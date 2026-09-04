---
name: gt:git-recompose-branches
description: Split a branch's commits into separate branches by file-pattern groups, with a verified split.
argument-hint: "[<commit-count>] [<source-branch>] [<pattern,pattern,…>]"
---

# Recompose branches

Analyse the commits of a source branch, group them by path patterns, rebuild one branch per
group with `git cherry-pick -x`, and prove the groups together equal the source.

## Usage

```
/gt:git-recompose-branches 78 feat/next src/claude-history/,plugins/,raycast/
/gt:git-recompose-branches                     # current branch, last 50 commits, ask for patterns
```

> **Underlying skill:** this command follows the `gt:git` skill's `references/recompose-branches.md`.

## Input: $ARGUMENTS

- First number → how many commits to analyse (default 50).
- A branch name → the source branch (default: the current one).
- A comma-separated list → the path patterns that define the groups; ask when missing.

## Process

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/git/references/recompose-branches.md` in full.
2. Analyse and classify the commits (IN / OUTSIDE / MIXED), write the table to
   `.claude/work/<source>-commits.md`, and ask how MIXED commits should be handled.
3. Build each group branch from the base with `--no-track`, cherry-pick in order, and for a
   MIXED commit drop the outside paths only after printing them and confirming.
4. Verify the split: the union of the groups' changed paths equals the source's, and every
   path's blob matches on exactly one group.
5. Report per group; pushes and PRs are printed, not run, until the user says push.
