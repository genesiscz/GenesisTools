# GitHub

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **GitHub CLI for fetching issues, PRs, comments, reviews, code, and activity — with built-in caching.**

A token-efficient GitHub client tailored for AI workflows. Parses issue/PR URLs or raw numbers, fetches bodies + comments + reviews, and outputs clean Markdown or JSON. Responses are cached in a local SQLite DB so repeated reads don't burn rate limit.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **URL or number** | Auto-detects `owner/repo` from the git remote when you pass just a number |
| **PR review threads** | `review` pulls unresolved threads grouped by file |
| **Comment filters** | Limit by count, recency, reactions, or exclude bots |
| **Search** | Issues, PRs, and code search with state/type filters |
| **Notifications & Activity** | Inbox triage and event feeds without leaving the terminal |
| **SQLite cache** | Every fetched object is reusable; `status` shows cache stats |
| **Interactive mode** | Run `tools github` with no args for a guided menu |

---

## Quick Start

```bash
# Fetch an issue or PR (URL or number if repo is inferrable)
tools github issue https://github.com/owner/repo/issues/123
tools github pr 456

# Include comments with filters
tools github pr 456 --no-bots --min-reactions 1 --last 20

# Review threads for a PR (only unresolved, grouped by file)
tools github review 456 --unresolved-only --group-by-file

# Search issues / PRs
tools github search "flaky test" --type pr --state open

# Code search
tools github code-search "TODO(matt)"

# Notifications (unread in last 7 days)
tools github notifications --state unread --since 7d

# Activity feed
tools github activity --since 1d --type pr

# Fetch a raw file
tools github get https://github.com/owner/repo/blob/main/src/index.ts --clipboard

# Cache + rate limit status
tools github status
```

---

## Subcommands

| Command | Description |
|---------|-------------|
| `issue <url-or-num>` | Fetch an issue with optional comments |
| `pr <url-or-num>` | Fetch a PR with optional comments and review comments |
| `comments <url-or-num>` | Fetch only the comment thread |
| `review <url-or-num>` | Review threads (unresolved-only, group-by-file, JSON/MD) |
| `search <query>` | Search issues and PRs |
| `code-search <query>` | GitHub code search |
| `get <file-url>` | Fetch raw file contents |
| `notifications` | List inbox notifications with filters |
| `activity` | Personal activity / events feed |
| `status` | Auth, rate limit, and cache stats |

Run any subcommand with `--help` for its full option list. The most common flags (`--format ai|json`, `--limit`, `--last`, `--no-bots`, `--min-reactions`, `--stats`, `--clipboard`) work across multiple subcommands.

---

## Auth

Uses `gh auth` credentials when available, otherwise works unauthenticated with public rate limits. `tools github status` tells you which mode you're in and how many calls remain.

---

## Related tools

- `tools github-release-notes` — generate release notes from tags
- `genesis-tools:github` skill — read-only GitHub browsing for agents
- `genesis-tools:github-pr` skill — PR review feedback workflow
