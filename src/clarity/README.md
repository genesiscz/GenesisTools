# Clarity

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **CA PPM Clarity timesheet automation with Azure DevOps and Timely integration.**

Fills Broadcom / CA PPM Clarity weekly timesheets from Azure DevOps work-item timelogs, links tasks to PPM project codes, and exposes a local dashboard UI for reviewing the plan before submission.

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Timesheet sync** | Pulls Azure DevOps / Timely entries and proposes Clarity line items |
| **Workitem linking** | Persistent mapping between ADO work items and Clarity PPM projects |
| **Weekly task rows** | `tasks --add-from` copies a week's task catalogue onto every week of a month |
| **Fill workflow** | `fill` command commits planned hours to Clarity |
| **Dashboard UI** | `tools clarity ui` opens a Vite-powered browser UI on `localhost:3071` |

---

## Quick Start

```bash
# First-time configuration
tools clarity configure

# Show the current week's proposed timesheet
tools clarity timesheet

# Link an Azure DevOps work item to a Clarity PPM task
tools clarity mappings

# Put a week's task rows on every week of a month
tools clarity tasks --date 2026-09 --add-from 2026-08-25 --yes

# Fill this week's timesheet
tools clarity fill

# Open the browser dashboard
tools clarity ui
```

---

## Commands

| Command | Description |
|---------|-------------|
| `configure` | Store Clarity credentials, URLs, and defaults |
| `timesheet` | Show proposed line items for a week, with enrichment from Timely + ADO |
| `fill` | Submit planned time entries into Clarity |
| `mappings` | Manage the ADO work item -> Clarity task mapping, stored locally |
| `tasks` | The Clarity task rows on a timesheet week: list, `--add`, `--add-from`, `--remove` |
| `ui` / `dashboard` | Launch the Clarity dashboard web UI (Vite dev server) |

---

## `mappings` vs `tasks`

Two different things that both used to be called `tasks`:

- **`mappings`** edits the local link table in `~/.genesis-tools/clarity/config.json`. It says which
  Clarity task an ADO work item bills. Nothing leaves the machine.
- **`tasks`** edits Clarity itself: the task rows that make up a timesheet week. `--add-from` copies
  a complete week's catalogue onto every week of a month, skipping periods Clarity has not opened
  yet and rows that are already there.

A recommendation may come only from an ADO id found in the Clarity task name, matched against the
work item or one of its ancestors. Project rules such as "an Incident goes to Incidenty_Opex" are
the operator's judgement and deliberately live outside this tool.

---

## How it works

- Auth and URL config is stored under `~/.genesis-tools/clarity/`.
- Time-source enrichment reuses `tools timely` and `tools azure-devops` so those must be configured first.
- The UI lives under `src/clarity/ui/` and expects the project's cwd via the `CLARITY_PROJECT_CWD` env var (set automatically by `tools clarity ui`).
- Czech-locale weeks (Monday-start, `dd.MM` dates) are supported end-to-end; Clarity project codes from Contoso are the primary target.

---

## Related tools

- `tools timely` — Timely time tracking source
- `tools azure-devops` — Azure DevOps work items and timelogs
- The `genesis-tools:timelog` skill drives the full ADO + Clarity sync
