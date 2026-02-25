---
name: genesis-tools:git-rebaser
description: Guided git rebase cascade for branch hierarchies. Use when rebasing a parent feature branch onto master/main and then updating child branches. Triggers on "rebase branches", "cascade rebase", "rebase onto master", "update child branches after rebase", "rebase feature branch hierarchy", "git rebaser". Handles reflog lookup, --onto mechanics, commit reporting, and user confirmation before any destructive action.
---

# Git Rebaser — Guided Cascade Rebase

Safely rebase a parent branch onto a target (e.g. master) and cascade all child branches using `git rebase --onto`. Every destructive step requires explicit user confirmation.

## Workflow

### Phase 1: Gather Information

Ask the user these questions (use AskUserQuestion sequentially):

1. **Target branch** — "Which branch are you rebasing onto?" (default: `master`)
2. **Parent branch** — "Which is the parent feature branch to rebase?" (e.g. `feat/main`)
3. **Has the parent already been rebased?** — "Have you already rebased the parent branch, or should I do it now?"
4. **Child branches** — "List the child branches (comma-separated or space-separated)." (e.g. `feat/small-1, feat/small-2`)

### Phase 2: Analyze Current State

Run these commands and **report results to the user** before any action:

```bash
# For each branch, show its commit log relative to the parent
git log --oneline <parent>..<child>        # unique commits per child
git log --oneline <target>..<parent>       # commits on parent not yet on target
git merge-base <parent> <target>           # current fork point
```

Display a clear summary:
```
Parent branch: feat/main (15 commits ahead of master)
Child branches:
  feat/small-1: 3 unique commits on top of feat/main
  feat/small-2: 5 unique commits on top of feat/main
```

### Phase 3: Rebase Parent (if not already done)

If the parent has NOT been rebased yet:

1. **Save the pre-rebase ref**: `OLD_PARENT=$(git rev-parse <parent>)`
2. **Show the plan**: "I will rebase `<parent>` onto `<target>`. This replays N commits."
3. **Ask confirmation** via AskUserQuestion: "Proceed with rebasing <parent> onto <target>?"
4. Execute:
   ```bash
   git checkout <parent>
   git rebase <target>
   ```
5. If conflicts occur, **stop and tell the user** — do NOT attempt to resolve automatically. Guide them through `git rebase --continue` after they fix conflicts.

If the parent was ALREADY rebased, determine `OLD_PARENT` using this tiered approach:

**Tier 1 — Reflog (most reliable, available ~90 days):**

1. Run `git reflog <parent>` and find the entry just before the rebase (typically `<parent>@{1}`).
2. Show the user the ref and its commit message. Ask them to confirm it's the pre-rebase tip.
3. If confirmed, set `OLD_PARENT` to that ref.

**Tier 2 — `git cherry` (works if commits weren't squashed/reordered during rebase):**

If reflog is unavailable or inconclusive:

1. Explain to the user: "Reflog doesn't have the old ref. I'll try matching commits by their diff content using `git cherry`. This works as long as the parent's commits weren't squashed or reordered during the rebase."
2. For each child, run:
   ```bash
   git cherry -v <parent> <child>
   ```
   - Lines starting with `-` = commits whose patch content already exists on the new parent (shared commits, safe to exclude).
   - Lines starting with `+` = commits unique to the child (these are the ones to replay).
3. Show the user both lists and explain which commits will be kept vs dropped.
4. If the `+` list looks correct, count N unique commits and set `OLD_PARENT` to `<child>~N`.

**Tier 3 — Interactive commit selection (last resort, always works):**

If reflog is gone AND commits were squashed/dropped/reordered (making `git cherry` unreliable):

1. Explain to the user: "The parent branch's commits were modified during rebase (squashed, dropped, or reordered), so I can't automatically determine which commits belong to the child branch vs the old parent. The only safe approach is for you to identify your commits manually."
2. Show the full commit history:
   ```bash
   git log --oneline <target>..<child>
   ```
3. Explain: "These are ALL commits on `<child>` that aren't on `<target>`. Some of these were on the old parent branch (and have already been rebased as part of the new parent). I need you to tell me which commits are YOUR work on this child branch."
4. Ask the user to identify their commits (by hash, range, or count from the top).
5. Once confirmed, set `OLD_PARENT` to `<child>~N` where N is the number of unique commits.

### Phase 4: Report New Parent State

After rebase (or after identifying OLD_PARENT):

```bash
git log --oneline <target>..<parent>   # new parent commits
```

Show: "After rebase, `<parent>` has N commits on top of `<target>`."

### Phase 5: Cascade Child Branches

For EACH child branch:

1. **Show what will happen**:
   ```bash
   # These are the commits unique to this child (will be replayed)
   git log --oneline $OLD_PARENT..<child>
   ```
   Display: "Branch `<child>` has N unique commits that will be replayed onto new `<parent>`:"
   Then list each commit (hash + message).

2. **Ask confirmation** via AskUserQuestion: "Rebase `<child>` onto new `<parent>`? (commits listed above)"

3. Execute:
   ```bash
   git rebase --onto <parent> $OLD_PARENT <child>
   ```

4. **Report result**:
   ```bash
   git log --oneline <parent>..<child>
   ```
   Show the new commit list for verification.

5. If conflicts occur, **stop and guide the user** through resolution.

### Phase 6: Final Report

After all branches are rebased, show a complete summary:

```
Cascade rebase complete!

  master
  └── feat/main (15 commits)
      ├── feat/small-1 (3 commits)
      └── feat/small-2 (5 commits)

All branches verified. No orphaned commits.
```

## Critical Rules

- **NEVER force-push** without explicit user request — this skill only does local rebases
- **ALWAYS show commits** before and after each rebase step
- **ALWAYS ask confirmation** before every `git rebase` command
- **STOP on conflicts** — guide the user, don't auto-resolve
- **Use `git rebase --onto`** for child branches — never plain `git rebase`
- Determine `OLD_PARENT` using tiered fallback: reflog → `git cherry` → interactive commit selection (see Phase 3)
