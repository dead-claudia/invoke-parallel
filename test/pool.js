"use strict"

// Apologies for the terse test names - I'm testing many different combinations
// at once, and there's a lot of information that needs to be conveyed with
// them.

const path = require("path")
const t = require("thallium")
const assert = require("thallium/assert")
const api = require("../lib/api")
const util = require("../test-util")
const Child = require("../lib/child")
const Pool = require("../lib/pool")
const onCancel = require("../lib/util").onCancel

function initLoad(child, request, finish) {
    child.completed.add(request)
    const requests = child.pool.requests[request.module]

    if (requests != null) {
        requests.forEach(req => {
            child.completed.add(req)
            if (req !== request) {
                child.loadRequests.splice(child.loadRequests.indexOf(req), 1)
            }
        })
    }
    finish(request.module)
    if (!child.cancelled.has(request)) child.decrement(request)
}

function initCall(child, request, value, resolve) {
    if (!child.cancelled.has(request)) {
        child.completed.add(request)
        child.decrement(request)
        child.pool.runner.defer(() => resolve(value))
        child.pool.runNext(child)
    }
}

// Override a few things to keep the child as more of a black box.
class MockChild extends Child {
    constructor(process, pool) {
        super(process, pool)
        this.loadRequests = []
        this.callRequests = []
        this.cancelled = new Set()
        this.completed = new Set()
    }

    load(request) {
        assert.isObject(request)
        onCancel(request.options, () => {
            this.cancelled.add(request)
            if (this.completed.has(request)) {
                this.loadRequests.splice(this.loadRequests.indexOf(request), 1)
            } else {
                this.decrement(request)
            }
            (0, request.reject)(new api.Cancel())
        })

        this.increment(request)
        this.loadRequests.push(request)
    }

    resolveLoad(request, methods) {
        assert.isObject(request)
        initLoad(this, request, mod => this.finishLoadResolve(mod, methods))
    }

    rejectLoad(request, error) {
        assert.isObject(request)
        initLoad(this, request, mod => this.finishLoadReject(mod, error, []))
    }

    call(request) {
        assert.isObject(request)
        onCancel(request.method.options, () => {
            this.cancelled.add(request)
            if (this.completed.has(request)) {
                this.callRequests.splice(this.callRequests.indexOf(request), 1)
            } else {
                this.decrement(request)
            }
            (0, request.reject)(new api.Cancel())
        })

        this.increment(request)
        this.callRequests.push(request)
    }

    resolveCall(request, value) {
        assert.isObject(request)
        initCall(this, request, value, request.resolve)
    }

    rejectCall(request, error) {
        assert.isObject(request)
        initCall(this, request, error, request.reject)
    }
}

class MockPool extends Pool {
    child(process) {
        return new MockChild(this, process)
    }
}

class Mock {
    constructor(opts) { this._ = new MockPool(opts) }
}
Object.setPrototypeOf(Mock.prototype, api.Pool.prototype)

