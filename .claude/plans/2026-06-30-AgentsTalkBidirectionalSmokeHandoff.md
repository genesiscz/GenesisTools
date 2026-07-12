# Agents Talk Bidirectional Smoke Handoff

Date: 2026-06-30
Session: `agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94`
Feed path: `~/.genesis-tools/agents/agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94/feed.jsonl`

## What Was Tested

Used the `genesis-tools:agents-talk` skill and the live `tools agents` CLI with two real spawned subagents:

- Lead: `lead` / `main_agentstalksm`
- Alpha: `alpha` / `agt_0001`
- Beta: `beta` / `agt_0002`

Topology exercised:

1. `lead` registered a debug session and preallocated waiter slots for `alpha` and `beta`.
2. `alpha` and `beta` claimed those slots with `tools agents login --once`.
3. `lead` sent `alpha` message `0001`.
4. `alpha` responded to `lead` with response `0002`.
5. `alpha` sent `beta` message `0003`.
6. `beta` responded to `alpha` with response `0004`.
7. `beta` sent completion message `0005` to `lead`.
8. `alpha` received `beta`'s response and sent completion message `0006` to `lead`.

## Result

Bidirectional communication worked end to end:

- Lead -> alpha direct message delivered: `0001` at feed seq `12`.
- Alpha -> lead response delivered: `0002` at feed seq `16`.
- Alpha -> beta direct message delivered: `0003` at feed seq `23`.
- Beta -> alpha response delivered: `0004` at feed seq `30`.
- Beta -> lead direct completion delivered: `0005` at feed seq `31`.
- Alpha -> lead direct completion delivered: `0006` at feed seq `34`.

The lead also saw its own direct send (`0001`) on `login --once`, which confirms the outbound-confirmation behavior promised by the skill.

## Issues Found

### 1. Debug mode exposes `--once` polling churn

The skill says `--once` polling churn is always hidden:

- `plugins/genesis-tools/skills/agents-talk/SKILL.md:125`

Observed behavior in the smoke session contradicts that. With `--debug`, `lead` repeatedly received `logged_in` / `logged_out` events for `alpha`, `beta`, and even `lead`'s own `--once` passes. Example seqs:

- `13` / `14`: beta `once` login/logout
- `21` / `22`: beta `once` login/logout
- `24` / `25`: beta `once` login/logout
- `28` / `29`: alpha `once` login/logout
- `32` / `33`: alpha `once` login/logout

Relevant implementation:

- `src/agents/lib/filter.ts:77-79` returns `true` for every peer lifecycle event when `meta.debug` is enabled, before checking mode/reason.

Why it matters:

- A `login --once` consumer wakes up on lifecycle noise instead of useful messages.
- In the smoke test, the lead had to poll multiple times because one receive returned only beta lifecycle events, not the pending beta/alpha completion messages.
- This makes debug mode poor for actual bidirectional work when agents use `--once` loops.

Suggested fix:

- Preserve debug visibility for meaningful lifecycle, but hide `mode === "once"` clean-exit churn before the debug short-circuit.
- Add a filter test for `meta.debug === true` plus `event.mode === "once"` and `reason === "clean_exit"` if that is still the intended contract.

### 2. `message` output and warning contradict sender-echo behavior

The skill says senders receive their own sends for confirmation:

- `plugins/genesis-tools/skills/agents-talk/SKILL.md:122`
- `plugins/genesis-tools/skills/agents-talk/SKILL.md:129`

The implementation also does this:

- `src/agents/lib/filter.ts:45-46` returns `true` when `event.from_agent_id === agent.agent_id`.

But `tools agents message` tells the user the opposite in two places:

- `src/agents/commands/message.ts:160` says self-sends "will NOT be delivered" to the sender's stream.
- `src/agents/commands/message.ts:197` reports broadcast recipients as `"(all peers except sender)"`.

Observed behavior:

- Lead received its own direct message `0001` during `tools agents login --agent-name lead --once`.

Suggested fix:

