---
name: genesis-tools:timelog
description: Sync time from Timely to Azure DevOps. Use when user says "sync timely", "log my time from timely", "propose time entries", "what did I work on today", "sync my tracked time". Analyzes Timely auto-tracked activities and git commits to generate Azure DevOps time log proposals.
---

# Timely -> Azure DevOps Time Sync

Analyze Timely events, auto-tracked memories, and git commits to propose Azure DevOps time log entries.

## Prerequisites

1. Timely configured: `tools timely login && tools timely accounts --select`
2. Azure DevOps configured: `tools azure-devops --configure <url>`
3. TimeLog configured: `tools azure-devops timelog configure`

## Data Model

| Timely Concept | CLI Command | What it is |
|---|---|---|
| **Events** | `tools timely events` | User-created logged/billed time (project, note, duration). Primary source. |
| **Memories** | `tools timely memories` | Auto-tracked desktop activity (app, file, URL). Context source. |
| **Entries** (linked) | Default with events | Memories linked to an event via `entry_ids[]`. Fetched automatically. |
| **Unlinked memories** | Also default with events | Memories NOT linked to any event, with fuzzy match suggestions. |

Events are the **time buckets** (e.g., "4h51m on CEZ project, note: Gen2 2").
Memories are the **activity context** (e.g., "Cursor 2h24m editing timelog.ts, Teams 1h44m").
An event's `entry_ids` links to specific memories that the user assigned to that event.
Unlinked memories are activities tracked but not assigned to any event — potential unlogged time.

## Workflow

When user asks to sync time or propose time entries:

### Step 1: Determine Date Range

Ask user for date if not specified. Default to today.

### Step 2: Check Already Logged Time

```bash
# Check what's already logged in Azure DevOps for this date
tools azure-devops timelog list --day YYYY-MM-DD --format json 2>/dev/null | tools json
```

This shows existing time log entries - avoid duplicating these.

### Step 3: Gather Timely Events + Entries + Unlinked Memories

```bash
# Events with linked memories AND unlinked memories (default behavior)
tools timely events --day YYYY-MM-DD --format json --without-details 2>/dev/null | tools json
```

This returns a `{ events, unlinked }` object:

**`events[]`** — slim event objects with linked memories:
```json
{
  "id": 279377482,
  "day": "2026-01-30",
  "project": { "id": 4344283, "name": "CEZ" },
  "duration": "04:51",
  "note": "Gen2 2",
  "from": null, "to": null,
  "entry_ids": [1996125913],
  "billed": false, "billable": true,
  "cost": 0,
  "entries": [
    { "title": "Cursor", "note": "timelog.ts", "duration": { "formatted": "02:24" },
      "sub_entries": [{ "note": "col-fe — JenkinsfileBuildFeeWeb.groovy", "duration": "00:45" }] },
    { "title": "Teams", "note": "Meeting", "duration": { "formatted": "01:44" } }
  ]
}
```

**`unlinked[]`** — memories NOT linked to any event, with fuzzy match suggestions:
```json
{
  "day": "2026-01-30",
  "title": "Teams",
  "note": "standup call",
  "duration": "00:45",
  "from": "09:00", "to": "09:45",
  "suggested_event": { "id": 279377482, "score": 0.55, "reasons": ["time 80%"] },
  "sub_entries": [{ "note": "Daily standup", "duration": "00:30" }]
}
```

Use `suggested_event` to associate unlinked memories with the best-matching event (by time overlap and content similarity). Score > 0.5 = likely match. No `suggested_event` = completely unaccounted time.

### Step 4: Gather Git Context

```bash
# Get commits for the specific date
git log --since="YYYY-MM-DD 00:00" --until="YYYY-MM-DD 23:59" --all --format="%H|%s|%an|%ai"

# Get branches with work item patterns
git branch -a | grep -E '[0-9]{5,6}'
```

### Step 5: Extract Work Item IDs

Search for patterns in commit messages and branch names:
- `#NNNNNN` - Explicit work item reference
- `feat(#NNNNNN):` - Conventional commit with work item
- `fix(NNNNNN):` - Conventional commit variant
- Branch: `feature/NNNNNN-description`

### Step 6: Correlate Events to Work Items

Each Timely **event** represents a chunk of logged time. Match each to a work item:

| Event (project + note) | Linked Entries Context | Git Context | -> Work Item |
|---|---|---|---|
| CEZ 4h51m "Gen2 2" | Cursor: timelog.ts, Teams: meeting | Commits on feature/268935 | -> 268935 |
| Internal 30m | Teams: standup | No direct link | -> Ask user |

Also check `unlinked[]` for unaccounted time:
- If `suggested_event` present with high score: add to that event's work item
- If no suggestion: potential new time entry (meeting, context switching, etc.)

### Step 7: Generate Proposal

Present a table for user approval:

```
+---------+---------+--------------+---------------------------------+
| Work ID | Hours   | Type         | Comment                         |
+---------+---------+--------------+---------------------------------+
| 268935  | 2.5     | Development  | Gen2 2: coding, timelog impl    |
| 268935  | 0.5     | Code Review  | PR review and feedback          |
| 123456  | 1.0     | Development  | fix: validation error handling  |
| ???     | 0.75    | Ceremonie    | Teams standup (unlinked, assign) |
+---------+---------+--------------+---------------------------------+
```

Use AskUserQuestion to confirm:
- "Approve these entries?" with options: "Yes, log all", "Let me modify", "Cancel"

### Step 8: Execute Approved Entries

For each approved entry:

```bash
tools azure-devops timelog add -w <id> -h <hours> -t "<type>" -c "<comment>"
```

## Time Type Mapping

| Activity Context | Time Type |
|---|---|
| Cursor/Warp coding | Development |
| GitLab MR review | Code Review |
| Teams meeting | Ceremonie |
| Documentation edits | Dokumentace |
| Testing activities | Test |
| Analysis/design | IT Analyza |
| Configuration/deploy | Konfigurace |

## Key Commands Reference

| Purpose | Command |
|---|---|
| Events + entries + unlinked (default) | `tools timely events --day YYYY-MM-DD --format json --without-details` |
| Events full raw JSON | `tools timely events --day YYYY-MM-DD --format json` |
| Events without memories | `tools timely events --day YYYY-MM-DD --format json --without-entries` |
| Memories only | `tools timely memories --day YYYY-MM-DD --format json` |
| Existing timelogs | `tools azure-devops timelog list --day YYYY-MM-DD --format json` |
| Timelogs by user/range | `tools azure-devops timelog list --since YYYY-MM-DD --upto YYYY-MM-DD --user "Name"` |
| Add timelog | `tools azure-devops timelog add -w <id> -h <hours> -t "<type>" -c "<comment>"` |
| Delete timelog | `tools azure-devops timelog delete <timeLogId>` |
| Delete timelog (interactive) | `tools azure-devops timelog delete --workitem <id>` |
| Available time types | `tools azure-devops timelog types` |

## Handling Unmatched Time

For time that can't be matched to a work item:
1. Show it separately in the proposal with `???` as work item
2. Suggest: "Assign work item manually or skip?"
3. Use AskUserQuestion to get work item ID

## Notes

- Events = time buckets (what was logged). Memories = activity context (what was tracked).
- Events command now includes entries and unlinked memories by default (use `--without-entries` to skip).
- JSON output with entries is `{ events: [...], unlinked: [...] }` when unlinked memories exist.
- When events have empty notes, use linked entries (memories) to infer what was done.
- Check existing timelogs first to avoid double-logging.
- Total proposed time should approximately match Timely total for the day (events + unlinked).
- When in doubt about work item assignment, ask the user rather than guess.
