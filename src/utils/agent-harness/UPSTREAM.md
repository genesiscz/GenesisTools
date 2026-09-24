# Upstream: Unreal Agent

This directory is a TypeScript port of two packages of
[unreallabsai/unreal-agent](https://github.com/unreallabsai/unreal-agent): `harness/contextbuilder`
and `harness/coordinator`, plus the value types they depend on (`harness/llm`, `harness/inbox`,
`harness/operation` values only, `harness/tool` contracts, `harness/session`,
`harness/sessionstore` contracts). The operation runtime (`primitives`, the local operation
manager), the Responses API client and the file session store are NOT ported: the host supplies
those.

- Pinned commit: `df8b0ba560da17fd705d941cbeb75eff86c74a1e` (2026-09-23).
- Local clone with history: `git clone https://github.com/unreallabsai/unreal-agent` anywhere, then pass
  it as `bun scripts/agent-harness-reconcile.ts --clone <path>`, or set
  `GENESIS_TOOLS_UNREAL_AGENT_CLONE=<path>` once. There is no built-in default path.
- JSON field names keep the Go spelling so session items and fixtures are shared byte for byte.
- Parity: every Go test in `harness/coordinator/*_test.go` and `harness/contextbuilder/*_test.go`
  has a TypeScript twin of the same name in `*.test.ts` here; the Go driver helpers
  (`stopTestRun`, `fakeStore`, `fakeOperationManager`, `fakeAdapter`) map onto `testing/driver.ts`.
- Oracle: `bun run test:oracle` (`HARNESS_ORACLE=go`) runs the same twin files against the
  upstream Go coordinator instead of the port. `oracle/bridge/main.go` (a Go module pinned to the
  commit above) runs `coordinator.New(...)` with every dependency served over stdio by the twin's
  own TypeScript fakes (`oracle/go-coordinator.ts`); uuids are renamed to the driver's `id-N` in
  order of first appearance, raw JSON fields are embedded for Go and re-stringified for the port
  (`oracle/raw-json.ts`, which also drops the keys Go writes for unset optional fields), a fake's
  thrown error travels as a `Ref` so the run error's cause chain still reaches it, and time is
  real (a wall clock in `testing/driver.ts`; `twinTime` scales the minute-long twins and widens
  the nanosecond epsilon to 300 ms). `run.internals()` works against Go too: the bridge reads the
  coordinator's private loop state through reflection whenever the driver settles and once more
  when `Run` returns, so `pendingInputs`, `stopMode`, grace and tool-call state are the Go values.
  Skipped under the oracle (58 of 139 twins, all `skipIf(oracle)` with the reason beside them):
  loop-a (29) and loop-b (22) drive loop steps directly, slurp (5) orders events inside the 1 ms
  idle window, `TestCoordinatorReconciliationRejectsUntranslatedCall` builds the port by hand, and
  `TestCoordinatorCancellationWhileCollectingUpdates` cancels inside that same window. The other
  81 pass against Go (2026-09-24, about 130 s; the heartbeat twins wait real scaled minutes).
  Proven to catch: a twin expecting no model request after a heartbeat fails with
  "Expected 0, Received 1". Needs a Go toolchain; the binary builds on first use into
  `oracle/bridge/bin/` (ignored).
- Reconcile: `bun scripts/agent-harness-reconcile.ts` (in this repo; `--clone`, `--pinned`,
  `--target <ref>`, `--json`) lists Go tests with no twin, twins with no Go test, skipped twins
  with their `PORT-*` reason, and the drift from the pinned commit to the target ref (diff stat
  plus the Go tests each test file adds or removes). It exits 1 on a missing or orphan twin.
