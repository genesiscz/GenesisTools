---
name: gt:timely
description: Create Timely time-log entries from auto-tracked memories. Use when the user says "log my Timely day", "convert memories to events", "fill Timely from yesterday", "create timely entry from memory", or "categorize my Timely time". Triggers a heuristic that matches each day's memories against the user's last 8 weeks of logged events to suggest a project, then POSTs via the public OAuth API with full memory linkage. Does NOT cover ADO TimeLog or Clarity sync — for those, defer to /gt:timelog.
---

# Timely Create-from-Memory

Drives the conversation that turns auto-tracked Timely memories into logged events with a heuristic project suggestion. The new event preserves the memory linkage (visible as auto-tracked tiles in the calendar UI) by passing `timestamps[].entry_ids` of the form `tool_tic_<memoryId>` to the public OAuth `POST /events` endpoint.

> **For full sync (Timely → ADO → Clarity), invoke `/gt:timelog` instead.** This skill is the *missing first hop*: it creates Timely entries. The follow-up ADO/Clarity sync is `/gt:timelog`'s job.

## CLI Reference

```bash
tools timely create --day 2026-04-24 -i               # interactive single day
tools timely create --from 2026-04-21 --to 2026-04-25 -i
tools timely create --day 2026-04-24 --dry-run        # preview payload
tools timely create --day 2026-04-24 --chain-ado      # also propose ADO entry per day
tools timely create --day 2026-04-24 -p 4344283 -n "feature work"  # non-interactive
tools timely memories --day 2026-04-24                # see what would be logged
tools timely events --day 2026-04-24                  # confirm after create
```

## Workflow

When the user says "log my Timely day" or similar:

1. **Pre-flight**
   - `tools timely status` → verify OAuth login (run `tools timely login` if not authenticated)
2. **Show the day**
   - `tools timely memories --day <date>` → list memory buckets
   - `tools timely events --day <date>` → flag if anything is already logged (warn before duplicating)
3. **Create**
   - `tools timely create --day <date> -i` → user confirms each suggestion, edits note, confirms post
4. **Optional ADO hop**
   - Append `--chain-ado` to spawn `tools azure-devops timelog add -i -d <date>` per day after each Timely post, OR invoke `/gt:timelog` separately.

## Categorizer Behavior

Heuristic in `src/timely/utils/categorizer.ts` ranks projects by:
- Word similarity (Jaccard) between memory text and past notes / project name (60%)
- Time-of-day overlap with past entries (20%)
- Recency (8-week linear decay) (20%)

Score is summed across all matching corpus entries — high match counts produce scores >1. The skill defers to user confirmation for any score; auto-pick only when `--project` is supplied or when running non-interactive.

## Common User Intents

| User says | Skill action |
|---|---|
| "Log yesterday in Timely" | `tools timely create --day <yesterday> -i` |
| "Fill in this week" | `tools timely create --from <Mon> --to <Fri> -i` |
| "What would be logged for Friday?" | `tools timely create --day <Fri> --dry-run` |
| "Also push to ADO" | append `--chain-ado` |

## When NOT to use this skill

- Just *reading* memories or events → use the underlying commands directly, no skill orchestration needed
- Full Timely → ADO → Clarity sync → `/gt:timelog`
- Editing existing events → not supported yet
