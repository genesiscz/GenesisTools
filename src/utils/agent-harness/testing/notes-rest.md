# Port notes: settings, delivery, recovery, fork, unavailable tool, stop integration, fault twins

Go sources: `harness/coordinator/{settings,delivery,recovery,recovery_sequences,fork,unavailable_tool,stop_integration,fault_fakes,fault_fuzz}_test.go`
at the pinned commit (UPSTREAM.md). Helpers: `testing/rest-helpers.ts`, `testing/fault-helpers.ts`.

## Port defects

<!-- updated 2026-09-23 23:20: defect 1 fixed in eb3815a56 (AggregateError with a cause chain, the fuzz cancel-site cases run); driver items 2 and 3 fixed in the same series (newRegistry honors enabled, StopTestRun.start keeps a restored state) -->

1. **FIXED (eb3815a56). `cancelOperations` lost the dependency error.** Go `loop.go:340` builds the
   error with `errors.Join(result, fmt.Errorf("cancel operation %q: %w", id, err))`, so
   `errors.Is(err, dependencyErr)` holds. `coordinator.ts:597-602` pushes
   `cancel operation "<id>": <message>` strings and throws `new Error(failures.join("\n"))`
   with no `cause`. The fault sweep's cancel-site cases (mode 8, five cases) fail only this
   check; with that one check relaxed every other invariant passes. Skipped as
   `FuzzCoordinatorFaults (cancel site)` in `coordinator.fault.test.ts`. A fix that keeps
   the message: `throw new AggregateError(errors, messages.join("\n"))` plus `cause: errors[0]`,
   or a cause chain; `errorIs` in rest-helpers walks `cause` only.

## Driver defects (not coordinator)

2. **`newRegistry(configured, ...enabled)` ignores `enabled`.** Go `tool.NewRegistry` resolves a
   static tool only when its name is in `enabled` (`tool/registry.go:72-78`). The driver maps every
   configured translator. `TestCoordinatorRejectsRestoreWhenRecordedCallRequiresUnavailableTool`
   passes Bash as configured but not enabled; its twin builds an empty `MapRegistry` directly.
   Every other call site in this slice passes the matching enabled names, so none is affected.
3. **`StopTestRun.start()` overwrites `deps.restored`** with `store.resume`. Go tests assign
   `dependencies.Restored` (via `restoreTestRun` or directly) before `start`. `startRun` in
   rest-helpers starts the coordinator without that reset, and `cancelRun` cancels it.
   <!-- updated 2026-09-23 23:51: fixed in the driver; `start()` now keeps a `deps.restored` the test replaced, so `startRun` and `cancelRun` are deleted and every twin calls `run.start(signal)` and `run.cancel()` -->

## Internals gaps (assertion kept as far as the surface allows)

4. **`callModel` and grace identity are not observable.**
   - `TestCoordinatorCompactionPreservesPendingInputsOnReplay` sets `state.callModel = true`
     and asserts it survives the compaction response; the twin cannot set or read it. Its
     whole-state `reflect.DeepEqual(replayed.state, want)` is compared through
     `stateSnapshot()` (every `loopState` field except `callModel`; `availableInputs` is
     `pendingInputs() + deliveredInputs`, exact by definition).
   - `TestCoordinatorSettingsPreserveToolGraceAndApplyToContinuation` compares
     `state.grace` by channel identity; the twin checks that grace stays armed with one call.
     A re-armed timer would pass the twin but fail Go.
   - RESOLVED 2026-09-23 23:20: `CoordinatorInternals` gained `callModel` (get/set),
     `graceGeneration` and `storeItemInSessionStore`; both twins assert the Go check again.
   - Original suggestion: `callModel` get/set, a grace generation counter, and
     `storeItemInSessionStore(item)` (the compaction twin calls the store's append methods
     through `storeItemInSessionStore()` in rest-helpers instead).

## Not applicable

<!-- updated 2026-09-24 00:10: RESOLVED. Both twins run against `testing/local-operation-manager.ts`, a test-local stand-in for Go's `operation.NewLocalOperationManager` that honours the manager contract for the `shell` (real `sh -c` process in its own group, `ProcessGroupID` in the state update, killed on cancel) and `value` (completes at once) operations; the store observer is `LocalStore.addObserver`. The primitive runtime stays unported; the twins verify the coordinator. No PORT-NA skip remains in the corpus. -->