- Update the warning/output to match actual behavior, or change the filter if the intended behavior is no sender echo.
- Current tests already encode sender echo as intended behavior in `src/agents/tests/filter.test.ts`, so docs/output should probably be corrected rather than changing filter behavior.

### 3. Current agents test suite has a timeout in this worktree

Command:

```bash
bun test src/agents/tests
```

Result:

- 23 pass
- 1 fail
- Failure: `message recipients > rejects messaging a slot that has not been claimed via login`
- Error: test timed out after 5000ms

Relevant test:

- `src/agents/tests/message-recipients.test.ts:28-70`

Manual reproduction of the user-facing CLI path passed:

```bash
GENESIS_TOOLS_HOME=/tmp/agents-msg-manual-019f1573 \
  bun run ./tools agents message \
  --from-agent-name lead \
  --to-agent-names researcher \
  --body 'too early' \
  --session msg-manual-019f1573
```

It exited `1` with:

```text
recipient agent_name "researcher" is registered but has not logged in yet (no agent_id assigned)
```

Likely next step:

- Investigate the test harness/process cleanup rather than the user-facing command path first.
- The test awaits `send.exited` and only kills the waiter afterwards; if any pipe/process lifetime hangs, the test hits Bun's default 5s timeout.
- Consider killing the waiter in a `finally` and awaiting `registerWaiter.exited`, or increasing the per-test timeout while diagnosing.

## Commands / Evidence

Key commands run:

```bash
tools agents register --agent-main --agent-name lead \
  --session agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94 \
  --debug

tools agents register --agent-name alpha \
  --role smoke-alpha \
  --session agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94

tools agents register --agent-name beta \
  --role smoke-beta \
  --session agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94

tools agents message --from-agent-name lead \
  --to-agent-names alpha \
  --body 'alpha-step-1 please ping beta and report back' \
  --session agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94

tools agents login --agent-name lead --once \
  --session agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94

tail -n 40 \
  ~/.genesis-tools/agents/agents-talk-smoke-019f1573-e3d6-7963-a317-78095c0e4e94/feed.jsonl \
  | tools json
```

Validation:

```bash
bun test src/agents/tests
```

Failed as described above. The live smoke itself completed successfully.

Passing subset:

```bash
bun test \
  src/agents/tests/filter.test.ts \
  src/agents/tests/id-gen.test.ts \
  src/agents/tests/login-state.test.ts \
  src/agents/tests/register-nowait.test.ts
```

Result: 23 pass, 0 fail.

## 2026-07-12 09:30 — Follow-up round: all 3 open items verified closed on master

Branch `fix/agents-talk-handoff` (worktree `agent-a52959e63c0c637e7`), based on `origin/master` at `4f9ebfa20`. Went through the three "Known open items" one by one, per the instruction to verify each is still open before touching anything (line numbers can drift).

**Context that explains why nothing reproduced:** the entire `src/agents/` tree — commands, lib, and tests — landed on master as a *single* squash commit, `5fd99bfb1` ("feat(agents): cross-agent communication CLI"), authored 2026-06-30 22:31:45, i.e. ~22 hours *after* this handoff was written (00:23 the same day). The WIP branch/worktree that produced the smoke-test findings above never made it into git history in its buggy form — only the final, already-cleaned-up version was committed. So "verify first" turned up nothing left to fix.

### Item 1 — `--debug` leaking `--once` lifecycle churn: ALREADY FIXED, not reproducible

Current `src/agents/lib/filter.ts` `visibleLifecycle()` (now lines 32-58, not 77-79 — file is 62 lines total) already orders the checks so `--once` is filtered before the debug short-circuit:

```
37  if (event.agent_id === agent.agent_id) { return false; }
41  if (event.mode === "once") { return false; }   // <- runs BEFORE debug check
45  if (meta?.debug) { return true; }
```

This is exactly the fix the handoff suggested ("hide `mode === 'once'` churn before the debug short-circuit"), already landed. `event.mode` exists on `LoggedOutEvent` too (optional field), so this also covers `--once` logouts, not just logins — a broader fix than the handoff's `reason === "clean_exit"` suggestion, but consistent with the skill's contract ("`--once`-mode polling churn is always hidden").

