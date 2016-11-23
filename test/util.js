"use strict"

const t = require("thallium")
const assert = require("thallium/assert")
const util = require("../lib/util")

t.test("util", () => {
    t.test("remove()", () => {
        const list = [1, 2, 3, 4, 5]

        util.remove(list, 3)
        assert.match(list, [1, 2, 4, 5])
        util.remove(list, 6)
        assert.match(list, [1, 2, 4, 5])
        util.remove(list, 5)
        assert.match(list, [1, 2, 4])
        util.remove(list, 1)
        assert.match(list, [2, 4])

        const empty = []

        util.remove(empty, 1)
        assert.match(empty, [])
    })

    t.test("onCancel()", () => {
        const spy = () => { spy.count++ }

        t.before(() => spy.count = 0)

        t.test("works with `null` opts", () => {
            util.onCancel(null, spy)
            assert.equal(spy.count, 0)
        })

        t.test("works with `undefined` opts", () => {
            util.onCancel(undefined, spy)
            assert.equal(spy.count, 0)
        })

        t.test("works with empty opts", () => {
            util.onCancel({}, spy)
            assert.equal(spy.count, 0)
        })

        t.test("works with non-promise opts.cancelToken", () => {
            util.onCancel({cancelToken: "nope"}, spy)
            assert.equal(spy.count, 0)
        })

        t.test("works with resolved thenable opts.cancelToken", () => {
            const thenable = {
                then(resolve, reject) {
                    this.resolve = resolve
                    this.reject = reject
                },
            }

            util.onCancel({cancelToken: thenable}, spy)
            thenable.resolve()
            assert.equal(spy.count, 1)
        })

        t.test("works with duplicate resolutions", () => {
            const thenable = {
                then(resolve, reject) {
                    this.resolve = resolve
                    this.reject = reject
                },
            }

            util.onCancel({cancelToken: thenable}, spy)
            thenable.resolve()
            thenable.resolve()
            thenable.resolve()
            assert.equal(spy.count, 1)
        })

        t.test("works with rejected thenable opts.cancelToken", () => {
            const err = new Error("sentinel")
            const thenable = {
                then(resolve, reject) {
                    this.resolve = resolve
                    this.reject = reject
                },
            }

            util.onCancel({cancelToken: thenable}, spy)
            assert.throwsMatch(e => err === e, () => thenable.reject(err))
            assert.equal(spy.count, 0)
        })

        t.test("works with throwing thenable opts.cancelToken", () => {
            const thenable = {then() { throw new Error() }}

            util.onCancel({cancelToken: thenable}, spy)
            assert.equal(spy.count, 0)
        })
    })
})
