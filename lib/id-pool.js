"use strict"

// TODO: check the long-term memory usage for this, and use an adaptation of
// Justin Collins' Dumb Numb Set (in Ruby) to compress the memory a little bit.
//
// https://github.com/presidentbeef/dumb-numb-set

/**
 * The ID pool for this module. Notes about this:
 *
 * 1. All IDs are positive, non-zero, 31-bit integers.
 *
 * 2. This keeps the free IDs as a linked list stack embedded in a hash table:
 *
 *    - `ids` is partially treated as a hash table of id -> next.
 *    - `ids[id] === 0` is the bottom when one exists.
 *    - Free ID entries can never be negative.
 *
 * 3. The used IDs are not contained within the table.
 *
 * 4. Acquiring and releasing IDs is guaranteed to be in amortized O(1) time.
 *
 * 5. The number of total generated IDs ever is `last`.
 *
 * This is intentionally somewhat optimized, because this is shared across all
 * pools, and each function is called at least once per call, often multiple
 * times.
 */
const util = require("./util")
const used = Object.create(null)

// All of the primary exports must be monomorphic, well-typed, and inlinable.
exports.acquire = () => {
    let id = 0

    do {
        id = 1 + (Math.random() * 0x7ffffffe | 0)
    } while (used[id] != null)

    used[id] = true
    return id
}

exports.release = id => {
    // Disallow duplicate release
    util.check(typeof id === "number")
    util.check(used[id] != null)
    delete used[id]
}

// For testing.
if (util.isDebug) {
    exports.isActive = id => {
        util.check(typeof id === "number")
        return used[id] != null
    }

    exports.clear = () => {
        for (const id of Object.keys(used)) {
            delete used[id]
        }
    }

    exports.active = () => {
        return Object.keys(used)
    }
}
