"use strict"

const t = require("thallium")
const serializer = require("./lib/serializer")
const util = require("./lib/util")

/**
 * This file contains all the test mocks and utilities.
 */

// To override the global promise temporarily. This module internally doesn't
// need any knowedge of thenables outside of cancel tokens, so this isn't an
// issue.
exports.proxy = f => {
    const Promise = global.Promise

    try {
        global.Promise = exports.defer
        return f()
    } finally {
        global.Promise = Promise
    }
}

// So I can skip tests that would otherwise have invalid state. This allows
// subtest dependency tracking as well.
exports.step = (pre, post) => {
    util.check(pre == null || typeof pre === "function")
    util.check(post == null || typeof post === "function")
    return step({failed: false})
    function step(status) {
        let ctx

        // When things fail, abort to avoid invalid state. Note that
        // this is intentionally throwing a string because a stack trace
        // would make it harder to find the error.
        const check = () => { if (status.failed) throw "aborted" } // eslint-disable-line no-throw-literal, max-len
        const skip = name => t.testSkip(name, () => {})
        const wrap = (usePre, usePost) => Object.assign(
            (name, body) => t.test(name, () => {
                check()
                try {
                    if (usePre) ctx = pre()
                    body(ctx)
                    if (usePost) ctx = post(ctx)
                } catch (e) {
                    status.failed = true
                    throw e
                }
            }),
            {skip})

        const wrapped = wrap(false, false)

        return Object.assign((name, body) => {
            // Prototypes drastically simplify this.
            if (name == null) return step(Object.create(status))
            else return wrapped(name, body)
        }, {
            skip, check,
            pre: wrap(typeof pre === "function", false),
            post: wrap(false, typeof post === "function"),
            all: wrap(typeof pre === "function", typeof post === "function"),
        })
    }
}

exports.tag = f => function (parts) {
    if (!Array.isArray(parts)) return f(parts)
    let ret = parts[0]

    for (let i = 1; i < arguments.length; i++) {
        ret += arguments[i] + parts[i]
    }

    return f(ret)
}

exports.spy = (length, result) => {
    util.check(typeof length === "number")

    function func() {
        func.this.push(this) // eslint-disable-line no-invalid-this
        func.args.push(Array.from(arguments))
        return result
    }

    Object.defineProperty(func, "length", {value: length})

    func.this = []
    func.args = []
    return func
}

exports.toMessage = (value, options) => {
    let data
    const child = {send() { data = Array.from(arguments) }}

    serializer.send(child, 1, 0, value, options)
    data[0] = JSON.stringify(data[0])
    return data
}

exports.toValue = data => {
    util.check(Array.isArray(data))
    return serializer.read(JSON.parse(data[0]), data[1])
}

// A *really* dumb deferred, without even support for chaining. It's actually
// fairly convenient for testing the tasks. Note that this is often called with
// `new`, so it must remain constructible.
exports.defer = function (init) {
    let status = "pending"
    let value
    const set = method => reason => {
        if (status !== "pending") return
        status = method
        value = reason
    }
    const resolve = set("resolved")
    const reject = set("rejected")

    if (typeof init === "function") init(resolve, reject)

    return {
        get status() { return status },
        get value() { return value },
        resolve, reject,
        inspect: () => ({status, value}),
    }
}

// Note that this allows abusive calls
exports.cancel = runner => {
    util.check(typeof runner === "object" && runner != null)

    const resolves = []
    const cancel = () => runner.defer(() => {
        resolves.forEach(resolve => resolve())
    })

    cancel.then = resolve => resolves.push(resolve)
    return cancel
}

exports.Process = class Process {
    constructor() { this.messages = [] }
    send() { this.messages.push(Array.from(arguments)) }
}

const once = callback => () => {
    const func = callback

    if (func != null) {
        callback = undefined
        func()
    }
}

exports.Runner = class Runner {
    constructor() {
        this.spawns = []
        this.timers = []
        this.deferred = []
        this.killed = []
    }

    limit() { return 5 }
    cwd() { return "/path/to/cwd" }
    env() { return {NODE_ENV: "development"} }

    setTimeout(delay, callback) {
        util.check(typeof delay === "number")
        util.check(typeof callback === "function")
        const timer = {delay, callback: once(callback)}

        this.timers.push(timer)
        return timer
    }

    clearTimeout(timer) {
        util.check(typeof timer === "object" && timer != null)
        util.remove(this.timers, timer)
    }

    defer(callback) {
        util.check(typeof callback === "function")
        const timer = {callback}

        this.deferred.push(timer)
        return timer
    }

    clear(timer) {
        if (timer == null) return
        util.check(typeof timer === "object" && timer != null)
        util.remove(this.deferred, timer)
    }

    init(child) {
        util.check(typeof child === "object" && child != null)
        child.process.send("init")
    }

    deinit(child) {
        util.check(typeof child === "object" && child != null)
        Object.freeze(child.process.messages) // Prevent pushing new messages
    }

    spawn(pool) {
        util.check(typeof pool === "object" && pool != null)
        this.spawns.push(() => {
            const process = new exports.Process()

            pool.spawnNext(process)
            return process
        })
    }

    kill(child) {
        util.check(typeof child === "object" && child != null)
        this.killed.push(child)
    }

    resolve() {
        const deferred = this.deferred

        this.deferred = []
        for (const task of deferred) {
            (0, task.callback)()
        }
    }
}
