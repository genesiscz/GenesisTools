---
name: gt:handoff
description: Create and maintain a compaction-proof progress file (.claude/plans/<plan>.handoff.md) next to an implementation plan, so any executor - fresh session, post-compact resume, or parallel subagent - knows exactly where the work stands and which plan lines to read next. Invoke when starting to execute a plan, when resuming one, when handing work to another agent, or when the user says "create a handoff" / "prepare the handoff".
---

# handoff — compaction-proof execution state

The handoff file is the executor's external memory. Context gets compacted, sessions die, agents run in parallel — the handoff file survives all of it. **THE FILE IS THE TRUTH**: if your memory of progress disagrees with the file, the file wins.

It is also **self-describing**: its own `## PROTOCOL` section teaches any reader the rules, so a fresh agent needs nothing but "Read `<plan>.handoff.md` and follow it."

## Where it lives

Next to the plan: `.claude/plans/<PlanName>.md` → `.claude/plans/<PlanName>.handoff.md`.
If there is no plan file, the handoff still works — its TASKS section carries the step list itself.

## The three iron rules

1. **Read the handoff FIRST** — at session start, after every compaction, before every task. It is small by design (~1–2k tokens) and replaces re-reading the whole plan.
2. **Update it IMMEDIATELY after every task** — never "at the end". An update you postponed dies with the next compaction.
3. **STATE/TASKS are rewritten in place; LOG is append-only.** Never rewrite or delete LOG entries — they are the audit trail.

## Creating a handoff (start of execution, or when handing off)

Step 1 — build the plan TOC with real line numbers:

```bash
rg -n '^#{1,3} ' .claude/plans/<PlanName>.md
wc -l .claude/plans/<PlanName>.md
```

Step 2 — Write `.claude/plans/<PlanName>.handoff.md` from this exact skeleton, filling every `<...>` (task list and line ranges come from the TOC you just built; mark independent tasks with the same `[P:n]` group when the plan's DON'T-TOUCH/interface-freeze shows they share no files):

````markdown
# Handoff: <PlanName>

## PROTOCOL — read this first, every time
You are executing a plan. This file is your memory; the plan file is your instructions.
1. Read this whole file (it is small). Trust it over anything you remember.
2. Read ONLY the plan's preamble (lines 1-<preamble-end>) — goal, covenant, interface freeze.
3. Find **YOU ARE HERE** below. Read ONLY that task's line range from the plan:
   `sed -n '<A>,<B>p' .claude/plans/<PlanName>.md` (or Read with offset/limit).
4. Execute the task exactly as the plan says. Do not improvise; deviations go in the
   plan's `## Deviations` AND one LOG line here.
5. IMMEDIATELY update this file: flip the task checkbox, move YOU ARE HERE, append one
   LOG line. Then go to 3.
6. After any compaction or restart: start again at 1. Never re-read the whole plan.
Rules: STATE/TASKS sections are rewritten in place. LOG is append-only, newest at the
bottom. If a check fails after its ON-FAIL fallback: STOP, log it, report to the user.

## STATE  <!-- rewrite in place -->
- **Plan:** .claude/plans/<PlanName>.md (<total> lines; preamble = lines 1-<preamble-end>)
- **Goal:** <one line>
- **Branch/worktree:** <branch> @ <absolute path>
- **YOU ARE HERE:** Task <N> — <name> (plan lines <A>-<B>) — <not started | in progress: step <K> | blocked: <why>>
- **Verify:** <the command that proves the current task done, e.g. `bun test src/x.test.ts`>

## TASKS  <!-- rewrite in place; [P:n] marks tasks safe to run in parallel within group n -->
- [ ] Task 1 — <name> (lines <A>-<B>)
- [ ] Task 2 — <name> (lines <C>-<D>) [P:1]
- [ ] Task 3 — <name> (lines <E>-<F>) [P:1]

## PLAN TOC  <!-- rewrite only when the plan file itself changes -->
- Preamble (goal, covenant, interface freeze, conventions): lines 1-<preamble-end>
- Task 1 — <name>: lines <A>-<B>
- ...
- Dry-run trace: lines <Y>-<Z>
- Deviations: lines <>-<end>

## LOG  <!-- append-only, one line per event, newest at bottom -->
- <YYYY-MM-DD HH:MM> — handoff created; plan has <K> tasks, none started.
````

Step 3 — verify: `wc -l` the handoff (should be well under ~120 lines) and confirm every TASKS line range matches the TOC.

Step 4 — the handoff prompt for another agent is exactly one sentence:
> Read `.claude/plans/<PlanName>.handoff.md` and follow its PROTOCOL section. Re-read that file after every compaction.

## Maintaining it (executor duties, after EVERY task)

1. Flip the checkbox in TASKS.
2. Move **YOU ARE HERE** to the next task (with its line range) and update **Verify**.
3. Append ONE LOG line with a real timestamp (`date '+%F %H:%M'`), stating the observable result, not intentions:
   `- 2026-07-08 21:40 — Task 2 done: bun test 14/14 green, committed abc1234. Next: Task 3.`
4. If anything deviated: one LOG line here + the entry in the plan's `## Deviations`.
5. Blocked? Set YOU ARE HERE to `blocked: <reason>`, log it, STOP and report — do not skip ahead.

Keep LOG lines terse. Never trim or rewrite old lines; the file staying append-only is worth more than it staying pretty.

## Resuming (fresh session / post-compact)

Read the handoff → read plan preamble lines → read the YOU-ARE-HERE task's line range → work. That's ~2–4k tokens to be fully oriented, no matter how large the plan is. Re-reading the entire plan after a compaction is a protocol violation, not diligence.

## Parallelizing with subagents

- Only tasks sharing a `[P:n]` group may run concurrently; anything unmarked is sequential.
- **One writer rule:** subagents NEVER edit the handoff. The orchestrator spawns each subagent with: "Execute ONLY Task <N> of `.claude/plans/<PlanName>.md`, lines <A>-<B>. Read the plan preamble (lines 1-<preamble-end>) first. Report the verify output; do not touch other files." The orchestrator updates TASKS/LOG as each returns.
- If two [P] tasks would touch the same file, the [P] marking is wrong — fix the handoff, run them sequentially.

## Relationship to other conventions

- Pairs with `plan-it` (gt:plan-it): plan-it plans have greppable `## Task N:` headings, per-task VERIFY, and a `## Deviations` section — a handoff maps onto them 1:1. Works with any plan that has task headings, though.
- The executor should load the `fable-style` skill if available; the handoff governs *where you are*, fable-style governs *how you work*.
- `*.handoff.md` files are chronological/append-only by repo convention — this skill's STATE/TASKS rewrite-in-place blocks are the explicitly declared exception; LOG keeps the append-only audit trail.
