# Todo

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)

> **Task tracking for AI-assisted development sessions, with Apple Calendar and Reminders sync.**

Every todo is a context capsule: it records the git state (branch, commit, staged and unstaged files), the cwd, the hostname and the agent session id at creation time, so a later session can pick the work up cold.

---

## Storage

Todos are **JSON files**, not a database. Each project gets its own directory, named after a SHA-256 hash of the project root:

```
~/.genesis-tools/todo/projects/<hash>/todos.json      # the todos
~/.genesis-tools/todo/projects/<hash>/meta.json       # project root, name, count
~/.genesis-tools/todo/projects/<hash>/attachments/    # files added with --attach
~/.genesis-tools/todo/projects/<hash>/todos.json.lock # held during every write
```

**Ids are per-project, never global.** The project root is the git root of the cwd unless `--project <path>` overrides it. An id created under one project is simply absent from another cwd, so every command takes `--project`, and a command that cannot find an id says which project holds it:

```
Todo not found in this project: todo_9mAKcL39
  searched project: /Users/me/work/app-frontend
  id lives in:      /Users/me/notes/vault
  re-run with:      tools todo sync todo_9mAKcL39 --to calendar --project /Users/me/notes/vault
```

Writes are safe under concurrency. Every mutation re-reads `todos.json` while holding the lock file, so parallel `tools todo add` calls from several agents cannot overwrite each other.

---

## Quick Start

```bash
# Create a task
tools todo add "Fix race in token refresh" --priority high --tag auth

# Create a task that is a calendar event at a wall-clock time
tools todo add "Call the supplier" --at "2026-09-15 12:00" --sync-to calendar -f json

# List open tasks
tools todo list
tools todo list --all                   # every project
tools todo list --project /path/to/repo # one specific project

# Status lifecycle: todo -> in-progress -> done (plus blocked and reopen)
tools todo start <id>
tools todo complete <id> --note "fixed in abc1234"
tools todo block <id>
tools todo reopen <id>

# Search, export, import
tools todo search "token"
tools todo export > todos.json
tools todo import todos.json
```

---

## Timing: `--at` vs `--reminder`

| Flag | Meaning |
|---|---|
| `--at <datetime>` | The event **start** time. One todo becomes one calendar event. |
| `--reminder <time>` | An **alert** on that event. Repeatable; each becomes an alarm before the start. |

Rules that follow from that:

- **Three wall-clock slots are three todos**, one `--at` each. `--at` is singular, and one todo can only ever be one event.
- **One todo with three `--reminder`s is ONE event with three alerts**, starting at `--at` (or at the latest reminder when `--at` is absent). Use this for "nudge me an hour before, then 15 minutes before".
- With `--at` and no `--reminder`, one alert is placed at the event start.

Times accept `30m`, `24h`, `3d`, `1w`, `2026-04-02 10:00` (interpreted as local time) or a full ISO string.

---

## Apple Calendar and Reminders sync

`--sync-to calendar|reminders|both` on `add` and `edit`, or `tools todo sync <id> --to <target>` later. Sync goes through EventKit (`tools macos calendar`), not AppleScript.

Every run prints its outcome on **stdout**, one line per target, **except under `-f json`**:

```
SYNC_OK calendar todo_l4GVIw27 created 7A1F…-EVENT-ID      # a new EventKit event exists
SYNC_OK calendar todo_l4GVIw27 already-synced 7A1F…        # created earlier, not duplicated
SYNC_FAILED calendar todo_l4GVIw27: <reason>               # stderr, exit code 1
SYNC_SUMMARY calendar ok=3 failed=0 of 3                   # --all only, last line
SYNC_NOOP calendar /path/to/project: <reason>              # --all only, nothing eligible
```

🛑 `-f json` suppresses the `SYNC_OK` line. `add` and `edit` print one JSON document to stdout and
nothing else, so the output stays parseable; the sync result is in the record's `reminders[]`
instead. `SYNC_FAILED` still goes to stderr and still exits 1. `sync --all` is unaffected, because
it has no JSON mode.

`reminders[].synced` and `reminders[].syncId` are written **only after EventKit returns a real identifier**, so a todo that claims `synced: "calendar"` always has an event behind it. A failure never records one, and never exits 0.

One entry holds one identifier, so neither target overwrites an entry the other owns. Every alert belongs to the one event, so the calendar claims every entry the Reminders item does not own; there is one Reminders item, so it claims a single entry; and when the other target owns them all, this one gets a copy of the first entry to write into. That holds in either order, so `--sync-to both`, and `--to reminders` followed by `--to calendar`, both end with two recorded identifiers. Re-syncing then creates neither a second event nor a second item.

```bash
# create and verify
tools todo add "Call X" --at "2026-09-15 12:00" --sync-to calendar -f json   # no SYNC_OK line; see reminders[]
tools todo show <id> -f json            # reminders[0].synced == "calendar"
tools macos calendar search "Call X"    # the event itself
```

`--calendar <name>` picks the destination calendar (default `GenesisTools`). Permission problems are a TCC issue, not a todo issue: run `tools macos calendar doctor` first.

---

## Commands

| Command | Description |
|---|---|
| `add [title]` | Create a todo. `--at`, `--reminder`, `--sync-to`, `--link`, `--attach`, `--md`, `--project` |
| `list` \| `ls` | List todos. `--all`, `--status`, `--priority`, `--tag`, `--session`, `--project` |
| `show <id>` | Full detail for one todo |
| `start <id>` | Mark as `in-progress` |
| `block <id>` | Mark as `blocked` |
| `complete <id>` \| `done` | Mark as `done`, `--note` for a completion note |
| `reopen <id>` | Back to `todo` |
| `edit <id>` | Change title, priority, tags, links; add reminders; set `--at`; `--sync-to` |
| `remove <id>` \| `rm` | Delete a todo (`--yes` outside a TTY) |
| `search <query>` | Text search over titles, descriptions, inlined content and tags |
| `sync [id]` | Create the Calendar event / Reminders item. `--to`, `--all`, `--calendar`, `--project` |
| `export` | Emit todos as JSON (`--output <file>`, `--all`) |
| `import <file>` | Import todos from JSON |

Every command that names an id also takes `--project <path>`.

---

## Output formats

| Format | Best for | Default when |
|---|---|---|
| `ai` | LLM consumption, compact | non-TTY (piped) |
| `table` | Human scanning of lists | TTY `list` |
| `md` | Detailed single-todo view | TTY `show` |
| `json` | Machine processing, export | explicit only |

Only the todo record and the `SYNC_*` lines go to stdout. Progress, notes, warnings and failures go to stderr, so `-f json` output stays parseable.
