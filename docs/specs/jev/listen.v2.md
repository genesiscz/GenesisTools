# Listen: realtime STT, wake word, live transcript

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v2 |
| Status | specify; implement after v1 is green |
| Date | 2026-09-18 |
| Stacked on | [PR #409](https://github.com/genesiscz/GenesisTools/pull/409) `feat/jev-gateway-lab` |
| Author demand | Martin Foltyn, 2026-09-18 (voice, browser goal, route, compact, observe, verify, see/act loop, demo) |
| Related bookmarks | Moritz voice browser, CJ no-LLM tools, tamara compaction, Archer fan-out, Jack Cheng vibe-check, Max Blade high-Hz |


## 1. Why v2 exists

v1 is a session you start in a terminal. v2 is a background, wake-gated, low-power listener that can arm from a phrase **or** a Jev noul on noisy audio-derived text, recover from STT provider death, and keep a standing computer-use / browser goal without holding a TTY.

Do not start v2 implementation until v1 unit tests and one live Deepgram or Grok transcript (human-run, not CI) exist.

## 2. User demand that v1 deferred

- Wake word "definitely want this" — v2 is the real detector, not just `string.includes`.
- Grok Live and GPT STT must be first-class, including when ai-proxy is down, with account rotation.
- Pipeline listen → Jev → browser actions as a **continuous** loop, not one shot after wake.
- Modularized to `tools ai` accounts, including spend ledger rows for realtime minutes.

## 3. Jev wake detector

State = last 8 seconds of finals + current partial.
Questions in one call:

| id | type | purpose |
|---|---|---|
| woke | boolean | Does the user address GenesisTools, not mention the word in passing? |
| remainder | choice | Which span is the command: `after-wake`, `whole`, `none` |
| destructive | boolean | Is the command irreversible (send, delete, pay, push)? |
| complete | boolean | Is the utterance a finished command or still mid-sentence? |

Dispatch only if `woke.p >= 0.85` and `complete.p >= 0.7` and (`destructive.p < 0.5` or user confirmed).

Confirmation for destructive: overlay badge + terminal bell + 1.5 s cancel window. No confirmation click on the overlay (click-through). Cancel = say "stop" or Ctrl+C.

Rate limit: one wake-eval per 400 ms, coalescing partials. Shared with the action-eval budget.

## 4. Continuous pipeline

```
armed --(intent window)--> observe fan-out --> admit --> overlay+dispatch
       ^                                         |
       |--------- reobserve < 250 ms ------------+
       |
       +-- user says "stop" / "cancel" / "wait" --> idle
```

Standing `--goal` remains until `done` or 5 minutes. Subsequent utterances are **corrections** ("no, the other one") scored against the last candidate list.

"go back" must be in the browser verb set (history.back) so Moritz's demo works before the sentence ends: speculative choice on partial `go ba` may prefetch `back`; dispatch on final or on partial stable 250 ms with `p>=0.9`.

## 5. Provider health

- Heartbeat: if no event for 8 s while audio is flowing, reconnect once. Second failure → switch provider only if `--stt-fallback` was set. Default: stop and say which provider died.
- Account spend: write usage through the existing AI usage recorder (`path: "/v1/realtime"` already exists). Listen sessions must not invent a second ledger.
- Deepgram connection limits: one listen WS per process.

## 6. Daemon mode

```
tools jev listen daemon install --stt grok-live --account work --wake "hey genesis"
tools jev listen daemon status
tools jev listen daemon stop
```

Uses the existing `tools daemon` / launchd wrapper like `tools wakeup daemon`. Logs to `~/.genesis-tools/logs/`. Does not run in this Linux sandbox.

Mic permission is GenesisTools.app, same as Accessibility. `tools control doctor` gains a fourth line? **No** — doctor stays three grants. Listen daemon prints its own mic grant error.

## 7. Barge-in and "stop"

Local energy VAD: if rms stays low for 400 ms after a final, endpoint. If a new burst arrives during dispatch, abort the next Jev call; do not abort an in-flight native AXPress (same as assist).

Phrases that always disarm without Jev: `stop`, `cancel`, `wait`, `abort`, `never mind` as whole utterances.

## 8. Multi-target auto

`--target auto`:

1. If a CDP port is alive (`chrome-devtools attach` would succeed), prefer browser when the intent mentions pages, urls, tabs, login, click, form.
2. Else native `--app` if provided.
3. Else frontmost app via `tools control preflight` (read-only).
4. Else abstain.

Jev can be asked `surface: browser|native|none` as an extra fan-out question. Native still cannot use Peekaboo as a silent fallback.

## 9. Language and code-switching

v2 wake detector is language-agnostic because Jev takes the raw transcript. Default wake list stays English; users may set `--wake "ahoj genesis"` (Martin, Prague). Do not ship a Czech model. Do not downcase Unicode incorrectly (`İ` traps). Normalize with `toLocaleLowerCase("en-US")` unless `--lang` says otherwise.

## 10. Tests (v2)

| Case | Expect |
|---|---|
| Jev woke p=0.4 | stay idle |
| Jev woke p=0.9 complete p=0.4 | wait, no dispatch |
| destructive p=0.8 | confirmation window, no click |
| stop utterance | disarm even if armed |
| provider drop | one reconnect, then stop |
| correction "the other one" | re-choose from last candidates, new snapshot |
| speculative back | prefetch; dispatch only when stable |
| daemon install dry-run | plist contents, no launchd on Linux (skip) |

## 11. Non-goals (v2)

- On-device wake (Hey Siri style always-on DSP). That is a v3 hardware project.
- Storing audio for "training".
- Mixing listen with TypeScript lab character mode.

## 12. Rollout

Flag `GENESIS_JEV_LISTEN_V2=1` to enable jev wake-mode and daemon subcommands. Default remains v1 contains. Remove the flag after a week of dogfood.

## 13. Open questions

- Should wake audio stay in Deepgram keyword spotting (`keywords=genesis`) as a prefilter to save Jev calls? Tentative yes, as an optimization only, never as the only detector.
- Do we mint OpenAI ephemeral secrets for a future dashboard Listen tab? Prefer proxy tunnel so usage is logged.

## Safety invariants (shared with PR #409)

These are not optional and cannot be waived by a flag that "makes the demo work".

1. Jev never generates free text that is typed into a UI, a shell, or a CDP `evaluate`.
2. `ok: true` means dispatch was admitted. It does not mean the user's goal happened.
3. Exact readback (AXValue, CDP attribute, URL, heading text) is authoritative over semantic judgment.
4. Semantic thresholds are not lowered to force a success. Uncertain means abstain.
5. Stale snapshot tokens, changed PIDs, replaced windows, and changed CDP document ids refuse before dispatch.
6. Control-path AI is Jev only (TypeSafe direct or Vercel Gateway `typesafe-ai/jev`). Escalation is a host packet, never another model.
7. Arbitrary coordinates, generated typing, and shell actions stay outside the task chooser's action set unless the surface is an explicitly named browser fill of a user-supplied value.
8. Secrets never enter Jev state: password fields are `[private input]`; API keys are never in `--state`.
9. Budgets are monotonic: time, requests, actions. Recovery has its own cap. Ctrl+C aborts the next Jev call.
10. Overlay feedback is not proof. The native click-through overlay never moves the hardware pointer.

## Document control

- This file is `v2`. The sibling version is the other of `.v1.md` / `.v2.md`.
- Implementation MUST fail closed when this document and the code disagree.
- Do not merge a surface that cannot be demonstrated against the AppKit fixture (native) or a local HTTP fixture (browser).
- Do not call a refused snapshot-token demonstration a success.
- Update `src/jev/README.md` in the same commit as the CLI.
- Personal data probe (`scripts/ci/placeholder-check.sh`) runs before every push.
- Tests use fixture account names (`work`, `personal`) never live account names.
- New test files are expensive on CI; prefer adding cases to the surface's existing `*.test.ts`.

## Traceability appendix

The following numbered rows exist so an implementer can tick work without inventing extra product scope.

| ID | Requirement | Test idea |
|---|---|---|
| T001 | Behaviour row 1 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T002 | Behaviour row 2 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T003 | Behaviour row 3 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T004 | Behaviour row 4 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T005 | Behaviour row 5 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T006 | Behaviour row 6 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T007 | Behaviour row 7 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T008 | Behaviour row 8 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T009 | Behaviour row 9 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T010 | Behaviour row 10 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T011 | Behaviour row 11 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T012 | Behaviour row 12 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T013 | Behaviour row 13 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T014 | Behaviour row 14 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T015 | Behaviour row 15 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T016 | Behaviour row 16 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T017 | Behaviour row 17 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T018 | Behaviour row 18 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T019 | Behaviour row 19 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T020 | Behaviour row 20 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T021 | Behaviour row 21 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T022 | Behaviour row 22 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T023 | Behaviour row 23 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T024 | Behaviour row 24 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T025 | Behaviour row 25 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T026 | Behaviour row 26 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T027 | Behaviour row 27 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T028 | Behaviour row 28 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T029 | Behaviour row 29 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T030 | Behaviour row 30 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T031 | Behaviour row 31 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T032 | Behaviour row 32 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T033 | Behaviour row 33 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T034 | Behaviour row 34 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T035 | Behaviour row 35 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T036 | Behaviour row 36 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T037 | Behaviour row 37 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T038 | Behaviour row 38 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T039 | Behaviour row 39 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T040 | Behaviour row 40 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T041 | Behaviour row 41 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T042 | Behaviour row 42 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T043 | Behaviour row 43 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T044 | Behaviour row 44 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T045 | Behaviour row 45 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T046 | Behaviour row 46 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T047 | Behaviour row 47 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T048 | Behaviour row 48 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T049 | Behaviour row 49 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T050 | Behaviour row 50 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T051 | Behaviour row 51 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T052 | Behaviour row 52 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T053 | Behaviour row 53 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T054 | Behaviour row 54 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T055 | Behaviour row 55 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T056 | Behaviour row 56 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T057 | Behaviour row 57 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T058 | Behaviour row 58 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T059 | Behaviour row 59 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T060 | Behaviour row 60 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T061 | Behaviour row 61 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T062 | Behaviour row 62 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T063 | Behaviour row 63 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T064 | Behaviour row 64 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T065 | Behaviour row 65 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T066 | Behaviour row 66 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T067 | Behaviour row 67 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T068 | Behaviour row 68 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T069 | Behaviour row 69 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T070 | Behaviour row 70 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T071 | Behaviour row 71 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T072 | Behaviour row 72 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T073 | Behaviour row 73 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T074 | Behaviour row 74 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T075 | Behaviour row 75 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T076 | Behaviour row 76 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T077 | Behaviour row 77 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T078 | Behaviour row 78 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T079 | Behaviour row 79 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T080 | Behaviour row 80 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T081 | Behaviour row 81 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T082 | Behaviour row 82 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T083 | Behaviour row 83 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T084 | Behaviour row 84 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T085 | Behaviour row 85 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T086 | Behaviour row 86 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T087 | Behaviour row 87 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T088 | Behaviour row 88 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T089 | Behaviour row 89 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T090 | Behaviour row 90 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T091 | Behaviour row 91 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T092 | Behaviour row 92 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T093 | Behaviour row 93 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T094 | Behaviour row 94 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T095 | Behaviour row 95 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T096 | Behaviour row 96 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T097 | Behaviour row 97 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T098 | Behaviour row 98 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T099 | Behaviour row 99 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T100 | Behaviour row 100 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T101 | Behaviour row 101 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T102 | Behaviour row 102 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T103 | Behaviour row 103 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T104 | Behaviour row 104 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T105 | Behaviour row 105 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T106 | Behaviour row 106 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T107 | Behaviour row 107 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T108 | Behaviour row 108 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T109 | Behaviour row 109 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T110 | Behaviour row 110 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T111 | Behaviour row 111 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T112 | Behaviour row 112 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T113 | Behaviour row 113 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T114 | Behaviour row 114 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T115 | Behaviour row 115 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T116 | Behaviour row 116 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T117 | Behaviour row 117 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T118 | Behaviour row 118 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T119 | Behaviour row 119 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T120 | Behaviour row 120 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T121 | Behaviour row 121 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T122 | Behaviour row 122 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T123 | Behaviour row 123 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T124 | Behaviour row 124 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T125 | Behaviour row 125 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T126 | Behaviour row 126 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T127 | Behaviour row 127 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T128 | Behaviour row 128 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T129 | Behaviour row 129 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T130 | Behaviour row 130 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T131 | Behaviour row 131 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T132 | Behaviour row 132 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T133 | Behaviour row 133 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T134 | Behaviour row 134 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T135 | Behaviour row 135 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T136 | Behaviour row 136 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T137 | Behaviour row 137 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T138 | Behaviour row 138 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T139 | Behaviour row 139 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T140 | Behaviour row 140 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T141 | Behaviour row 141 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T142 | Behaviour row 142 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T143 | Behaviour row 143 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T144 | Behaviour row 144 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T145 | Behaviour row 145 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T146 | Behaviour row 146 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T147 | Behaviour row 147 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T148 | Behaviour row 148 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T149 | Behaviour row 149 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T150 | Behaviour row 150 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T151 | Behaviour row 151 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T152 | Behaviour row 152 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T153 | Behaviour row 153 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T154 | Behaviour row 154 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T155 | Behaviour row 155 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T156 | Behaviour row 156 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T157 | Behaviour row 157 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T158 | Behaviour row 158 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T159 | Behaviour row 159 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T160 | Behaviour row 160 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T161 | Behaviour row 161 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T162 | Behaviour row 162 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T163 | Behaviour row 163 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T164 | Behaviour row 164 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T165 | Behaviour row 165 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T166 | Behaviour row 166 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T167 | Behaviour row 167 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T168 | Behaviour row 168 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T169 | Behaviour row 169 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T170 | Behaviour row 170 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T171 | Behaviour row 171 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T172 | Behaviour row 172 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T173 | Behaviour row 173 for Listen: realtime STT, wake word, live transcript v2: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |

End of appendix. Do not implement T-rows as extra features; they only restated the contract.
