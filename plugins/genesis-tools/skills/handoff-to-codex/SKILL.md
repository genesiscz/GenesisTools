---
name: handoff-to-codex
description: Hand a review or an implementation to Codex and drive the session (spawn, steer, approve, verify). Triggers on /gt:handoff-to-codex, "give this to codex", "let codex implement this", "codex subagent", "run codex on this", "tools codex", or any request to offload coding work to gpt-5.x.
---

# handoff-to-codex

Run OpenAI Codex as a steerable worker under this session: you architect and verify, Codex implements. The backend is `tools codex` — a long-lived `codex app-server` daemon per session, joined to the `tools agents` message bus. Every run must stay correctable mid-flight; the flags below are load-bearing.

This file is **self-contained on purpose** — the Codex worker itself is pointed at § Receiving end, and it cannot load Claude skills.

Not sure Codex is the right worker at all? `gt:handoff-to` decides that. Not sure how the bus works? `gt:agents-talk`. Everything needed to *run* a handoff is below.

## Modes

| Invocation | Who drives | Blocks the main turn? |
|---|---|---|
| `/gt:handoff-to-codex <task>` (default) | a `genesis-tools:agent-driver` subagent, spawned in the background | no |
| `/gt:handoff-to-codex --inline <task>` | this session, via background Bash + Monitor | no |
| `/gt:handoff-to-codex --inline --wait <task>` | this session, blocking until `turn.completed` | yes |

**Default to the driver subagent.** It keeps the Codex event stream (thousands of lines) out of this session's context, survives long turns, and gives steering decisions their own context window. Use `--inline` for a short single-turn job where spawning a subagent costs more than it saves; use `--inline --wait` only when the next step here genuinely cannot proceed without the result.

Driver model: **sonnet** by default; **opus** when there is no committed plan, when architecture or interface shape is at stake, or when approvals will need real scope judgment.

Spawning the driver (after §1's brief is written and `tools agents login --agent-main --agent-name lead` is running in the background):

```
Agent(
  subagent_type: "genesis-tools:agent-driver",
  model: "sonnet",              // or "opus" per above
  run_in_background: true,
  prompt: "BACKEND: codex\nNAME: <task>\nCWD: <abs path>\nBRIEF_FILE: /tmp/codex-<task>-brief.md\nWRITE_POLICY: ask\nVERIFY_CMD: <command + expected output>\nSCOPE: <paths the worker may touch>\nESCALATE: <what must come back to the human>"
)
```

The driver reports back on the bus as `driver_<task>` and ends with a `VERDICT:` message; keep working until it arrives.

## 1. Readiness gate

Do not spawn until all four hold:

1. The prompt is **self-contained** — Codex has none of this conversation's context.
2. A **verification command** is named, with its expected observable output.
3. **Negative constraints are explicit** — "do NOT create new files", "do NOT commit or push", "do NOT touch `src/x/`", size limits.
4. **Checkpoints are named** (§ Checkpoint contract).

Write the prompt to a file and pass `--prompt-file`. Inline `--prompt` breaks on embedded quotes, backticks, and `$(...)`.

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
| omitted / `deny` | read-only | none possible | reviewers, investigations, second opinions |
| `ask` | workspace-write | untrusted → forwarded to `lead` | **default for implementation** |
| `allow` | workspace-write | never prompts | tightly bounded, disposable, or worktree-isolated work only |

Other flags: `--model` / `--effort`, `--home` (CODEX_HOME override), `--mode review|task`, `--writable-root <path...>`, `--session <id>` when `CLAUDE_CODE_SESSION_ID` can't be discovered, `--no-agents` to disable the bus (don't — the bus is the point).

Sessions land in `~/.genesis-tools/codex/sessions/<name>.*` (`.jsonl` event log, `.meta.json`, `.daemon.log`). Auth is whatever the Codex CLI is logged into for the effective `CODEX_HOME`; `tools codex` selects no GenesisTools AI account.

The session auto-registers on the bus as `codex_<name>`. **Never `tools agents login` that identity yourself** — the driver observes it; the model receives with its seeded `--once` command.

## 3. Checkpoint contract (state it in the brief, every time)

Codex presses on by default. The brief must say where it stops. Include this block verbatim, filled in:

```markdown
## Stop and report — do not continue past these
- After <first milestone>: report what changed + the verify output, then WAIT for a reply.
- Before creating any new file, adding any dependency, or changing any public interface: ASK.
- Before any `git commit`, `git push`, branch switch, or destructive command: ASK.
- If the verify command fails twice in a row: STOP and report both failures. Do not keep patching.
- If the task turns out to need work outside <declared scope>: STOP and report the gap.
Report with: tools agents message --from codex_<name> --to lead --body '<text>'
Check for replies with: tools agents login --agent-name codex_<name> --once
```

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

Repeat the negative constraints in every steering message — the correction is what the model attends to now.

## 5. Approvals

With `--write ask`, out-of-policy commands and file changes pause and arrive on the bus as `approval_request` messages to `lead`:

```bash
tools codex approve --name <task> --request <id>
tools codex deny    --name <task> --request <id>
```

Driver authority: **approve autonomously** only when the action is inside the declared writable roots and inside the declared task scope. **Escalate to the human** for anything that expands scope, adds a dependency, touches git history, or leaves the declared paths.

Compact receiver stream for the orchestrator:

```bash
tools agents login --agent-main --agent-name lead --kinds message,error,approval_request
```

Waking a possibly-idle peer needs both channels: `tools agents message ...` (durable payload) **then** a harness `SendMessage` nudge. Agents-channel traffic alone does not re-invoke an idle subagent.

## 6. Verify, then integrate

Never trust the worker's self-report. After the turn completes:

1. Run the verification command yourself.
2. `git diff` — read it, don't skim it.
3. Only then integrate, commit, or hand back.

Then `tools codex stop --name <task>`.

## Receiving end — read this if you ARE the Codex worker

You are a worker inside a Claude Code agent swarm. The orchestrator is `lead`.

1. Your first action is to report in on the bus. It is not optional:
   `tools agents message --from codex_<yourname> --to lead --body 'received; starting <task>'`
2. Check for steering between meaningful steps:
   `tools agents login --agent-name codex_<yourname> --once`
3. Honor the **Stop and report** block in your brief literally. Stopping to ask is the expected behavior, not a failure.
4. Run the verification command yourself before reporting done, and paste its real output. Never report a green state you did not observe.
5. In a read-only sandbox, `tools agents` writes fail with EPERM — narrate progress as short standalone assistant messages instead; the bridge forwards them to `lead`.

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
- `--ignore-user-config` — otherwise it loads `~/.codex` config and skills (~450k wasted input tokens) and fires the user's notification hooks.
- `-o <file>` — read the answer from this file, never by parsing the stream.
- Never `--ephemeral` if you might resume.

Wait on event types only (`error:` appears in normal red-test output):

```bash
SECONDS=0; until rg -q '"type":"turn.completed"|"type":"turn.failed"' /tmp/codex-<task>.log 2>/dev/null || [ $SECONDS -ge 600 ]; do sleep 5; done
```

Resume: `command codex exec resume <thread_id> --json --skip-git-repo-check -c sandbox_mode="workspace-write" -o /tmp/codex-<task>-steer.md "<correction>"`. `--skip-git-repo-check` is **not** inherited; `--sandbox`/`--cd` are **not** re-applied on resume — pass sandbox as `-c sandbox_mode=`.
