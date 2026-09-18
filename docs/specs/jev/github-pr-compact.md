# github-pr compaction hook (spec only, do not implement)

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v1-spec |
| Status | do not hook yet |
| Date | 2026-09-18 |
| Stacked on | PR #409 `feat/jev-gateway-lab` |
| Demand | Martin Foltyn 2026-09-18 |


## User demand

Do not hook compact into the github-pr skill yet. Write the spec.

## Current github-pr

`/gt:github-pr` fetches review threads, verifies claims, implements, commits, replies. Thread expansion dumps a lot of tool results into the agent context.

## Hook design (future PR)

When compact library lands in `@genesiscz/utils/ai/compact`:

1. Skill step "load threads" writes `threads.jsonl` in the worktree tmp.
2. Optional `--compact` flag (default off in first hook PR) runs layer 1.
3. Agent sees compacted JSONL. User/reviewer text stays verbatim; old bot replies and huge diffs are drop/truncate candidates.
4. Never compact the patch the agent is about to apply.

## Safety

Do not drop an unresolved review thread's latest human comment. Pin: human comments on unresolved threads, the PR title/body, the current spec.

## Tests (when implemented later)

Pin keeps unresolved human comments.
Layer 1 does not call github API.
Flag default off.


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
| T001 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 1: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T002 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 2: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T003 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 3: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T004 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 4: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T005 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 5: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T006 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 6: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T007 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 7: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T008 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 8: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T009 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 9: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T010 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 10: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T011 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 11: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T012 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 12: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T013 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 13: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T014 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 14: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T015 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 15: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T016 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 16: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T017 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 17: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T018 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 18: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T019 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 19: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T020 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 20: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T021 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 21: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T022 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 22: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T023 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 23: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T024 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 24: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T025 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 25: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T026 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 26: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T027 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 27: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T028 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 28: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T029 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 29: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T030 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 30: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T031 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 31: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T032 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 32: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T033 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 33: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T034 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 34: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T035 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 35: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T036 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 36: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T037 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 37: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T038 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 38: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T039 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 39: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T040 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 40: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T041 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 41: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T042 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 42: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T043 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 43: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T044 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 44: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T045 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 45: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T046 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 46: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T047 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 47: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T048 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 48: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T049 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 49: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T050 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 50: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T051 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 51: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T052 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 52: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T053 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 53: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T054 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 54: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T055 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 55: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T056 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 56: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T057 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 57: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T058 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 58: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T059 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 59: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T060 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 60: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T061 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 61: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T062 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 62: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T063 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 63: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T064 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 64: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T065 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 65: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T066 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 66: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T067 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 67: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T068 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 68: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T069 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 69: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T070 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 70: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T071 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 71: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T072 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 72: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T073 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 73: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T074 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 74: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T075 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 75: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T076 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 76: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T077 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 77: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T078 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 78: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T079 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 79: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T080 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 80: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T081 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 81: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T082 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 82: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T083 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 83: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T084 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 84: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T085 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 85: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T086 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 86: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T087 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 87: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T088 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 88: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T089 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 89: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T090 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 90: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T091 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 91: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T092 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 92: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T093 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 93: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T094 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 94: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T095 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 95: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T096 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 96: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T097 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 97: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T098 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 98: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T099 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 99: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T100 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 100: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T101 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 101: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T102 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 102: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T103 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 103: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T104 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 104: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T105 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 105: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T106 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 106: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T107 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 107: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T108 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 108: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T109 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 109: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T110 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 110: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T111 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 111: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T112 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 112: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T113 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 113: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T114 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 114: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T115 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 115: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T116 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 116: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T117 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 117: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T118 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 118: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T119 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 119: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T120 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 120: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T121 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 121: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T122 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 122: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T123 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 123: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T124 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 124: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T125 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 125: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T126 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 126: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T127 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 127: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T128 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 128: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T129 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 129: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T130 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 130: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T131 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 131: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T132 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 132: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T133 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 133: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T134 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 134: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T135 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 135: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T136 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 136: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T137 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 137: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T138 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 138: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T139 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 139: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T140 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 140: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T141 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 141: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T142 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 142: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T143 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 143: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T144 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 144: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T145 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 145: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T146 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 146: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T147 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 147: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T148 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 148: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T149 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 149: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T150 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 150: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T151 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 151: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T152 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 152: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T153 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 153: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T154 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 154: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T155 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 155: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T156 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 156: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T157 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 157: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T158 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 158: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T159 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 159: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T160 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 160: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T161 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 161: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T162 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 162: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T163 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 163: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T164 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 164: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T165 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 165: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T166 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 166: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T167 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 167: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T168 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 168: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T169 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 169: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T170 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 170: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T171 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 171: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T172 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 172: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T173 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 173: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T174 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 174: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T175 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 175: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T176 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 176: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T177 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 177: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T178 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 178: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T179 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 179: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T180 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 180: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T181 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 181: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T182 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 182: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T183 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 183: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T184 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 184: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T185 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 185: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T186 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 186: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T187 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 187: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T188 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 188: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T189 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 189: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T190 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 190: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T191 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 191: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T192 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 192: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T193 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 193: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T194 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 194: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T195 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 195: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T196 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 196: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T197 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 197: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T198 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 198: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T199 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 199: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T200 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 200: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T201 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 201: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T202 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 202: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T203 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 203: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T204 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 204: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T205 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 205: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T206 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 206: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T207 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 207: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T208 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 208: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T209 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 209: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T210 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 210: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T211 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 211: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T212 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 212: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T213 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 213: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T214 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 214: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T215 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 215: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T216 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 216: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T217 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 217: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T218 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 218: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T219 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 219: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T220 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 220: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T221 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 221: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T222 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 222: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T223 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 223: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T224 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 224: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T225 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 225: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T226 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 226: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T227 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 227: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T228 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 228: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T229 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 229: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T230 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 230: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T231 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 231: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T232 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 232: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T233 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 233: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T234 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 234: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T235 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 235: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T236 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 236: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T237 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 237: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T238 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 238: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T239 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 239: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T240 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 240: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T241 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 241: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T242 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 242: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T243 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 243: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T244 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 244: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T245 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 245: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T246 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 246: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T247 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 247: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T248 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 248: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T249 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 249: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T250 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 250: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T251 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 251: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T252 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 252: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T253 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 253: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T254 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 254: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T255 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 255: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T256 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 256: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T257 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 257: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T258 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 258: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T259 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 259: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T260 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 260: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T261 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 261: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T262 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 262: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T263 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 263: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T264 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 264: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T265 | github-pr compaction hook (spec only, do not implement) v1-spec contract row 265: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |

Appendix rows restate the contract. They are not extra product scope.
