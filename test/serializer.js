"use strict"

// Note: this doesn't test the internals very well - it only tests that they
// can be serialized with `JSON.stringify` (which Node's IPC uses) and come out
// matching the input.

const net = require("net")
const t = require("thallium")
const assert = require("thallium/assert")
const util = require("../test-util")

t.test("serializer", () => {
    t.test("serializes strings", () => {
        const data = util.toMessage("foo")

        assert.isString(data[0])
        assert.equal(data[1], undefined)
        assert.equal(data[2], undefined)
        assert.equal(util.toValue(data), "foo")
    })

    t.test("serializes numbers", () => {
        const data = util.toMessage(100000)

        assert.isString(data[0])
        assert.equal(data[1], undefined)
        assert.equal(data[2], undefined)
        assert.equal(util.toValue(data), 100000)
    })

    t.test("serializes booleans", () => {
        const data = util.toMessage(true)

        assert.isString(data[0])
        assert.equal(data[1], undefined)
        assert.equal(data[2], undefined)
        assert.equal(util.toValue(data), true)
    })

    t.test("serializes `null`s", () => {
        const data = util.toMessage(null)

        assert.isString(data[0])
        assert.equal(data[1], undefined)
        assert.equal(data[2], undefined)
        assert.equal(util.toValue(data), null)
    })

    t.test("serializes objects", () => {
        const data = util.toMessage({foo: "bar"})

        assert.isString(data[0])
        assert.equal(data[1], undefined)
        assert.equal(data[2], undefined)
        assert.match(util.toValue(data), {foo: "bar"})
    })

    t.test("serializes arrays", () => {
        const data = util.toMessage(["foo", "bar"])

        assert.isString(data[0])
        assert.equal(data[1], undefined)
        assert.equal(data[2], undefined)
        assert.match(util.toValue(data), ["foo", "bar"])
    })

    t.test("serializes sockets", () => {
        // Don't actually construct a socket.
        const socket = Object.create(net.Socket.prototype)
        const data = util.toMessage(socket)

        assert.isString(data[0])
        assert.equal(data[1], socket)
        assert.equal(data[2], undefined)
        assert.equal(util.toValue(data), socket)
    })

    t.test("serializes servers", () => {
        // Don't actually construct a socket.
        const server = Object.create(net.Server.prototype)
        const data = util.toMessage(server)

        assert.isString(data[0])
        assert.equal(data[1], server)
        assert.equal(data[2], undefined)
        assert.equal(util.toValue(data), server)
    })

    t.test("serializes sockets with opts", () => {
        // Don't actually construct a socket.
        const socket = Object.create(net.Socket.prototype)
        const data = util.toMessage(socket, {keepOpen: true})

        assert.isString(data[0])
        assert.equal(data[1], socket)
        assert.match(data[2], {keepOpen: true})
        assert.equal(util.toValue(data), socket)
    })

    t.test("serializes servers with opts", () => {
        // Don't actually construct a socket.
        const server = Object.create(net.Server.prototype)
        const data = util.toMessage(server, {keepOpen: true})

        assert.isString(data[0])
        assert.equal(data[1], server)
        assert.match(data[2], {keepOpen: true})
        assert.equal(util.toValue(data), server)
    })
})
