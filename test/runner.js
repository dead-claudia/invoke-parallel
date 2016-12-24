"use strict"

const EventEmitter = require("events").EventEmitter
const os = require("os")
const t = require("thallium")
const assert = require("thallium/assert")
const runner = require("../lib/runner.js")

t.test("runner", () => {
    t.test("limit()", () => {
        assert.equal(runner.limit(), os.cpus().length + 1)
    })

    t.test("cwd()", () => {
        t.test("initial", () => {
            assert.equal(runner.cwd(), process.cwd())
        })

        t.test("changed", () => {
            const cwd = process.cwd()

            try {
                const newCwd = os.tmpdir()

                process.chdir(newCwd)
                assert.equal(runner.cwd(), newCwd)
            } finally {
                process.chdir(cwd)
            }
        })
    })

    t.test("env()", () => {
        assert.equal(runner.env(), process.env)
    })

    t.test("onError()", () => {
        const old = console.error // eslint-disable-line no-console
        const captures = []

        console.error = e => captures.push(e) // eslint-disable-line no-console

        try {
            runner.onError(new Error("sentinel"))
            assert.match(captures, [new Error("sentinel")])
        } finally {
            console.error = old // eslint-disable-line no-console
        }
    })

    t.test("init()", () => {
        class Pool {
            constructor() {
                this.respawned = []
                this.errors = []
                this.onError = e => this.errors.push(e)
            }

            respawn(child, error) {
                this.respawned.push({child, error})
            }
        }

        class Child {
            constructor() {
                this.pool = new Pool()
                this.process = new EventEmitter()
                this.received = []
            }

            handle(message, socket) {
                this.received.push({message, socket})
            }
        }

        t.test("handles `message` events", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("message", ["foo", "bar"], {type: "socket"})
            assert.match(child.received, [
                {message: ["foo", "bar"], socket: {type: "socket"}},
            ])
        })

        t.test("handles `error` events", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("error", new Error("sentinel"))
            assert.match(child.pool.errors, [new Error("sentinel")])
        })

        t.test("handles `exit` events with code", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("exit", 0)
            assert.match(child.pool.respawned, [
                {child, error: new Error("Child exited with code 0")},
            ])
        })

        t.test("handles `exit` events with non-zero code", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("exit", 10)
            assert.match(child.pool.respawned, [
                {child, error: new Error("Child exited with code 10")},
            ])
        })

        t.test("handles `exit` events with signal", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("exit", null, "SIGKILL")
            assert.match(child.pool.respawned, [
                {child, error: new Error("Child exited with signal SIGKILL")},
            ])
        })

        t.test("handles `exit` events with code + signal", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("exit", 0, "SIGKILL")
            assert.match(child.pool.respawned, [
                {child, error: new Error(
                    "Child exited with code 0, signal SIGKILL"
                )},
            ])
        })

        t.test("handles `exit` events with non-zero code + signal", () => {
            const child = new Child()

            runner.init(child)
            child.process.emit("exit", 10, "SIGKILL")
            assert.match(child.pool.respawned, [
                {child, error: new Error(
                    "Child exited with code 10, signal SIGKILL"
                )},
            ])
        })

        t.test("clears `message` listeners first", () => {
            const child = new Child()
            const received = []

            child.process.on("message", (message, socket) => {
                received.push({message, socket})
            })

            runner.init(child)
            child.process.emit("message", ["foo", "bar"], {type: "socket"})
            assert.match(received, [])
        })

        t.test("clears `error` listeners first", () => {
            const child = new Child()
            const received = []

            child.process.on("error", e => received.push(e))
            runner.init(child)
            child.process.emit("error", new Error("sentinel"))
            assert.match(received, [])
        })

        t.test("clears `exit` listeners first", () => {
            const child = new Child()
            const received = []

            child.process.on("error", (code, status) => {
                received.push({code, status})
            })
            runner.init(child)
            child.process.emit("exit", 10, "SIGKILL")
            assert.match(received, [])
        })
    })

    // This is more of a smoke test than anything, because it's highly
    // non-deterministic, and the worker itself is highly encapsulated
    // (prohibiting inspection).
    t.test("spawn()", () => {
        t.slow = 250

        t.test("default cwd + env", () => {
            return new Promise((resolve, reject) => {
                runner.spawn({
                    cwd: process.cwd(),
                    env: process.env,
                    retries: 5,
                    spawnNext: resolve,
                    spawnError: reject,
                })
            })
            .then(proc => {
                assert.match(proc.stdio, [null, null, null, null])
                proc.removeAllListeners()
                proc.kill("SIGKILL")
            })
        })

        t.test("custom cwd + env", () => {
            return new Promise((resolve, reject) => {
                runner.spawn({
                    cwd: os.tmpdir(),
                    env: {foo: "bar"},
                    retries: 5,
                    spawnNext: resolve,
                    spawnError: reject,
                })
            })
            .then(proc => {
                assert.match(proc.stdio, [null, null, null, null])
                proc.removeAllListeners()
                proc.kill("SIGKILL")
            })
        })
    })

    t.test("deinit()", () => {
        t.test("clears `message` listeners first", () => {
            const child = {process: new EventEmitter()}
            const received = []

            child.process.on("message", (message, socket) => {
                received.push({message, socket})
            })

            runner.deinit(child)
            child.process.emit("message", ["foo", "bar"], {type: "socket"})
            assert.match(received, [])
        })

        t.test("leaves `error` listeners", () => {
            const child = {process: new EventEmitter()}
            const received = []

            child.process.on("error", e => received.push(e))
            runner.deinit(child)
            child.process.emit("error", new Error("sentinel"))
            assert.match(received, [new Error("sentinel")])
        })

        t.test("clears `exit` listeners first", () => {
            const child = {process: new EventEmitter()}
            const received = []

            child.process.on("error", (code, status) => {
                received.push({code, status})
            })
            runner.deinit(child)
            child.process.emit("exit", 10, "SIGKILL")
            assert.match(received, [])
        })
    })
})
