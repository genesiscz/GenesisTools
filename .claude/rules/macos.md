---
paths:
  - "src/macos/**"
  - "src/utils/macos/**"
  - "src/notify/**"
---

# macOS app, notifications and privacy grants

Loaded by Claude Code when you read, write or edit a file under `src/macos/`, `src/utils/macos/` or `src/notify/`. Window rules for the Swift app are in `.claude/rules/macos-app.md`.

## 🛑 Changing Swift under `src/macos/GenesisTools/` — always `bun run app`

**While you work on the app, keep `tools hub dev monitor` running under the Monitor tool** (hangs, stalls,
layout loops, link-relay trouble and crash reports as events; `.claude/rules/macos-app.md`).

`swift build` alone proves nothing: it writes `.build/`, and the thing answering on your Mac is the
installed bundle at `~/Applications/GenesisTools.app`. **After ANY edit to `Sources/**` or
`Info.plist`, run `bun run app`** (alias of `tools macos permissions build`). It builds, assembles,
signs, atomically swaps the bundle, re-registers with Launch Services, and then reaps stale
processes. `bun run app:status` prints what is installed and whether it is stale.

**🛑 A package that uses GenesisKit by path** (`src/macos/GenesisTools`, `GenesisClickyPreview`,
`GenesisWidgetPreview`) **is built, tested and run with `--disable-build-manifest-caching`**:
`swift build --disable-build-manifest-caching` in the preview packages. SwiftPM re-plans a build
only when the ROOT package's own folders, `Package.swift` or `Package.resolved` change, so a Swift file added
to GenesisKit is never compiled into the dependent, and its first use fails with "cannot find 'X' in scope" on
correct code. It hit three merges on 2026-10-10 and the Clicky preview twice on 2026-10-12. The flag costs
about 0.1 s. `bun run app` decides it by itself (a hash of the Swift file list in `app.ts`), and the shell guard
blocks the bare command (rule `swiftpm-stale-plan`). GenesisKit's own tests do not need it.

**The app's tests: `bun run app:test`** (`tools macos permissions test`; pass `swift test` arguments after `--`:
`bun run app:test -- --filter HubUsageTests`). It runs `swift test` in the app build's own scratch tree
(`.build/opt`, every part, `-O`, no index store) and decides the manifest flag the same way. A plain `swift test`
builds a second full tree in `.build`: measured 2026-11-05, 1676 MiB, against 260 MiB that the tests add to the
app's tree, and the app build after a test build took 2.6 s (nothing rebuilt). The suite gives the same result
both ways (886 tests, 0 failures).

**🛑 The reap is the part that matters, and it is why this is a rule rather than a suggestion.**
macOS delivers a notification click to the bundle's ALREADY-RUNNING instance and only launches a
fresh one when none exists. So a settings window or an `--rpc` process from an older build keeps
receiving every click and answers with whatever code it was built from — silently, because it looks
exactly like a working app. Observed 2026-09-16: a window instance started at 13:48 swallowed every
click for the rest of the session while three separate "fixes" were written against a process that
was never running them, and a hung `--rpc` process spun at 60% CPU for an hour doing the same. The
reap now runs inside `buildApp()` (`src/macos/lib/permissions/app.ts`, `reapStaleAppFaces`), so every
path gets it; it is proven to catch by planting a `--window` instance and rebuilding.

⚠️ It kills **only** argument-less and flag-argument faces (`--window`, `--rpc`). It never touches
`GenesisTools <program> [args...]`, which is the launcher running the user's real work — dev servers,
editor sessions, long builds all run under it.

