# Git

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Git analysis for commits, authors, and workitem ID extraction.**

Queries commits across a date range, extracts workitem IDs from commit messages via configurable regex patterns, attributes branches, classifies rebased commits, and maintains a list of author identities so you can slice history cleanly across name/email changes.

This is complementary to `git-commit` (which *creates* commits) and `git-last-commits-diff` (which *renders* diffs). `tools git commits` is the reporting layer.

---

## Quick Start

```bash
# Query commits for the last week
tools git commits --from 2026-04-13 --to 2026-04-20

# Include line-change stats and filter by author
tools git commits --from 2026-04-01 --to 2026-04-30 --stat --author "Martin"

# Group by branch, include workitem titles from Azure DevOps cache
tools git commits --from 2026-05-01 --to 2026-05-15 --group-by branch --with-workitem-title

# markdown for standup / Clarity paste
tools git commits --from 2026-05-14 --to 2026-05-27 --markdown --clipboard

# Configure authors interactively (pick from git history)
tools git configure-authors

# Quick add/remove
tools git configure-authors --add "Your Name"
tools git configure-authors --remove "old-name"

# Suggest workitem patterns from a repo
tools git configure-workitem-patterns --suggest --repo /path/to/repo

# Add a custom pattern
tools git configure-workitem-patterns --add 'col-(\d+)'
```

---

## Commands

### `commits`

Query commits by date range with optional workitem extraction, branch attribution, and rebase handling.

| Option | Description |
|--------|-------------|
| `--from <YYYY-MM-DD>` | Start date (required) |
| `--to <YYYY-MM-DD>` | End date (required) |
| `--author <name>` | Override configured authors (repeatable) |
| `--with-author <name>` | Append to configured authors (repeatable) |
| `--format <json\|table>` | Output format (default: table) |
| `--stat` | Include line-change stats |
| `--group-by <day\|branch\|workitem\|none>` | Group main listing (default: `day`) |
| `--without-branch` | Hide inline `[branch]` column (shown by default) |
| `--without-workitem-id` | Hide inline `[#id]` column (shown by default) |
| `--with-workitem-title` | Resolve Azure DevOps titles (cache-first); shown inline after `#id` **and** in the Workitem Summary |
| `--with-workitems` | Alias for `--with-workitem-title` |
| `--with-full-commit-messages` | Show full multi-line commit bodies (default: first line only) |
| `--without-stashes` | Exclude `WIP on` / `index on` stash commits |
| `--without-merges` | Exclude merge commits |
| `--workitem <id>` | Filter to commits referencing workitem ID (repeatable, OR) |
| `--include-rebases` | Expand rebased-into-range commits inline |
| `--date <author\|commit\|true-first>` | Date used for grouping (default: `author`) |
| `--markdown` | markdown output (day headers, bullet list) |
| `--clipboard` | Copy output to clipboard (`--markdown` recommended) |

**Rebase behaviour:** `git log --after`/`--before` still filter by committer date. Commits authored before `--from` but committed inside the range are clustered by landing time. In the default `day` grouping each cluster is folded into the day it **landed** (committer date) as a single `▸ N commits rebased … [from <branch>]` line, with the day header showing `(N commits, M rebased)`. Under `--group-by branch|workitem|none` the clusters stay in a compressed footer instead. `--include-rebases` expands every rebased commit in its own section. Patch-id dedup collapses cherry-pick/rebase duplicates (keeps newest committer date).

**Default inline columns:** each row shows `[branch]` and `[#workitem]` when known. Trunk-only attribution is labelled `[trunk: develop]`. Only the **first line** of each commit message is shown — pass `--with-full-commit-messages` for the full body.

**`(?)` marker:** a commit flagged `(?)` had its author date likely reset by a rebase/amend, so the timestamp shown is the original authoring time, not when it landed. A legend prints at the bottom whenever any `(?)` appears.

**Performance:** branch attribution (`git branch --contains`) and patch-id dedup (`git show | git patch-id`) run in parallel; a ~1000-commit / two-week range over `--all` resolves in ~1s. Per-phase timings are logged at `debug` level — run with `-v` or read `~/.genesis-tools/logs/<today>.log` to triage slow runs.

### `configure-authors`

Manage the author identities used by `commits` when `--author` isn't passed.

| Option | Description |
|--------|-------------|
| `--add <name>` | Add author (repeatable) |
| `--remove <name>` | Remove an author |
| `--list` | List configured authors |
| _(no flags)_ | Interactive multi-select from `git log` |

### `configure-workitem-patterns`

Manage regex patterns that extract workitem IDs (e.g. `DEV-1234`, `FEAT-42`) from commit messages.

| Option | Description |
|--------|-------------|
| `--list` | List current patterns |
| `--add '<regex>'` | Add a pattern |
| `--remove <index>` | Remove a pattern by index |
| `--suggest` | Scan a repo and propose patterns |
| `--repo <path>` | Repo to scan for `--suggest` (default: cwd) |
| _(no flags)_ | Interactive management |

---

## Storage

Configuration lives at `~/.genesis-tools/git/config.json`.

Example with branch attribution:

```json
{
  "authors": ["you@example.com"],
  "workitemPatterns": [ ... ],
  "branchAttribution": {
    "excludeTrunks": ["develop", "main", "master"]
  }
}
```

`branchAttribution.excludeTrunks` is optional; defaults to `develop`, `main`, and `master`. Names matching these (including `origin/<name>`) are skipped during branch resolution unless no other branch exists — then the trunk is shown as `[trunk: <name>]`.

Workitem pattern tightening (e.g. `col-(\d{5,6})` instead of `col-(\d+)`) is per-user via `configure-workitem-patterns` or direct config edit; code defaults remain loose for other projects.
