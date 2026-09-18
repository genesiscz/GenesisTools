# tools jev control observe — fan-out on one see

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v1 |
| Status | implement |
| Date | 2026-09-18 |
| Stacked on | PR #409 `feat/jev-gateway-lab` |
| Demand | Martin Foltyn 2026-09-18 |


## User demand

`tools jev control observe` — good. Spec + impl. Make it multistep with reupdates in between. Assist ditto.

Archer's architecture: one shared AX/browser state, many isolated questions, one RTT.

## CLI

```
tools jev control observe --app TextEdit --goal "enable line numbers"
  --window-id ID
  --scope window|chrome
  --updates 3
  --interval 250
  --provider typesafe
```

Also `tools jev observe` as a thin alias that forwards to control observe.

## Fan-out questions (one evaluate call)

| id | type | options / meaning |
|---|---|---|
| target | choice | evidence ids + `none` |
| verb | choice | `press` `set` `scroll` `wait` `stop` |
| done | boolean | goal already true on this observation |
| blocked | boolean | dialog, occluder, wrong window, auth |
| risk | score | low, reversible, irreversible |
| wait | boolean | should wait instead of acting |

`admittedChoice` from existing `decisions.ts` applies to `target` and `verb` independently. Dispatch is NOT done by observe. Observe is read-only. Assist/loop consume the result.

## Multistep reupdates

`--updates N` re-runs `see` N times with `--since` if available, each time a new fan-out. Output is an array of observations+answers. Stops early if `done` admitted true or `blocked` admitted true.

Interval bounded 100–2000 ms. Default 250.

## Assist ditto

`assistTask` should call the fan-out helper instead of a single `resolveIntent` where possible, in the same PR, without changing assist's admission gates. If fan-out `done` is true and exact/semantic judge agrees, break. If `blocked`, stop with the authentication reason. If `verb=wait`, use existing semantic wait (phase 2) or 1s fallback.

If wiring assist is too risky in this stacked PR, export the helper and add a `--fanout` flag defaulting true with tests that the flag path is used. Prefer actually switching assist.

## Tests

Fan-out builds one evaluate input with 6 questions.
none target + press verb → not dispatchable.
updates=2 calls observe twice on a fake driver.
Assist with done true on first fan-out performs zero actions.

## Non-goals

