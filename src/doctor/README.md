# tools doctor

Find and fix common problems on a macOS developer machine: disk bloat, dev caches, leaked temp copies, memory
pressure, runaway processes, startup and security settings. Every finding carries a safety tier and a confirmation
level, so you can clean up with prompts in a terminal, read the findings as JSON, or let GenesisTools.app's Disk
Manager act on one finding by id through `tools doctor act`.

## Quick start

```bash
tools doctor                                       # full-screen dashboard of every analyzer
tools doctor --plain --only disk-space,dev-caches  # linear prompts, two analyzers only
tools doctor --json --dry-run > ~/doctor.json      # every finding as JSON; nothing runs
tools doctor cpu                                   # what burns CPU during the next 3 seconds
tools doctor find --min-mb 500 --max-days 30       # files over 500 MB changed in the last 30 days
tools doctor log --since 7d                        # what doctor did this week
```

## Commands

### `tools doctor` (scan, then fix)

With no subcommand, doctor runs the analyzers and lets you pick findings to act on.

| Flag | What it does |
|---|---|
| `--plain` | Linear clack prompts instead of the OpenTUI dashboard |
| `--json` | Print the findings document and exit (implies `--plain`) |
| `--only <ids>` | Comma-separated analyzer ids (see Analyzers below) |
| `--fresh` | Ignore the analyzer cache and scan again |
| `--dry-run` | Run nothing; report what would run |
| `--thorough` | Run 8 analyzers at once instead of 4 |
| `--quick` | Accepted, but no code reads it yet |
| `--debug` | Accepted, but no code reads it yet; use `-v` |
| `-v, --verbose` | Debug logs, with each analyzer's duration and finding count |
| `--readme` | Print this README |

- Of the scan flags, only `--dry-run` passes from the root to a subcommand, and only to `act`:
  `tools doctor --dry-run act ...` works, and so does `act ... --dry-run`. The others (`--json`, `--plain`,
  `--fresh`, `--only`, `--thorough`) do nothing before a subcommand, so `tools doctor --json cpu` prints the plain
  flow. Put `--json` after `cpu`.
- The dashboard needs a terminal of at least 80x24. A smaller one, `--plain`, or no terminal at all (a pipe, CI)
  gives the plain flow.
- `--only` ignores an id it does not know, without a warning. When no id matches, the plain flow says "No analyzers
  selected" and `--json` prints an empty `analyzers` list.
- `--thorough` only raises concurrency in the dashboard and the plain flow. No analyzer reads it, and `--json`
  always runs 4 at once. It does not lift time caps.

Dashboard keys: `j`/`k` or the arrows move between analyzers, `d` or Enter opens the findings drawer, Space selects a
finding in the drawer, `x` runs the first action of every selected finding, `Shift+D` empties the staged Trash (you
type `DELETE`), `q` or Escape closes the drawer or quits.

Plain flow: a picker for the analyzers (all preselected; skipped with `--only`), then a picker for the findings
(`safe` ones preselected), then an action picker when a finding offers more than one, then each action's
confirmation. Blocked findings are left out of the picker. Their reasons print only when every finding is blocked,
so use `--json` to see them (`severity: "blocked"`, `blacklistReason`). Without a terminal it only lists the
findings that are not blocked and says "No terminal, so nothing is acted on".

### `tools doctor find`

```bash
tools doctor find --root ~/Projects --min-mb 200 --max-days 7
```

| Flag | Default | Meaning |
|---|---|---|
| `--root <path>` | `$HOME` | Folder to search |
| `--min-mb <n>` | `100` | Smallest file size in MB |
| `--max-days <n>` | `30` | Modified in the last N days |

It uses `fd` when installed (hidden files included, 10 levels deep) and `find` otherwise (no ignore rules, no depth
limit), so the results depend on whether `fd` is installed:

- `fd` leaves out every file that ignore rules hide: a `.gitignore` inside a git checkout (build output, archives,
  `dist` folders), plus `.ignore` and `.fdignore` files.
