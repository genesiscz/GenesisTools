# tools clarity

Fills Broadcom (CA PPM) Clarity weekly timesheets from the hours you logged in the Azure DevOps TimeLog
extension. It keeps a local table that says which Clarity task each ADO work item bills, manages the task rows on
your Clarity weeks, and ships a browser dashboard for reviewing a month before it is written.

## Quick start

Clarity reads your hours through `tools azure-devops`, so set that up first, with its TimeLog, in your project
folder (see [Configuration](#configuration)). Then:

```bash
# Sign in once: paste a cURL copied from Clarity in the browser
tools clarity configure auth

# Which work items of the month have hours but no Clarity task yet
tools clarity mappings --date 2026-09 --unassigned

# Map them: by recommendation, or by hand as <workItemId>:<clarityTaskId>
tools clarity mappings --date 2026-09 --apply-recommended
tools clarity mappings --date 2026-09 --assign 123456:7000001

# Preview the September fill (a dry run is the default), then write it
tools clarity fill --month 9
tools clarity fill --month 9 --confirm
```

Run `fill` and `mappings` from the project folder that holds your Azure DevOps config. `tools clarity ui` does the
same steps in a browser dashboard on http://localhost:3071.

## Commands

### Sign-in and configuration: `configure`

| Command | What it does |
|---|---|
| `configure` | The config and a menu: link work items, remove a mapping, sign in again, reset. |
| `configure auth [--driver <id>]` | First sign-in. Tests the connection and saves it. |
| `configure update-auth [--driver <id>]` | Signs in again. Your mappings are kept. |
| `configure show` | Prints the base URL, where the session is kept, the user and every mapping. |
| `configure mappings` | The mapping wizard (the one `mappings` opens in a terminal). |

`--driver` picks how to sign in. The only driver today is `curl`: you copy any `/ppm/rest/v1/` request from the
browser's Network tab as cURL and paste it (several lines are fine, finish with an empty line). The tool reads
the base URL, the `authToken` header and the session cookie from it. Step by step:
[docs/authentication.md](docs/authentication.md).

### ADO work item to Clarity task: `mappings`

The mapping table lives on your Mac. Nothing here writes to Clarity.

```bash
tools clarity mappings                                    # the wizard; --list when not a terminal
tools clarity mappings --list                             # every stored mapping
tools clarity mappings --date 2026-08 --unassigned        # hours logged, no mapping yet
tools clarity mappings --date 2026-08 --assigned          # mappings, with drift against the tree
tools clarity mappings --date 2026-08 --apply-recommended # map every unmapped item that has a recommendation
tools clarity mappings --date 2026-08 --assign 123456:7000001
tools clarity mappings --work-item 123456 234567 --clarity-task "Incidents_Opex"
tools clarity mappings --unlink 234567 --yes
```

| Flag | Meaning |
|---|---|
| `--date <YYYY-MM>` | The month whose ADO entries count. Default: this month. |
| `--list` | Every stored mapping. |
| `--assigned` / `--unassigned` | Work items with hours, mapped or not, and a RECOMMENDED column. |
| `--assign <pairs...>` | Create mappings as `<workItemId>:<clarityTaskId>`. |
| `--work-item <ids...>` | Work items to map onto `--clarity-task` (the two go together). |
| `--clarity-task <name>` | An exact task name, or a part of one that matches one task only. |
| `--apply-recommended` | Map every UNMAPPED work item that has a tree recommendation. |
| `--unlink <ids...>` | Remove the mappings of these work items. |
| `--yes` | Skip the confirmation for unlinking or overwriting a mapping. |
| `--format table\|json` | Output format. Default: `table`. |

- `--assign` and `--clarity-task` accept only a task that is in the catalogue of that month (a row on one of its
  timesheets). Use `tasks --search` to find one that is not, and `tasks --add` to put it on a week.
- `--clarity-task` tries the exact name first, then a part of a name in any case. A part that matches several
  tasks is refused, and the tool lists them.
- Pointing an already mapped work item at another task is named and needs a confirmation, or `--yes`.
- Every write prints a receipt with the `mappings` command that undoes it: `--unlink` for a new mapping, and
  `--assign <workItemId>:<previous task id>` for a replaced or removed one.
- `--assign` reads the work item title from Azure DevOps when the month has no hours on it yet, instead of storing
  the bare id as the title.
- `--assigned` marks a row with a warning sign when the stored mapping points somewhere the ADO tree does not
  ("drift"). `--apply-recommended` never changes a stored mapping: a mapping is your decision, so drift is reported
  and not corrected.

### Task rows on a Clarity week: `tasks`

This command writes to Clarity itself: the task rows that make up a timesheet week. A row must exist before `fill`
can book hours on it.

```bash
tools clarity tasks --date 2026-08                       # catalogue of every week of August
tools clarity tasks --timesheet 7100077                  # catalogue of one timesheet
tools clarity tasks --date 2026-09 --add-from 2026-08-25 --yes   # copy a week's rows onto every week of September
tools clarity tasks --date 2026-09-01 --add 7000005 7000008 --yes
tools clarity tasks --date 2026-09-01 --remove 7000008 --yes
tools clarity tasks --date 2026-09 --search 410001       # a task named D_410001_... or 410001_...
```

| Flag | Meaning |
|---|---|
| `--date <date>` | A day (`YYYY-MM-DD`, its week) or a month (`YYYY-MM`). Default: today. |
| `--timesheet <id>` | One timesheet, no date lookup. |
| `--add <ids...>` | Add these Clarity task ids as rows on the weeks in scope. |
| `--add-from <source>` | Copy the rows of another week (`YYYY-MM-DD` or a timesheet id). |
| `--remove <ids...>` | Remove these rows. A row that carries hours is kept. |
| `--search <terms...>` | Find tasks by name prefix or ADO id, also tasks on no timesheet yet. |
| `--yes` | Skip confirmation prompts. Required in a non-interactive shell. |
| `--format table\|json` | Output format. Default: `table`. |

- `--remove` cannot be combined with `--add` or `--add-from`, and `--search` cannot be combined with any write.
- `--add-from` skips periods Clarity has not opened yet and rows that are already there, and says so.
- Every write prints a receipt with an undo. The undo touches only the weeks and rows the run changed: one `--date`
  command when every week got the same rows, otherwise one `--timesheet` command per week, so a row that was
  already there is never removed.
- `--search` reads Clarity's global task list, not a timesheet. A task that exists but was never added to any
  timesheet has no row, so the catalogue and `mappings` cannot see it; this finds it. A numeric term searches both
  `D_<id>_` and `<id>_` (the trailing `_` keeps `410001` from matching work item `4100019`). The `ON <date>` column
  says, per week, whether `--add` is still needed.

### Writing the hours: `fill`

```bash
tools clarity fill --month 9                  # dry run: the plan per week, nothing is written
tools clarity fill --month 9 --year 2026 --confirm
tools clarity fill --month 9 --confirm --allow-unmapped --no-comments
```

| Flag | Meaning |
|---|---|
| `--month <n>` | Month 1 to 12. Required: without it `fill` prints its help. |
| `--year <n>` | Default: the current year. |
| `--confirm` | Write to Clarity. Without it the run is a dry run. |
| `--dry-run` | Preview only (the default). Cannot be combined with `--confirm`. |
| `--allow-unmapped` | Fill the mapped work items and skip the unmapped ones. |
| `--no-comments` | Do not post the per-week timesheet note. |
| `--verbose` | Has no effect today (see below). |

`fill --help` lists `--verbose` to print each PUT request and response. The flag never reaches `fill`:
`tools clarity` also has a root `-v, --verbose`, and Commander gives the flag to the root wherever it stands. The
root `-v` does not print the PUT lines either.

What a fill does:

1. Exports your ADO TimeLog entries for the month and sums the minutes per day and per Clarity task.
2. Refuses to start while any work item with hours has no mapping, and names them. `--allow-unmapped` overrides
   this. It also refuses when a day with hours falls in no Clarity period, because those hours would be lost.
3. Finds each week's timesheet and row, and prints a table per week (Monday to Friday) plus the note it would post.
4. With `--confirm`, REPLACES the hours, for the days of that month, on each row of a task that has ADO hours in
   the month: a day with no ADO hours becomes zero. Rows of other tasks are not touched. There is no undo. In a
   week that straddles two months, the days of the other month keep what Clarity holds.
5. Posts one note per week, unless the timesheet already carries a note. The note lists each day with Czech day
   names and `d.M.` dates (`Po, 3.11.:`), then `#<id> - <time type> - <comment>` per entry.

A task with no row on a week is reported, and its hours are not booked; add the row with `tasks --add-from` and run
again. A `--confirm` run exits 1 when any hours were not booked. A dry run exits 0 even when it reports missing
rows, so read its output.

### Timesheets: `timesheet`

| Command | What it does |
|---|---|
| `timesheet show <timesheetId>` | One week: rows, hours per day, status. |
| `timesheet list --period <id>` | The carousel of weeks around a time period id. |
| `timesheet submit <timesheetId>` | Submit for approval (asks first). |
| `timesheet revert <timesheetId>` | Reopen a submitted, unapproved week for edits (asks first). |

`show` and `list` take `--format table|json`. `submit` and `revert` always ask and have no `--yes`. The time
period id comes from the Clarity web UI. `tasks --date` finds the timesheet ids for you, so you rarely need `list`.

### The dashboard: `ui` (alias `dashboard`)

`tools clarity ui` runs a Vite dev server for the app in `src/clarity/ui/`, in the background on port 3071, and
opens the browser. The port is strict: a busy port is an error, not a move to the next free one (`--force` stops the
process that holds it, `-p` picks another). The server runs from the GenesisTools checkout and gets the folder you
started it from as `CLARITY_PROJECT_CWD`.

It has these pages: an overview with the sign-in state of ADO, TimeLog and Clarity; Mappings; Export (the month's
ADO timelog); Import (preview and fill the Clarity weeks); and Settings, where you can configure ADO and TimeLog and
paste a fresh Clarity cURL.

| Command | What it does |
|---|---|
| `ui [-i]` | Start in the background and open the browser. `-i` forces the menu. |
| `ui up [-f] [-p <n>] [--force] [--no-open]` | Start. `-f` blocks in the foreground. |
| `ui down` (alias `stop`) `[--no-force]` | Stop. `--no-force` never escalates to SIGKILL. |
| `ui restart` | Stop and start again (same flags as `up`). |
| `ui status` | pid, port, uptime, dependencies, launchd state. |
| `ui open` | Start if needed, print the URL and a QR code, and open it. |
| `ui logs [-n <lines>]` | The last lines of the background log (default 200). |
| `ui attach [-n <lines>]` | Follow the log (prints the last 50 first). Ctrl+C detaches. |
| `ui install` / `ui uninstall` | Register or remove a launchd agent that keeps it running. |

`ui open` takes `-p <n>`, `--no-qr`, `--no-open` (print the URL only) and `-q key=value` (a URL query parameter,
repeatable). `ui install` takes `--force` and `-p <n>`.

Before it starts, the dashboard checks the ADO, TimeLog and Clarity sign-ins and prints a warning with the fix
for each one that failed.

## How it works

- **Where the hours come from.** The Azure DevOps TimeLog extension, through `tools azure-devops`. Its config is
  found from the folder you run in (see [Configuration](#configuration)), so run `fill` and `mappings` from that
  project.
- **Where data lives.**
  - `~/.genesis-tools/clarity/config.json`: the Clarity config and the mapping table (keys under
    [Configuration](#configuration)).
  - The session (`authToken`, `sessionId`, cookies) is in the macOS keychain, item `genesis-tools-clarity` /
    `session`. A session that an older version stored in `config.json` moves to the keychain on the first read.
    `configure show` says where yours is.
  - Dashboard: pid in `~/.genesis-tools/dashboards/clarity.pid`, log in `~/.genesis-tools/logs/clarity.bg.log`,
    launchd label `com.genesis-tools.clarity`.
- **What it calls.** The Clarity REST API at `<baseUrl>/ppm/rest/v1` with your browser session, and the Azure
  DevOps and TimeLog APIs. TLS verification is always on. API reference: [docs/api.md](docs/api.md). Week
  lifecycle, the carousel and the segment format: [docs/timesheet-workflow.md](docs/timesheet-workflow.md).
- **A damaged config is never overwritten.** When `config.json` does not parse or does not match the schema, a command
  that reads it stops and names the file, so a save cannot replace your mappings with an empty list.

### `mappings` and `tasks` are two different things

Both used to be called `tasks`. **`mappings`** edits the local table: which Clarity task an ADO work item bills.
**`tasks`** edits Clarity: the rows of a week. `fill` needs both: a mapping to know the task, and a row on the
week to book it on.

### Recommendations come only from ids in task names

A recommendation may come only from an ADO id found in a Clarity task name, matched against the work item or one
of its ancestors. Project rules such as "an Incident goes to Incidents_Opex" are the operator's judgement and
deliberately live outside this tool.

The id must be a standalone six-digit number in the task name (`D_567890_Technical debt 2026`, `678901_Meetings`).
A letter or digit next to it breaks the match, so an investment code such as `P100001` is not read as work item
`100001`, and an id of any other length is never matched. The closest level of the chain wins: the work item
itself, then its parent, and so on. When two task names carry the same id, neither is recommended.

**The ancestor walk behind that match is unbounded, and must stay unbounded.** It used to stop after three
ancestors. Because the id match is the only evidence-based routing here, an ancestor one level past the ceiling
does not shorten the answer, it erases it: the RECOMMENDED column shows no task and the work item looks like one
with no rule-based home at all. The case that exposed it was a five-level chain (task, user story, feature,
umbrella feature, epic) whose epic named the Clarity task four ancestors up, and the mapping had to be made by
hand. Chains gain a level whenever an umbrella Feature is inserted, so a cap silently drops another work item
each time that happens.

Depth is close to free: `walkAncestorsBatched` spends one request per tree LEVEL shared by every work item of the
month, not one per ancestor, and it reads no comments. Its `attempted` set ends a cyclic chain. See
[../azure-devops/README.md](../azure-devops/README.md) for the walk itself.

### A task Clarity replaced

Clarity can close a task for time entry (`TMA-1026`, `TASK_NOT_OPEN_FOR_TE`) and open a copy with the same name
and investment under a new id. Weeks before the switch carry only the old row, weeks after it only the new one.
`fill` books a mapped task on its own row and, when the week has none, on the one row with the same name and
investment code, and says so. Work mapped to both ids books once, on the row the week has. `tasks --add-from`
lists the copies of each task Clarity refused as closed and, once confirmed, adds the single copy.

## Configuration

**Azure DevOps (required).** Run these once in your project folder:

```bash
tools azure-devops configure "<any Azure DevOps URL of your project>"   # organization and project ids
tools azure-devops timelog configure                                   # the TimeLog key and your TimeLog user
```

They write `.claude/azure/config.json`. Clarity finds it in the working folder or up to three folders above it,
or at the path in `AZURE_DEVOPS_CONFIG`. It needs four values from it: the organization id, the project id,
`timelog.functionsKey` and `timelog.defaultUser`.

**Clarity.** `~/.genesis-tools/clarity/config.json` (mode 0600), written by `configure auth`:

| Key | Meaning |
|---|---|
| `baseUrl` | The Clarity server, read from the pasted cURL. |
| `resourceId`, `uniqueName` | Your Clarity resource id and user name. |
| `auth.driver` | The sign-in driver (`curl`). A config without it was a cURL paste. |
| `mappings` | The mapping table, one entry per work item. Default: empty. |

A mapping entry holds `adoWorkItemId`, `adoWorkItemTitle`, `adoWorkItemType`, `clarityTaskId`, `clarityTaskName`,
`clarityTaskCode`, `clarityInvestmentName` and `clarityInvestmentCode`.

**Environment variables.**

| Variable | Meaning |
|---|---|
| `AZURE_DEVOPS_CONFIG` | The path of the Azure DevOps config, instead of the folder search. |
| `CLARITY_PROJECT_CWD` | The project folder for the dashboard. `ui` sets it to your folder. |
| `NODE_EXTRA_CA_CERTS` | A PEM file, for a Clarity server behind a private CA. |

## For agents

- `mappings`, `tasks` and `timesheet show|list` take `--format json`. JSON goes to stdout.
- Every write that asks first (`tasks` writes, `mappings --unlink`, overwriting a mapping) refuses with exit 1 in a
  non-interactive shell unless you pass `--yes`. `mappings` with no flags prints `--list` when not in a terminal.
- `timesheet submit` and `revert` always ask and have no `--yes`, so they need a terminal.
- `fill` exits 1 when it refuses (unmapped work items, a day in no period). A `--confirm` run also exits 1 when
  any hours were not booked. A dry run exits 0 even when it reports missing rows or unreadable weeks, so read its
  output before you run it again with `--confirm`.
- `fill --verbose` has no effect today (see [Writing the hours](#writing-the-hours-fill)).
- `tools hub timesheet` shows one week from the same month-fill plan the dashboard previews and `fill --confirm` writes (`src/clarity/lib/month-fill.ts`).
- The `genesis-tools:timelog` plugin command walks the whole ADO TimeLog to Clarity routine.

## Troubleshooting

- **`Clarity not configured`**: there is no `config.json` yet. Run `tools clarity configure auth`.
- **`Clarity is not signed in`**: `config.json` exists, but the keychain holds no session. Run
  `tools clarity configure auth`.
- **A 401, or `Clarity API returned a login page (...): session expired`**: the browser session ended (often
  after about 30 idle minutes). Sign in to Clarity in the browser, copy a fresh cURL, and run
  `tools clarity configure update-auth` (or paste it in the dashboard's Settings).
- **`Clarity config ... is not valid`**: the file was edited by hand or is damaged. Fix or move it, then run
  `configure auth`.
- **`No Azure DevOps configuration found`**: the Azure DevOps config was never set up, or you are in the wrong
  folder. Run `tools azure-devops configure "<any Azure DevOps URL of your project>"` in the project, `cd` into the
  project that holds `.claude/azure/config.json`, or set `AZURE_DEVOPS_CONFIG`.
- **`Organization ID missing` or `Project ID missing`**: run `tools azure-devops configure` with a URL of your
  project again.
- **`TimeLog is not configured` or `TimeLog user is not configured`**: the Azure DevOps config has no TimeLog key
  or user. Run `tools azure-devops timelog configure`.
- **`Refusing to fill an incomplete month`**: some work items have no mapping. Map them, or pass
  `--allow-unmapped`.
- **`No time entry row for task ...`**: the week has no row for that task. Run
  `tools clarity tasks --date <YYYY-MM> --add-from <a week that has it>`.
- **`No Clarity period covers <date>`**: Clarity has not opened that period yet. Fill again once it exists.
- **`Clarity has not opened a timesheet for <date> yet`** (from `tasks`, exit 1): the period is not open yet. Run
  the command again once Clarity opens it.
- **A certificate error from Clarity**: your Clarity server uses a private CA. Point `NODE_EXTRA_CA_CERTS` at its
  PEM file.
- **`Could not find vite` on any command**: dependencies are missing. Run `bun install` in the GenesisTools
  checkout.

## Related

- [tools azure-devops](../azure-devops/README.md): work items, the TimeLog extension and its configuration.
- [tools hub](../hub/README.md): `tools hub timesheet`, the Clarity week of a date on the phone.
- [tools timely](../timely/README.md): auto-tracked activity, a check before you log time in ADO.
- [tools dashboards](../dashboards/README.md): every GenesisTools dashboard, this one included.
