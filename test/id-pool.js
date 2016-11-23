"use strict"

const t = require("thallium")
const assert = require("thallium/assert")
const idPool = require("../lib/id-pool")

function isActive(id) {
    if (!idPool.isActive(id)) {
        assert.fail("Expected {actual} to be an active ID", {actual: id})
    }
}

function isNotActive(id) {
    if (idPool.isActive(id)) {
        assert.fail("Expected {actual} to not be an active ID", {actual: id})
    }
}

t.test("id-pool", () => {
    t.before(idPool.clear)
    t.afterAll(idPool.clear)

    t.test("acquires and releases one ID without error", () => {
        const id = idPool.acquire()

        assert.isNumber(id)
        isActive(id)
        idPool.release(id)
    })

    t.test("acquires two IDs without error", () => {
        const id1 = idPool.acquire()
        const id2 = idPool.acquire()

        assert.isNumber(id1)
        assert.isNumber(id2)
        isActive(id1)
        isActive(id2)
        assert.notEqual(id1, id2)
        idPool.release(id1)
        isNotActive(id1)
        isActive(id2)
        idPool.release(id2)
        isNotActive(id1)
        isNotActive(id2)
    })

    t.test("releases two IDs out of order without error", () => {
        const id1 = idPool.acquire()
        const id2 = idPool.acquire()

        idPool.release(id2)
        isNotActive(id2)
        isActive(id1)
        idPool.release(id1)
        isNotActive(id2)
        isNotActive(id1)
    })
})
