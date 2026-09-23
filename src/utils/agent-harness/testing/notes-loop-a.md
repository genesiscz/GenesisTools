# Notes: loop_test.go twins, part 1 (coordinator.loop-a.test.ts)

Written 2026-09-23 19:12. Scope: `harness/coordinator/loop_test.go` lines 1 to 1389, from
`TestCoordinatorRestoresSession` through `TestCoordinatorRunHandlesOperationUpdateWhileModelIsRunning`.
All 29 Go tests have a twin of the same name. 29 pass. One extra skipped test holds the Go subtests
that cannot be ported (entry 1).

## Skips

<!-- updated 2026-09-24 00:10: RESOLVED. `addItemToLocalState` now runs `assertItemData`, a runtime shape check per kind that fails with Go's "<kind> data is <type>, want <T>" wording, so all seven subtests run in the one twin from unchecked JSON items. No skip remains in this file. -->

1. **RESOLVED (was PORT-NA), `TestCoordinatorRejectsInvalidSessionItemData`, five of seven subtests.** The subtests
   "fork", "input", "turn", "response" and "status" (loop_test.go:719-726) store a `session.Turn` or
   an `inbox.Input` as the `Data` of an item of another kind. They expect the coordinator's Go type
   assertion to fail with "want sessionstore.Fork" and similar. The port's `Item` is a discriminated
   union, so typed code cannot build such an item. `addItemToLocalState` (coordinator.ts:718-799) has
   no runtime shape check that could fail. The two content subtests, "invalid input" and "kind", run
   in the main twin and pass. The five are in
   `test.skip("TestCoordinatorRejectsInvalidSessionItemData (typed Data subtests)")`.
   - The orchestrator decides whether this is a defect. It becomes one if the port ever loads items
     from untyped JSON (a file store) without a shape check. The Go store decodes `Data` per kind, so
     Go meets malformed data only in memory.

## Deviations that are not skips

2. **No `addToolCallsToLocalState` or `addOperationToLocalState` on the internals.** Four Go tests call
   these methods directly. The twins reach the same state through the existing surface:
   - Tool calls: `addItemToLocalState({Kind: "model_response"})` through a `GatedBuilder` that mutes
     `addModelResponse` for that one call, so the context stays as Go's method leaves it
     (`addToolCallsToLocalState` in loop-a-helpers.ts).
   - Operations: `handleOperationUpdate`, which also writes the operation to the fake store. None of
     those tests assert on the store.
   <!-- updated 2026-09-23 23:51: tool calls now go through the typed `internals.addToolCallsToLocalState(response)`, as in Go; `GatedBuilder` and the muting helper are deleted, and `FailingBuilder` comes from rest-helpers. The operation bullet is unchanged. -->
3. **`TestCoordinatorToolCallOperationsAreTerminal` builds its state through entry points.** Go writes
   `state.toolCalls[key]` by hand on a bare `&coordinator{}`. The twin sends a model response and a
   status for a tool that has no translator. That records the awaited operations and produces no
   result. The call also carries a `status`, which Go's hand-built state does not. The function under
   test does not read `status`.
4. **Zero `llm.Response` literals use `Stop: "complete"`.** The TypeScript `StopReason` has no empty
   value. `modelResponse()` in loop-a-helpers.ts spells Go's `llm.Response{ID, Output}` this way, the
   same as `independentToolCalls` in driver.ts.
5. **`decodeUncheckedItem` returns `SafeJSON.parse` output typed as `Item`.** `SafeJSON.parse` returns
   `any`, so this is an unchecked conversion. It is the only way to produce an input of kind
   "unknown" or an item of kind "unknown" without a cast, and it models an unchecked decode of
   persisted JSON. It is used only by the two runnable subtests of entry 1.
6. **Go's real-time waits are virtual.** `receiveTestValue` advances the virtual clock one slurp
   window at a time, for at most 50 rounds, instead of waiting one real second. This keeps the
   one-second tool grace timer from firing during a wait. `TestCoordinatorRunSteersActiveModelRequest`
   maps `time.After(20 * time.Millisecond)` to `clock.advance(20)`.
7. **`errors.Is(err, context.Canceled)`** maps to `errorsIs(err, canceled)`. Each twin aborts its run
   with its own `AbortedError("context canceled")`, and `errorsIs` follows the `cause` chain.

## Positive control

The twins were run once with four assertions flipped in a scratch copy: an input count, an error
string, a steering request length, and the effect order. All four failed as expected. The scratch
copy was moved to `/tmp/loopa-mut/`.
