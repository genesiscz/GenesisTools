# Grok mechanics (grok-4.6 via `tools grok`)

Read this after `gt:handoff-to` has picked Grok and the readiness gate has passed.

The harness is **`tools grok`** (`src/grok/`) — the grok counterpart of `tools codex`. It drives xAI's `grok` CLI as a headless worker: you architect and verify, the worker implements. Unlike Codex there is **no daemon, no bus auto-registration, and no approval channel**. The drive model is a **resume loop**: each turn is one blocking invocation; steering happens *between* turns. Every fact below was verified against grok CLI 1.0.3 on 2026-08-26.

## Drive loop

```bash
tools grok run    --name <task> --cwd <abs project path> --prompt-file <brief path> [--readonly] [--no-skills] [--no-rules]
tools grok steer  --name <task> --prompt-file <correction file>   # preferred
tools grok steer  --name <task> --prompt '<correction + the negative constraints restated>'
tools grok read   --name <task> [--turn N] [--format compact|json|jsonl|events|raw] [--thoughts none|short|full]
tools grok tail   --name <task> [--format compact]   # follow the running turn; exits when the turn ends
tools grok status --name <task>      # metadata + whether a turn is running right now
tools grok stop   --name <task>      # kill the running turn; the session survives, steer resumes it
tools grok sessions
```

`--format` is the one transcript door every backend shares (`src/utils/ai/transcripts/door.ts`; `tools ai sessions tail <task> --provider grok` is the same thing without the backend prefix). `compact` is the agent-friendly view: one numbered block per model call, thoughts shortened to one line, tool results folded into the call line, a totals footer, and a `--offset` hint for the next window. `jsonl` streams one JSON turn per line, `events` is the shared worker-event vocabulary (`src/utils/worker/events.ts`, deltas already folded), `raw` is the CLI's own NDJSON. What this backend can and cannot do is declared in `WORKER_CAPABILITIES.grok` (`src/utils/worker/capabilities.ts`); a verb it lacks (approve, deny) errors naming that entry.

- **`run` and `steer` block for the whole turn (minutes).** Run them with Bash `run_in_background: true` and wait for the completion notification. A foreground call is killed at the Bash timeout cap mid-turn.
- Write the brief to a file (session scratchpad) and pass `--prompt-file`. Inside single quotes a backtick and `$(...)` stay literal, so those are safe; what breaks is an **apostrophe** in the brief, which closes the quote and leaves the shell parsing the rest as arguments. A file has no quoting rules at all.
- **`steer` takes `--prompt-file` too**, and should use it for the same reason. A steering message is prose restating constraints, so it is *more* likely to contain an apostrophe than the original brief.
- On completion the harness prints the worker's report (stdout) and its tool calls (stderr), and **exits 1 when the turn died mid-flight** (the raw grok CLI exits 0 even then).
- 🛑 **"The turn ended" is not "the task got done".** A worker that stops cleanly halfway prints the same success line and exits 0 as one that finished — the mid-flight check only catches a missing end event. Observed 2026-09-04: a worker ended turn 1 after writing its sweep script but before running it, and the untouched worktree was found by a separate grader, not by the harness. So the harness now prints a worktree delta after each writable turn:

  ```
  ● turn 2 changed 1 path(s); 1 dirty in total
  ▲ turn 1 changed NOTHING in <cwd> — the turn ended, but the task may be unfinished.
  ```

  Treat that warning as "steer it to continue", not as a failure. It is suppressed for `--readonly` sessions, which change nothing by design, and absent when `--cwd` is not a git repo or when you are replaying a past turn with `read` (a replay has no before/after snapshot to compare).
- **Slice the work per turn.** The checkpoint contract below is not optional politeness: one turn is one blocking invocation, and a brief that asks for recon plus a sweep plus verification plus a written report in a single turn is likely to end somewhere in the middle.
- Turn transcripts live at `~/.genesis-tools/grok/sessions/<task>.turn<N>.jsonl` (+ `.err`); `tools grok read` re-prints them.
- `--name` is the session handle: `run` refuses an existing name, so pick a fresh one per handoff and use `steer` for every later turn.
- To abort a running turn, kill it by its **session uuid**, which is on the child's command line as `--session-id` (first turn) or `--resume` (every later turn) and is unique to that session:

  ```bash
  uuid=$(tools json ~/.genesis-tools/grok/sessions/<task>.meta.json | rg -o '[0-9a-f-]{36}')
  pgrep -fl "$uuid"          # ALWAYS look first — confirm it is the one process you mean
  pkill -f "$uuid"
  ```

  Verified: the harness then reports `exit 143`, `died mid-flight`, and exits 1, while the session survives and the next `steer` resumes it normally.

  🛑 Do **not** `pkill -f "grok .*--cwd <path>"`. A cwd pattern matches every session running in that project, and `grok` is a common enough word to catch your own shell and editor.
