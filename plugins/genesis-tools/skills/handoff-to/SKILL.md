---
name: handoff-to
description: Offload work to another model or agent, and pick which one (Codex/GPT-6 Astra, Sol and Luna, grok, sonnet, opus, fable). Triggers on "give this to codex", "let codex implement this", "run codex on this", "codex subagent", "tools codex", "give this to grok", "run grok on this", "offload this", "hand this off", "second opinion from GPT", "second opinion from grok", "parallelize this across models", "which model should do X" — and use it proactively whenever a bounded, well-specified task should go to a worker while this session reviews.
---

# handoff-to — pick the worker, then dispatch

This file answers two questions: **who does it**, and **is it ready to leave**. The per-backend mechanics live in reference files, so you load only the one you need.

| Worker | Dispatch via |
|---|---|
| Codex / GPT-6 Astra, Sol, Luna | Read `references/codex.md` — **mandatory**; never hand-roll `tools codex` or `codex exec` from memory |
| Grok / grok-4.x | Read `references/grok.md` — never hand-roll a bare `grok -p` (isolation and safety flags are non-obvious) |
| sonnet / opus / fable executed inside Claude Code | `Agent` with `model:`, or `Workflow` for fan-out — **the default when Claude Code is the host** |
| Claude executed from Codex, on a **different account**, or as headless `claude -p` | Read `references/claude.md` — a native Codex GPT subagent may drive `tools claude worker`, but `spawn_agent` itself does not select a Claude model |

The reference files sit next to this one, at `${CLAUDE_PLUGIN_ROOT}/skills/handoff-to/references/`. Claude Code substitutes that placeholder at load time; it is not a shell variable. If you see it unsubstituted, build the path from the "Base directory for this skill" line printed when this skill loaded. If both fail, Read `plugins/genesis-tools/skills/handoff-to/references/<backend>.md` in the GenesisTools repo.

⚠️ **Picking Claude does not automatically mean `references/claude.md` when Claude Code is the host.** Its `Agent` tool keeps the native harness. From Codex, however, native `spawn_agent` selects a Codex model; to execute Claude, use the separate process in `references/claude.md`. The native Codex subagent can still be the driver that spawns, steers, reads, and checks that Claude worker.

## Model rankings

Higher = better. **Cost** = what is actually paid (not list price). **Intelligence** = how hard a problem you can hand it unsupervised. **Taste** = UI/UX, code quality, API design, copy.

| model | cost | intelligence | taste |
|---|---|---|---|
| fable-5-1 | 2 | 10 | 9 |
| gpt-6-astra | 2 | 9 | 7 |
| opus-5-5 | 5 | 9 | 9 |
| gpt-6-sol | 8 | 8 | 6 |
| gpt-6-luna | 10 | 7 | 5 |
| grok-4.7 | 7 | 7 | 5 |
| sonnet-5 | 5 | 5 | 7 |

<!-- updated 2026-09-23: GPT-6 Sol/Luna, Opus 5.5 and grok-4.7 scored from launch benchmarks; opus-5, fable-5, gpt-5.6-* and grok-4.6 rows retired -->

List prices per MTok (input/output), from the vendor pages on 2026-09-23: fable-5-1 and gpt-6-astra
$10/$50, opus-5-5 $4/$20, gpt-6-sol $2/$10, gpt-6-luna $0.10/$0.50, grok-4.7 $2/$6, sonnet-5 $2/$10
(the introductory rate, permanent since 2026-08-10).
GPT-6 prompts above 272K input tokens bill 2x input and 1.5x output; grok-4.7 bills 2x above 200K.
Subscription quota and API-equivalent cost are different measures. Do not infer that a worker is free.

Launch benchmarks behind the scores (vendor-reported, different harnesses, so read them as tiers, not ranks):

- Terminal-Bench 4.0: opus-5-5 66.4%, gpt-6-astra 57.7%, fable-5-1 55.8%, grok-4.7 37.6%.
- DeepSWE v1.1: gpt-6-astra 74.1%, grok-4.7 71.0% (high), gpt-6-sol 68.8% (max), fable-5-1 67.4%, gpt-6-luna 66.6% (max).
- FrontierCode v1.1 Main: opus-5-5 54.4%, gpt-6-astra 53.3%, fable-5-1 50.3 to 50.9%.
- Humanity's Last Exam with tools: fable-5-1 65.0%, gpt-6-astra 57.2%. Artificial Analysis Coding Agent Index: fable-5-1 70, gpt-6-astra 67.

