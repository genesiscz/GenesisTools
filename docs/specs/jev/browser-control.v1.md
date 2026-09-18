# Browser control from a goal (chrome-devtools + Jev)

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v1 |
| Status | implement |
| Date | 2026-09-18 |
| Stacked on | PR #409 `feat/jev-gateway-lab` |
| Demand | Martin Foltyn 2026-09-18 |


## User demand

`tools jev` needs browser control from a goal. Use `src/chrome-devtools` and `plugins/**/chrome-devtools`. Expand them. Clicks must be visible with the existing Swift native overlay. The pipeline listen → transcript → Jev → browser actions is in scope. The Atlas screenshot (OpenCode `browser-use`, 10 Jev requests in 312 ms, 15-step cap, fill/click/stop) is the UX target.

## What already exists

| Piece | Path | Reuse |
|---|---|---|
| CDP client | `src/chrome-devtools/lib/cdp.ts` `Conn` `Page` | navigate, eval, screenshot, network |
| MCP door | `src/chrome-devtools/lib/mcp.ts` `withMcp` `callTool` | `take_snapshot`, `click`, `fill`, `navigate_page` |
| Shared MCP spawn | `src/utils/devtools/mcp-client.ts` | stdio `chrome-devtools-mcp --browserUrl` |
| Launch/attach | `src/chrome-devtools/commands/browse.ts` | open, restart, port 9222 |
| Skill | `plugins/genesis-tools/skills/chrome-devtools/SKILL.md` | operator docs; do not fork |
| Overlay | `native/ax-tool` `cursor-feedback` | emit click at CSS → screen point |
| Native assist | `src/control/lib/decision/assist.ts` | copy budget/chooser/judge, do not import AX into CDP |

v1 does **not** drive the page by generating JavaScript from Jev.

## CLI

```
tools jev browser goal "<goal>"
  --url http://127.0.0.1:43127/login
  --port 9222
  --browser chrome|brave|chromium
  --inputs '{"username":"qa-user"}'
  --max-steps 15
  --max-requests 20
  --timeout 120000
  --record false
  --provider typesafe|vercel
  --no-cursor
```

Alias: `tools jev control browser-goal` for worktree use.

JSON result matches the screenshot shape:

```
{
  "status": "completed|stopped|unknown",
  "url": "...",
  "title": "...",
  "timing": {"totalMs": 0, "jevMs": 0, "browserMs": 0, "jevRequests": 0},
  "steps": [{"n":1,"candidates":2,"action":"fill","uid":"1_4","label":"Username","confidence":0.91,"complete":0.01}],
  "headings": [{"level":1,"text":"Run 1842"}]
}
```

## Snapshot

Prefer MCP `take_snapshot` (accessibility tree with uid refs). Fallback: `Accessibility.getFullAXTree` via `Page.send` if MCP is missing, parsed into the same `BrowserCandidate[]`.

Candidate fields: `{uid, role, name, value?, clickable, fillable, bounds?}`. Cap 80 candidates. If more, ask Jev `scope` over landmarks first, then resnap.

Fill values come ONLY from `--inputs` (user supplied). Jev chooses which field maps to which key. Jev never invents a password.

## Actions admitted in v1

`click`, `fill` (mapped input), `navigate` (url from snapshot links only), `back`, `wait` (bounded 1s), `scroll` (page down/up), `stop`.

Not admitted: `evaluate` of model text, file upload, drag, new origin navigation except `--url` at start, download.

`stop` is selected when no action safely advances the goal (screenshot step 10). That is a success of the chooser, not a crash.

## Overlay mapping

MCP click happens in CSS viewport coords. Convert:

1. Take element box from snapshot or `DOM.getBoxModel`.
2. `Page.getLayoutMetrics` + window screenX/Y via `Browser.getWindowForTarget` or `eval` of `window.screenX` (fixed script, not Jev-generated).
3. Emit overlay at global point. Target `pixel`.

If conversion fails, click still proceeds; overlay is skipped and the step records `overlay:false`.

## Goal loop (v1)

Identical structure to `assistTask`:

1. snapshot
2. fan-out observe (done, blocked, target, verb, risk)
3. if done verified (URL+heading exact or semantic with high p) stop
4. if stop/uncertain stop
5. dispatch once
6. wait for navigation or 300 ms
7. snapshot again
8. budgets

`--record false` means do not start `chrome-devtools` HAR recorder. `--record true` attaches the existing recorder.

## Tests

