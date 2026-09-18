# see/act multistep loop — native and browser

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v1 |
| Status | implement |
| Date | 2026-09-18 |
| Stacked on | PR #409 `feat/jev-gateway-lab` |
| Demand | Martin Foltyn 2026-09-18 |


## User demand

The see/act multistep loop with a controlling goal is wanted, both browser and general computer use.

This is the productized form of assist + browser-goal, one CLI:

```
tools jev loop --goal "..." --surface native|browser|auto
```

## Surfaces

`native`: existing `ControlDriver` / `assistTask` / computer-use session.
`browser`: BrowserDriver from browser-control v1.
`auto`: browser if `--port`/`--url` present, else native if `--app` present, else error.

## Loop (shared)

```
observe -> fan-out observe -> maybe dispatch -> reobserve -> judge
```

Shared `RunLoop` in `src/jev/lib/loop.ts` taking a `SurfaceDriver`:

```
interface SurfaceDriver {
  observe(signal): Promise<SurfaceObservation>
  dispatch(observation, action): Promise<DispatchResult>
  overlay?(action): void
}
```

Native driver wraps `ControlSession`. Browser driver wraps chrome-devtools.

## Computer use

`--surface native` should work through `ComputerUse` when `--api computer-use` is passed, else AX assist. Default AX assist to stay compatible. `--api computer-use` uses `src/control/lib/computer-use/session.ts` so MCP/REPL and CLI share code.

## Budgets

Same OperationBudget defaults as assist: 8 actions, 20 requests, 120s. Browser default max-steps 15 as in the screenshot.

## Stop reasons (closed set)

`verified`, `uncertain`, `blocked`, `budget`, `cancelled`, `no-change`, `error`.

JSON always includes steps[] with candidate counts, timings, jev request count.

## Tests

Fake native driver: two observes, one press, verified.
Fake browser driver: fill then click then stop.
auto without app/url → error.
computer-use api path constructs without calling Sky.

## Non-goals

Parallel loops against 50 windows (Max Blade). A later stress harness may, v1 will not.


## Safety invariants (shared with PR #409)

1. Jev never generates free text that is typed into a UI, a shell, or a CDP evaluate.
2. `ok: true` means dispatch was admitted. It does not mean the user's goal happened.
3. Exact readback is authoritative over semantic judgment.
4. Semantic thresholds are not lowered to force a success.
5. Stale snapshots, changed PIDs, replaced windows, and changed CDP documents refuse before dispatch.
6. Control-path AI is Jev only. Escalation is a host packet, never another model.
7. Overlay feedback is not proof and never moves the hardware pointer.
8. Secrets never enter Jev state.
9. Budgets are monotonic: time, requests, actions.
10. Tests use fixture account names, never live accounts.


## Document control

- Sibling file is the other of `.v1.md` / `.v2.md`.
- Implementation fails closed when this document and the code disagree.
- Update `src/jev/README.md` in the same commit as the CLI.
- Personal data probe runs before every push.

## Traceability appendix