- With `fd` a MB is 1,000,000 bytes; with `find` it is 1,048,576 bytes.

It prints the 50 largest matches. The search has a 30 s limit, and any non-zero exit of `fd` or `find` (a timeout,
or `find` hitting a folder it may not read) gives "0 files matched".

### `tools doctor cpu`

```bash
tools doctor cpu --window 5000 --threshold 50
```

| Flag | Default | Meaning |
|---|---|---|
| `--window <ms>` | `3000` | Gap between the two samples (at least 100) |
| `--threshold <pct>` | `25` | Report at or above this share of one core |
| `--json` | off | Print the findings document |

It reads `ps -o cputime` twice, `--window` milliseconds apart, and lists every process in both readings that used at
least `--threshold` percent of one core in between. A process that starts inside the window has no first reading and
is not judged, however much CPU it uses. Two readings of accumulated CPU time are exact, where `pcpu` is a
decaying average that smears an old spin and hides a fresh one. GenesisTools.app faces and `tools` processes are
named as such, with the fix (`bun run app` rebuilds the app and reaps a stale face; a `tools` process points at
today's log). Each row offers a yes/no kill unless the process is on the never-kill list.

`cpu` is opt-in. It is not in the default `tools doctor` suite, because that would sleep the window on every run.
The static half of the same guard is `bun scripts/ci/lint-rules.ts` (timers under 100 ms, `sleepSync` in a loop, a
Swift `.wait()` without a timeout). Background and numbers: [benchmarks-cpu.md](../../docs/benchmarks-cpu.md).

### `tools doctor act`

```bash
tools doctor act <actionId> --analyzer <id> --id <findingId> [options]
```

Runs one reclaim action without prompts on findings it re-derives from a fresh scan. It prints one JSON result.
Details, guards and exit codes are in [The `doctor act` door](#the-doctor-act-door) below.

| Flag | Meaning |
|---|---|
| `--analyzer <id>` | Analyzer that owns the findings (required) |
| `--id <findingId>` | Finding id, repeatable (ids hold paths, so no comma lists) |
| `--method <method>` | `trash` or `delete`: required for removal actions, refused for command actions |
| `--yes` | Satisfies a yes/no confirmation |
| `--confirm <phrase>` | Satisfies a typed confirmation (exact, case sensitive, repeatable) |
| `--expect <id>=<bytes>` | The `reclaimableBytes` you showed; more than 25% drift refuses as `stale` |
| `--expect-paths <id>=<hash>` | The `pathsHash` you showed; a changed path set refuses as `stale` |
| `--dry-run` | Re-check and plan only: no change, no manifest, no history |
| `--ndjson` | Stream plan, item and volume events; the last line is the result |
| `--json` | One result object (the default) |

### `tools doctor log`, `stats`, `wipe-cache`

```bash
tools doctor log --since 24h --analyzer temp-leaks   # recent actions, newest first (last 50)
tools doctor log --json                              # the raw history entries
tools doctor stats --since all                       # bytes reclaimed, actions, runs, counts per action
tools doctor wipe-cache                              # delete the analyzer cache
```

- `--since` takes `<n>d`, `<n>w`, `<n>h` or `<n>m` (minutes, not months). The default is `7d`. Any other value,
  `all` included, silently means 7 days, except that `stats --since all` reads the whole history.
- `log --analyzer <id>` keeps entries whose finding id contains that text. Only the `temp-leaks`, `app-bloat`,
  `brew`, `battery`, `startup`, `extensions` and `cpu-spin` finding ids start with the analyzer id. For the others,
  pass the id prefix: `disk-` (disk-space), `dev-` (dev-caches), `sys-` (system-caches), `mem-` (memory), `proc-`
  (processes), `net-` (network), `sec-` (security). `--analyzer disk-space` matches nothing.
- `stats` counts reclaimed bytes from `ok` results only, so Trash moves and dry runs add nothing.
- `wipe-cache` makes the next run scan everything again, like `--fresh` once.

## Analyzers

The ids below are what `--only` and `act --analyzer` take. The cache time after each id is how long a result is
reused before the analyzer scans again (no cache: it always scans).

Disk (findings with sizes, most of them actable):

- `disk-space` (cache 1 h): Downloads over 500 MiB (reveal in Finder only), the Trash, Time Machine local
  snapshots, files of 500 MiB or more under `$HOME`, and an offer to `brew install fd` when `fd` is missing.
- `dev-caches` (cache 24 h): `node_modules`, Xcode DerivedData, simulators, Docker images, package-manager caches,
  the Homebrew cache.
- `temp-leaks` (no cache): leaked `code_sign_clone` app copies, stale agent scratch, moved-aside folders, old
  `$TMPDIR` entries, SwiftPM `.build` copies.
- `app-bloat` (cache 5 min): app VM disks, caches, old versions and big logs.
- `system-caches` (cache 6 h): `~/Library/Caches` folders and archived `/var/log` files.

Health (mostly reports; some offer a kill or a command):

- `memory` (no cache): swap, memory pressure, the 5 processes with the most resident memory.
- `processes` (no cache): zombies, processes over 50% of a core in a 250 ms sample (top 5), and groups of 5 or more
  processes with one name.
- `startup` (cache 7 days): `pmset -g assertions` sleep blockers, and user launch agents whose last exit status is
  not 0 (remove with `launchctl remove`).
- `brew` (cache 24 h): Homebrew missing, outdated packages (`brew upgrade` on yes/no), more than 30 top-level
  packages.
- `battery` (cache 24 h): cycle count and condition from `system_profiler SPPowerDataType` (about 2 s), and recent
  thermal events from `pmset -g thermlog` (an empty log means no throttling, not an error).
- `network` (no cache): more than 100 TCP connections in `TIME_WAIT` or `CLOSE_WAIT`, a DNS cache flush
  (`dscacheutil -flushcache`; the `mDNSResponder` HUP runs only as root), more than 4 `utun` interfaces.
- `security` (no cache): FileVault, Gatekeeper, SIP, and whether the app that hosts your shell is on the Developer
  Tools list.
- `extensions` (no cache): the GenesisTools browser extensions are built, loaded, current and reach their native host.

`cpu-spin` runs only through `tools doctor cpu`.

### Disk analyzers in detail

- `disk-space`: large files are sized by **allocated** blocks (`st_blocks * 512`), never `st_size`. A VM or container
  disk (`Docker.raw`, `data.img.raw`, `swap.img`, `*.vmdk`, `*.qcow2`, anything under the Docker, OrbStack, Colima,
  Lima, UTM or Parallels data folders, the Photos library) and any file whose allocated size is far below its apparent
  size (sparse or compressed) is `blocked` with a reason and offers no action. Before 2026-10-13 the rule listed
  OrbStack's 926 GiB sparse `data.img.raw` first and moved it to the Trash on the TUI's first key. A file in a
  Tresorit synced folder is `blocked`; one in iCloud Drive or `~/Library/CloudStorage` carries `metadata.cloudSync`.
  The large-file scan lists the 20 largest files of 500 MiB or more, searches 6 levels under `$HOME`, and stops
  after 15 s. With `fd` it leaves out the files that a `.gitignore` inside a git checkout hides; the `find` fallback
  skips `node_modules` and `.git` folders instead. A file that a process holds open (or every file, when `lsof`
  cannot tell) carries a blocker in `metadata.blockers`, so every flow refuses its actions.
- `dev-caches`: `node_modules` folders of 500 MiB or more (the 20 largest) under the checkout roots: the folders one or
  two levels under `~` that directly hold git checkouts, plus `GENESIS_TOOLS_DEV_CACHE_ROOTS`. No folder names are
  assumed. Simulators are grouped per runtime, with actions for unavailable ones, ones not used in more than 90
  days, and all of a runtime (you type the runtime name). Docker calls are pinned to the context that
  `docker context show` names, and the prune removes dangling images only. The bun, npm and pnpm caches show at
  1 GiB or more and the yarn cache at 500 MiB. Their globally installed packages are saved to a snapshot before the
  wipe. In the dashboard and the plain flow the reinstall runs right after a successful clean, without another
  prompt, and downloads the packages. `doctor act` does not run it and lists it in the result's `followUps`.
- `system-caches`: `~/Library/Caches` folders of 50 MiB or more (Playwright and `*.ShipIt` are left to `app-bloat`, so
  no byte is listed twice), and archived `/var/log` files (it copies the `sudo` command for you).
- `temp-leaks`: leaked `code_sign_clone` app copies under `$(dirname $(getconf DARWIN_USER_TEMP_DIR))/X`. A clone is
  kept when it was born within 5 s before to 60 s after a running main process of its app started, or is younger than
  10 minutes. The finding names the off switch `--disable-features=MacAppCodeSignClone` and "close automation Chrome
  with Browser.close, never a signal". Then: stale agent scratch `<root>/<project>/<session>` (only when
  `GENESIS_TOOLS_AGENT_SCRATCH_ROOT` names the root; 3 days old, live sessions and git checkouts or worktrees left
  out; over 5 GiB needs a typed `DELETE`), git worktrees in that scratch (report only: remove them with
  `tools hub worktrees remove`), moved-aside leftovers at least a day old (GenesisTools' own
  `/tmp/<date>-agents-removals`, plus the `/tmp` names in `GENESIS_TOOLS_MOVED_ASIDE_GLOBS`), old `$TMPDIR` entries
  grouped by name prefix (1 day for GenesisTools-owned prefixes, 3 days otherwise), and SwiftPM `.build` copies
  outside the primary checkout that are 2 days old.
- `app-bloat`: the Claude Desktop VM disks and caches, old `cursor-agent` versions, Cursor state of deleted projects
  and `CachedData`, Cursor's live `state.vscdb` (blocked), superseded ShipIt update downloads (the one
  `ShipItState.plist` stages is kept), Playwright browsers, Android emulator user data, logs of 1 GiB or more (only a
  finished GenesisTools day log is deletable; an open log frees nothing), and the Docker Desktop and OrbStack sparse
  VM disks (blocked, with the guest prune commands pinned to a context). A Cursor workspace counts as dead only when
  its project folder is positively gone (`ENOENT` on a mounted volume); an unmounted volume, `EACCES` or `EPERM` keeps
  it.

