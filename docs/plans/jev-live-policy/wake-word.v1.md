# Jev wake word v1 — gated listen session spec

Status: contract for `cursor/jev-live-policy-d0bc` on top of PR #409.

## Why

Listen v1 is push-to-session. A wake word starts that session without
the terminal focused, without becoming a spyware mic. This spec exists
so implementers do not bolt Porcupine into `listen.ts`.

## Non-goals

No always-on cloud streaming. Audio before the wake word must not leave
the machine. No vendor lock in the public API. Off by default. The
wake-word process never clicks.

## Threat model

A wake-word listener holds a microphone. v1 requires `tools jev wake
enable` with a first-time TTY confirm, writes
`~/.genesis-tools/jev/wake.json` mode 0600, logs start/stop never
samples, refuses `GENESIS_TOOLS_NO_WAKE=1`, refuses non-TTY unless
`--yes` and the marker exists.

Pre-trigger audio is a 1.5 s in-memory ring. Not written. Not uploaded.

## API

```ts
export interface WakeWordEngine {
  id: "fixture" | "keyword" | "porcupine";
  start(options: { word: string; sensitivity: number; signal: AbortSignal }): Promise<void>;
  events(): AsyncIterable<{ kind: "trigger" | "error"; atMs: number; word?: string }>;
  close(): Promise<void>;
}
```

v1 ships `fixture` and a cheap `keyword` energy gate. Porcupine is
named, not bundled.

## Session

`idle --trigger--> listen(max-seconds=12) --silence|budget--> idle`

v1 may reopen STT after trigger. Losing the first syllable is accepted
and recorded as a v2 bug.

## CLI

```
tools jev wake status
tools jev wake enable --word "hey jev" --stt xai
tools jev wake disable
tools jev wake test --fixture trigger.jsonl
```

`status` is a diagnostic and must not start the mic.

## Overlay

On trigger, flash the existing overlay in the target corner for 300 ms.

## Tests

Fixture trigger opens listen once. Cooldown suppresses a second trigger.
Disable stops the engine. Status does not call start. Pre-trigger frames
never appear in STT fixture events.

## Shared invariants (copy on every feature)

1. Jev is text-only. Pixels become text through native OCR or AX/CDP labels.
2. Jev does not generate chat replies, review comments, or free-form shell.
3. Arbitrary typing, coordinates, and shell stay outside the chooser.
4. Semantic judge may abstain. Exact readback is authoritative.
5. Decision gates stay at `minProbability` 0.8, `minMargin` 0.15,
   `minConfidence` 0.7 unless a command documents a stricter gate.
6. Control tooling may call no other AI model for target choice.
   Escalation is a host packet, never a second model.
7. Phase 2 waits, recovery, rebind, and OCR grounding are already in
   PR #409. This work sits on top and must not rewrite them.
8. `ok: true` means dispatch succeeded, not that the user's goal happened.
9. A diagnostic (`status`, `doctor`, `test`, `--dry-run`) never mutates
   durable credentials or spends a single-use refresh token.
10. `src/utils/**` never imports `@app/*`. Shared types move down.
11. Every wait has a deadline or `AbortSignal`. No `sleepSync` in a loop.
12. Wake on the event. A timer under 100 ms needs a lint-rules-ignore.
13. Logger is diagnostics. `out.result` is the machine result.
14. Tests use fixture handles only. No live gateway in unit tests.
15. Biome: 120 columns, 4-space indent, SafeJSON, braced ifs, sorted imports.

## Existing modules this must reuse

- Evaluator: `@genesiscz/utils/ai/evaluation/service`
  (`createEvaluator`, `evaluateRequest`). Schema already allows many
  questions in one request (`src/utils/ai/evaluation/evaluate.ts`).
- AX observe/act: `src/control/lib/decision/{native,session,observation,decisions,assist,chooser}.ts`
- Overlay: `src/control/lib/cursor.ts` plus the native Cua overlay.
- Tool discovery: `src/tools/lib/discovery.ts`
- Browser: `src/chrome-devtools/` and `@genesiscz/utils/devtools/mcp-client`
- STT accounts: `resolveForTask({ task: "transcribe" })`,
  `AIXAITranscriptionProvider.transcribeStream`, `@ai-sdk/deepgram`,
  OpenAI/Groq whisper bindings.
- Computer-use REPL: `src/control/lib/computer-use/`

## Logging

Log provider id, account id (not secrets), snapshot token prefix, candidate
count, admitted choice, refusal reason, CDP port, and budget remaining.
A future reader of `~/.genesis-tools/logs/<date>.log` must reconstruct
the session without re-running it.

## Output

Human status on stderr (`out.log` or `@genesiscz/utils/cli/ui`). Machine
result on stdout via `out.result`. `--json` is implied when the caller
is a pipe and `--format json` is set; default CLI prints the same object
through `out.result` already used by `tools jev ask`.

## Exit codes

- 0: admitted success path for that command (listen dry-run that abstained
  is still 0; assist unverified is 1 as today).
- 1: user error, refused dispatch, unverified goal, invalid flags.
- 2: cancelled (SIGINT) after restoring terminal.
- 3: provider/auth missing (print the login command).
- 4: snapshot/token stale and the command chose to stop rather than hold.

