---
name: wrap-up
description: "Write the state doc that lets a fresh agent resume cold — a session wrap-up in Obsidian, or a plan-execution handoff in the repo. Triggers on 'wrap up', 'close out this session', 'summarize and hand off', 'document what we did', 'save/create the handoff', and on starting or resuming execution of a plan. Use it proactively at the end of any substantial multi-commit or PR-merged session, even unasked."
---

# wrap-up — durable resume state

Context gets compacted, sessions die, work spans days. This skill writes the file a fresh agent reads to know exactly where things stand, without re-deriving it from git and scrollback.

Two modes, two artifacts. Pick by what is being resumed:

| Mode | Artifact | Lives in | For |
|---|---|---|---|
| **SESSION** (default) | `<project>-<branch>.wrapup.md` | Obsidian vault | end of a work session; cross-day, cross-project narrative + forensics |
| **PLAN** | `.claude/plans/<PlanName>.handoff.md` | the repo | mid-execution of a specific plan; which task you are on, what verifies it |

SESSION mode is Parts 1–2 below; PLAN mode is the last section.

They compose: a long plan execution uses PLAN mode continuously and SESSION mode once at the end.

## SESSION mode

The wrap-up doc is the bridge between sessions. It lives in the user's Obsidian vault (durable, cross-project, outside any one repo), and it is **append-only for history** with **one rewrite-in-place header** for current state.

Two jobs: figure out *where* the doc lives (target resolution), then *write* it (header + log + forensics).

## Part 1 — Resolve the target directory

Work through these tiers in order. Stop at the first that yields a directory.

### Tier 1 — the Obsidian dir already involved this session
If this session already read from or wrote to a specific Obsidian vault directory (a plan, a handoff, notes for this project), that is the target. You know this from your own session history — no lookup needed. Prefer it over the registry: it reflects where the work actually lived today.

### Tier 2 — the registry
Otherwise consult `~/.claude/handoff-registry.json`, which maps projects/branches/worktrees to their Obsidian home. Run:

```bash
bun "$CLAUDE_PLUGIN_ROOT/skills/wrap-up/scripts/resolve.ts" resolve
```

It reads your current git toplevel + branch + cwd, matches the most specific entry, and prints `{ found, obsidianDir, docPath, ... }`. If `found:true`, use that `docPath`. The registry shape:

```json
{
  "entries": [
    {
      "projectDir": "/path/to/ProjectRepo",
      "branch": "feat/handoff-fixes",
      "worktreeDir": "/path/to/ProjectRepo/.claude/worktrees/handoff-part2",
      "obsidianDir": "/path/to/Vault/ProjectRepo/Plans"
    }
  ]
}
```

`branch` and `worktreeDir` are optional — omit `branch` for a project-wide entry that matches any branch. `docPath` is optional; when absent the resolver derives `<obsidianDir>/<project>-<branch-slug>.wrapup.md` so each branch accumulates its own file.

### Tier 2.5 — shared plugin config (automatic)
`resolve` falls back to `~/.genesis-tools/plugins/config.json` by itself when the registry has no match — the result then carries `"source": "config"` and you just use its `docPath`, no user interaction needed. The file is a per-skill map shared by all genesis-tools plugin skills:

```json
{
  "wrap-up": {
    "vaultDir": "~/Vault",
    "docDir": ".claude/wrapups",
    "registryPath": "~/.claude/handoff-registry.json"
  }
}
```

All keys optional. `docDir` (absolute, `~/`, or relative to the project toplevel) wins over `vaultDir`, which resolves to `<vaultDir>/<projectName>/`. `registryPath` relocates the registry itself. When proposing a target in Tier 3, also suggest adding a `vaultDir` here once — it makes every future project resolve automatically.

### Tier 3 — infer, propose, register
If neither registry nor config yields a target (`found:false`), don't guess silently and don't dump the doc in a random place. Instead:

1. **Infer the user's structure.** Look at how the vault is organized for similar work — e.g. `ls` the vault root and any `<Project>/` folder, check whether handoffs/plans live under `<Vault>/<Project>/Plans/`, `/Handoffs/`, or similar. One or two `ls`/`Glob` calls, not a full crawl.
2. **Propose a target** to the user via `AskUserQuestion` — offer the inferred path as the recommended option plus one or two alternatives, so they confirm or redirect in one click.
3. **Persist the choice** so it's never asked again for this project/branch:
   ```bash
   bun "$CLAUDE_PLUGIN_ROOT/skills/wrap-up/scripts/resolve.ts" register --obsidian "<confirmed dir>" --branch "<branch>" --worktree "<worktree or omit>"
   ```
