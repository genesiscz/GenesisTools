---
name: gt:git-recommit
description: Recompose the current branch's commits into N clean, scope-organised commits with the same final tree.
argument-hint: "[<count> | --min <n> --max <n>]"
---

# Recommit

Recompose all commits on the current branch into clean, scope-organised commits. Not a squash:
a soft reset plus fresh commits, and the final tree stays byte-identical (a backup tag and a
tree-identity gate prove it).

## Usage

```
/gt:git-recommit 4              # exactly four commits
/gt:git-recommit --min 3 --max 6
/gt:git-recommit                # ask: a number, or analyse and propose a split
```

> **Underlying skill:** this command follows the `gt:git` skill's `references/recommit.md`.

## Input: $ARGUMENTS

- A single number → exactly that many commits.
- `--min <n> --max <n>` → decide within the range.
- Nothing → ask the user whether to specify a number or to analyse the changes and propose a split.

## Process

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/git/references/recommit.md` in full.
2. Follow its phases in order: detect the base with `tools git base`, sync local and remote base,
   collect commit and file data from the MERGE-BASE (never the moving base tip), decide the
   count, categorise (a Sonnet subagent for the grouping), present the plan, then backup tag,
   soft reset, recommit, and the zero-diff gate against the backup tag.
3. Push only when the user says push, with `--force-with-lease`; otherwise report the backup tag
   and the exact push line.
