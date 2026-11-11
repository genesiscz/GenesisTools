# tools timely

A command line client for the [Timely](https://timelyapp.com) time tracker. It reads your accounts, projects,
logged events and auto-tracked activities ("memories"), exports a month in six formats, and turns a day's memories
into logged events, by hand or through a plan file that an agent fills in. Use it to check what you worked on before
you log time to Azure DevOps or Clarity, or to fill in Timely itself without clicking through its calendar.

## Quick start

```bash
# One-time setup: OAuth login, default account, browser cookie for memories (in this order)
tools timely login api-key
tools timely accounts --select
tools timely login cookies

# What you logged on a day, with the memories linked to each event and the ones left unlinked
tools timely events --day 2026-04-20

# What Timely tracked by itself on that day
tools timely memories --day 2026-04-20

# Turn a week of memories into a plan file to fill in (then --apply it, see "Create events")
tools timely create --plan --from 2026-04-20 --to 2026-04-24 --out ./timely-plan.json

# A month of logged time as CSV
tools timely export-month 2026-04 --format csv > time.csv
```

## Commands

Every command takes `-h, --help`. The tool also takes `-v, --verbose` (debug lines on stderr), `--readme` (this
page), and `-?, --help-full` (an extended page with examples). Flags belong to each command: trust
`tools timely <command> --help` over the `-?` page, whose "Global Options" block is older and lists `-f`, `-a` and
`-p` as if every command had them.

### Sign in and choose an account

| Command | What it does |
|---|---|
| `login` | Asks which credential to set up. Without a TTY it exits 1 and names both subcommands. |
| `login api-key` | OAuth2 login for `api.timelyapp.com` (accounts, projects, events). |
| `login cookies [--from-clipboard]` | Stores a browser session cookie for `app.timelyapp.com` (memories). |
| `logout` | Removes the OAuth tokens and the stored cookie. |
| `status [-f json\|table]` | Login state, token lifetime, cookie state, selected IDs, cache size, paths. |
| `accounts [-f json\|table] [-s]` | Lists accounts; `-s, --select` picks the default account. |
| `projects [-f json\|table] [-s] [-a <id>]` | Lists projects grouped by client; `-s` picks a default project. |

`login api-key` asks for your OAuth application's Client ID, Client Secret and Redirect URI the first time
(default `urn:ietf:wg:oauth:2.0:oob`). Create the application at
`https://app.timelyapp.com/settings/oauth_applications`. The command opens the authorize URL in your browser, then
asks you to paste the authorization code. If you are already logged in, it asks before it logs in again.

`login cookies` needs a selected account (run `accounts --select` first). In a browser tab that is logged in to
`https://app.timelyapp.com`, open DevTools, then Network, right-click any request to `app.timelyapp.com`, and choose
Copy, then Copy as cURL. The command takes any of these:

- a whole `curl` command (`-b` / `--cookie`, or `-H 'cookie: ...'`),
- a bare `Cookie: name=value; ...` header line,
- a bare `name=value; ...` string.

It offers the clipboard first, then a paste prompt: a multiline one for a whole curl command (visible while you
paste, wiped on submit) or a hidden one for the header alone. `--from-clipboard` skips every prompt, so it also works
without a TTY. The cookie is saved only after one real request with it returns suggested entries (see How it works).
The value is never printed or logged; only the cookie names and their count are shown.

`logout` keeps the OAuth application credentials and the selected account and project, so the next
`login api-key` asks only for a new authorization code.

`accounts` also prompts for a default when none is selected yet, unless you ask for `--format json`. `accounts` and
`projects` save the fetched list into the config as a side effect.

The default project that `projects --select` stores is shown by `status` and `projects` only. No other command reads
it today: `create` takes `-p` or a suggestion instead.

### Read logged time and memories

**`events`**: logged time entries for a date range, with the memories linked to each event and the day's unlinked
memories. An unlinked memory also shows the event it most likely belongs to, when one matches well enough.

| Flag | Meaning |
|---|---|
| `--from <date>`, `--to <date>`, `--day <date>` | Date filter (`YYYY-MM-DD`). At least one is required. |
| `-f, --format <fmt>` | `table` (default), `json`, `csv`. |
| `-a, --account <id>` | Use another account than the selected one. |
| `--without-entries` | Skip memories: no cookie needed, no unlinked analysis. |
| `--without-details` | JSON only: slim event objects instead of the raw Timely objects. |
| `--force` | Fetch memories fresh instead of from the cache. |

The CSV columns are `date,project,note,hours,minutes,duration_formatted`. The JSON shapes are under For agents.

**`memories`**: auto-tracked activities (Timely calls them suggested entries), grouped by day and app.

| Flag | Meaning |
|---|---|
| `--from <date>`, `--to <date>`, `--day <date>` | Date filter. With only `--from` or only `--to`, that one day. |
| `-f, --format <fmt>` | `table` (default), `json` (the raw memory objects). |
| `-a, --account <id>` | Use another account than the selected one. |
| `--force` | Fetch fresh instead of from the cache. |

**`export-month <YYYY-MM>`**: every event of one month.

| Format (`-f`) | Output |
|---|---|
| `table` (default) | Events per day with day totals and a month total. |
| `json` | The raw Timely event objects. |
| `csv` | Same columns as `events --format csv`. |
| `raw` | One detailed table per event, with its linked entries fetched from `app.timelyapp.com`. |
| `summary` | A markdown report of the month's memories, saved to a file and printed. |
| `detailed-summary` | The same report with more detail per entry and no `# SUMMARIES` header. |

`-a, --account <id>` picks another account. `-s, --silent` (or `-q, --quiet`) makes the two summary formats print
only the report's path. The path is always the first line of their output.

`export-month` downloads the memories of every day of the month before it builds any format, so it needs the cookie
in every format, `csv` and `json` included, unless those days are already cached. It fetches future days of the
month too.

Every format, the two summaries included, needs at least one logged event in the month. Otherwise the command prints
"No events found for this month." and writes no report, even when the month has memories.

The summary formats keep only entries whose title, note or description contains a word from a built-in work list
(meetings, chat, editors, git hosts, error trackers, and similar); everything else is dropped. The list and three
project-name constants live at the top of `src/timely/utils/entry-processor.ts`. Change the constants to your own
repository, project and side-project names, or the report keeps less than you expect.

### Create events from memories

`create` has three modes. `--plan` and `--apply` cannot be combined. All modes use the selected account.

| Flag | Meaning |
|---|---|
| `--day <date>`, or `--from <date> --to <date>` | The days to work on. `--from` needs `--to`. |
| `-p, --project <id>` | Direct mode: post to this project, skip the suggestions. Must be a positive integer. |
| `-n, --note <text>` | Direct mode: the event note. Default: the first three distinct memory titles. |
| `-i, --interactive` | Direct mode: pick project and note per day. The default when stdin is a TTY. |
| `--dry-run` | Print the payloads, post nothing. Works in direct and apply mode. |
| `--plan` | Write a JSON plan instead of posting. |
| `--out <path>` | Where `--plan` writes. Default `-` (stdout). |
| `--apply <path>` | Post the events of a filled plan file. `-` reads stdin. |
| `--yes` | Apply even when validation printed warnings, without asking. |

**Direct mode** (`create --day <date>`) puts all memories of a day into one event. With `-i` it shows the top three
project suggestions (or "Pick another..." to browse the first 50 projects), lets you edit the note, and asks before
each post. Interactive mode is the default in a terminal. With `-p` in a terminal, it skips the project pick and the
note edit, and the only question is the confirmation before each post. Without a TTY and without `-p`, it posts each
day to the top suggestion without asking, and skips a day that has no suggestion. `-i` without a TTY exits 1.
`--dry-run` prints the payload and asks nothing.

```bash
# Pick project and note, confirm each post
tools timely create --day 2026-04-24 -i

# One event, one project; in a terminal it asks once before it posts
tools timely create --day 2026-04-24 -p 4100001 -n "Widgets"

# Print the payload only
tools timely create --day 2026-04-24 -p 4100001 --dry-run
```

**Plan and apply** splits a day across several projects. This is the flow the `gt:timely` plugin skill drives.

```bash
# 1. Write the plan. With --out <file> it also prints a per-day summary of memories and suggestions.
tools timely create --plan --day 2026-04-24 --out ./timely-plan.json

# 2. Fill "events": [] of each day in the file (see the plan format under For agents).

# 3. Validate and print every payload, post nothing
tools timely create --apply ./timely-plan.json --dry-run

# 4. Post. --yes skips the question that validation warnings raise.
tools timely create --apply ./timely-plan.json --yes
```

Apply prints one line per event: `✓ <day>#<n> [proj <id>] event <eventId> (<duration>, <n> memories)`, or
`already applied as event <eventId>` when a receipt says it was posted before. Run `tools timely events --day <date>`
before you post, so you do not log a day twice.

### Cache

| Command | What it does |
|---|---|
| `cache list [-f json\|table]` | Lists every cached file by absolute path. |
| `cache clear` | Deletes the whole cache after a confirmation. Apply receipts are not in the cache. |

## How it works

**Two Timely hosts, two credentials.**

- `api.timelyapp.com/1.1` takes the OAuth2 bearer token. It serves accounts, projects, events, and event creation.
- `app.timelyapp.com` is Timely's web app. It serves memories (`suggested_entries.json`) and entries
  (`entries.json`, used by `export-month --format raw`), and it accepts only a browser session cookie. The bearer
  alone is refused there. `login cookies` was added on 2026-07-29 so memories work again.

A signed-out request to the web host is answered with a redirect to the sign-in page, or with a 200 that carries
the sign-in page, not with a 401. The tool treats a redirect as a refused session on every request, and
`login cookies` stores a cookie only when today's `suggested_entries.json` answers 200 with a JSON array. A
redirect, another status, or an HTML page saves nothing. That check has a 15 second timeout.

**Tokens.** Timely's token response carries no `expires_in`, so the tool assumes Doorkeeper's default lifetime of
two hours from `created_at` and refreshes five minutes before that. Parallel calls that find the token stale share
one refresh request. Before 2026-07-29 the tool refreshed before every request instead.

**Requests to the web host.** Each request has a 30 second deadline. A 429 with `Retry-After` is waited out once,
but only when the wait fits inside the deadline; a longer wait fails at once with a message that names it.
Memories for several days load three at a time. The first day loads alone, so a bad credential stops the run after
one request instead of failing every day. Any other failure on one day is logged, and the run warns that its totals
are incomplete.

**Events created from memories.** Each memory's intervals are merged when the gap between them is 60 seconds or
less, and merged blocks shorter than five minutes are dropped. The event's `from` and `to` are the earliest and
latest interval, its duration is the union of the intervals, and each interval carries `entry_ids` of the form
`tool_tic_<memoryId>`, so Timely shows the memories as linked tiles. The event is marked `created_from: GenesisTools`.

**Project suggestions** are computed locally; no AI model is called. The corpus is your own events of the last 56
days (eight weeks), cached for one day. Each past event scores 0.6 times the word similarity (Jaccard) between the
memories' text and the past note plus project name, plus 0.2 times the time-of-day overlap, plus 0.2 times recency
(linear decay over the 56 days). Events under 0.05 are ignored, the rest are summed per project, and the top three
are kept. Recency alone gives up to 0.2 per event, so any event from the last 42 days passes the 0.05 cut even with
no shared words, and the reason `N similar past entries` counts those events too. A high score with
`top word similarity 0.00` means only that the project was busy recently. Read the reasons before you post to the top
suggestion, above all in direct mode without a TTY, which posts to it without asking.

**Apply receipts make a re-run of an unchanged plan safe.** Before each POST, apply writes a "pending" receipt keyed
by a hash of the account, day, project, sorted memory IDs and the payload, and marks it "created" with the event ID
afterwards. A re-run of an unchanged day reports "already applied" and posts nothing. The payload is rebuilt at
apply time from memories that apply fetches again. If a day's memories changed, the payload and the hash change, and
a re-run posts a second event. That is always possible for today, which is never cached, and after the memories
cache was refreshed (`cache clear`, `memories --force`, or the 30-day expiry) when Timely now returns other
intervals. Apply a day after it has ended, and check `events --day` before a re-run. A receipt left pending (the
process died during the POST) is matched against the day's real events: exactly one event with the same project,
note, bounds and duration (to the minute) counts as created; anything else is an error, never a second POST. A
definite 4xx rejection (not 408, 409, 425 or 429) deletes the receipt, so the next run posts again. A plan that you
change after an apply (another note, other memory IDs) has a new hash, so it posts a new event; it does not update
the old one. Receipts live outside the cache, so `cache clear` can never turn a pending receipt into a blind second
POST. A ledger that an older build kept inside the cache is read as the starting point once.

**Where data lives.** Everything is under `~/.genesis-tools/timely/`:

```text
config.json                              OAuth app, tokens, selected IDs, account and project lists
cookie                                   the browser session Cookie header, mode 0600
apply-receipts/<account-id>.json         create --apply receipts (kept by cache clear)
cache/accounts/<id>/memories/            one file per day, 30 days; today is never cached
cache/accounts/<id>/suggested_entries/   export-month's memories: today 1 hour, other days no expiry
cache/events/<id>/<YYYY-MM>.json         export-month's events: current month 1 hour, others 7 days
cache/accounts/<id>/corpus/              the 56-day event corpus for suggestions, 1 day
cache/accounts/<id>/entries/             entries fetched by the raw format, 7 days
cache/accounts/<id>/entries-<YYYY-MM>-summary.md            summary report, 90 days
cache/accounts/<id>/entries-<YYYY-MM>-detailed-summary.md   detailed-summary report, 90 days
```

"Today" in the cache rules is the UTC date, not your local date.

**What it needs.** A Timely account with an OAuth application, a browser to authorize it and to copy the cookie
from, and clipboard access for `login cookies`. It calls no other tool, needs no macOS permission, and nothing in
it costs money beyond your Timely plan.

## Configuration

`~/.genesis-tools/timely/config.json` holds these keys:

| Key | Set by | Content |
|---|---|---|
| `oauth` | first `login api-key` | `client_id`, `client_secret`, `redirect_uri` |
| `tokens` | `login api-key`, refreshes | `access_token`, `refresh_token`, `token_type`, `created_at` |
| `authenticatedAt` | `login api-key` | Unix seconds of the last code exchange (refreshes keep it) |
| `selectedAccountId` | `accounts --select` | The account every command uses without `-a` |
| `selectedProjectId` | `projects --select` | Shown by `status` and `projects` only |
| `accounts`, `projects` | `accounts`, `projects` | The last fetched lists |
| `cookieUpdatedAt` | `login cookies` | Unix seconds of the last stored cookie |

The file is plain JSON: the client secret and the tokens are not encrypted, so keep the folder private.
`status --format json` prints the config with the secret, both tokens and the cookie masked as `***`. The cookie
itself is in its own `cookie` file with mode 0600, because the config is rewritten through a new file on every
update and would lose a file mode. An older build kept the cookie in `config.json` under `cookie`; the first read
moves it into the file and removes the key.

There are no tool-specific environment variables. `GENESIS_TOOLS_HOME` replaces the home directory for every tool, so
this data moves to `$GENESIS_TOOLS_HOME/.genesis-tools/timely/`.

## For agents

- **JSON output:** `status`, `accounts`, `projects`, `events`, `memories` and `cache list` take `-f json`;
  `export-month` takes `-f json`. Results go to stdout. Log lines (progress, "No events found.", warnings, errors) go
  to stderr, so an empty result leaves stdout empty.
- **`create` writes more than results to stdout.** Direct mode prints its prompts, spinner and log lines there.
  `--plan --out <file>` prints the per-day summary there. `--apply` prints the validation issues, the `--dry-run`
  payloads and one result line per event there; only its closing count is on stderr. Only `--plan` with the default
  `--out -` gives pure JSON on stdout.
- **`events --format json` changes shape.** With memories loaded and at least one unlinked memory, it prints
  `{ "events": [...], "unlinked": [...] }`; otherwise a plain array. `--without-entries` always gives a plain array.
  `--without-details` gives slim events (`id`, `day`, `dayOfWeek`, `project {id, name}`, `duration` as `HH:MM`,
  `note`, `from`, `to`, `entry_ids`, `billed`, `billable`, `cost`, `entries[]`). Each unlinked memory carries `day`,
  `title`, `note`, `duration`, `from`, `to`, and optional `suggested_event {id, score, reasons}` and `sub_entries`.
- **Do not run `create` without `--plan`, `--apply` or `--dry-run` from a script.** Without a TTY it posts each day
  to the top suggestion at once.
- **`accounts` without `--format json`** prompts when no account is selected yet.
- **Exit codes:** 0 on success, also when nothing was found. 1 on any failure: a missing login or account, a bad
  date or month, a refused credential, a plan with validation errors, or an apply where any event failed. An
  `--apply --dry-run` exits 0 even when it prints an event error.
- **Skills:** the `gt:timely` plugin skill (`plugins/genesis-tools/skills/timely/SKILL.md`) drives plan and apply.
  The `/gt:timelog` plugin command (`plugins/genesis-tools/commands/timelog.md`) syncs Timely to Azure DevOps time
  logs and Clarity timesheets.

**The plan file.** `create --plan` writes this shape. You fill `events` for each day; leave a day's `events` empty to
skip it.

```json
{
  "version": 1,
  "generated_at": "2026-04-25T08:00:00.000Z",
  "days": [
    {
      "day": "2026-04-24",
      "available_memories": [
        { "id": 2079040832, "app": "Editor", "note": "web-app", "from": "2026-04-24T09:03:00+02:00",
          "to": "2026-04-24T10:07:00+02:00", "duration_min": 64, "sub_notes": ["owner/repo#42"] }
      ],
      "suggestions": [
        { "project_id": 4100001, "project_name": "Widgets", "score": 2.88,
          "reasons": ["27 similar past entries", "top word similarity 0.00"] }
      ],
      "events": [
        { "project_id": 4100001, "note": "Widgets: checkout form", "memory_ids": [2079040832] }
      ]
    }
  ]
}
```

Apply checks the plan before it posts anything:

| Severity | Rule |
|---|---|
| error | `version` is not 1, or `days`, `available_memories`, `events` or `memory_ids` is not an array |
| error | an event has no `memory_ids` |
| error | `project_id` is missing or not above 0 |
| error | a `memory_id` is not in that day's `available_memories` |
| error | a `memory_id` appears twice in one event |
| warn | a `memory_id` is in more than one event of the same day |
| warn | some memories of a day with events are in no event (the warning gives their minutes) |

One memory's window cannot be split across two projects: pick the project that covers most of it. Look up other
project IDs with `tools timely projects --format json`.

## Troubleshooting

A command that throws prints one `ERROR: <message>` line on stderr and exits 1. The tool has its own explainer
(`src/timely/utils/failure.ts`) with messages such as "Your stored browser session cookie has expired." and "but
your API login is still valid.", but since 2026-10-05 it no longer sees a command's error: the shared CLI runner
catches the error first. The entries below quote the messages you see today.

- **"Not authenticated. Run 'tools timely login' first." or "No access token found."** No OAuth login is stored. Run
  `tools timely login api-key`. From `create`, the same message also means that no account is selected, even when
  the login is valid: run `tools timely accounts --select`.
- **"Memories request for <date> failed (401)" or "... was redirected to a sign-in page (...), so the session was not
  accepted".** The web host refused the memories request. Either no cookie is stored (the web host does not take the
  OAuth token), or the stored cookie has expired. `tools timely status` shows which. Run `tools timely login cookies`
  with a fresh copy, or use `events --without-entries`. `export-month` names the request "Suggested entries for
  <date>", and its raw format "Entry request for <id>".
