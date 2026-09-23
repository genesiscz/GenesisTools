# Upstream: Unreal Agent

This directory is a TypeScript port of two packages of
[unreallabsai/unreal-agent](https://github.com/unreallabsai/unreal-agent): `harness/contextbuilder`
and `harness/coordinator`, plus the value types they depend on (`harness/llm`, `harness/inbox`,
`harness/operation` values only, `harness/tool` contracts, `harness/session`,
`harness/sessionstore` contracts). The operation runtime (`primitives`, the local operation
manager), the Responses API client and the file session store are NOT ported: the host supplies
those.

- Pinned commit: `df8b0ba560da17fd705d941cbeb75eff86c74a1e` (2026-09-23).
- Local clone with history: `/Users/Martin/Tresors/Projects/_Playgrounds/unreal-agent`.
- JSON field names keep the Go spelling so session items and fixtures are shared byte for byte.
- Parity: every Go test in `harness/coordinator/*_test.go` and `harness/contextbuilder/*_test.go`
  has a TypeScript twin of the same name in `*.test.ts` here; the Go driver helpers
  (`stopTestRun`, `fakeStore`, `fakeOperationManager`, `fakeAdapter`) map onto `testing/driver.ts`.
- Reconcile: `bun scripts/agent-harness-reconcile.ts` (in this repo; `--clone`, `--pinned`,
  `--target <ref>`, `--json`) lists Go tests with no twin, twins with no Go test, skipped twins
  with their `PORT-*` reason, and the drift from the pinned commit to the target ref (diff stat
  plus the Go tests each test file adds or removes). It exits 1 on a missing or orphan twin.
