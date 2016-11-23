"use strict"

/**
 * This is the actual logic for the child. Note that anything here will not
 * propagate to the parent without the use of IPC.
 *
 * Minimal error handling is done beyond invoking the method itself and catching
 * `require` errors, because internal errors cannot be reasonably handled.
 *
 * Note that the numerous seemingly magic numbers really just correspond to
 * positional parameter indices (0-based). Each relevant method has descriptive
 * names to explain each of the positional parameters. It's to reduce IPC memory
 * overhead by saving a lot of JSON space.
 */

const M = require("./enums").Messages
const serializer = require("./serializer")
const ReturnWrap = require("./worker-api").ReturnWrap
const util = require("./util")

// Simple bit mask
const StateError = 0x1
const StateDefer = 0x2
const StateLocked = 0x4

function invoke(method, args) {
    util.check(typeof method === "function")

    // V8 likes consistent numbers of arguments.
    if (args == null) return method()
    switch (args.length) {
    case 0: return util.check(false)
    case 1: return method(args[0])
    case 2: return method(args[0], args[1])
    case 3: return method(args[0], args[1], args[2])
    case 4: return method(args[0], args[1], args[2], args[3])
    default: return method.apply(undefined, args)
    }
}

function load(state, name) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof name === "string")

    const raw = state.require(name)

    if (raw == null || typeof raw !== "function" && typeof raw !== "object") {
        state.uncache(name)
        throw new TypeError(
            `Module '${name}' must only export an object or function value!`
        )
    }

    return raw
}

function emit(state, type, id, value) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof type === "number")
    util.check(typeof id === "number")

    if (value instanceof ReturnWrap) {
        serializer.send(state, type, id, value.result, value.options)
    } else {
        serializer.send(state, type, id, value)
    }
}

function tryLoad(state, name) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof name === "string")

    try {
        const raw = load(state, name)
        const exports = Object.create(null)
        const lengths = Object.create(null)

        for (const key of Object.keys(raw)) {
            const method = raw[key]

            if (typeof method === "function") {
                exports[key] = method
                lengths[key] = method.length
            }
        }

        return {exports, lengths}
    } catch (e) {
        state.mask |= StateError
        return {value: e}
    }
}

// -> [_, id, module]
// <- [M.Load, id, {...[method]: length}]
// <- [M.Load, id]
// <- [M.Throw, id, type, value?]
// This is deferred to avoid blocking later call requests.
function initLoad(state, id, sendMethods) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof id === "number")
    util.check(typeof sendMethods === "boolean")

    state.mask = 0
    const name = state.calls[id]

    delete state.calls[id]
    delete state.timers[id]

    const result = tryLoad(state, name)

    if (state.mask & StateError) {
        emit(state, M.Throw, id, result.value)
    } else {
        state.cache[name] = result.exports
        if (sendMethods) {
            state.send([M.Load, id, result.lengths])
        } else {
            state.send([M.Load, id])
        }
    }
}

/**
 * This is all untrusted, thus the enclosing `try`/`catch`.
 */
function tryInvoke(state, call, id) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof call === "object" && call != null)
    util.check(typeof id === "number")

    try {
        const result = invoke(call.method, call.args)
        const then = result.then

        if (typeof result.then === "function") {
            then.call(result,
                value => emit(state, M.Return, id, value),
                err => emit(state, M.Throw, id, err))
            state.mask |= StateDefer
            return undefined
        }

        return result
    } catch (e) {
        state.mask |= StateError
        return e
    }
}

// -> [M.Invoke, id]
// <- [M.Return, id, type, value?]
// <- [M.Throw, id, type, value?]
function initInvoke(state, id) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof id === "number")

    const call = state.calls[id]

    delete state.calls[id]
    delete state.timers[id]
    state.mask = 0

    const result = tryInvoke(state, call, id)

    if (state.mask & StateError) {
        emit(state, M.Throw, id, result)
    } else if (!(state.mask & StateDefer)) {
        emit(state, M.Return, id, result)
    }
}

// -> [M.Cancel, id]
// <- [M.Cancel, id]
function handleCancel(state, id) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof id === "number")

    state.clear(state.calls[id])
    delete state.calls[id]
    delete state.timers[id]
    state.send([M.Cancel, id])
}

// -> [M.Add, id, type, value?] + socket?
// <- [M.Next, id]
function handleAdd(state, id, message, socket) {
    util.check(typeof state === "object" && state != null)
    util.check(typeof id === "number")
    util.check(Array.isArray(message))

    const call = state.calls[id]

    if (call == null) return

    if (call.args == null) {
        call.args = [serializer.read(message, socket)]
    } else {
        call.args.push(serializer.read(message, socket))
    }

    state.send([M.Next, id])
}

/**
 * A state state manager. Note that this is intended to be subclassed, with the
 * following abstract methods:
 *
 * - `send(message, socket?, options?)` - Use a custom `process.send`.
 * - `defer(func)` - Use a custom `setImmediate` to defer execution.
 * - `clear(func)` - Use a custom `clearImmediate`.
 * - `require(module)` - Use a custom `require`.
 * - `uncache(module)` - Uncache a failed `require`.
 */
module.exports = class State {
    constructor() {
        this.mask = 0
        this.cache = Object.create(null)
        this.calls = Object.create(null)
        this.timers = Object.create(null)
    }

    send() { throw new ReferenceError("state.send is abstract!") }
    defer() { throw new ReferenceError("state.defer is abstract!") }
    clear() { throw new ReferenceError("state.clear is abstract!") }
    require() { throw new ReferenceError("state.require is abstract!") }
    uncache() { throw new ReferenceError("state.uncache is abstract!") }

    // die(err) {
    //     this.mask = StateLocked
    //     emit(this, M.Error, 0, err)
    // }

    invoke(message, socket) {
        if (this.mask === StateLocked) return
        util.check(Array.isArray(message))

        // These are standard fields present on all requests
        const type = message[0]
        const id = message[1]

        util.check(typeof type === "number")
        util.check(typeof id === "number")

        switch (type) {
        // -> [M.Cancel, id]
        // <- [M.Cancel, id]
        case M.Cancel:
            handleCancel(this, id)
            break

        // -> [M.Load, id, module]
        // <- [M.Load, id, {...[name]: length}]
        // <- [M.Throw, id, type, value?]
        case M.Load:
            this.calls[id] = message[2]
            this.timers[id] = this.defer(() => initLoad(this, id, true))
            break

        // -> [M.LateLoad, id, module]
        // <- [M.LateLoad, id, {...[name]: length}]
        // <- [M.Throw, id, type, value?]
        case M.LateLoad:
            this.calls[id] = message[2]
            this.timers[id] = this.defer(() => initLoad(this, id, false))
            break

        // -> [M.Init, id, module, method]
        // <- [M.Next, id]
        case M.Init:
            this.calls[id] = {
                method: this.cache[message[2]][message[3]],
                args: undefined,
            }
            this.send([M.Next, id])
            break

        // -> [M.Add, id, type, value?] + socket?
        // <- [M.Next, id]
        case M.Add:
            handleAdd(this, id, message, socket)
            break

        // -> [M.Invoke, id]
        // <- [M.Return, id, type, value?]
        // <- [M.Throw, id, type, value?]
        case M.Invoke:
            this.timers[id] = this.defer(() => initInvoke(this, id))
            break

        default: throw new TypeError(`Invalid message type: ${type}`)
        }
    }
}
