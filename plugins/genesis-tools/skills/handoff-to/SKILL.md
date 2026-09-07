---
name: handoff-to
description: Offload work to another model or agent, and pick which one (Codex/GPT-6 Astra and GPT-5.6, grok, sonnet, opus, fable). Triggers on "give this to codex", "let codex implement this", "run codex on this", "codex subagent", "tools codex", "give this to grok", "run grok on this", "offload this", "hand this off", "second opinion from GPT", "second opinion from grok", "parallelize this across models", "which model should do X" — and use it proactively whenever a bounded, well-specified task should go to a worker while this session reviews.
---

# handoff-to — pick the worker, then dispatch

This file answers two questions: **who does it**, and **is it ready to leave**. The per-backend mechanics live in reference files, so you load only the one you need.

| Worker | Dispatch via |
|---|---|
| Codex / GPT-6 Astra / GPT-5.6 | Read `references/codex.md` — **mandatory**; never hand-roll `tools codex` or `codex exec` from memory |
| Grok / grok-4.x | Read `references/grok.md` — never hand-roll a bare `grok -p` (isolation and safety flags are non-obvious) |
| sonnet / opus / fable, in this session | `Agent` tool with `model:`, or `Workflow` for fan-out — **the default for Claude work** |
| Claude on a **different account**, or a headless `claude -p` run | Read `references/claude.md` — `tools claude exec -a <account>`, never interactive `tools claude run` |

The reference files sit next to this one, at `${CLAUDE_PLUGIN_ROOT}/skills/handoff-to/references/`. Claude Code substitutes that placeholder at load time; it is not a shell variable. If you see it unsubstituted, build the path from the "Base directory for this skill" line printed when this skill loaded. If both fail, Read `plugins/genesis-tools/skills/handoff-to/references/<backend>.md` in the GenesisTools repo.

