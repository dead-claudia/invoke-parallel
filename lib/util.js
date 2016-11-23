"use strict"

// Detect debug state
exports.isDebug = process.env.NODE_DEBUG === "invoke-parallel"

// Debug assert, simple to avoid the ceremony of Node's built-in `assert` (nice
// for testing, but bad for use in performance sensitive code). For this reason,
// it doesn't even include a configurable message, because that's yet another
// allocation. It's designed to be easily compiled out by V8's JIT when in
// release mode.
exports.check = exports.isDebug
    ? cond => {
        if (!cond) {
            const err = new Error("Assertion failed")

            // Strip this function out of the stack.
            Error.captureStackTrace(err, exports.check)
            throw err
        }
    }
    : () => {}

// Common utilities
exports.remove = (list, item) => {
    exports.check(Array.isArray(list))
    const index = list.indexOf(item)

    if (index >= 0) list.splice(index, 1)
    return index >= 0
}

exports.onCancel = (options, callback) => {
    try {
        let called = false

        options.cancelToken.then(() => {
            if (called) return
            called = true
            callback()
        }, e => { throw e }) // Trigger uncaught exception handlers
    } catch (_) {
        // Yes, this will throw if `options` or `options.cancelToken` don't
        // exist, or if `cancelToken` isn't a thenable, but who cares. Errors
        // are swallowed because there's no point in worrying about it (I can't
        // really do anything about faulty cancel tokens).
    }
}

exports.Retry = class Retry extends Error {
    constructor() { super("Child process died. Please reattempt call.") }
    get name() { return "Retry" }
}

exports.Cancel = class Cancel extends Error {
    constructor() {
        super("Call cancelled.")
        // There isn't any meaningful stack to be displayed.
        delete this.stack
    }
    get stack() { return "" }
}

exports.cancelToken = init => {
    if (init != null && typeof init !== "function") {
        throw new TypeError("init must be a function if passed")
    }

    let resolve
    const p = new Promise(res => resolve = () => res)

    p.resolve = resolve
    if (init != null) init(resolve)
    return p
}