- **Auth defaults to the user's subscription login** (`~/.grok/auth.json`, written by `grok login`) whenever that file exists: the harness drops `XAI_API_KEY` from the worker env and sets `GROK_AUTH_PATH` to the real login file, so refreshes never fork into a copy. Pass `--auth api-key` on `run` to bill the metered `XAI_API_KEY` team instead; the choice is stored in the session meta, so every `steer` reuses it. Why the default flipped (2026-09-04 18:20): the worker's `GROK_HOME` never holds a login, and the binary prefers an ambient `XAI_API_KEY` over its OAuth file, so five planners silently burned API credits and died on a 403 `used all available credits` while the subscription sat idle. If a turn reports a login problem, stop and report — never run `grok login` for the user.

## What the harness bakes in (do not hand-roll bare `grok`)

- **Surfaces on, side effects off.** Workers run with `GROK_HOME=~/.genesis-tools/grok/worker-home`; hooks, MCP servers and session pickup from `~/.claude` are off unconditionally. The user's personal skills and rules are ON by default (decided 2026-09-04: a worker that knows them does better work) and `--no-skills` / `--no-rules` opt out, sticky across steers. Because the personal rules include interactive rituals, every turn carries the shared contract as `--rules` (`src/utils/worker/contract.ts`), which tells the worker those rituals (`tools say`, spoken summaries, asking the user) do not apply to it. Before 2026-09-04 the toggles were meant to block everything and did not: grok scans `~/.agents/skills` against the real `$HOME` with no toggle, so the "isolated" planner read the user's `best-skill` before its own brief; `--no-skills` now handles that tier through a `[skills] ignore` block in the worker home's `config.toml`. Project-local configuration in the worker's own `--cwd` always loads — `CLAUDE.md`, and any `.grok/` config the repo carries (MCP servers, hooks, permission rules). `GROK_HOME` redirects *user* state only, never the target repo's; point `--cwd` at a scratch dir or a worktree when that is not what you want.
- **Session bookkeeping.** The session uuid and cwd live in `~/.genesis-tools/grok/sessions/<task>.meta.json`; grok keys sessions by cwd, and `steer` resumes with the identical cwd automatically.
- **Sticky `--readonly`.** The raw grok CLI forgets `--tools` on every `--resume` (verified: a read-only session edited a file on its first unflagged resume). The harness re-arms the allowlist on every steer — verified: an unflagged steer of a read-only session still had only `read_file,list_dir,grep` and left the target file untouched. `--writable` on a steer deliberately switches back (verified: write tools returned, the edit landed, and `sessions` then shows the session as `jail`).
- **A per-handoff worker home** via `--worker-home <path>` when running handoffs in parallel (verified: grok populated the override directory instead of the default one). Keep it constant for the whole handoff — grok keys sessions by cwd inside that home. ⚠️ It moves the worker's own state, **not** the session records: those stay under `~/.genesis-tools/grok/sessions/` so `tools grok sessions` lists every worker, so two runs sharing a `--name` share one record whatever their home, and `run` refuses the second.
- **Direct binary spawn.** No shell in the path, so the user's zsh `grok` wrapper function (proxy env injection) cannot interfere.

## Safety dial

| Intent | How | Verified behavior |
|---|---|---|
| read-only (review, second opinion) | `--readonly` | Worker gets only `read_file,list_dir,grep` — it physically lacks edit and terminal tools; edit attempts are denied and files stay untouched |
| implementation (default) | no flag | Headless default is **Auto mode — a project jail**: edits and commands inside `--cwd` run without approval; any write outside the project is blocked with a denial message the worker sees and reports |
| full trust | not exposed | On purpose. For risky work, give the worker a disposable worktree and keep the default jail |

🛑 Never reach past the harness for safety flags — two raw-grok flags LOOK like safety dials and are not (both verified): `--permission-mode plan` does not restrict a headless run (the worker edited a file under it), and `--disallowed-tools` silently refuses to remove `run_terminal_command` (the worker appended via the shell instead).

There are no mid-turn approvals. The Auto-mode jail plus the checkpoint contract below are the only brakes.

🛑 **A dispatch the user did not ask for is `--readonly`.** The skill triggers proactively, and the default mode edits and runs commands inside `--cwd` with no confirmation. So when *you* decided to hand the task off, pass `--readonly`, or give the worker a disposable worktree (`git worktree add`) that is not the user's live checkout. A writable run against a real working tree needs the user to have asked for the handoff, or to have said yes to it. Being inside the project jail is not consent: the jail only stops writes *outside* `--cwd`, and everything the user cares about is inside it.

### 🛑 `--readonly` costs more than editing

The read-only worker gets `read_file,list_dir,grep` and **no terminal tool at all**. That means it cannot write its own report file and cannot run a test suite or any verification command. The same trap bites Codex reviewers (see `references/codex.md` § What read-only mode actually costs you), and here it is stricter, because there is no `--writable-root` escape hatch.

So for a read-only grok review, plan for it up front:

