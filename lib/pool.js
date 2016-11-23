"use strict"

const path = require("path")
const util = require("./util")
const runner = require("./runner")
const Child = require("./child")
const hasOwn = Object.prototype.hasOwnProperty

// TODO: switch the algorithm to highest response ratio next, and track average
// call duration for each method (last N calls for some small but usable N).

/**
 * Note: `pool.runner` is an injection for executing tasks, mainly used for
 * testing. The methods are intentionally chosen to be as agnostic to the
 * scheduling as possible, so the core logic can be optimized independently of
 * running the pool, and so this might be made portable later.
 *
 * Here are the `runner` methods:
 *
 * - `runner.limit()` - Get the default limit.
 * - `runner.cwd()` - Get the default current working directory.
 * - `runner.env()` - Get the default child environment.
 * - `runner.setTimeout(delay, callback)` - A custom `setTimeout`.
 * - `runner.clearTimeout(timeout)` - A custom `clearTimeout`.
 * - `runner.defer(callback)` - A custom `setImmediate`.
 * - `runner.clear(timer)` - A custom `clearImmediate`.
 * - `runner.init(child)` - Initialize a process after finished spawning.
 * - `runner.deinit(child)` - Deinitialize a process.
 * - `runner.kill(child)` - Kill a child process.
 * - `runner.spawn(pool)` - Create a new child process.
 *
 * With `runner.spawn`, you must call `pool.spawnNext` with the new child
 * or `pool.spawnError` in case of error.
 *
 * Each task contains at least these properties (others are ignored here):
 *
 * - `task.resolve` - Resolve with the end result
 * - `task.reject` - Reject with the end error
 *
 * Note that a cancel token is an object with a thenable `promise` method.
 */

/**
 * Get next ready process, or `undefined` if none are currently available.
 *
 * Bias is towards least used, then oldest. If any children have reached their
 * limit (if one exists), they're skipped over (this may result in no child
 * being returned).
 */
function nextReady(pool) {
    util.check(typeof pool === "object" && pool != null)

    // First, try to find an unused thread.
    for (let i = 0; i < pool.processes.length; i++) {
        const child = pool.processes[i]

        if (!child.locked && child.running === 0) return child
    }

    // All threads in use. Let's create a new fresh one if there's room, but not
    // if we're waiting on existing pre-emptively spawned processes.
    if (pool.waiting !== 0) {
        pool.waiting--
    } else if (pool.spawned < pool.limit) {
        pool.runner.spawn(pool)
        pool.spawned++
    }

    // Time to load balance.
    return nextBalanced(pool)
}

function nextBalanced(pool) {
    util.check(typeof pool === "object" && pool != null)

    let minimum = pool.maxPerChild
    let i = 0
    let found

    if (minimum === 0) {
        while (i < pool.processes.length) {
            const child = pool.processes[i++]

            if (!child.locked) {
                found = child
                minimum = child.running
                break
            }
        }

        // No running count is 0 at this point.
        if (minimum === 0) return undefined
    }

    while (i < pool.processes.length) {
        const child = pool.processes[i++]

        if (!child.locked && child.running < minimum) {
            found = child
            minimum = child.running
        }
    }

    return found
}

function deinit(pool, child) {
    util.check(typeof pool === "object" && pool != null)
    util.check(typeof child === "object" && child != null)
    util.check(!child.locked)

    pool.runner.deinit(child)
    if (child.timeout != null) pool.runner.clearTimeout(child.timeout)
    child.lock()
    util.remove(pool.processes, child)
    pool.spawned--
}

function invokeInit(pool, request) {
    const child = nextReady(pool)

    if (child == null) {
        pool.taskQueue.push(request)
        util.onCancel(request.method.options, () => {
            // Only reject if it hasn't been pulled out yet.
            if (util.remove(pool.taskQueue, request)) {
                (0, request.reject)(new util.Cancel())
            }
        })
    } else {
        util.check(!child.locked)
        if (child.timeout != null) {
            pool.runner.clearTimeout(child.timeout)
            child.timeout = undefined
        }
        child.call(request)
    }
}

function loadInit(pool, request) {
    const child = nextReady(pool)

    if (child != null) {
        util.check(!child.locked)
        child.load(request)
    } else {
        pool.loadQueue.push(request)
    }
}

/**
 * A process pool featuring adaptive process scheduling and allocation. This is
 * the backbone of the module, the workhorse that makes things fast behind the
 * scenes.
 */