Writing the observation to disk by default. `--snapshot-file` already exists for input.


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
| T001 | tools jev control observe — fan-out on one see v1 contract row 1: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T002 | tools jev control observe — fan-out on one see v1 contract row 2: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T003 | tools jev control observe — fan-out on one see v1 contract row 3: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T004 | tools jev control observe — fan-out on one see v1 contract row 4: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T005 | tools jev control observe — fan-out on one see v1 contract row 5: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T006 | tools jev control observe — fan-out on one see v1 contract row 6: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T007 | tools jev control observe — fan-out on one see v1 contract row 7: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T008 | tools jev control observe — fan-out on one see v1 contract row 8: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T009 | tools jev control observe — fan-out on one see v1 contract row 9: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T010 | tools jev control observe — fan-out on one see v1 contract row 10: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T011 | tools jev control observe — fan-out on one see v1 contract row 11: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T012 | tools jev control observe — fan-out on one see v1 contract row 12: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T013 | tools jev control observe — fan-out on one see v1 contract row 13: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T014 | tools jev control observe — fan-out on one see v1 contract row 14: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T015 | tools jev control observe — fan-out on one see v1 contract row 15: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T016 | tools jev control observe — fan-out on one see v1 contract row 16: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T017 | tools jev control observe — fan-out on one see v1 contract row 17: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T018 | tools jev control observe — fan-out on one see v1 contract row 18: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T019 | tools jev control observe — fan-out on one see v1 contract row 19: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T020 | tools jev control observe — fan-out on one see v1 contract row 20: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T021 | tools jev control observe — fan-out on one see v1 contract row 21: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T022 | tools jev control observe — fan-out on one see v1 contract row 22: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T023 | tools jev control observe — fan-out on one see v1 contract row 23: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T024 | tools jev control observe — fan-out on one see v1 contract row 24: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T025 | tools jev control observe — fan-out on one see v1 contract row 25: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T026 | tools jev control observe — fan-out on one see v1 contract row 26: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T027 | tools jev control observe — fan-out on one see v1 contract row 27: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T028 | tools jev control observe — fan-out on one see v1 contract row 28: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T029 | tools jev control observe — fan-out on one see v1 contract row 29: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T030 | tools jev control observe — fan-out on one see v1 contract row 30: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T031 | tools jev control observe — fan-out on one see v1 contract row 31: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T032 | tools jev control observe — fan-out on one see v1 contract row 32: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T033 | tools jev control observe — fan-out on one see v1 contract row 33: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T034 | tools jev control observe — fan-out on one see v1 contract row 34: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T035 | tools jev control observe — fan-out on one see v1 contract row 35: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T036 | tools jev control observe — fan-out on one see v1 contract row 36: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T037 | tools jev control observe — fan-out on one see v1 contract row 37: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T038 | tools jev control observe — fan-out on one see v1 contract row 38: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T039 | tools jev control observe — fan-out on one see v1 contract row 39: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T040 | tools jev control observe — fan-out on one see v1 contract row 40: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T041 | tools jev control observe — fan-out on one see v1 contract row 41: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T042 | tools jev control observe — fan-out on one see v1 contract row 42: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T043 | tools jev control observe — fan-out on one see v1 contract row 43: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T044 | tools jev control observe — fan-out on one see v1 contract row 44: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T045 | tools jev control observe — fan-out on one see v1 contract row 45: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T046 | tools jev control observe — fan-out on one see v1 contract row 46: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T047 | tools jev control observe — fan-out on one see v1 contract row 47: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T048 | tools jev control observe — fan-out on one see v1 contract row 48: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T049 | tools jev control observe — fan-out on one see v1 contract row 49: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T050 | tools jev control observe — fan-out on one see v1 contract row 50: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T051 | tools jev control observe — fan-out on one see v1 contract row 51: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T052 | tools jev control observe — fan-out on one see v1 contract row 52: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T053 | tools jev control observe — fan-out on one see v1 contract row 53: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T054 | tools jev control observe — fan-out on one see v1 contract row 54: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T055 | tools jev control observe — fan-out on one see v1 contract row 55: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T056 | tools jev control observe — fan-out on one see v1 contract row 56: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T057 | tools jev control observe — fan-out on one see v1 contract row 57: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T058 | tools jev control observe — fan-out on one see v1 contract row 58: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T059 | tools jev control observe — fan-out on one see v1 contract row 59: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T060 | tools jev control observe — fan-out on one see v1 contract row 60: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T061 | tools jev control observe — fan-out on one see v1 contract row 61: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T062 | tools jev control observe — fan-out on one see v1 contract row 62: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T063 | tools jev control observe — fan-out on one see v1 contract row 63: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T064 | tools jev control observe — fan-out on one see v1 contract row 64: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T065 | tools jev control observe — fan-out on one see v1 contract row 65: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T066 | tools jev control observe — fan-out on one see v1 contract row 66: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T067 | tools jev control observe — fan-out on one see v1 contract row 67: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T068 | tools jev control observe — fan-out on one see v1 contract row 68: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T069 | tools jev control observe — fan-out on one see v1 contract row 69: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T070 | tools jev control observe — fan-out on one see v1 contract row 70: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T071 | tools jev control observe — fan-out on one see v1 contract row 71: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T072 | tools jev control observe — fan-out on one see v1 contract row 72: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T073 | tools jev control observe — fan-out on one see v1 contract row 73: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T074 | tools jev control observe — fan-out on one see v1 contract row 74: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T075 | tools jev control observe — fan-out on one see v1 contract row 75: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T076 | tools jev control observe — fan-out on one see v1 contract row 76: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T077 | tools jev control observe — fan-out on one see v1 contract row 77: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T078 | tools jev control observe — fan-out on one see v1 contract row 78: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T079 | tools jev control observe — fan-out on one see v1 contract row 79: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T080 | tools jev control observe — fan-out on one see v1 contract row 80: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T081 | tools jev control observe — fan-out on one see v1 contract row 81: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T082 | tools jev control observe — fan-out on one see v1 contract row 82: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T083 | tools jev control observe — fan-out on one see v1 contract row 83: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T084 | tools jev control observe — fan-out on one see v1 contract row 84: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T085 | tools jev control observe — fan-out on one see v1 contract row 85: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T086 | tools jev control observe — fan-out on one see v1 contract row 86: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T087 | tools jev control observe — fan-out on one see v1 contract row 87: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T088 | tools jev control observe — fan-out on one see v1 contract row 88: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T089 | tools jev control observe — fan-out on one see v1 contract row 89: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T090 | tools jev control observe — fan-out on one see v1 contract row 90: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T091 | tools jev control observe — fan-out on one see v1 contract row 91: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T092 | tools jev control observe — fan-out on one see v1 contract row 92: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T093 | tools jev control observe — fan-out on one see v1 contract row 93: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T094 | tools jev control observe — fan-out on one see v1 contract row 94: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T095 | tools jev control observe — fan-out on one see v1 contract row 95: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T096 | tools jev control observe — fan-out on one see v1 contract row 96: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T097 | tools jev control observe — fan-out on one see v1 contract row 97: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T098 | tools jev control observe — fan-out on one see v1 contract row 98: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T099 | tools jev control observe — fan-out on one see v1 contract row 99: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T100 | tools jev control observe — fan-out on one see v1 contract row 100: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T101 | tools jev control observe — fan-out on one see v1 contract row 101: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T102 | tools jev control observe — fan-out on one see v1 contract row 102: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T103 | tools jev control observe — fan-out on one see v1 contract row 103: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T104 | tools jev control observe — fan-out on one see v1 contract row 104: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T105 | tools jev control observe — fan-out on one see v1 contract row 105: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T106 | tools jev control observe — fan-out on one see v1 contract row 106: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T107 | tools jev control observe — fan-out on one see v1 contract row 107: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T108 | tools jev control observe — fan-out on one see v1 contract row 108: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T109 | tools jev control observe — fan-out on one see v1 contract row 109: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T110 | tools jev control observe — fan-out on one see v1 contract row 110: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T111 | tools jev control observe — fan-out on one see v1 contract row 111: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T112 | tools jev control observe — fan-out on one see v1 contract row 112: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T113 | tools jev control observe — fan-out on one see v1 contract row 113: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T114 | tools jev control observe — fan-out on one see v1 contract row 114: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T115 | tools jev control observe — fan-out on one see v1 contract row 115: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T116 | tools jev control observe — fan-out on one see v1 contract row 116: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T117 | tools jev control observe — fan-out on one see v1 contract row 117: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T118 | tools jev control observe — fan-out on one see v1 contract row 118: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T119 | tools jev control observe — fan-out on one see v1 contract row 119: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T120 | tools jev control observe — fan-out on one see v1 contract row 120: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T121 | tools jev control observe — fan-out on one see v1 contract row 121: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T122 | tools jev control observe — fan-out on one see v1 contract row 122: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T123 | tools jev control observe — fan-out on one see v1 contract row 123: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T124 | tools jev control observe — fan-out on one see v1 contract row 124: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T125 | tools jev control observe — fan-out on one see v1 contract row 125: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T126 | tools jev control observe — fan-out on one see v1 contract row 126: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T127 | tools jev control observe — fan-out on one see v1 contract row 127: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T128 | tools jev control observe — fan-out on one see v1 contract row 128: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T129 | tools jev control observe — fan-out on one see v1 contract row 129: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T130 | tools jev control observe — fan-out on one see v1 contract row 130: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T131 | tools jev control observe — fan-out on one see v1 contract row 131: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T132 | tools jev control observe — fan-out on one see v1 contract row 132: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T133 | tools jev control observe — fan-out on one see v1 contract row 133: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T134 | tools jev control observe — fan-out on one see v1 contract row 134: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T135 | tools jev control observe — fan-out on one see v1 contract row 135: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T136 | tools jev control observe — fan-out on one see v1 contract row 136: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T137 | tools jev control observe — fan-out on one see v1 contract row 137: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T138 | tools jev control observe — fan-out on one see v1 contract row 138: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T139 | tools jev control observe — fan-out on one see v1 contract row 139: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T140 | tools jev control observe — fan-out on one see v1 contract row 140: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T141 | tools jev control observe — fan-out on one see v1 contract row 141: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T142 | tools jev control observe — fan-out on one see v1 contract row 142: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T143 | tools jev control observe — fan-out on one see v1 contract row 143: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T144 | tools jev control observe — fan-out on one see v1 contract row 144: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T145 | tools jev control observe — fan-out on one see v1 contract row 145: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T146 | tools jev control observe — fan-out on one see v1 contract row 146: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T147 | tools jev control observe — fan-out on one see v1 contract row 147: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T148 | tools jev control observe — fan-out on one see v1 contract row 148: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T149 | tools jev control observe — fan-out on one see v1 contract row 149: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T150 | tools jev control observe — fan-out on one see v1 contract row 150: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T151 | tools jev control observe — fan-out on one see v1 contract row 151: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T152 | tools jev control observe — fan-out on one see v1 contract row 152: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T153 | tools jev control observe — fan-out on one see v1 contract row 153: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T154 | tools jev control observe — fan-out on one see v1 contract row 154: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T155 | tools jev control observe — fan-out on one see v1 contract row 155: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T156 | tools jev control observe — fan-out on one see v1 contract row 156: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T157 | tools jev control observe — fan-out on one see v1 contract row 157: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T158 | tools jev control observe — fan-out on one see v1 contract row 158: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T159 | tools jev control observe — fan-out on one see v1 contract row 159: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T160 | tools jev control observe — fan-out on one see v1 contract row 160: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T161 | tools jev control observe — fan-out on one see v1 contract row 161: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T162 | tools jev control observe — fan-out on one see v1 contract row 162: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T163 | tools jev control observe — fan-out on one see v1 contract row 163: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T164 | tools jev control observe — fan-out on one see v1 contract row 164: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T165 | tools jev control observe — fan-out on one see v1 contract row 165: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T166 | tools jev control observe — fan-out on one see v1 contract row 166: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T167 | tools jev control observe — fan-out on one see v1 contract row 167: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T168 | tools jev control observe — fan-out on one see v1 contract row 168: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T169 | tools jev control observe — fan-out on one see v1 contract row 169: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T170 | tools jev control observe — fan-out on one see v1 contract row 170: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T171 | tools jev control observe — fan-out on one see v1 contract row 171: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T172 | tools jev control observe — fan-out on one see v1 contract row 172: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T173 | tools jev control observe — fan-out on one see v1 contract row 173: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T174 | tools jev control observe — fan-out on one see v1 contract row 174: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T175 | tools jev control observe — fan-out on one see v1 contract row 175: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T176 | tools jev control observe — fan-out on one see v1 contract row 176: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T177 | tools jev control observe — fan-out on one see v1 contract row 177: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T178 | tools jev control observe — fan-out on one see v1 contract row 178: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T179 | tools jev control observe — fan-out on one see v1 contract row 179: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T180 | tools jev control observe — fan-out on one see v1 contract row 180: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T181 | tools jev control observe — fan-out on one see v1 contract row 181: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T182 | tools jev control observe — fan-out on one see v1 contract row 182: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T183 | tools jev control observe — fan-out on one see v1 contract row 183: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T184 | tools jev control observe — fan-out on one see v1 contract row 184: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T185 | tools jev control observe — fan-out on one see v1 contract row 185: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T186 | tools jev control observe — fan-out on one see v1 contract row 186: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T187 | tools jev control observe — fan-out on one see v1 contract row 187: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T188 | tools jev control observe — fan-out on one see v1 contract row 188: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T189 | tools jev control observe — fan-out on one see v1 contract row 189: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T190 | tools jev control observe — fan-out on one see v1 contract row 190: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T191 | tools jev control observe — fan-out on one see v1 contract row 191: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T192 | tools jev control observe — fan-out on one see v1 contract row 192: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T193 | tools jev control observe — fan-out on one see v1 contract row 193: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T194 | tools jev control observe — fan-out on one see v1 contract row 194: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T195 | tools jev control observe — fan-out on one see v1 contract row 195: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T196 | tools jev control observe — fan-out on one see v1 contract row 196: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T197 | tools jev control observe — fan-out on one see v1 contract row 197: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T198 | tools jev control observe — fan-out on one see v1 contract row 198: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T199 | tools jev control observe — fan-out on one see v1 contract row 199: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T200 | tools jev control observe — fan-out on one see v1 contract row 200: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T201 | tools jev control observe — fan-out on one see v1 contract row 201: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T202 | tools jev control observe — fan-out on one see v1 contract row 202: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T203 | tools jev control observe — fan-out on one see v1 contract row 203: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T204 | tools jev control observe — fan-out on one see v1 contract row 204: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T205 | tools jev control observe — fan-out on one see v1 contract row 205: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T206 | tools jev control observe — fan-out on one see v1 contract row 206: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T207 | tools jev control observe — fan-out on one see v1 contract row 207: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T208 | tools jev control observe — fan-out on one see v1 contract row 208: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T209 | tools jev control observe — fan-out on one see v1 contract row 209: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T210 | tools jev control observe — fan-out on one see v1 contract row 210: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T211 | tools jev control observe — fan-out on one see v1 contract row 211: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T212 | tools jev control observe — fan-out on one see v1 contract row 212: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T213 | tools jev control observe — fan-out on one see v1 contract row 213: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T214 | tools jev control observe — fan-out on one see v1 contract row 214: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T215 | tools jev control observe — fan-out on one see v1 contract row 215: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T216 | tools jev control observe — fan-out on one see v1 contract row 216: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T217 | tools jev control observe — fan-out on one see v1 contract row 217: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T218 | tools jev control observe — fan-out on one see v1 contract row 218: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T219 | tools jev control observe — fan-out on one see v1 contract row 219: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T220 | tools jev control observe — fan-out on one see v1 contract row 220: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T221 | tools jev control observe — fan-out on one see v1 contract row 221: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T222 | tools jev control observe — fan-out on one see v1 contract row 222: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T223 | tools jev control observe — fan-out on one see v1 contract row 223: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T224 | tools jev control observe — fan-out on one see v1 contract row 224: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T225 | tools jev control observe — fan-out on one see v1 contract row 225: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T226 | tools jev control observe — fan-out on one see v1 contract row 226: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T227 | tools jev control observe — fan-out on one see v1 contract row 227: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T228 | tools jev control observe — fan-out on one see v1 contract row 228: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T229 | tools jev control observe — fan-out on one see v1 contract row 229: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T230 | tools jev control observe — fan-out on one see v1 contract row 230: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T231 | tools jev control observe — fan-out on one see v1 contract row 231: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T232 | tools jev control observe — fan-out on one see v1 contract row 232: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T233 | tools jev control observe — fan-out on one see v1 contract row 233: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T234 | tools jev control observe — fan-out on one see v1 contract row 234: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T235 | tools jev control observe — fan-out on one see v1 contract row 235: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T236 | tools jev control observe — fan-out on one see v1 contract row 236: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T237 | tools jev control observe — fan-out on one see v1 contract row 237: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |

Appendix rows restate the contract. They are not extra product scope.