**Reclaim metadata.** Every `temp-leaks` and `app-bloat` finding carries this contract in `metadata` (the older
analyzers carry `paths` too): `kind`, `paths` (what `act` removes), `allocatedBytes`, `apparentBytes`,
`freeableFloorBytes` (clone-aware, when the volume can say), `ageDays`, `owner`, `requires.absentProcesses`,
`regenerates`, `restoreHint`, `sizeKnown`, and `blockers` (why `act` must refuse now: a running owner, an open
writer). Their ids follow `<analyzerId>:<kind>:<key>` and are stable between scans. `reclaimableBytes` is the
clone-aware floor when known, else the allocated ceiling.

**Scan gate.** When free space is under 1 GiB, or `fseventsd` holds 1 GiB of memory or more, the walk-heavy rules
(the large-file walk, the `node_modules` search, the agent-scratch and SwiftPM searches, Cursor's dead workspaces) do
not run, and the others list names and ages only (`sizeKnown: false`). `--json` reports the gate as `scanGate`.

**Sizes** are decimal (1 MB = 1,000,000 bytes), like the Finder and the Disk Manager. Until 2026-10-14 doctor divided
by 1024 and still printed "MB", so a 629,145,600-byte file read "600.0 MB" next to the Disk Manager's "629 MB".
The size thresholds are binary, so this README writes them as MiB and GiB: a 500 MiB threshold is 524 MB on
screen, and 1 GiB is 1.07 GB.

## Safety

Every finding has a severity:

- **safe** (green): preselected in the plain flow.
- **cautious** (yellow): the usual tier for a cache or a process.
- **dangerous** (red): `doctor act` always asks for the typed phrase.
- **blocked** (gray): no action, with a reason (a JetBrains cache, `kernel_task`, a VM disk).

`blocked` is enforced in the executor too, so no caller can run a blocked finding's action. A finding with
`metadata.blockers` is refused the same way.

The confirmation comes from the action: `none` (a plain command such as `brew cleanup`), yes/no, or a typed phrase.
Caches and regenerable data are yes/no; user data is never below typed. A large file from `disk-space` needs
`yes, trash` to move it to the Trash and `yes, delete` to delete it; the Claude Desktop VM disks (they hold the
Cowork session), the dead Cursor workspaces (chat history), the Android emulator data, large agent scratch, and
leaked `code_sign_clone` app copies when there are 5 or more of them need `DELETE`; killing a whole process group
needs the process name.

Processes that are never killed (`blocked`): `kernel_task`, `launchd`, `loginwindow`, `WindowServer`, `mds`,
`mds_stores`, `mdworker`, `coreaudiod`, `airportd`, `bluetoothd`, `cfprefsd`, `powerd`, `configd` and a few more
system daemons. Finder, Dock, SystemUIServer, ControlCenter, NotificationCenter and Spotlight are marked as
respawning by themselves.

Caches that are never listed as deletable: JetBrains, Raycast, 1Password, `com.apple.iconservices*`, HomeKit,
AddressBook, Docker Desktop, Cursor and VS Code under `~/Library/Caches`. This list and your own globs in
`blacklist.json` (see Configuration) apply to `system-caches` only.

### Trash staging

Large files from `disk-space` default to **moving to the Trash** in the interactive flows, after you type
`yes, trash` (they are your files, not caches); the other removal actions delete directly. The interactive flows
move and empty through Finder, which needs the Automation grant (see How it works). Items stay in the Trash
until you confirm with `DELETE` to empty it permanently (`Shift+D` in the dashboard), and emptying empties the whole
Trash. A Trash move stays on the same volume, so it frees nothing until then. If you quit midway, items stay in the
Trash and Finder's "Put Back" restores them.

## The `doctor act` door

This is the non-interactive door the Disk Manager uses. A typical caller scans, shows the user a finding, and then
acts on exactly that finding:

```bash
tools doctor --json --only temp-leaks > ~/scan.json
tools doctor act delete-clone \
    --analyzer temp-leaks \
    --id '<findingId from scan.json>' \
    --method trash \
    --yes \
    --expect '<findingId>=<reclaimableBytes>' \
    --expect-paths '<findingId>=<pathsHash>' \
    --dry-run
```

With 5 or more leaked copies, `delete-clone` needs a typed phrase: pass `--confirm DELETE` instead of `--yes`.

Actions it runs (only `remove-path` and `command` actions of disk or system analyzers; kill, install, reveal and
reinstall never run):

- `disk-space`: `stage-trash` (`--method trash`), `direct-delete` (`--method delete`), `empty-trash`,
  `delete-snapshots`
- `dev-caches`: `delete-node-modules` and `clear-derived-data` (`--method delete` only), `delete-unavailable`,
  `delete-stale`, `delete-all-for-runtime`, `prune-images`, `brew-cleanup`, `clean-<bun|npm|pnpm|yarn>-cache`
- `system-caches`: `delete-cache` (`--method delete` only)
- `temp-leaks`: `delete-clone`, `delete-moved-aside`, `delete-tmp-group`, `delete-scratch`, `delete-swiftpm-build`
- `app-bloat`: `delete-app-cache`, `delete-log`

The `temp-leaks` and `app-bloat` removals take either method. A removal pinned to one method refuses the other as
`method-conflict`. The other `dev-caches` actions run their own command and refuse `--method`.

A follow-up action (the reinstall after a package-cache wipe) is not run; it is listed in the result's `followUps`.

**It never takes a path, and it never reads a path out of an id.** It runs the rule that produces the requested ids
again (`Analyzer.recheck`, fresh, never the cache, whose findings have lost their `execute`), keeps only the
findings whose id matches exactly, and acts only on their `metadata.paths`. An id the fresh scan does not produce is
`not-found`; a hand-written `dev-node-modules-<any folder>` or `disk-large-<any file>` is refused that way. The Docker
finding id names its pinned context (`dev-docker-unused-images:<context>`), so a context switch between review and
act re-derives nothing.

Then these guards run per finding, and the first failure wins:

1. `not-found`
2. `blocked`
3. `unknown-action`, `category-not-allowed`
4. `method-required`, `method-not-applicable`, `method-conflict`
5. `confirm-required`: `--yes` for yes/no, the exact `--confirm <phrase>` for typed, and a dangerous finding always
   needs the phrase. The result names `requiredConfirm` and `expectedPhrase`.
6. `outside-allowlist`: the path guard below.
7. `in-use`: the finding's blockers, a process whose working folder is inside a path, or no process table at all.
8. `stale`: `--expect` is more than 25% away from the fresh `reclaimableBytes`, or `--expect-paths` differs from the
   fresh path set.

A second run while one holds the lock is refused as `locked`, before any re-check.

**The path guard** refuses a path that is missing, relative or a **symbolic link** (both methods refuse links
outright; `moveToTrash` also `lstat`s and refuses a link before it calls the system Trash command). The real path
must sit strictly inside the analyzer's allow roots (folders, or globs such as `$X/*.code_sign_clone`; temp-leaks
never allows all of `/tmp`), at least three components deep, and must not be `/`, `$HOME`, a system location
(`/System`, `/usr`, `/Library`, `/Applications`, `/private/etc`, `/private/var/db`, ...), a git checkout or worktree
root (a folder with a `.git` entry), a VM or container disk (Docker, OrbStack, Colima, Lima, Podman, Rancher Desktop,
Tart, Multipass, `~/.docker/machine`, `*.raw`, `diffdisk`, `basedisk`, `disk.img`, `*.qcow2` except an Android
emulator's `userdata-qemu.img.qcow2`) or the Photos library. "Is the app running" checks never count the
`doctor act` process or its ancestors, and when `ps` fails every such check blocks instead of passing.

**A run, step by step:**

- Passing items run under one lock (`~/.genesis-tools/doctor/act.lock`), taken before the re-derive. The lock is
  refreshed every minute and counts as stale after 30 minutes. `--dry-run` takes no lock.
- Right before each item the path guard and the in-use check run again, and a run longer than 30 s re-derives the
  remaining findings. So an app started midway, or a path swapped for a link, refuses the later items.
- A Trash move calls `/usr/bin/trash -v` for each path after a fresh path and in-use check. This needs macOS 15 or
  later, and it does not use Finder automation or need its Automation grant. The `empty-trash` action is different:
  it empties the Trash through Finder, like the interactive flows, and gives up after 120 s.
- A JSONL manifest `~/.genesis-tools/doctor/manifests/<runId>.jsonl` gets its `plan` line fsynced before anything
  changes, then `item-start`, `item-done` and `volume-after`.
- Free space is read with `statfs` before and after. Each item says `freesNow: "yes" | "no" | "later"`. A Trash move
  frees nothing until the Trash is emptied (`freesNow: "no"`), and after a large delete `df` may keep rising for
  several minutes.
- Every result goes to `history.jsonl`, Trash moves included. A manifest or history write that fails after a removal
  is reported on that item's `error`; the run still finishes and prints its result.
- `--ndjson` streams the same events and ends with `{"type":"result","result":{...}}`.

**Exit codes:** 0 when every item is `ok`, `staged` or (dry run) `skipped`; 1 when any is `refused` or `failed`; 2 for
an invalid call, with `{"schemaVersion":1,"error":{"kind":"invalid-call","message"}}` on stdout.

## How it works

- Pure local work: doctor runs macOS commands (`ps`, `vm_stat`, `sysctl`, `pmset`, `launchctl`, `netstat`,
  `ifconfig`, `system_profiler`, `fdesetup`, `spctl`, `csrutil`, `tmutil`, `du`, `fd` or `find`) and, for their
  findings, `brew`, `docker`, `xcrun simctl` and the package managers. Doctor sends nothing to a web service and
  costs nothing. An action such as `brew upgrade` downloads what it installs, and so does the global-package
  reinstall that the dashboard and the plain flow run right after a package-cache wipe.
- The dashboard and the plain flow move items to the Trash and empty it through Finder (`osascript`), and the
  `empty-trash` action empties it the same way. The first time, macOS asks whether GenesisTools may control Finder
  (System Settings, Privacy & Security, Automation). `tools` runs every tool through GenesisTools.app, so macOS
  gives the grant to the app, not to your terminal. Only `doctor act`'s Trash move uses `/usr/bin/trash` and needs
  no grant.
- Analyzers run in parallel: 4 at once, 8 with `--thorough` in the dashboard and the plain flow.
- An analyzer with a cache TTL writes its result to the cache and reuses it until the TTL runs out; `--fresh` or
  `wipe-cache` forces a new scan.
- A cached finding has no runnable action. Acting on it fails with "re-run doctor with --fresh".
- With `-v`, each analyzer logs when it starts, and when it ends with its duration and finding count.

State lives under `~/.genesis-tools/doctor/`:

- `analysis/<run-id>/`: each analyzer's raw JSON result, plus `run.json` (the plain flow's run summary)
- `cache/<analyzer>.json`: analyzer caches (each analyzer has its own TTL)
- `history.jsonl`: append-only log of every executed action (`doctor act` logs Trash moves too)
- `manifests/<run-id>.jsonl`: what each `doctor act` run planned and did, written before the first change
- `act.lock`: the single-instance lock of `doctor act`
- `global-packages-snapshots/<run-id>-<manager>.json`: the global packages saved before a package-cache wipe
- `blacklist.json`: your extra `~/Library/Caches` globs for `system-caches`

