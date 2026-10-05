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

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/git/references/recompose-branches.md` in full. The
   harness substitutes that placeholder at load time; if you see it literally, build the path
   from the "Base directory for this skill" line printed when this loaded rather than passing
   it to a shell, which would expand it to nothing. If both fail, read
   `plugins/genesis-tools/skills/git/references/recompose-branches.md` in the GenesisTools repo.
   🛑 Do not improvise these phases from memory — this splits a branch, and a wrong move loses
   commits.
2. Analyse with `tools git rebranch plan`, one `--groups name=pattern` per group (a pattern
   without `*` covers its whole directory). Show the IN / OUTSIDE / MIXED table, ask how each
   MIXED commit should go (whole, skip, paths-only), and write the answers into the plan file
   from `plan --json`.
3. Build with `tools git rebranch apply --plan <file>` (`--dry-run` first). It cherry-picks in
   order from the base and prints the outside paths of every paths-only commit.
4. The apply ends with the proof; `tools git rebranch verify --plan <file>` reruns it. Exit 1
   names every lost or changed path: report it, never call the split done.
5. Report per group; pushes and PRs are printed, not run, until the user says push.
