# TODOs

Here's my TODO list, in order of decreasing importance.

(Note: 1-4 are all absolute blockers for going even beta, and 5-7 are blockers for going stable. 8-10 are nice to haves)

## Critical

These are all blocker for going alpha, since they're highly critical features.

1. Allow [async iterators](https://github.com/tc39/proposal-async-iteration) and [observables](https://github.com/tc39/proposal-observable) to be returned.

    - This blocks one of my primary needs for this.
    - This would make 2 even more imperative for performance reasons (binary transfer).
    - Individual `next`/etc. calls should not be cancellable - just not call the method and/or ignore the result instead.

    The APIs will be like this:

    - Iterators/async iterators: export function directly, return value detected with a `next` method (argument and return values observably coerced into promises and lifted, optimization will avoid the extra object).
    - Observables: return the result of either of the following:
        1. `invoke.observable(observer => ...)`. The `observer` argument is a plain object, and does *not* inherit from the proposal's `%SubscriptionObserverPrototype%`. This is the easiest.
        2. `invoke.observable(observable)`. Sugar for `invoke.observable(observer => observable.subscribe(observer))`, but verifies the `subscribe` method exists.
    - Both initial return values may optionally be wrapped in Promises.
    - Iterables will *not* be detected (i.e. no `Symbol.iterator` detection); only the iterators themselves.

    For observables in particular, they are initialized lazily, so you have to subscribe to the observable before events are fired. Additionally, each subscription is reflected in the relevant worker instance, and unsubscriptions are also translated across the boundary.

    The parent return value of these will be the following:

    - Async iterators/generators: An object with the proper methods, and polyfill `Symbol.asyncIterator` as appropriate.
    - Observables: An instance of a local ponyfill, and polyfill `Symbol.observable` as appropriate.

2. Route this module's IPC communication through fd 4 (sockets still through `process.send` and fd 3), with a special-purpose binary protocol.

    - Use a modified version of HTML's structured cloning for object transfer.
        - Preserve dates, errors (including native type and stack), buffers, sockets, and servers.
        - Preserve primitive reference types, except symbols.
        - Preserve `lastIndex` property of regexps.
        - Errors must include extra properties.
        - Buffers should be sent in raw form.
        - Use `process.send` for sockets/servers (closed in sending process by default).
        - Abort and reject with a `TypeError` instead of a `DataCloneError` instead if an inconvertible type is passed (e.g. functions, weak collections, symbols, promises).
        - Browser-specific objects won't be understood.
        - Zero-copy transfer won't be supported (OS reasons).
        - Structured cloning is intentionally designed to be efficient.
    - Perform streamed transfer for parallel serialization/deserialization.
    - Note: this protocol will be a very hot path (object transfer called once for each value, and protocol averaging 5-10 events per call), so it will need profiled, and allocation minimized.

    This will allow me to send lethal errors synchronously before the child process dies, which is an absolute must for fault tolerance.

    It will also speed up IPC significantly, a huge boon for observables and generators (including async generators), but also very useful for standard singular calls. It's not an absolute requirement for most CLI apps, but it will be incredibly useful for long-running servers and for some data-heavy and I/O-heavy apps. This will be fairly complex, but only really the translating from a stream of bytes to a series of events.

    It may potentially make certain bits of data less costly to transmit, so I may be able to get away with less heap data in JS land.

3. Catch and report process-fatal errors.

    - Reject the currently executing methods with the error.
    - Reject the rest with a `Retry`.
    - Requires that errors can be sent synchronously, which isn't possible with `process.send`.

## High

These are all blockers for going beta, since they're moderately critical features, but won't cause substantial problems if they're missing.

4. Use domains to catch errors, localized to a particular module/method.

    - Reject the currently executing method with the error.
    - Reject the rest with a `Retry`.
    - Requires that errors can be sent synchronously, which isn't possible with `process.send`.

5. Allow modules to default-export a promise, which will pave the way for async module loaders (e.g. AMD, `import` proposal).

6. Add preloading support by option:

    - Pool-level, for all processes.
    - Module-level, for individual modules (managed as in-memory dependencies).
    - Allows for use of require hooks/etc.

## Medium

These are all blockers for going stable, since they deal more with stability and polish than missing functionality.

7. Add preloading support by option:

    - Pool-level, for all processes.
    - Module-level, for individual modules (managed as in-memory dependencies).
    - Allows for use of require hooks/etc.

8. Allow killing a pool entirely, with all existing processes.

    - An option should be given to close it gracefully (scheduling results in a sync `ReferenceError`, but existing processes aren't terminated) or forcefully (outstanding tasks rejected immediately with a `invoke.PoolDeath`, and scheduling results in a `ReferenceError`).
    - Returns a Promise resolved when pool is successfully killed.
    - Returns an already-resolved Promise when pool is already dead.
    - The default pool should always remain unkillable, and should be detectable without requiring importing the module.

9. Switch the scheduling algorithm to use highest response ratio next, and track average call duration for each method (last N calls for some small but usable N). This will allow for far better cross-module scheduling, especially with the default pool and the later item with process priority/deadlines. Also, make the process finding sublinear, preferably constant, so it can provide better real-time guarantees.

## Lower

These won't block the stable release (or any minor release), because they're mainly focused on features, not functionality.

10. Port this to browsers using shared web workers.

11. Make the loader configurable per-module, at the pool level. Useful mainly for browsers, where there may not necessarily be a default loader, or even if there is, it's not always practical for some use cases.

12. Allow scheduling tasks that require process locks and/or increased priority and/or deadlines. This shouldn't be too difficult to add after the scheduling algorithm settles down, but will complicate the pool substantially.

13. In workers, make them able to know their worker status.

14. Make workers' default pool the pool they're contained in, unless they're isolated.

    - This will require broadcasting to the parent and other loaded modules status updates when tasks are created.
    - This will require a dedicated shared process (across all pools) for coordinating scheduling, for performance reasons.
    - The scheduler process should be very light, and should only need to do the following, little else:
        - Track pool statistics
        - Track IDs
        - Track pool processes and return next available one for that pool
        - Route processes to one another
        - Track pools and schedule pools/processes
        - Broadcast pool-level errors (Sockets are never transferred)
        - Kill pools + dependencies upon request
    - Peer processes would communicate sockets and objects directly to one another.
    - The parent process should *never* have tasks scheduled in it, and tasks should *never* be run in the scheduling process.
    - The default pool should be created afresh if the worker limit is just 1, and no extra intermediary process should be created in the absence of pools supporting multiple workers.

    This part will likely be the hardest part out of all of these.

## Wishlist

My wishlist for this. No guarantees about anything here, but any (or all) of these would be nice.

- Rewrite the core in C++ or maybe Rust (better, but harder V8 interop), compiling down to both native (for Node.js and other platforms) and WebAssembly (for web embeddings). I can then use threading and low-level constructs to drastically increase speed and reduce memory overhead, and would make the scheduler process mentioned above practically weightless. The main hurdle is that WebAssembly itself is too immature to be realistic at the moment, and won't be for a while. Best to revisit when things actually begin falling into place feature-wise (I need a *lot* more than simple number crunching for this).

- Change the module's cancellation API to match whatever proposal/idiom JS actually ends up using. So far, both major proposals (`Promise.prototype.cancel` à la [Bluebird](http://bluebirdjs.com/docs/api/cancellation.html) and [cancel tokens](https://github.com/tc39/proposal-cancelable-promises/tree/0e769fda8e16bff0feffe964fddc43dcd86668ba)) have died, and even the committee hasn't nailed down what precisely cancellation should be.

- Make the runner back-end configurable. It would make this much more portable, but the majority of the things in this list would make custom runners harder, some changing the prospective API significantly.