4. Then write the doc there.

## Part 2 — Write the doc

**EVERY wrap-up invocation does BOTH, always — never one without the other:**
1. **Rewrite the `YOU-ARE-HERE` header in place** (current state), AND
2. **Append a new `## <datetime> — <topic>` log section at the bottom** (what this session did, with commit SHAs).

This is not optional and not skippable — not even for a tiny one-commit session, not even if "the header already says it." The header is *volatile* (it gets overwritten next time, so its content is lost); the **log is the only permanent record**. A wrap-up that updates the header but appends no log section silently erases this session from history the moment the next wrap-up runs. If you truly did nothing worth a paragraph, you still append a one-line dated log entry. Header-only = incomplete wrap-up.

Locate the file at `docPath`. If it doesn't exist, create it from the template below (header + first log section). If it exists, **update the header in place** and **append a new log section** — never rewrite existing log sections; they are the audit trail.

### The template (new file)

```markdown
# Wrap-up: <Project> — <branch>

<!-- YOU-ARE-HERE:START -->
## You are here (<YYYY-MM-DD HH:MM>)
- **Branch / worktree:** <branch> @ <absolute path>
- **State:** <one line — what's done, what's mid-flight>
- **Next:** <the immediate next action a fresh agent should take>
- **Verify:** <the command that proves current state, e.g. `bun test src/x.test.ts`>
- **Read to resume:** <how much to read — e.g. "this header + the last 2 log sections below">
<!-- YOU-ARE-HERE:END -->

---

## <YYYY-MM-DD HH:MM> — <topic>  (commits <sha>, <sha>, …)

### Goal & context
<why this session existed — the ask, the starting state, what problem was being solved. One short paragraph so a cold reader has the frame before the details.>

### What happened (chronological)
<the build-log narrative, in order. Each meaningful step: what was attempted, what the result was, what it led to next. Include dead-ends and course-corrections — the path matters, not just the destination. This is the longest part; do not compress it to a bullet.>

### Files touched
<every path changed, created, or deleted, each with a one-line note of WHAT changed in it and WHY. Group by commit if there were several.>

### Commits
<one line per commit: `<sha> — <subject>`. Every git-touching entry above must map to a SHA here.>

### Decisions & rationale
<each non-obvious choice: what was decided, which alternatives were considered and rejected, and why. Tradeoffs accepted. This is what a fresh agent cannot re-derive from the diff.>

### Bugs, surprises, gotchas
<anything that bit us: errors hit and how they were resolved, surprising behavior, environment quirks, things the next agent must not step on again.>

### Verification
<what was actually run to prove it works — commands + observed output (test counts, exit codes, screenshots). If a check was skipped or failed, say so plainly.>

### Open / deferred / blocked
<what's unfinished, what was intentionally punted (and why), what's blocked on something external, and the concrete next steps.>
```

The subsections above are the floor, not the ceiling — a substantive session's log runs long by design. Drop a subsection only when it genuinely has nothing (e.g. no bugs hit → omit "Bugs"); never collapse the whole thing to a terse paragraph.

### Updating an existing file — one call does everything

The whole update — rewrite the `YOU-ARE-HERE` block in place, append the new log section, auto-stamp the datetime, and auto-generate the `### Header before → after` snapshot from the outgoing header — is a single `log` invocation. You never hand-transcribe the old header (the script reads it), never compute the datetime (the script stamps it), never do a separate in-place Edit.

Pipe ONE heredoc split by two sentinel lines: `@@HERE@@` introduces the new state bullets (the script wraps them in `## You are here (<now>)` between the markers), then `@@LOG@@` introduces the log-section body you author. Quote the delimiter (`<<'WRAPUP'`) so backticks and `$` in your prose aren't shell-expanded:

