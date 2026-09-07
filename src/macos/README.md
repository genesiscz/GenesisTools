# macOS

![Status](https://img.shields.io/badge/Status-Active-success?style=flat-square)
![Platform](https://img.shields.io/badge/Platform-macOS-blue?style=flat-square)

> **Umbrella CLI for macOS native frameworks — Mail, Calendar, Reminders, Messages, Voice Memos, Sleep.**

`tools macos` exposes a consistent interface for reading and (where supported) writing to macOS native data stores. It reuses the shared DarwinKit bridge so commands feel fast and scriptable compared to `osascript`.

---

## Subcommands

| Subcommand | What it does |
|------------|--------------|
| `mail` | Search, list, and download messages from Apple Mail |
| `calendar` | List calendars/events, search, add, update, delete events |
| `reminders` | List/add/search/remove reminders across lists |
| `messages` | List, search, and show iMessage / SMS conversations |
| `voice-memos` | List, play, export, transcribe, search Voice Memos |
| `clones` | Clone-aware sizes, duplicate detection, safe APFS dedupe across worktrees (alias: `apfs`) |
| `sleep` | Inspect macOS sleep / wake metadata |

---

## Quick Start

```bash
# Mail
tools macos mail search "invoice"
tools macos mail list INBOX --limit 20 --from 14h        # INBOX = every account's inbox (Gmail All Mail, EWS "Doručená pošta" included)
tools macos mail list INBOX --unread --has-attachment --from 2026-08-01
tools macos mail download 12345 --output-dir ./out

# Calendar
tools macos calendar list-calendars
tools macos calendar list Work --from 2026-04-01 --to 2026-04-30
tools macos calendar search "standup"
tools macos calendar add "Dentist" --start "2026-05-02 10:00"

# Reminders
tools macos reminders list-lists
tools macos reminders list Home --include-completed
tools macos reminders add "Buy milk" --list Home --due "tomorrow 18:00"

# Messages
tools macos messages list --limit 50
tools macos messages search "meeting"
tools macos messages show "+420..."
tools macos messages show "+420..." --from 2026-01-01 --to 2026-12-31 \
  --output-dir ./out --md-name chat-2026.md --save-attachments
tools macos messages attachment 11122 --download ./out/attachments
# --attachments-filter accepts "#11122,10989" or a name regex like "IMG_|\\.pdf$"
# Opaque *.pluginPayloadAttachment stubs are renamed via magic-byte sniff (e.g. 11111-image.png).

# Voice Memos (also available as `tools voice-memos`)
tools macos voice-memos list

# Clones (APFS clone-aware disk usage; run bare for the guide)
tools macos clones
tools macos clones measure ~/Projects/acme --show-partners
tools macos clones duplicates ~/Projects/acme --node-modules
tools macos clones reclaim plan --dir ~/Projects
tools macos clones reclaim plan --dir ~/Projects --worktrees-of acme --save acme
tools macos clones reclaim apply --dir ~/Projects --yes
tools macos clones reclaim presets list
tools macos clones optimize --rollback --process <id>
```

Run `tools macos <subcommand> --help` for the full option list of each subcommand.

### Clones: reclaim across worktrees

`reclaim` finds the install trees under a directory (`node_modules`, composer `vendor`, `Pods`, `.cxx` — the gitignored ones by default), including the git worktrees of a repo that live beside it, and matches duplicates ACROSS those trees. `plan` rewrites nothing (its one durable side effect is the daemon registration below, `--no-daemon` skips it); `apply` clonefiles each duplicate onto one keep copy after a typed confirmation and writes an audit you can roll back. A preset (`--save <id>`, `presets run <id>`) stores the selector, never file paths, so it stays correct after a branch switch.

On macOS the walk runs in the `tools du` native core (`clonesize --bigfiles`): one parallel `getattrlistbulk` pass over every root that returns only the files at or above the size floor, about 14x faster than the in-process walk on node_modules trees (a 233-root fleet of 13.7M files lists in under 40 s instead of 8 minutes). It is used automatically when the floor is at least 1 MB; `nativeWalk: false` in the library, or a machine without clang, falls back to the in-process walk.

Every finished `reclaim plan` (and `apply`, and a preset run) registers two daily `tools daemon` tasks when they are not registered yet, and prints a `recorded: daemon tasks` line when it did; an existing registration is left alone unless its script file is gone (a deleted worktree), which it repairs. `--no-daemon` skips it for one invocation. `tools macos clones daemon disable` is the permanent opt-out: it unregisters both tasks AND stores `daemon: false` in the clones config, which every later plan honours, so the registration cannot come back on its own. `tools macos clones daemon enable` clears that flag and overwrites an existing registration. The registered script path points at the main checkout even when the plan ran from a git worktree. The tasks are: the dry-run scan at 03:00 and, at 04:00, a cache reconciliation that drops file-meta rows older than 30 days across the whole table plus rows whose paths are gone (one probe per gone subtree), then VACUUMs when at least a tenth of the rows went. Run it by hand with `bun run src/macos/lib/clones/cache-prune-daemon.ts`.

While a plan runs, the command prints one line per finished stage (discover, cache, walk, hash, collapse, then `recorded:` for the snapshot and any preset it wrote), each with its counts and wall time; in a TTY the spinner turns into that line, in a pipe it lands on stderr. Every phase is timed under the `clones` profiler scope: `PROFILE=clones tools macos clones reclaim plan --dir ~/Projects` writes phase timings to `~/.genesis-tools/logs/<date>-profiling.log`; `profiling.detail=all` also times each spawned `find` / `git check-ignore`. Each run also leaves `~/.genesis-tools/macos-clones/reclaim/<runId>.jsonl` with what it discovered, skipped and scanned. Benchmarks: `scripts/benchmarks/clones/run-reclaim.sh <label> <dir> [flags]` (cold + warm plan, phase timings, one JSONL row), beside the older `run.sh` (duplicates) and `run-measure.sh`. The result rows name the scanned paths, so they stay out of git; only the scripts are tracked.

---

## Mail: search modes, the stage watchdog, mailbox names, benchmarks

`tools macos mail search` runs against the FTS index at `~/.genesis-tools/indexer/macos-mail/index.db` (`--mode fulltext | hybrid | vector | auto`; `auto` is hybrid when the index has embeddings). Two facts that used to cost hours:

- **The hybrid over-fetch used to kill any big page.** Hybrid asks sqlite-vec for `limit × 15` neighbours (3× for the RRF pool, 5× for a filtered cosine query) and sqlite-vec refuses `k > 4096`, so `--limit 500` over a month window died with `k value in knn query too large, provided 7500 and the limit is 4096` (2026-09-07). The store now clamps `k` (`SQLITE_VEC_MAX_K` in `src/utils/search/stores/sqlite-vec-store.ts`) and the search prints one warning saying the vector candidate pool was capped and vector recall is reduced. The cap is not a rank boundary: a hybrid result anywhere in the page may still carry both scores, and with a selective filter even the first one may lack the vector score, so the warning does not name a rank. A pure `--mode vector` search gets its own wording (only the 4096 nearest neighbours are considered). `--mode fulltext` never had the problem.
- **Every stage has a deadline.** `--timeout <seconds>` (default 60) covers the index query, the row fetch, the Spotlight and LIKE fallback and the attachments join separately; a stuck stage exits 1 with `mail search timed out after 60s in stage "<name>"` instead of a silent process. The limit of that guard: SQLite calls are synchronous, so a query that is blocked cannot be interrupted mid-flight. What is guaranteed is that a stage which returns after its deadline is reported as a timeout, never as a success. A never-settling stage (Spotlight, a lost promise) is cut at the deadline itself. `PROFILE=macos-mail` (scope `macos-mail`, `src/utils/profile`) prints one `[profile:macos-mail] <stage> <ms>` line per stage for `search` and `list`; `-v` shows the stage transitions. The hour-long "hang" a keyword sweep reported on 2026-09-07 did not reproduce: the same queries back to back finish in about a second each, and a search with an open stdin pipe exits normally, so the watchdog is insurance, not a fix for a known stall.

**Mailbox names** (`list <mailbox>`, `--mailbox`, `--account`): `INBOX` means every account's inbox (localized names included). Anything else is a case-insensitive substring of the percent-decoded, NFC-normalized mailbox URL, so `Deleted Messages`, `Deleted`, `Koš`, `Ko%C5%A1`, `Odstran` and `Archiv` all work; an accent-free `Kos` does not.

### Benchmarks

`bun src/macos/lib/mail/bench.ts "<label>" [rounds]` runs the arms below interleaved (A,B,C,A,B,C,…) and prints the table. Wall time on this machine swings with load, so treat anything under about 20 % as noise, and note the load average. The stage timers say the work itself is small: a fulltext month search spends ~15 ms in the index query, ~5 ms fetching rows; a month list ~26 ms in SQL and ~42 ms rendering 10 000 JSON rows. The rest of each ~330 ms is bun start-up plus the launcher.

#### 2026-09-07 17:03, before the knn clamp and watchdog (load 41.7 / 29.6, 5 interleaved rounds)

| Arm | min | median | max | exit codes | first error line |
|---|---|---|---|---|---|
| list month, limit 10000 | 334ms | 466ms | 1.3s | 0 |  |
| search faktura, fulltext, limit 500 | 358ms | 383ms | 655ms | 0 |  |
| search faktura, auto, limit 500 | 498ms | 730ms | 2.0s | 1 | ERROR: k value in knn query too large, provided 7500 and the limit is 4096 |

#### 2026-09-07 17:09, after (load 14.3 / 29.5, 5 interleaved rounds)

| Arm | min | median | max | exit codes | first error line |
|---|---|---|---|---|---|
| list month, limit 10000 | 334ms | 336ms | 348ms | 0 |  |
| search faktura, fulltext, limit 500 | 311ms | 314ms | 380ms | 0 |  |
| search faktura, auto, limit 500 | 643ms | 645ms | 699ms | 0 |  |

The auto arm went from "fails every run" to a working ~645 ms (the embedding of the query plus the 4096-neighbour scan sit on top of the fulltext cost). The list and fulltext medians moved by less than the load swing between the two runs and are noise; the watchdog is a `Promise.race` per stage and adds nothing measurable.

## Permissions

macOS keys every privacy grant (Calendars, Reminders, Contacts, Full Disk Access, Accessibility, Automation, Speech, Microphone, protected folders) to the **responsible process**. For a plain CLI that is the terminal that launched it, or `bun` itself under launchd, so every terminal needed its own grants and a launchd job had none. Since 2026-09-03 19:40 GenesisTools owns them itself:

- **`GenesisTools.app`** (`src/macos/GenesisTools/`, Swift, ~100 lines) is a launcher installed at `~/Applications/GenesisTools.app`. `tools` runs every tool through it. The launcher re-spawns itself with the `responsibility_spawnattrs_setdisclaim` attribute and then starts the tool, so macOS treats the signed bundle `com.genesiscz.genesistools` as the client for the whole process tree, including the DarwinKit child. Grants attach to that one identity, and every terminal, worktree and launchd job shares them.
- It is signed with the first available **Developer ID Application** or **Apple Development** certificate (`GENESIS_TOOLS_CODESIGN_IDENTITY` overrides). That is what makes the identity survive rebuilds: TCC remembers the signing requirement, not the binary hash. An ad-hoc signature works but loses every grant on the next build, and `tools macos permissions` says so.
- `install.sh` builds it when `swift` is available; `bun run build:app` or `tools macos permissions build` rebuilds it. Without the bundle, or with `GENESIS_TOOLS_NO_APP=1`, `tools` runs the old way under the terminal's grants.
- **Who builds the bundle.** Three entry points, and nothing else: `./install.sh` on a fresh clone, `tools macos permissions build` by hand, and `tools update`. Ordinary commands never build it: `tools macos mail` just runs, under the app if it exists and under the terminal if it does not, and the permission dialog names `tools macos permissions build` when it is the terminal.

  The app lives outside the repo, so a `git pull` never touches it. `tools update` therefore checks it after installing dependencies and does one of three things:

  | Bundle state | What `tools update` does |
  |---|---|
  | missing | installs it, and prints what now attaches to it plus how to opt out |
  | source hash differs from the installed manifest | rebuilds and re-signs it |
  | current | nothing |

  The missing case is the one that matters on the first update after this shipped, since no existing user has the bundle and nobody re-runs `install.sh` to update. A failed build never fails the update: tools keep working under the terminal's own permissions and the `permissions build` command is printed. Re-signing with the same identity leaves every TCC row intact, verified by rebuilding with grants in place.
- **Cost of the launcher, measured 2026-09-04 00:55** (25 interleaved samples per arm; the machine sat at load average 27-51, so the minimum is the load-robust statistic):

  | Arm | min | p25 | median |
  |---|---|---|---|
  | launcher + `/usr/bin/true` | 18.9 ms | 22.7 ms | 25.1 ms |
  | same launcher built Foundation-only | 13.1 ms | 17.4 ms | 19.9 ms |
  | no launcher at all | 2.3 ms | 2.9 ms | 4.4 ms |

  So a `tools` command pays about 16 ms: roughly 11 ms for the two-stage spawn, which is irreducible because only a parent can set the disclaim attribute, and about 6 ms for loading AppKit and SwiftUI, which the launcher links only because the settings window shares its binary. End to end that is 10-18 ms on a ~290 ms floor dominated by bun startup, and it disappears into the noise on real work (`tools macos mail search` runs 600 ms+). **The window was deliberately not split into a second binary**: a non-main executable inside `Contents/MacOS` is not covered by tccd's BUNDLE_ATTRIBUTION, so the window's own permission prompts could stop being attributed to the bundle. Six milliseconds is not worth risking the identity the whole design rests on. Re-measure with `/tmp/bench-launcher2.py` style interleaving if this ever feels slow.
- The icon is Genesis's amber sparkles on the same dark rounded square, with a golden ring around the mark so the two apps are distinguishable; the 16px tile drops the ring, where it would only smudge. `src/macos/GenesisTools/scripts/build-icon.swift` renders the iconset and `AppIcon.icns` (both committed); `bun run build:app-icon` regenerates them, and the bundle build copies the `.icns` into `Contents/Resources`.
- The same bundle is also a small app: `open -a GenesisTools`, a Finder double-click or `tools macos permissions ui` opens a window with every grant and a Request button (the prompt names GenesisTools, same identity as the CLI), the `com.genesis-tools.*` launchd jobs and whether they run under the app, and a switch that routes `tools` through the launcher or not (`~/.genesis-tools/app/disabled`; also `tools macos permissions enable|disable`). The launcher path never loads AppKit, so a `tools` run stays two tiny processes with no Dock icon.
- Children see `GENESIS_TOOLS_APP_BUNDLE_ID=com.genesiscz.genesistools`; `tools macos permissions` and `tools macos calendar doctor` read it to say who is responsible.
- Every launchd writer (`DashboardApp/launchd.ts` for the dashboards and ai-proxy, `daemon`, `automate`) puts the launcher first in `ProgramArguments`, so services share the CLI's grants instead of needing rows for `~/.bun/bin/bun`. A plist from before the app existed is left alone until the user starts that service again: `ui up` boots the job out and rewrites it, `tools daemon restart` and `tools automate daemon install` reinstall it, and `status` says so until then. Without the bundle, or with the launcher switched off, the plists come out exactly as before.

Fresh machine:

```bash
./install.sh                                   # builds and signs GenesisTools.app
tools macos permissions                        # identity, signature, and every grant recorded for it
tools macos permissions open --pane full-disk-access   # opens the pane and reveals the .app: drag it in
tools macos calendar list --from 2026-09-01 --to 2026-09-30   # first run prompts "GenesisTools would like to access your calendar"
```

Full Disk Access and Accessibility have no system prompt. Only Mail, Messages and Voice Memos need Full Disk Access; when one of those commands hits the missing grant on a TTY, GenesisTools shows its own dialog that says which command needs it, opens the pane and selects the app in Finder (the "+" picker also lists GenesisTools under Applications). `tools macos permissions` only reports; `tools macos permissions open --pane full-disk-access` shows the dialog on demand. Files you name on the Desktop, in Documents or in Downloads get the per-folder system prompt instead, and allowing one folder is enough. The dialog is throttled to once per hour. Calendars, Reminders, Contacts, Automation and folders prompt on first use, with GenesisTools as the name in the dialog. The user TCC database is itself behind Full Disk Access, so `tools macos permissions` treats an unreadable database under GenesisTools.app as "Full Disk Access missing".

### Calendar: three grant levels, and the middle one is the trap

| Grant | `tools macos calendar` sees |
|---|---|
| Full Access | every calendar and event |
| Add Only (write-only) | one placeholder calendar `Calendar` from source `Account`, zero events. `add` still works. |
| Denied / none | nothing |

Every read command (`list`, `search`, `list-calendars`, `update`, `delete`) checks the status first and exits 1 with the fix instead of printing an empty list. On a TTY it first asks macOS to upgrade Add Only to Full Access (a system dialog; the tool waits up to 15 s for your answer). `tools macos calendar doctor` shows the status, the responsible identity and every `kTCCServiceCalendar` row.
