# Git

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Git analysis for commits, authors, and workitem ID extraction.**

Queries commits across a date range, extracts workitem IDs from commit messages via configurable regex patterns, and maintains a list of author identities so you can slice history cleanly across name/email changes.

This is complementary to `git-commit` (which *creates* commits) and `git-last-commits-diff` (which *renders* diffs). `tools git commits` is the reporting layer.

---

## Quick Start

```bash
# Query commits for the last week
tools git commits --from 2026-04-13 --to 2026-04-20

# Include line-change stats and filter by author
tools git commits --from 2026-04-01 --to 2026-04-30 --stat --author "Martin"

# Emit JSON for piping / dashboards
tools git commits --from 2026-04-01 --to 2026-04-30 --format json

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

Query commits by date range with optional workitem extraction.

| Option | Description |
|--------|-------------|
| `--from <YYYY-MM-DD>` | Start date (required) |
| `--to <YYYY-MM-DD>` | End date (required) |
| `--author <name>` | Override configured authors (repeatable) |
| `--with-author <name>` | Append to configured authors (repeatable) |
| `--format <json\|table>` | Output format (default: table) |
| `--stat` | Include line-change stats |

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
