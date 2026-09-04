# Codex mechanics (gpt-5.x via `tools codex`)

Read this after `gt:handoff-to` has picked Codex and the readiness gate has passed. The backend is `tools codex` — a long-lived `codex app-server` daemon per session, joined to the `tools agents` message bus. Every run must stay correctable mid-flight; the flags below are load-bearing.

## Modes

| Invocation | Who drives | Blocks the main turn? |
|---|---|---|
| default | a `genesis-tools:agent-driver` subagent, spawned in the background | no |
| `--inline` | this session, via background Bash + Monitor | no |
| `--inline --wait` | this session, blocking until `turn.completed` | yes |

**Default to the driver subagent.** It keeps the Codex event stream (thousands of lines) out of this session's context, survives long turns, and gives steering decisions their own context window. Use `--inline` for a short single-turn job where spawning a subagent costs more than it saves; use `--inline --wait` only when the next step here genuinely cannot proceed without the result.

## 1. Start the lead's bus listener — durably

The driver steers through the bus, so `lead` must be listening before you spawn it. A plain `&  disown` inside a Bash call does **not** survive: observed 2026-08-27, `tools agents login --agent-main --agent-name lead > log 2>&1 & disown` printed its `{"type":"ready"…}` line and the process was then gone, with `pgrep -fl 'tools agents login --agent-main'` returning nothing. Use `nohup` with stdin detached, which was confirmed alive afterwards via `ps`:

```bash
nohup tools agents login --agent-main --agent-name lead --kinds message,error,approval_request \
  </dev/null >/tmp/lead-bus.log 2>&1 & disown
```

Then prove it took, rather than assuming:

```bash
pgrep -fl 'tools agents login --agent-main'
```

⚠️ The reason the first form died was never isolated. Treat the `nohup` recipe as the verified fix and the cause as unknown.

## 2. Spawn

```bash
tools codex spawn \
  --name <task> \
  --write ask \
  --cwd <abs path> \
  --prompt-file /tmp/codex-<task>-brief.md
```

Write policy — the only real safety dial:

| `--write` | sandbox | approvals | use for |
|---|---|---|---|
| omitted / `deny` | read-only | none possible | INLINE-only review. No file to write. |
| `ask` | workspace-write | untrusted → forwarded to `lead` | **default for implementation** |
| `allow` | workspace-write | never prompts | tightly bounded folder: vault note, disposable worktree |

### 🛑 File deliverables: never `--write deny`

If the brief tells the worker to write a path (Obsidian vault, report.md, any file), **do not spawn deny.** `--writable-root` under deny does not lift that.

Observed 2026-08-31 12:15: `--write deny` plus `--writable-root <path to the notes vault>` still failed `apply_patch` with *"writing is blocked by read-only sandbox; rejected by user approval settings"*. The vault note had to be written by the orchestrator.

Recipe for a note under the notes vault:

1. Orchestrator `mkdir -p` the note's parent first. macOS TCC on a synced folder can block the Codex child's mkdir.
2. Spawn `--write allow` with `--cwd` set to that parent. Do not set cwd to the app repo.
3. Brief: write only the exact path. Do not commit. Do not touch the repo.
4. If `apply_patch` still stalls on Tresors, the worker writes `/tmp/<same-filename>` and you `cp` it into the vault.

`--write ask` is fine if the driver will approve that one path. `allow` is allowed here because cwd is the note folder, not the live repo.

### 🛑 What read-only mode actually costs you

`deny` is the right default for an **inline** reviewer. It is far more restrictive than "cannot edit the repo". Observed on a real review handoff on 2026-08-27:

- **The worker cannot write a report file.** A brief that says "write your findings to `<path>.md`" fails. Codex refused with *"Blocked from writing the requested report: the sandbox is read-only"* and dumped about 4 KB inline. In `deny` mode the deliverable is that inline answer. Do not add the report directory as `--writable-root` and keep deny. That was the 2026-08-31 miss.
- **The worker cannot run most test runners.** Observed: Jest's Watchman probe failed (`fchmod` in a read-only temp), then haste-map persist under `/private/var/…/T` hit EPERM. Zero assertions ran, and the worker still wrote a confident "Test quality" section.