Performance targets from the first version (2026-04-28, not measured again since): cold start under 200 ms, a
standard scan under 6 s, `--thorough` under 30 s. Install `fd` (`brew install fd`) for file walks that are about ten
times faster; `disk-space` offers the install as a finding when `fd` is missing and Homebrew is present.

## Configuration

Add `~/Library/Caches` globs that `system-caches` must never offer to delete in
`~/.genesis-tools/doctor/blacklist.json`. The other analyzers do not read this file, so a glob such as `~/.npm/**` or
a `node_modules` path changes nothing. `**` matches any depth, `*` stays inside one folder, and `~` is your home:

```json
{
    "cacheGlobs": [
        "~/Library/Caches/com.example.myapp/**"
    ]
}
```

A matching cache becomes `blocked` with "User-defined blacklist match". A file that does not parse is ignored.

Environment variables (all optional):

- `GENESIS_TOOLS_DEV_CACHE_ROOTS` (`dev-caches`, `temp-leaks`): extra checkout roots, `:` separated, `~` allowed.
  Set it when the root discovery does not reach a folder of checkouts: it walks two levels under `~` with a time
  budget, and skips hidden folders and symlinks.
- `GENESIS_TOOLS_AGENT_SCRATCH_ROOT` (`temp-leaks`): the scratch root coding agents write into, one folder per project
  and then per session (for example `/tmp/cc`). Unset, the scratch rules are off.
