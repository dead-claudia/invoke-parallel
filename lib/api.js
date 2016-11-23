"use strict"

const Module = require("module")
const path = require("path")
const PoolState = require("./pool")
const util = require("./util")

/**
 * Main API
 */
class Pool {
    constructor(opts) {
        this._ = new PoolState(opts)
    }

    /**
     * Get a copy of all options. Note that changing the result has no effect on
     * the pool itself.
     *
     * - `options.cwd` - The current working directory used for each process
     * - `options.env` - The environment used for each process
     * - `options.limit` - The process limit for the pool
     * - `options.minimum` - The minimum active processes for the pool
     * - `options.maxPerChild` - The maximum number of tasks each child process
     *   is allowed to handle at once (`0` means no limit)
     * - `options.timeout` - The timeout used for each child in the pool
     * - `options.retries` - The maximum number of retries when a child fails to
     *   spawn before giving up
     * - `options.onError` - The pool's error handler, bound to its options
     *   (note: this is not the actual instance).
     */
    options() {
        return {
            cwd: this._.cwd,
            env: Object.assign({}, this._.env),
            limit: this._.limit,
            minimum: this._.minimum,
            maxPerChild: this._.maxPerChild,
            timeout: this._.timeout,
            retries: this._.retries,
            onError: this._.onError,
        }
    }

    /**
     * Get a snapshot of per-child statistics as a list.
     */
    childStats() {
        return this._.processes.map(child => child.stats())
    }

    /**
     * Get the total number of running child processes.
     */
    total() {
        return this._.processes.length
    }

    /**
     * Get the total number of spawned processes, even if they aren't fully
     * initialized yet.
     */
    spawned() {
        return this._.spawned
    }

    /**
     * Get the total number of queued tasks.
     */
    queued() {
        return this._.loadQueue.length + this._.taskQueue.length
    }

    /**
     * Get the total number of actively running tasks.
     */
    running() {
        let sum = 0

        for (let i = 0; i < this._.processes.length; i++) {
            sum += this._.processes[i].running
        }

        return sum
    }

    /**
     * Get the total number of all tasks not yet completed.
     */
    waiting() {
        return this.queued() + this.running()
    }

    /**
     * Get a list of all loaded modules known to this pool.
     */
    loaded() {
        return Object.keys(this._.cache)
    }

    /**
     * Get a list of all methods owned by this module, given by absolute path
     * (resolved relative to current working directory). If it hasn't been
     * loaded yet, this returns `undefined`.
     */
    cached(module) {
        const mod = this._.cache[path.resolve(this._.cwd, module)]

        return mod != null ? Object.keys(mod.methods) : undefined
    }

    /**
     * Get a list of currently requested module loads.
     */
    loading() {
        return Object.keys(this._.requests)
    }
}
if (util.isDebug) exports.Pool = Pool

let defaultPool

function globalPool() {
    if (defaultPool == null) defaultPool = new Pool()
    return defaultPool
}

exports.cancelToken = util.cancelToken
exports.Retry = util.Retry
exports.Cancel = util.Cancel
exports.globalPool = globalPool
exports.pool = options => new Pool(options)
exports.load = (parent, request, options) => {
    let pool

    if (options != null) {
        if (options.pool != null) pool = options.pool
        // Sugar for enforced isolation.
        if (options.isolated) pool = new Pool(options.options)
    }

    if (pool == null) pool = globalPool()

    return new Promise((resolve, reject) => pool._.load({
        module: Module._resolveFilename(request, parent, false),
        options, resolve, reject,
    }))
}
