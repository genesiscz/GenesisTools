# Listen: realtime STT, wake word, live transcript

| Field | Value |
|---|---|
| Surface | `tools jev` |
| Version | v1 |
| Status | implement |
| Date | 2026-09-18 |
| Stacked on | [PR #409](https://github.com/genesiscz/GenesisTools/pull/409) `feat/jev-gateway-lab` |
| Author demand | Martin Foltyn, 2026-09-18 (voice, browser goal, route, compact, observe, verify, see/act loop, demo) |
| Related bookmarks | Moritz voice browser, CJ no-LLM tools, tamara compaction, Archer fan-out, Jack Cheng vibe-check, Max Blade high-Hz |


## 1. User demand (verbatim intent)

1. Add `tools jev listen`. Reuse GPT Live / Grok Live transcripts if they already exist under `src/ai/` or `src/utils/`. If they do not, put the unified live-STT module in `src/utils/ai/live-stt/` so every tool can share it.
2. Support Deepgram, Grok Live STT, and GPT realtime STT. Keep providers modular. Wire credentials through `tools ai` accounts, not a new key pile.
3. Wake word is required. v1 ships a deterministic detector plus a spec for the Jev-backed detector.
4. Pipeline: listen realtime → live transcript → feed Jev → browser (and native) actions. Clicks MUST show the existing Swift native overlay.
5. Keep it modular. Do not fork TranscriptionManager. Do not read `process.env` in application code.

## 2. What already exists (do not rewrite)

| Existing | Path | Role in v1 |
|---|---|---|
| Batch transcription facade | `src/utils/ai/transcription/TranscriptionManager.ts` | File STT only. Not a live session. |
| Task transcriber | `src/utils/ai/tasks/Transcriber.ts` | Chunked uploads, diarize. Not live. |
| Deepgram SDK mapping | `src/utils/ai/transcription/sdk-result.ts` | Reuse utterance → segment mapping if a live Deepgram message looks the same. |
| AI accounts | `src/utils/ai/AIAccount.ts`, `src/ai/` | Credential + model resolution. Live STT must go through the same account objects. |
| Grok / OpenAI realtime tunnel | `src/ai-proxy/REALTIME.md`, `src/ai-proxy/lib/realtime.ts` | `wss` tunnel for `grok-voice-latest` and `gpt-realtime`. Transcription events already exist (`audio.input.transcription`, `response.output_audio.transcript`). |
| Batch proxy STT | `POST /v1/audio/transcriptions` on ai-proxy | Fallback when live WS is down; not the primary listen path. |
| `tools ask --sst` | `src/ask` | One-shot file. Listen is streaming. |
| Cursor overlay | `native/ax-tool/Sources/CursorOverlay.swift` | Clicks from listen must emit `CursorFeedbackEvent` `{action:click,x,y,target:pixel}`. |

There is **no** existing `src/ai` "gpt live" CLI. The live capability lives in ai-proxy realtime. v1 therefore adds `src/utils/ai/live-stt` as the missing shared client, and `tools jev listen` as the product surface.

`src/wakeup` is Wake-on-LAN. It is unrelated. Do not put wake-word code there.

## 3. Vocabulary

| Term | Meaning |
|---|---|
| Partial | Non-final ASR hypothesis. May shrink or rewrite. |
| Final | Endpointed utterance. Stable for Jev. |
| Wake phrase | Configurable list, default `["hey genesis", "ok genesis", "genesis"]`. |
| Armed | Wake accepted; subsequent finals (and optionally high-confidence partials) are intents. |
| Idle | Microphone open, nothing is dispatched. |
| Intent window | Time after wake during which speech is collected before Jev sees it. Default 2500 ms of silence or a final punctuation. |
| Provider id | `deepgram` \| `grok-live` \| `gpt-realtime`. |

## 4. Module layout

```
src/utils/ai/live-stt/
  types.ts          # TranscriptEvent, LiveSttProvider, LiveSttSession
  accounts.ts       # resolve STT account through tools ai catalog (no process.env)
  wake-word.ts      # normalize + contains detector (v1), Jev detector interface (v2)
  session.ts        # fan-in audio, fan-out events, abort, budgets
  providers/
    mock.ts         # tests
    deepgram.ts     # Deepgram listen WS, nova-3
    grok-live.ts    # OpenAI-realtime events via ai-proxy or direct xAI
    gpt-realtime.ts # same protocol, OpenAI account
  index.ts
  live-stt.test.ts
src/jev/lib/listen-pipeline.ts
src/jev/lib/listen-pipeline.test.ts
src/jev/commands/listen.ts
```

`src/utils/ai/live-stt` MUST NOT import `@app/*`. Jev pipeline imports the utils package and `@app/control` / chrome-devtools.

## 5. CLI

```
tools jev listen [--provider vercel|typesafe]
  --stt deepgram|grok-live|gpt-realtime
  --account <ai-account-name>
  --wake "hey genesis,ok genesis,genesis"
  --wake-mode off|contains|jev
  --lang en
  --device default
  --pcm-in <path|->          # tests and piping; omit to use system mic (macOS)
  --sample-rate 16000
  --goal <text>              # optional standing goal; otherwise each armed utterance is the goal
  --target browser|native|auto
  --app <name>
  --window-id <id>
  --port 9222                # CDP when target is browser
  --url <url>                # navigate first when browser
  --max-steps 8
  --max-requests 20
  --timeout 120000
  --no-cursor
  --json                     # JSONL events on stdout
```

Stdout is JSONL:

```
{"type":"ready","stt":"deepgram","wake":["hey genesis"]}
{"type":"partial","text":"hey gene","tMs":120}
{"type":"final","text":"hey genesis open atlas","tMs":890}
{"type":"wake","matched":"hey genesis","remainder":"open atlas"}
{"type":"decision","choice":"uid=1_12","p":0.91,"admitted":true}
{"type":"dispatch","ok":true,"overlay":true}
{"type":"stop","reason":"idle-timeout"}
```

`--json` is the default for non-TTY. TTY prints a one-line live transcript plus the last decision.

## 6. Audio capture

v1 capture sources, in order of admission:

1. `--pcm-in -` or a file: s16le mono PCM at `--sample-rate`. This is the test path and the Linux path.
2. macOS: `sox` / CoreAudio via a small helper if present. If the helper is missing, refuse with a message that names `--pcm-in`.
3. No Pulse/ALSA busy-loop. Linux without `--pcm-in` exits 1.

Push frames of 20 ms. A provider that wants 100 ms buffers concatenates. Never block the event loop on a 1-second read.

## 7. Provider contracts

Every provider implements:

```
interface LiveSttProvider {
  readonly id: "deepgram" | "grok-live" | "gpt-realtime" | "mock";
  connect(options: ConnectOptions): Promise<LiveSttSession>;
}
interface LiveSttSession {
  write(pcm: Uint8Array): void;
  events: AsyncIterable<TranscriptEvent>;
  close(): Promise<void>;
}
```

### 7.1 Deepgram

- URL: `wss://api.deepgram.com/v1/listen?model=nova-3&smart_format=true&interim_results=true&endpointing=300`
- Auth: `Authorization: Token <key>` from the Deepgram-capable AI account (`DEEPGRAM_API_KEY` via `env` helpers / account `apiKeyEnv`, never `process.env.DEEPGRAM_API_KEY` in product code).
- Map `is_final` → `final`, `speech_final` → endpoint.
- Close: send empty close frame, await, then abort after 2 s.

### 7.2 Grok Live

- Prefer ai-proxy tunnel `ws://127.0.0.1:8317/v1/realtime?model=<account>/grok/grok-voice-latest` when the proxy is up.
- Else direct `wss://api.x.ai/v1/realtime` with the xAI account key from `tools ai`.
- Session update: `audio.input.format = {type:audio/pcm, rate:24000}`, `audio.input.transcription = {model: grok-transcribe}`, `turn_detection` server VAD or null with explicit commit.
- Resample 16 kHz capture → 24 kHz before append.
- Treat `conversation.item.input_audio_transcription.delta` as partial and `.completed` as final.
- Do not play output audio. This is STT, not speech-to-speech. Set modalities to text if the API allows; otherwise drop `response.output_audio.delta`.

### 7.3 GPT realtime

- Same protocol as Grok through the OpenAI account (`gpt-realtime` / `gpt-realtime-mini`).
- Auth through `tools ai` OpenAI api-key account, not ChatGPT OAuth.
- Insufficient quota is a hard error naming the account, not a silent Deepgram fallback. Fallbacks are explicit `--stt` only.

### 7.4 Mock

- Used in tests. `write()` is ignored. The test injects events via `emit()`.

## 8. Wake word v1

`wake-mode contains` (default when `--wake` is non-empty):

1. Normalize: lowercase, strip punctuation except spaces, collapse whitespace, convert `hey-genesis` → `hey genesis`.
2. Match if the normalized transcript **starts with** a phrase or contains ` ${phrase} `.
3. On match: `armed = true`, remainder = text after the phrase, start intent window.
4. `--wake-mode off`: every final is an intent. Required for piped tests.
5. `--wake-mode jev`: v1 may call the v2 function if implemented; otherwise refuse with "wake-mode jev is v2".

False accepts are worse than false rejects. Do not fuzzy-match `genesis` inside `genesiscz` repository names unless it is a whole word.

Idle timeout after wake with no remainder: 6 s, then disarm.

## 9. From transcript to action (v1 subset)

v1 listen can:

- Print the transcript (always).
- Optionally run `runListenPipeline` which:
  1. Takes remainder or standing `--goal`.
  2. Observes `--target` (browser snapshot or native `see`).
  3. Calls the same chooser as `observe` / `assist` (fan-out).
  4. Dispatches one admitted action.
  5. Emits overlay at the click point.
  6. Stops after `--max-steps` or `done`.

Partial transcripts MAY run a **speculative** Jev choice but MUST NOT dispatch until a final (or 400 ms of unchanged partial after wake). Prefetch of act payloads is allowed; stale tokens are discarded.

## 10. Overlay

After a browser or native click is dispatched:

```
runAx(["cursor-feedback", "--emit", "--action", "click", "--at", `${x},${y}`, "--target", "pixel"])
```

Add `--emit` to `runCursorFeedbackCommand` in Swift so TS does not reimplement the datagram. `--target pixel` is already in `CursorFeedbackEvent.actions` / valid targets.

`--no-cursor` and `GENESIS_CONTROL_CURSOR=off` skip overlay. Overlay failure never fails the action.

## 11. Budgets and privacy

- Default listen session: 5 minutes wall, 60 Jev requests, 20 actions.
- Audio is not written to disk unless `--pcm-in` was a file already.
- Transcript JSONL may be written with `--log <path>` under `~/.genesis-tools/jev/listen/` mode 0600.
- Do not send raw audio to Jev. Only text.

## 12. Tests (v1)

| Case | Expect |
|---|---|
| contains wake at start | remainder extracted |
| wake as whole word only | `genesiscz` does not wake |
| wake-mode off | first final is intent |
| wake-mode jev on v1 | error |
| mock STT events | pipeline sees partial then final |
| speculative choice on partial | no dispatch |
| final + admitted | one dispatch |
| uncertain choice | no dispatch, JSON reason |
| overlay emit args | `--at` parsed, invalid coords refused |
| account missing | error names `tools ai` / `tools jev login` as appropriate |
| PCM header wrong | refuse before WS |

No live microphone in CI. No paid Deepgram/xAI/OpenAI in unit tests.

## 13. Failure messages (copy)

- `STT account 'work' has no Deepgram key. Use tools ai accounts, or --stt grok-live.`
- `Live listen needs PCM. Pass --pcm-in - or run on macOS with a capture helper.`
- `Wake phrase matched but the snapshot expired before dispatch. No click.`
- `gpt-realtime quota exhausted for account 'personal'. Not falling back.`

## 14. Non-goals (v1)

- Speaker diarization.
- Always-on daemon (use a later `tools daemon` registration in v2).
- Local Whisper streaming.
- barge-in TTS replies. Jev does not talk.
- Browser DOM mutation via `Runtime.evaluate` strings generated by Jev.

## 15. Acceptance

`bun run test src/utils/ai/live-stt src/jev/lib/listen-pipeline.test.ts` green.
`tools jev listen --help` lists STT providers and wake flags.
A mock-PCM fixture produces a JSONL wake + decision + abstain without network.

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

- This file is `v1`. The sibling version is the other of `.v1.md` / `.v2.md`.
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
| T001 | Behaviour row 1 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T002 | Behaviour row 2 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T003 | Behaviour row 3 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T004 | Behaviour row 4 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T005 | Behaviour row 5 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T006 | Behaviour row 6 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T007 | Behaviour row 7 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T008 | Behaviour row 8 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T009 | Behaviour row 9 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T010 | Behaviour row 10 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T011 | Behaviour row 11 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T012 | Behaviour row 12 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T013 | Behaviour row 13 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T014 | Behaviour row 14 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T015 | Behaviour row 15 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T016 | Behaviour row 16 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T017 | Behaviour row 17 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T018 | Behaviour row 18 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T019 | Behaviour row 19 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T020 | Behaviour row 20 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T021 | Behaviour row 21 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T022 | Behaviour row 22 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T023 | Behaviour row 23 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T024 | Behaviour row 24 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T025 | Behaviour row 25 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T026 | Behaviour row 26 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T027 | Behaviour row 27 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T028 | Behaviour row 28 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T029 | Behaviour row 29 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T030 | Behaviour row 30 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T031 | Behaviour row 31 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T032 | Behaviour row 32 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T033 | Behaviour row 33 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T034 | Behaviour row 34 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T035 | Behaviour row 35 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T036 | Behaviour row 36 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T037 | Behaviour row 37 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T038 | Behaviour row 38 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T039 | Behaviour row 39 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T040 | Behaviour row 40 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T041 | Behaviour row 41 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T042 | Behaviour row 42 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T043 | Behaviour row 43 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T044 | Behaviour row 44 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T045 | Behaviour row 45 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T046 | Behaviour row 46 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T047 | Behaviour row 47 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |
| T048 | Behaviour row 48 for Listen: realtime STT, wake word, live transcript v1: refuse illegal input, bound work, emit JSON, never lie about ok. | Unit test with a fake evaluator; no network. |

End of appendix. Do not implement T-rows as extra features; they only restated the contract.