The faces it reopens come back with their own `GENESIS_TOOLS_HOME`, `GENESIS_TOOLS_BIN` and `GENESIS_HUB_SERVER`
(`RESTORED_ENVIRONMENT` in `src/macos/lib/permissions/relaunch.ts`), read from each stopped process through the kernel,
and with the argv record from that face's own home. `open` hands its caller's environment to the app (a recorder face
reopened by a worktree build carried that build's `node_modules/.bin` PATH and its Claude session variables), so before
2026-11-05 a Meetings window started on a sandbox came back on the real data, and a build run on a sandbox would have
moved every face onto it. A face whose environment the kernel withholds stays closed, and the build output says so
("did not reopen the … face").

**Which commit is installed? One command: `bun run app:status`.** Its `source` line reads
`<branch> @ <12-char sha>[+dirty] (<checkout>)`, written into `~/.genesis-tools/app/manifest.json` by every build
(`sourceRoot`, `sourceBranch`, `sourceCommit`, `sourceDirty`). `+dirty` means the Swift sources had uncommitted changes,
so the sha alone does not name the code. A build from before 2026-10-06 shows "unknown": its manifest has only `builtAt`,
`sourceHash`, `signedWith` and `teamId`, so it records no checkout and no commit; `builtAt` against the `git log` of the
checkouts you build from is the only lead. `built … (stale: sources
changed)` compares file contents of THIS checkout with the install, so a stale flag from another worktree's build is expected.

**How did a face end? Read `~/.genesis-tools/app/lifecycle.jsonl`** (since 2026-11-04,
`Sources/Host/App/FaceLifecycle.swift`). Every long-lived face (the window faces, every part face, the link relay)
writes one JSON line per `start`, `exit`, `terminate` (with the quit Apple Event's sender), `signal`, `crash`,
`exception`, `window-close` and `quit-request` ("Quit All" names the pid that sent it). A face that left no line at all
(SIGKILL, a jetsam kill, a power loss) is reported as `vanished` by the next face that starts, from its marker in
`app/lifecycle-alive/<pid>`. `t` is epoch seconds: `jq -r '"\(.t | strftime("%m-%d %H:%M:%S")) \(.pid) \(.face) \(.event) \(.detail // "")"'`
prints it in UTC. The widget stayed off for two days from 2026-11-02 with no trace of how it ended; this log is why
the next stop has one. Every window face other than the widget also starts the widget while "Show the widget" is on
(`WidgetLaunch.ensureRunningIfShown`), so quitting the hub with "Quit All" and opening it again brings the widget back.

**Before believing an app-face bug report, check what is actually running:**
`ps -Ao pid,lstart,command | rg "MacOS/GenesisTools" | rg -v "gt-cc|gt-claude|bun "`. A bare entry
with no program argument is a window instance, and its start time tells you which build it is.
An entry whose only argument is an `https://…` link and that is older than a minute is a STUCK LINK ROUTER:
macOS hands every later click to it, it has no URL handler, and the click vanishes ("Raycast quicklink opens nothing",
2026-10-06: one lived 5 h 27 m). Cause that day: an install whose Info.plist declares document types (Recast) made
AppKit open the link in argv as a file (modal "document could not be opened") and cancel `terminate` ("not all
documents were closed"; find it with `command log show --predicate 'processID == <pid>' | rg -i terminat`). A router
now quits with `exit(0)`, never `NSApp.terminate`, and a build is not done until one `open -a ~/Applications/GenesisTools.app
https://example.org/` leaves no router running after ~8 s.

**Notifications specifically** (`src/macos/GenesisTools/Sources/Host/Notify.swift`, reached from
`src/utils/macos/notifications.ts` via `genesis-app-rpc.ts`): `tools macos permissions build`, then
`tools notify status`. `alertStyle: banner` means macOS's "Temporary" — the banner fades in ~5 s,
taking its buttons and attachment with it, and **code cannot change this**
(`UNNotificationSettings.alertStyle` is read-only by design). The only fix is the user picking
"Persistent" in System Settings, deep-linked by `tools notify settings`. `timeSensitiveSetting:
notSupported` is likewise permanent: the entitlement needs a provisioning profile a Developer ID
signature cannot carry, so `ignoreDnD` is accepted and ignored. First grant on a machine is
`tools notify authorize` (post will not put up a prompt the 8s RPC deadline cannot survive). Click
handling logs every launch and action to `~/.genesis-tools/app/notify-clicks.log` — read it before
theorising, since a click runs in a process with no terminal and a dropped click is otherwise
indistinguishable from no click at all.

## macOS privacy grants (TCC) live on GenesisTools.app

`tools` runs every tool through `~/Applications/GenesisTools.app` (source `src/macos/GenesisTools/`, built by `tools macos permissions build`, signed with the first Developer ID or Apple Development identity on the machine, ad-hoc as a last resort; an ad-hoc build loses every grant on the next rebuild, and `tools macos permissions` says so). The launcher disclaims responsibility for itself, so macOS attributes Calendar, Reminders, Contacts, Full Disk Access, Accessibility and Automation to `com.genesiscz.genesistools`, not to the terminal. Consequences for agents:

- **An empty result from a permission-gated tool is never proof of empty data.** Run `tools macos permissions` (all grants) or `tools macos calendar doctor` first; both exit 1 while something is missing and print the pane to open.
- Never read `__CFBundleIdentifier` to name the responsible app; use `responsibleIdentity()` from `@genesiscz/utils/macos/genesis-app`, which knows about the launcher marker.
- `GENESIS_TOOLS_NO_APP=1` bypasses the launcher (grants then follow the terminal again). Use it only to reproduce the old behaviour. The window (`tools macos permissions ui`) has the same switch as a persistent marker; `tools macos permissions` reports it.
- darwinkit stays a plain child: never start it with `disclaim: true` from GenesisTools, or the grants split into a second identity (`DarwinKit.app`).

## Retired app copies answer links

`open -b com.genesiscz.genesistools <url>` can reach a RETIRED copy of the app: Spotlight indexes `~/.genesis-tools` and registers every bundle it finds, and an old copy with an old router then loops or drops links. Retired copies live in `~/.genesis-tools/app/retired.noindex/` (Spotlight skips `*.noindex`), and every build unregisters them before it packs the idle older ones into `<ms>.zst` files (never bundles, so lsregister never sees them). Check: `lsregister -dump | rg "^path: .*GenesisTools\.app"` must list only `~/Applications/GenesisTools.app`. A test that runs the real `install.sh` under a temporary HOME registers one too.
