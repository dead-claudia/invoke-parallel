"use strict"

const t = require("thallium")
const assert = require("thallium/assert")
const moduleWrap = require("../lib/module-wrap")

t.test("module-wrap", () => {
    function create(methods) {
        const pool = {
            calls: [],
            invoke(method, args) {
                this.calls.push({method, args})
            },
        }

        return moduleWrap.create(pool, "module", methods)
    }

    t.test("has correct properties", () => {
        const pool = {pool: true}
        const mod = moduleWrap.create(pool, "module", {one: 1, two: 2})

        assert.equal(mod.pool, pool)
        assert.equal(mod.name, "module")
        assert.isFunction(mod.proxy)
    })

    t.test("initial", () => {
        t.test("has correct proxy keys", () => {
            const mod = create({one: 1, two: 2})

            assert.match(Object.keys(mod.proxy), ["one", "two"])
        })

        t.test("has correct proxy types", () => {
            const mod = create({one: 1, two: 2})

            assert.isFunction(mod.proxy.one)
            assert.isFunction(mod.proxy.two)
        })

        t.test("has correct proxy lengths", () => {
            const mod = create({one: 1, two: 2})

            assert.match(mod.proxy.one.length, 1)
            assert.match(mod.proxy.two.length, 2)
        })

        t.test("is invokable without `this`", () => {
            const mod = create({foo: 0})

            ;(0, mod.proxy.foo)()
        })

        t.test("is invoked with correct method name", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy

            proxy.two()
            proxy.one()
            assert.match(
                mod.pool.calls.map(c => c.method.name),
                ["two", "one"]
            )
        })

        t.test("is invoked with correct args if none passed", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy

            proxy.one()
            proxy.two()
            assert.match(mod.pool.calls.map(c => c.args), [
                undefined,
                undefined,
            ])
        })

        t.test("is invoked with correct args if many passed", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy

            proxy.one("foo", "what")
            proxy.two("bar", "nope")
            assert.match(mod.pool.calls.map(c => c.args), [
                ["foo", "what"],
                ["bar", "nope"],
            ])
        })

        t.test("is invoked with correct module", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy

            proxy.one()
            proxy.two()

            assert.equal(
                mod.pool.calls[0].method.module,
                mod.pool.calls[1].method.module
            )
            assert.equal(mod.pool.calls[0].method.module, mod)
        })

        t.test("is invoked with correct options", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy

            proxy.one()
            proxy.two()

            assert.equal(
                mod.pool.calls[0].method.options,
                mod.pool.calls[1].method.options
            )
            assert.equal(mod.pool.calls[0].method.options, undefined)
        })
    })

    t.test("with opts", () => {
        t.test("has correct proxy keys", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            assert.match(Object.keys(proxy), ["one", "two"])
        })

        t.test("has correct proxy types", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            assert.isFunction(proxy.one)
            assert.isFunction(proxy.two)
        })

        t.test("has correct proxy lengths", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            assert.match(proxy.one.length, 1)
            assert.match(proxy.two.length, 2)
        })

        t.test("is invokable without `this`", () => {
            const mod = create({foo: 0})
            const proxy = mod.proxy({keepOpen: true})

            ;(0, proxy.foo)()
        })

        t.test("is invoked with correct method name", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            proxy.two()
            proxy.one()
            assert.match(
                mod.pool.calls.map(c => c.method.name),
                ["two", "one"]
            )
        })

        t.test("is invoked with correct args", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            proxy.one("foo", "what")
            proxy.two("bar", "nope")
            assert.match(mod.pool.calls.map(c => c.args), [
                ["foo", "what"],
                ["bar", "nope"],
            ])
        })

        t.test("is invoked with correct module", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            proxy.one()
            proxy.two()

            assert.equal(
                mod.pool.calls[0].method.module,
                mod.pool.calls[1].method.module
            )
            assert.equal(mod.pool.calls[0].method.module, mod)
        })

        t.test("is invoked with correct options", () => {
            const mod = create({one: 1, two: 2})
            const proxy = mod.proxy({keepOpen: true})

            proxy.one()
            proxy.two()

            assert.equal(
                mod.pool.calls[0].method.options,
                mod.pool.calls[1].method.options
            )
            assert.match(mod.pool.calls[0].method.options, {keepOpen: true})
        })
    })
})
