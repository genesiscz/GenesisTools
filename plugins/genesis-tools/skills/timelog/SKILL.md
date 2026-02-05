---
name: genesis-tools:timelog
description: Sync time from Timely to Azure DevOps. Use when user says "sync timely", "log my time from timely", "propose time entries", "what did I work on today", "sync my tracked time". Analyzes Timely auto-tracked activities and git commits to generate Azure DevOps time log proposals.
---

# Timely → Azure DevOps Time Sync

Analyze auto-tracked Timely activities and git commits to propose Azure DevOps time log entries.

## Prerequisites

1. Timely configured: `tools timely login && tools timely accounts --select`
2. Azure DevOps configured: `tools azure-devops --configure <url>`
3. TimeLog configured: `tools azure-devops timelog configure`

## Workflow

When user asks to sync time or propose time entries:

### Step 1: Determine Date Range

Ask user for date if not specified. Default to today.

### Step 2: Gather Timely Data

```bash
# Download and process Timely entries for the month containing the target date
tools timely export-month YYYY-MM --format detailed-summary --silent
```

This creates a summary at `~/.genesis-tools/timely/cache/entries-YYYY-MM-detailed-summary.md`

Read this file to understand activities for the target date.

### Step 3: Gather Git Context

```bash
# Get commits for the specific date
git log --since="YYYY-MM-DD 00:00" --until="YYYY-MM-DD 23:59" --all --format="%H|%s|%an|%ai"

# Get current branch for context
git branch --show-current

# Get branches with work item patterns
git branch -a | grep -E '[0-9]{5,6}'
```

### Step 4: Extract Work Item IDs

Search for patterns in commit messages and branch names:
- `#NNNNNN` - Explicit work item reference
- `feat(#NNNNNN):` - Conventional commit with work item
- `fix(NNNNNN):` - Conventional commit variant
- `WI-NNNNNN` or `WI NNNNNN` - Work item prefix
- Branch: `feature/NNNNNN-description`
- Branch: `NNNNNN-description`

### Step 5: Correlate Activities to Work Items

Match Timely activities to work items:

| Timely Activity | Git Context | → Work Item |
|-----------------|-------------|-------------|
| Cursor col-fe 3h | Commits mention #268935 | → 268935 |
| Teams meeting 30m | No direct link | → Ask user or skip |
| GitLab/GitKraken 45m | MR review on feature/123456 | → 123456 |

### Step 6: Generate Proposal

Present a table for user approval:

```
┌─────────┬─────────┬──────────────┬─────────────────────────────────┐
│ Work ID │ Hours   │ Type         │ Comment                         │
├─────────┼─────────┼──────────────┼─────────────────────────────────┤
│ 268935  │ 2.5     │ Development  │ feat: implement login flow      │
│ 268935  │ 0.5     │ Code Review  │ PR review and feedback          │
│ 123456  │ 1.0     │ Development  │ fix: validation error handling  │
│ ???     │ 0.5     │ Ceremonie    │ Teams standup (assign manually) │
└─────────┴─────────┴──────────────┴─────────────────────────────────┘
```

Use AskUserQuestion to confirm:
- "Approve these entries?" with options: "Yes, log all", "Let me modify", "Cancel"

### Step 7: Execute Approved Entries

For each approved entry:

```bash
tools azure-devops timelog add -w <id> -h <hours> -t "<type>" -c "<comment>"
```

## Time Type Mapping

| Activity Context | Time Type |
|------------------|-----------|
| Cursor/Warp coding | Development |
| GitLab MR review | Code Review |
| Teams meeting | Ceremonie |
| Documentation edits | Dokumentace |
| Testing activities | Test |
| Analysis/design | IT Analýza |
| Configuration/deploy | Konfigurace |

## Examples

| User Request | Action |
|--------------|--------|
| "sync my time from today" | Full workflow for today |
| "propose time entries for 2026-02-03" | Full workflow for specific date |
| "what did I work on yesterday?" | Gather + analyze, show proposal |
| "log my timely to azure devops" | Full workflow for today |

## Handling Unmatched Time

For Timely time that can't be matched to a work item:
1. Show it separately in the proposal
2. Suggest: "Assign work item manually or skip?"
3. Use AskUserQuestion to get work item ID

## Notes

- Timely data is cached; re-run `export-month` to refresh
- The LLM should use judgment to correlate activities
- When in doubt, ask the user rather than guess
- Total logged time should approximately match Timely total for the day
