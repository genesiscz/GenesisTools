# ms-teams

Read Microsoft Teams conversations from the **local New Teams desktop cache** (Chromium IndexedDB), ingest them into SQLite, and export markdown / JSON / HTML.

This is the client cache of threads you have opened. It is not a server-complete Graph export.

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
| `meetings` | Meeting chats |
| `mentions` | Activity feed |
| `transcripts` | Cached call transcripts / recordings |
| `mcp` | Stdio MCP server |

Natural query examples for `show`:

- `conversation with Ada Lovelace from 2026-08-06 to 2026-08-06`
- `Weekly planning`
- a raw thread id (`19:…@thread.v2` or `@unq.gbl.spaces`)

`--with`, `--from`, `--to`, `--id` flags override the parsed query. Inline AMS images are extracted from the Teams Chromium disk cache into `~/.genesis-tools/ms-teams/media/` and embedded in md/html (the public `eu-api.asm.skype.com` URL is unauthenticated and returns 401). `--attachments` also tries HTTP downloads next to `--out`.
