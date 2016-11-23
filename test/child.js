"use strict"

const t = require("thallium")
const assert = require("thallium/assert")
const Child = require("../lib/child")
const M = require("../lib/enums").Messages
const serializer = require("../lib/serializer")
const libUtil = require("../lib/util")
const util = require("../test-util")
const idPool = require("../lib/id-pool")
const moduleWrap = require("../lib/module-wrap")
const Cancel = libUtil.Cancel

t.test("child", () => { // eslint-disable-line max-statements
    t.after(idPool.clear)

    const runner = new util.Runner()
    // let respawn
    const pool = {
        cache: Object.create(null),
        requests: Object.create(null),
        runner,
        spawnNext() {}, // no-op for runner.spawn
        runNext() {}, // no-op for runner.spawn
        // respawn(process, error) { respawn = {process, error} },
    }

    runner.spawn(pool)

    const process = new util.Process()
    const child = new Child(pool, process)

    // Wrap the module proxy and proxy `pool.invoke` so we can monkey-patch in
    // our own fake Promise and reuse that API. The wrappers are cached to avoid
    // slowing down the tests too much.
    pool.invoke = (method, args) => {
        const defer = util.defer()

        child.call({
            method, args,
            resolve: defer.resolve,
            reject: defer.reject,
            index: 0,
        })

        return defer
    }

    get.cached = Object.create(null)
    function get(name) {
        if (get.cached[name] != null) return get.cached[name]
        return get.cached[name] = pool.cache[name].proxy
    }

    function load(module, options) {
        const defer = util.defer()
        const request = {
            module, options,
            resolve: defer.resolve,
            reject: defer.reject,
            isProxy: true,
        }

        pool.requests[module] = [request]
        libUtil.onCancel(options, () => {
            // Only reject if it hasn't been pulled out yet.
            const requests = pool.requests[module]

            if (libUtil.remove(requests, request)) {
                if (!requests.length) delete pool.requests[module]
                defer.reject(new Cancel())
            }
        })
        child.load(request)

        return defer
    }

    function invoke() {
        child.handle(Array.from(arguments))
    }

    function push(type, id, value) {
        serializer.send({send: child.handle.bind(child)}, type, id, value)
    }

    function receivedInit() {
        const id = process.messages[0][0][1]
        const args = Array.from(arguments)

        args.splice(1, 0, id)
        assert.match(process.messages.shift(), [args])
        return id
    }

    function receivedValue(type, id, value, options) {
        serializer.send(process, type, id, value, options)
        const args = process.messages.pop()

        assert.match(process.messages.shift(), args)
    }

    function received() {
        assert.match(process.messages.shift(), [Array.from(arguments)])
    }

    const all = util.step(undefined, () => {
        assert.match(process.messages, [])
        assert.match(idPool.active(), [])
    })
    const mod1 = all()

    mod1.all("load module-1", () => {
        const defer = load("module-1")
        const id = receivedInit(M.Load, "module-1")

        invoke(M.Load, id, {exports: 1})
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.equal(defer.status, "resolved")
        assert.match(Object.keys(defer.value), ["exports"])
        assert.match(Object.keys(pool.cache["module-1"].proxy), ["exports"])
    })

    mod1().all("call module-1 exports success", () => {
        const defer = util.proxy(() => get("module-1").exports("foo"))
        const id = receivedInit(M.Init, "module-1", "exports")

        assert.equal(defer.status, "pending")
        invoke(M.Next, id)
        assert.equal(defer.status, "pending")
        receivedValue(M.Add, id, "foo")
        invoke(M.Next, id)
        assert.equal(defer.status, "pending")
        received(M.Invoke, id)
        push(M.Return, id, "result")
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.hasKeys(defer, {status: "resolved", value: "result"})
    })

    mod1().all("call module-1 exports error", () => {
        const defer = util.proxy(() => get("module-1").exports("foo"))
        const id = receivedInit(M.Init, "module-1", "exports")

        assert.equal(defer.status, "pending")
        invoke(M.Next, id)
        assert.equal(defer.status, "pending")
        receivedValue(M.Add, id, "foo")
        invoke(M.Next, id)
        assert.equal(defer.status, "pending")
        received(M.Invoke, id)
        push(M.Throw, id, "error")
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.hasKeys(defer, {status: "rejected", value: "error"})
    })

    all().all("load module-2 fail", () => {
        const defer = load("module-2")
        const id = receivedInit(M.Load, "module-2")

        push(M.Throw, id, "error")
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.hasKeys(defer, {status: "rejected", value: "error"})
        assert.equal(pool.cache["module-2"], undefined)
    })

    const mod2 = all()

    mod2.all("load module-2", () => {
        const defer = load("module-2")
        const id = receivedInit(M.Load, "module-2")

        invoke(M.Load, id, {method1: 1, method2: 2})
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.equal(defer.status, "resolved")
        assert.match(Object.keys(defer.value), ["method1", "method2"])
        assert.match(
            Object.keys(pool.cache["module-2"].proxy),
            ["method1", "method2"])
    })

    mod2().all("call parallel module-2 method1+method2 success", () => {
        const method1 = util.proxy(() => get("module-2").method1("foo"))
        const method2 = util.proxy(() => get("module-2").method2("bar"))
        const id1 = receivedInit(M.Init, "module-2", "method1")
        const id2 = receivedInit(M.Init, "module-2", "method2")

        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        receivedValue(M.Add, id1, "foo")
        receivedValue(M.Add, id2, "bar")
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        received(M.Invoke, id1)
        received(M.Invoke, id2)
        push(M.Return, id1, "result")
        push(M.Return, id2, "result")
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        runner.resolve()
        assert.hasKeys(method1, {status: "resolved", value: "result"})
        assert.hasKeys(method2, {status: "resolved", value: "result"})
    })

    mod2().all("call parallel module-2 method1+method2 success/fail", () => {
        const method1 = util.proxy(() => get("module-2").method1("foo"))
        const method2 = util.proxy(() => get("module-2").method2("bar"))
        const id1 = receivedInit(M.Init, "module-2", "method1")
        const id2 = receivedInit(M.Init, "module-2", "method2")

        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        receivedValue(M.Add, id1, "foo")
        receivedValue(M.Add, id2, "bar")
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        received(M.Invoke, id1)
        received(M.Invoke, id2)
        push(M.Return, id1, "result")
        push(M.Throw, id2, "error")
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        runner.resolve()
        assert.hasKeys(method1, {status: "resolved", value: "result"})
        assert.hasKeys(method2, {status: "rejected", value: "error"})
    })

    mod2().all("call parallel module-2 method1+method2 fail", () => {
        const method1 = util.proxy(() => get("module-2").method1("foo"))
        const method2 = util.proxy(() => get("module-2").method2("bar"))
        const id1 = receivedInit(M.Init, "module-2", "method1")
        const id2 = receivedInit(M.Init, "module-2", "method2")

        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        receivedValue(M.Add, id1, "foo")
        receivedValue(M.Add, id2, "bar")
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        received(M.Invoke, id1)
        received(M.Invoke, id2)
        push(M.Throw, id1, "error")
        push(M.Throw, id2, "error")
        assert.hasKeys(method1, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        runner.resolve()
        assert.hasKeys(method1, {status: "rejected", value: "error"})
        assert.hasKeys(method2, {status: "rejected", value: "error"})
    })

    mod1().all("call parallel module-1+module-2 success", () => { // eslint-disable-line max-statements, max-len
        mod2.check()
        const exports = util.proxy(() => get("module-1").exports("foo"))
        const method2 = util.proxy(() => get("module-2").method2("bar"))
        const id1 = receivedInit(M.Init, "module-1", "exports")
        const id2 = receivedInit(M.Init, "module-2", "method2")

        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        receivedValue(M.Add, id1, "foo")
        receivedValue(M.Add, id2, "bar")
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        received(M.Invoke, id1)
        received(M.Invoke, id2)
        push(M.Return, id1, "result")
        push(M.Return, id2, "result")
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        runner.resolve()
        assert.hasKeys(exports, {status: "resolved", value: "result"})
        assert.hasKeys(method2, {status: "resolved", value: "result"})
    })

    mod1().all("call parallel module-1+module-2 success/fail", () => { // eslint-disable-line max-statements, max-len
        mod2.check()
        const exports = util.proxy(() => get("module-1").exports("foo"))
        const method2 = util.proxy(() => get("module-2").method2("bar"))
        const id1 = receivedInit(M.Init, "module-1", "exports")
        const id2 = receivedInit(M.Init, "module-2", "method2")

        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        receivedValue(M.Add, id1, "foo")
        receivedValue(M.Add, id2, "bar")
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        received(M.Invoke, id1)
        received(M.Invoke, id2)
        push(M.Return, id1, "result")
        push(M.Throw, id2, "error")
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        runner.resolve()
        assert.hasKeys(exports, {status: "resolved", value: "result"})
        assert.hasKeys(method2, {status: "rejected", value: "error"})
    })

    mod1().all("call parallel module-1+module-2 fail", () => { // eslint-disable-line max-statements, max-len
        mod2.check()
        const exports = util.proxy(() => get("module-1").exports("foo"))
        const method2 = util.proxy(() => get("module-2").method2("bar"))
        const id1 = receivedInit(M.Init, "module-1", "exports")
        const id2 = receivedInit(M.Init, "module-2", "method2")

        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        receivedValue(M.Add, id1, "foo")
        receivedValue(M.Add, id2, "bar")
        invoke(M.Next, id1)
        invoke(M.Next, id2)
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        received(M.Invoke, id1)
        received(M.Invoke, id2)
        push(M.Throw, id1, "error")
        push(M.Throw, id2, "error")
        assert.hasKeys(exports, {status: "pending"})
        assert.hasKeys(method2, {status: "pending"})
        runner.resolve()
        assert.hasKeys(exports, {status: "rejected", value: "error"})
        assert.hasKeys(method2, {status: "rejected", value: "error"})
    })

    all().all("cancelled module-3, load resolved", () => {
        const cancel = util.cancel(runner)
        const defer = load("module-3", {cancelToken: cancel})
        const id = receivedInit(M.Load, "module-3")

        assert.equal(defer.status, "pending")
        cancel()
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
        assert.notHasOwn(pool.cache, "module-3")
        assert.notHasOwn(child.calls, id)

        received(M.Cancel, id)
        invoke(M.Load, id, {foo: 0})
        invoke(M.Cancel, id)

        runner.resolve()
        assert.match(Object.keys(pool.cache["module-3"].proxy), ["foo"])
    })

    all().all("duplicate cancelled module-4, load resolved", () => {
        const cancel = util.cancel(runner)
        const defer = load("module-4", {cancelToken: cancel})
        const id = receivedInit(M.Load, "module-4")

        assert.equal(defer.status, "pending")
        cancel()
        cancel()
        cancel()
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
        assert.notHasOwn(pool.cache, "module-4")
        assert.notHasOwn(child.calls, id)

        received(M.Cancel, id)
        invoke(M.Load, id, {foo: 0})
        invoke(M.Cancel, id)

        runner.resolve()
        assert.match(Object.keys(pool.cache["module-4"].proxy), ["foo"])
    })

    all().all("cancelled module-1 exports immediate", () => {
        const cancel = util.cancel(runner)

        const defer = util.proxy(() =>
            get("module-1")({cancelToken: cancel}).exports("foo"))

        receivedInit(M.Init, "module-1", "exports")

        cancel()
        assert.equal(defer.status, "pending")
        runner.resolve()
        runner.resolve()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
        const cancelled = receivedInit(M.Cancel)

        invoke(M.Cancel, cancelled)
    })

    all().all("duplicate cancelled module-1 exports immediate", () => {
        const cancel = util.cancel(runner)
        const defer = util.proxy(() =>
            get("module-1")({cancelToken: cancel}).exports("foo"))

        receivedInit(M.Init, "module-1", "exports")

        cancel()
        cancel()
        cancel()
        assert.equal(defer.status, "pending")
        runner.resolve()
        runner.resolve()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
        cancel()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
        const cancelled = receivedInit(M.Cancel)

        invoke(M.Cancel, cancelled)
    })

    all().all("duplicate cancelled module-1 exports 1 arg", () => {
        const cancel = util.cancel(runner)
        const defer = util.proxy(() =>
            get("module-1")({cancelToken: cancel}).exports("foo", "bar"))

        receivedInit(M.Init, "module-1", "exports")

        cancel()
        cancel()
        cancel()
        assert.equal(defer.status, "pending")
        runner.resolve()
        runner.resolve()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
        const cancelled = receivedInit(M.Cancel)

        invoke(M.Cancel, cancelled)
        cancel()
        assert.equal(defer.status, "rejected")
        assert.match(defer.value, new Cancel())
    })

    all().all("cached module-5 load", () => {
        const mod = moduleWrap.create(pool, "module-5", {exports: 1})

        pool.cache["module-5"] = mod

        const defer = load("module-5")
        const id = receivedInit(M.LateLoad, "module-5")

        invoke(M.Load, id)
        assert.equal(defer.status, "pending")
        runner.resolve()
        assert.equal(defer.status, "resolved")
        assert.equal(defer.value, mod.proxy)
        assert.equal(pool.cache["module-5"], mod)
    })
})
