---
name: handoff-to
description: Offload work to another model or agent, and pick which one (Codex/gpt-5.x, grok, sonnet, opus, fable). Triggers on "give this to codex", "give this to grok", "run grok on this", "offload this", "hand this off", "second opinion from GPT", "second opinion from grok", "parallelize this across models", "which model should do X" — and use it proactively whenever a bounded, well-specified task should go to a worker while this session reviews.
---

# handoff-to — pick the worker, then dispatch

This skill only answers two questions: **who does it**, and **is it ready to leave**. The mechanics of driving each worker live elsewhere:

| Worker | Dispatch via |
|---|---|
| Codex / gpt-5.x | `gt:handoff-to-codex` — **mandatory**: invoke that skill; never hand-roll `tools codex` or `codex exec` from here |
| Grok / grok-4.x | § Grok mechanics below — never hand-roll a bare `grok -p` (isolation and safety flags are non-obvious) |
| sonnet / opus / fable | `Agent` tool with `model:`, or `Workflow` for fan-out |

## Model rankings

Higher = better. **Cost** = what is actually paid (not list price). **Intelligence** = how hard a problem you can hand it unsupervised. **Taste** = UI/UX, code quality, API design, copy.

| model | cost | intelligence | taste |
|---|---|---|---|
| gpt-5.5 | 9 | 8 | 5 |
| grok-4.6 | 7 | 6 | 4 |
| sonnet-5 | 5 | 5 | 7 |
| opus-4.8 | 4 | 7 | 8 |
| fable-5 | 2 | 9 | 9 |

grok-4.6 scores are provisional (added 2026-08-26, one session of evidence); re-rank after real use.

How to apply:

- Defaults, not limits. Standing permission to override: if a cheaper model's output misses the bar, rerun with a smarter one without asking. **Judge the output, not the price tag. Escalating costs less than shipping mediocre work.**
- Cost is a tie-breaker only. When axes conflict for anything that ships: intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 — effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent perspective.
- Never Haiku for work that ships (thin wrapper/relay agents are fine).
- gpt-5.5 is only reachable through the Codex CLI; grok-4.6 only through the `grok` CLI (metered `XAI_API_KEY`). Claude models run via the `Agent`/`Workflow` `model` parameter.
- Grok's niche: cheap parallel second opinions and bounded fix-it work in a scratch dir or worktree. Its harness has no mid-turn approvals (§ Grok mechanics, Safety dial), so route work needing supervised writes in a live checkout to Codex instead.

## Task routing

| Task | Route |
|---|---|
| Design decisions, naming, interface shape | Stay here — decide first, then hand the decision down |
| Spec'd mechanical implementation, boilerplate, big renames | Codex |
| Test writing against a fixed contract | Codex |
| Second-opinion code review | Codex, read-only |
| Ambiguous / underspecified work | Stay here until spec'd, THEN offload |
| Cross-file refactor requiring judgment calls | Stay here, or opus/fable subagent |
| Long-running bounded sweep while this session reviews | Codex, parallel drivers with `isolation: "worktree"` |

Rule of thumb: **taste stays here, precision ships out.**

## Readiness gate (applies to every route)

Do not dispatch until all four hold. If any fails, the task is not ready to offload — finish specifying it first.

1. The prompt is **self-contained**: the worker has none of this conversation's context.
2. There is a **verification command** the worker can run itself, with the expected observable output stated.
3. **Negative constraints are explicit** — "do NOT create new files", "do NOT commit", "do NOT touch `src/x/`", size limits. Workers obey these reliably when spelled out, and not otherwise.
4. **Checkpoints are named** — the points at which the worker must stop and report instead of pressing on (see `gt:handoff-to-codex` § Checkpoint contract).

## Driver-model choice (when the route is Codex)

The driver is the Claude subagent that owns the Codex session (`genesis-tools:agent-driver`).

- **sonnet** — default. The driver relays, watches, and approves inside declared bounds.
- **opus** — when there is no committed plan, when architecture or interface shape is at stake, or when approvals will require real judgment about scope.

## Never trust the self-report

Whatever the worker says it did, re-run the verification command yourself and read the diff before integrating.

---

# Grok mechanics (grok-4.6 via `tools grok`)

The harness is **`tools grok`** (`src/grok/`) — the grok counterpart of `tools codex`. It drives xAI's `grok` CLI as a headless worker: you architect and verify, the worker implements. Unlike Codex there is **no daemon, no bus auto-registration, and no approval channel**. The drive model is a **resume loop**: each turn is one blocking invocation; steering happens *between* turns. Every fact below was verified against grok CLI 1.0.3 on 2026-08-26.

## Drive loop

```bash
tools grok run   --name <task> --cwd <abs project path> --prompt-file /tmp/grok-<task>-brief.md [--readonly]
tools grok steer --name <task> --prompt '<correction + the negative constraints restated>'
tools grok read  --name <task> [--turn N]
tools grok sessions
```

