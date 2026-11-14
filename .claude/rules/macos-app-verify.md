---
paths:
  - "src/macos/GenesisTools/Tests/**"
  - "src/macos/lib/permissions/app.ts"
---

# GenesisTools.app: verify without a screen, and tests that need a picture

Covers snapshot runs, the hub bench, logic tests, the hub's verification flags and keys, and the rebuild's retired bundles.

## Verify without a screen

- `GenesisTools --review --repo <path> [--scope branch] [--proposal <file>] --snapshot /tmp/x.png`
- `GenesisTools --hub [--mode worktrees|prs] [--session <id>] [--pr <n>] [--tab …] [--panes transcript,changes,files] [--file <path>] [--style unified] [--glass on] [--width <pt>] --snapshot /tmp/x.png`
  (`--file` renders that one file of the diff; a file only scrolled into view never paints in the invisible snapshot window)
- From a worktree: `swift build`, then `.build/debug/GenesisTools --hub … --snapshot x.png` runs outside a bundle (the web
  diff viewer does not load there: its pane shows "viewer did not load", so judge diffs in the real app). The app calls the
  MAIN checkout's `tools` unless `GENESIS_TOOLS_BIN=<worktree>/tools GENESIS_HUB_SERVER=0` is set, so without them a
  snapshot shows the main branch's CLI data. A defaults gate takes a launch argument: `-GenesisToolsStagingFaces YES`.