```bash
bun "$CLAUDE_PLUGIN_ROOT/skills/wrap-up/scripts/resolve.ts" log "<docPath>" <<'WRAPUP'
@@HERE@@
- **Branch / worktree:** <branch> @ <absolute path>
- **State:** <one line — what's done, what's mid-flight>
- **Next:** <immediate next action for a fresh agent>
- **Verify:** <command that proves current state>
- **Read to resume:** <how much of the log below to read>
@@LOG@@
## <YYYY-MM-DD HH:MM> — <topic>  (commits <sha>, …)

### Goal & context
...
### What happened (chronological)
...
### Files touched
...
### Decisions & rationale
...
WRAPUP
```

What the script does, atomically:
- Extracts the current `YOU-ARE-HERE` block, replaces it in place with your new `@@HERE@@` bullets under a freshly-stamped `## You are here (<now>)` title.
- Appends your `@@LOG@@` body as a new section at the bottom, then auto-appends a `### Header before → after` block quoting the outgoing header (verbatim) and the new one (verbatim) — so the volatile resume-pointer's wording survives permanently. **You do not write the before→after block yourself.**
- Prints `{ logged, stamp }`. Use `stamp` (or `date '+%Y-%m-%d %H:%M'`) for the `## <datetime>` line in your `@@LOG@@` body.

It refuses (non-zero exit) if the file doesn't exist (create it from the template with Write first), if a sentinel is missing, or if there's no `YOU-ARE-HERE` block — so a failed call never half-writes.

Append-only still holds: `log` only rewrites the header region and adds at the bottom; it never touches earlier log sections. To amend an in-place list/table in an old section, edit it directly and prepend `<!-- updated YYYY-MM-DD HH:MM: reason; commit <sha> -->` inside it.

### What each log section carries (forensics)

**Err long. The log is the permanent record — a fresh agent must be able to reconstruct the entire session from it without re-running anything, re-reading scrollback, or re-deriving state from git.** When in doubt, include it. Terse wrap-ups are the failure mode; length here is a feature, not bloat. Every substantive session fills all of these:

- **Goal & context** — the ask, the starting state, the problem being solved. Frame first.
- **Chronological narrative** — the build-log of what actually happened, step by step, *in order*, including dead-ends, failed attempts, and course-corrections. The path is as valuable as the result. This is the meat and it is meant to be long.
- **Files touched** — every path changed/created/deleted, each with WHAT changed and WHY. Not a bare file list.
- **Commit SHA(s)** the section produced or refers to. A git-touching section without its SHA is incomplete.
- **Decisions & rationale** — every non-obvious choice, the alternatives considered and rejected, the tradeoffs accepted. This is precisely what the diff cannot show.
- **Bugs, surprises, gotchas** — errors hit and how resolved, environment quirks, traps the next agent must avoid.
- **Verification** — commands run + observed output (test counts, exit codes). State skipped/failed checks honestly.
- **Open / deferred / blocked** — what's unfinished, what was punted and why, what's blocked, and the concrete next steps.

## Reading a wrap-up back (cheap resume)

To orient without reading the whole file, pull just the current-state header:

```bash
bun "$CLAUDE_PLUGIN_ROOT/skills/wrap-up/scripts/resolve.ts" here <docPath>
# or with sed:
sed -n '/YOU-ARE-HERE:START/,/YOU-ARE-HERE:END/p' <docPath>
```

The header's own **Read to resume** line tells you how much of the log below to read — usually the header plus the last section or two, not the whole history.

## Rules

- **Header rewrites in place; log is append-only — and you ALWAYS do both.** Every invocation: rewrite the `YOU-ARE-HERE` block (the single mutable region) AND append one new dated `##` log section. Never header-only. Log sections are permanent audit trail — never delete or rewrite them.
- **Every log section header carries the full datetime** (`## YYYY-MM-DD HH:MM — topic`), never date-only. Get it from `date '+%Y-%m-%d %H:%M'`.
- **Every git-touching section attaches its commit SHA(s)** inline.
- **Resolve before writing.** Don't dump wrap-ups in an arbitrary directory — walk the three tiers, and register the target once so it's automatic next time.
- **Keep it honest.** Record what actually happened — failed steps, skipped checks, open bugs. A wrap-up that only lists wins misleads the next session.
- **Err long, not terse.** The log section is the permanent audit trail — write it exhaustively (goal, full chronological narrative including dead-ends, files+why, decisions+rejected alternatives, bugs, verification output, open items). A substantive session's log runs long by design; a one-paragraph summary of a multi-commit session is a defect, not brevity.
- **Always end your response with the full absolute path to the wrap-up file as the last line** — after writing or appending, the final line of your reply must be the complete `docPath` (e.g. `/path/to/Vault/ProjectRepo/Plans/....wrapup.md`), so the user can open it in one click. Nothing after it.

