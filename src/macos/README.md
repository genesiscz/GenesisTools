# tools macos

`tools macos` reads and writes the Mac's own data from the terminal: Apple Mail, Calendar, Reminders, Messages and
Voice Memos, plus clone-aware disk usage on APFS, live Endpoint Security events, swap usage and sleep. It also owns
GenesisTools.app, the signed launcher that holds every macOS privacy grant for all of `tools`, so one grant covers
every terminal, worktree and launchd job. It runs on macOS only.

## Quick start

```bash
tools macos doctor                                # every read-only check in one pass; exits 1 if one fails
tools macos permissions                           # which app holds the grants, and every grant it has
tools macos mail search "invoice" --from 7d       # search Apple Mail (index, or Spotlight plus SQL)
tools macos calendar list --from 2026-04-01 --to 2026-04-30
tools macos reminders add "Buy milk" --list Home --due "2026-04-10T18:00"
tools macos clones measure ~/Projects/app         # what a tree really costs on disk, clones counted once
```

Run `tools macos <command> --help` for the full option list of any command. Three commands also work without the
`macos` word: `tools calendar`, `tools reminders` and `tools voice-memos` are aliases of `tools macos calendar`,
`tools macos reminders` and `tools macos voice-memos`.

## Commands

The top level registers thirteen commands. The sections below group them by job.

### Health and permissions

| Command | What it does |
|---|---|
| `doctor [--json]` | Every read-only check in one pass; exits 1 if one fails |
| `permissions [status] [--json]` | This process's TCC identity and the app's grants; exits 1 while one is missing |
| `permissions build` | Build, sign and install `~/Applications/GenesisTools.app` (needs the Swift toolchain) |
| `permissions test [-- <swift test args>]` | Run the app's Swift tests in the build's own scratch tree |
| `permissions codesign-trust` | One time: let `codesign` sign without the keychain password dialog |
| `permissions retired [--apply] [--json]` | Old app bundles kept for processes that still run them |
| `permissions request [kind] [--reason <text>]` | Show the GenesisTools dialog for one grant, then macOS's own prompt |
| `permissions local-network [--since 2h] [--json]` | Which program made macOS ask about local networks |
| `permissions open [--pane <name>]` | Open a Privacy & Security pane and reveal the app in Finder |
| `permissions ui` | Open the GenesisTools window: grants with Request buttons, launchd services, settings |
| `permissions enable` / `disable` | Route `tools` through the app again, or run it under the terminal's own grants |

`doctor` runs the permissions report, the Calendar doctor, the Reminders doctor and the Notifications status
together. `permissions build` flags:

- `--parts <ids>` builds exactly these optional parts: `host`, `all`, `features`, `hub`, `widget`, `clicky`,
  `markdown`, `recorder`, `meetings`. The default is the parts already installed (the host alone on a fresh install).
- `--add-part <ids>` adds parts to the installed ones.
- `--no-relaunch` leaves the settings, hub, review, widget and Clicky windows closed after the build.

`permissions codesign-trust` asks for the login password once, so that later builds sign with the login keychain's
keys without a dialog. `permissions retired` only reads; `--apply` turns the resources that the old bundles have in
common with the installed one into APFS clones, which a build also does by itself.

`permissions request` kinds: `input-monitoring`, `accessibility`, `microphone`, `speech`, `screen-recording`,
`calendar`, `reminders`, `contacts`, `full-disk-access`, `automation`, `desktop`, `documents`, `downloads`,
`local-network`.

`permissions open --pane` names: `calendars`, `reminders`, `contacts`, `automation`, `speech-recognition`,
`microphone`, `desktop-folder`, `documents-folder`, `downloads-folder`, `full-disk-access`, `accessibility`,
`screen-recording`.

The package scripts are shortcuts for the same commands: `bun run app` and `bun run build:app` run
`permissions build`, `bun run app:status` runs `permissions`, `bun run app:test` runs `permissions test`, and
`bun run build:app-icon` renders the icon.

### Apple Mail