No test previously locked in the specific "debug=true AND mode=once" combination the handoff called out (existing tests covered "own events hidden even with debug" and "peer events shown with debug", but not the once-mode carve-out under debug). Added one regression test per the handoff's own "Suggested fix" note:

- `src/agents/tests/filter.test.ts` — new test `"hides peer --once login/logout churn even when session debug is on"`, covering both `logged_in`/`logged_out`, both a non-main and a main-agent viewer, all with `{ debug: true }`. All assertions pass against current code (no behavior change).

**Verdict: closed. No source fix needed — only a regression test added to guard it.**

### Item 2 — docs/CLI warning contradicting sender-echo behavior: ALREADY RECONCILED, no contradiction found

Checked all three sources named in the handoff against current `origin/master`:

- `src/agents/lib/filter.ts` `visibleMessage()` (lines 20-30): `if (event.from_agent_id === agent.agent_id) { return false; }` — **no** sender echo.
- `plugins/genesis-tools/skills/agents-talk/SKILL.md:117`: *"**You never see your own sends.** The CLI filters out events where `from_agent_id == your id` before they reach your stream — no echo-prevention logic needed on your end."* — matches.
- `src/agents/commands/message.ts:88`: *"senders do NOT see their own messages on their own login stream — the message is stored but the sender's stream filters it out."* — matches.
- `src/agents/commands/message.ts:114`: `recipients: isBroadcast ? "(all peers except sender)" : ...` — matches (broadcasts genuinely exclude the sender).

All four agree: no sender echo, ever, regardless of `--debug` (message visibility doesn't take `meta` at all — only lifecycle events do). `src/agents/tests/filter.test.ts` already has explicit tests for this ("does NOT deliver sender's own broadcast/direct message back to them"), and they pass.

The handoff's observed behavior ("Lead received its own direct message 0001 during login --once") and its claim that "tests already encode sender echo as intended" both describe the *opposite* of what's on master today — this was almost certainly true against the pre-squash WIP code, fixed before the commit landed, and the handoff was never updated to match. Per the task instruction to not change behavior and only reconcile docs-to-code: there is nothing left to reconcile: code, skill docs, and CLI warning text are already in agreement.

**Verdict: closed. No doc or code change made — verified no discrepancy exists.**

### Item 3 — `message-recipients.test.ts:28-70` timing out at 5s: file does not exist, suite does not hang

`src/agents/tests/message-recipients.test.ts` (and `login-state.test.ts`, `register-nowait.test.ts` from the "passing subset" list) do not exist anywhere in the current repo — confirmed via `fd`/`rg` across the whole tree, zero matches. The squash commit that introduced `src/agents/` on master ships a different test layout: `filter.test.ts`, `id-gen.test.ts`, `matrix-e2e.test.ts` (36 KB integration harness + `matrix.sh`), nothing else.

Ran `bun test src/agents` twice (once as baseline, once after adding the item-1 regression test):

- Baseline: `25 pass, 0 fail, 32 expect() calls. Ran 25 tests across 3 files. [71.89s]`
- Post-change: `26 pass, 0 fail, 36 expect() calls. Ran 26 tests across 3 files. [71.34s]`

No failures, no timeouts, both runs took ~71s wall time for the full suite (dominated by `matrix-e2e.test.ts`, which spawns real subprocesses) but nothing hit Bun's 5s per-test default. The specific test and race the handoff diagnosed (awaiting `send.exited` before killing the waiter) is not present in the current test files, so there's no code left to bound-fix.

**Verdict: closed — not reproducible. Nothing to fix; not counted as "attempted and gave up."**

### Net result

All 3 items verified against `origin/master` HEAD `4f9ebfa20`: none reproduce. Only change made: one new regression test in `src/agents/tests/filter.test.ts` (25 lines) locking in item 1's already-fixed behavior. Gates: `bun test src/agents` → 26 pass/0 fail; `bunx tsgo --noEmit` → clean (0 `src/agents` errors); `bunx biome check src/agents` → clean, no fixes needed.