| ID | Requirement | Test |
|---|---|---|
| T001 | see/act multistep loop — native and browser v1 contract row 1: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T002 | see/act multistep loop — native and browser v1 contract row 2: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T003 | see/act multistep loop — native and browser v1 contract row 3: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T004 | see/act multistep loop — native and browser v1 contract row 4: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T005 | see/act multistep loop — native and browser v1 contract row 5: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T006 | see/act multistep loop — native and browser v1 contract row 6: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T007 | see/act multistep loop — native and browser v1 contract row 7: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T008 | see/act multistep loop — native and browser v1 contract row 8: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T009 | see/act multistep loop — native and browser v1 contract row 9: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T010 | see/act multistep loop — native and browser v1 contract row 10: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T011 | see/act multistep loop — native and browser v1 contract row 11: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T012 | see/act multistep loop — native and browser v1 contract row 12: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T013 | see/act multistep loop — native and browser v1 contract row 13: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T014 | see/act multistep loop — native and browser v1 contract row 14: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T015 | see/act multistep loop — native and browser v1 contract row 15: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T016 | see/act multistep loop — native and browser v1 contract row 16: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T017 | see/act multistep loop — native and browser v1 contract row 17: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T018 | see/act multistep loop — native and browser v1 contract row 18: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T019 | see/act multistep loop — native and browser v1 contract row 19: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T020 | see/act multistep loop — native and browser v1 contract row 20: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T021 | see/act multistep loop — native and browser v1 contract row 21: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T022 | see/act multistep loop — native and browser v1 contract row 22: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T023 | see/act multistep loop — native and browser v1 contract row 23: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T024 | see/act multistep loop — native and browser v1 contract row 24: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T025 | see/act multistep loop — native and browser v1 contract row 25: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T026 | see/act multistep loop — native and browser v1 contract row 26: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T027 | see/act multistep loop — native and browser v1 contract row 27: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T028 | see/act multistep loop — native and browser v1 contract row 28: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T029 | see/act multistep loop — native and browser v1 contract row 29: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T030 | see/act multistep loop — native and browser v1 contract row 30: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T031 | see/act multistep loop — native and browser v1 contract row 31: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T032 | see/act multistep loop — native and browser v1 contract row 32: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T033 | see/act multistep loop — native and browser v1 contract row 33: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T034 | see/act multistep loop — native and browser v1 contract row 34: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T035 | see/act multistep loop — native and browser v1 contract row 35: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T036 | see/act multistep loop — native and browser v1 contract row 36: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T037 | see/act multistep loop — native and browser v1 contract row 37: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T038 | see/act multistep loop — native and browser v1 contract row 38: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T039 | see/act multistep loop — native and browser v1 contract row 39: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T040 | see/act multistep loop — native and browser v1 contract row 40: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T041 | see/act multistep loop — native and browser v1 contract row 41: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T042 | see/act multistep loop — native and browser v1 contract row 42: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T043 | see/act multistep loop — native and browser v1 contract row 43: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T044 | see/act multistep loop — native and browser v1 contract row 44: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T045 | see/act multistep loop — native and browser v1 contract row 45: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T046 | see/act multistep loop — native and browser v1 contract row 46: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T047 | see/act multistep loop — native and browser v1 contract row 47: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T048 | see/act multistep loop — native and browser v1 contract row 48: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T049 | see/act multistep loop — native and browser v1 contract row 49: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T050 | see/act multistep loop — native and browser v1 contract row 50: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T051 | see/act multistep loop — native and browser v1 contract row 51: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T052 | see/act multistep loop — native and browser v1 contract row 52: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T053 | see/act multistep loop — native and browser v1 contract row 53: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T054 | see/act multistep loop — native and browser v1 contract row 54: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T055 | see/act multistep loop — native and browser v1 contract row 55: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T056 | see/act multistep loop — native and browser v1 contract row 56: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T057 | see/act multistep loop — native and browser v1 contract row 57: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T058 | see/act multistep loop — native and browser v1 contract row 58: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T059 | see/act multistep loop — native and browser v1 contract row 59: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T060 | see/act multistep loop — native and browser v1 contract row 60: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T061 | see/act multistep loop — native and browser v1 contract row 61: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T062 | see/act multistep loop — native and browser v1 contract row 62: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T063 | see/act multistep loop — native and browser v1 contract row 63: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T064 | see/act multistep loop — native and browser v1 contract row 64: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T065 | see/act multistep loop — native and browser v1 contract row 65: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T066 | see/act multistep loop — native and browser v1 contract row 66: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T067 | see/act multistep loop — native and browser v1 contract row 67: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T068 | see/act multistep loop — native and browser v1 contract row 68: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T069 | see/act multistep loop — native and browser v1 contract row 69: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T070 | see/act multistep loop — native and browser v1 contract row 70: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T071 | see/act multistep loop — native and browser v1 contract row 71: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T072 | see/act multistep loop — native and browser v1 contract row 72: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T073 | see/act multistep loop — native and browser v1 contract row 73: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T074 | see/act multistep loop — native and browser v1 contract row 74: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T075 | see/act multistep loop — native and browser v1 contract row 75: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T076 | see/act multistep loop — native and browser v1 contract row 76: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T077 | see/act multistep loop — native and browser v1 contract row 77: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T078 | see/act multistep loop — native and browser v1 contract row 78: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T079 | see/act multistep loop — native and browser v1 contract row 79: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T080 | see/act multistep loop — native and browser v1 contract row 80: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T081 | see/act multistep loop — native and browser v1 contract row 81: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T082 | see/act multistep loop — native and browser v1 contract row 82: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T083 | see/act multistep loop — native and browser v1 contract row 83: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T084 | see/act multistep loop — native and browser v1 contract row 84: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T085 | see/act multistep loop — native and browser v1 contract row 85: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T086 | see/act multistep loop — native and browser v1 contract row 86: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T087 | see/act multistep loop — native and browser v1 contract row 87: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T088 | see/act multistep loop — native and browser v1 contract row 88: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T089 | see/act multistep loop — native and browser v1 contract row 89: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T090 | see/act multistep loop — native and browser v1 contract row 90: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T091 | see/act multistep loop — native and browser v1 contract row 91: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T092 | see/act multistep loop — native and browser v1 contract row 92: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T093 | see/act multistep loop — native and browser v1 contract row 93: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T094 | see/act multistep loop — native and browser v1 contract row 94: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T095 | see/act multistep loop — native and browser v1 contract row 95: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T096 | see/act multistep loop — native and browser v1 contract row 96: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T097 | see/act multistep loop — native and browser v1 contract row 97: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T098 | see/act multistep loop — native and browser v1 contract row 98: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T099 | see/act multistep loop — native and browser v1 contract row 99: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T100 | see/act multistep loop — native and browser v1 contract row 100: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T101 | see/act multistep loop — native and browser v1 contract row 101: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T102 | see/act multistep loop — native and browser v1 contract row 102: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T103 | see/act multistep loop — native and browser v1 contract row 103: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T104 | see/act multistep loop — native and browser v1 contract row 104: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T105 | see/act multistep loop — native and browser v1 contract row 105: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T106 | see/act multistep loop — native and browser v1 contract row 106: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T107 | see/act multistep loop — native and browser v1 contract row 107: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T108 | see/act multistep loop — native and browser v1 contract row 108: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T109 | see/act multistep loop — native and browser v1 contract row 109: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T110 | see/act multistep loop — native and browser v1 contract row 110: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T111 | see/act multistep loop — native and browser v1 contract row 111: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T112 | see/act multistep loop — native and browser v1 contract row 112: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T113 | see/act multistep loop — native and browser v1 contract row 113: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T114 | see/act multistep loop — native and browser v1 contract row 114: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T115 | see/act multistep loop — native and browser v1 contract row 115: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T116 | see/act multistep loop — native and browser v1 contract row 116: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T117 | see/act multistep loop — native and browser v1 contract row 117: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T118 | see/act multistep loop — native and browser v1 contract row 118: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T119 | see/act multistep loop — native and browser v1 contract row 119: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T120 | see/act multistep loop — native and browser v1 contract row 120: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T121 | see/act multistep loop — native and browser v1 contract row 121: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T122 | see/act multistep loop — native and browser v1 contract row 122: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T123 | see/act multistep loop — native and browser v1 contract row 123: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T124 | see/act multistep loop — native and browser v1 contract row 124: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T125 | see/act multistep loop — native and browser v1 contract row 125: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T126 | see/act multistep loop — native and browser v1 contract row 126: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T127 | see/act multistep loop — native and browser v1 contract row 127: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T128 | see/act multistep loop — native and browser v1 contract row 128: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T129 | see/act multistep loop — native and browser v1 contract row 129: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T130 | see/act multistep loop — native and browser v1 contract row 130: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T131 | see/act multistep loop — native and browser v1 contract row 131: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T132 | see/act multistep loop — native and browser v1 contract row 132: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T133 | see/act multistep loop — native and browser v1 contract row 133: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T134 | see/act multistep loop — native and browser v1 contract row 134: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T135 | see/act multistep loop — native and browser v1 contract row 135: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T136 | see/act multistep loop — native and browser v1 contract row 136: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T137 | see/act multistep loop — native and browser v1 contract row 137: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T138 | see/act multistep loop — native and browser v1 contract row 138: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T139 | see/act multistep loop — native and browser v1 contract row 139: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T140 | see/act multistep loop — native and browser v1 contract row 140: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T141 | see/act multistep loop — native and browser v1 contract row 141: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T142 | see/act multistep loop — native and browser v1 contract row 142: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T143 | see/act multistep loop — native and browser v1 contract row 143: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T144 | see/act multistep loop — native and browser v1 contract row 144: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T145 | see/act multistep loop — native and browser v1 contract row 145: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T146 | see/act multistep loop — native and browser v1 contract row 146: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T147 | see/act multistep loop — native and browser v1 contract row 147: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T148 | see/act multistep loop — native and browser v1 contract row 148: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T149 | see/act multistep loop — native and browser v1 contract row 149: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T150 | see/act multistep loop — native and browser v1 contract row 150: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T151 | see/act multistep loop — native and browser v1 contract row 151: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T152 | see/act multistep loop — native and browser v1 contract row 152: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T153 | see/act multistep loop — native and browser v1 contract row 153: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T154 | see/act multistep loop — native and browser v1 contract row 154: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T155 | see/act multistep loop — native and browser v1 contract row 155: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T156 | see/act multistep loop — native and browser v1 contract row 156: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T157 | see/act multistep loop — native and browser v1 contract row 157: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T158 | see/act multistep loop — native and browser v1 contract row 158: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T159 | see/act multistep loop — native and browser v1 contract row 159: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T160 | see/act multistep loop — native and browser v1 contract row 160: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T161 | see/act multistep loop — native and browser v1 contract row 161: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T162 | see/act multistep loop — native and browser v1 contract row 162: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T163 | see/act multistep loop — native and browser v1 contract row 163: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T164 | see/act multistep loop — native and browser v1 contract row 164: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T165 | see/act multistep loop — native and browser v1 contract row 165: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T166 | see/act multistep loop — native and browser v1 contract row 166: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T167 | see/act multistep loop — native and browser v1 contract row 167: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T168 | see/act multistep loop — native and browser v1 contract row 168: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T169 | see/act multistep loop — native and browser v1 contract row 169: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T170 | see/act multistep loop — native and browser v1 contract row 170: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T171 | see/act multistep loop — native and browser v1 contract row 171: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T172 | see/act multistep loop — native and browser v1 contract row 172: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T173 | see/act multistep loop — native and browser v1 contract row 173: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T174 | see/act multistep loop — native and browser v1 contract row 174: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T175 | see/act multistep loop — native and browser v1 contract row 175: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T176 | see/act multistep loop — native and browser v1 contract row 176: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T177 | see/act multistep loop — native and browser v1 contract row 177: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T178 | see/act multistep loop — native and browser v1 contract row 178: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T179 | see/act multistep loop — native and browser v1 contract row 179: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T180 | see/act multistep loop — native and browser v1 contract row 180: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T181 | see/act multistep loop — native and browser v1 contract row 181: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T182 | see/act multistep loop — native and browser v1 contract row 182: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T183 | see/act multistep loop — native and browser v1 contract row 183: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T184 | see/act multistep loop — native and browser v1 contract row 184: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T185 | see/act multistep loop — native and browser v1 contract row 185: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T186 | see/act multistep loop — native and browser v1 contract row 186: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T187 | see/act multistep loop — native and browser v1 contract row 187: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T188 | see/act multistep loop — native and browser v1 contract row 188: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T189 | see/act multistep loop — native and browser v1 contract row 189: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T190 | see/act multistep loop — native and browser v1 contract row 190: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T191 | see/act multistep loop — native and browser v1 contract row 191: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T192 | see/act multistep loop — native and browser v1 contract row 192: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T193 | see/act multistep loop — native and browser v1 contract row 193: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T194 | see/act multistep loop — native and browser v1 contract row 194: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T195 | see/act multistep loop — native and browser v1 contract row 195: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T196 | see/act multistep loop — native and browser v1 contract row 196: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T197 | see/act multistep loop — native and browser v1 contract row 197: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T198 | see/act multistep loop — native and browser v1 contract row 198: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T199 | see/act multistep loop — native and browser v1 contract row 199: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T200 | see/act multistep loop — native and browser v1 contract row 200: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T201 | see/act multistep loop — native and browser v1 contract row 201: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T202 | see/act multistep loop — native and browser v1 contract row 202: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T203 | see/act multistep loop — native and browser v1 contract row 203: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T204 | see/act multistep loop — native and browser v1 contract row 204: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T205 | see/act multistep loop — native and browser v1 contract row 205: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T206 | see/act multistep loop — native and browser v1 contract row 206: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T207 | see/act multistep loop — native and browser v1 contract row 207: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T208 | see/act multistep loop — native and browser v1 contract row 208: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T209 | see/act multistep loop — native and browser v1 contract row 209: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T210 | see/act multistep loop — native and browser v1 contract row 210: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T211 | see/act multistep loop — native and browser v1 contract row 211: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T212 | see/act multistep loop — native and browser v1 contract row 212: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T213 | see/act multistep loop — native and browser v1 contract row 213: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T214 | see/act multistep loop — native and browser v1 contract row 214: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T215 | see/act multistep loop — native and browser v1 contract row 215: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T216 | see/act multistep loop — native and browser v1 contract row 216: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T217 | see/act multistep loop — native and browser v1 contract row 217: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T218 | see/act multistep loop — native and browser v1 contract row 218: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T219 | see/act multistep loop — native and browser v1 contract row 219: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T220 | see/act multistep loop — native and browser v1 contract row 220: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T221 | see/act multistep loop — native and browser v1 contract row 221: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T222 | see/act multistep loop — native and browser v1 contract row 222: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T223 | see/act multistep loop — native and browser v1 contract row 223: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T224 | see/act multistep loop — native and browser v1 contract row 224: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T225 | see/act multistep loop — native and browser v1 contract row 225: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T226 | see/act multistep loop — native and browser v1 contract row 226: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T227 | see/act multistep loop — native and browser v1 contract row 227: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T228 | see/act multistep loop — native and browser v1 contract row 228: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T229 | see/act multistep loop — native and browser v1 contract row 229: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T230 | see/act multistep loop — native and browser v1 contract row 230: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T231 | see/act multistep loop — native and browser v1 contract row 231: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T232 | see/act multistep loop — native and browser v1 contract row 232: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T233 | see/act multistep loop — native and browser v1 contract row 233: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |

Appendix rows restate the contract. They are not extra product scope.
