"use strict"

/**
 * This is the child module loaded with `child_process.fork`. Most of the logic
 * is in `./child-state.js`.
 */

const State = require("./worker-state")

const state = new State()

state.send = process.send
state.defer = setImmediate
state.clear = clearImmediate
state.require = require
state.uncache = mod => { delete require.extensions[require.resolve(mod)] }

// FIXME: Message communication needs to be made sync with sockets, so I can
// synchronously send the error and exit immediately after. These below won't
// work otherwise. Note that, as a caveat, I won't be able to send sockets as
// unhandled/uncaught errors.
// process.on("uncaughtException", err => state.die(err))
// process.on("unhandledRejection", err => state.die(err))

process.on("message", (message, socket) => state.invoke(message, socket))
process.send("start")