fable-5-1 keeps intelligence 10 for the hardest ambiguous reasoning; opus-5-5 matches or beats it on agentic
coding at 40% of the price, so it is the default Claude worker for work that ships. The grok-4.7 scores are
provisional (added 2026-09-23 from launch data only); re-rank after real use.

How to apply:

- Defaults, not limits. Standing permission to override: if a cheaper model's output misses the bar, rerun with a smarter one without asking. **Judge the output, not the price tag. Escalating costs less than shipping mediocre work.**
- Cost is a tie-breaker only. When axes conflict for anything that ships: intelligence > taste > cost.
- Codex mechanical work and bounded exploration use Luna, and implementation requiring judgment uses Sol. Use Astra for the difficult cases described below.
- Anything user-facing (UI, copy, API design) needs taste ≥ 7.
- Claude plan/implementation reviews: opus-5-5 by default, fable-5-1 when the problem needs the deepest reasoning. Codex code-review workers use gpt-6-sol unless the user requests another model.
- Never Haiku for work that ships (thin wrapper/relay agents are fine).
- GPT-6 Astra, Sol and Luna use native Codex collaboration when exposed by the host, or the Codex CLI otherwise. Codex native run aliases include Astra, Sol and Luna (Terra still maps to `gpt-5.6-terra`); see its reference for named-account launch. Grok supports subscription and explicit API-key worker auth as described in its reference. Claude models use Claude Code's `Agent`/`Workflow`, or the separate process in `references/claude.md`. A native Codex GPT subagent can drive that process, but remains the driver rather than the Claude execution model.
- **Spreading load across Claude accounts is a billing decision, not a quality one.** `references/claude.md` changes who pays; it does not change how good the model is. Pick the model first from this table, then decide which account runs it.
- Grok's niche: cheap parallel second opinions and bounded fix-it work in a scratch dir or worktree. Its harness has no mid-turn approvals, so route work needing supervised writes in a live checkout to Codex instead.

## Codex model selection

Follow the user's explicit model choice and live AGENTS.md routing first.
Set a model explicitly; an Astra parent should not make every worker Astra.

| Task | Model | Default effort |
|---|---|---|
| Mechanical extraction, formatting, simple lookups, or a fully specified small edit | `gpt-6-luna` | low |
| Bounded repository exploration, tracing an established call path, or gathering evidence | `gpt-6-luna` | medium |
| Normal implementation, reproducible debugging, and code review | `gpt-6-sol` | medium; high for complex reviews |
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

## Driver versus execution model

The **driver** owns the worker lifecycle: spawn, steer, read, status, approvals, and final verification. The **execution model** does the delegated task. Choose them separately.

- In Claude Code, a `genesis-tools:agent-driver` subagent normally drives external Codex, Grok, or Claude workers. Use sonnet by default; use opus when unplanned architecture or approval boundaries require more judgment.
- In Codex, use native collaboration for Codex-native work. When the execution model must be Claude, a native Codex GPT subagent may be the driver for `tools claude worker`; its GPT model does not turn the worker into GPT, and `spawn_agent` does not select Claude.
- External workers use the model flag of their own backend (`tools codex spawn --model`, `tools claude worker spawn -m`, or the Grok backend). That flag does not select the driver.

Treat process metadata and transcripts as authoritative over a driver's self-report. A driver has been observed omitting its final verdict and relaying stale state after work finished. Check `status` and `read` on the worker backend before waiting, retrying, or declaring completion.

## Never trust the self-report

Whatever the worker says it did, re-run the verification command yourself and read the diff before integrating.

## Experiment parity

The worker harness injects a shared contract covering checkpoints, verification evidence, scope changes, and final report fields. That contract can materially change how an ordinary runtime behaves. When comparing models or runtimes, give each arm an equivalent contract, project configuration, sandbox, tools, and stopping rule—or state that the comparison measures the handoff harness as well as the model.

## Account and history boundaries

Forward an account explicitly supplied by the orchestrator; do not substitute desktop login or duplicate a native auth file. Codex workers accept --account; human-driven `tools codex run <account>` uses the account-bound server. Native Claude/Codex/Grok history searches auto-index on use. Manual index maintenance is optional and separate from credential import or source migration, which requires authorization. See the provider references and `../claude-history/SKILL.md`.

Provider history uses the existing `~/.genesis-tools/claude-history/index.db`: bounded metadata and statistics, with source-backed text/context. That database also holds historical usage/spending observations. Optional history rebuild must preserve those rows; do not delete the database or recreate a parallel transcript mirror.