- `GENESIS_TOOLS_MOVED_ASIDE_GLOBS` (`temp-leaks`): extra folder names under `/tmp` that hold items moved aside
  instead of deleted, `:` separated, `*` matching any run of characters (for example `disk-reclaim-*`).
  GenesisTools' own move-aside folders are always included.

## For agents

- `tools doctor --json` prints the findings document (schema 1) and never runs a fix; the Disk Manager calls it as
  `tools doctor --json --dry-run`. Combine it with `--only` and `--fresh`.
- Document: `{schemaVersion, runId, startedAt, endedAt, analyzers, scanGate, findings[], errors[]}`. Each finding has
  `id, analyzerId, title, detail, severity, reclaimableBytes, blacklistReason, fromCache, pathsHash,
  availableActionIds, actions[], metadata`. `pathsHash` is `sha256:` of the sorted `metadata.paths` joined by
  newlines, and null without paths. Each action is `{id, label, confirm, confirmPhrase?, staged, kind: "remove-path" |
  "command" | "other", method?, actable}`. An analyzer that threw is in `errors` as `{analyzerId, error}`.
- Act on a finding with `tools doctor act` and read `items[].status` and `items[].reason`. Pass back `--expect` and
  `--expect-paths` from what you showed the user, and start with `--dry-run`.
