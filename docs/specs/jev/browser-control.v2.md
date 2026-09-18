# Browser control from a goal (chrome-devtools + Jev)

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v2 |
| Status | implemented (v2) |
| Date | 2026-09-18 |
| Stacked on | PR #409 `feat/jev-gateway-lab` |
| Demand | Martin Foltyn 2026-09-18 |


## Why v2

v1 is one goal, one tab, one origin, 15 steps. v2 is the Atlas-quality agent: multi-tab, dialogs, file chooser handoff to the host, HAR-backed assertions, and listen-driven continuous control.

## Tabs and pages

Use MCP `list_pages` / `select_page`. Jev extra question `page` chooses among titles. Never close a tab the session did not open.

## Dialogs

`handle_dialog` only for dialogs whose text was observed. Accept/dismiss is a Jev choice. Prompt values must come from `--inputs`.

## Auth walls

If snapshot contains password fields and `--inputs` has no password, stop with `authenticationBarrier` equivalent. Do not call native keychain. Do not screenshot the password.

## Cross-origin

`--url` start origin is pinned. A click that would navigate elsewhere requires `risk` score high + host packet, except HTTP 3xx on the same host.

## Visual + AX hybrid

v2 may include a screenshot captioner that is NOT an LLM: native OCR already in `tools control ocr`, run on the viewport PNG, text appended to Jev state. Still text-only Jev.

## Listen integration

`tools jev listen --target browser` uses this driver. Partials speculative-choose among current uids. Dispatch on finals. "go back" is a first-class verb.

## Recording and proof

`--record true` writes:
- HAR via existing recorder
- decision JSONL
- optional `tools control capture` of the window (native), not CDP screencast by default (CPU)

A demo command (`tools jev demo browser`) boots a local fixture page (the in-repo static HTML, not Atlas) and runs the login+assert flow with `--inputs`.

## Tests v2

Dialog without inputs → stop.
Cross-origin click → host packet.
OCR text included in state, truncated to 4k.
Listen partial does not click.

## Non-goals v2

Headless-only Chrome without overlay (overlay needs a real window). Remote CDP over the internet. Cookie stuffing.


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
| T001 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 1: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T002 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 2: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T003 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 3: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T004 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 4: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T005 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 5: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T006 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 6: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T007 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 7: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T008 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 8: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T009 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 9: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T010 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 10: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T011 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 11: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T012 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 12: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T013 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 13: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T014 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 14: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T015 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 15: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T016 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 16: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T017 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 17: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T018 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 18: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T019 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 19: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T020 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 20: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T021 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 21: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T022 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 22: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T023 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 23: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T024 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 24: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T025 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 25: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T026 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 26: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T027 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 27: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T028 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 28: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T029 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 29: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T030 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 30: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T031 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 31: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T032 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 32: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T033 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 33: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T034 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 34: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T035 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 35: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T036 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 36: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T037 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 37: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T038 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 38: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T039 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 39: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T040 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 40: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T041 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 41: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T042 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 42: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T043 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 43: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T044 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 44: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T045 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 45: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T046 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 46: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T047 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 47: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T048 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 48: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T049 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 49: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T050 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 50: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T051 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 51: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T052 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 52: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T053 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 53: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T054 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 54: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T055 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 55: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T056 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 56: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T057 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 57: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T058 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 58: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T059 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 59: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T060 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 60: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T061 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 61: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T062 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 62: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T063 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 63: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T064 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 64: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T065 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 65: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T066 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 66: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T067 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 67: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T068 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 68: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T069 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 69: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T070 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 70: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T071 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 71: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T072 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 72: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T073 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 73: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T074 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 74: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T075 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 75: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T076 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 76: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T077 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 77: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T078 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 78: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T079 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 79: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T080 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 80: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T081 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 81: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T082 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 82: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T083 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 83: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T084 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 84: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T085 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 85: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T086 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 86: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T087 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 87: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T088 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 88: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T089 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 89: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T090 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 90: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T091 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 91: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T092 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 92: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T093 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 93: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T094 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 94: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T095 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 95: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T096 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 96: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T097 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 97: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T098 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 98: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T099 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 99: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T100 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 100: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T101 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 101: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T102 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 102: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T103 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 103: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T104 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 104: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T105 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 105: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T106 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 106: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T107 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 107: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T108 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 108: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T109 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 109: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T110 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 110: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T111 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 111: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T112 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 112: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T113 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 113: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T114 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 114: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T115 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 115: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T116 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 116: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T117 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 117: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T118 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 118: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T119 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 119: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T120 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 120: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T121 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 121: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T122 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 122: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T123 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 123: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T124 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 124: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T125 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 125: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T126 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 126: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T127 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 127: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T128 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 128: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T129 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 129: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T130 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 130: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T131 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 131: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T132 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 132: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T133 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 133: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T134 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 134: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T135 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 135: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T136 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 136: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T137 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 137: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T138 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 138: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T139 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 139: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T140 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 140: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T141 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 141: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T142 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 142: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T143 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 143: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T144 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 144: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T145 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 145: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T146 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 146: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T147 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 147: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T148 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 148: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T149 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 149: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T150 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 150: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T151 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 151: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T152 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 152: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T153 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 153: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T154 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 154: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T155 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 155: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T156 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 156: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T157 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 157: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T158 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 158: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T159 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 159: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T160 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 160: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T161 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 161: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T162 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 162: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T163 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 163: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T164 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 164: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T165 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 165: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T166 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 166: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T167 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 167: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T168 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 168: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T169 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 169: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T170 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 170: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T171 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 171: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T172 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 172: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T173 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 173: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T174 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 174: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T175 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 175: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T176 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 176: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T177 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 177: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T178 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 178: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T179 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 179: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T180 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 180: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T181 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 181: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T182 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 182: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T183 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 183: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T184 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 184: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T185 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 185: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T186 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 186: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T187 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 187: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T188 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 188: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T189 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 189: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T190 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 190: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T191 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 191: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T192 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 192: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T193 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 193: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T194 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 194: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T195 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 195: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T196 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 196: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T197 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 197: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T198 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 198: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T199 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 199: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T200 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 200: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T201 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 201: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T202 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 202: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T203 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 203: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T204 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 204: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T205 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 205: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T206 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 206: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T207 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 207: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T208 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 208: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T209 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 209: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T210 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 210: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T211 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 211: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T212 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 212: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T213 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 213: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T214 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 214: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T215 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 215: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T216 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 216: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T217 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 217: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T218 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 218: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T219 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 219: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T220 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 220: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T221 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 221: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T222 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 222: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T223 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 223: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T224 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 224: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T225 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 225: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T226 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 226: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T227 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 227: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T228 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 228: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T229 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 229: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T230 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 230: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T231 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 231: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T232 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 232: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T233 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 233: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T234 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 234: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T235 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 235: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T236 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 236: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T237 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 237: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T238 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 238: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T239 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 239: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T240 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 240: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T241 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 241: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T242 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 242: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T243 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 243: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T244 | Browser control from a goal (chrome-devtools + Jev) v2 contract row 244: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |

Appendix rows restate the contract. They are not extra product scope.
