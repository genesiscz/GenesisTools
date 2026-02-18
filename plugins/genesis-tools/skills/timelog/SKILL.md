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
4. Git authors configured: `tools git configure authors` (for using `tools git commits`)

## Data Model

| Timely Concept | CLI Command | What it is |
|---|---|---|
| **Events** | `tools timely events` | User-created logged/billed time (project, note, duration). Primary source. |
| **Memories** | `tools timely memories` | Auto-tracked desktop activity (app, file, URL). Context source. |
| **Entries** (linked) | Default with events | Memories linked to an event via `entry_ids[]`. Fetched automatically. |
| **Unlinked memories** | Also default with events | Memories NOT linked to any event, with fuzzy match suggestions. |

Events are the **time buckets** (e.g., "4h51m on MyProject, note: Sprint 2").
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
  "project": { "id": 4344283, "name": "MyProject" },
  "duration": "04:51",
  "note": "Sprint 2",
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
# Get commits for the specific date range with automatic workitem ID extraction
tools git commits --from YYYY-MM-DD --to YYYY-MM-DD --format json 2>/dev/null | tools json
```

This command automatically extracts workitem IDs from commit messages and branch names via configured patterns (default: `col-(\d+)`, `#(\d{5,6})`, `COL-(\d+)-` on branches).

The output includes commit metadata (hash, message, author, date), stats (files changed, insertions, deletions), and extracted workitem IDs. Stats are always included.

Each Timely **event** represents a chunk of logged time. Match each to a work item:

| Event (project + note) | Linked Entries Context | Git Context | -> Work Item |
|---|---|---|---|
| MyProject 4h51m "Sprint 2" | Cursor: timelog.ts, Teams: meeting | Commits on feature/268935 | -> 268935 |
| Internal 30m | Teams: standup | No direct link | -> Ask user |

Also check `unlinked[]` for unaccounted time:
- If `suggested_event` present with high score: add to that event's work item
- If no suggestion: potential new time entry (meeting, context switching, etc.)

### Step 6: Generate Proposal

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

### Step 7: Stage Entries for Review (Preferred for Multi-Day Sync)

Instead of directly executing entries, the preferred workflow for multi-day sync is to use `prepare-import`:

```bash
# For each entry, stage it for review
tools azure-devops timelog prepare-import add --from YYYY-MM-DD --to YYYY-MM-DD --entry '{
  "workItemId": 268935,
  "date": "2026-02-04",
  "hours": 2.5,
  "timeType": "Development",
  "comment": "Gen2 2: coding, timelog impl"
}'

# Review all staged entries
tools azure-devops timelog prepare-import list --name YYYY-MM-DD.YYYY-MM-DD --format table

# On user approval, import all at once
tools azure-devops timelog import .genesis-tools/azure-devops/cache/prepare-import/YYYY-MM-DD.YYYY-MM-DD.json
```

This workflow:
- Validates each entry as it's added (Zod schema + workitem type precheck)
- Allows user to review before committing
- Generates a name automatically from date range (e.g., `2026-02-01.2026-02-08`)
- Entries can be removed or modified before import
- Import supports `--dry-run` for final verification

### Step 8: Execute Approved Entries (Alternative for Single Entries)

For single entries or immediate execution:

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
| Events (force fresh fetch) | `tools timely events --day YYYY-MM-DD --force` |
| Events for date range | `tools timely events --from YYYY-MM-DD --to YYYY-MM-DD --format json` |
| Memories only | `tools timely memories --day YYYY-MM-DD --format json` |
| Memories (force fresh fetch) | `tools timely memories --day YYYY-MM-DD --force` |
| Memories for date range | `tools timely memories --from YYYY-MM-DD --to YYYY-MM-DD --format json` |
| Git commits with workitem IDs | `tools git commits --from YYYY-MM-DD --to YYYY-MM-DD --format json` |
| Configure git authors | `tools git configure authors` (interactive) |
| Configure workitem patterns | `tools git configure patterns` (interactive) |
| Existing timelogs | `tools azure-devops timelog list --day YYYY-MM-DD --format json` |
| Timelogs by date range | `tools azure-devops timelog list --from YYYY-MM-DD --to YYYY-MM-DD --format json` |
| Timelogs filtered to me | `tools azure-devops timelog list --from YYYY-MM-DD --to YYYY-MM-DD --user @me --format json` |
| Add timelog | `tools azure-devops timelog add -w <id> -h <hours> -t "<type>" -c "<comment>"` |
| Stage entry for review | `tools azure-devops timelog prepare-import add --from YYYY-MM-DD --to YYYY-MM-DD --entry '{...}'` |
| Review staged entries | `tools azure-devops timelog prepare-import list --name YYYY-MM-DD.YYYY-MM-DD` |
| Remove staged entry | `tools azure-devops timelog prepare-import remove --name <name> --id <uuid>` |
| Import staged entries | `tools azure-devops timelog import <path-to-json>` |
| Import with dry run | `tools azure-devops timelog import <path-to-json> --dry-run` |
| Delete timelog | `tools azure-devops timelog delete <timeLogId>` |
| Delete timelog (interactive) | `tools azure-devops timelog delete --workitem <id>` |
| Available time types | `tools azure-devops timelog types` |

