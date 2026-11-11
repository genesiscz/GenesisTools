# tools todo

Project-scoped task tracking for AI-assisted development sessions, with Apple Calendar and Reminders sync. Every todo is a context capsule: it records the git state (branch, commit, staged, unstaged and untracked files), the cwd, the hostname and the agent session id when it is created, so a later session can pick the work up cold.

## Quick start

```bash
# Add a todo to the current project (the git root of the cwd).
# In a terminal, add asks for each of -p, -t and -d that you did not pass.
tools todo add "Fix race in token refresh" \
  --priority high \
  --tag auth \
  -d "Two refresh calls race after a 401"

# List the open todos of this project (done todos are hidden)
tools todo list

# Work on it, then close it with a note (use the id that add printed)
tools todo start todo_9mAKcL39
tools todo complete todo_9mAKcL39 --note "fixed in abc1234"

# A todo that is also a calendar event at a wall-clock time
tools todo add "Call the supplier" --at "2026-09-15 12:00" --sync-to calendar

# The open todos of every project
tools todo list --all
```

## Commands

Every command takes `--project <path>`, the project that owns the todo (see [Projects and ids](#projects-and-ids)). `add`, `edit`, `list`, `show`, `search` and the four status commands also take `-f, --format ai|json|md|table` and `--colors` (see [Output formats](#output-formats)). `start`, `block`, `complete` and `reopen` do not check the `-f` value: an unknown value still changes the status and prints an empty line. The tool itself takes `-v, --verbose`, `--readme` and `-V, --version`.

### Create and change

`add [title]` creates a todo.

| Flag | What it does |
|---|---|
| `-d, --description <text>` | Description text |
| `-p, --priority <p>` | `critical`, `high`, `medium` (default) or `low` |
| `-t, --tag <tags>` | Comma-separated tags |
| `--at <datetime>` | The event start time |
| `-r, --reminder <time>` | An alert on the event. Repeatable |
| `-l, --link <link>` | `pr:123`, `issue:456`, `ado:789` or a URL. Repeatable |
| `-a, --attach <path>` | Copy a file into the todo's store. Repeatable |
| `--md <path>` | Inline the text of a markdown file |
| `-s, --session-id <id>` | Session to stamp, or `current` |
| `--sync-to <target>` | `calendar`, `reminders` or `both`: create it now |
| `--calendar <name>` | Calendar for the event (default `GenesisTools`) |

- The session id defaults to the agent session that runs the command (Claude Code, Codex or Grok). Outside an agent it stays empty.
- Repeatable flags also split on commas, so `--reminder 30m,2h` is two reminders. `-t` is not repeatable: a second `-t` replaces the first, so give one comma list.
- `add` stores any `-p` value as it is given. `edit --priority` accepts only the four names.
- A link is `pr:<n>`, `issue:<n>`, `ado:<n>`, a GitHub pull request or issue URL (stored as `pr` or `issue` with its `owner/repo`), or any other `http(s)` URL. Anything else fails with `Unrecognized link format`.
- `--attach` copies each file to `attachments/<todo id>/<file name>`. Two files with the same name overwrite each other.
- In a terminal (stdin is a TTY), `add` asks for the title, priority, tags and description that the flags did not give. Pass `-p`, `-t` and `-d` to skip those questions. In a script the title is required and nothing is asked.

`edit <id>` changes a todo.

| Flag | What it does |
|---|---|
| `--title <text>` | New title |
| `--description <text>` | New description |
| `--priority <p>` | New priority (one of the four) |
| `--add-tag <tags>` | Add comma-separated tags |
| `--remove-tag <tags>` | Remove comma-separated tags |
| `--at <datetime>` | Set the event start time |
| `--add-reminder <time>` | Add an alert. Repeatable |
| `--add-link <link>` | Add a link. Repeatable |
| `--session-id <id>` | Set the session id, or `current` |
| `--sync-to <target>` | As on `add` |
| `--calendar <name>` | As on `add` |

`edit` cannot remove a reminder or a link, clear `--at`, or empty the description. It appends to the record as it is at write time, so two parallel `--add-tag` or `--add-reminder` edits both land.

### Read

- `list` (alias `ls`) lists todos. Filters: `--status`, `--priority`, `--tag` (comma lists), `--session <id|current>`, and `--all` for every project. Without `--status` it shows `todo`, `in-progress` and `blocked`, so pass `--status done` to see finished work. `--tag a,b` matches a todo with either tag. `--session current` fails when no agent session runs, instead of listing everything.
- `show <id>` prints one todo in full. When the id lives in another project, `show` still prints it and says on stderr which `--project` the other commands need.
- `search <query>` finds a case-insensitive substring in titles, descriptions, inlined markdown and tags, across every status. `--all` searches every project.

### Change the status

- `start <id>` sets `in-progress`.
- `block <id>` sets `blocked`.
- `complete <id>` (alias `done`) sets `done` and records the time. `-n, --note <text>` adds a completion note. Completing a done todo again resets the time, and without `-n` it clears the earlier note.
- `reopen <id>` sets `todo` from any status and clears the completion time and note.

### Calendar and Reminders

- `sync [id] --to calendar|reminders|both` creates the event or the item for a todo that exists already. `--to` is required.
- `sync --all --to <target>` syncs every open todo of ONE project (the `--project` or the cwd's) that has `--at` or a timed reminder. It is not a cross-project `--all` like the one on `list`.
- `--calendar <name>` picks the calendar. `sync` has no `-f` flag, so it always prints its result lines.

See [Apple Calendar and Reminders sync](#apple-calendar-and-reminders-sync).

### Remove, export, import

- `remove <id>` (alias `rm`) deletes the todo and its attachments folder. It asks first in a terminal. In a script it needs `-y, --yes`. It does not delete the calendar event or the Reminders item.
- `export` prints the project's todos, every status, as one JSON array. `-o, --output <file>` writes a file instead and prints the count on stderr. `--all` exports every project.
- `import <file>` adds the todos of a JSON array to ONE project: `--project`, or the git root of the cwd. Each item needs `id`, `title`, `status`, `priority`, `tags` and `context`. An id that the project holds already is skipped.

```bash
tools todo export > todos.json      # or: tools todo export --output todos.json
tools todo import todos.json --project ~/Projects/app
```

`import` ignores the project root each todo recorded, so `export --all` followed by `import` puts every project's todos into one project. Attachment files are not exported: an imported todo keeps the old `storedPath`.

## Timing: `--at` vs `--reminder`

| Flag | Meaning |
|---|---|
| `--at <datetime>` | The event **start** time. One todo is one event. |
| `--reminder <time>` | An **alert** on that event. Repeatable. |

Rules that follow from that:

- **Three wall-clock slots are three todos**, one `--at` each. `--at` is singular, and one todo can only ever be one event.
- **One todo with three `--reminder`s is ONE event with three alerts**, starting at `--at` (or at the latest reminder when `--at` is absent). Use this for "nudge me an hour before, then 15 minutes before".
- With `--at` and no `--reminder`, one alert is placed at the event start.
- An alert later than the start fires at the start.
- The event lasts 30 minutes.

```bash
# THREE slots: three todos, one --at each
tools todo add "Call X (12:00)" --at "2026-09-15 12:00" --sync-to calendar
tools todo add "Call X (14:00)" --at "2026-09-15 14:00" --sync-to calendar
tools todo add "Call X (16:00)" --at "2026-09-15 16:00" --sync-to calendar

# ONE meeting with a 1h and a 15m warning: one todo, two reminders
tools todo add "Call X" \
  --at "2026-09-15 12:00" \
  --reminder "2026-09-15 11:00" \
  --reminder "2026-09-15 11:45" \
  --sync-to calendar
```

Times accept `30m`, `24h`, `3d`, `1w`, `2026-04-02 10:00` (interpreted as local time) or a full ISO string.

- **A relative time counts from now, not from `--at`.** `--at "2026-09-15 12:00" --reminder 1h` puts the alert one hour after you ran the command. For "an hour before", give the absolute time, as above.
- A date with no time (`2026-09-15`) is read as midnight UTC. Always give a time.

## Apple Calendar and Reminders sync

`--sync-to calendar|reminders|both` on `add` and `edit`, or `tools todo sync <id> --to <target>` later. Sync goes through EventKit (the DarwinKit bridge that `tools macos calendar` and `tools macos reminders` also use), not AppleScript.

What each target creates:

- **calendar**: one event in `--calendar` (default `GenesisTools`). Title is the todo title, notes are the description (or `Todo: <id>`), and the start and the alarms follow the timing rules above. The URL is the first plain URL link. Else it is the first `pr` link, then the first `issue` link, when that link carries its `owner/repo` (it came from a full GitHub URL). Only the first link of each type counts: after `pr:142`, a later full pull request URL is ignored. Give only the full URL, or put it first, when the event should link to the pull request.
- When the calendar does not exist, sync creates it (in an iCloud source first, then in a local, CalDAV, MobileMe or Exchange source, in that order). If no source accepts it, the event goes to the first writable calendar. Two calendars with the same name fail the sync.
- **reminders**: one item in the Reminders list `GenesisTools`, with the title, the notes, a due date at the first reminder's time, or at `--at` when the todo has no reminder (none for an untimed todo), the priority (`critical` and `high` both become high) and the same URL. The list must exist already: sync does not create it, and there is no flag to pick another list.
- `sync <id> --to calendar` (or `--to both`) refuses a todo with neither `--at` nor a reminder. `--to reminders` accepts it.

Every run prints its outcome on **stdout**, one line per target, **except under `-f json`**:

```
SYNC_OK calendar todo_l4GVIw27 created 7A1F…-EVENT-ID      # a new EventKit event exists
SYNC_OK calendar todo_l4GVIw27 already-synced 7A1F…        # created earlier, not duplicated
SYNC_FAILED calendar todo_l4GVIw27: <reason>               # stderr, exit code 1
SYNC_SUMMARY calendar ok=3 failed=0 of 3                   # --all only, last line
SYNC_NOOP calendar /path/to/project: <reason>              # --all only, nothing eligible
```

`sync --all` ends with exactly one of `SYNC_SUMMARY` and `SYNC_NOOP`, so a parser always sees the run close. `SYNC_NOOP` is the only line when no open todo has `--at` or a reminder. In `SYNC_SUMMARY`, `ok` and `failed` count todos, and `of` is the number of eligible todos. A todo with any failed target counts as failed, and a failure never turns the run into `SYNC_NOOP`.

🛑 `-f json` suppresses the `SYNC_OK` line, and the sync result is in the record's `reminders[]` instead. `edit` then prints one JSON document to stdout and nothing else, and so does `add` when stdin is not a TTY (a script, an agent, or `< /dev/null`). In a terminal, `add` also prints its prompt frame (the `todo add` header, `Created <id>` and `Done!`) on stdout, so pipe it to `jq` only from a script. `SYNC_FAILED` still goes to stderr and still exits 1. `sync` is unaffected, because it has no JSON mode.

`reminders[].synced` and `reminders[].syncId` are written **only after EventKit returns a real identifier**, so a todo that claims `synced: "calendar"` always has an event behind it. A failure never records one, and never exits 0.

One entry holds one identifier, so neither target overwrites an entry the other owns. Every alert belongs to the one event, so the calendar claims every entry the Reminders item does not own. There is one Reminders item, so it claims a single entry. When the other target owns them all, this one gets a copy of the first entry to write into. That holds in either order, so `--sync-to both`, and `--to reminders` followed by `--to calendar`, both end with two recorded identifiers. Re-syncing then creates neither a second event nor a second item. Two syncs of the same todo at the same time also create one event, because each sync holds a per-todo lock while EventKit works.

```bash
# create and verify
tools todo add "Call X" --at "2026-09-15 12:00" --sync-to calendar -f json   # no SYNC_OK line; see reminders[]
tools todo show <id> -f json            # reminders[0].synced == "calendar", syncId is the event id
tools macos calendar search "Call X"    # the event itself, at the expected local time
```

**Sync creates; it never updates or deletes.** Once a target holds an identifier, a new sync answers `already-synced` and changes nothing. Changing `--at`, adding a reminder, completing or removing the todo leaves the event and the item as they were. Use the identifier from `reminders[].syncId`:

```bash
# move the event (give both ends: the event is 30 minutes long)
tools macos calendar update <event-id> \
  --start 2026-09-15T14:00 \
  --end 2026-09-15T14:30

# delete the event
tools macos calendar delete <event-id>

# tick off the Reminders item (without --complete it is deleted)
tools macos reminders remove <item-id> --complete
```

Permission problems are a TCC issue, not a todo issue: run `tools macos calendar doctor` (or `tools macos reminders doctor`) first.

## How it works

### Storage

Todos are **JSON files**, not a database. Each project gets its own directory:

```
~/.genesis-tools/todo/projects/<hash>/todos.json        # the todos
~/.genesis-tools/todo/projects/<hash>/meta.json         # projectRoot, name, lastAccessed, todoCount
~/.genesis-tools/todo/projects/<hash>/attachments/<id>/ # files added with --attach
~/.genesis-tools/todo/projects/<hash>/todos.json.lock   # held during every write
~/.genesis-tools/todo/projects/<hash>/sync-<sha>.lock   # held while one todo syncs
```

`<hash>` is the first 12 hex characters of the SHA-256 of the project root path. `GENESIS_TOOLS_HOME` moves the whole tree to `$GENESIS_TOOLS_HOME/.genesis-tools/todo/`.

### Projects and ids

**Ids are per-project, never global.** An id is `todo_` plus 8 random characters. The project root is the first folder that holds `.git`, checked from the cwd itself upward. Outside git it is the cwd. `--project <path>` overrides both. An id created under one project is simply absent from another cwd, so every command takes `--project`, and a command that cannot find an id says which project holds it (paths shortened here):

```
Todo not found in this project: todo_9mAKcL39
  searched project: ~/Projects/app
  id lives in:      ~/Projects/notes
  re-run with:      tools todo sync todo_9mAKcL39 --to calendar --project ~/Projects/notes
```

The `re-run with` line is the command you ran, rebuilt from its real arguments, with the right `--project`. When no project holds the id, the message says so and points at `tools todo list --all`.

Two consequences:

- A linked git worktree has its own `.git` file, so each worktree is a separate project from the main checkout.
- `--project` is used as given (made absolute). It is not walked up to a git root, so `--project ~/Projects/app/src` and `--project ~/Projects/app` are two projects.

### Concurrency

Writes are safe under concurrency. Every mutation re-reads `todos.json` while holding the lock file, so parallel `tools todo add` calls from several agents cannot overwrite each other. A writer waits up to 30 seconds for the lock. A lock left by a dead process is taken over. A sync does not hold the store lock during the EventKit call; it holds its own per-todo lock, and it merges its result into the record as it is at write time.

### What a todo records

`-f json` prints the full record:

- `id`, `title`, `description`, `status` (`todo`, `in-progress`, `blocked`, `done`), `priority`, `tags`
- `at`: the event start, as an ISO string
- `reminders[]`: `{ at, label, synced, syncId }`, where `synced` is `calendar`, `reminders` or `null`
- `links[]`: `{ type, ref, repo }`, where `type` is `pr`, `issue`, `ado` or `url`
- `attachments[]`: `{ originalPath, storedPath, filename }`
- `inlineContent`: the text of `--md`
- `sessionId`, `completedAt`, `completionNote`
- `context`: `git` (`branch`, `commitSha`, `commitMessage`, `stagedFiles`, `unstagedFiles`, `untrackedFiles`, `remote`), `cwd`, `projectRoot`, `hostname`, `createdAt`, `updatedAt`

The git context is read from the project root at `add` time (`git rev-parse`, `git log -1`, `git remote get-url origin`, `git status --porcelain`) and never refreshed. `updatedAt` changes on every write. An export carries the hostname, the cwd, the remote URL and the changed file names of every todo, so check it before you share it.

### What it needs

- `git` on the PATH for the context capture. Outside a repository the `git` block is left out.
- For sync only: macOS, and Calendar or Reminders access. macOS grants that access to GenesisTools.app when it is installed (`tools` runs every tool through it), else to the terminal or the agent host that runs the command (also under `GENESIS_TOOLS_NO_APP=1`). `tools macos calendar doctor` and `tools macos permissions` name the identity that needs the grant. A calendar sync needs Add Only or Full Access.
- The tool makes no network calls of its own and costs nothing.

## Configuration

There is no config file. Defaults: the calendar `GenesisTools` (change it per call with `--calendar`) and the Reminders list `GenesisTools` (fixed).

| Variable | Effect |
|---|---|
| `GENESIS_TOOLS_HOME` | Folder that holds `.genesis-tools/` (default: home) |
| `DARWINKIT_TIMEOUT_MS` | Timeout of each Reminders call (default 10000) |

## Output formats

| Format | Prints | Default for |
|---|---|---|
| `md` | Markdown, one section per todo | `add`, `edit`, `show`, status (TTY) |
| `ai` | The same markdown as `md` | every command in a script |
| `table` | ID, Status, Priority, Title, Tags | `list`, `search` (TTY) |
| `json` | The full record, or an array of them | never: pass `-f json` |

- "TTY" and "in a terminal" mean that stdin is a TTY. "Status" means the four status commands. `tools todo list | less`, typed in a terminal, still prints a table, so scripts should pass `-f`.
- Markdown is rendered with colors in a terminal, or anywhere with `--colors`, and printed plain otherwise.
- A markdown section opens with `## [ ] <title>` (`[-]` in progress, `[!]` blocked, `[x]` done), then the id, priority and status, the tags, the branch, commit, session, links and reminders, the completion time and note, the description and the inlined markdown.
- The table has no project column. `list --all -f json` carries each todo's `context.projectRoot`.

## For agents

- Read todos with `-f ai`, parse them with `-f json`. `list`, `search` and `export` print a JSON array. `add`, `edit`, `show` and the status commands print one object.
- Only the todo record, the list and the `SYNC_*` lines go to stdout (plus the one-line `Removed <id>` and `Imported <n> todo(s)` receipts). Progress, notes, warnings and failures go to stderr, so `-f json` output stays parseable when stdin is not a TTY. In a terminal, `add` also prints its prompt frame on stdout.
- Exit code 1 means a failure: an id not found, a `SYNC_FAILED` target, a missing title or `--yes` in a script, an unreadable import file. Cancelling a prompt in a terminal exits 0.
- Carry `--project` forward. If you passed `--project` to `add`, pass it to `show`, `edit`, `sync` and `complete` too.
- `add` stamps the calling agent's session id by itself. At the start of a session, `tools todo list --session current -f ai` lists that session's todos.
- The plugin skill `gt:todo` (`plugins/genesis-tools/skills/todo/SKILL.md`) teaches an agent when and how to call this tool.

## Troubleshooting

- **`Todo not found in this project`**: the id was created under another project root. Run the `re-run with` command it prints, or find the todo with `tools todo list --all -f json`.
- **The todos are gone in a worktree**: each worktree is its own project. Pass `--project <main checkout>`, or use `--all`.
- **A `SYNC_FAILED calendar` line that says `no event time`**: the todo has neither `--at` nor a reminder. Run `tools todo edit <id> --at "2026-09-15 12:00"`, then sync again.
- **`Reminder list "GenesisTools" does not exist`**: create a list with that name in Reminders.app, then sync again.
- **A calendar or Reminders permission error**: run `tools macos calendar doctor` or `tools macos reminders doctor`. A script run (stdin not a TTY) never shows the Reminders access dialog, so run `tools macos reminders doctor --request-access` once from a terminal.
- **The event shows the old time after an edit**: sync never updates an event. Move it with `tools macos calendar update <event-id>`, as shown above.
- **`created <id> but could not record it`**: the event or item exists, but the todo has no record of it, so the next sync creates a second one. Delete the orphan with `tools macos calendar delete <id>` or `tools macos reminders remove <id>` before you retry.
- **A lock timeout after 30 seconds**: a live process held `todos.json.lock` the whole time. Look for a hung `tools todo` process.
- **`add` asks questions in a terminal**: pass `-p`, `-t` and `-d`, or run it from a script.
- **Lost todos in an older transcript**: before 2026-09-14, parallel `add` calls could overwrite each other, and a todo with `--at` and no reminder reported a sync without creating an event. Both are fixed.

## Related

- [`tools macos`](../macos/README.md): `calendar` and `reminders` read, search, change and delete what sync created, and their `doctor` commands explain permissions. `tools calendar` and `tools reminders` are aliases of `tools macos calendar` and `tools macos reminders`.
