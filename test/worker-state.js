"use strict"

const net = require("net")
const t = require("thallium")
const assert = require("thallium/assert")
const serializer = require("../lib/serializer")
const M = require("../lib/enums").Messages
const State = require("../lib/worker-state")
const set = require("../lib/worker-api").set
const remove = require("../lib/util").remove
const idPool = require("../lib/id-pool")
const util = require("../test-util")

class Mock extends State {
    constructor(modules) {
        super()
        this.modules = modules != null ? modules : {}
        this.loaded = []
        this.sent = []
        this.deferred = []
    }

    // Abstract methods
    send() {
        const args = []

        for (let i = 0; i < arguments.length; i++) {
            args.push(arguments[i])
        }

        this.sent.push(args)
    }

    defer(func) {
        const args = []

        for (let i = 1; i < arguments.length; i++) {
            args.push(arguments[i])
        }

        const call = {func, args}

        this.deferred.push(call)
        return call
    }

    clear(timer) {
        remove(this.deferred, timer)
    }

    uncache(mod) {
        this.loaded.splice(this.loaded.indexOf(mod), 1)
    }

    require(mod) {
        if (this.modules[mod] == null) throw new Error("module not found")
        this.loaded.push(mod)
        try {
            return this.modules[mod]()
        } catch (e) {
            this.loaded.pop()
            throw e
        }
    }
}

