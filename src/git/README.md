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

# Markdown for standup / Clarity paste
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
| `--with-workitem-title` | Append Azure DevOps title after `#id` (cache-first) |
| `--without-stashes` | Exclude `WIP on` / `index on` stash commits |
| `--without-merges` | Exclude merge commits |
| `--workitem <id>` | Filter to commits referencing workitem ID (repeatable, OR) |
| `--include-rebases` | Expand rebased-into-range commits inline |
| `--date <author\|commit\|true-first>` | Date used for grouping (default: `author`) |
| `--markdown` | Markdown output (day headers, bullet list) |
| `--clipboard` | Copy output to clipboard (`--markdown` recommended) |

**Rebase behaviour:** `git log --after`/`--before` still filter by committer date. Commits authored before `--from` but committed inside the range appear in a compressed “rebased into this range” footer (or inline with `--include-rebases`). Patch-id dedup collapses cherry-pick/rebase duplicates (keeps newest committer date).

**Default inline columns:** each row shows `[branch]` and `[#workitem]` when known. Trunk-only attribution is labelled `[trunk: develop]`.

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
