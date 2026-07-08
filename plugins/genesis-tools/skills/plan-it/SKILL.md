---
name: gt:plan-it
description: Write comprehensive implementation plans (subsumes writing-plans - bite-sized TDD tasks, exact paths, complete code) hardened with an executor-proof contract - all judgment spent at plan time, REASON/VERIFY/ON-FAIL per task, no-improvisation covenant - so even the weakest model executes to strong-model-quality output. Invoke INSTEAD of writing-plans whenever the plan may be executed by another session, subagent, or weaker model.
---

# plan-it — executor-proof implementation plans

**Announce at start:** "I'm using the plan-it skill to create the implementation plan."

This skill **subsumes `writing-plans`** — same comprehensive planning discipline (bite-sized tasks, TDD, complete code, exact paths, self-review, execution handoff), plus an executor-proof contract on top. Never invoke both; this is the superset.

**Planner floor: Sonnet-class or better.** A five-run evaluation showed Haiku-class models reproduce the contract's *structure* reliably but hallucinate dry-run intermediates and skip do-work requirements (running the empirical trace, resolving design uncertainty); they are executor-tier, not planner-tier. The plan is where all judgment lives — spend a strong model on it.

The plan, not the executor, carries the intelligence. Written under this contract, a plan produces near-identical results whether a frontier model or a small one executes it — because every decision is already made, every line of nontrivial code is already written, and every checkpoint is mechanically checkable. The output looks like the planner's code because the code in the plan IS the planner's.

Why this works: weak models match strong ones only when nothing is left to fill in — they fail precisely by filling gaps with their own judgment, and they silently drop project conventions under complexity unless the conventions are restated in-context. Separating REASON (judgment) from ACT (mechanics) is the best-transferring shape.

## Core assumption — the weakest executor

Write for a skilled but completely **literal** engineer with zero context for the codebase, questionable taste in tests and design, and **no access to this conversation**:

- **Self-contained**: every path repo-rooted or absolute; every relevant repo convention restated inside the plan (logger vs out, SafeJSON, prompt facade, import style, …); never "as discussed" or "like we did before".
- **Interface freeze**: exact file names, exported symbols, type signatures, DB columns declared in the preamble *before* the tasks — executors drift on names first, and a symbol used in Task 7 that was named differently in Task 3 is a plan bug.
- **DON'T-TOUCH list**: name adjacent files/behaviors that must not change. Weak models "improve" neighboring code unless told not to.

## Where plans go

