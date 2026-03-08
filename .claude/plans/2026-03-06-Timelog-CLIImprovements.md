# Clarity CLI Improvements Plan

**Date:** 2026-03-06
**Branch:** feat/timelog-clarity

---

## Context

Current CLI (`tools clarity`) has usability gaps:
- `tools clarity configure` — asks "Reconfigure? yes/no" instead of showing config ✅ DONE
- `tools clarity fill` without `--month` — shows error instead of help ✅ DONE
- `tools clarity fill` preview — returns `totalMapped: 13425` with no explanation why weeks are empty ✅ DONE
- `tools clarity timesheet` — does nothing (no default action)
- `tools clarity timesheet list` — requires `--period <timePeriodId>` (nobody knows that)
- No interactive mode for any command when called without args
- `tools azure-devops workitem/query` — should suggest work item URLs for LLMs

---

## Task 1: Make `tools clarity timesheet` interactive

When called without a subcommand, show an interactive menu:

```
┌   Clarity Timesheets
│
◆  Select action:
│  ● Show current week timesheet
│  ○ Browse timesheets by month
│  ○ Submit a timesheet
│  ○ Revert a timesheet
└
```

**"Show current week"**: Fetch the current week's timesheet via `getTimesheetApp(0)` (period 0 = current), render table.

**"Browse by month"**: Prompt for month/year (default: current), use `getTimesheetWeeks()` from `src/clarity/lib/timesheet-weeks.ts` to find all weeks, show them as selectable list, then render selected timesheet.

**"Submit/Revert"**: Same browse flow, then ask confirmation.

**Files:**
- Modify: `src/clarity/commands/timesheet.ts` — add default interactive action

---

## Task 2: Make `tools clarity timesheet list` accept `--month`/`--year`

Replace the `--period` option with `--month`/`--year` (like fill uses). Use the shared `getTimesheetWeeks()` to resolve month → timesheet IDs.

Keep `--period` as hidden option for backward compat.

**Files:**
- Modify: `src/clarity/commands/timesheet.ts` — update `list` subcommand

---

## Task 3: Make `tools clarity fill` interactive when no `--month`

Instead of showing help, prompt for month/year interactively:

```
┌   Clarity Fill
│
◆  Month? (1-12)
│  2
│
◆  Year?
│  2026
│
◇  Preview or execute?
│  Preview (dry-run)
│
```

Then run the fill logic with those params.

**Files:**
- Modify: `src/clarity/commands/fill.ts` — add interactive fallback

---

## Task 4: Make `tools clarity` (no subcommand) show interactive menu

Instead of Commander help, show an interactive menu of all available commands:

```
┌   Clarity PPM Tools
│
◆  What would you like to do?
│  ● View/manage timesheets
│  ○ Fill timesheets from ADO
│  ○ Link ADO work items to Clarity
│  ○ Configuration
│  ○ Open dashboard (web UI)
└
```

**Files:**
- Modify: `src/clarity/index.ts` — add default action with clack select

---

## Task 5: ADO work item URL template in CLI output

When `tools azure-devops workitem` or `tools azure-devops query` outputs results, include the work item URL in the output. For LLM-consumed output (JSON), add a `url` field. For human output (table), show as clickable link.

Template: `https://dev.azure.com/{org}/{project}/_workitems/edit/{id}` or `{org}.visualstudio.com/{project}/_workitems/edit/{id}`

Use `buildWorkItemUrl()` from `src/azure-devops/lib/urls.ts`.

**Files:**
- Modify: `src/azure-devops/commands/workitem.ts` — add URL to output
- Modify: `src/azure-devops/commands/query.ts` — add URL to output

---

## Implementation Order

1. Task 1 — interactive timesheet (most impactful UX)
2. Task 2 — month/year for timesheet list
3. Task 3 — interactive fill
4. Task 4 — interactive main menu
5. Task 5 — ADO URLs (separate tool)