`--writable-root /tmp` and `"$TMPDIR"` under deny exist so Jest can persist a haste map. They are not a report-file hatch:

```bash
tools codex spawn --name <task> --cwd <abs path> \
  --write deny \
  --writable-root /tmp --writable-root "$TMPDIR" \
  --prompt-file /tmp/codex-<task>-brief.md
```

**Whenever a read-only worker reports on test quality, ask it for the command it ran and that command's real output.** No output means it read the tests and inferred. Say so when you relay it.

### Keeping the worker lean

`tools codex spawn` has **no config-isolation flag**. Verified 2026-08-27: its options are exactly `--name --cwd --home --model --effort --write --mode --prompt --prompt-file --no-agents --session --writable-root`; `--no-skills` and `--no-rules` were added 2026-09-04 for parity with grok and claude, and they only print a warning that codex cannot honour them. This is a real asymmetry with the `codex exec` fallback below, which passes `--ignore-user-config` because loading `~/.codex` fires the user's notification hooks (and adds a few thousand input tokens).

Observed cost of not isolating: a code-review worker spent its startup attaching about 20 MCP servers it had no use for (expo, higgsfield, apify, vitrinka, playwright, firecrawl, jina, brave-search and more), four of which failed noisily — three "not logged in" errors and a vitrinka HTTP connect failure.

Workaround until the flag exists: point `--home` at a minimal `CODEX_HOME` that contains only the auth file. `--home` is real and lands where you need it — `spawnAppServer()` sets `childEnv.CODEX_HOME` from it before launching `codex app-server` (`src/codex/lib/app-server-client.ts:295-297`), reached via `spawn.ts:124` → `daemon.ts:47`.

```bash
mkdir -p ~/.genesis-tools/codex/lean-home
cp ~/.codex/auth.json ~/.genesis-tools/codex/lean-home/ 2>/tmp/lean-home.err; cat /tmp/lean-home.err
tools codex spawn --name <task> --home ~/.genesis-tools/codex/lean-home --cwd <abs path> ...
```

Other flags: `--model` / `--effort`, `--mode review|task`, `--session <id>` when no parent session can be discovered (resolution order: the explicit flag, then `$GENESIS_AGENTS_SESSION`, then `$GT_RENDEZVOUS_SESSION`, and only then the host session id of whoever runs the spawn — Claude Code, Codex or grok. An assigned swarm always outranks an inherited host id, so a nested worker cannot re-parent its children), `--no-agents` to disable the bus (do not — the bus is the point).

Sessions land in `~/.genesis-tools/codex/sessions/<name>.*` (`.jsonl` event log, `.meta.json`, `.daemon.log`). Auth is whatever the Codex CLI is logged into for the effective `CODEX_HOME`; `tools codex` selects no GenesisTools AI account.

The session auto-registers on the bus as `codex_<name>`. **Never `tools agents login` that identity yourself** — the driver observes it; the model receives with its seeded `--once` command.

## 3. Checkpoint contract (state it in the brief, every time)