⚠️ **Picking Claude does not automatically mean `references/claude.md`.** A subagent via the `Agent` tool is cheaper and keeps the harness. Load that reference only when the point is the *account* (spreading usage, running under a subscription this session is not on) or the *separate process* (a long headless run that must not eat this session's context).

## Model rankings

Higher = better. **Cost** = what is actually paid (not list price). **Intelligence** = how hard a problem you can hand it unsupervised. **Taste** = UI/UX, code quality, API design, copy.

| model | cost | intelligence | taste |
|---|---|---|---|
| gpt-6-astra | unscored | unscored | unscored |
| gpt-5.6-sol | 9 | 8 | 5 |
| gpt-5.6-terra | 9 | 7 | 5 |
| gpt-5.6-luna | unscored | unscored | unscored |
| grok-4.6 | 7 | 6 | 4 |
| sonnet-5 | 5 | 5 | 7 |
| opus-5 | 4 | 8 | 8 |
| fable-5-1 | 2 | 9 | 9 |
| fable-5 | 2 | 9 | 9 |

Astra and Luna have no measured local numeric scores here. Use the Codex task table below;
subscription quota and API-equivalent cost are different measures. Do not infer that a worker is free.

grok-4.6 scores are provisional (added 2026-08-26, one session of evidence); re-rank after real use.

How to apply:

- Defaults, not limits. Standing permission to override: if a cheaper model's output misses the bar, rerun with a smarter one without asking. **Judge the output, not the price tag. Escalating costs less than shipping mediocre work.**
- Cost is a tie-breaker only. When axes conflict for anything that ships: intelligence > taste > cost.
- Codex mechanical work uses Luna, bounded exploration uses Terra, and implementation requiring judgment uses Sol. Use Astra for the difficult cases described below.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Claude plan/implementation reviews: fable-5-1 (fable-5 is the same tier) or opus-5. Codex code-review workers use gpt-5.6-sol unless the user requests another model.
- Never Haiku for work that ships (thin wrapper/relay agents are fine).
- GPT-6 Astra and GPT-5.6 Sol/Terra/Luna use native subagent tools when exposed by the host, or the Codex CLI otherwise. Grok-4.6 uses the `grok` CLI (metered `XAI_API_KEY`). Claude models use `Agent`/`Workflow`, or `tools claude exec` for another account (`references/claude.md`).
- **Spreading load across Claude accounts is a billing decision, not a quality one.** `references/claude.md` changes who pays; it does not change how good the model is. Pick the model first from this table, then decide which account runs it.
- Grok's niche: cheap parallel second opinions and bounded fix-it work in a scratch dir or worktree. Its harness has no mid-turn approvals, so route work needing supervised writes in a live checkout to Codex instead.

## Codex model selection

Follow the user's explicit model choice and live AGENTS.md routing first.
Set a model explicitly; an Astra parent should not make every worker Astra.

| Task | Model | Default effort |
|---|---|---|
| Mechanical extraction, formatting, simple lookups, or a fully specified small edit | `gpt-5.6-luna` | low |
| Bounded repository exploration, tracing an established call path, or gathering evidence | `gpt-5.6-terra` | medium |
| Normal implementation, reproducible debugging, and code review | `gpt-5.6-sol` | medium; high for complex reviews |
| Difficult cross-system reasoning, ambiguous failures, or an evidence-backed escalation | `gpt-6-astra` | high |

Astra is the escalation tier, not the default for exploration. Keep the cheaper worker's
findings and failed verification when escalating. If a model is unavailable, disclose the
fallback and select the nearest suitable tier instead of silently choosing Astra.

Use native subagent model selection when the current host supports the requested model.
If an override cannot be combined with a full-history fork, use `fork_turns: "none"`
with a self-contained brief, or the smallest supported partial-history fork.
For a separate Codex CLI worker, read `references/codex.md` and use `--model` and `--effort`.

`review_model` controls built-in Codex review. It does not select arbitrary review
subagents, so explicitly choose Sol for those. Internal permission Auto Review is a
separate mechanism and is not selected through this routing table.

## Task routing

| Task | Route |
|---|---|
| Design decisions, naming, interface shape | Stay here — decide first, then hand the decision down |
| Spec'd mechanical implementation, boilerplate, big renames | Codex |
| Test writing against a fixed contract | Codex |
| Second-opinion code review | Codex, read-only only if the deliverable is inline. A vault note or report file is a writable job. See § Read-only tax |
| Ambiguous / underspecified work | Stay here until spec'd, THEN offload |
| Cross-file refactor requiring judgment calls | Stay here, use Sol for a bounded implementation, or Astra for difficult cross-system reasoning; opus/fable remain Claude options |
| Long-running bounded sweep while this session reviews | Codex, parallel drivers with `isolation: "worktree"` |

Rule of thumb: **taste stays here, precision ships out.**

## Readiness gate (applies to every route)

Do not dispatch until all five hold. If any fails, the task is not ready to offload — finish specifying it first.

1. The prompt is **self-contained**: the worker has none of this conversation's context.
2. There is a **verification command** the worker can run itself, with the expected observable output stated — **and the worker's sandbox can actually run it** (see § Read-only tax).
3. **Negative constraints are explicit** — "do NOT create new files", "do NOT commit", "do NOT touch `src/x/`", size limits. Workers obey these reliably when spelled out, and not otherwise.
4. **Checkpoints are named** — the points at which the worker must stop and report instead of pressing on. The generic contract (honour Stop-and-report, real verify output only, two failed verifies means stop, paths character for character, the `RESULT/AT/CHANGED/VERIFY/OPEN` report lines) is injected by every harness from `src/utils/worker/contract.ts`; the brief supplies only the task-specific milestone and negative constraints.
5. **The deliverable matches the sandbox.** A `--write deny` / `--readonly` worker cannot write a file. If the deliverable is a path on disk (Obsidian vault note, report.md, anything `mkdir`/`cp` would create), do **not** dispatch deny. `--writable-root` under deny does **not** make that write work (Codex, 2026-08-31 12:15: `apply_patch` still rejected with "writing is blocked by read-only sandbox"). Spawn recipe: `references/codex.md` § File deliverables. Inline chat text may use deny.

## 🛑 Read-only tax — decide this before you dispatch

"Read-only" does not mean "everything except editing your code". On both backends it also blocks the worker from **writing its own report** and from **running tests**. Observed on a real Codex review handoff (2026-08-27): the worker could not write the report file it was asked for, and two attempts to run Jest died on a read-only temp dir. It executed zero test assertions and still produced a confident "Test quality" section.

So when you route a review:

- **File deliverable** (vault, report.md, any path): not a deny job. Do not pass `--write deny` or grok `--readonly`. Codex recipe in `references/codex.md` § File deliverables. Grok: default jail with `--cwd` at the note folder, or write `/tmp` and copy.
- **Inline deliverable**: say so in the brief. Do not ask the worker to write a path.
- Expect **no executed verification** under deny unless you granted writable temp/cache dirs for the test runner. That is all `--writable-root` is for under deny. It is not a report-file hatch.
- **Any claim a read-only reviewer makes about test or runtime behavior is inference, not observation.** Ask it for the command it ran and that command's real output. If there is none, say so when you relay the finding.

Per-backend spawn flags live in the reference files. Do not invent a deny+writable-root hybrid for a vault write.

## Driver-model choice (when the route is Codex or Grok)

The driver is the Claude subagent that owns the worker session (`genesis-tools:agent-driver`).

- **sonnet** — default. The driver relays, watches, and approves inside declared bounds.
- **opus** — when there is no committed plan, when architecture or interface shape is at stake, or when approvals will require real judgment about scope.

⚠️ **Never block indefinitely on the driver's `VERDICT:`.** It has been observed ending a session without sending one, and relaying stale state after the work had finished. Poll the session yourself (`tools codex status` / `tools codex read`, or `tools grok sessions` / `tools grok read`) and treat that as the authority over the driver's prose. Details in the reference files.

## Never trust the self-report

Whatever the worker says it did, re-run the verification command yourself and read the diff before integrating.