- `tools doctor cpu --json` answers "what is burning CPU right now" (it takes the `--window`, 3 s by default, to
  answer); the performance skill points there.
- `log --json` and `stats --json` print the history entries and the totals.
- Frozen samples: `src/macos/GenesisKit/Sources/GenesisKitFixtures/Disk/contract-doctor-*` (GenesisKit's one copy;
  `act.test.ts` and `reclaim-analyzers.test.ts` keep the keys and nesting of real output equal to them).

## Troubleshooting

- **An action fails with "this finding came from the analyzer cache and cannot run".** The analyzer reused a cached
  result (for example `disk-space` within an hour of the last run). Run `tools doctor --fresh`.
- **"Terminal is NxM - falling back to --plain".** The dashboard needs at least 80 columns and 24 rows.
- **"No terminal, so nothing is acted on".** The plain flow lists findings only when stdin is not a terminal (a
  pipe, CI, an agent). Run it in a terminal, use `--json` for the data, or use `tools doctor act`.
- **`find` prints "0 files matched" for a folder you know is full.** `find` exits non-zero when it meets a folder it
  may not read, and the search stops after 30 s. Install `fd`, or point `--root` at a smaller folder.
- **`node_modules` of some checkouts are missing.** Their parent folder is deeper than two levels under `~` or was not
  reached in time. Add it to `GENESIS_TOOLS_DEV_CACHE_ROOTS`.
