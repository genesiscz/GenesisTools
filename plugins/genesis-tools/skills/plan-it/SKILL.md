---
name: gt:plan-it
description: Write the plan that another session, agent or model builds from, in the form its executor needs. A build spec (decision-level, about 400 lines - frozen interfaces, packages that say what each one needs, done-when checks, the owner's decisions, stop rules, a block to read after a compaction) for an Opus-class executor or for this session after a compaction; a full executor-proof plan (bite-sized TDD tasks, complete code, REASON/VERIFY/ON-FAIL) for a weak model. Use for "plan this", "write the spec", "spec for opus", "plan-it", "a plan to close these handoffs", "plan it so agents can build it", and INSTEAD of writing-plans whenever someone other than the current context executes.
---

# plan-it: the plan another executor builds from

The planner spends the judgment, the executor spends the hours. This skill has two forms. Pick by the executor,
never by habit.

| The executor | Form | What the plan holds |
|---|---|---|
| Opus-class or better; or this session after a compaction, switched to a cheaper strong model | **Build spec** (this file) | Decisions, frozen interfaces, packages, checks. No implementation code. About 400 lines. |
| A weak model (Haiku-class, Sonnet-class on a hard change), or unknown | **Full plan** | Every step and every line of code. Read `references/full-plan.md` in full and follow it. |

A spec for a weak executor leaves gaps that it fills with its own judgment. A full plan for a strong executor
costs a day of planner time for code the executor writes better with the real files open. Both are plan failures.

**Planner floor:** the strongest model you have. The spec is where the judgment lives.

## What a build spec is for

A strong executor does not fail on mechanics. It fails in four ways, and each part of the spec exists to stop one:

- It builds on a claim that was true last week. So: **the truth table**.
- It decides alone what the owner wanted to decide, or asks him forty small things. So: **the grilling**.
- It waits for a foundation, or invents names that another package also invents. So: **the interface freeze** and
  **what each package needs**.
- It never finishes: each check finds a new thing, each new thing becomes work. So: **done-when checks, targets
  that are aims, and the stop rules**.

It also forgets. A long build is compacted several times, and the owner's standing orders are the first thing a
summary loses. So: **the block to read after a compaction**.

## Before you write

1. **The truth table.** List each claim the spec builds on: "task t4 of the handoff is open", "the service has a
   `rebuild` command", "the window has no project picker". Check each one today, at the current head, with a
   command or a file and line. A handoff, a note or a memory entry is a dated observation, not a fact. Mark each
   row `holds`, `changed` (say how) or `cannot check` (say what would check it). Plan only from rows that hold.
   Keep a long table in its own file beside the spec and link it.
2. **The grilling: big decisions only.** Ask the owner before you write, in at most two rounds. A decision is big
   when a wrong guess is expensive to undo or he lives with it every day: a new model or dependency, a new service
   or daemon, a shape that is saved on disk, a default that changes what he sees, work that is dropped. Each
   question stands alone:
   - the situation on one real example from his data, in plain words, with who does what;
   - the options as letters, each with its cost (lines, dependencies, where it runs) and what it buys;
   - your recommendation and its main disadvantage.
   Decide every other thing yourself and write it as one line under "Decisions the planner made". Record each
   answer word for word. Never turn his answer into a stricter rule than he said.
3. **Name the executor.** "This session after a compaction, on <model>", or "one agent per package". Both read
   only the spec and what it links. Nothing you know from the conversation reaches them unless it is in the file.

## The sections of a spec, in this order

`assets/spec.example.md` shows all of them filled in. The file goes to
`.claude/plans/YYYY-MM-DD-<FeatureNameCamelCase>.md` (in a linked worktree: the main checkout's folder).

1. **The head.** `**Status:**` (date, state), `**Goal:**` (one sentence), `**Non-goals:**`, `**Executor:**`.
2. **`## Read this first after a compaction`.** The owner's standing orders, word for word with their date ("no
   review agents", "never push", "background only"). Where the progress is. The three things that are easiest to
   get wrong. The executor reads this block again after each compaction, before its next tool call.
3. **`## Sources`.** Each handoff with its id, its name, its open tasks and the exact commands to claim it, tick a
   task, deny a task and comment. The notes, the truth table, and each owner decision with his words. An executor
   that cannot find the handoff cannot close it.
4. **`## Interface freeze`.** The names every package uses: files, exported symbols with their signatures, shapes
   on disk, the command line. Code blocks are right here: a signature is a decision. When code forces a change,
   the executor changes this section first and adds a dated line.
5. **`## Order`.** Which packages can start now, which wait, and for what. See "What a package needs".
6. **`## Packages`.** One `### P<n>: <name>` per unit of work that one agent can finish. Fields below.
7. **`## Rules for the executor`.** The stop rules (below), the repository rules that this change touches, restated
   in a few lines, and the gate that every package runs.
8. **`## Decisions`.** `- **D<n> (answered <letter>):** "<the owner's words>"`, and
   `- **D<n> (open, blocks P<n>):** <the question>`. Then "Decisions the planner made", one line each.
9. **`## Progress`**, **`## Seen, not fixed`**, **`## Deviations`.** Empty. The executor fills them.

### The fields of a package

```markdown
### P3: the reopen path

**Owner files:** `src/handoff/lib/reopen.ts` (new), `src/handoff/lib/store.ts`
**Needs:** P1 (built), P2 (interface), external: the actions service (interface)
**Handoff:** closes t5 of `h_ab12cd34`
**Decisions:**
1. A reopen is an event in the log, not an edit of the task. Ruled out: a `reopened` flag, because the log is
   the only writer today.
**Done when:** `bun run test src/handoff/lib/reopen.test.ts` passes, and `tools handoff reopen <task>` on a
closed task prints the receipt.
**Targets:**
- ideally under 200 ms for a store of 5,000 events; way: read the index, not the log; source: tool; if not:
  write the measured time into Progress and go on.
**Effort:** about two hours. Stop at the first design that passes the test.
**Not in this package:** the delivery to a live agent (P4).
```

- **Owner files** are the files only this package changes. Two packages that own the same file cannot run at the
  same time: move the shared part into an earlier package.
- **Decisions** are the architecture: what, why, and the alternative that a constraint rules out. The executor
  does not derive them again. Write no implementation code; write a signature, a shape or an invariant.
- **Done when** is a command or a test that shows the wanted behaviour and one normal case. A check in a real
  window is written only for a defect of the window.
- **Targets** are aims, never bare numbers. Each one has the aim, a `way:`, a `source:` (`tool` when the tool
  measures the number, `hand-reference` when a person made the reference, `estimate`) and `if not:`. Only a number
  with `source: tool` may be a gate (`gate: yes`), and only on the owner's word.
- **Effort** says how much the package is worth and where to stop.

### What a package needs

A plan that waits for a foundation loses days. Write `**Needs:**` so that it does not:

- `nothing`: it can start now. These packages come first.
- `P2 (interface)`: it needs the names that P2 freezes, not P2's code. It can run beside P2. This is the reason
  the interface freeze is written before any package.
- `P2 (built)`: it needs P2's code to run. It starts when P2 is done.
- `external: <name> (interface)` or `(built)`: a foundation that another plan builds. Read its spec, write your
  package against its frozen interface, and put the calls behind ONE adapter file that uses today's door until
  the foundation is there. Name the swap (the file, the call sites) in the package. Never plan a second service,
  a second store or a second transport because the first one is not built yet.

Order the packages so that nothing waits without need. `scripts/spec-check.ts` prints the waves.

## Rules for the executor (copy them into the spec, then add the repository's)

- A package is done when its "Done when" holds and the gate passes. Tick its handoff task with the command, where
  it ran and the commit. Then start the next package.
- A number shows a direction. It is a gate only where the package says `gate: yes`.
- When a measurement shows that a target is out of reach, write the number and the reason into Progress and go
  on. Ask the owner about all such limits in ONE question at the end. Do not work on a limit while you wait.
- While you verify, fix a new thing only when it loses data, shows an invented fact or blocks the package. Each
  other thing is one line under "Seen, not fixed".
- The handoff tasks and Progress are the only lists. Make no second checklist.
- A fix that needs a new model, a new library or a large new feature is the owner's decision: say what it costs
  and what it buys, and go on with the other packages.
- Write each deviation from the spec under "Deviations" with the reason. An honest incomplete run is better than
  a complete improvised one.
- After a compaction, read "Read this first after a compaction" before the next tool call.

## Size

About 400 lines. A longer spec is not read twice, and it is read after every compaction. What does not fit goes
into a file the spec names: the truth table, a list of forty rows, the research behind a decision. Do not cut the
interface freeze or a "Done when" to save lines; cut history, comparison and prose.

## Check it, then hand it over

1. Run `bun <this skill>/scripts/spec-check.ts <spec.md>`. It fails on a missing section or package field, a path
   that does not exist (mark a file the build creates with `(new)` on its line), a handoff a package names that
   "Sources" does not, a target with no source or no way, a gate on a number the tool does not measure, a
   placeholder ("TBD", "as needed"), and a need that names no package. It prints the waves and what waits.
2. **The stranger test.** Could a model that never saw this conversation build it from the file alone?
3. Hand over with three facts: the path of the spec, the decisions that are still open and what they block, and
   the next step. For "this session after a compaction": the owner compacts the session and switches the model;
   the first message after it is "Build `<path>`. Read its first block before anything else." For agents: one
   agent per package of the first wave, each with the spec path and its package id, nothing else.

Do not build from the spec in the session that wrote it unless the owner says so. The planner's context is
expensive, and the spec is the test of itself: an executor that needs the planner's memory shows a gap.

## When you are the executor of a spec

Read "Read this first after a compaction", "Sources" and "Rules for the executor", then your package. Claim the
handoff. Per package: build, run the gate, tick, commit, write one line into Progress (package, state, commit,
the check with where it ran). Stop for the owner only on an open decision that blocks every package you can
start.
