---
name: gt:timely
description: Create Timely time-log entries from auto-tracked memories. Use when the user says "log my Timely day", "convert memories to events", "fill Timely from yesterday", "create timely entry from memory", "split my day into projects", or "categorize my Timely time". Drives a non-interactive **plan / apply** workflow that lets you (the LLM) split a day's memories across multiple projects. Does NOT cover ADO TimeLog or Clarity sync — for those, defer to /gt:timelog.
---

# Timely Create-from-Memory

Drives the conversation that turns auto-tracked Timely memories into logged events. The new event preserves the memory linkage (visible as auto-tracked tiles in the calendar UI) by passing `timestamps[].entry_ids` of the form `tool_tic_<memoryId>` to the public OAuth `POST /events` endpoint.

> **For full sync (Timely → ADO → Clarity), invoke `/gt:timelog` instead.** This skill is the *missing first hop*: it creates Timely entries. The follow-up ADO/Clarity sync is `/gt:timelog`'s job.

---

## Primary Workflow (LLM, non-interactive)

The plan/apply pattern is the default. It lets you split a day's memories across multiple projects and gives the user a single artifact to review before any POST.

> **DO NOT use python, jq, awk, or shell loops to inspect or edit the plan.** The tool prints the summary itself and you have the `Edit` / `Read` / `Write` tools. Using shell scripts to extract memory IDs is an anti-pattern — it hides your reasoning from the user and is unnecessary now that the tool ships a summary.

### Step 1 — Generate a plan

```bash
tools timely create --plan --from 2026-04-21 --to 2026-04-25 --out /tmp/timely-plan.json
# or for one day:
tools timely create --plan --day 2026-04-24 --out /tmp/timely-plan.json
```

The command does two things:
1. **Writes** the JSON plan file to `--out`
2. **Prints** a compact per-day summary to stdout — this is what you reason over

The summary looks like:

```
=== 2026-04-19 (2 memories) ===
  Suggestions:
    proj  4344283  ČEZ          score  2.88  27 similar past entries · top word similarity 0.00
    proj  5190862  Reservine    score  0.05   1 similar past entries · top word similarity 0.00
  Memories (id  from-to  min  app  note | sub_notes):
    2079040832  21:03-22:07    65m  cmux       col-fe | tools claude usage; col-fe2
    2079063024  22:23-22:29     6m  cmux       col-fe
```

The plan JSON file contains the same data with full ISO timestamps and is the artifact `--apply` consumes.

### Step 2 — Reason from the printed summary (no Read of JSON needed)

Look at the summary the tool printed for:
- App names + notes + sub_notes (often contain repo names, branch names, file paths — strong project signal)
- Time ranges (split a day by morning/afternoon/evening blocks)
- `suggestions[]` (heuristic prior — high score = strong historical pattern, but **don't blindly trust** if the memories clearly say something else)
- Any prior conversation context the user gave you (e.g. "I worked on Reservine in the morning")

State your splits in chat — group memory IDs into time-block buckets per intended project. Be explicit so the user can correct you before you Edit.

### Step 3 — Fill in `events[]` with the Edit tool

Use the `Edit` tool to replace `"events": []` in the plan JSON file with your filled events. **Don't use shell scripts** — the Edit tool is the right primitive.

Multiple events per day are fine — each gets its own project + note + memory_ids subset. Example:

```json
"events": [
  {
    "project_id": 5190862,
    "note": "Reservine — col-fe migration",
    "memory_ids": [2084994045, 2085026565]
  },
  {
    "project_id": 4344283,
    "note": "ČEZ — Timely tooling",
    "memory_ids": [2085118879, 2085658439]
  }
]
```

**Rules:**
- Every `memory_id` must appear in `available_memories[].id` (validation errors otherwise — re-Read the JSON if you forget an ID)
- A `memory_id` should appear in **at most one** event (validation warns on duplicates)
- Memories you intentionally skip (lunch, idle, personal, leisure YouTube/Instagram/Messages-with-partner) — just leave them out. Validation **warns**, doesn't error
- Notes should be human-readable, not just app names. Steal phrasing from `sub_notes[]` (repo names, branch names, PR titles)
- Use `project_id` from `suggestions[]` when it matches your reasoning. Run `tools timely projects --format json` to look up other project IDs
- **Memory linkage caveat**: a single memory's wall-clock window is atomic — you can't split *one* memory across two projects. If memory `X` shows mixed work (e.g. cmux session that touched two repos), pick the dominant project for the whole window

### Step 4 — Verify the file

The Edit tool already wrote the changes. No additional save step needed. If you're worried, `Read` the relevant slice of the file to confirm.

### Step 5 — Dry-run

```bash
tools timely create --apply /tmp/timely-plan.json --dry-run
```

This re-validates and prints each event's `CreateEventInput` payload (with `timestamps[]` filtered to that event's `memory_ids`). Show the user a tight summary:

```
2026-04-21#0 [proj 4250000] DRY 03:21 (5 memories)  Reservine — col-fe migration
2026-04-21#1 [proj 4344283] DRY 04:15 (8 memories)  ČEZ — Timely tooling
```

### Step 6 — Apply

After user confirms:

```bash
tools timely create --apply /tmp/timely-plan.json --yes
```

`--yes` skips the warning confirmation (you've already shown the user the dry-run). On success: `✓ <day>#<N> [proj <id>] event <evId> (HH:MM, N memories)`.

---

## Validation rules (so you can pre-check before --dry-run)

| Severity | Rule |
|---|---|
| error | `memory_id` not in `available_memories` |
| error | duplicate `memory_id` within a single event |
| error | `memory_ids` is empty |
| error | `project_id` ≤ 0 |
| warn | `memory_id` assigned to multiple events on the same day (intentional split) |
| warn | some `available_memories` are not assigned to any event (intentional drop) |

---

## Manual Fallback (Human, no LLM driver)

If the user wants to do it themselves:

```bash
tools timely create --day 2026-04-24 -i                  # clack interactive flow
tools timely create --day 2026-04-24 -p 4344283 -n "..."  # one-shot, all-day, one project
tools timely create --day 2026-04-24 --dry-run           # preview the all-day single-project payload
```

The interactive `-i` flow puts every memory on a day into ONE event (no splitting). For per-memory selection, use the plan/apply flow above.

---

## Read-only context commands

```bash
tools timely status                            # verify OAuth login (run `tools timely login` if not)
tools timely memories --day 2026-04-24         # raw memories for one day
tools timely events --day 2026-04-24           # what's already logged (warn before duplicating!)
tools timely projects --format json            # list project IDs + names
```

Always run `tools timely events --day <date>` before posting to avoid double-logging.

---

## Common User Intents

| User says | First action |
|---|---|
| "Log yesterday in Timely" | `tools timely create --plan --day <yesterday> --out /tmp/p.json`, then read + fill |
| "Fill in this week" | `tools timely create --plan --from <Mon> --to <Fri> --out /tmp/p.json` |
| "Split Friday — morning was Reservine, afternoon ČEZ" | Plan for Friday, place morning memory_ids in one event, afternoon in another |
| "Skip the lunch memories" | Leave their IDs out of every event; validation warns and proceeds |
| "Re-run with the same plan" | Re-run `--apply <path> --yes` |

---

## Categorizer details (for reasoning context)

`src/timely/utils/categorizer.ts` ranks projects by:
- Word similarity (Jaccard) between memory text and past notes / project name (60%)
- Time-of-day overlap with past entries (20%)
- Recency (8-week linear decay) (20%)

Score is summed across all matching corpus entries. High match counts produce scores >1. Use `score` and `reasons[]` as priors; override when the memory text clearly indicates a different project.

---

## When NOT to use this skill

- Just *reading* memories or events → use the underlying commands directly, no skill orchestration needed
- Full Timely → ADO → Clarity sync → `/gt:timelog`
- Editing existing events → not supported yet