- **Disk findings show no sizes (`sizeKnown: false`).** The scan gate is on: free space is under 1 GiB or
  `fseventsd` uses 1 GiB or more. Free some space first; the gate is in `--json` as `scanGate`.
- **`doctor act` refuses with `locked`.** Another `doctor act` holds `~/.genesis-tools/doctor/act.lock`. Wait for it;
  a lock that is not refreshed for 30 minutes counts as stale.
- **Free space did not grow after a Trash move.** A Trash move stays on the same volume. Empty the Trash.
- **"Could not stage <path>: ..." or "Trash empty command reported failure. Check Finder."** The dashboard and the
  plain flow move and empty the Trash through Finder. One cause is a missing Automation grant: macOS refused the
  request, or nobody answered it. Allow GenesisTools to control Finder in System Settings, Privacy & Security,
  Automation, then try again. A Trash move through `doctor act --method trash` does not need the grant.
- **`doctor act delete-clone --yes` refuses with `confirm-required`.** With 5 or more leaked copies the action needs
  `--confirm DELETE`.
- **`doctor act` refuses with `method-conflict`.** `delete-node-modules`, `clear-derived-data` and `delete-cache`
  take `--method delete` only.
- **The flush DNS action did not restart `mDNSResponder`.** That part runs only as root; `dscacheutil -flushcache`
  still ran.

## Related

- [tools du](../du/README.md): measure disk usage without changing anything.
- [tools hub](../hub/README.md): `tools hub worktrees remove` for the worktrees `temp-leaks` reports.
- [tools macos](../macos/README.md): clone-aware disk usage on APFS, and GenesisTools.app, whose Disk Manager reads
  `--json` and calls `doctor act`.
- [tools rm](../rm/README.md): delete files through a Trash that drains in the background.
