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
tools macos mail list INBOX --limit 20
tools macos mail download ./out --from "boss@example.com"

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

Every finished `reclaim plan` (and `apply`, and a preset run) registers two daily `tools daemon` tasks when they are not registered yet, and prints a `recorded: daemon tasks` line when it did; an existing registration is left alone unless its script file is gone (a deleted worktree), which it repairs. `--no-daemon` skips this. `tools macos clones daemon enable` overwrites an existing registration, `daemon disable` removes both. The registered script path points at the main checkout even when the plan ran from a git worktree. The tasks are: the dry-run scan at 03:00 and, at 04:00, a cache reconciliation that drops file-meta rows older than 30 days across the whole table plus rows whose paths are gone (one probe per gone subtree), then VACUUMs when at least a tenth of the rows went. Run it by hand with `bun run src/macos/lib/clones/cache-prune-daemon.ts`.

While a plan runs, the command prints one line per finished stage (discover, cache, walk, hash, collapse, then `recorded:` for the snapshot and any preset it wrote), each with its counts and wall time; in a TTY the spinner turns into that line, in a pipe it lands on stderr. Every phase is timed under the `clones` profiler scope: `PROFILE=clones tools macos clones reclaim plan --dir ~/Projects` writes phase timings to `~/.genesis-tools/logs/<date>-profiling.log`; `profiling.detail=all` also times each spawned `find` / `git check-ignore`. Each run also leaves `~/.genesis-tools/macos-clones/reclaim/<runId>.jsonl` with what it discovered, skipped and scanned. Benchmarks: `scripts/benchmarks/clones/run-reclaim.sh <label> <dir> [flags]` (cold + warm plan, phase timings, one JSONL row), beside the older `run.sh` (duplicates) and `run-measure.sh`. The result rows name the scanned paths, so they stay out of git; only the scripts are tracked.

---

## Permissions

Most commands need Full Disk Access and/or specific Privacy permissions (Contacts, Calendars, Reminders, Messages). If you see "not authorized" errors, the CLI prints step-by-step instructions — the short version is:

1. **System Settings -> Privacy & Security -> Full Disk Access** -> enable your terminal app.
2. Grant the specific framework permission when macOS prompts (Calendars, Reminders, ...).
3. Restart the terminal and re-run.