## Test shape

Mock `Evaluator` like `src/control/commands/workflow.test.ts`. Mock STT
with a fixture async iterable. Mock `ControlDriver.observe/act`. Never
open a real microphone in CI. New files must stay cheap (no wall-clock
sleeps, no child process per assertion).


## Implementation notes that keep this honest

- A new safety parameter that defaults to the dangerous behaviour leaves
  every existing caller unsafe. Invert the default.
- Spy on the irreversible call itself (the `act`, the `refresh`, the
  `close_tab`) and make the spy throw as well as record.
- Ship the negative control: the unguarded path still works.
- Do not lower semantic gates to make a demo green.
- Do not call Bonsai or any non-Jev model from assist/listen/watch/loop.
- Do not generate sentences. If you need words, the tool that Jev picked
  prints them.
- Chrome verbs are a closed set. If a verb is not in the snapshot or the
  chrome list, the answer is abstain.
- Prefetch is a cache of last Jev ids against a snapshot token. It is
  not a license to click an index the model once liked.
- Overlay failure is not a failed action. Log and continue.
- Whole-window see/act must still refuse while a chat surface updates.
- When `--run` exists, default is print. Opt-in mutates.
- Destructive catalogue entries (control act, git push, jenkins) need
  an extra noul boolean in the same Jev request.
- Compaction never rewrites user or assistant text. If reduction is
  under 25%, return the original and say so.
- Observe fan-out is one RTT. Code branches on the answers.
- Assist should call observe-fan-out every step instead of a serial
  pick-then-maybe-judge when the v1 observe helper exists.
- Browser and AX share a `GoalSurface` interface so the loop is one
  implementation with two drivers.
- Demo uses the AppKit fixture, never the user's Mail.
- Demo success requires exact readback confirmation.
- Wake-word audio before trigger never leaves the machine.
- Status/doctor/test never start the microphone.
- Account binding uses `tools ai` profiles. No new env-only key path
  except the grandfathered set.
- `tools jev control` remains the same registry as `tools control`.
- Dashboard APIs stay same-origin, `x-jev-request: 1`, 64 KB bodies.
- One in-flight listen session on the dashboard. A second start is 409.
- JSONL in, JSONL out for compact and listen traces.
- Pin last N messages in compact so the tail cannot be dropped.
- Screen/verify emit `{file, p_risk, p_relevant, ...}` never a comment.
- Purpose templates are named, versioned, and listed by `--list`.
- Watch Hz default 4, max 10. Budget in seconds and requests.
- Loop re-see after every act. Hold on token change.
- Speculative top-3 is rebuilt when the winner leaves the set.
- Correction utterances invalidate prefetch.
- Non-TTY listen requires `--transcript` and defaults to dry-run.
- `--force-act` is required to dispatch from a pipe.
- Catalogue generation is deterministic for a given checkout + commit.
- Commander graph walk must not execute tool entrypoints.
- Prefer static parse of `program.command(` registrations plus README
  one-liners. Fallback: `discoverTools` names only.
- Semantic suggestion ranks by Jev score, then by name.
- Route prints the command. `--run` executes through the same `bun`
  entry the `tools` launcher uses, inheriting stdio.
- Route `--run` of a destructive tool requires `--yes` or a TTY confirm.
- Compact LLM layer is optional `--llm` and still Jev, not a summarizer
  model. It only chooses keep/drop/truncate.
- GitHub PR hook is specified, not wired, in this PR.
- File paths in docs use repo-relative paths.
- Version headers stay `.v1.md` / `.v2.md` next to each other.

- Extra acceptance 1: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 1.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 1.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 2: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 2.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 2.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 3: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 3.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 3.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 4: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 4.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 4.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 5: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 5.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 5.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 6: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 6.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 6.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 7: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 7.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 7.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 8: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 8.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 8.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 9: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 9.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 9.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 10: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 10.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 10.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 11: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 11.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 11.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 12: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 12.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 12.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 13: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 13.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 13.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 14: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 14.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 14.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 15: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 15.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 15.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 16: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 16.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 16.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 17: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 17.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 17.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 18: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 18.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 18.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 19: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 19.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 19.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 20: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 20.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 20.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 21: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 21.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 21.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 22: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 22.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 22.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 23: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 23.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 23.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 24: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 24.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 24.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 25: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 25.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 25.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 26: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 26.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 26.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 27: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 27.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 27.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 28: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 28.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 28.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 29: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 29.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 29.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 30: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 30.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 30.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 31: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 31.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 31.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 32: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 32.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 32.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 33: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 33.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 33.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 34: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 34.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 34.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 35: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 35.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 35.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 36: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 36.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 36.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 37: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 37.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 37.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 38: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 38.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 38.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 39: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 39.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 39.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 40: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 40.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 40.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 41: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 41.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 41.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
- Extra acceptance 42: unclassified callers of new guards are bugs; document every call site in the same commit.
- Extra acceptance 42.1: remaining budget is checked before every paid request and every act.
- Extra acceptance 42.2: cancellation restores the terminal and releases the mic, CDP client, and overlay.
