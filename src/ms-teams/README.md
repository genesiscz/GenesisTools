# tools ms-teams

Read your Microsoft Teams chats on this Mac without the Teams API. The tool copies the local cache of the New Teams
desktop app (a Chromium IndexedDB) into its own SQLite store, then lists, searches and exports conversations as
markdown, JSON or HTML, shows who joined and left a meeting call, and repairs a Teams cache that lost old chats
without logging you out.

The data is the client cache of the threads you opened in Teams. It is not a server-complete export like Microsoft
Graph: a chat you never opened on this Mac is not there. Only New Teams (`com.microsoft.teams2`) is read; classic
Teams is not.

## Quick start

```bash
tools ms-teams doctor                                   # read-only check of paths, permission and the store
tools ms-teams sync                                     # copy the Teams cache into the local SQLite store
tools ms-teams conversations --with "Alice"             # find the chats with a person
tools ms-teams search "look at it today" --with "Alice" # full-text search over the stored messages

# one chat as markdown on stdout
tools ms-teams show "conversation with Alice Example from 2026-08-06 to 2026-08-06"
# one chat as an HTML file
tools ms-teams show "Weekly planning" --format html --out ~/Projects/app/planning.html
```

The reading commands read the SQLite store, not the live Teams cache. Only inline images and the live call log come
from Teams directly. Run `sync` first, and again when you want newer messages. The tool needs Full Disk Access (see
[How it works](#how-it-works)).

## Commands

Root options: `-v, --verbose` (debug logging), `--readme` (print this file), `-V, --version`.

### Sync and check

- `sync [--force]`: copy the live Teams IndexedDB, dump it and add it to the store. Without `--force` it skips the
  copy when the Teams cache has not changed since the last sync. `--force` re-reads it anyway; stored history is kept
  either way.
- `doctor`: read-only check. It reports the IndexedDB (present and readable), the blob folder, the Python venv,
  whether Teams runs, and the store (its last sync time and its counts of chats, messages, people and calls). It
  never writes.

### Find and read conversations

- `conversations` (also `chats` and `list`, the same command under three names): a table of stored conversations,
  newest activity first.

  | Flag | Meaning |
  |---|---|
  | `--type <type>` | `meeting`, `chat`, `space`, `topic` or `group` |
  | `--with <name>` | a part of a member name, the title or the topic |
  | `--topic <text>` | the same match as `--with` |
  | `--from <date>` / `--to <date>` | last activity after / before this date |
  | `--limit <n>` | max rows, default 40, a positive integer |
  | `--json` | JSON on stdout, with the full ids |

  `--with` and `--topic` both look for a part of the text, not a whole word, in the title, the topic and the member
  list, without case and without diacritics. So `--topic` also matches a member name or email. The table shortens
  long ids (see [Queries](#queries)).

  `group` means every conversation that is neither a meeting nor a one-to-one chat. A conversation of a kind the
  parser does not know is stored as `other`, and `--type other` finds it.

- `show [query...]`: resolve one conversation and export it. See [Queries](#queries) and [Exports](#exports).

  | Flag | Meaning |
  |---|---|
  | `--id <threadId>` | the exact conversation id |
  | `--with <name>` | a participant display name |
  | `--topic <text>` | the topic or the title |
  | `--from <date>` / `--to <date>` | only messages after / before this date |
  | `--format <fmt>` | `md` (default), `json` or `html` |
  | `--json` | the same as `--format json`; on stdout unless `--out` is given |
  | `--out <path>` | write to a file, or into a folder |
  | `--attachments` | also try to download attachments next to `--out` |
  | `--include-system` | keep member-join and similar system events in md and html |
  | `--allow-shrink` | overwrite an `--out` file that holds more messages than this export |

- `search <text...>`: full-text search over the stored message text, newest first. The text matches as one phrase:
  whole words, next to each other, in that order. Case and diacritics do not matter. `--with <name>` keeps hits
  whose sender, chat title or chat members match. `--in <id>` keeps one conversation. `--from <date>` and
  `--to <date>` bound the message time. `--limit <n>` is 50 by default and at most 500. `--json` prints the rows.
  The filters apply to the newest four times `--limit` text matches (200 by default). For a common phrase, raise
  `--limit` (at most 500) so that a filtered search finds older hits.
- `people [query...]` and `people show [query...]`: the people from the Teams profile cache and the chat rosters,
  filtered by name or email. `--json`.
- `members [query...]`: the roster of one conversation. `--id <threadId>`, `--json`.

### Attachments, calls, meetings and activity

- `files ls [query...]`: the attachments of every stored message, or of one conversation (`--id <threadId>` or a
  query). `--json`.
- `files download [query...] --out <dir>`: save the attachments of one conversation into `<dir>`. `--out` is
  required. Name the conversation with a query or `--id <threadId>`. Images that the Teams disk cache holds are copied
  from there. Other files get the same plain HTTPS download as `show --attachments` (see [Exports](#exports)).
- `calls`: the call-history records from the Teams cache (start, type, state, direction, thread). `--json`.
- `meetings` and `meetings list`: the stored meeting chats (up to 100). `--with <name>`, `--json`.
- `meetings attendance [query...]`: who was in each call of one meeting chat, with join and leave times.
  `--id <threadId>`, `--call <callId>` (one call only), `--json`. See [Meeting attendance](#meeting-attendance).
- `mentions`: the activity feed (mentions and reactions) from the Teams cache. `--json`.
- `transcripts [query...]`: the call-transcript and call-recording messages that the cache holds for one meeting or
  chat. `--id <threadId>`, `--json`.

### Repair the live Teams cache

These commands work on the live Teams profile, not on the SQLite store. `--root <path>` points every one of them
except `quit` at another `MSTeams` folder.

- `repair status [--root <path>]`: read-only. It shows whether Teams runs, the profile size, the login folders, the
  size of each cache folder `repair cache` would move, each IndexedDB folder, and the backups in `/tmp`.
- `repair probe <text...> [--root <path>] [--json]`: read-only. It searches the raw live IndexedDB files for a text,
  such as a conversation title. Use it to tell "Teams lost the chat" from "the store is stale".
- `repair quit`: quit Teams. This is not a logout. It ignores the Teams audio driver and the widget extension, which
  stay in the process list, and waits up to 20 seconds for the app to exit.
- `repair idb --yes`: move the `teams.microsoft.com` IndexedDB (the conversation store) aside. Login is kept.
- `repair cache --yes`: move the Service Worker, GPU and shader caches aside. Login is kept. This did not bring back
  vanished chats when it was tried on 2026-07-23 12:46.
- `repair restore <dest> --yes`: move a `/tmp/teams-idb-*` or `/tmp/teams-cache-*` backup back into the live profile.

`idb`, `cache` and `restore` also take `--dry-run` (print the plan, move nothing). `idb` and `cache` take
`--tmp <dir>`, the backup parent (default `/tmp`). Without `--yes` or `--dry-run` these three exit 1 and move
nothing. With `--yes` they refuse to run while Teams is up. The workflow is in
[Repair vanished chats](#repair-vanished-chats).

### MCP server

- `mcp`: start a stdio MCP server over the same store. See [For agents](#for-agents).

## Queries

`show`, `members`, `files`, `transcripts` and `meetings attendance` take a free-text query for one conversation:

```bash
tools ms-teams show "conversation with Alice Example from 2026-08-06 to 2026-08-06"
tools ms-teams show "Weekly planning"
tools ms-teams show "19:abc123@thread.v2"
```

- A raw thread id (`19:…@thread.v2`, `@thread.tacv2` or `@unq.gbl.spaces`) selects that conversation.
- `with <name>` names a participant. `from` or `since`, and `to`, `until` or `till`, bound the dates. A leading
  `conversation`, `chat`, `meeting` or `thread` is dropped. The rest is the topic or title.
- Dates are `2026-08-06`, `2026-08-06 14:30`, `6. 8. 2026`, or plain words such as `yesterday` (chrono-node). A date
  without a time covers the whole local day.
- Names and titles match without case and without diacritics.
- A flag wins over the same part of the query: `--id` on every one of these commands, and on `show` also `--with`,
  `--topic`, `--from` and `--to`.
- With a name, a one-to-one chat with that person wins over a group chat. When several conversations fit equally,
  `show` prints them and asks for `--id`. `members`, `files`, `transcripts` and `meetings attendance` list nothing
  and print only "Pass --id". `meetings attendance` also exits 1 and suggests `tools ms-teams meetings list`.
- Every conversation table (`conversations`, `meetings list` and the `show` candidates) shortens long ids to 35
  characters and a trailing `…`. A one-to-one id is about 90 characters, and a cut id matches nothing (`show` then
  prints "No conversation matched that query."). Take the full id from the command that `show` prints under its
  candidates (it names the first match), or from `tools ms-teams conversations --with "<name>" --json`.

## Exports

`show` prints markdown by default. `--format html` gives one HTML page, and `--json` or `--format json` gives the
thread as JSON (the conversation header and every message, system events included).

- `--out` takes a file, or a folder (a path that ends in `/` or has no extension), which gets `thread.md`,
  `thread.html` or `thread.json`.
- The header names the conversation type, the message count, the time span of the exported messages, and the note
  "client cache of opened threads; not a server-complete history". The count says how many messages were kept from
  earlier syncs (see [The store keeps history](#the-store-keeps-history)).
- In markdown, the messages of one speaker within an hour share one heading. A reply quotes the start of the message
  it answers, and reactions show under the message. JSON also carries the mentions, links and attachments of each
  message. A message deleted in Teams shows `_(deleted in Teams)_` under its last seen text.
- Inline images: Teams serves them from AMS URLs (`eu-api.asm.skype.com`) that answer 401 without your login. The tool
  takes the image bytes from the Teams Chromium disk cache instead, saves them in `~/.genesis-tools/ms-teams/media/`,
  and embeds them in md and html, at most 480 px wide. The export links those local files, so it shows the images
  only on this Mac.
- HTML message bodies are cleaned: scripts, frames, forms, event handlers and `javascript:` or `data:` links are
  removed.
- `--attachments` (with `--out`) also tries a plain HTTPS download of each attachment into an `attachments/` folder
  next to the export. It sends no Teams login, so a file that needs one stays a link. It fetches only from Microsoft
  hosts (Teams, Skype, SharePoint, OneDrive, Office), at most 50 MB and 30 seconds per file.
- **`--out` does not shrink a file.** When the target file holds more messages than the new export, `show` refuses
  to write it. It counts the file itself: the `<!-- msg -->` markers in markdown (the speaker headings in an older
  export), `<article class="msg">` in HTML, the `messages` array in JSON. It also refuses a non-empty file it cannot
  count at all. Pass `--allow-shrink` to overwrite anyway, or write elsewhere.

## The store keeps history

The Teams cache drops old messages over time; the SQLite store does not. Each `sync` upserts by conversation id and
message id:

- It keeps every message it saw before, even with `--force`.
- An edited message is replaced by its newest version.
- A message deleted in Teams is marked deleted and keeps its last seen text.
- The export header counts the messages kept from earlier syncs (`120 messages (35 kept from earlier syncs)`).

## Meeting attendance

`meetings attendance` answers who was in a meeting call at each moment. It joins two local sources:

- The Teams web-client log, which New Teams writes as JSON files under `EBWebView/WV2Profile_tfw/File System/`. Its
  `participant added` and `participant removed` lines give each person's join and leave time, and its call-state lines
  give your own. The log rotates within about a day, so `sync` copies these facts into the store (`call_log_events`).
  `attendance` reads the live log as well.
- The `callEnded` system message in the meeting chat. It lists everyone who was in the call at any time, the
  organizer, and the call start and end. Its per-person durations all equal the call length, so they are not used.

The times are what your client saw. A person who was already in the call when you joined (listed within 2 seconds of
your own join) shows `joinedAtExact: false`, because their real join is earlier. One who stayed after you left shows
`leftAtExact: false`. A person known only from the `callEnded` message has no times. A person who left and came back
gets one row per stay. The table marks inexact times with `<` (already in when you joined) and `>` (still in when
you left). Calls are listed newest first.

`--json` prints one provider-neutral record per call: `provider` (`ms-teams`), `meeting` (`id`, `title`, `callId`,
`organizer`, `scheduledStart`, `scheduledEnd`, `startedAt`, `endedAt`), `observer` (you: `id`, `joinedAt`,
`leftAt`), and `attendance` rows (`name`, `email`, `id`, `self`, `joinedAt`, `leftAt` as ISO 8601 with the local
offset, `joinedAtExact`, `leftAtExact`, `source`). `source` is `ms-teams:web-client-log` or
`ms-teams:call-ended-message`. `tools meetings attendance --from teams` reads this output.

## Repair vanished chats

When old chats vanish in Teams while you are still logged in, the conversation store (IndexedDB) is the part to
reset. Login lives elsewhere in the profile (`Cookies`, `Login Data`, `Local Storage`, `Session Storage`,
`WebStorage`), and no repair command moves those folders.

```bash
tools ms-teams repair probe "Weekly planning"           # 1. is the chat in the live Teams store?
tools ms-teams conversations --topic "Weekly planning"  #    and in the SQLite store?
tools ms-teams repair quit                              # 2. quit Teams (not a logout)
tools ms-teams repair status                            # 3. app: down, login folders: intact
tools ms-teams repair idb --yes                         # 4. move the IndexedDB to /tmp/teams-idb-<unix time>/
open -a "Microsoft Teams"                               # 5. relaunch; the first load is slow
tools ms-teams repair probe "Weekly planning"           # 6. wait until the live store has the chat again
tools ms-teams sync --force                             # 7. then refresh the SQLite store
```

- `repair idb` moves every `https_teams.microsoft.com_*` IndexedDB folder (the `.leveldb` and `.blob` pair). One
  database cannot be taken out of that LevelDB alone, so the pair is the unit.
- `repair cache` is the lighter step for a bloated profile. It moves `Service Worker`, `GPUCache`,
  `DawnGraphiteCache` and `DawnWebGPUCache` from `WV2Profile_tfw`, and `GrShaderCache`, `GraphiteDawnCache`,
  `ShaderCache` and `component_crx_cache` from `EBWebView`. It does not move the HTTP disk cache under
  `~/Library/Containers/com.microsoft.teams2/Data/Library/Caches/`, so inline images stay available to exports.
- After each move the tool prints the backup path (`DEST=…`), the state of the login folders, and the restore
  command. After the relaunch the first load is slow, and the chats refill from the server.
- Do not run `sync --force` before the live IndexedDB exists again (the tool prints this warning too). Until Teams
  has refilled it, the sync reads an empty or partial dump. The store keeps its old messages either way.
- To undo: quit Teams, then `tools ms-teams repair restore /tmp/teams-idb-<unix time> --yes`. Teams recreates the
  moved folders at launch, so `restore` first moves those new folders to `<backup>-replaced-<time>`, which you can
  restore the same way.
- `/tmp` clears on reboot, so a backup can be restored only until the next restart. `repair status` lists the backups
  in `/tmp` only, not under another `--tmp`.

## How it works

**Where the data comes from.** Everything is read from the Teams container on this Mac. The Teams root (the folder
that `--root` replaces) is:

```text
~/Library/Containers/com.microsoft.teams2/Data/Library/Application Support/Microsoft/MSTeams/
```

Under its profile folder `EBWebView/WV2Profile_tfw/`:

- `IndexedDB/https_teams.microsoft.com_0.indexeddb.leveldb` and the `.blob` folder beside it: the conversation store.
- `File System/`: the web-client log, read for meeting attendance.

Inline images come from the Chromium disk cache, `EBWebView/WV2Profile_tfw/Cache/Cache_Data` under:

```text
~/Library/Containers/com.microsoft.teams2/Data/Library/Caches/Microsoft/MSTeams/
```

**What `sync` does.**

1. It copies the live IndexedDB and blob folders into `~/.genesis-tools/ms-teams/snapshot/`. It never reads the
   live LevelDB in place.
2. A Python script (`native/dump_idb.py`) reads the copy with
   [ccl_chromium_reader](https://github.com/cclgroupltd/ccl_chromium_reader) and writes five stores as JSONL under
   `snapshot/dump/`: conversations, messages (`replychains`), profiles, call history and the activity feed.
3. It adds the dump to the SQLite store and stores the call-log facts from the web-client log.

Only one sync runs at a time. A second one waits up to 15 minutes for the first.

**What it needs on the Mac.**

- **Full Disk Access** for the app that macOS holds responsible for the command. `tools` runs every tool through
  GenesisTools.app when it is installed, so the grant goes to GenesisTools.app; under `GENESIS_TOOLS_NO_APP=1` or
  without the app it goes to your terminal. This is the same grant `tools macos messages` needs. Open the pane with
  `tools macos permissions open --pane full-disk-access`.
- **`python3`** and **`git`** on `PATH`. The first `sync` makes a venv at `~/.genesis-tools/ms-teams/venv` and
  installs ccl_chromium_reader from GitHub at a pinned commit. pip needs `git` for that `git+https` URL. That install
  needs the network once.
- New Teams installed and signed in at least once, so its cache exists.

**What it writes.** Everything stays under `~/.genesis-tools/ms-teams/`:

| Path | What |
|---|---|
| `cache.db` | the SQLite store: chats, messages (full-text index), people, calls, activity, call-log facts |
| `cache.db.lock` | the lock of a running sync |
| `snapshot/` | the last IndexedDB copy and its JSONL dump, owner-only (0700) |
| `venv/` | the Python venv for the dumper |
| `media/` | inline images taken from the Teams disk cache, owner-only files (0600) |

`repair` writes only its backups (`/tmp/teams-idb-<unix time>/`, `/tmp/teams-cache-<unix time>/`, or under `--tmp`).

**What touches the network.** The first `sync` (the pip install), `show --attachments` and `files download`.
Everything else is local. Nothing costs money.

## Configuration

There is no config file and no account setup: the tool reads the Teams profile of the macOS user who runs it.

- `GENESIS_TOOLS_HOME` moves the store to `$GENESIS_TOOLS_HOME/.genesis-tools/ms-teams/`. The Teams paths still come
  from your real home folder.
- `--root <path>` on the `repair` commands reads another `MSTeams` folder.

## For agents

- **JSON.** Every listing command takes `--json` and prints JSON on stdout: `conversations`, `show`, `search`,
  `people`, `members`, `files ls`, `calls`, `meetings`, `meetings attendance`, `mentions`, `transcripts` and
  `repair probe`.
- **Exit codes.** An error exits 1 with the message on stderr. A missing store fails with "No Teams cache yet" and
  names `tools ms-teams sync`. `meetings attendance` exits 1 when the query does not resolve to one conversation.
  `repair idb`, `cache` and `restore` exit 1 without `--yes` or `--dry-run`. `show`, `members`, `files` and
  `transcripts` print a message and exit 0 when nothing matches, so check the output, not only the exit code.
- **What writes.** Only `repair quit`, `idb`, `cache` and `restore` change the live Teams. `doctor`, `repair status`
  and `repair probe` write nothing. The other commands write only under `~/.genesis-tools/ms-teams/` (the store and
  `media/`) and to the path you give with `--out`.
- **MCP.** `tools ms-teams mcp` is a stdio server:

  ```json
  { "mcpServers": { "ms-teams": { "command": "tools", "args": ["ms-teams", "mcp"] } } }
  ```

  Its tools answer JSON text:

  - `ms_teams_sync`: a full sync. It always forces the re-read, like `sync --force`.
  - `ms_teams_doctor`: the `doctor` report.
  - `ms_teams_conversations`: `with`, `topic`, `limit` (default 40).
  - `ms_teams_show`: `query`, `id`, `with`, `from`, `to`. It answers the thread (system events included), or the
    resolve result (`status` `ambiguous` or `none`, with `matches`) when no single conversation fits.
  - `ms_teams_search`: `text` (required), `with`, `from`, `to`. Up to 50 hits.
  - `ms_teams_people`: `query`.
  - `ms_teams_files`: `id`.
- **Other readers.** `tools meetings attendance --from teams` runs
  `tools ms-teams meetings attendance <title> --json`. The repository's personal-data probe seeds its local needle
  list from this store (`scripts/ci/harvest-placeholder-markers.ts`).

## Troubleshooting

- **"No Teams cache yet. Run tools ms-teams sync first."** The store does not exist. Run `tools ms-teams sync`.
- **"Teams IndexedDB not found" on `sync`, or `doctor` shows the IndexedDB as missing or not readable.** Full Disk
  Access is missing for the responsible app, or New Teams never ran on this Mac. Grant the access (see
  [How it works](#how-it-works)), then run `tools ms-teams doctor` again. Both the sync error and the `doctor` hint
  say "your terminal". With GenesisTools.app installed, add GenesisTools.app instead.
- **`doctor` shows the blob dir as missing.** This is a warning, not an error. `sync` works without the blob folder.
- **"Teams dump is empty; the snapshot probably failed."** The dump found no conversations and no messages, so
  `sync` refused to accept it. This can happen right after `repair idb`, before Teams has refilled its cache. Wait,
  then sync again. `--force` accepts an empty dump.
- **`sync` warns `Teams store "replychains" was not found`.** Teams renamed a store in its cache, and that part was
  read as empty. This happened on 2026-10-23, when `replychains` became `replychains-2`; the dumper now tries both
  names. A new rename needs a new name in `native/dump_idb.py`.
- **"Could not install ccl_chromium_reader".** The first sync could not reach GitHub, or `git` is missing (pip needs
  it for the pinned `git+https` URL). The error prints the `pip install` command to run by hand.
- **"Could not create a Python venv at …".** `python3` is missing from `PATH`, or it cannot make a venv. Install
  Python 3, then sync again.
- **A chat shows in `conversations` but Teams lost it.** The store keeps what it saw. Ask the live Teams store with
  `repair probe "<title>"`.
- **`repair probe` finds nothing.** It is a raw byte search of the LevelDB files, in UTF-8 and UTF-16LE, and it is
  case-sensitive. LevelDB can compress what it stores, so a miss does not prove the chat is gone. The proof is
  `sync --force`, then `conversations --topic "<title>"`.
- **"ABORT: New Teams is still running".** Run `tools ms-teams repair quit` first. The Core Audio driver
  `MSTeamsAudioDevice.driver` contains "MSTeams" too, but it is not the app: `repair quit` ignores it, and you must not
  kill it. If Teams stays up after 20 seconds, quit it from the Dock.
- **"Several conversations matched. Pass --id from this list".** The query fits more than one chat. The table
  shortens long ids, so an id copied from it matches nothing. The command printed under the table carries the full
  id of the first match. For another match, take its id from `tools ms-teams conversations --with "<name>" --json`.
- **"Could not resolve a single conversation. Pass --id."** (`members`, `transcripts`), **"Could not resolve that
  conversation. Pass --id."** (`files`) or **"Could not resolve a single meeting chat. Pass --id."**
  (`meetings attendance`). These commands list no candidates. Find the full id with
  `tools ms-teams conversations --with "<name>" --json`, then pass it with `--id`.
- **An image shows as a link, not a picture.** Teams never loaded the image into its disk cache on this Mac. Open the
  chat in Teams, scroll to the image, then export again.
- **Logs.** Add `-v` for debug output, and read `~/.genesis-tools/logs/<today>.log` (`rg ms-teams`).

## Related

- [`tools meetings`](../meetings/README.md): meeting notes and attendance. Its `attendance --from teams` reads
  `meetings attendance --json` from this tool.
- [`tools macos`](../macos/README.md): `tools macos messages` reads iMessage from a local database the same way, and
  `tools macos permissions` checks the Full Disk Access grant.