t.test("worker-state", () => { // eslint-disable-line max-statements
    const sentinel1 = new Error("sentinel1")
    const sentinel2 = new Error("sentinel2")
    const socket = Object.create(net.Socket.prototype)
    const server = Object.create(net.Server.prototype)
    const method1 = util.spy(1, "foo result")
    const method2 = util.spy(2, "bar result")

    socket.method = () => {}
    server.method = () => {}

    const state = new Mock({
        "module-1": () => ({exports: () => "exports"}),
        "module-2": () => { throw sentinel1 },
        "module-3": () => ({method1, method2}),
        "module-4": () => ({exports() { throw sentinel2 }}),
        "send-opts-1": () => ({invoke: () => { throw set(sentinel1) }}),
        "send-opts-2": () => ({invoke: (arg, opts) => set(arg, opts)}),
    })

    function invoke() {
        const args = []

        for (let i = 0; i < arguments.length; i++) {
            args.push(arguments[i])
        }

        state.invoke(args)
    }

    function push(type, id, value) {
        serializer.send({send: state.invoke.bind(state)}, type, id, value)
    }

    function resolve() {
        const call = state.deferred.shift()

        call.func.apply(undefined, call.args)
    }

    function receivedValue(type, id, value, options) {
        assert.equal(state.sent.length, 1)
        serializer.send(state, type, id, value, options)
        const args = state.sent.shift()

        assert.match(state.sent.shift(), args)
    }

    function received() {
        const args = []

        for (let i = 0; i < arguments.length; i++) {
            args.push(arguments[i])
        }

        assert.equal(state.sent.length, 1)
        assert.match(state.sent.shift(), [args])
    }

    function loaded() {
        assert.equal(state.loaded.length, arguments.length)
        for (let i = 0; i < arguments.length; i++) {
            assert.equal(state.loaded.shift(), arguments[i])
        }
    }

    function called(func, inst) {
        const args = []

        for (let i = 2; i < arguments.length; i++) {
            args.push(arguments[i])
        }

        assert.equal(func.this.length, 1)
        assert.equal(func.args.length, 1)
        assert.match(func.this.shift(), inst)
        assert.match(func.args.shift(), args)
    }

    const all = util.step(idPool.acquire, idPool.release)
    const mod1 = all()

    mod1.all("load module-1", id => {
        invoke(M.Load, id, "module-1")
        resolve()
        received(M.Load, id, {exports: 0})
        loaded("module-1")
    })

    const mod3 = all()

    mod3.all("load module-3 cached", id => {
        invoke(M.LateLoad, id, "module-3")
        resolve()
        received(M.Load, id)
        loaded("module-3")
    })

    const mod3call1 = mod3()

    mod3call1.pre("init module-3 method1", id => {
        invoke(M.Init, id, "module-3", "method1")
        received(M.Next, id)
    })

    mod3call1("add module-3 method1 (arg 1)", id => {
        push(M.Add, id, "foo")
        received(M.Next, id)
    })

    const mod3call2 = mod3()

    mod3call2.pre("init module-3 method1", id => {
        invoke(M.Init, id, "module-3", "method1")
        received(M.Next, id)
    })

    all().all("load module-2", id => {
        invoke(M.Load, id, "module-2")
        resolve()
        receivedValue(M.Throw, id, sentinel1)
    })

    const mod3call3 = mod3()

    mod3call3.pre("init module-3 method2", id => {
        invoke(M.Init, id, "module-3", "method2")
        received(M.Next, id)
    })

    mod3call2("add module-3 method1 (arg 1)", id => {
        push(M.Add, id, "foo")
        received(M.Next, id)
    })

    mod3call1("add module-3 method1 (arg 2)", id => {
        push(M.Add, id, "bar")
        received(M.Next, id)
    })

    mod3call3("add module-3 method2 (arg 1, socket)", id => {
        push(M.Add, id, socket)
        received(M.Next, id)
    })

    mod3call2("add module-3 method1 (arg 2)", id => {
        push(M.Add, id, "bar")
        received(M.Next, id)
    })

    mod3call1.post("invoke module-3 method1", id => {
        invoke(M.Invoke, id)
        resolve()
        called(method1, undefined, "foo", "bar")
        receivedValue(M.Return, id, "foo result")
    })

    mod3call3("add module-3 method2 (arg 2)", id => {
        push(M.Add, id, "bar")
        received(M.Next, id)
    })

    mod3call2.post("invoke module-3 method1", id => {
        invoke(M.Invoke, id)
        resolve()
        called(method1, undefined, "foo", "bar")
        receivedValue(M.Return, id, "foo result")
    })

    all().all("load module-2", id => {
        invoke(M.Load, id, "module-2")
        resolve()
        loaded()
        receivedValue(M.Throw, id, sentinel1)
    })

    const mod3call4 = mod3()

    mod3call4.pre("init module-3 method1", id => {
        invoke(M.Init, id, "module-3", "method1")
        received(M.Next, id)
    })

    mod3call3.post("invoke module-3 method2", id => {
        invoke(M.Invoke, id)
        resolve()
        called(method2, undefined, socket, "bar")
        receivedValue(M.Return, id, "bar result")
    })

    const mod4 = all()

    mod4.all("load module-4", id => {
        invoke(M.Load, id, "module-4")
        resolve()
        received(M.Load, id, {exports: 0})
        loaded("module-4")
    })

    const mod4call1 = all()

    mod4call1.pre("init module-4 exports", id => {
        invoke(M.Init, id, "module-4", "exports")
        received(M.Next, id)
    })

    mod4call1.post("invoke module-4 exports", id => {
        invoke(M.Invoke, id)
        resolve()
        receivedValue(M.Throw, id, sentinel2)
    })

    mod3call4("add module-3 method1 (arg 1, server)", id => {
        push(M.Add, id, server)
        received(M.Next, id)
    })

    mod3call4("add module-3 method1 (arg 2)", id => {
        push(M.Add, id, "foo")
        received(M.Next, id)
    })

    mod3call4.post("invoke module-3 method1", id => {
        invoke(M.Invoke, id)
        resolve()
        called(method1, undefined, server, "foo")
        receivedValue(M.Return, id, "foo result")
    })

    const mod1call1 = mod1()

    mod1call1.pre("init module-1 exports (call 1)", id => {
        invoke(M.Init, id, "module-1", "exports")
        received(M.Next, id)
    })

    const mod1call2 = mod1()

    mod1call2.pre("init module-1 exports (call 2)", id => {
        invoke(M.Init, id, "module-1", "exports")
        received(M.Next, id)
    })

    mod1call2("add module-1 exports (call 2, arg 1)", id => {
        push(M.Add, id, "foo")
        received(M.Next, id)
    })

    const mod3call5 = mod3()

    mod3call5.pre("init module-1 exports (empty)", id => {
        invoke(M.Init, id, "module-3", "method1")
        received(M.Next, id)
    })

    mod1call2.post("cancel module-1 exports (call 2)", id => {
        invoke(M.Cancel, id)
        received(M.Cancel, id)
    })

    mod3call5.post("invoke module-1 exports (empty)", id => {
        invoke(M.Invoke, id)
        resolve()
        called(method1, undefined)
        receivedValue(M.Return, id, "foo result")
    })

    mod1call1.post("invoke module-1 exports (call 1)", id => {
        invoke(M.Invoke, id)
        resolve()
        receivedValue(M.Return, id, "exports")
    })

    const sendOpts1 = all()

    sendOpts1.all("load send-opts-1", id => {
        invoke(M.Load, id, "send-opts-1")
        resolve()
        received(M.Load, id, {invoke: 0})
        loaded("send-opts-1")
    })

    const sendOpts2 = all()

    sendOpts2.all("load send-opts-2", id => {
        invoke(M.Load, id, "send-opts-2")
        resolve()
        received(M.Load, id, {invoke: 2})
        loaded("send-opts-2")
    })

    const sendOpts1Call1 = all()

    sendOpts1Call1.pre("init send-opts-1 invoke", id => {
        invoke(M.Init, id, "send-opts-1", "invoke")
        received(M.Next, id)
    })

    const sendOpts2Call1 = all()

    sendOpts2Call1.pre("init send-opts-2 invoke (call 1)", id => {
        invoke(M.Init, id, "send-opts-2", "invoke")
        received(M.Next, id)
    })

    sendOpts2Call1("add send-opts-2 invoke (call 1, arg 1, socket)", id => {
        push(M.Add, id, socket)
        received(M.Next, id)
    })

    sendOpts2Call1("add send-opts-2 invoke (call 1, arg 2)", id => {
        push(M.Add, id, {keepOpen: true})
        received(M.Next, id)
    })

    sendOpts1Call1.post("invoke send-opts-1 invoke", id => {
        invoke(M.Invoke, id)
        resolve()
        receivedValue(M.Throw, id, sentinel1)
    })

    const sendOpts2Call2 = all()

    sendOpts2Call2.pre("init send-opts-2 invoke (call 2)", id => {
        invoke(M.Init, id, "send-opts-2", "invoke")
        received(M.Next, id)
    })

    sendOpts2Call2("add send-opts-2 invoke (call 2, arg 1)", id => {
        push(M.Add, id, "foo")
        received(M.Next, id)
    })

    sendOpts2Call1.post("invoke send-opts-2 invoke (call 1)", id => {
        invoke(M.Invoke, id)
        resolve()
        receivedValue(M.Return, id, socket, {keepOpen: true})
    })

    sendOpts2Call2.post("invoke send-opts-2 invoke (call 2)", id => {
        invoke(M.Invoke, id)
        resolve()
        receivedValue(M.Return, id, "foo")
    })
})