5. **RESOLVED (was PORT-NA): `stop_integration_test.go`, both tests.** They run the real
   `operation.NewLocalOperationManager`: `TestCoordinatorStopCancelsShellProcess` spawns
   `/bin/sh` and probes its process group with `kill(-pgid, 0)`;
   `TestCoordinatorStopAfterToolCommitSettlesOperation` needs the manager to execute a value
   operation and a store observer to queue the stop. The operation runtime is not ported.
   The second one could run with a value-operation fake manager plus `LocalStore.addObserver`.
   That would test the fake manager as much as the coordinator, so it stays skipped.

## Substitutions (no assertion changed)

6. **`localfile.Store` becomes `LocalStore` (rest-helpers).** An in-memory twin of the localfile
   rules the tests depend on: the turn chain (`PreviousTurnID` must equal the latest turn),
   owned and responded turns, first-append operation initialization and validation, repeat
   statuses appended without re-initialization, `Resume` (non-terminal operations plus terminal
   states missing from tool-call history), `Fork` (`forkStoredState`: inherit up to the boundary,
   strip inherited status operations, append the fork item, reset owned state), and observers.
   `MemoryStore` returns every operation on resume, so it cannot stand in. "Reopening" a
   directory reuses the instance; reads return deep copies. `persistTestRun` and
   `restoreTestRun` are ported onto it.
7. **Fork mapping.** The port's `Store` has no `fork()`. `LocalStore.fork(child, parent, turn)`
   produces the child history Go's `Store.Fork` writes; the coordinator then replays the
   `{Kind: "fork", Data: {ParentID, PreviousTurnID}}` item like any other.
8. **Ids of resumed runs.** Go turn and operation ids are UUIDs. The driver's counter restarts
   at `id-1` for every run, and `LocalStore` rejects a second turn `id-1` exactly as localfile
   would. Resumed runs over a shared store call `prefixIDs(run, "resumed")`.
9. **`recordedInputs`** (Go `heartbeatTestRun`) is every input the store appended:
   `FakeStore.appendedInputs`.
10. **`NewLocalOperationManager` in `TestCoordinatorStopRejectsUnsupportedOperation`** only
    has to reject the fixture's `shell` operation with `ErrUnsupported`
    (`advanceLocalOperation`, local_manager.go). `newLocalManagerStandIn()` does that with
    `UnsupportedOperationError`, and `errors.Is` becomes an `instanceof` walk of the cause chain.
11. **Go zero-value `llm.Response{Output: ...}`** becomes `{ID: "", Stop: "complete", Usage: usage(), Output}`,
    as in the driver's `textResponse`. The coordinator never reads `Stop`.

## Fault sweep mapping

12. `FuzzCoordinatorFaults` becomes a deterministic sweep. It runs the 29 Go seeds (`f.Add` for
    every mode plus the empty seed), then every occurrence index of every fault site for the
    actions `[0, 17, 35]` (34 cases). That is 63 cases: 58 run, and the 5 cancel-site cases are
    skipped (#1).
    - The Responses API adapter and its `http.RoundTripper` are not ported. `FaultAdapter` fails
      at the same `transport`, `http` and `body` sites and returns the two responses the
      transport encodes. The Go request-body decode of `function_call_output` items becomes a
      scan of the `tool_result` items in `llm.Request`.
    - The skill-use translator and `DecodeSkillUse` are not ported. `SkillUseTranslator` and
      `encodeSkillUse`/`decodeSkillUse` reproduce `tool/skill_use.go`, with `Content` as base64
      like Go's `[]byte`.
    - `Usage.InputTokens` is a JS number, so `2^53+1` and `MaxInt64` lose precision there. The
      exact digits survive in `Usage.Raw`, and the assertion compares the same conversion.
    - The store's `ctx.Err()` checks have no counterpart, because the port's `Store` takes no signal.
    - Proven to catch: the sweep found #1, and `assertCoordinatorFaultTrace` rejects three
      planted violations (a request before its turn, a settled run with no responses, a commit
      after a failure).