Parse a fixture snapshot string into candidates.
Map inputs username → fillable textbox.
Refuse fill without a matching --inputs key.
Chooser abstain when all p < gate.
Stop action recorded as status completed if done, else stopped.
No MCP spawn in unit tests (inject BrowserDriver).

## Non-goals v1

Playwright. AppleScript. Peekaboo. Opening the user's default profile. Typing generated strings into contenteditable.


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
| T001 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 1: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T002 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 2: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T003 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 3: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T004 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 4: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T005 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 5: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T006 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 6: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T007 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 7: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T008 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 8: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T009 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 9: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T010 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 10: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T011 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 11: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T012 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 12: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T013 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 13: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T014 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 14: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T015 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 15: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T016 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 16: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T017 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 17: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T018 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 18: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T019 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 19: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T020 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 20: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T021 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 21: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T022 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 22: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T023 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 23: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T024 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 24: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T025 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 25: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T026 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 26: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T027 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 27: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T028 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 28: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T029 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 29: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T030 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 30: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T031 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 31: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T032 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 32: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T033 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 33: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T034 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 34: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T035 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 35: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T036 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 36: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T037 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 37: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T038 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 38: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T039 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 39: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T040 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 40: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T041 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 41: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T042 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 42: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T043 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 43: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T044 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 44: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T045 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 45: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T046 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 46: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T047 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 47: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T048 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 48: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T049 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 49: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T050 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 50: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T051 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 51: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T052 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 52: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T053 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 53: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T054 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 54: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T055 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 55: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T056 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 56: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T057 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 57: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T058 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 58: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T059 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 59: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T060 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 60: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T061 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 61: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T062 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 62: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T063 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 63: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T064 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 64: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T065 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 65: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T066 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 66: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T067 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 67: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T068 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 68: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T069 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 69: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T070 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 70: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T071 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 71: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T072 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 72: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T073 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 73: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T074 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 74: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T075 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 75: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T076 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 76: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T077 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 77: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T078 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 78: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T079 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 79: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T080 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 80: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T081 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 81: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T082 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 82: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T083 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 83: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T084 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 84: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T085 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 85: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T086 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 86: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T087 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 87: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T088 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 88: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T089 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 89: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T090 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 90: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T091 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 91: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T092 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 92: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T093 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 93: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T094 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 94: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T095 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 95: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T096 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 96: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T097 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 97: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T098 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 98: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T099 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 99: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T100 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 100: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T101 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 101: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T102 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 102: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T103 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 103: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T104 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 104: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T105 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 105: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T106 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 106: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T107 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 107: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T108 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 108: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T109 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 109: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T110 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 110: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T111 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 111: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T112 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 112: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T113 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 113: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T114 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 114: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T115 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 115: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T116 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 116: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T117 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 117: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T118 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 118: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T119 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 119: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T120 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 120: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T121 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 121: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T122 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 122: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T123 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 123: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T124 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 124: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T125 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 125: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T126 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 126: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T127 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 127: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T128 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 128: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T129 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 129: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T130 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 130: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T131 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 131: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T132 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 132: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T133 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 133: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T134 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 134: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T135 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 135: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T136 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 136: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T137 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 137: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T138 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 138: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T139 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 139: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T140 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 140: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T141 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 141: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T142 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 142: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T143 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 143: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T144 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 144: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T145 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 145: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T146 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 146: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T147 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 147: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T148 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 148: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T149 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 149: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T150 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 150: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T151 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 151: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T152 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 152: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T153 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 153: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T154 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 154: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T155 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 155: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T156 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 156: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T157 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 157: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T158 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 158: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T159 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 159: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T160 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 160: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T161 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 161: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T162 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 162: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T163 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 163: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T164 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 164: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T165 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 165: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T166 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 166: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T167 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 167: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T168 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 168: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T169 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 169: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T170 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 170: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T171 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 171: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T172 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 172: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T173 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 173: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T174 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 174: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T175 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 175: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T176 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 176: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T177 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 177: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T178 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 178: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T179 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 179: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T180 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 180: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T181 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 181: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T182 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 182: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T183 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 183: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T184 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 184: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T185 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 185: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T186 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 186: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T187 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 187: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T188 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 188: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |
| T189 | Browser control from a goal (chrome-devtools + Jev) v1 contract row 189: validate input, bound work, JSON in, JSON out, refuse illegal states. | Fake evaluator; no network; no sleep. |

Appendix rows restate the contract. They are not extra product scope.
