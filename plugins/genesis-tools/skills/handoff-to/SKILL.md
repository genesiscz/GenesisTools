---
name: handoff-to
description: Offload work to another model or agent, and pick which one (Codex/gpt-5.x, sonnet, opus, fable). Triggers on "give this to codex", "offload this", "hand this off", "second opinion from GPT", "parallelize this across models", "which model should do X" — and use it proactively whenever a bounded, well-specified task should go to a worker while this session reviews.
---

# handoff-to — pick the worker, then dispatch

This skill only answers two questions: **who does it**, and **is it ready to leave**. The mechanics of driving each worker live elsewhere:

| Worker | Dispatch via |
|---|---|
| Codex / gpt-5.x | `gt:handoff-to-codex` — **mandatory**: invoke that skill; never hand-roll `tools codex` or `codex exec` from here |
| sonnet / opus / fable | `Agent` tool with `model:`, or `Workflow` for fan-out |

## Model rankings

Higher = better. **Cost** = what is actually paid (not list price). **Intelligence** = how hard a problem you can hand it unsupervised. **Taste** = UI/UX, code quality, API design, copy.

| model | cost | intelligence | taste |
|---|---|---|---|
| gpt-5.5 | 9 | 8 | 5 |
| sonnet-5 | 5 | 5 | 7 |
| opus-4.8 | 4 | 7 | 8 |
| fable-5 | 2 | 9 | 9 |

How to apply:

- Defaults, not limits. Standing permission to override: if a cheaper model's output misses the bar, rerun with a smarter one without asking. **Judge the output, not the price tag. Escalating costs less than shipping mediocre work.**
- Cost is a tie-breaker only. When axes conflict for anything that ships: intelligence > taste > cost.
- Bulk/mechanical work (clear-spec implementation, data analysis, migrations): gpt-5.5 — effectively free.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Reviews of plans/implementations: fable-5 or opus-4.8, optionally gpt-5.5 as an extra independent perspective.
- Never Haiku for work that ships (thin wrapper/relay agents are fine).
- gpt-5.5 is only reachable through the Codex CLI. Claude models run via the `Agent`/`Workflow` `model` parameter.

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
