"use strict"

const M = require("./enums").Messages
const serializer = require("./serializer")
const util = require("./util")
const idPool = require("./id-pool")
const moduleWrap = require("./module-wrap")

// Being *super* conservative with validating IDs are active.
const checkActive = util.isDebug
    ? id => util.check(idPool.isActive(id))
    : () => {}

const CancelModule = 0
const CancelCall = 1

// <- [M.Cancel, id]
function cancelAction(child, id) {
    util.check(!child.locked)
    checkActive(id)
    const call = child.calls[id]

    if (call != null && call.reject != null) {
        const reject = call.reject

        child.pool.runner.defer(() => reject(new util.Cancel()))
    }

    const delayed = child.delayed[id]

    // Go ahead and clear the existing data now.
    delete child.calls[id]
    delete child.delayed[id]

    // The rest is irrelevant for anything other than cancelled `M.Load`
    // requests.
    if (delayed == null) {
        // Only non-load requests can be cancelled individually. Load requests
        // are batched, so the raw request cannot be cancelled yet. Also, don't
        // release the ID yet, in case the child is currently executing this
        // method request.
        child.process.send([M.Cancel, id])
        child.cancelling[id] = CancelCall
        return
    }

    checkActive(delayed)
    const loadData = child.loadData[delayed]

    util.check(loadData != null)
    util.remove(loadData.deps, id)
    idPool.release(id)

    if (loadData.deps.length === 0) {
        // Don't release the delayed ID yet, in case the child is currently
        // loading the module in question.
        child.process.send([M.Cancel, delayed])
        child.cancelling[delayed] = CancelModule

        // Don't delete the load data yet, in case the child process loads the
        // module before receiving the cancel request. (The process sends a
        // synchronous cancel response and locks the state when it receives a
        // cancel request, and it defers the load request when it receives it.)
        return
    }

    // It's only safe to delete the call and update the statistics after all
    // cancellation is addressed.
    if (call != null) child.decrement(call)
}

// <- <resolve/reject>
function initReturn(child, id) {
    util.check(!child.locked)
    checkActive(id)
    const call = child.calls[id]

    if (call == null) return undefined
    child.decrement(call)
    delete child.calls[id]
    idPool.release(id)
    return call
}

// So loads don't duplicate each other.
// <- [M.Load, id, module]
function load(child, id, module) {
    util.check(!child.locked)
    checkActive(id)
    let loadId = child.loadId[module]
    let loadData

    if (loadId == null) {
        loadId = idPool.acquire()
        child.process.send([
            // Notify the child if the load is the first one - the method list
            // is ignored after the first load, so it doesn't need sent back.
            child.pool.cache[module] == null ? M.Load : M.LateLoad,
            loadId,
            module,
        ])
        loadData = child.loadData[loadId] = {deps: [], name: module}
    } else {
        loadData = child.loadData[loadId]
        util.check(loadData != null)
    }

    loadData.deps.push(id)
    child.delayed[id] = loadId
}

function handleLoadDep(child, loadData, id) {
    util.check(typeof child === "object" && child != null)
    util.check(typeof loadData === "object" && loadData != null)
    util.check(!child.locked)
    checkActive(id)

    const call = child.calls[id]

    delete child.delayed[id]
    if (call == null) return
    if (call.module == null) {
        child.process.send([
            M.Init, id,
            loadData.name,
            call.method.name,
        ])
    } else {
        idPool.release(id)
        child.running--
        delete child.calls[id]
    }
}

// -> [M.Load, id, {...[name]: length}]
// <- [M.Init, id, module, method]
// <- <resolve>
// Note that this is coded without the assumption there is another step, because
// this could very well be called after cancellation, in which we still *should*
// cache the load instead of throwing it away (it's already cached in the child
// process).
function handleLoad(child, loadId, methods) {
    util.check(!child.locked)
    checkActive(loadId)

    const loadData = child.loadData[loadId]

    delete child.loadData[loadId]
    delete child.loadId[loadData.name]
    if (child.cancelling[loadId] == null) idPool.release(loadId)

    for (let i = 0; i < loadData.deps.length; i++) {
        handleLoadDep(child, loadData, loadData.deps[i])
    }

    child.finishLoadResolve(loadData.name, methods)
}