---

## PLAN mode — compaction-proof execution state in the repo

Everything above is SESSION mode. PLAN mode is a different artifact with different rules: a small file next to an implementation plan, rewritten constantly during execution, that answers "which task am I on".

The handoff file is the executor's external memory. **THE FILE IS THE TRUTH**: if your memory of progress disagrees with the file, the file wins. It is also **self-describing** — its own `## PROTOCOL` section teaches any reader the rules, so a fresh agent needs nothing but "Read `<plan>.handoff.md` and follow it."

### Where it lives

Next to the plan: `.claude/plans/<PlanName>.md` → `.claude/plans/<PlanName>.handoff.md`. If there is no plan file, the handoff still works — its TASKS section carries the step list itself.

### The three iron rules

1. **Read the handoff FIRST** — at session start, after every compaction, before every task. It is small by design (~1–2k tokens) and replaces re-reading the whole plan.
2. **Update it IMMEDIATELY after every task** — never "at the end". An update you postponed dies with the next compaction.
3. **STATE/TASKS are rewritten in place; LOG is append-only.** Never rewrite or delete LOG entries — they are the audit trail.

### Creating one

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
- **Verify:** <the command that proves the current task done, e.g. `bun run test src/x.test.ts`>

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

### Maintaining it (executor duties, after EVERY task)

1. Flip the checkbox in TASKS.
2. Move **YOU ARE HERE** to the next task (with its line range) and update **Verify**.
3. Append ONE LOG line with a real timestamp (`date '+%F %H:%M'`), stating the observable result, not intentions:
   `- 2026-07-08 21:40 — Task 2 done: bun test 14/14 green, committed abc1234. Next: Task 3.`
4. If anything deviated: one LOG line here + the entry in the plan's `## Deviations`.
5. Blocked? Set YOU ARE HERE to `blocked: <reason>`, log it, STOP and report — do not skip ahead.

Keep LOG lines terse. Never trim or rewrite old lines; append-only is worth more than pretty.

### Resuming (fresh session / post-compact)

Read the handoff → read plan preamble lines → read the YOU-ARE-HERE task's line range → work. That is ~2–4k tokens to be fully oriented, no matter how large the plan is. Re-reading the entire plan after a compaction is a protocol violation, not diligence.

### Parallelizing with subagents

- Only tasks sharing a `[P:n]` group may run concurrently; anything unmarked is sequential.
- **One writer rule:** subagents NEVER edit the handoff. The orchestrator spawns each subagent with: "Execute ONLY Task <N> of `.claude/plans/<PlanName>.md`, lines <A>-<B>. Read the plan preamble (lines 1-<preamble-end>) first. Report the verify output; do not touch other files." The orchestrator updates TASKS/LOG as each returns.
- If two [P] tasks would touch the same file, the [P] marking is wrong — fix the handoff, run them sequentially.

### Relationship to other conventions

- Pairs with `gt:plan-it`: its plans have greppable `## Task N:` headings, per-task VERIFY, and a `## Deviations` section — a handoff maps onto them 1:1. Works with any plan that has task headings, though.
- The executor should load the `fable-style` skill if available; the handoff governs *where you are*, fable-style governs *how you work*.
- `*.handoff.md` files are chronological/append-only by repo convention — this mode's STATE/TASKS rewrite-in-place blocks are the explicitly declared exception; LOG keeps the append-only audit trail.
- Handing the work to a non-Claude worker instead of a subagent? That is `gt:handoff-to` (routing) and `gt:handoff-to-codex` (mechanics), not this skill.
- **Replaces the retired `gt:handoff`.** That skill is gone, not renamed: its wrap-up half is SESSION mode above, its plan-handoff half is PLAN mode. If you were reaching for `gt:handoff`, you want this skill — unless you meant offloading work to another model, which is `gt:handoff-to`.
