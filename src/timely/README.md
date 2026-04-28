# Timely

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Timely time-tracking CLI — OAuth2 login, project filters, monthly exports, and summary generation.**

Reads auto-tracked activities ("memories"), logged events, accounts, and projects from the Timely API. Handy for sanity-checking what you worked on before logging time to Azure DevOps or Clarity.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **OAuth2 login** | Browser-based flow with token storage |
| **Events & memories** | Pull both logged time and auto-tracked suggestions |
| **Month export** | One command, five output formats (table/CSV/JSON/summary) |
| **Account/project picker** | `--select` flows cache the default for future runs |

---

## Quick Start

```bash
# First-time auth
tools timely login

# Check config + auth status
tools timely status

# Pick a default account / project
tools timely accounts --select
tools timely projects --select

# See what you logged in a date range
tools timely events --from 2026-04-01 --to 2026-04-07

# Auto-tracked suggestions for today
tools timely memories --day 2026-04-20

# Monthly export (table, CSV, JSON, summary, detailed-summary)
tools timely export-month 2026-04
tools timely export-month 2026-04 --format csv > time.csv
tools timely export-month 2026-04 --format summary
tools timely export-month 2026-04 --format detailed-summary --silent
```

---

## Commands

| Command | Description |
|---------|-------------|
| `login` | OAuth2 auth with Timely |
| `logout` | Clear stored tokens |
| `status` | Show config + auth status |
| `accounts [--select]` | List accounts, optionally pick default |
| `projects [--select]` | List projects, optionally pick default |
| `events [--from/--to/--day]` | List logged time entries |
| `memories [--from/--to/--day]` | Auto-tracked activities (suggested entries) |
| `create [--day/--from/--to] [-i] [--dry-run]` | Create events from memories with heuristic project suggestion (interactive single-event-per-day) |
| `create --plan --out <path>` / `create --apply <path> [--yes] [--dry-run]` | LLM-friendly plan/apply: generate a JSON, fill `events[]` per day with `memory_ids` subsets, then apply |
| `export-month <YYYY-MM>` | Export all entries for a month |
| `cache [list\|clear]` | Manage the local Timely cache |

---

## Global Options

| Option | Alias | Description |
|--------|-------|-------------|
| `--help-full` | `-?` | Extended help with examples |
| `--verbose` | `-v` | Verbose logging |
| `--format <fmt>` | `-f` | `json`, `table`, `csv`, `raw`, `summary`, `detailed-summary` |
| `--account <id>` | `-a` | Override account ID |
| `--project <id>` | `-p` | Override project ID |
| `--silent`, `--quiet` | | Suppress output (print only the file path) |
| `--from <YYYY-MM-DD>` | | Start date (events/memories) |
| `--to <YYYY-MM-DD>` | | End date (events/memories) |
| `--day <YYYY-MM-DD>` | | Single day (events/memories) |

---

## Related

- `tools azure-devops` / `tools clarity` — downstream time sinks
- The `genesis-tools:timelog` skill drives the full Timely -> ADO -> Clarity sync