- **"Token refresh failed: ..." or "API request failed (401): ..."** The OAuth login is dead. Run
  `tools timely login api-key`.
- **"Timely bounced that request to a sign-in page" or "Timely answered 200, but with a sign-in page" during
  `login cookies`.** The tab you copied from was signed out. Sign in, then copy the request again, with every
  `name=value` pair.
- **"No account selected."** Run `tools timely accounts --select`.
- **"Choose a login method in non-interactive mode." or "Pasting a cookie needs a TTY."** Run
  `tools timely login api-key` in a terminal, or `tools timely login cookies --from-clipboard` with the cURL copy on
  the clipboard.
- **A day's memories look incomplete or old.** Past days are cached for 30 days, and "today" is the UTC date, so a
  local day fetched before it ended can stay cached. Run `tools timely memories --day <date> --force`; that also
  rewrites the cache that `events` and `create` read.
- **A month's summary misses days, or `export-month` shows old events.** Export-month fetches every day of the month,
  future days included, and keeps every day except today with no expiry. If you export a month before it ends, its
  later days stay empty, and the day you exported on keeps what Timely had tracked by then. Its events are cached for
  1 hour in the current month and 7 days in other months. Run `tools timely cache clear`, then export again.
- **"... is rate limited by Timely for another Ns, longer than the request deadline."** Timely asked for a pause
  that does not fit in the 30 second request deadline. Wait that long and run the command again.