t.test("pool", () => { // eslint-disable-line max-statements
    /**
     * This semi-declarative DSL makes it much easier and more concise to
     * describe each snapshot. Here's a quick overview:
     *
     * t.testSkip("name", () => {
     *     init(opts?)
     *     action()
     *     // Run a few assertions/etc.
     *     checkStatus(whatever)
     *     // more tasks
     * })
     *
     * Most of the top-level functions below are runnable commands for this DSL.
     * Also, `runner` and `pool` are the current runner and pool for the test.
     */

    let runner, pool

    function init(opts) {
        if (opts != null && opts.onError != null) {
            opts.onError = opts.onError.bind(opts)
        }
        runner = new util.Runner()
        pool = new Mock(Object.assign({runner}, opts || {}))
    }

    const check = (name, body) => t.test(name, () => {
        body()

        // Sanity checks to ensure the state always remains correct at the end
        // (i.e. no lost processes or memory leaks, returns completely to its
        // base state). Catches a whole host of memory issues.

        runner.resolve()
        // assert.equal(pool.running(), 0)

        for (const child of pool._.processes) {
            child.loadRequests = child.loadRequests
                .filter(req => !child.cancelled.has(req))
            child.callRequests = child.callRequests
                .filter(req => !child.cancelled.has(req))

            assert.match(child.loadRequests, [])
            assert.match(child.callRequests, [])
        }

        const options = pool.options()

        for (const timer of runner.timers.slice()) {
            assert.equal(timer.delay, options.timeout)
            ;(0, timer.callback)()
        }

        runner.resolve()
        assert.match(runner.deferred, [])

        assert.equal(pool._.processes.length, pool._.spawned)
        assert.equal(pool._.processes.length, options.minimum)
    })

    let loadData = Object.create(null)
    let loadCache = Object.create(null)
    let invokeData = Object.create(null)
    let data, mod, child

    function select(opts) {
        if (opts.load != null) data = loadData[opts.load]
        if (opts.invoke != null) data = invokeData[opts.invoke]
        if (opts.module != null) mod = pool._.cache[opts.module].proxy
        if (opts.child != null) child = pool._.processes[opts.child]
    }

    function load(id, name, options) {
        const deferred = util.defer()

        pool._.load({
            module: name, options,
            resolve: deferred.resolve,
            reject: deferred.reject,
        })
        loadData[id] = {name, deferred}
        select({load: id})
    }

    function consumeSpawn(id) {
        const process = runner.spawns.shift()()

        assert.match(process.messages.shift(), ["init"])
        select({child: id})
    }

    function resolveLoad(methods, cancel) {
        assert.assert(data.name != null, "current selection not a load data")
        child.resolveLoad(child.loadRequests.shift(), methods)
        runner.resolve()
        if (cancel) {
            assert.hasKeysMatch(data.deferred, {
                status: "rejected",
                value: new api.Cancel(),
            })
        } else {
            assert.hasKeys(data.deferred, {
                status: "resolved",
                value: pool._.cache[data.name].proxy,
            })
        }
        loadCache[data.name] = methods
    }

    function invoke(id, method, args, options) {
        const host = options != null ? mod(options) : mod

        invokeData[id] = {
            args, method,
            deferred: util.proxy(() => host[method].apply(undefined, args)),
            id: undefined,
        }
        select({invoke: id})
    }

    function resolveInvoke(status, value) {
        assert.assert(data.method != null, "current not an invoke data")
        assert.hasKeys(data.deferred, {status: "pending"})
        if (status === "resolved") {
            child.resolveCall(child.callRequests.shift(), value)
        } else {
            child.rejectCall(child.callRequests.shift(), value)
        }
        runner.resolve()
        assert.hasKeys(data.deferred, {status, value})
    }

    // This is meant as a batch check, so testing them all simultaneously leads
    // to more useful assertion error messages.
    function state(opts) {
        const found = {
            spawned: pool.spawned(),
            total: pool.total(),
            active: pool.childStats().filter(c => c.running).length,
            queued: pool.queued(),
            loading: pool.loading(),
            loaded: pool.loaded(),
            cached: Object.create(null),
        }

        if (opts.cached != null) {
            found.cached = Object.create(null)

            for (const key of Object.keys(opts.cached)) {
                const mod = pool._.cache[key]

                if (mod != null) found.cached[key] = Object.keys(mod.methods)
            }
        }

        for (const key of Object.keys(found)) {
            if (!{}.hasOwnProperty.call(opts, key)) delete found[key]
        }

        assert.hasKeysMatch(found, opts)
    }

    t.after(() => {
        pool = runner = undefined
        loadData = Object.create(null)
        loadCache = Object.create(null)
        invokeData = Object.create(null)
    })

    /* eslint-disable max-statements */

    t.test("opts methods", () => {
        t.test("onError()", () => {
            const opts = {
                _error: undefined,
                _count: 0,
                onError(e) {
                    this._error = e
                    this._count++
                },
            }

            init(opts)
            pool.options().onError(new Error("sentinel"))
            assert.equal(opts._count, 1)
            assert.match(opts._error, new Error("sentinel"))
        })

        t.test("cwd()", () => {
            init({cwd: "some/project/folder"})
            assert.equal(
                pool.options().cwd,
                path.resolve(runner.cwd(), "some/project/folder")
            )
        })

        t.test("cwd() default", () => {
            init()
            assert.equal(pool.options().cwd, runner.cwd())
        })

        t.test("env()", () => {
            init({env: {foo: "bar"}})
            assert.match(pool.options().env, {foo: "bar"})
        })

        t.test("env() default", () => {
            init()
            assert.match(pool.options().env, runner.env())
        })

        t.test("limit()", () => {
            init({limit: 10})
            assert.equal(pool.options().limit, 10)
        })

        t.test("limit() default", () => {
            init()
            assert.equal(pool.options().limit, runner.limit())
        })

        t.test("timeout()", () => {
            init({timeout: 10})
            assert.equal(pool.options().timeout, 10)
        })

        t.test("timeout() default", () => {
            init()
            assert.equal(pool.options().timeout, 30 * 1000)
        })

        t.test("retries()", () => {
            init({retries: 10})
            assert.equal(pool.options().retries, 10)
        })

        t.test("retries() default", () => {
            init()
            assert.equal(pool.options().retries, 5)
        })

        t.test("maxPerChild()", () => {
            init({maxPerChild: 10})
            assert.equal(pool.options().maxPerChild, 10)
        })

        t.test("maxPerChild() default", () => {
            init()
            assert.equal(pool.options().maxPerChild, 0)
        })
    })

    t.test("initial state", () => {
        init()
        state({
            spawned: 1,
            total: 0,
            active: 0,
            queued: 0,
            loading: [],
            loaded: [],
        })
    })

    check("load single module", () => {
        init()
        load(0, "module")

        state({
            spawned: 1,
            total: 0,
            active: 0,
            queued: 0,
            loading: ["module"],
            loaded: [],
        })

        runner.resolve()
        runner.resolve()
        state({
            spawned: 1,
            total: 0,
            active: 0,
            queued: 1,
            loading: ["module"],
            loaded: [],
        })

        assert.equal(data.deferred.status, "pending")
        consumeSpawn(0)

        state({
            spawned: 1,
            total: 1,
            active: 1,
            queued: 0,
            loading: ["module"],
            loaded: [],
        })

        assert.equal(data.deferred.status, "pending")
        assert.match(child.loadRequests, [{
            module: "module", options: undefined,
            resolve: data.deferred.resolve,
            reject: data.deferred.reject,
        }])

        child.resolveLoad(child.loadRequests.shift(), {method: 1})
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.equal(data.deferred.status, "resolved")
        assert.equal(data.deferred.value, pool._.cache["module"].proxy)

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })
    })

    check("invoke method", () => {
        init()
        load(0, "module")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method: 1})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })

        select({module: "module", child: 0})
        invoke(0, "method", ["foo", "bar"])
        resolveInvoke("resolved", "result")

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })
    })

    check("invoke multi serial", () => {
        init()
        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        select({module: "module-1", child: 0})
        invoke(0, "method1", ["foo", "bar"])
        resolveInvoke("resolved", "result")

        invoke(1, "method1", ["foo", "bar"])
        resolveInvoke("resolved", "result")
    })

    check("invoke multi parallel", () => {
        init()
        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        select({module: "module-1"})
        invoke(0, "method1", ["foo", "bar"])
        invoke(1, "method2", ["foo", "bar"])

        consumeSpawn(1)

        select({child: 0, invoke: 0})
        resolveInvoke("resolved", "result")

        invoke(2, "method2", ["foo", "bar"])

        select({child: 0, invoke: 1})
        resolveInvoke("resolved", "result")

        select({child: 1, invoke: 2})
        resolveInvoke("resolved", "result")
    })

    check("load 2 parallel + invoke 2 parallel", () => {
        init()
        load(0, "module-1")
        load(1, "module-2")

        runner.resolve()
        runner.resolve()
        consumeSpawn(0)
        consumeSpawn(1)

        select({child: 0, load: 0})
        resolveLoad({method1: 1, method2: 2})

        select({child: 1, load: 1})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 2,
            total: 2,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        select({module: "module-1"})
        invoke(0, "method1", ["foo", "bar"])
        select({module: "module-2"})
        invoke(1, "method2", ["foo", "bar"])

        select({child: 0, invoke: 0})
        resolveInvoke("resolved", "result")

        invoke(2, "method2", ["foo", "bar"])

        select({child: 1, invoke: 1})
        resolveInvoke("resolved", "result")

        select({child: 0, invoke: 2})
        resolveInvoke("resolved", "result")
    })

    check("load 2 parallel + invoke 2 parallel + cancel 1", () => {
        init()
        load(0, "module-1")
        load(1, "module-2")

        runner.resolve()
        runner.resolve()
        consumeSpawn(0)
        consumeSpawn(1)

        select({child: 0, load: 0})
        resolveLoad({method1: 1, method2: 2})

        select({child: 1, load: 1})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 2,
            total: 2,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        const cancel1 = util.cancel(runner)
        const cancel2 = util.cancel(runner)

        select({module: "module-1"})
        invoke(0, "method1", ["foo", "bar"], {cancelToken: cancel1})
        select({module: "module-2"})
        invoke(1, "method2", ["foo", "bar"], {cancelToken: cancel2})

        cancel1()
        select({invoke: 0})
        assert.equal(data.deferred.status, "pending")
        select({invoke: 1})
        assert.equal(data.deferred.status, "pending")

        runner.resolve()
        select({invoke: 0})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        select({invoke: 1})
        assert.equal(data.deferred.status, "pending")

        runner.resolve()
        select({child: 1, invoke: 1})
        resolveInvoke("resolved", "result")
    })

    check("load 2 serial", () => {
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        load(1, "module-2")
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })
    })

    check("load 2 serial + invoke 2 serial", () => {
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        load(1, "module-2")
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        select({module: "module-1", child: 0})
        invoke(0, "method1", ["foo", "bar"])
        resolveInvoke("resolved", "result")

        select({module: "module-2", child: 0})
        invoke(0, "method2", ["foo", "bar"])
        resolveInvoke("resolved", "result")
    })

    check("load + interleaved load and invoke + invoke", () => {
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        load(1, "module-2")
        select({module: "module-1", child: 1})
        invoke(0, "method1", ["foo", "bar"])

        runner.resolve()
        runner.resolve()
        consumeSpawn(1)

        select({child: 0, load: 1})
        resolveLoad({method1: 1, method2: 2})

        select({module: "module-1", child: 1})
        invoke(2, "method1", ["foo", "bar"])

        state({
            spawned: 2,
            total: 2,
            active: 2,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        select({child: 0, invoke: 0})
        resolveInvoke("resolved", "result")

        select({module: "module-2", child: 0})
        invoke(0, "method2", ["foo", "bar"])
        resolveInvoke("resolved", "result")

        select({child: 1, invoke: 2})
        resolveInvoke("resolved", "result")
    })

    check("load + cancel immediate", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel})
        cancel()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        consumeSpawn(0)
    })

    check("load + cancel immediate, duplicate calls", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel})
        cancel()
        cancel()
        cancel()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        consumeSpawn(0)
    })

    check("load + cancel running", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel})
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        cancel()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        resolveLoad({method1: 1, method2: 2}, true)
    })

    check("load + cancel running, duplicate calls", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel})
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        cancel()
        cancel()
        cancel()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        resolveLoad({method1: 1, method2: 2}, true)
    })

    check("load + cancel immediate, 2 serial", () => {
        init()
        const cancel1 = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel1})
        cancel1()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        consumeSpawn(0)
        runner.resolve()

        const cancel2 = util.cancel(runner)

        load(1, "module-2", {cancelToken: cancel2})
        cancel2()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
    })

    check("load + cancel running, 2 serial", () => {
        init()
        const cancel1 = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel1})
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        cancel1()
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        resolveLoad({method1: 1, method2: 2}, true)

        // This cancel is too late
        const cancel2 = util.cancel(runner)

        load(1, "module-1", {cancelToken: cancel2})
        runner.resolve()
        runner.resolve()
        cancel2()
        assert.hasKeysMatch(data.deferred, {
            status: "resolved",
            value: pool._.cache["module-1"].proxy,
        })
    })

    check("load + cancel immediate, 2 parallel", () => {
        init()
        const cancel1 = util.cancel(runner)
        const cancel2 = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel1})
        load(1, "module-2", {cancelToken: cancel2})

        cancel1()
        select({load: 0})
        assert.equal(data.deferred.status, "pending")

        cancel2()
        select({load: 1})
        assert.equal(data.deferred.status, "pending")

        runner.resolve()
        select({load: 0})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        select({load: 1})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })

        consumeSpawn(0)
    })

    check("load + cancel running, 2 parallel", () => {
        init()
        const cancel1 = util.cancel(runner)
        const cancel2 = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel1})
        load(1, "module-2", {cancelToken: cancel1})

        consumeSpawn(0)
        runner.resolve()
        runner.resolve()

        consumeSpawn(1)
        runner.resolve()
        runner.resolve()

        cancel1()
        cancel2()

        select({load: 0})
        assert.equal(data.deferred.status, "pending")
        select({load: 1})
        assert.equal(data.deferred.status, "pending")

        runner.resolve()
        select({load: 0})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        select({load: 1})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })

        select({child: 0, load: 0})
        resolveLoad({method1: 1, method2: 2}, true)

        select({child: 0, load: 1})
        resolveLoad({method1: 1, method2: 2}, true)
    })

    check("load 2 serial + invoke 2 distinct parallel + cancel 2 immediate", () => { // eslint-disable-line max-len
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        select({load: 0})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        load(1, "module-2")
        runner.resolve()
        runner.resolve()
        select({load: 1})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        const cancel1 = util.cancel(runner)
        const cancel2 = util.cancel(runner)

        select({module: "module-1"})
        invoke(0, "method1", ["foo", "bar"], {cancelToken: cancel1})

        select({module: "module-2"})
        invoke(1, "method2", ["foo", "bar"], {cancelToken: cancel2})

        cancel1()
        cancel2()

        select({invoke: 0})
        assert.equal(data.deferred.status, "pending")
        select({invoke: 1})
        assert.equal(data.deferred.status, "pending")

        runner.resolve()
        select({invoke: 0})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
        select({invoke: 1})
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })

        consumeSpawn(1)
    })

    check("load + invoke + cancel immediate, 2 serial", () => {
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        select({load: 0})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        const cancel1 = util.cancel(runner)

        select({module: "module-1"})
        invoke(0, "method1", ["foo", "bar"], {cancelToken: cancel1})

        cancel1()
        select({invoke: 0})
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })

        load(1, "module-2")
        runner.resolve()
        runner.resolve()
        select({load: 1})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        const cancel2 = util.cancel(runner)

        select({module: "module-2"})
        invoke(1, "method2", ["foo", "bar"], {cancelToken: cancel2})

        cancel2()
        select({invoke: 1})
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
    })

    check("load + invoke + cancel, 2 parallel", () => {
        init()

        load(0, "module-1")
        load(1, "module-2")

        consumeSpawn(0)
        runner.resolve()
        runner.resolve()

        consumeSpawn(1)
        runner.resolve()
        runner.resolve()

        select({child: 0, load: 0})
        resolveLoad({method1: 1, method2: 2})

        select({child: 0, load: 1})
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 2,
            total: 2,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1", "module-2"],
        })

        const cancel1 = util.cancel(runner)
        const cancel2 = util.cancel(runner)

        select({child: 0, module: "module-1"})
        invoke(0, "method1", ["foo", "bar"], {cancelToken: cancel1})

        select({child: 1, module: "module-2"})
        invoke(1, "method2", ["foo", "bar"], {cancelToken: cancel2})

        cancel1()
        select({invoke: 0})
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })

        cancel2()
        select({invoke: 1})
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new api.Cancel(),
        })
    })

    check("load parallel to max", () => {
        init({limit: 4})

        for (let i = 0; i < 8; i++) {
            const loading = []

            for (let j = 0; j <= i; j++) {
                loading.push(`module-${j}`)
            }

            load(i, `module-${i}`)
            runner.resolve()
            runner.resolve()
            state({
                spawned: Math.min(4, i + 1),
                total: 0,
                active: 0,
                queued: i + 1,
                loading,
                loaded: [],
            })
        }

        for (let i = 0; i < 4; i++) {
            consumeSpawn(i)
        }

        for (let i = 0; i < 8; i++) {
            select({child: i % 4, load: i})
            resolveLoad({method1: 1, method2: 2})
        }

        state({
            spawned: 4,
            total: 4,
            active: 0,
            queued: 0,
            loading: [],
            loaded: [
                "module-0", "module-1", "module-2", "module-3",
                "module-4", "module-5", "module-6", "module-7",
            ],
        })
    })

    check("load + invoke distinct, parallel to max", () => {
        init({limit: 4})

        function range(start, end, func) {
            if (func == null) { func = end; end = start; start = 0 }
            for (let i = start; i < end; i++) func(i)
        }

        range(8, i => {
            const loading = []

            range(0, i + 1, j => loading.push(`module-${j}`))
            load(i, `module-${i}`)
            runner.resolve()
            runner.resolve()
            state({
                spawned: Math.min(4, i + 1),
                total: 0,
                active: 0,
                queued: i + 1,
                loading,
                loaded: [],
            })
        })

        range(4, consumeSpawn)

        const cache = new Array(8).fill()

        function each(func) {
            range(8, i => {
                select({child: i % 4, load: i})
                cache[i] = func(i, cache[i])
            })
        }

        each(i => {
            const methods = {}

            methods[`method-${i}`] = 2
            child.resolveLoad(child.loadRequests.shift(), methods)
            assert.equal(data.deferred.status, "pending")
            return methods
        })

        runner.resolve()

        each((_, methods) => {
            assert.hasKeysMatch(data.deferred, {
                status: "resolved",
                value: pool._.cache[data.name].proxy,
            })
            loadCache[data.name] = methods
        })

        range(8, i => {
            select({module: `module-${i}`})
            invoke(i, `method-${i}`, ["foo", "bar"])
            assert.equal(data.deferred.status, "pending")
        })

        range(2, offset => {
            runner.resolve()

            function each(func) {
                range(offset * 4, offset * 4 + 4, i => {
                    select({child: i % 4, invoke: i})
                    func(`result-${i}`)
                })
            }

            each(value => {
                assert.equal(data.deferred.status, "pending")
                child.resolveCall(child.callRequests.shift(), value)
                assert.equal(data.deferred.status, "pending")
            })

            runner.resolve()

            each(value => {
                assert.hasKeys(data.deferred, {status: "resolved", value})
            })
        })

        state({
            spawned: 4,
            total: 4,
            active: 0,
            queued: 0,
            loading: [],
            loaded: [
                "module-0", "module-1", "module-2", "module-3",
                "module-4", "module-5", "module-6", "module-7",
            ],
        })
    })

    check("load 3 duplicate, serial", () => {
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        const mod = pool._.cache["module-1"]

        load(1, "module-1")
        runner.resolve()
        runner.resolve()
        assert.hasKeys(data.deferred, {status: "resolved", value: mod.proxy})
        assert.equal(pool._.cache["module-1"], mod)

        load(2, "module-1")
        runner.resolve()
        runner.resolve()
        assert.hasKeys(data.deferred, {status: "resolved", value: mod.proxy})
        assert.equal(pool._.cache["module-1"], mod)

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })
    })

    check("load 3 duplicate, parallel", () => {
        init()

        load(0, "module-1")
        load(1, "module-1")
        load(2, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})
        runner.resolve()

        const mod = pool._.cache["module-1"]

        select({load: 0})
        assert.hasKeys(data.deferred, {status: "resolved", value: mod.proxy})
        assert.equal(pool._.cache["module-1"], mod)

        select({load: 1})
        assert.hasKeys(data.deferred, {status: "resolved", value: mod.proxy})
        assert.equal(pool._.cache["module-1"], mod)

        select({load: 2})
        assert.hasKeys(data.deferred, {status: "resolved", value: mod.proxy})
        assert.equal(pool._.cache["module-1"], mod)

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })
    })

    check("load error", () => {
        init()

        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        child.rejectLoad(child.loadRequests.shift(), new Error("sentinel"))
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new Error("sentinel"),
        })

        assert.notHasOwn(pool._.cache, "module-1")

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: [],
        })
    })

    check("invoke single method error", () => {
        init()
        load(0, "module")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method: 1})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })

        select({module: "module", child: 0})
        invoke(0, "method", ["foo", "bar"])
        resolveInvoke("rejected", new Error("sentinel"))
    })

    check("invoke multi error, serial", () => {
        init()
        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        select({module: "module-1", child: 0})
        invoke(0, "method1", ["foo", "bar"])
        resolveInvoke("resolved", new Error("sentinel"))

        invoke(1, "method1", ["foo", "bar"])
        resolveInvoke("resolved", new Error("sentinel"))
    })

    check("invoke multi error, parallel", () => {
        init()
        load(0, "module-1")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method1: 1, method2: 2})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module-1"],
        })

        select({module: "module-1"})
        invoke(0, "method1", ["foo", "bar"])
        invoke(1, "method2", ["foo", "bar"])

        consumeSpawn(1)

        select({child: 0, invoke: 0})
        resolveInvoke("resolved", new Error("sentinel"))

        invoke(2, "method2", ["foo", "bar"])

        select({child: 0, invoke: 1})
        resolveInvoke("resolved", new Error("sentinel"))

        select({child: 1, invoke: 2})
        resolveInvoke("resolved", new Error("sentinel"))
    })

    check("load single module", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module", {cancelToken: cancel})

        state({
            spawned: 1,
            total: 0,
            active: 0,
            queued: 0,
            loading: ["module"],
            loaded: [],
        })

        runner.resolve()
        runner.resolve()
        state({
            spawned: 1,
            total: 0,
            active: 0,
            queued: 1,
            loading: ["module"],
            loaded: [],
        })

        assert.equal(data.deferred.status, "pending")
        consumeSpawn(0)

        state({
            spawned: 1,
            total: 1,
            active: 1,
            queued: 0,
            loading: ["module"],
            loaded: [],
        })

        assert.equal(data.deferred.status, "pending")
        assert.match(child.loadRequests, [{
            module: "module",
            options: {cancelToken: cancel},
            resolve: data.deferred.resolve,
            reject: data.deferred.reject,
        }])

        child.resolveLoad(child.loadRequests.shift(), {method: 1})
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.equal(data.deferred.status, "resolved")
        assert.equal(data.deferred.value, pool._.cache["module"].proxy)

        cancel()
        runner.resolve()
        runner.resolve()

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })
    })

    check("cancel after invoke method", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method: 1})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })

        select({module: "module", child: 0})
        invoke(0, "method", ["foo", "bar"], {cancelToken: cancel})
        resolveInvoke("resolved", "result")

        cancel()
        runner.resolve()
        runner.resolve()

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })
    })

    check("cancel after load error", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module-1", {cancelToken: cancel})
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        child.rejectLoad(child.loadRequests.shift(), new Error("sentinel"))
        assert.equal(data.deferred.status, "pending")
        runner.resolve()
        assert.hasKeysMatch(data.deferred, {
            status: "rejected",
            value: new Error("sentinel"),
        })

        assert.notHasOwn(pool._.cache, "module-1")

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: [],
        })

        cancel()
        runner.resolve()
        runner.resolve()

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: [],
            cached: {},
        })
    })

    check("cancel after invoke error", () => {
        init()
        const cancel = util.cancel(runner)

        load(0, "module")
        consumeSpawn(0)
        runner.resolve()
        runner.resolve()
        resolveLoad({method: 1})

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })

        select({module: "module", child: 0})
        invoke(0, "method", ["foo", "bar"], {cancelToken: cancel})
        resolveInvoke("rejected", new Error("sentinel"))

        cancel()
        runner.resolve()
        runner.resolve()

        state({
            spawned: 1,
            total: 1,
            active: 0,
            queued: 0,
            loading: [],
            loaded: ["module"],
            cached: {module: ["method"]},
        })
    })
})