// -> [M.Next, id]
// <- [M.Next, id, type, value?]
// <- [M.Invoke, id]
function handleNext(child, id) {
    util.check(!child.locked)
    checkActive(id)
    const call = child.calls[id]

    if (call == null) return
    if (call.args == null || call.index === call.args.length) {
        child.process.send([M.Invoke, id])
        return
    }

    const value = call.args[call.index]
    let options = call.method.options

    if (options != null && Array.isArray(options.keepOpen)) {
        options = Object.assign({}, options,
            {keepOpen: options.keepOpen.indexOf(value) >= 0})
    }

    serializer.send(child.process, M.Add, id, value, options)
    call.index++
}

// -> [M.Return, id, type, value?]
// <- <resolve>
function handleReturn(child, id, message, socket) {
    util.check(!child.locked)
    checkActive(id)
    const call = initReturn(child, id)

    if (call != null) {
        const resolve = call.resolve
        const value = serializer.read(message, socket)

        child.pool.runner.defer(() => resolve(value))
    }

    child.pool.runNext(child)
}

function batchRejectLoad(child, mainId, error) {
    util.check(!child.locked)
    checkActive(mainId)

    const loadData = child.loadData[mainId]
    const rejects = []

    delete child.loadData[mainId]
    delete child.loadId[loadData.name]
    idPool.release(mainId)

    for (let i = 0; i < loadData.deps.length; i++) {
        const id = loadData.deps[i]

        checkActive(id)
        delete child.delayed[id]
        const call = initReturn(child, id)

        if (call != null) rejects.push(call.reject)
    }

    child.finishLoadReject(loadData.name, error, rejects)
}

// -> [M.Throw, id, type, value?]
function handleThrow(child, id, message, socket) {
    util.check(!child.locked)
    checkActive(id)

    const error = serializer.read(message, socket)

    if (child.loadData[id] == null) {
        const call = initReturn(child, id)
        const reject = call.reject

        if (call != null) child.pool.runner.defer(() => reject(error))
        child.pool.runNext(child)
    } else {
        batchRejectLoad(child, id, error)
    }
}

// -> [M.Cancel, id]
function handleCancel(child, id) {
    util.check(!child.locked)
    util.check(child.cancelling[id] != null)
    checkActive(id)
    const loadData = child.loadData[id]

    if (loadData != null) delete child.loadId[loadData.name]

    if (child.cancelling[id] === CancelModule) {
        child.loadCount--
    } else {
        child.callCount--
    }

    child.running--
    delete child.loadData[id]
    delete child.cancelling[id]
    idPool.release(id)
    if (!child.running) child.pool.runNext(child)
}

// -> [M.Error, _, type, value?]
// <- <invoke onError, kill>
// function handleError(child, message, socket) {
//     checkActive(id)
//     child.pool.runner.kill(child.process)
//     child.pool.respawn(child, serializer.read(message, socket))
// }

/**
 * The low-level child machine used to order and run the tasks. It exposes a
 * simpler API on top so that the runner doesn't have to understand all its
 * complicated internals to use it.
 *
 * This is what makes things work behind the scenes, and is the primary
 * interface between the child process and the pool.
 */