- **`run` and `steer` block for the whole turn (minutes).** Run them with Bash `run_in_background: true` and wait for the completion notification. A foreground call is killed at the Bash timeout cap mid-turn.
- Write the brief to a file and pass `--prompt-file`; inline `--prompt` breaks on backticks and `$(...)`.
- On completion the harness prints the worker's report (stdout) and its tool calls (stderr), and **exits 1 when the turn died mid-flight** (the raw grok CLI exits 0 even then). Turn transcripts live at `~/.genesis-tools/grok/sessions/<task>.turn<N>.jsonl` (+ `.err`); `tools grok read` re-prints them.
- To abort a running turn, kill the grok process; the session survives and the next `steer` resumes it.
- Auth is `XAI_API_KEY` from the environment. If a turn reports a login problem, stop and report — never run `grok login` for the user.

## What the harness bakes in (do not hand-roll bare `grok`)

- **Isolation.** Workers run with `GROK_HOME=~/.genesis-tools/grok/worker-home` plus the `GROK_CLAUDE_*_ENABLED=0` toggles. Without them the worker loads the user's `~/.claude/CLAUDE.md`, permission settings, and ~200 personal skills — and *acts* on them (verified: an un-isolated worker ran the user's personal `tools say` ritual mid-task). A `CLAUDE.md` in the worker's own `--cwd` project still loads (usually wanted); use a scratch dir or worktree when not.
- **Session bookkeeping.** The session uuid and cwd live in `~/.genesis-tools/grok/sessions/<task>.meta.json`; grok keys sessions by cwd, and `steer` resumes with the identical cwd automatically.
- **Sticky `--readonly`.** The raw grok CLI forgets `--tools` on every `--resume` (verified: a read-only session edited a file on its first unflagged resume). The harness re-arms the allowlist on each steer; `--writable` on a steer switches back deliberately.
- **Direct binary spawn.** No shell in the path, so the user's zsh `grok` wrapper function (proxy env injection) cannot interfere.

## Safety dial

| Intent | How | Verified behavior |
|---|---|---|
| read-only (review, second opinion) | `--readonly` | Worker gets only `read_file,list_dir,grep` — it physically lacks edit and terminal tools; edit attempts are denied and files stay untouched |
| implementation (default) | no flag | Headless default is **Auto mode — a project jail**: edits and commands inside `--cwd` run without approval; any write outside the project is blocked with a denial message the worker sees and reports |
| full trust | not exposed | On purpose. For risky work, give the worker a disposable worktree and keep the default jail |

🛑 Never reach past the harness for safety flags — two raw-grok flags LOOK like safety dials and are not (both verified): `--permission-mode plan` does not restrict a headless run (the worker edited a file under it), and `--disallowed-tools` silently refuses to remove `run_terminal_command` (the worker appended via the shell instead).

There are no mid-turn approvals. The Auto-mode jail plus the checkpoint contract below are the only brakes.

## Checkpoints

The readiness gate above applies unchanged. Because there are no approvals, slice the task so each turn ends at a checkpoint. Include in the brief, filled in:

```markdown
## Stop and report — do not continue past these
- This turn: <single milestone> ONLY. Report what changed + the verify output, then STOP; the next instruction arrives as a new turn.
- Do NOT create new files, do NOT commit or push, do NOT touch <paths>.
- If the verify command fails twice in a row: STOP and report both outputs. Do not keep patching.
```

Grok honors diagnose-only and touch-only-X constraints reliably when they are spelled out (verified across a 3-turn bug-fix session). Restate the negative constraints in every steering message.

## Verify, then integrate

Never trust the self-report (see above). Run the verification command yourself, read `git diff` in the worker's cwd, only then integrate. There is no daemon to tear down — when the last turn ends, the handoff is over.

## Driver mode (Grok)

For a long grok handoff, spawn a `genesis-tools:agent-driver` subagent with `BACKEND: grok` in its prompt (sonnet by default) so the resume loop and its logs stay out of this session. The driver runs the run/steer/read/verify loop itself and reports a `VERDICT:` — see that agent's grok section.

The `tools agents` bus is optional here: the transcript already lands in the turn logs. Add bus reporting (per `gt:agents-talk`) only when the worker is part of a multi-agent swarm — and then know its limits, verified in a live 5-agent chain probe (2026-08-26):

- A grok worker **receives** bus mail fine (blocking `tools agents login --once` inside its turn works, including session auto-detection from the inherited env).
- Its **sends are unreliable under the Auto-mode jail**: the policy layer auto-cancelled the second `tools agents` command in each observed turn ("User cancelled the execution for tool `run_terminal_command`"), and the worker **reported the send as successful anyway**. Budget ONE bus send per turn, split extra reports across steered turns, and confirm every hop by watching the feed from the lead side — never from the worker's claim. A steered retry of a cancelled send succeeded unchanged.
