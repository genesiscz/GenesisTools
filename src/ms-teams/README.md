# ms-teams

Read Microsoft Teams conversations from the **local New Teams desktop cache** (Chromium IndexedDB), ingest them into SQLite, and export markdown / JSON / HTML.

This is the client cache of threads you have opened. It is not a server-complete Graph export.

The Teams cache drops old messages over time; the SQLite store does not. Each `sync` upserts by conversation id + message id, keeps every message it saw before (even with `--force`), replaces an edited message with its newest version, and marks a message deleted in Teams (`_(deleted in Teams)_`) while keeping its last seen text. The export header counts the messages kept from earlier syncs. `show --out` refuses to overwrite a file that holds more messages than the new export (counted from the file itself: message headings in markdown, `<article class="msg">` in HTML, the `messages` array in JSON), and refuses a non-empty file it cannot count at all, unless you pass `--allow-shrink`.

## Quick start

```bash
tools ms-teams doctor
tools ms-teams repair probe "Weekly planning"
tools ms-teams sync
tools ms-teams conversations --with "Ada"
tools ms-teams show "conversation with Ada Lovelace from 2026-08-06 to 2026-08-06"
tools ms-teams show "Planning" --format html --out /tmp/planning.html
tools ms-teams search "look at it today" --with "Ada"
```

Needs Full Disk Access for your terminal (same as `tools macos messages`).

## Commands

| Command | What |
|---|---|
| `sync` | Snapshot IndexedDB and ingest into `~/.genesis-tools/ms-teams/cache.db` |
| `doctor` | Read-only path / cache / venv check. Never writes. |
| `repair status` | Live profile sizes and auth dirs. Never writes. |
| `repair probe <text>` | Search live IndexedDB files for a title (not the SQLite cache) |
| `repair quit` | Quit the app. Ignores `MSTeamsAudioDevice.driver`. Not logout. |
| `repair idb --yes` | Move `teams.microsoft.com` IndexedDB aside. Conversation store. Keeps login. |
| `repair cache --yes` | Move Service Worker + GPU caches. Did not restore vanished chats. |
| `repair restore <dest> --yes` | Put a `/tmp/teams-{idb,cache}-*` backup back |
| `conversations` (`chats`, `list`) | Inventory table |
| `show [query]` | Resolve one thread and export `md` / `json` / `html` |
| `search <text>` | FTS over message text |
| `people` / `people show` | Profile cache |
| `members` | Roster of one chat |
| `files ls` / `files download` | Attachments |
| `calls` | Call history |
| `meetings` (`meetings list`) | Meeting chats |
| `meetings attendance [query]` | Who was in each call of a meeting chat, with join and leave times (`--id`, `--call`, `--json`) |
| `mentions` | Activity feed |
| `transcripts` | Cached call transcripts / recordings |
| `mcp` | Stdio MCP server |

Natural query examples for `show`:

- `conversation with Ada Lovelace from 2026-08-06 to 2026-08-06`
- `Weekly planning`
- a raw thread id (`19:…@thread.v2` or `@unq.gbl.spaces`)

`--with`, `--from`, `--to`, `--id` flags override the parsed query. Inline AMS images are extracted from the Teams Chromium disk cache into `~/.genesis-tools/ms-teams/media/` and embedded in md/html (the public `eu-api.asm.skype.com` URL is unauthenticated and returns 401). `--attachments` also tries HTTP downloads next to `--out`.

## Meeting attendance

`meetings attendance` answers who was in a meeting call at each moment. It joins two local sources:

- The Teams web-client log, which New Teams writes as JSON files under `EBWebView/WV2Profile_tfw/File System/`. Its `participant added` / `participant removed` lines give each person's join and leave time, and its call-state lines give your own. The log rotates within about a day, so `sync` copies these facts into the SQLite store (`call_log_events`).
- The `callEnded` system message in the meeting chat. It lists everyone who was in the call at any time, the organizer, and the call start and end. Its per-person durations all equal the call length, so they are not used.

The times are what your client saw. A person who was already in the call when you joined shows `joinedAtExact: false` (their real join is earlier), and one who stayed after you left shows `leftAtExact: false`. A person known only from the `callEnded` message has no times. `--json` prints one provider-neutral record per call: `meeting`, `observer`, and `attendance` rows (`name`, `email`, `id`, `self`, `joinedAt`, `leftAt` as ISO 8601 with the local offset, `joinedAtExact`, `leftAtExact`, `source`).