module.exports = class Child {
    /**
     * `pool` is a `Pool`, but only the following properties/methods are used:
     *
     * - `pool.cache` - The pool's module cache.
     * - `pool.requests` - The pending load requests for the pool.
     * - `pool.respawn(this, err)` - Log an `err` and respawn the process.
     *
     * - `pool.runner` - The runner injection for the pool. Only the following
     *   methods are used (see `./pool.js` for more details):
     *   - `runner.defer(func)`
     *   - `runner.kill(proc)`
     *
     * `process` is an object with a `send` method carrying the same API as
     * `ChildProcess.prototype.send`.
     */
    constructor(pool, process) {
        // options
        this.pool = pool
        this.process = process

        // external members
        this.running = 0
        this.timeout = undefined
        this.locked = false

        // For much faster statistics gathering (in case the number of tasks
        // running is quite large)
        this.loadCount = 0
        this.callCount = 0

        // loading
        this.loadId = Object.create(null)
        this.loadData = Object.create(null)
        this.delayed = Object.create(null)
        this.cancelling = Object.create(null)

        // task state
        this.modules = Object.create(null)
        this.calls = Object.create(null)
        this.rejects = Object.create(null)
    }

    /**
     * Get statistics for this child.
     */
    stats() {
        return {
            running: this.running,
            loaded: Object.keys(this.modules),
            // This is in fact observable.
            dying: this.locked,
            loads: this.loadCount,
            calls: this.callCount,
        }
    }

    lock() {
        util.check(!this.locked)
        this.locked = true

        // Clear every data property. Note that this is always called after the
        // timeout has been cleared.
        this.pool = undefined
        this.process = undefined
        this.timeout = undefined
        this.loadId = undefined
        this.loadData = undefined
        this.delayed = undefined
        this.modules = undefined
        this.calls = undefined
    }

    // To avoid a massive amount of duplication in testing (this carries mostly
    // cross-cutting concerns with the pool).
    finishLoadResolve(name, methods) {
        const requests = this.pool.requests[name]
        let cached = this.pool.cache[name]

        if (cached == null) {
            cached = moduleWrap.create(this.pool, name, methods)
            this.pool.cache[name] = cached
            // TODO: preload this module in the rest of the active processes
        }

        this.modules[name] = true
        delete this.pool.requests[name]

        if (requests != null) {
            const resolves = []
            const proxy = cached.proxy

            for (let i = 0; i < requests.length; i++) {
                resolves.push(requests[i].resolve)
            }

            this.pool.runner.defer(() => {
                for (let i = 0; i < resolves.length; i++) {
                    (0, resolves[i])(proxy)
                }
            })
        }

        this.pool.runNext(this)
    }

    finishLoadReject(name, error, rejects) {
        const requests = this.pool.requests[name]

        delete this.pool.requests[name]
        if (requests != null) {
            for (let i = 0; i < requests.length; i++) {
                rejects.push(requests[i].reject)
            }
        }

        if (rejects.length) {
            this.pool.runner.defer(() => {
                for (let i = 0; i < rejects.length; i++) {
                    (0, rejects[i])(error)
                }
            })
        }

        this.pool.runNext(this)
    }

    decrement(call) {
        util.check(!this.locked)

        if (call.module != null) {
            this.loadCount--
        } else {
            this.callCount--
        }

        this.running--
    }

    increment(call) {
        util.check(!this.locked)

        if (call.module != null) {
            this.loadCount++
        } else {
            this.callCount++
        }

        this.running++
    }

    /**
     * This method handles worker messages, and is designed to be inlinable.
     * Quick description of the argument patterns:
     *
     * -> [M.Load, id, {...[name]: length}]
     * <- [M.Init, id, module, method]
     * <- <resolve>
     *
     * -> [M.Next, id]
     * <- [M.Next, id, type, value?]
     * <- [M.Invoke, id]
     * <- <reject>
     *
     * -> [M.Return, id, type, value?]
     * <- <resolve>
     *
     * -> [M.Throw, id, type, value?]
     * <- <reject>
     *
     * -> [M.Error, _, type, value?]
     * <- <invoke onError, kill>
     *
     * -> [M.Cancel, id]
     *
     * FIXME: Actually implement this part...
     * Note: Errors in the this aren't handlable outside of module loads and
     * method calls. Log the error, kill the process, and pre-emptively respawn
     * a replacement.
     */
    handle(message, socket) {
        if (this.locked) return

        // These are standard fields present on all requests
        const type = message[0]
        const id = message[1]

        switch (type) {
        case M.Load: handleLoad(this, id, message[2]); break
        case M.Next: handleNext(this, id); break
        case M.Return: handleReturn(this, id, message, socket); break
        case M.Throw: handleThrow(this, id, message, socket); break
        // case M.Error: handleError(this, message, socket); break
        case M.Cancel: handleCancel(this, id); break
        default: throw new TypeError(`Invalid message type: ${type}`)
        }
    }

    /**
     * Load a `request.module` with `request.options`, and call
     * `request.resolve` on success or `request.reject` on error.
     *
     * <- [M.Load, id, module]
     * <- <wait for existing load>
     */
    load(request) {
        util.check(!this.locked)
        const id = idPool.acquire()

        util.onCancel(request.options, () => {
            if (this.locked || this.calls[id] == null) return
            this.loadCount--
            cancelAction(this, id)
        })

        this.calls[id] = request
        this.increment(request)
        load(this, id, request.module)
    }

    /**
     * This runs a `method` with `args` inside its module, increments
     * `child.running` during execution, and decrements `child.running` after
     * success, error, or cancellation.
     *
     * <- [M.Load, id, module]
     * <- [M.Init, id, module, method]
     * <- <wait for existing load>
     */
    call(request) {
        util.check(!this.locked)
        const method = request.method
        const name = method.module.name
        const id = idPool.acquire()

        util.onCancel(method.options, () => {
            if (this.locked || this.calls[id] == null) return
            this.callCount--
            cancelAction(this, id)
        })

        this.calls[id] = request
        this.increment(request)
        if (this.modules[name] != null) {
            this.process.send([M.Init, id, name, method.name])
        } else {
            load(this, id, name)
        }
    }
}
