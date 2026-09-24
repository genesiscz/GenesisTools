# Port notes: heartbeat, scheduling, submission and slurp twins

Written 2026-09-23 19:15. Twins: `coordinator.heartbeat.test.ts`, `coordinator.scheduling.test.ts`,
`coordinator.submission.test.ts`, `coordinator.slurp.test.ts`. Helpers: `testing/hss-helpers.ts`.

## PORT-DEFECT

<!-- updated 2026-09-23 23:20: defect 1 fixed in daa6b43b2 (channels read once before the loop); the twin runs and passes -->

1. **FIXED (daa6b43b2). The run loop re-read the inbox output every iteration.**
   Go captures the select channels once before the loop:
   `inboxOutput := current.dependencies.Inbox.Output()` and
   `operationUpdates := current.dependencies.Operations.Updates()` (`harness/coordinator/loop.go:99-100`).
   Only `processEvents` re-reads `current.dependencies.Inbox.Output()` for its slurp (`loop.go:191`).
   The TS loop reads `this.deps.inbox.outputQueue()` and `this.deps.operations.updates()` at the top of
   every iteration (`coordinator.ts:259-260`).
   Effect: `TestCoordinatorHeartbeatPropagatesSubmissionFailure` swaps `deps.inbox` for a stopped inbox
   inside `onSaveOperation`. Go keeps selecting on the live output, the heartbeat timer fires, and the
   heartbeat `Submit` into the stopped inbox fails with `want`. TS selects on the stopped inbox's closed
   queue on the next iteration and returns `inbox output closed` before the heartbeat fires (verified with
   a probe: the run settles during `run.update(0, "awaiting")`).
   Fix: capture `const inboxQueue = this.deps.inbox.outputQueue()` and
   `const updateQueue = this.deps.operations.updates()` once, before `while (true)`, and keep the slurp in
   `processEvents` reading `this.deps.inbox.outputQueue()` as Go does. The twin is `test.skip` with a
   `PORT-DEFECT` comment; un-skip it after the fix.

## Mappings that are not one-to-one

2. **Slurp twins go through the loop.** `slurpChannel` is the private `slurp` method, reachable only
   through `run()`. Each `slurp_test.go` twin drives the inbox slurp: a trigger input is consumed by the
   select, the values queued behind it are what the slurp sees, the store's appended inputs are the
   slurp's return value, and the virtual time at which they land (plus the model request one
   `SLURP_IDLE_MS` later, after the update slurp) is `time.Since(startedAt)`. `close(output)` is aborting
   the inbox signal; `cancel(cause)` is aborting the run signal, which surfaces as `slurp inbox: <cause>`.
   The full mapping is in the header of `coordinator.slurp.test.ts`.
3. **`localfile.Store` is `MemoryStore`.** `persistTestRun` / `restoreTestRun` (from
   `recovery_sequences_test.go`) use `sessionstore.MemoryStore`. `MemoryStore.resume` returns every
   operation; localfile returns only unfinished ones plus terminal states missing from tool-call history,
   and only external input IDs. No submission twin observes the difference: an extra terminal state only
   re-sets local state history already holds, a terminal operation is never dispatched, and the test inbox
   is built without seen IDs.
   <!-- updated 2026-09-24 06:14: the difference is gone, MemoryStore.resume now returns localfile's set (PR #422 review); commit 5a114409c -->

4. **`StopTestRun.start()` discards a restored state.** It sets `deps.restored = store.resume` (the fake
   store's), so a run prepared by `restoreTestRun` starts with `startRestored(run, signal)` instead.
   <!-- updated 2026-09-23 23:51: fixed in the driver; `start()` keeps a replaced `deps.restored`, so `startRestored` is deleted and the submission twins call `run.start(signal)` -->
5. **Blocking `<-run.done` is `awaitDone(run)`.** In a synctest bubble a blocking receive lets the clock
   jump through slurp idle windows; `awaitDone` advances the virtual clock one `SLURP_IDLE_MS` at a time
   until the run settles. A non-blocking `select { case <-run.done: default: }` stays `run.done.settled`.
   `TestCoordinatorHeartbeatRequiresPersistence` needs this: after `advanceHeartbeatTime(time.Second)` the
   heartbeat input is still inside the 1 ms inbox slurp window.
6. **`state.availableInputs` is `pendingInputs() + deliveredInputs`.** The internals do not expose
   `availableInputs`; `pendingInputs` is `availableInputs - deliveredInputs` in both ports.
7. **Go `context.Canceled` is `contextCanceled`** (an `AbortedError` in `hss-helpers.ts`), passed as the
   abort reason; `errors.Is` is `errorIs`, which walks the `cause` chain.
8. **`scheduling_test.go` tests that build their own coordinator** (`independentToolCalls` + test inbox +
   fake operation manager + recording adapter) use `newStopTestRun(count)`, which is that same set with the
   virtual clock the twins need.