module.exports = class Pool {
    constructor(opts) { // eslint-disable-line max-statements
        // Injection
        this.runner = opts != null && opts.runner != null
            ? opts.runner : runner

        // Options
        this.onError = e => { this.runner.onError(e) }
        this.cwd = this.runner.cwd()
        this.env = this.runner.env()
        this.minimum = 1
        this.limit = Math.max(1, this.runner.limit()|0)
        this.timeout = 30 * 1000
        this.retries = 5
        this.maxPerChild = 0

        if (opts != null) {
            if (opts.cwd != null) this.cwd = path.resolve(this.cwd, opts.cwd)
            if (opts.env != null) this.env = Object.assign({}, opts.env)
            if (opts.minimum != null) this.minimum = Math.max(1, opts.minimum|0)
            if (opts.timeout != null) this.timeout = Math.max(0, opts.timeout|0)
            if (opts.retries != null) this.retries = Math.max(0, opts.retries|0)
            if (opts.onError != null) this.onError = e => { opts.onError(e) }
            // Floor the limit to the minimum
            if (opts.limit != null) {
                this.limit = Math.max(this.minimum, opts.limit|0)
            }
            if (opts.maxPerChild != null) {
                this.maxPerChild = Math.max(1, opts.maxPerChild|0)
            }
        }

        // Pool state
        this.spawned = this.minimum
        this.waiting = this.minimum
        this.processes = []

        // Task/module queues
        this.taskQueue = []
        this.loadQueue = []

        // Module statistics
        this.requests = Object.create(null) // name -> outstanding requests
        this.cache = Object.create(null) // name -> initialized object

        // Initialize the minimum processes
        for (let i = 0; i < this.minimum; i++) {
            this.runner.spawn(this)
        }
    }

    /**
     * Create a child. This is overridable for testing.
     */
    child(process) {
        return new Child(this, process)
    }

    /**
     * Respawn a dead `child`, logging an `err`.
     */
    respawn(child, err) {
        util.check(typeof child === "object" && child != null)
        // The child might be locked before the timeout released (e.g. if
        // they're scheduled for the same tick).
        if (child.locked) return

        // This rejects all the currently executing tasks when a child dies,
        // recommending that their callee reattempt. There's no better recourse
        // other than this, because the modules could have their own state.
        const rejects = []

        for (const id in child.calls) {
            if (hasOwn.call(child.calls, id)) {
                const call = child.calls[id]

                if (call.module != null) {
                    const options = call.options

                    // Modules are never null
                    if (hasOwn.call(child.delayed, id) ||
                            options != null && options.noRetry) {
                        this.load(call)
                    } else {
                        rejects.push(call.reject)
                    }
                } else {
                    const options = call.method.options

                    if (hasOwn.call(child.delayed, id) ||
                            call.index !== call.args.length ||
                            options != null && options.noRetry) {
                        call.index = 0
                        invokeInit(this, call)
                    } else {
                        rejects.push(call.reject)
                    }
                }
            }
        }

        if (this.spawned < this.minimum) {
            this.runner.spawn(this)
            this.spawned++
            this.waiting++
        }

        // TODO: support preloading (preload dead modules)
        deinit(this, child)
        this.onError(err)

        this.runner.defer(() => {
            for (let i = 0; i < rejects.length; i++) {
                (0, rejects[i])(new util.Retry())
            }
        })
    }

    /**
     * Schedule a task with a `method` (reference) and `args`, and return a
     * promise resolved when done, rejected on error.
     */
    invoke(method, args) {
        util.check(typeof method === "object" && method != null)
        util.check(args == null || typeof args === "object")

        return new Promise((resolve, reject) => {
            invokeInit(this, {method, args, resolve, reject, index: 0})
        })
    }

    /**
     * Load a `module` (name) with an optional `options` object. Call `resolve`
     * on success, `reject` on error.
     */
    load(request) {
        util.check(typeof request === "object" && request != null)
        const cached = this.cache[request.module]

        if (cached != null) {
            const resolve = request.resolve
            const reject = request.reject
            let timer

            util.onCancel(request.options, () => {
                if (timer != null) {
                    this.runner.clear(timer)
                    timer = undefined
                    reject(new util.Cancel())
                }
            })

            // Double-defer so it can be cancelled correctly by subsequent async
            // promise calls that use `setImmediate` to defer instead of
            // `process.nextTick`.
            timer = this.runner.defer(() => {
                timer = this.runner.defer(() => {
                    timer = undefined
                    resolve(cached.proxy)
                })
            })
            return
        }

        let requests = this.requests[request.module]
        const first = requests == null

        if (first) {
            requests = this.requests[request.module] = []
        }

        requests.push(request)

        util.onCancel(request.options, () => {
            // Only reject if it hasn't been run yet.
            const requests = this.requests[request.module]

            if (requests != null && util.remove(requests, request)) {
                if (!requests.length) {
                    this.runner.clear(requests.timer)
                    delete this.requests[request.module]
                }
                (0, request.reject)(new util.Cancel())
            }
        })

        if (first) {
            // Double-defer so it can be cancelled correctly by subsequent async
            // promise calls that use `setImmediate` to defer instead of
            // `process.nextTick`.
            requests.timer = this.runner.defer(() => {
                requests.timer = this.runner.defer(() => {
                    requests.timer = undefined
                    loadInit(this, request)
                })
            })
        }
    }

    // Module loading takes priority over method execution to avoid
    // starvation. (Method calls require modules to be loaded, and module
    // loads are cached.)
    runNext(child) {
        util.check(typeof child === "object" && child != null)
        util.check(!child.locked)
        if (this.loadQueue.length) {
            child.load(this.loadQueue.shift())
        } else if (this.taskQueue.length) {
            child.call(this.taskQueue.shift())
        } else {
            child.timeout = this.runner.setTimeout(this.timeout, () => {
                // The child might be locked before the timeout released (e.g.
                // if they're scheduled for the same tick).
                if (!child.locked && this.spawned !== this.minimum) {
                    this.runner.kill(child)
                    deinit(this, child)
                }
            })
        }
    }

    spawnError(err) {
        this.spawned--
        // We're no longer waiting for the process.
        if (this.waiting) this.waiting--
        this.onError(err)
    }

    spawnNext(process) {
        util.check(typeof process === "object" && process != null)
        // We're no longer waiting for the process.
        if (this.waiting) this.waiting--
        const child = this.child(process)

        this.runner.init(child)
        this.processes.push(child)
        this.runNext(child)
    }
}