`.claude/plans/YYYY-MM-DD-<FeatureNameCamelCase>.md` (this convention overrides any other skill's default location).

## Scope check

If the spec covers multiple independent subsystems, split it — one plan per subsystem, each producing working, testable software on its own.

## File structure first

Before writing tasks, map which files will be created/modified and each one's single responsibility. Prefer small focused files; follow the codebase's established patterns rather than restructuring unilaterally. This map locks in the decomposition; each task then produces a self-contained change.

## Plan preamble (mandatory, in this order)

````markdown
# [Feature Name] Implementation Plan

> **For agentic workers:** Execute task-by-task (subagent-driven-development or
> executing-plans). Steps use checkbox (`- [ ]`) syntax. Load the `fable-style`
> skill first if it is available. The covenant below is binding.

**Goal:** [one sentence]
**Architecture:** [2–3 sentences]
**Tech Stack:** [key technologies]
**Non-goals:** [what this plan deliberately does not do]
**DON'T-TOUCH:** [files/behaviors that must not change]

## Interface freeze
[exact names: files, exported symbols, signatures, types, columns — the vocabulary
every task below must use verbatim]

## Conventions capsule
[the repo rules relevant to this change, restated — the executor has not read
CLAUDE.md and will not infer them]

> **Covenant:** Execute tasks in order, exactly as written. Do not substitute
> approaches, "improve" adjacent code, rename things, or skip verification steps.
> If anything is ambiguous, or a check stays red after its single ON-FAIL fallback,
> stop and report — an honest incomplete run beats a complete improvised one.
````

## Bite-sized granularity

Each step is ONE action (2–5 minutes): write the failing test → run it, expect FAIL → minimal implementation → run it, expect PASS → commit. DRY. YAGNI. TDD. Frequent commits.

## Task skeleton (mandatory)

Use exactly this heading format — `## Task N: [Component Name]` — executors and graders match on `^## Task`.

````markdown
## Task N: [Component Name]

**REASON**: <2–4 lines: why this approach, which constraint rules out the obvious
alternative. The executor must not re-derive or second-guess this.>

**Files:**
- Create: `exact/path/to/file.ts`
- Modify: `exact/path/to/existing.ts:123-145` (anchor: quote the exact existing line)
- Test: `exact/path/to/file.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
<real test code — full block, no "..." elisions>
```

- [ ] **Step 2: Run it — expect FAIL**

Run: `bun test exact/path/to/file.test.ts`
Expected: FAIL with "<the actual message>"

- [ ] **Step 3: Minimal implementation**

```ts
<real code — the planner writes it, the executor applies it>
```

- [ ] **Step 4: Run — expect PASS**

Run: `bun test exact/path/to/file.test.ts`
Expected: PASS (and any other observable: exit 0, string to grep)

- [ ] **Step 5: Commit**

```bash
git add exact/path/to/file.test.ts exact/path/to/file.ts
git commit -m "feat: <concise why>"
```

**ON-FAIL**: If <specific symptom> → <one action> once. Otherwise: STOP, append to
`## Deviations`, do not start Task N+1.
````

ON-FAIL is one sentence, one action, **25 words maximum**. It may NEVER modify anything declared in the interface freeze (names, signatures, frozen constants/sets), may NEVER weaken, loosen, or delete a test to make it pass, and is not a debugging expedition — if one bounded action doesn't fix it, the answer is STOP, not a second idea. Commit steps always `git add` explicit paths — never `git add -A`.

Granularity guard: one exported symbol (or one cohesive component) per task. If a task's ACT creates two unrelated exports, split it.

No test infrastructure in the target repo? Replace test steps with the strongest available observable (`tsgo --noEmit`, lint, a runnable command with expected output) — never drop verification.

## No placeholders — the altitude rule

Spend ALL judgment at plan time. A weak executor doesn't fill gaps with your judgment; it fills them with its own. These are **plan failures** — never write them:

- "TBD", "TODO", "implement later", "fill in details"
- "Add appropriate error handling" / "add validation" / "handle edge cases" / "as needed" / "properly"
- "Write tests for the above" (without the actual test code)
- "Similar to Task N" (repeat the code — tasks may be read out of order)
- Steps that describe code without showing it (code blocks required)
- References to types/functions not defined in the interface freeze or an earlier task
- Any ACT needing more than ~30 lines of new logic the plan doesn't spell out — judgment leaked into execution; go back and write the code

## Self-review (before publishing)

Run this checklist yourself — not a subagent dispatch:

1. **Spec coverage** — every spec requirement maps to a task; list gaps and add tasks.
2. **Placeholder scan** — search the plan for every red-flag pattern above; fix inline.
3. **Type consistency** — names/signatures in later tasks match the interface freeze and earlier tasks.
4. **Stranger test** — could a model that has never seen this conversation execute it, alone, from the file?
5. **Observable verification** — every task's checks name expected output, not "check it works".
6. **Bounded failure** — every task has exactly one ON-FAIL fallback, then stop.
7. **Dry-run trace section present and honest** — the `## Dry-run trace` section exists, its intermediate values are actually computed (not asserted), and its conclusion equals the test's expected value. A plan whose own tests fail its own implementation strands the executor at the first VERIFY — the worst possible leak, because the executor is forbidden from fixing it.

Fix and move on; no re-review loop.

## Dry-run trace section (mandatory)

Every plan contains, immediately before `## Deviations`, a `## Dry-run trace` section for the least trivial test input in the plan. The trace must be **empirical, not mental**: paste the planned function into a throwaway eval (e.g. `bun -e '<planned function code>; console.log(fn(<input>))'` — touches no repo files, so it is still PLAN ONLY) and paste the REAL printed output into the section, alongside the per-stage intermediate values (log the token array after each stage). Mental simulation is forbidden — models routinely mis-simulate regex and string operations and then assert wrong intermediates with full confidence. If the actual output and the test's expected value disagree, the plan is wrong — fix the code or the test before publishing. A plan without this section, or with a trace that was not actually executed, is incomplete and must not be published.

## Deviations section

Every plan ends with an empty `## Deviations` section. The executor appends every deviation there (anchor moved, command adapted, fallback used) — it's the audit trail for the retro.

## Execution handoff

After saving, offer: **1. Subagent-driven** (fresh subagent per task, review between tasks — recommended) or **2. Inline** (executing-plans, batch with checkpoints). Either way, if the `fable-style` skill is available the executor loads it first — plan-it is the planner-side half of the transfer (work arrives pre-chewed); fable-style is the executor-side half (the worker behaves like the strong model).