Codex presses on by default. The brief must say where it stops. The generic contract (ask before new files, dependencies, interface changes or git operations; stop after two failed verifies; paths character for character; the `RESULT/AT/CHANGED/VERIFY/OPEN` report lines; the bus commands) is injected by the harness (`src/utils/worker/contract.ts`, see § The worker's own instructions below), so the brief carries only the task-specific lines, filled in:

```markdown
## Stop and report — do not continue past these
- After <first milestone>: report what changed + the verify output, then WAIT for a reply.
- If the task turns out to need work outside <declared scope>: STOP and report the gap.
- Do NOT touch <paths>.
```

The path rule earns its line. Observed: a brief supplied `/private/tmp/claude-502/-Users-Martin-Tresors-Projects-Contoso-example-app/<uuid>/scratchpad/report.md` and Codex echoed it back as `…/-Users-Martin-Tresors-Projects/Contoso-example-app/<uuid>/…`, substituting a `/` for a `-` mid-path. Harmless that time because the orchestrator used its own path; a human copy-pasting it lands nowhere.

## 4. Watch and steer

```bash
tools codex status  --name <task>
tools codex tail    --name <task> --follow      # background + Monitor
tools codex read    --name <task>               # thread snapshot
tools codex steer   --name <task> --body 'Focus on the auth path; do NOT refactor the router'
tools codex interrupt --name <task>             # kill the current turn
tools codex rollback  --name <task> --turns 1   # drop turns from the end
tools codex stop      --name <task>             # tear down
```

`tools codex logs` and `tail` take `--events` to render the shared worker-event stream (`src/utils/worker/events.ts`) instead of raw notifications, and `--format compact|json|jsonl|events|raw` to go through the transcript door every backend shares (`tools grok read --format`, `tools claude worker read --format`, `tools ai sessions tail <name> --provider codex`). The default raw view is unchanged and stays the authoritative one for approvals, since it carries the request ids; the transcript formats do not. Codex's capabilities (the only backend with mid-turn approvals and mid-turn steering) are declared in `WORKER_CAPABILITIES.codex` (`src/utils/worker/capabilities.ts`).

Repeat the negative constraints in every steering message — the correction is what the model attends to now.

## 5. Approvals

With `--write ask`, out-of-policy commands and file changes pause and arrive on the bus as `approval_request` messages to `lead`:

```bash
tools codex approve --name <task> --request <id>
tools codex deny    --name <task> --request <id>
```

**The recipient is always `lead`** — it is hardcoded (`leadName: "lead"`, `src/codex/lib/session.ts:124`), not the driver's name. So in driver mode the bus message lands on the orchestrator, not on `driver_<task>`. The driver picks approvals up from its own `tools codex tail --name <task> --follow` stream, which carries the request id; if `lead` sees the bus message first, it forwards the id to the driver. Either way the session stays paused until someone answers, so an unanswered approval shows up as a stall, not a silent continue.

Driver authority: **approve autonomously** only when the action is inside the declared writable roots and inside the declared task scope. **Escalate to the human** for anything that expands scope, adds a dependency, touches git history, or leaves the declared paths.

Waking a possibly-idle peer needs both channels: `tools agents message ...` (durable payload) **then** a harness `SendMessage` nudge. Agents-channel traffic alone does not re-invoke an idle subagent.

## 6. 🛑 The driver's VERDICT is not guaranteed — never block on it alone

`genesis-tools:agent-driver` is specified to end with a `VERDICT:` block. **It does not always send one.** Observed 2026-08-27: the orchestrator received three `idle_notification` messages (idleReason `available`, then `interrupted`, then `available`) and no VERDICT at all, while `tools codex status` showed the session flip `running → ready → closed`. Waiting for the VERDICT literally would have deadlocked the session.

So treat the VERDICT as the fast path, never the only path. Poll the session yourself:

```bash
tools codex status --name <task>     # closed / ready with no VERDICT = go read it yourself
tools codex read   --name <task>     # thread snapshot; the worker's final answer is in here
```

⚠️ **Distrust driver relays that disagree with the session state.** In the same run the driver sent *"Still waiting on the Codex driver for the formal MR review verdict"* after the report had already landed, been saved, been verified and the session stopped. A second message carried an idle timestamp **earlier** than work already completed. An orchestrator that trusted those relays would have waited or paid for a duplicate run. `tools codex status` and `tools codex read` are the authority; the driver's prose is not.

## 7. Verify, then integrate

Never trust the worker's self-report. After the turn completes:

1. Run the verification command yourself.
2. `git diff` — read it, do not skim it.
3. Only then integrate, commit, or hand back.

Then `tools codex stop --name <task>`.

## Spawning the driver

After the brief is written and the lead listener from §1 is confirmed alive:

```text
Agent(
  subagent_type: "genesis-tools:agent-driver",
  model: "sonnet",              // "opus" per gt:handoff-to § Driver-model choice
  run_in_background: true,
  prompt: "BACKEND: codex\nNAME: <task>\nCWD: <abs path>\nBRIEF_FILE: /tmp/codex-<task>-brief.md\nWRITE_POLICY: ask\nVERIFY_CMD: <command + expected output>\nSCOPE: <paths the worker may touch>\nESCALATE: <what must come back to the human>"
)
```

❗ **Do not pass `isolation: "worktree"` for a read-only reviewer.** It buys nothing (the worker cannot write anyway) and it can fail outright. Observed: the Agent call died with *"Cannot create worktree: `<repo>/.claude/worktrees` is a symlink"*, and retrying without isolation worked immediately. Reserve worktree isolation for writable workers running in parallel.

## The worker's own instructions are injected in code, not from this file

`tools codex spawn` passes the worker's receiving-end contract as `developerInstructions` on `thread/start` (`src/codex/lib/session.ts`). Since 2026-09-04 that text is the ONE contract every backend injects, `buildWorkerContract()` in `src/utils/worker/contract.ts` (grok passes it as `--rules`, claude as `--append-system-prompt`); `buildAgentInstructions()` in `src/codex/lib/seed-instructions.ts` is codex's door onto it and adds the bus identity. It covers: how to message `lead` and check for steering with `--once` (only when the swarm is enabled; a `--no-agents` worker still gets the rest), honoring the **Stop and report** block, asking before new files or dependencies or git operations, pasting real verification output, and ending the final message with `RESULT: / AT: / CHANGED: / VERIFY: / OPEN:`. A read-only sandbox gets a variant telling it to narrate instead, because `tools agents` writes fail with EPERM there.

So do **not** restate the receiving-end contract in your brief, and do not edit it here — edit `src/utils/worker/contract.ts`, which is covered by `contract.test.ts` and `seed-instructions.test.ts`.

## Fallback: one-shot `codex exec`

For a job that needs no bus, no daemon, and no mid-flight steering:

```bash
command codex --sandbox workspace-write exec \
  --json --ignore-user-config --skip-git-repo-check \
  -C <workdir> -o /tmp/codex-<task>-last.md \
  "<self-contained prompt>" 2>&1 | tee /tmp/codex-<task>.log
```

- `command codex` — the user's zsh wrapper silently injects `--sandbox danger-full-access`; a worker must get an explicit narrower sandbox.
- `--json` — first event is `{"type":"thread.started","thread_id":"..."}`; capture it or the run is not resumable.
- `--ignore-user-config` — otherwise it loads `~/.codex` config and skills and fires the user's notification hooks. The hooks are the reason to pass it; the token cost is small. Measured 2026-08-29 on codex-cli 0.148.0, three interleaved pairs of `codex exec --json "reply with the single word ok"`: 25,247 input tokens loaded versus ~20.6k with the flag, so about **4.6k**. An earlier note here claimed ~450k, which is wrong by roughly 100x — no first turn in 25 recorded sessions exceeded 33,344 input tokens.
- `-o <file>` — read the answer from this file, never by parsing the stream.
- Never `--ephemeral` if you might resume.

Wait on event types only (`error:` appears in normal red-test output):

```bash
SECONDS=0; until rg -q '"type":"turn.completed"|"type":"turn.failed"' /tmp/codex-<task>.log || [ $SECONDS -ge 600 ]; do sleep 5; done
rg -q '"type":"turn.completed"|"type":"turn.failed"' /tmp/codex-<task>.log || { echo "TIMEOUT after ${SECONDS}s — turn never terminated"; tail -20 /tmp/codex-<task>.log; exit 1; }
```

The re-check after the loop is not optional: the loop also exits on the deadline, and a timed-out run still leaves a stale `-o` file on disk. Reading that file without confirming a terminal event reports a half-finished turn as a result. On timeout, stop and report — do not resume blindly.

Resume: `command codex exec resume <thread_id> --json --ignore-user-config --skip-git-repo-check -c sandbox_mode="workspace-write" -o /tmp/codex-<task>-steer.md "<correction>"`. Nothing is inherited from the original invocation — `--ignore-user-config` and `--skip-git-repo-check` must both be repeated, and `--sandbox`/`--cd` are **not** re-applied on resume, so pass sandbox as `-c sandbox_mode=`. Dropping `--ignore-user-config` on resume silently reloads `~/.codex` config and skills mid-thread.