| Command | What it does |
|---|---|
| `mail search <query>` | Search by subject, sender, body and attachment names |
| `mail list [mailbox]` | Recent emails of one mailbox (default `INBOX`, which is every account's inbox) |
| `mail show <message-id>` | One email in full, body included |
| `mail open [rowid] [-m <message-id>]` | Open a message in Mail, by a search's ROWID or its RFC Message-ID |
| `mail download [ids...] --output-dir <dir>` | Write chosen emails as markdown, attachments optional |
| `mail search-download <query> --output-dir <dir>` | Run a search again and write every result to disk as markdown |
| `mail index` | Build or update the searchable index (fulltext, plus embeddings unless `--no-embed`) |
| `mail index cleanup` | Drop index rows for messages deleted from Mail. Writes only to the GenesisTools index |
| `mail monitor` | Report new important emails since the last run |
| `mail accounts` | List the configured mail accounts |

Main flags:

- `search`: `--mode auto|fulltext|hybrid|vector` (default `auto`), `--limit 100`, `--offset 0`, `--from` and `--to`
  (`14h`, `7d`, `YYYY-MM-DD`, ISO, `now`; a date alone as `--to` means the end of that local day), `--mailbox`,
  `--account` (an address or a UUID prefix), `--receiver`, `--help-receivers`, `--without-body` (metadata only),
  `--jxa` (skip the index and run the Spotlight plus SQL `LIKE` fallback), `--semantic` (Apple NL re-ranking after
  RRF; it overwrites the embedding scores, so it is not recommended), `--max-distance 1.2`, `--timeout 60`,
  `--columns`, `-f table|json|toon`.
- `list`: `--limit 20`, `--offset`, `--from`, `--to`, `--sender`, `--receiver`, `--account`, `--unread`, `--read`,
  `--flagged`, `--has-attachment`, `--since-last-check`, `--columns`, `-f table|json|toon`.
- `show`: `--max-chars <n>`, `--body-format text|markdown|html|raw`, `-f text|json|toon`, `--json`.
- `download`: `--ids <a,b>` (instead of the positional ids), `--output-dir <dir>`, `--save-attachments`,
  `--attachments-only`, `--body-max-chars <n>`, `--overwrite` or `--append` for an existing `index.md`, `--yes`.
- `search-download`: the same output flags without `--ids`, plus the search filters `--receiver`, `--account`,
  `--from`, `--to`, `--mailbox`, `--limit 100`, `--mode`, `--jxa` and `--without-body`.
- `index`: `--provider [type]` and `--model [id]` (no value opens a picker), `--limit`, `--from`, `--to`,
  `--no-embed`, `--rebuild-fulltext`, `--rebuild-embeddings`, `--force`.
- `monitor`: `--limit 200`, `--rules <path>`, `--dry-run`, `--preview`, `--notify-telegram`.

The column list for `--columns` is `id, date, from, fromEmail, to, toEmail, cc, ccEmail, subject, mailbox, account,
read, flagged, size, attachments, body, bodyText, bodyHtml, bodyMarkdown, bodyRaw, bodyMatch, ftsSnippet, relevance`.

```bash
tools macos mail list INBOX --limit 20 --from 14h
tools macos mail list INBOX --unread --has-attachment --from 2026-08-01
tools macos mail search "invoice" --mode fulltext --limit 50 -f json
tools macos mail download 12345 12346 --output-dir ./out --save-attachments
tools macos mail search-download "invoice" --from 2026-01-01 --output-dir ./invoices --yes
tools macos mail index --provider ollama           # a non-interactive run must name the provider
```

### Calendar and Reminders

| Command | What it does |
|---|---|
| `calendar doctor [--json] [--request-access]` | Status, calendar count, host app and TCC rows (read-only) |
| `calendar list-calendars` | Every calendar |
| `calendar list [name] [--from] [--to] [-f table\|json\|md]` | Events, of one calendar or all |
| `calendar search <query> [--calendar] [--from] [--to]` | Events by title, notes or location |
| `calendar add <title> --start <datetime>` | New event |
| `calendar update <event-id>` | Change an event's fields |
| `calendar delete <event-id>` | Delete one event |
| `reminders doctor [--json] [--request-access]` | Authorization status, list count, host app and TCC rows |
| `reminders list-lists` | Every reminder list |
| `reminders list [name] [--include-completed] [-f table\|json]` | Reminders, of one list or all |
| `reminders search <query> [--list <name>]` | Reminders by title or notes |
| `reminders add <title>` | New reminder |
| `reminders remove <id> [--complete]` | Delete a reminder, or mark it done with `--complete` |

- `calendar doctor` never asks macOS for access unless `--request-access` is given.
- `calendar add`: `--end` (default 30 minutes after the start), `--calendar` (default `GenesisTools`), `--notes`,
  `--url`, `--location`, `--all-day`, `--alert <minutes>` (repeatable).
- `calendar update`: `--title`, `--start`, `--end`, `--notes`, `--url`, `--location`, `--alert`, `--all-day`.
- `reminders add`: `--list` (default `GenesisTools`), `--due`, `--priority high|medium|low|none` (default `none`),
  `--notes`, `--url`.

```bash
tools macos calendar list-calendars
tools macos calendar list Work --from 2026-04-01 --to 2026-04-30
tools macos calendar search "standup"
tools macos calendar add "Dentist" --start "2026-05-02T10:00" --alert 30
tools macos reminders list Home --include-completed
tools macos reminders remove <id> --complete
```

### Messages and Voice Memos

| Command | What it does |
|---|---|
| `messages list` | Conversations: `--service iMessage\|SMS`, `--from`, `--to`, `--limit 20`, `--page` |
| `messages search <query>` | Messages by text: `--chat <identifier>`, `--from`, `--to`, `--limit 20`, `--page` |
| `messages show <identifier>` | One thread (a phone number or a group ID), printed or written as markdown |
| `messages attachment <id>` | One attachment by the `#ID` that `show` prints: `--download [dest]`, `--open`, `--info` |
| `voice-memos list` | Every memo |
| `voice-memos play <id>` | Play one memo |
| `voice-memos export <id> [dest]` | Copy the memo's audio file to a folder (default `.`) |
| `voice-memos transcribe [id]` | Transcribe one memo, or `--all` |
| `voice-memos search <query>` | Search titles and transcript text |

`messages show` flags: `--from`, `--to`, `--format text|markdown` (markdown when `--output-dir` is set),
`--no-contacts`, `--no-group`, `--output-dir <dir>`, `--md-name <file>` (default `conversation.md`),
`--save-attachments`, `--attachments-only` (implies `--save-attachments`), `--attachments-filter <pattern>`.
The filter takes an ID list such as `#11122,10989` or a regular expression against the attachment name, such as
`IMG_|\.pdf$`. Opaque `*.pluginPayloadAttachment` stubs are renamed by their magic bytes when saved (for example
`11111-image.png`).

`voice-memos transcribe` uses the transcript Apple already stored in the memo (`tsrp`) first, and an AI provider
only when there is none, or with `--force`. Flags: `--lang <code>` (detected when left out), `--provider local-hf|
cloud|openai|groq|openrouter|xai|darwinkit`, `--local` (same as `--provider local-hf`), `--model`, `--format
text|json|srt|vtt`, `-o <path>` (a folder of per-memo files with `--all`), `-c` (copy to the clipboard; it cannot be
combined with `--all`), `--sensitive` (lower thresholds for quiet speakers). Without `--provider`, a terminal gets a
picker of the available providers and a pipe gets an error that names the flag. `tools macos voice-memos` with no
subcommand opens a memo picker in a terminal; in a pipe it lists the memos and prints the subcommands instead.

```bash
tools macos messages list --limit 50
tools macos messages search "meeting"
tools macos messages show "+15555550123" --from 2026-01-01 --to 2026-12-31 \
  --output-dir ./out \
  --md-name chat-2026.md \
  --save-attachments
tools macos messages attachment 11122 --download ./out/attachments
tools macos voice-memos transcribe 3 --provider darwinkit --format srt -o ./memo-3.srt
```

### Disk: clones (APFS)

`tools macos clones` (hidden alias `tools macos apfs`) answers how big a tree really is when many files are APFS
clones of each other, finds the content-identical files that are not clones yet, and turns them into clones. Run it
bare for a guide to the model the flags assume.

| Command | What it does |
|---|---|
| `clones measure [roots...]` | Clone-aware sizes per root (real, du, overcount), with a per-folder breakdown |
| `clones du [folder] [--depth <n>]` | The same, shaped like `du`, for one folder |
| `clones duplicates [roots...]` | Content-identical files and folders that are not clones yet, collapsed to folders |
| `clones optimize [roots...]` | Clone the duplicates under the roots you name (dry run unless `--apply`) |
| `clones reclaim plan [dirs...]` | Find the install trees (worktrees included) and show what `apply` would do |
| `clones reclaim apply [dirs...]` | The same discovery, then clone the duplicates, audited |
| `clones reclaim presets list\|show\|save\|rm\|auto\|run` | Saved selectors, and the daily automatic run |
| `clones reclaim stores [--min-size 1MB]` | bun cache entries no install tree clones (report only) |
| `clones config` | Watched folders, and the floor and filters of the daily scan |
| `clones daemon enable\|disable\|status` | The daily dry-run scan and the daily cache reconciliation |

Common flags:

- `--min-real <size>` is the size floor (default 10MB). It and the other size flags (`clones config --set-min-real`,
  `reclaim stores --min-size`, `presets auto --max-bytes`) need a binary unit (`512B`, `100KB`, `10MB`, `1.5GB`); a
  bare number is refused, so a size never silently means bytes. `--min-real-bytes`, `--min-real-kilobytes` and
  `--min-real-megabytes` take a plain number instead, and passing two of the four is an error.
- `--format auto|table|json|jsonl` (`auto` becomes `json` in a pipe; `presets list` and `reclaim stores` have no
  `jsonl`), `-v`, `--silent`.
- `measure` and `du`: `--top <n>`, `--sort overcount|real|du`, `--no-breakdown`, `--node-modules`, `--include`,
  `--exclude`, `--show-partners` (probe bun's install cache to name cross-tree partners; can take seconds),
  `--no-unique` (skip the clone-deduplicated on-disk figure, which costs a second walk: about 120 to 200 ms on 40k
  files and about 195 s on 5.8 M).
- `duplicates`: `--group` (every member path), `--top 30` (0 is unlimited; JSON always returns all),
  `--prefix-hash` (a 4 KB pre-hash that helps heterogeneous cold scans and may slow warm ones; off by default).
- `reclaim plan|apply` and `presets save`: `--dir <path>` (repeatable), `--worktrees-of <repo>`, `--targets [kinds]`,
  `--keep-partners [ids]`, `--rewrite-stores [ids]`, `--keep-unfreeable`, `--exclude`. `plan` and `apply` take
  `--no-daemon`; `plan` adds `--save <id>`; `apply` adds `--yes` (required without a TTY) and `--no-cache` (ignore
  the 60 s plan snapshot).
- `optimize`: `--apply`, `--rollback --process <id>`, `--list [--limit <n>]`, `--log --process <id>`, `--yes`
  (required for `--apply` and `--rollback` without a TTY), `--no-cache`, `--node-modules`, `--include`, `--exclude`,
  plus the `reclaim` selectors `--dir`, `--worktrees-of` and `--targets`.
- `presets auto <id>`: `--on`, `--off`, `--max-bytes <size>|none`, `--max-files <n>|none`, `--json`.
- `presets run <id>`: `--apply`, `--yes`, `--no-cache`, `--no-daemon`, `--format`.
- `reclaim stores` reports only and never deletes.
- `config`: `--add-dir <paths>`, `--remove-dir <paths>`, `--list` (the config as JSON), `--set-min-real <size>`,
  `--node-modules on|off`. See [Configuration](#configuration) for what each key affects.

```bash
tools macos clones                                         # the guide
tools macos clones measure ~/Projects/app --show-partners
tools macos clones duplicates ~/Projects/app --node-modules
tools macos clones reclaim plan --dir ~/Projects
tools macos clones reclaim plan --dir ~/Projects --worktrees-of app --save app
tools macos clones reclaim apply --dir ~/Projects --yes
tools macos clones reclaim presets list
tools macos clones optimize --rollback --process <id>
```

The details are in [Clones in depth](#clones-in-depth) below.

### System and other

| Command | What it does |
|---|---|
| `eslogger` | Watch Endpoint Security events live through Apple's `eslogger`. Needs root and Full Disk Access |
| `swap` | Processes ranked by swap use, with RSS and uptime |
| `sleep [--after <duration>]` | Put the Mac to sleep now, or after a countdown (`30m`, `1h30m`, `90s`, `2hours`) |
| `control [args...]` | Pass the arguments to `tools control` (UI automation: element control and recording) |
| `clicky-library download [--json]` | Download, verify and unpack the sound pack for Clicky's sound libraries |

- `eslogger` flags: `-e, --events [list]`, `-c, --category [list]`, `--include-fork`, `--filter-event <expr>`
  (repeatable), `-o, --output <file>`, `--input <file>` (`-` for stdin), `-s, --silent`, `-d, --dry-run`,
  `--debug`, `--list-events`. See [eslogger in depth](#eslogger-in-depth).
- `swap` flags: `-l, --limit 30` (how many of the top processes by RSS to scan with `vmmap`), `-t, --top 25` (rows
  shown), `-a, --all` (scan every process with RSS of at least 25 MB; slow), `--json`.
- `sleep` runs `pmset sleepnow`. During a countdown, Ctrl+C cancels it.
- `control` has no help of its own: run `tools control --help` for its commands.
- `clicky-library download` fetches the pinned release asset from the GenesisTools GitHub releases, checks every
  file's sha256, and unpacks it into `~/.genesis-tools/app/clicky-library/<hash>/GenesisTools sounds`, outside the
  signed bundle. A second call reuses the folder.

```bash
tools macos eslogger -c process
tools macos eslogger -e exec --filter-event '.event.exec.target.executable.path =~ "zsh"'
tools macos eslogger --list-events
tools macos swap --top 10
tools macos sleep --after 45m
```

## How it works

### GenesisTools.app owns the privacy grants

macOS keys every privacy grant (Calendars, Reminders, Contacts, Full Disk Access, Accessibility, Automation, Speech,
Microphone, protected folders) to the **responsible process**. For a plain CLI that is the terminal that launched it,
or `bun` itself under launchd, so every terminal needed its own grants and a launchd job had none. Since 2026-09-03
19:40 GenesisTools owns them itself:

- **`GenesisTools.app`** (`src/macos/GenesisTools/`, Swift) is a launcher installed at
  `~/Applications/GenesisTools.app`. `tools` runs every tool through it. The launcher re-spawns itself with the
  `responsibility_spawnattrs_setdisclaim` attribute and then starts the tool, so macOS treats the signed bundle
  `com.genesiscz.genesistools` as the client for the whole process tree, including the DarwinKit child. Grants attach
  to that one identity, and every terminal, worktree and launchd job shares them.
- It is signed with the first available **Developer ID Application** or **Apple Development** certificate
  (`GENESIS_TOOLS_CODESIGN_IDENTITY` overrides). That is what makes the identity survive rebuilds: TCC remembers the
  signing requirement, not the binary hash. An ad-hoc signature works but loses every grant on the next build, and
  `tools macos permissions` says so.
- Without the bundle, or with `GENESIS_TOOLS_NO_APP=1`, `tools` runs the old way under the terminal's grants.
- Children see `GENESIS_TOOLS_APP_BUNDLE_ID=com.genesiscz.genesistools`; `tools macos permissions` and
  `tools macos calendar doctor` read it to say who is responsible.
- The same bundle is also a small app: `open -a GenesisTools`, a Finder double-click or `tools macos permissions ui`
  opens a window with every grant and a Request button (the prompt names GenesisTools, the same identity as the CLI),
  the `com.genesis-tools.*` launchd jobs and whether they run under the app, and a switch that routes `tools` through
  the launcher or not (the marker file `~/.genesis-tools/app/disabled`; also `tools macos permissions enable|disable`).
  The launcher path never loads the window, so a `tools` run stays two tiny processes with no Dock icon.
- The app is a host plus optional parts: `features` (the feature settings window), `hub` (the hub and the diff review
  window), `widget`, `clicky` (keyboard sounds), `markdown` (the markdown viewer), `recorder` (the screen recorder's
  menu bar item and editor) and `meetings`. `permissions build --parts` and `--add-part` choose them.
- The one launchd writer (`src/utils/process/launchd-agent.ts`, used by the dashboards, ai-proxy, the MCP gateway,
  `daemon`, `automate` and the youtube server) puts the launcher first in `ProgramArguments`, so services share the CLI's grants instead of needing rows for
  `~/.bun/bin/bun`. A plist from before the app existed is left alone until the user starts that service again:
  `ui up` boots the job out and rewrites it, `tools daemon restart` and `tools automate daemon install` reinstall it,
  and `status` says so until then. Without the bundle, or with the launcher switched off, the plists come out exactly
  as before.
- The icon is Genesis's amber sparkles on the same dark rounded square, with a golden ring around the mark so the two
  apps are distinguishable; the 16px tile drops the ring, where it would only smudge.
  `src/macos/GenesisTools/scripts/build-icon.swift` renders the iconset and `AppIcon.icns` (both committed);
  `bun run build:app-icon` regenerates them, and the bundle build copies the `.icns` into `Contents/Resources`.

**Who builds the bundle.** `./install.sh` on a fresh clone (when `swift` is available), `tools macos permissions
build` by hand, and `tools update`. Three tools also build it by themselves when it is missing or lacks their part,
which takes about a minute: `tools hub` (also when the app is stale; `--no-build` refuses instead), the
`tools recorder` commands that need the recorder part, and `tools meetings window` (`--no-build` refuses instead).
Other commands never build it on their own. In an interactive terminal, the first permission-gated command
(`calendar`, `reminders`, `mail`, `messages`, `voice-memos`, `control`, or an `eslogger` capture) may offer to
build it when it is missing. A "no" keeps the offer quiet for three days, a Mac without full Xcode gets the install
hint instead, and help pages, `doctor`, `status`, a pipe and `GENESIS_TOOLS_NO_APP=1` never get the offer. Without
the app, a command just runs under the terminal, and the permission dialog names `tools macos permissions build`.

The app lives outside the repo, so a `git pull` never touches it. `tools update` therefore checks it after
installing dependencies:

| Bundle state | What `tools update` does |
|---|---|
| missing | installs it, and prints what now attaches to it plus how to opt out |
| source hash differs from the installed manifest | rebuilds and re-signs it |
| current | nothing |

The missing case mattered on the first update after the app shipped, since no existing user had the bundle and
nobody re-runs `install.sh` to update. A failed build never fails the update: tools keep working under the
terminal's own permissions and the `permissions build` command is printed. Re-signing with the same identity leaves
every TCC row intact, verified by rebuilding with grants in place.

**Cost of the launcher, measured 2026-09-04 00:55** (25 interleaved samples per arm; the machine sat at load
average 27 to 51, so the minimum is the load-robust statistic):

| Arm | min | p25 | median |
|---|---|---|---|
| launcher + `/usr/bin/true` | 18.9 ms | 22.7 ms | 25.1 ms |
| same launcher built Foundation-only | 13.1 ms | 17.4 ms | 19.9 ms |
| no launcher at all | 2.3 ms | 2.9 ms | 4.4 ms |

So a `tools` command pays about 16 ms: roughly 11 ms for the two-stage spawn, which is irreducible because only a
parent can set the disclaim attribute, and about 6 ms for loading AppKit and SwiftUI, which the launcher links only
because the settings window shares its binary. End to end that is 10 to 18 ms on a floor of about 290 ms that bun
startup dominates, and it disappears into the noise on real work (`tools macos mail search` runs 600 ms and more).
**The window was deliberately not split into a second binary**: a non-main executable inside `Contents/MacOS` is not
covered by tccd's BUNDLE_ATTRIBUTION, so the window's own permission prompts could stop being attributed to the
bundle. Six milliseconds is not worth risking the identity the whole design rests on. Re-measure with the same
interleaved method if this ever feels slow.

**Fresh machine:**

```bash
./install.sh                                                  # builds and signs GenesisTools.app
tools macos permissions                                       # identity, signature, and every grant recorded for it
tools macos permissions open --pane full-disk-access          # dialog, pane, and the .app revealed: drag it in
# The first calendar run prompts "GenesisTools would like to access your calendar".
tools macos calendar list --from 2026-09-01 --to 2026-09-30
```

**Full Disk Access** and **Accessibility** have no system prompt. Only Mail, Messages and Voice Memos need Full Disk
Access. When one of those commands hits the missing grant in a terminal, GenesisTools shows its own dialog that says
which command needs it, opens the pane and selects the app in Finder (the "+" picker also lists GenesisTools under
Applications). The dialog shows at most once per hour. `tools macos permissions` only reports;
`tools macos permissions open --pane full-disk-access` shows that dialog on demand (past the once-per-hour limit),
then opens the pane and reveals the app. Files you name on the Desktop, in Documents or in Downloads get the
per-folder system prompt instead, and allowing one folder is enough. Calendars, Reminders, Contacts, Automation and
folders prompt on first use, with GenesisTools as the name in the dialog. The user TCC database is itself behind
Full Disk Access, so `tools macos permissions` treats an unreadable database under GenesisTools.app as "Full Disk
Access missing".

**Local Network.** macOS asks "Allow GenesisTools to find devices on local networks?" the first time any process
under the launcher reaches a device on the LAN: a dev server, a language server inside an editor session, a printer.
GenesisTools itself does not scan the network; the prompt names it because every `tools` process runs under it, and
the Info.plist text says so. macOS keeps the answer in nehelper's rule store
(`/Library/Preferences/com.apple.networkextension.plist`), and an executable outside the installed bundle gets an
answer of its own, keyed by its path. A rebuild moves the running bundle to
`~/.genesis-tools/app/retired.noindex/<ms>/`, so a process still running that old build asks once more on its first
LAN access (2026-10-12 22:00: a language server whose launcher ran the 17:55 build). `tools macos permissions` shows
the installed app's answer and an "Old builds still running" section with each old build, its processes and whether
it will ask. `tools macos permissions request local-network` shows the GenesisTools dialog first, then macOS's
prompt; `request <kind>` works for every grant the window lists. The dialog cannot name the program that asked (its
text is fixed). `tools macos permissions local-network [--since 2h]` reads nehelper's log line for each prompt and
prints the responsible launcher pid, whether it runs an old build, and, while it still runs, its program, folder and
children. The link relay follows that log line live (`log stream`) and shows a panel beside the dialog with the same
facts; it closes when the dialog does (`GenesisTools --local-network-panel --payload <json> --snapshot <png>` renders
it).

### Calendar: three grant levels, and the middle one is the trap

| Grant | `tools macos calendar` sees |
|---|---|
| Full Access | every calendar and event |
| Add Only (write-only) | one placeholder calendar `Calendar` from source `Account`, zero events; `add` still works |
| Denied or none | nothing |

Every read command (`list`, `search`, `list-calendars`, `update`, `delete`) checks the status first and exits 1 with
the fix instead of printing an empty list. In a terminal it first asks macOS to upgrade Add Only to Full Access (a
system dialog; the tool waits up to 15 s for your answer). `tools macos calendar doctor` shows the status, the
responsible identity and every `kTCCServiceCalendar` row. It stays read-only: with no recorded grant it reports that
instead of asking, because the macOS dialog writes a durable TCC row. `--request-access` reads the status even when
that shows the dialog.

### Reminders: the same shape as the Calendar doctor

Every read and write command (`list-lists`, `list`, `search`, `add`, `remove`) asks macOS for Reminders access itself
when the status is still undetermined and the terminal is interactive, instead of failing with DarwinKit's internal
"Call reminders.authorized first." `tools macos reminders doctor` is the Reminders equivalent of
`tools macos calendar doctor`: the authorization status (never asking, so it cannot show the dialog on its own), the
list count once readable, the responsible identity, and every `kTCCServiceReminders` row. Only `--request-access`
asks, and only while macOS has not asked yet.

### `tools macos doctor`: every read-only check in one pass

It runs the permissions report, the Calendar doctor, the Reminders doctor and the Notifications status together, one
section per check, and exits 1 if any of them failed. It calls each check's library function directly instead of
spawning the individual subcommands, so none of them can show a permission dialog or write durable state: the same
read-only contract as each doctor on its own.

### Mail: where the data comes from, search modes, the stage watchdog

The mail commands read Mail.app's own data under `~/Library/Mail/V10` (the Envelope Index database and the `.emlx`
files), read-only, under Full Disk Access. `tools macos mail index` builds a separate index at
`~/.genesis-tools/indexer/macos-mail/index.db` (the `tools indexer` machinery). `search` uses that index when it
exists. Without it, or with `--jxa` or `--without-body`, it runs Spotlight (`mdfind` under `~/Library/Mail`) and a SQL
`LIKE` search on the Envelope Index together. When `--from` or `--to` reaches outside the dates the index covers,
search prints an advisory on stderr.

`--mode fulltext | hybrid | vector | auto` picks the index search; `auto` is hybrid when the index has embeddings.
Two facts that used to cost hours:

- **The hybrid over-fetch used to kill any big page.** Hybrid asks sqlite-vec for `limit × 15` neighbours (3× for the
  RRF pool, 5× for a filtered cosine query), and sqlite-vec refuses `k > 4096`, so `--limit 500` over a month window
  died with `k value in knn query too large, provided 7500 and the limit is 4096` (2026-09-07). The store now clamps
  `k` (`SQLITE_VEC_MAX_K` in `src/utils/search/stores/sqlite-vec-store.ts`), and the search prints one warning saying
  the vector candidate pool was capped and vector recall is reduced. The cap is not a rank boundary: a hybrid result
  anywhere in the page may still carry both scores, and with a selective filter even the first one may lack the
  vector score, so the warning does not name a rank. A pure `--mode vector` search gets its own wording (only the
  4096 nearest neighbours are considered). `--mode fulltext` never had the problem.
- **Every stage has a deadline.** `--timeout <seconds>` (default 60) covers the index query, the row fetch, the
  Spotlight and `LIKE` fallback and the attachments join separately. A stuck stage exits 1 with
  `mail search timed out after 60s in stage "<name>"` instead of a silent process. The limit of that guard: SQLite
  calls are synchronous, so a query that is blocked cannot be interrupted mid-flight. What is guaranteed is that a
  stage which returns after its deadline is reported as a timeout, never as a success. A stage that never settles
  (Spotlight, a lost promise) is cut at the deadline itself. `PROFILE=macos-mail` (the `macos-mail` scope of the
  profiler in `src/utils/profile`) prints one
  `[profile:macos-mail] <stage> <ms>` line per stage for `search` and `list`; `-v` shows the stage transitions. The
  hour-long "hang" a keyword sweep reported on 2026-09-07 did not reproduce: the same queries back to back finish in
  about a second each, and a search with an open stdin pipe exits normally, so the watchdog is insurance, not a fix
  for a known stall.

**Mailbox names** (`list <mailbox>`, `--mailbox`, `--account`): `INBOX` means every account's inbox, localized names
and Gmail's All Mail included. Anything else is a case-insensitive substring of the percent-decoded, NFC-normalized
mailbox URL, so `Deleted Messages`, `Deleted`, `Koš`, `Ko%C5%A1`, `Odstran` and `Archiv` all work; an accent-free
`Kos` does not.

**The index and its embeddings.** The first `mail index` builds the index. Without `--provider` it asks for an
embedding provider and model in a terminal, and a pipe must pass `--provider`; that is needed only while the index
does not exist yet. With `--provider <type>`, or the picker that a bare `--provider` opens, `mail index` also saves
the provider and model in `~/.genesis-tools/ai/config.json` under `defaults.app.mail.embed`. A plain first run asks
and saves nothing. On an existing index, a later run compares the requested model (from `--provider` or `--model`,
else the saved value) with the model of the index. A different model asks before it rebuilds in a terminal; a pipe
exits 1 unless `--force` is given. `--no-embed` keeps the index fulltext-only. A cloud embedding provider bills its
account for every chunk it embeds; a local provider costs nothing.

**Monitor.** `mail monitor` reads the newest `--limit` messages, keeps the ones it has not seen, and flags those that
match a rule. It remembers what it saw in `~/.genesis-tools/macos-mail/seen.db`; `--dry-run` leaves that database
alone, and so does a failed notification. `mail list --since-last-check` shows the mail since the last check. The
built-in rules flag a short list of important senders, subjects about a payment or an invoice, personal mail (exactly
one To recipient) and flagged mail. `--rules <path>` replaces them with a JSON array of
`{ "name": "...", "match": { ... } }` objects, where `match` takes `senderContains`, `subjectContains`,
`subjectNotContains` (lists of substrings), `isPersonal` and `isFlagged`. `--notify-telegram` sends the summary
through the `sayy` command, which must be on `PATH`.

#### Mail benchmarks

`bun src/macos/lib/mail/bench.ts "<label>" [rounds]` runs the arms below interleaved (A, B, C, A, B, C, ...) and
prints the table. Wall time on the measuring machine swings with load, so treat anything under about 20% as noise,
and note the load average. The stage timers say the work itself is small: a fulltext month search spends about 15 ms
in the index query and about 5 ms fetching rows; a month list about 26 ms in SQL and about 42 ms rendering 10,000
JSON rows. The rest of each run of about 330 ms is bun startup plus the launcher.

2026-09-07 17:03, before the knn clamp and the watchdog (load 41.7 / 29.6, 5 interleaved rounds):

| Arm | min | median | max | exit codes | first error line |
|---|---|---|---|---|---|
| list month, limit 10000 | 334ms | 466ms | 1.3s | 0 |  |
| search faktura, fulltext, limit 500 | 358ms | 383ms | 655ms | 0 |  |
| search faktura, auto, limit 500 | 498ms | 730ms | 2.0s | 1 | ERROR: k value in knn query too large |

2026-09-07 17:09, after (load 14.3 / 29.5, 5 interleaved rounds):

| Arm | min | median | max | exit codes | first error line |
|---|---|---|---|---|---|
| list month, limit 10000 | 334ms | 336ms | 348ms | 0 |  |
| search faktura, fulltext, limit 500 | 311ms | 314ms | 380ms | 0 |  |
| search faktura, auto, limit 500 | 643ms | 645ms | 699ms | 0 |  |

The auto arm went from "fails every run" to a working 645 ms or so (the embedding of the query plus the 4096-neighbour
scan sit on top of the fulltext cost). The list and fulltext medians moved by less than the load swing between the two
runs and are noise; the watchdog is a `Promise.race` per stage and adds nothing measurable.

### Messages and Voice Memos: where the data comes from

`messages` reads `~/Library/Messages/chat.db` read-only and resolves phone numbers and addresses to contact names
(`--no-contacts` turns that off). `voice-memos` reads the Voice Memos database (`CloudRecordings.db` or
`Recordings.db`) under `~/Library/Group Containers/group.com.apple.VoiceMemos.shared/Recordings` or one of the older
locations. Both need Full Disk Access. Transcription with a cloud provider bills that provider's account;
`darwinkit` and `local-hf` run on the Mac.

### Clones in depth

The sizes come from the `tools du` extent engine (`src/du/lib/engine.ts`), so `clones measure` and
`tools du clonesize` cannot drift. This group adds what `du` deliberately lacks: finding duplicates and writing clones
back. "real" is the bytes that deleting a tree would actually free; `du -sh` counts every clone copy in full, so a
bun-installed `node_modules` (mostly clones of the install cache) looks several times bigger than it is. A
postinstall that copies a file instead writes a private full copy that every worktree pays for again; those private
copies are what `reclaim` collapses back into shared extents.

**Reclaim across worktrees.** `reclaim` finds the install trees under a folder (`node_modules`, composer `vendor`,
`Pods`, `.cxx`; the gitignored ones by default), including the git worktrees of a repo that live beside it, and
matches duplicates ACROSS those trees. `plan` rewrites nothing (its one durable side effect is the daemon
registration below; `--no-daemon` skips it). `apply` clonefiles each duplicate onto one keep copy after a typed
confirmation and writes an audit you can roll back. A preset (`--save <id>`, `presets run <id>`) stores the selector,
never file paths, so it stays correct after a branch switch.

**Not only install folders.** `--targets all` makes each searched folder (each worktree with `--worktrees-of`) a root
of its own, so every file at or above `--min-real` counts: a tracked binary that every worktree checks out again,
published assets, fixtures. `.git` is pruned, and a checkout that lies inside another root (the worktrees that
`git worktree list` reports under the repo's own `.worktrees/`, or any other nesting) is walked once: the check
compares paths, it knows no folder name. On 2026-10-19 the install-folder plan of a PHP repo with 28 checkouts found
0 bytes (its worktrees have no `vendor` or `node_modules`), while `--targets all --min-real 100KB` cloned 1561 files
for 1.59 GB, 1.07 GB of it one tracked 38 MB binary. A `find -name` pattern in `--targets` matches folder names only,
so `--targets rr` never finds a file called `rr`; pass `--targets` with no value to see the choices. `optimize
<roots...>` always scans every file under the roots it is given; `reclaim` with `all` is the form a preset can save
and `presets auto --on` can run daily:

```bash
tools macos clones reclaim presets save app-all \
  --dir ~/Projects/app \
  --worktrees-of ~/Projects/app \
  --targets all \
  --min-real 100KB
tools macos clones reclaim presets auto app-all --on
```

**Package-manager stores.** bun, npm, pnpm, yarn and composer caches are keep-only: a file inside one can win as the
copy everything else points at, and is never written. They join a set only with `--keep-partners`, and only bun can
currently resolve a candidate; the others report their root and nothing else. `--rewrite-stores bun` also rewrites a
store file onto a byte-identical file of the same store.

**Two things called a plan.** A *preset* is the selector you saved. It stores what you typed, never file paths, and
every run rediscovers the trees, so it stays right for months. A *snapshot* is the keep and replace list, cached for
60 seconds with the mtime of each root. An `apply` that follows a `plan` reuses it only while every root is
unchanged; otherwise it rescans. It proves that nothing it names has changed, never that it is still complete: a
duplicate created after the plan is not in it, which is why the window is one minute and not an hour. Speed on a
later run comes from the per-file metadata cache, which skips hashing files whose size and mtime did not move.

**Safety.** A dry run is the default, and `apply` is a separate verb that asks for a typed confirmation (`--yes`
without a TTY). Every clone is byte-compared first, swapped atomically, and hashed again after. Undo a run with
`tools macos clones optimize --rollback --process <id>`.

**Automatic runs.** An armed preset has no limits by default (since 2026-10-19; the 5 GB and 500-file defaults
before it had no measured reason, and a set with more files than the cap was never cloned at all): every run clones
every set the plan finds, each one byte-compared before the swap and rolled back with
`optimize --rollback --process <id>`. `presets auto <id> --max-bytes 50GB --max-files 2000` sets a limit and
`--max-bytes none` removes it; the first run after `--on` is still a dry run. `presets save <id>` over an existing
preset is an edit: it keeps `createdAt`, the auto settings and the last run, and a changed selector makes the next
auto run a dry run again. `optimize --list --limit <n>` reads only the newest N runs.

**The native walk.** On macOS the walk runs in the `tools du` native core (`clonesize --bigfiles`): one parallel
`getattrlistbulk` pass over every root that returns only the files at or above the size floor, about 14x faster than
the in-process walk on `node_modules` trees (a fleet of 233 roots and 13.7M files lists in under 40 s instead of 8
minutes). It is used automatically when the floor is at least 1 MB; `nativeWalk: false` in the library, or a machine
without clang, falls back to the in-process walk.

**The daily tasks.** Every finished `reclaim plan` (and `apply`, and a preset run) registers two daily `tools daemon`
tasks when they are not registered yet, and prints a `recorded: daemon tasks` line when it did. An existing
registration is left alone unless its script file is gone (a deleted worktree), which it repairs. `--no-daemon`
skips it for one invocation. `tools macos clones daemon disable` is the permanent opt-out: it unregisters both tasks
AND stores `daemon: false` in the clones config, which every later plan honours, so the registration cannot come back
on its own. `tools macos clones daemon enable` clears that flag and overwrites an existing registration. The
registered script path points at the main checkout even when the plan ran from a git worktree. The tasks are:

- `macos-clones-scan`, every day at 03:00: a clone-aware dry-run scan of the watched folders that notifies what is
  reclaimable, and runs the presets armed with `presets auto --on`.
- `macos-clones-cache-prune`, every day at 04:00: a cache reconciliation. Every run drops the file-meta rows not
  seen by a scan in 30 days, across the whole table. It also drops rows whose paths are gone (one probe per gone
  subtree), then VACUUMs when at least a tenth of the rows went. The gone-path check covers a seventh of the rows
  each day (its cursor is `cache/file-meta.db.reconcile-cursor.json`), so every row is checked once a week: one full
  sweep of the 976,810 rows of 2026-10-12 took 53 s at normal and 163 s at background priority, and a cold,
  throttled disk at 04:00 took up to 27 minutes. A gone path's row can live six days longer, which costs only disk.
  Run it by hand with `bun run src/macos/lib/clones/cache-prune-daemon.ts`.

**Progress and profiling.** While a plan runs, the command prints one line per finished stage (discover, cache, walk,
hash, collapse, then `recorded:` for the snapshot and any preset it wrote), each with its counts and wall time; in a
TTY the spinner turns into that line, in a pipe it lands on stderr. Every phase is timed under the `clones` profiler
scope: `PROFILE=clones tools macos clones reclaim plan --dir ~/Projects` writes phase timings to
`~/.genesis-tools/logs/<date>-profiling.log`; `profiling.detail=all` also times each spawned `find` and
`git check-ignore`. Each run also leaves `~/.genesis-tools/macos-clones/reclaim/<runId>.jsonl` with what it
discovered, skipped and scanned. Benchmarks: `scripts/benchmarks/clones/run-reclaim.sh <label> <dir> [flags]` (cold
and warm plan, phase timings, one JSONL row), beside the older `run.sh` (duplicates) and `run-measure.sh`. The result
rows name the scanned paths, so they stay out of git; only the scripts are tracked.

### eslogger in depth

`tools macos eslogger` runs Apple's `/usr/bin/eslogger` (macOS 13 and later) and turns its JSON Lines into one
readable line per event: local time, event name, the acting process (pid and executable), then what the event did.

```text
10:15:30.123 exec         pid 4100   /bin/zsh → /usr/bin/git status --short (cwd /Users/alice/project)
10:15:31.000 fork         pid 4200   /bin/zsh → child pid 4201
10:15:32.000 exit         pid 4300   /usr/sbin/ipconfig exit code 0
```

**Requirements.** eslogger only runs as root, and the app macOS holds responsible for the command needs Full Disk
Access (`man eslogger`, "TCC AUTHORIZATION"). The tool itself stays a normal user process: it starts only eslogger
through `sudo`, which asks for your password in the terminal. Without a terminal (a pipe, an agent, launchd) sudo
cannot ask, so the command prints the fix and exits 1 instead of starting anything. Under GenesisTools.app the Full
Disk Access grant belongs to GenesisTools; with `GENESIS_TOOLS_NO_APP=1` it belongs to your terminal. When eslogger
refuses for a missing grant (`ES_NEW_CLIENT_RESULT_ERR_NOT_PERMITTED`), the tool says which app needs it and names
`tools macos permissions open --pane full-disk-access`. The first capture in a terminal may offer to build
GenesisTools.app, as the other permission-gated subcommands do; `--list-events`, `--dry-run`, `--input` and `--help`
never do.

**Choosing events.** `-e exec,fork` picks events, `-c process,file` picks categories, and both can be combined. With
neither, a terminal gets a picker; a pipe gets an error naming the flags. `--include-fork` adds `fork` beside `exec`.
`--list-events` prints the categories and every event this Mac's eslogger reports through `eslogger --list-events`,
which needs no root. An unknown event name is refused before eslogger starts, while a category member this Mac's
eslogger lacks (an older macOS) is named and left out. eslogger supports notify events only, never AUTH events.

| Category | Events |
|---|---|
| `process` | exec, fork, exit |
| `file` | open, close, create, write, unlink, rename (high volume) |
| `ipc` | uipc_bind, uipc_connect, xpc_connect (Unix-domain sockets and XPC; eslogger has no TCP/IP events) |
| `security` | authentication, sudo, su, setuid, setgid, seteuid, setegid, setreuid, setregid, |
| | xp_malware_detected, xp_malware_remediated, gatekeeper_user_override |
| `session` | lw_session_login/logout/lock/unlock, screensharing_attach/detach, |
| | openssh_login/logout, login_login/logout |
| `auth` | authorization_petition, authorization_judgement, tcc_modify |
| `persistence` | btm_launch_item_add/remove, profile_add/remove |

**Filters.** `--filter-event '<path> <op> <value>'`, repeatable (all must match). The path is jq-style dot notation
into eslogger's JSON, and eslogger nests every event's fields under its short name, so the exec target is
`.event.exec.target.executable.path`, not `.event.target.path`. A path that skips the event name is refused with
that hint. `==` and `!=` compare the whole value as text (`.process.audit_token.euid == 0` works); `=~` and `!~` test
a regular expression. Arrays of plain values join with spaces, so `.event.exec.args =~ "--inspect"` searches the
arguments. A missing field never equals anything.

| Path | What it is |
|---|---|
| `.process.executable.path` | the process that caused the event (for exec: the image before the exec) |
| `.process.audit_token.pid`, `.euid`, `.ppid` | its pid, effective uid and parent pid |
| `.event.exec.target.executable.path` | what an exec started |
| `.event.exec.args`, `.event.exec.cwd.path` | the arguments and the folder of an exec |
| `.event.fork.child.audit_token.pid` | the pid a fork created |
| `.event.exit.stat` | the wait(2) status (shown as exit code or signal) |
| `.event.open.file.path`, `.event.open.fflag` | the file an open reads or writes |
| `.event.close.target.path` | the file closed |
| `.event.write.target.path`, `.event.unlink.target.path` | the file written or deleted |
| `.event.rename.source.path` | the file a rename moved |
| `.event.signal.sig`, `.event.signal.target.audit_token.pid` | a signal and the process it went to |
| `.event.sudo.command`, `.event.sudo.success`, `.event.sudo.to_username` | a sudo run |

Field names follow the EndpointSecurity C headers (`es_message_t`, `es_event_*_t`), as `man eslogger` documents.
Apple makes no schema promise: message version 10 writes `audit_token` as a positional array of eight numbers
instead of an object. Audit-token paths such as `.process.audit_token.pid` work on both shapes, and `event_type`
numbers map to names from the macOS 26.5 SDK enum (146 is `gatekeeper_user_override`, 147 `tcc_modify`).

**Output and replay.** Event lines go to stdout and status to stderr, so `tools macos eslogger -c process > log.txt`
keeps only events; `-o <file>` writes them to a file as they arrive; `-s` drops the status lines; `--debug` also
prints each event's raw JSON on stderr. `--input <file>` (or `-` for stdin) replays a recording made with
`sudo eslogger exec fork > rec.jsonl` through the same `-e` and `-c` selection, filters and formatting, with no root:
the way to build a filter without sudo, and how the tests prove the parsing. `--dry-run` prints the exact eslogger
command line, or with `--input` the recording it would replay, and never touches the `-o` file.

```bash
tools macos eslogger -e open,write -o events.log
sudo eslogger exec > exec.jsonl
tools macos eslogger --input exec.jsonl --filter-event '.event.exec.args =~ "git"'
```

Code: [`commands/eslogger/index.ts`](commands/eslogger/index.ts) is the CLI door; the event catalogue, parsing,
filters, formatting and process handling live in [`lib/eslogger/`](lib/eslogger/), with tests in
`eslogger.test.ts`.

### Where the data lives

| Path | What it holds |
|---|---|
| `~/Applications/GenesisTools.app` | the installed launcher and app |
| `~/.genesis-tools/app/manifest.json` | the last build: source hash, checkout, branch, commit, parts, identity |
| `~/.genesis-tools/app/disabled` | present while `permissions disable` routes `tools` around the app |
| `~/.genesis-tools/app/retired.noindex/` | old bundles kept for processes that still run them |
| `~/.genesis-tools/app/clicky-library/` | the downloaded Clicky sound pack |
| `~/.genesis-tools/app-build-offer/state.json` | when the build offer last heard "no" |
| `~/.genesis-tools/indexer/macos-mail/index.db` | the mail search index |
| `~/.genesis-tools/macos-mail/seen.db` | the messages `mail monitor` has already seen |
| `~/.genesis-tools/macos-clones/config.json` | clones watched folders and defaults |
| `~/.genesis-tools/macos-clones/presets.json` | saved reclaim presets |
| `~/.genesis-tools/macos-clones/cache/file-meta.db` | per-file size, mtime and hash cache |
| `~/.genesis-tools/macos-clones/cache/file-meta.db.reconcile-cursor.json` | where the daily gone-path check stopped |
| `~/.genesis-tools/macos-clones/reclaim/<runId>.jsonl` | what a reclaim run discovered, skipped and scanned |
| `~/.genesis-tools/macos-clones/process/<id>.jsonl` | what an apply changed: the audit `--rollback` reads |
| `~/.genesis-tools/logs/<date>.log` | every log line, pino JSON (older days are stored as `.zst`) |

Apple's own stores are read in place and never written: `~/Library/Mail/V10`, `~/Library/Messages/chat.db`, the Voice
Memos database, and the TCC database at `~/Library/Application Support/com.apple.TCC/TCC.db`. Calendar and
Reminders go through EventKit by the shared DarwinKit bridge instead of `osascript`, so `add`, `update`, `delete`
and `remove` change your real calendars and lists.

## Configuration

- **Clones config** (`~/.genesis-tools/macos-clones/config.json`, edited with `tools macos clones config`):
  - `watchedDirs` is the default root list of `measure`, `duplicates`, `optimize` and the daily scan. Without it a
    command uses the current folder.
  - `minReal` (bytes), `nodeModules` and `exclude` apply only to the daily scan. The commands use their own flags.
  - `exclude` has no `clones config` flag; edit `config.json` to set it.
  - `daemon` is `false` after `clones daemon disable`.
- **Mail embeddings**: `defaults.app.mail.embed` (`provider`, `model`) in `~/.genesis-tools/ai/config.json`, written
  by `mail index`.
- **Mail monitor rules**: a JSON file you pass with `--rules`; see Monitor above.
- **Environment variables:**
  - `GENESIS_TOOLS_NO_APP=1` runs `tools` without the launcher, under the terminal's grants.
  - `GENESIS_TOOLS_CODESIGN_IDENTITY` picks the signing identity for `permissions build`.
  - `GENESIS_TOOLS_APP_BUNDLE_ID` is set by the launcher for its children; do not set it yourself.
  - `PROFILE=macos-mail` and `PROFILE=clones` print stage timings.

## For agents

- **An empty result from a permission-gated command is never proof of empty data.** Run
  `tools macos permissions` or `tools macos doctor` first; both exit 1 while something is missing and print the pane
  to open. `calendar doctor` and `reminders doctor` do the same for one app.
- Machine output: `doctor --json`, `permissions status --json`, `permissions local-network --json`,
  `permissions retired --json`, `calendar doctor --json`, `reminders doctor --json`, `calendar list -f json`,
  `reminders list -f json`, `mail search|list|accounts -f json` (or `-f toon`), `mail show --json`, `swap --json`,
  `clicky-library download --json`, `--format json|jsonl` on `clones measure`, `du`, `duplicates`, `optimize`,
  `reclaim plan|apply` and `presets run`, and `--format json` on `presets list` and `reclaim stores`.
- **Clones JSON (the contract the Disk Manager reads).** Every verb that changes something has a machine mode:
  `reclaim apply`, `reclaim presets run --apply`, `optimize --apply` and `optimize --rollback` take
  `--format json|jsonl` (a pipe resolves `auto` to `json`), and `reclaim presets save|rm`, `reclaim presets auto` and
  `daemon enable|disable|status` take `--json`. The apply JSON is the `ProcessReport` plus
  `plan: {runId, totalReclaimable, totalFreeable, totalFreeableUpTo, sets}`, so the projected and the measured bytes
  sit side by side (with no duplicate sets, apply prints the plan itself instead). A failure in a machine mode prints
  `{"error": {"kind", "message", "command", ...}}` on stdout as well as the usual stderr line, with the same exit code.
  The kinds are `integrity`, `clone-unsupported`, `rollback-space` (with `required` and `available` bytes),
  `unknown-process` (with `closest`), `missing-process`, `confirm-required`, `unknown-preset` (with `known`),
  `no-roots`, `invalid-arguments` (a refused selector flag), and `repo-not-found` (`--worktrees-of` names no
  repository). `daemon status --json` reads the daemon config and launchd directly:
  `{enabled, daemon, tasks, registered: {scan, prune}}`. `daemon enable --json` prints
  `{enabled: true, newlyRegistered, registered}` and `daemon disable --json` prints
  `{enabled: false, removed, registered}`: `newlyRegistered` and `removed` say what this call changed, and
  `registered` is the state afterwards (an already registered task is `newlyRegistered: false, registered: true`).
  Frozen samples: `src/macos/GenesisKit/Sources/GenesisKitFixtures/Disk/contract-clones-*` (GenesisKit's one copy;
  the reclaim and optimize tests keep real output's keys and nesting equal to them).
- Commands that would prompt need a TTY: `clones reclaim apply`, `reclaim presets run --apply`, `optimize --apply`
  and `optimize --rollback` need `--yes` in a pipe, `mail index` needs `--provider` while the index does not exist
  yet, `voice-memos transcribe` needs `--provider` and an id or `--all`, and `eslogger` needs `-e` or `-c` and a
  terminal for sudo.
- Run `permissions build` only when you mean to change the installed app: it rebuilds and re-signs the app that every
  tool runs under, stops its old windows and opens them again.
- The `macos-control` plugin skill covers UI automation through `tools control` and `tools macos control`; the
  `todo` skill uses `tools macos calendar` for its calendar sync.

## Troubleshooting

- **A calendar command shows one calendar named `Calendar` and no events.** The grant is Add Only. Run
  `tools macos calendar doctor`, then upgrade the grant to Full Access in Privacy & Security.
- **Mail, Messages or Voice Memos fail with a permission error.** Full Disk Access is missing for the app that is
  responsible (GenesisTools.app, or the terminal under `GENESIS_TOOLS_NO_APP=1`). Run
  `tools macos permissions open --pane full-disk-access` and drag the app in.
- **Every grant vanished after a rebuild.** The app was signed ad hoc. Install a Developer ID or Apple Development
  certificate, or set `GENESIS_TOOLS_CODESIGN_IDENTITY`, then run `tools macos permissions build`.
- **Every build asks for the keychain password.** Run `tools macos permissions codesign-trust` once.
- **macOS asks about local networks again.** An old build still runs a process. `tools macos permissions` lists the
  old builds, and `tools macos permissions local-network` names the program that asked.
- **A window shows old behaviour after a code change.** The installed bundle is stale: `bun run app:status` shows the
  installed commit. A build reaps the old windows and opens them again.
- **`mail search` fails with `k value in knn query too large`.** That was fixed on 2026-09-07; update. On a current
  build, a big hybrid page prints a warning that vector recall is reduced; `--mode fulltext` avoids it.
- **`mail search` exits with `timed out after 60s in stage "<name>"`.** One stage did not finish in time. Run it with
  `PROFILE=macos-mail` and `-v` to see the stage, or raise `--timeout`.
- **eslogger shows no exec for a command you typed.** Shell builtins (`cd`, `echo`, zsh's `which`) never exec, so
  they produce no exec event; `/usr/bin/which` does. eslogger also hides events from its own process group, so run
  the commands in another window. Ctrl+C stops eslogger (SIGINT through sudo, SIGTERM after 3 s) and prints the
  totals.
- **`clones reclaim plan` keeps registering daemon tasks.** Run `tools macos clones daemon disable`; plans then leave
  the registration alone.

## Related

- [`tools du`](../du/README.md): the extent engine and native walker that `clones` measures with.
- [`tools control`](../control/README.md): the UI automation that `tools macos control` passes through to.
- [`tools notify`](../notify/README.md): the notifications that `doctor` checks and that run through the app.
- [`tools daemon`](../daemon/README.md): runs the daily clones tasks.
- [`tools indexer`](../indexer/README.md): the index machinery behind `mail index` and `mail search`.
- [`tools update`](../update/README.md): installs or rebuilds GenesisTools.app when its sources change.
- [`tools hub`](../hub/README.md) and [`tools recorder`](../recorder/README.md): optional parts of GenesisTools.app.
- [`tools transcribe`](../transcribe/README.md): general audio transcription.
- [`tools automate`](../automate/README.md): launchd jobs that run under the launcher.