## Handling Unmatched Time

For time that can't be matched to a work item:
1. Show it separately in the proposal with `???` as work item
2. Suggest: "Assign work item manually or skip?"
3. Use AskUserQuestion to get work item ID

## Fixed Workitem Mappings

These workitems are always the same and should be used automatically:

| Pattern | Workitem ID | Time Type | Description |
|---|---|---|---|
| SU, standup | **262042** | Ceremonie | Standup (always 0.5h) |
| Planning, retro, ceremonies | **262042** | Ceremonie | Planning, retrospective, etc. |
| `(sentry)` in commit messages | **269409** | Development | Sentry-related work |
| Support, provoz | **266796** | Provoz - Správa Aplikací | Support/operations |
| Release (only when user explicitly says) | **262351** | Release | Release work |
| `col-<taskid>` in commit messages | **\<taskid\>** | Development | Maps directly to that workitem |

> **Validation:** Periodically verify these IDs are still active: `tools azure-devops workitem 262042,269409,266796,262351 --format ai`. Update mappings if any return Closed/Removed state.

## Git Commit Stats for Time Estimation

When estimating time from commits (useful for days without Timely events or for distributing "Development" hours across workitems):

```bash
# Get commits with stats using tools git
tools git commits --from YYYY-MM-DD --to YYYY-MM-DD --format json 2>/dev/null | tools json
```

The command uses configured authors (from `tools git configure authors`) and automatically filters by author date in the specified range. Authors can be added with `--author "Name"` or `--with-author "Name"` flags if needed.

Line count estimation heuristics:
- < 20 lines changed: 0.5h minimum
- 20-100 lines: 0.5-1h
- 100-500 lines: 1-3h
- 500+ lines: 3-6h (complex feature/refactor)
- Tests (1000+ lines): 2-4h (test code is repetitive, faster to write)
- Rebased/merge commits: count as 0.5-2h for the rebase work itself, don't count old commit lines

## Azure DevOps Activity (for Gap Filling)

When Timely data is missing or incomplete, use Azure DevOps activity to reconstruct what the user worked on:

```bash
# Get activity timeline for a date range (reads from cache)
tools azure-devops history activity --from YYYY-MM-DD --to YYYY-MM-DD -o json 2>/dev/null | tools json

# Discover + sync items not yet cached, then show activity
tools azure-devops history activity --from YYYY-MM-DD --to YYYY-MM-DD --discover -o json 2>/dev/null | tools json
```

The output is grouped by day, with events like:
- `state_change` — user moved an item (Active → Resolved)
- `assignment_change` — user (re)assigned an item
- `comment` — user commented on an item
- `created` — user created a new item
- `field_edit` — user edited fields (description, title, etc.)

**Mapping activity to time entries:**
- Multiple actions on the same work item within a short window = single work session
- State changes (especially → Resolved/Closed) indicate focused work
- Comments often indicate code review or investigation
- Item creation = analysis/planning time

**Prerequisite:** Sync history first if cache is empty:
```bash
tools azure-devops history sync                              # sync all cached items
tools azure-devops history activity --from YYYY-MM-DD --discover  # discover + sync new items
```

## Import JSON Format

For bulk importing time entries, create a JSON file:

```json
{
  "entries": [
    {
      "workItemId": 268935,
      "hours": 2,
      "timeType": "Development",
      "date": "2026-02-04",
      "comment": "Implemented feature X"
    },
    {
      "workItemId": 268936,
      "hours": 1,
      "minutes": 30,
      "timeType": "Code Review",
      "date": "2026-02-04",
      "comment": "PR #123 review"
    }
  ]
}
```

Fields:
- `workItemId` (required): Azure DevOps work item ID
- `date` (required): YYYY-MM-DD
- `timeType` (required): Must match exactly from `tools azure-devops timelog types`
- `hours` (required): Whole or decimal hours (0.5 = 30min)
- `minutes` (optional): Additional minutes (use instead of decimal hours if preferred)
- `comment` (optional): Description of work done

Commands:
```bash
# Validate without creating entries
tools azure-devops timelog import <file.json> --dry-run

# Actually import
tools azure-devops timelog import <file.json>
```

## Timelog Report Format (.md)

Reports go in `.claude/timelog/YYYY-MM.md`. Structure:

```markdown
# <Month> <Year> - Time Log & Activity Report

**Author:** <name> (<git emails>)
**Period:** YYYY-MM-DD to YYYY-MM-DD
**Sources:** Timely auto-tracking + git commits (<repo>) + Azure DevOps

---

## Summary

### Project-Related Activity (by Timely)

| Date | Day | Project Hours | Timely Note | Key Activities |
|------|-----|-----------|-------------|----------------|
| 1. 2. | po | 11h | SU (0.5), Support (4), Login (7.5) | ... |

### Teams/Meetings (from Timely)

| Date | Duration | Key Meetings |
|------|----------|-------------|
| 2. 2. | 5h 54m | GO/NO GO (52m), Teams: Hansík, Figurny... |

---

## Git Commits - <repo> (<period>)

### <Date> (<Day>):
- `<commit message>` (<N> files, <N>+, <N>-)

---

## Work Item References (from commits)

| Work Item | Description | Commits | Lines Changed |
|-----------|-------------|---------|--------------|
| col-XXXXX | ... | N | NNN |

---

## Key Work Themes (<period>)

### 1. Theme Name
- Bullet points of what was done
```

Key principles:
- Timely note breakdowns (SU, Support, Login hours) go in the summary table
- Each commit listed with file/line stats
- Days with NO COMMITS explicitly noted
- Weekend/no-event days with commits still listed
- Rebased commits noted separately (count + "rebased" note)
- Work item table cross-references commits

## Multi-Day / Weekly Workflow

When syncing multiple days at once:

1. **Gather Timely events for the range** (use `--from`/`--to` or per-day `--day`)
2. **Gather git commits for the range** with stats: `tools git commits --from YYYY-MM-DD --to YYYY-MM-DD --format json`
3. **Check existing timelogs** for the range to avoid duplicates
4. **Create a report .md file** in `.claude/timelog/` with full breakdown (commits, Timely data, Teams meetings)
5. **Stage entries using prepare-import** (preferred):
   - For each entry: `tools azure-devops timelog prepare-import add --from <from> --to <to> --entry '{...}'`
   - Review: `tools azure-devops timelog prepare-import list --name <from>.<to>`
6. **Present proposal** to user with friendly readable table and totals per day
7. **Use AskUserQuestion** to get approval: "Approve all", "Let me modify", "Cancel"
8. **On approval**, run `tools azure-devops timelog import .genesis-tools/azure-devops/cache/prepare-import/<name>.json`

The Timely event notes often contain the user's own time breakdown (e.g., "SU (0.5), Support (4), Login (7.5)"). Use these as primary allocation guide, then distribute the specific development hours across workitems based on commit line counts.

## Notes

- Events = time buckets (what was logged). Memories = activity context (what was tracked).
- Events command now includes entries and unlinked memories by default (use `--without-entries` to skip).
- JSON output with entries is `{ events: [...], unlinked: [...] }` when unlinked memories exist.
- When events have empty notes, use linked entries (memories) to infer what was done.
- Check existing timelogs first to avoid double-logging.
- Total proposed time should approximately match Timely total for the day (events + unlinked).
- When in doubt about work item assignment, ask the user rather than guess.
- Minimum time unit: 0.5h (30 minutes). Round up small items.
- Weekend/off-hours commits should still be estimated and proposed (user decides whether to log them).
