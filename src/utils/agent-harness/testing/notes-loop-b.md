# loop_test.go (2/2) port notes

Slice: `TestCoordinatorRunDropsSuccessfulResponseFromSupersededTurn` through
`TestClosedInputErrorPrefersContextCancellation` (22 tests), in `coordinator.loop-b.test.ts`.

No PORT-DEFECT and no PORT-NA skips: all 22 twins run and pass.

## Mapping decisions (not defects)

1. **Private methods reached through `loop-b-helpers.ts`.** Four Go white-box calls are not on
   `CoordinatorInternals`: `addOperationToLocalState` (4 tests), `addToolCallsToLocalState`
   (1), `storeItemInSessionStore` (2), and the package function `closedInputError` (1), which
   is a private method in the port. The helper looks the method up with `Reflect.get` and
   throws if it has been renamed. Suggested port change: add these four to
   `CoordinatorInternals`, then switch the helpers to the internals and delete the lookup.
   <!-- updated 2026-09-23 23:51: done; the four methods are typed on `CoordinatorInternals`, the helpers forward to `coordinatorInternals(current)`, and the `Reflect` lookup is deleted -->
2. **`TestCoordinatorClonesOperationDataBeforeDispatch` uses a field reassignment instead of a
   byte write.** Go overwrites byte 0 of the `State` and `Idempotency` slices it receives
   (`value.State[0] = '!'`). TypeScript strings are immutable, so `MutatingOperationManager`
   reassigns both fields on the object it receives. That is the same aliasing risk in
   TypeScript. The assertion is unchanged: the stored operation keeps its original `State`
   and `Idempotency`. The port passes because `dispatchOperationToManager` hands
   `{ ...operation }` to the manager.
3. **`context.Canceled` becomes an `AbortedError("canceled")` abort reason.** `errors.Is(err,
   context.Canceled)` becomes a check that the reason is the error or is on its `cause` chain
   (`errorChainIncludes`). This follows the stop twin's
   `TestCoordinatorCancellationTakesPrecedenceOverModelError`.
4. **An inbox built on a canceled context** (`inbox.New(canceledCtx)`) becomes
   `direct.inboxController.abort()` before `run()`.
5. **`operation.ErrUnsupported` wrapped with `%w`** becomes an `Error` whose `cause` is an
   `UnsupportedOperationError`. `errors.Is` becomes an `instanceof` check along the cause chain.
