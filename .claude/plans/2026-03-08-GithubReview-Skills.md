# GitHub Review LLM — Plan 3: Skill Updates

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Update the github-pr skill to use the new `--llm` ref system, preserve the old skill as fallback.

**Architecture:** Rename old skill, rewrite github-pr.md to use `--llm` + expand + respond workflow, update github SKILL.md docs.

**Tech Stack:** Markdown (skill files)

**Prerequisite:** Plan 1 (Foundation) and Plan 2 (CLI) must be completed first.

---

### Task 3.1: Copy github-pr.md to github-pr-old.md

**Files:**
- Copy: `plugins/genesis-tools/commands/github-pr.md` → `plugins/genesis-tools/commands/github-pr-old.md`

**Step 1: Copy the file**

```bash
cp plugins/genesis-tools/commands/github-pr.md plugins/genesis-tools/commands/github-pr-old.md
```

**Step 2: Update frontmatter in the OLD file**

Change the `name:` frontmatter in `github-pr-old.md` from `github-pr` to `github-pr-old`, and update the description to mention it's the legacy version (e.g. "Legacy PR review workflow (without --llm mode)").

---

### Task 3.2: Rewrite github-pr.md

**Files:**
- Modify: `plugins/genesis-tools/commands/github-pr.md`

The new skill should follow this workflow:

1. **Fetch with --llm mode**: `tools github review <pr> --llm -u -s pr{N}-{timestamp}`
2. **Read L1 output** to get thread list with refs
3. **Group threads by file** from L1 output
4. **For each file group, spawn an Explore agent** that:
   - Runs `tools github review expand t1,t3,t5 -s <session>` to get full thread details
   - Reads the actual source files referenced
   - Analyzes each thread → VALID / FALSE_POSITIVE / BY_DESIGN / ALREADY_FIXED / NEEDS_CLARIFICATION
5. **Merge agent results** into consolidated report
6. **Ask user** which threads to fix
7. **Implement fixes** and commit
8. **Post replies**: `tools github review respond t3 "Fixed in <sha>" --resolve -s <session>`

Key changes from old skill:
- Uses `-s` flag on EVERY command (session safety)
- Sub-agents expand only their batch of threads (not entire PR)
- Uses `respond`/`resolve` subcommands instead of flag-based `--respond -t`
- Session ID always shown in output, agents verify they're using the correct one

The skill should read the current `github-pr.md` and preserve:
- Multi-PR support (spawn parallel agents per PR)
- Verdict system (VALID, FALSE_POSITIVE, BY_DESIGN, ALREADY_FIXED, NEEDS_CLARIFICATION)
- Reply formatting patterns (commit links, reviewer tagging)
- Background agent delegation for posting replies

Just update the commands used to the new ref-based system.

---

### Task 3.3: Update github/SKILL.md

**Files:**
- Modify: `plugins/genesis-tools/skills/github/SKILL.md`

Add a new section documenting the LLM mode commands. Insert after the existing review command documentation:

```markdown
### LLM Mode (Session-Based Review)

For large PRs, use `--llm` mode which creates a session and uses compact refs:

```bash
# Fetch + create session with compact output
tools github review 137 --llm -u -s pr137-session

# Expand specific threads to see full detail
tools github review expand t1,t3 -s pr137-session

# Reply to threads using refs
tools github review respond t1 "Fixed in abc123" --resolve -s pr137-session

# Resolve multiple threads
tools github review resolve t1,t2,t3 -s pr137-session

# List active review sessions
tools github review sessions
```

The `-s` flag specifies the session ID. Always use it to avoid cross-session confusion.
When using the `genesis-tools:github-pr` skill, it automatically generates and uses session IDs.
```

---

### Task 3.4: Commit Plan 3

```bash
git add plugins/genesis-tools/commands/github-pr.md plugins/genesis-tools/commands/github-pr-old.md plugins/genesis-tools/skills/github/SKILL.md
git commit -m "feat(github-review): update github-pr skill to use --llm refs, preserve old as fallback"
```

---

## Verification (End-to-End)

After all 3 plans are complete:

1. `tsgo --noEmit` — no type errors across entire project
2. `tools github review <real-pr> --llm` — produces L1 output with session
3. `tools github review expand t1 -s <session>` — shows full thread detail
4. `tools github review sessions` — lists the session just created
5. Old commands still work: `tools github review 137 -u -g --md`
6. `tools github review respond t1 "test" -s <session>` — (test with disposable PR)
