---
name: gt:todo
description: |
  Manage project-scoped todos with rich context capture, and put timed todos into Apple Calendar or Reminders. Use when the user wants to track tasks, schedule something at a wall-clock time, create reminders, link work items to PRs/issues, or manage work across sessions. Triggers on "add todo", "create task", "remind me to", "schedule a call at", "book a slot", "track this", "todo list", "what's on my plate", "mark done", "complete task", "what should I work on". Also use proactively when the user mentions wanting to remember something for later or needing to follow up.
---

# Todo Management Tool

Create, track, and manage project-scoped todos with auto-captured git context, session tracking, and Apple Calendar / Reminders sync.

Every todo is a **context capsule** — it captures the full git state (branch, commit, staged/unstaged changes), environment info, and session ID at creation time so any future session can pick up the work with zero context loss.

## Two facts to get right before anything else

1. **Ids are per-project, not global.** The store is keyed by the project root, which is the git root of your cwd unless `--project <path>` says otherwise. A todo created with `--project /a/b` is invisible from any other cwd, so **pass the same `--project` to every later command for that todo**. A command that cannot find an id will name the project that holds it.
2. **`--at` is the event start; `--reminder` is an alert on it.** One todo is one calendar event. Three wall-clock slots are **three todos with one `--at` each**. One todo with three `--reminder`s is ONE event with three alarms.

Parallel `tools todo add` calls are safe: every write takes the project lock. (Before 2026-09-14 they silently overwrote each other, so an older transcript showing lost todos is that bug, not yours.)

## CLI Reference

```bash
# Create
tools todo add "Fix the auth bug" \
  --priority high \
  --tag auth,backend \
  --reminder "24h" --reminder "3d" \
  --link pr:142 --link ado:78901 \
  --attach ./screenshot.png \
  --md ./notes.md \
  --description "The OAuth flow breaks when..."

# Create a timed todo AND its calendar event in one call
tools todo add "Call the supplier" --at "2026-09-15 12:00" --sync-to calendar -f json

# List
tools todo list                              # current project, active todos
tools todo list --all                        # all projects
tools todo list --project /path/to/repo      # one specific project
tools todo list --status done                # filter by status
tools todo list --priority critical,high     # filter by priority
tools todo list --tag auth                   # filter by tag
tools todo list --session current            # this agent session's todos
tools todo list --format ai|json|md|table

# Show detail
tools todo show <id> --format ai
tools todo show <id> --project /path/to/repo

# Status transitions (all take --project)
tools todo start <id>
tools todo block <id>
tools todo complete <id> --note "Fixed in commit abc123"
tools todo reopen <id>

# Edit
tools todo edit <id> --priority critical
tools todo edit <id> --add-tag urgent
tools todo edit <id> --add-reminder "1h"
tools todo edit <id> --at "2026-09-15 14:00"
tools todo edit <id> --add-link pr:99

# Search / Remove
tools todo search "auth bug" --all
tools todo remove <id> --yes

# Apple sync (later, or for a todo created earlier)
tools todo sync <id> --to calendar
tools todo sync <id> --to reminders --project /path/to/repo
tools todo sync --all --to calendar
tools todo sync <id> --to calendar --calendar "Work"   # non-default calendar

# Import/Export
tools todo export > todos.json                 # or --output todos.json
tools todo import todos.json
```

## Scheduling something at a wall-clock time

```bash
# ONE meeting at 12:00
tools todo add "Call X" --at "2026-09-15 12:00" --sync-to calendar -f json

# THREE slots at 12:00 / 14:00 / 16:00 — three todos, one --at each
tools todo add "Call X (12:00)" --at "2026-09-15 12:00" --sync-to calendar -f json
tools todo add "Call X (14:00)" --at "2026-09-15 14:00" --sync-to calendar -f json
tools todo add "Call X (16:00)" --at "2026-09-15 16:00" --sync-to calendar -f json

# ONE meeting with a 1h and a 15m warning — one todo, two reminders
tools todo add "Call X" --at "2026-09-15 12:00" \
  --reminder "2026-09-15 11:00" --reminder "2026-09-15 11:45" \
  --sync-to calendar -f json
```