- **"N of M date(s) could not be fetched ...; the totals below are incomplete."** Some days failed for a reason
  other than a refused credential. Run the command again; the days that worked are cached. If the failed days say
  "returned a non-JSON body (200)", Timely served its sign-in page: the cookie is dead, so run
  `tools timely login cookies`. `export-month` prints "N of M suggested_entries download(s) failed" for the same
  case.
- **`export-month --format raw` prints `[]` and exits 1.** Timely did not return the linked entry of one event, and
  the empty answer is cached for 7 days. Run `tools timely cache clear` and try again, or use `--format json`.
- **"all memories filtered out (too short)" in direct mode.** Every interval of that day was shorter than five
  minutes after merging, so there is nothing to log. The day is skipped.
- **"no flat entries after filter" during apply.** The event's memory IDs are no longer in that day's memories, or
  all their intervals are shorter than five minutes. Make a new plan for that day.
- **"previous apply may have reached Timely; no unique remote event matched the pending receipt."** An earlier apply
  stopped during its POST. Check `tools timely events --day <date>`. If the event is not there, remove the pending
  receipt from `~/.genesis-tools/timely/apply-receipts/<account-id>.json` and apply again. Receipts carry no day:
  each is keyed by a hash and holds only `identity`, `status`, `eventId`, `duration` and `updatedAt`. Find the one
  with `"status": "pending"` and the `updatedAt` of the failed run.
- **An event you deleted in Timely is "already applied".** Its receipt still says "created". Find that receipt in
  the same file by its `eventId`, and remove it to post the event again.
- **Anything else.** Run the command with `-v`, and read `~/.genesis-tools/logs/<today>.log`.

## Related

- [`tools azure-devops`](../azure-devops/README.md): Azure DevOps time logs, the next stop after Timely.
- [`tools clarity`](../clarity/README.md): Clarity PPM timesheets.
- [`tools git`](../git/README.md): `tools git commits`, which `/gt:timelog` reads beside Timely.
- [api.md](api.md): a copy of Timely's public API reference.
- [ReportCreation.md](ReportCreation.md): a manual recipe that turns a `detailed-summary` export into a weekly
  table. The file names it mentions predate the current report path above.
- [Plan.md](Plan.md) and [Plan2.md](Plan2.md): the original implementation plans of this tool.