- Resize performance: `GenesisTools --hub --session <id> --panes transcript,changes --bench /tmp/b.json`
  (sidebar drag, file-list drag, window and pane-divider sweeps with jitter; main-thread busy ms per step from run-loop
  observers, plus layout-flip probes; `GENESIS_HUB_BENCH_ONLY=sidebar` for one sweep, e.g. under `sample`). Scripted
  runs use a scratch copy of the hub's settings (`HubDefaults`), never the live layout. `--mode timeline` adds
  `activity` (the Activity rail's filters clicked) and `inbox` (the mode switch). `GENESIS_HUB_BENCH_ONLY=modes` switches
  through every mode twice, 2 s apart, one scenario per mode (`mode.prs`, …): what a switch costs on the main thread,
  and the way to profile one off screen (`sample` the bench process while it runs). 🛑 Measure clicks with
  `GENESIS_HUB_BENCH_AX=1`: the live hub always has an accessibility client (dictation, `tools control`), and with
  one SwiftUI walks every responder per changed accessibility node; a click that costs 90 ms without it costs 1.6 s.
- Logic tests: `bun run app:test [-- --filter <name>]` for this folder (Tests/; it runs `swift test` in the app build's
  own tree, `.claude/rules/macos.md`), and `swift test` in `../GenesisKit` for the shared code (its SessionTranscriptScrollTests
  and WindowTitlebarTests open windows the same way). Here only LiveTimeTests
  open a window, alpha 0 below the desktop and never activated; `SESSION_SCROLL_PERF=1` adds the transcript's scroll and idle cost lines.
- Read the PNG. The web diff is composited from WKWebView's own snapshot, so it needs no Screen Recording grant.
- A `--snapshot` run uses the `.prohibited` activation policy and an alpha-0 window (`orderInForSnapshot`): it never
  shows on screen and never takes the keyboard. Martin's typing once landed in the hub search field because a
  snapshot run became the active app. It waits for a web diff only when the screen shows one
  (`HubModel.snapshotShowsDiff`): Inbox, Activity and the Agents list take 4 to 12 s, not 35 to 44. Its stall
  lines carry `run=snapshot pid=<n>` and it spawns no `sample`, so its title bar audit is never read as the
  live hub stalling.
- Open the hub with `tools hub` (builds the app when it is missing or stale; `--mode`, `--session`, `--pr`, `--tab`,
  `--filter <text>` (the session list, which also searches every project's history), `--palette [text]`,
  `--find [text]`). `GenesisTools --hub` also takes `--transcript-query <text>` (the transcript opens with a
  whole-session search). The same flags work in a `--snapshot` run, which is how to verify these overlays.
- Keys: ⌘K command palette (Hub/HubPalette.swift: `<project> <keyword> <id>`, "gt pr 424", Tab completes),
  ⌘⇧F find in files (Hub/HubFind.swift, rg over the session's project and added folders), ⌘⇧G glass (previous
  match instead while a panel's find bar is open), ⌘F find in the panel the keyboard is in (the transcript and the
  diff keep their own; the file list focuses "Filter files…"). Snapshot a panel's find with `--panel-find <scope>:<text> [--panel-find-next <n>]` (scopes:
  timeline, worktree.cleanup, pr.overview, pr.threads, decisions, inbox); `--set <key>=<true|false|text>` sets a
  scratch setting first (`--set review.prThreads.open=true` shows the PR threads list, `--set hub.timeline.range=last30`
  the 30-day Activity). `--timeline-open <event id> [--timeline-action <id>]` runs an Activity row's action once the
  feed loads (`diff` on a review comment: the PR's diff at that thread, one click).
- The Native style in a snapshot: `--set hub.style=native --set featureSettings.appearance.theme=glass|solid|gradient|graphite|midnight|dusk`
  (scratch only; `HubDefaults.isolate()` copies General's `featureSettings.appearance.*` too). A `--snapshot` cannot show
  the desktop behind glass: it draws the blur as flat grey. The Hub settings pages need a bundle under `--features`; from
  a checkout use `../GenesisClickyPreview` (`swift build --disable-build-manifest-caching`, see `.claude/rules/macos.md`,
  then `.build/debug/GenesisClickyPreview --page hub.appearance
  --theme gradient --hub-style native --snapshot x.png`), which writes only its own preview suite and tells no hub.
  It shows the Widgets pages with `--sessions <n>` (a made-up roster) or `--widget-snapshot <file.json>` (a saved
  `tools hub widget snapshot --json`).
- A Settings snapshot (`--features --page <id> --snapshot`, and GenesisClickyPreview) is the window server's own composite
  (GenesisKit `WindowSnapshot`). `cacheDisplay` skips the backdrop and portal layers Liquid Glass is made of, and SwiftUI
  draws everything a glass view covers through them, so a page holding glass came out transparent: Projects / Sessions
  under Gradient, every page under Glass (2026-10-11; the live window was never affected). The capture needs the
  Screen Recording grant, and the window turns opaque only once it sits under the desktop picture. Without either it
  falls back to `cacheDisplay`, and the stderr line says `by cacheDisplay (<why>; …)`. The `--hub` and `--review`
  snapshots still draw with `cacheDisplay`.
- Files → "Add folder" (Hub/HubFolders.swift): more roots per session; Changes picks roots with "Changes in <folder>"
  checkboxes. Stored per session in `HubDefaults` (`hub.extraFolders.<id>`). All ticked roots share ONE review
  (Review/ReviewRoots.swift, `ReviewModel.setRoots`): one toolbar, one diff, one Files tree with one top-level folder
  per root, every path under its root's folder name. Map a merged file back with `locate(fileID:)`,
  `absolutePath(of:)`, `file(atPath:)`; never join `model.repo` with `file.path`.
- The open transcript follows its session with ONE long-running `tools ai sessions tail <id> --live --offset <n>`
  per open detail (GenesisKit `TranscriptLiveTail` on `ToolsLineStream`, shared with Genesis): each stdout line is a turn with its
  `index` (a changed turn comes again and replaces its row), a totals line, or an `activity` line when what the agent
  does changes (thinking, an open tool call, waiting for the user, idle). The activity is the transcript's last row
  through a `TranscriptActivityFeed` that only that row observes (passed as a value, each change re-ran the list:
  87 to 372 ms of main thread per second against 20 ms), the header's coarse status (`HeaderState`) and the session
  list's dot (`HubLiveActivityStore`); never derive "working" from the last write's age again. It stops when the detail closes, the
  session changes, the window hides or minimizes, and when the app quits (the child ends on stdin EOF); one restart
  on an unexpected exit, stderr in `app-perf.log` (`hub.transcript.follow`). Never spawn a `tools` process per file
  growth again. ⌘F searches the whole session (`tools ai sessions grep` + `tail --turns`).
- To SEE the live window (not a snapshot), `tools control screenshot --app GenesisTools --path /tmp/x.png`: a window
  capture with no accessibility walk, so it works while a transcript streams. Since 2026-09-27 (24a236c41) a
  snapshot skips the web diff's own image under a modal panel (digest, rules, search, prompts, handoff, palette,
  find) and draws a SwiftUI sheet, which an off-screen parent gets as an unattached `SheetPresentationWindow`.
  A snapshot taken before a search or load finished shows its empty state: read `app-perf.log` for the span.
  One hub runs at a time: a second `GenesisTools --hub …` hands its flags to the running hub and exits
  (Hub/HubSingleInstance.swift: the hub holds a `flock` on `~/.genesis-tools/hub/hub.lock`, dropped by the kernel on exit).
- A rebuild never deletes the replaced bundle: it moves to `~/.genesis-tools/app/retired.noindex/<ms>/`. After the
  install window the newest two retired bundles and every one a running process executes stay folders; other idle
  ones are packed into `<ms>.zst` (tar inside zstd, `tools compress unpack` restores one), at most 5 packed copies
  and none older than 14 days (`packRetiredBundles` in `src/macos/lib/permissions/app.ts`). Claude sessions run
  inside the launcher binary they started with, and
  tccd denies every grant to a process whose binary is gone. The launcher also exports `GENESIS_TOOLS_APP_INODE`;
  `tools` re-enters the current launcher when it differs (`genesisAppLauncher()`). A build that finds no signing
  identity while the installed app is Developer ID signed refuses to install ad-hoc (a sandboxed shell cannot read
  the keychain). Worktree builds install the same way and keep the grants.
- A pinned retired bundle stays, so every open Claude session keeps one build alive (2026-11-01: 22 pinned folders,
  3.5 GB, one per build since 10-19). A launcher maps only `Contents/MacOS/GenesisTools` (`lsof` shows `txt`), so
  after each build a background `tools macos permissions retired --apply` makes the retired bundles'
  `Contents/Resources` (Clicky sounds, web viewers, icon: about 65 MB of 154 MB) APFS clones of the installed copy;
  the bytes do not change, so the seal and every grant stay. It never touches the executable, `Info.plist` or
  `_CodeSignature`, and marks each folder it finished with `resources-shared`. `tools macos permissions retired`
  alone is the dry run; measure with `tools du clonesize`, never `du`. Only the binary (about 93 MB per pinned
  build) still piles up while its session lives.
- After a rebuild, restart a running hub without stealing focus, by its pid only (a `pkill -f` pattern also
  killed other agents' snapshot runs, 2026-09-24): `kill <pid of MacOS/GenesisTools --hub>` if the build did not
  reap it, then `tools hub open --no-activate` with the flags it had.

## Tests that need a picture or a screen

- **A SwiftUI view in a test has no accessibility tree.** `NSHostingView` walked with `accessibilityChildren()` returns nothing, in or out of a window. Assert what a view shows by rendering it: `ImageRenderer(content:)` with `scale = 2`, then `VNRecognizeTextRequest` (`.accurate`, language correction off) on `renderer.cgImage`. About 0.3 s, and no window.
- **Five GenesisKit window-animation and transcript-scroll tests fail while the screen is locked** (`tools control window --app <pid> --json` prints `"screenLocked": true`). Run the same filter at a known green commit as a control before you blame a change.