Times accept `30m`, `24h`, `3d`, `1w`, `2026-09-15 12:00` (local time) or a full ISO string.

## Verify a sync — do not assume it worked

`--sync-to` prints its outcome on **stdout**, one line per target:

```
SYNC_OK calendar todo_l4GVIw27 created 7A1F…-EVENT-ID      # the event exists
SYNC_OK calendar todo_l4GVIw27 already-synced 7A1F…        # created earlier
SYNC_FAILED calendar todo_l4GVIw27: <reason>               # stderr, exit code 1
```

With `-f json` on `add` and `edit`, the `SYNC_OK` line is **omitted** so stdout stays one
parseable record. The identifier is in the record itself — read `reminders[].syncId`. The
`tools todo sync` command has no `-f` flag, so it always prints the lines.

`tools todo sync --all --to <target>` ends with exactly ONE of these two lines, so a caller
always sees the run close:

```
SYNC_SUMMARY calendar ok=3 failed=0 of 3                   # last line, at least one todo was eligible
SYNC_NOOP calendar /path/to/project: <reason>               # the only line, nothing was eligible
```

Then confirm both sides:

```bash
tools todo show <id> -f json          # reminders[0].synced == "calendar", syncId is the event id
tools macos calendar search "Call X"  # the event, at the expected local time
```

There is **no `tools calendar` tool of its own** — it is an alias for `tools macos calendar`, which is the real command. If a sync fails on permissions, run `tools macos calendar doctor`; that is a TCC problem, not a todo problem.

## LLM Usage Guidelines

### Always Do

1. **Session id is automatic.** `add` stamps the session of whichever agent runs it
   (Claude Code, Codex or grok). Pass `--session-id <id>` only to override it.

2. **Use `--format ai`** when reading todos back for context:
   ```bash
   tools todo list --format ai
   tools todo show <id> --format ai
   ```

3. **Carry `--project` forward.** If you passed `--project` to `add`, pass it to `show`, `sync`, `edit` and `complete` too. Otherwise the id will not be found from your cwd.

4. **Link external resources** when working on PRs, issues, or ADO work items:
   ```bash
   --link pr:142           # GitHub PR
   --link issue:456        # GitHub issue
   --link ado:78901        # Azure DevOps work item
   --link https://...      # any URL
   ```

5. **Embed context** with `--md ./spec.md` for complex todos.

6. **Set priority** from the conversation: "urgent"/"ASAP"/"critical" → `--priority critical`; "important"/"soon" → `high`; default `medium`; "whenever"/"nice to have" → `low`.

7. **Track status** as you work: `start` when beginning, `complete --note "summary"` when finishing, `block` when stuck.

### Checking Session Todos

At the start of a session:
```bash
tools todo list --session current --format ai
```

Or every active todo for the project:
```bash
tools todo list --format ai
```

### Creating From Conversation

When the user says "remind me to..." or "I need to...", create a todo:
```bash
tools todo add "What the user wants to track" \
  --priority <infer from context> \
  --tag <relevant tags> \
  --link <any relevant PR/issue> \
  --description "Additional context from the conversation"
```

Add `--at "<datetime>" --sync-to calendar` whenever the user names a time or a day, so it also lands in their calendar.

## Output Formats

| Format | Best For | Default When |
|--------|----------|-------------|
| `ai` | LLM consumption, compact | Non-TTY (piped) |
| `table` | Human scanning of lists | TTY list |
| `md` | Detailed single-todo view | TTY show |
| `json` | Machine processing, export | Explicit only |

Only the todo record and the `SYNC_*` lines go to stdout; notes, warnings and failures go to stderr, so `-f json` stays parseable.

## Storage

Todos live at `~/.genesis-tools/todo/projects/<hash>/todos.json`, where `<hash>` is derived from the project root. `meta.json` holds the project path, `attachments/` holds `--attach` files, and `todos.json.lock` serializes writes. Use `--all` to query across every project.