- If the deliverable is a file (Obsidian vault, report.md), do **not** pass `--readonly`. Use the default jail with `--cwd` at the note folder, or write `/tmp` and let the orchestrator copy. Same class of miss as Codex `--write deny` on 2026-08-31.
- Make **inline output the deliverable** only when the review is actually inline. Say so in the brief; do not ask for a file.
- Expect **zero executed verification**. If the worker reports on test quality or runtime behavior, it inferred that from reading. Say so when you relay it, or re-run the claim yourself.
- If the review genuinely needs to run something, do not reach for `--writable`. Give the worker a disposable worktree and let it run in the default Auto-mode jail there.

## Checkpoints

The readiness gate in `gt:handoff-to` applies unchanged. Because there are no approvals, slice the task so each turn ends at a checkpoint. The generic contract is injected by the harness on every turn (`src/utils/worker/contract.ts`, passed as `--rules`): honour the brief's Stop-and-report block, never report a verification you did not run, stop after two failed verifies, copy paths character for character, and end the final message with `RESULT: / AT: / CHANGED: / VERIFY: / OPEN:`. The brief supplies only what is task-specific, filled in:

```markdown
## Stop and report — do not continue past these
- This turn: <single milestone> ONLY. Report what changed + the verify output, then STOP; the next instruction arrives as a new turn.
- Do NOT create new files, do NOT commit or push, do NOT touch <paths>.
```

Grok honors diagnose-only and touch-only-X constraints reliably when they are spelled out (verified across a 3-turn bug-fix session). Restate the negative constraints in every steering message. The finished-turn printer puts the worker's `RESULT:` line on its status line, so `tools grok run … 2>&1 | head -1` tells you `done`, `stopped-at-checkpoint`, `blocked` or `failed` without reading the report.

## What the raw CLI still has that the harness does not

The harness already consumes `--output-format streaming-json` — every turn log is flat NDJSON (`{"type":"text","data":…}`; despite the CLI help, it is NOT ACP-nested), which is what `read --format …` renders from: inside one model call the order is thought deltas, text deltas, one `usage` line, then that call's tool calls, and results arrive whenever the tool finishes. Two raw-CLI capabilities remain unwired:

- **`--json-schema '<schema>'`** constrains the final answer to a validated shape, and `streaming-messages-json` emits the Anthropic Messages wire format instead.
- **A leader process.** `grok leader list | info | kill` manages running leader processes over a socket at `~/.grok/leader.sock` (`--leader-socket` overrides it). This is the closest grok analog to the Codex app-server daemon.

Reaching for either means going around the harness and losing the isolation and sticky-`--readonly` guarantees above. Do not do that casually. Flag it as a harness gap instead.

## Verify, then integrate

Never trust the self-report. Run the verification command yourself, read `git diff` in the worker's cwd, only then integrate. There is no daemon to tear down — when the last turn ends, the handoff is over.

## Driver mode (Grok)

For a long grok handoff, spawn a `genesis-tools:agent-driver` subagent with `BACKEND: grok` in its prompt (sonnet by default) so the resume loop and its logs stay out of this session. The driver runs the run/steer/read/verify loop itself and reports a `VERDICT:`.

⚠️ **Do not block on that VERDICT alone.** The Codex driver has been observed ending a session without ever sending one (`references/codex.md` § The driver's VERDICT is not guaranteed). Grok has no daemon to poll, so the equivalent authority is the turn transcript: `tools grok sessions` for state and `tools grok read --name <task>` for the worker's actual last answer. Read those before concluding the handoff stalled, and distrust any driver relay that contradicts them.

The `tools agents` bus is optional here: the transcript already lands in the turn logs. Add bus reporting (per `gt:agents-talk`) only when the worker is part of a multi-agent swarm — and then know its limits, verified in a live 5-agent chain probe (2026-08-26):

- **Pass `--session <id>` explicitly** in every `tools agents` command you put in a grok brief. Since 2026-08-29 `tools grok run` also writes `$GT_RENDEZVOUS_SESSION` into the worker environment, so auto-detection resolves the parent's swarm on its own — but the explicit flag is still what the brief should say, because it survives a worker that shells out through something that strips the environment.
- A grok worker **receives** bus mail fine: a blocking `tools agents login --agent-name <name> --once --session <id>` inside its turn delivered the message.
- Its **sends are unreliable**: in both observed turns the *second* `tools agents` command of the turn was cancelled by grok's own permission layer ("User cancelled the execution for tool `run_terminal_command`"), while the first succeeded. The cause was not isolated — treat it as an observation, not a rule. What matters: the worker **reported the cancelled send as successful anyway**. Budget ONE bus send per turn, split extra reports across steered turns, and confirm every hop by reading the feed from the lead side — never from the worker's claim. A steered retry of a cancelled send succeeded unchanged.
- **The worker's bus identity is not yours to choose.** A codex worker auto-registers as `codex_<name from --spawn>`; a grok worker has no auto-registration and uses whatever `--agent-name` its brief tells it to log in with. Naming a different identity in `--from` fails with "not registered". Write the brief's identity to match the spawn name exactly.
- The lead's own listener must be started durably, or it dies at the Bash call boundary — see `references/codex.md` § Start the lead's bus listener.
