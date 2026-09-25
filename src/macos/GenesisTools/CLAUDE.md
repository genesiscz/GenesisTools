# GenesisTools.app (Swift) — rules for every window

Loaded automatically when you work under `src/macos/GenesisTools/`. The root CLAUDE.md rule still
applies: after ANY edit to `Sources/**`, `web/**` or `Info.plist`, run `bun run app` (build, sign,
install, reap stale faces). Swift UI you have not seen rendered is not done.

## Use the shared components (Sources/Hub/HubComponents.swift), never hand-roll these

| Need | Use | Never |
|---|---|---|
| An icon-only button | `IconButton(systemName:tooltip:action:)` | a bare `Button { Image(...) }` without a tooltip |
| Any other control that is not self-explanatory | `.instantTooltip("…")` (Hub/Stolen/UI/InstantTooltip.swift) | `.help(...)` alone: it shows after a long delay and is easy to miss |
| A link to a web page (repo, branch, PR, commit) | `ExternalLink(text:url:)` (opens in Brave, shows the ↗ glyph) | plain text that happens to be a URL |
| Repo / branch web URLs, the branch's PR/MR | `RepoFactsStore.shared.facts(for: path, pr:)` (fed by `tools hub repo --json`) + `PullRequestLink` | parsing `git remote` in Swift, or any `Process` in a view body |
| A file or folder path | `PathLabel(path:)` (menu: Finder, Cursor, cmux, copy; plus copy / reveal / Cursor icons) | a bare `Text(path)` |
| Open a file at a line | `PathOpener.cursor(path, line:)` | `open -a` without the line |
| A side panel | `ResizableSidePanel(key:edge:title:minWidth:maxWidth:autoCollapse:)` (Hub/HubPanels.swift: grip on hover, release below the minimum collapses to a rail, width saved on release only; during a drag the layout keeps the start width and the panel draws over its neighbour, one reflow on release; the parent passes the room it has as `maxWidth` and `autoCollapse` when there is none, which shows the rail and opens the panel as a drawer) | a fixed `.frame(width:)` sidebar, a width written to `@AppStorage` on every drag step, or moving the neighbouring panes per step (each move of a focusable list makes SwiftUI rebuild the key view loop over every transcript row: 82 ms/step) |
| A heavy pane (transcript, diff) | `.freezesWidthWhileResizing()`: keeps its size while `HubLiveResize` is active (panel drag, window live resize, pane divider) and reflows once at the end. `heavy: false` for a pane that should follow a pane-divider drag live (everything but the transcript list; frozen, it left a dark gap beside the divider) | letting a `List` re-measure every row per resize step (395 ms/step measured), or ending a divider drag on a local mouse-up monitor (NSSplitView's tracking loop swallows it; `HubLiveResize` polls the button instead) |
| A list row that acts as a button | `.rowButton(cornerRadius:)` → `HubRowButtonStyle`: soft fill in the row's own frame; keep gaps and insets OUTSIDE the button so hover box = selection box | `genHoverRow(accent: .white)` (45 % white outline) or padding inside the button |
| A background | `.hubSurface(.chrome / .content / .bar)`: opaque normally, translucent in glass mode (`HubGlass`, ⌘⇧G) | `ReviewPalette.sidebar` / `.background` directly |
| A sidebar group header | `GroupHeader` + `GroupPrefs` (collapse, pin, move up/down, persisted) | an uppercase static label |
| A status message | `NoticePill` (fades, error stays) | a raw colored `Text` line |
| Find inside a panel (⌘F) | Hub/HubPanelFind.swift: `@State` `PanelFindModel`, `PanelFindBar` under the header as its own row above the scroll view, `.panelFind(find, revision:rows:)` on the root, `.findRow(id)` per row, `FindText(text, field:)` for shown text (`MarkdownContentView` + `.findField(key)` for markdown). A pane with its own find registers with `.panelFindNative(scope)`, an overlay that owns the keyboard with `.panelFindModal()` | a bar in `.safeAreaInset(edge: .top)` (selectable text draws through it), a SwiftUI `.keyboardShortcut("f")` button or a local key monitor per view: `PanelFindRouter` is the one ⌘F / ⌘G / ⇧⌘G / Esc owner and sends the key to the panel of the last click |
| A PR/MR's review threads or any write to them | `ReviewModel.attachPR` → `PRThreadsStore` + `PRCommand` argv (Review/PRThreads.swift, fed by `tools hub pr`). The diff's thread cards carry Reply / Resolve / Edit / Delete (web/diff-viewer/main.ts, `renderLiveThread`): the page only posts `thread.action`, and Swift confirms, runs `tools`, then answers `threadDone`. The PR bar and threads list are in Review/PRThreadsPanel.swift. 🛑 `PRCommand.publish` has one caller, the Submit review confirmation (a test scans Sources for it) | `tools github …` / `tools gitlab …` calls from a view, or a second path to `publish` |

**Every button has a hover effect.** Icon buttons: `IconButton` (uses `.genHoverIcon()`); text-like buttons and
links: `.buttonStyle(.genHoverPlain())`; list rows and menu rows: `.buttonStyle(.genHoverRow())` (all from
Hub/Stolen/UI/GenHoverButton.swift). Never `.buttonStyle(.borderless)` on something clickable.

**Every button that shows only an icon has a tooltip.** Check before you finish: `rg -n 'Image\(systemName' Sources | rg -v 'IconButton|instantTooltip'` and look at each hit.

## 🛑 Never block the main thread inside a view body

`Process.waitUntilExit()` spins the main run loop. Inside a SwiftUI `body` that lets AppKit lay out
the view that is still being computed: AttributeGraph prints `cycle detected` and SwiftUI's
StackLayout array is freed twice (EXC_BAD_ACCESS in `StackLayout.Child`, hub crash 2026-09-24).
A body only reads cached state; anything that spawns, reads git, or hits the disk more than a
stat goes through a store that loads on a background queue (see `RepoFactsStore`). Data that the
`tools` CLI can compute comes from `tools`, not from Swift reimplementations.
To find a cycle: `AG_TRAP_CYCLES=1 GenesisTools --hub … --snapshot /tmp/x.png`, then read the
newest `~/Library/Logs/DiagnosticReports/GenesisTools-*.ips` stack.

## Measure every load

Every load that can be slow runs in a span: `HubPerf.begin("area.what", detail)` then
`span.end()`, or `HubPerf.measure(...)`. Spans, stalls and hang samples go to
`~/.genesis-tools/logs/app-perf.log` (stolen `PerfLog`; `.main` suffix = ran on the main
thread; `SLOW` marks at 100 ms). `HangWatch` samples the main thread into
`~/.genesis-tools/logs/hangs/` after 1 s. Summary: `bun scripts/perf-report.ts --tail 5000`.
Watch it while you click: `tail -f ~/.genesis-tools/logs/app-perf.log | rg 'SLOW|stall|main '`.
A span times work, not the SwiftUI layout it causes: after a state change the renderer runs in the
next run-loop passes. `HubMainBusy.measure("area.what")` (HubPerf.swift) logs the main thread's busy
time over the next 600 ms, which is what an append or a reload really costs on screen.

## Look

- Palette: `ReviewPalette` (Review/ReviewWindow.swift) for hub and review; `SessionPalette` inside the stolen session screen. Dark only, near-black background, white-alpha hairlines, green/red/orange/blue status colours.
- Group and project names keep their own case. No uppercase section titles except tiny kickers ("AGENT ANALYSIS").
- Dense rows (24–28 pt), monospaced numbers with `Text(verbatim:)` (locale grouping turned "+7711" into "+7 711").

## Stolen code (Hub/Stolen/)

Files copied from GenesisPlayground/Genesis carry a `// Copied from <path> at <time> at commit hash <sha>` header.
Keep them verbatim so `/steal-code --reconcile` can three-way merge upstream changes. Any local change is a
marked adaptation (`// GenesisTools adaptation: …`). Missing Genesis types go in `Hub/StolenShims.swift` or
`Hub/MarkdownShim.swift`, not into the stolen files.

## Verify without a screen

- `GenesisTools --review --repo <path> [--scope branch] [--proposal <file>] --snapshot /tmp/x.png`
- `GenesisTools --hub [--mode worktrees|prs] [--session <id>] [--pr <n>] [--tab …] [--panes transcript,changes,files] [--file <path>] [--style unified] [--glass on] [--width <pt>] --snapshot /tmp/x.png`
  (`--file` renders that one file of the diff; a file only scrolled into view never paints in the invisible snapshot window)
- Resize performance: `GenesisTools --hub --session <id> --panes transcript,changes --bench /tmp/b.json`
  (sidebar drag, file-list drag, window and pane-divider sweeps with jitter; main-thread busy ms per step from run-loop
  observers, plus layout-flip probes; `GENESIS_HUB_BENCH_ONLY=sidebar` for one sweep, e.g. under `sample`). Scripted
  runs use a scratch copy of the hub's settings (`HubDefaults`), never the live layout.
- Logic tests: `swift test` in this folder (Tests/, no windows).
- Read the PNG. The web diff is composited from WKWebView's own snapshot, so it needs no Screen Recording grant.
- A `--snapshot` run uses the `.prohibited` activation policy and an alpha-0 window (`orderInForSnapshot`): it never
  shows on screen and never takes the keyboard. Martin's typing once landed in the hub search field because a
  snapshot run became the active app.
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
- Files → "Add folder" (Hub/HubFolders.swift): more roots per session; Changes picks roots with "Changes in <folder>"
  checkboxes. Stored per session in `HubDefaults` (`hub.extraFolders.<id>`). All ticked roots share ONE review
  (Review/ReviewRoots.swift, `ReviewModel.setRoots`): one toolbar, one diff, one Files tree with one top-level folder
  per root, every path under its root's folder name. Map a merged file back with `locate(fileID:)`,
  `absolutePath(of:)`, `file(atPath:)`; never join `model.repo` with `file.path`.
- The open transcript follows its session file (Hub/HubTranscriptTail.swift, a file event source, no timer) and
  appends turns from the last known one; ⌘F searches the whole session (`tools ai sessions grep` + `tail --turns`).
- To SEE the live window (not a snapshot), `tools control screenshot --app GenesisTools --path /tmp/x.png`: a window
  capture with no accessibility walk, so it works while a transcript streams. A snapshot run paints the web diff on
  top of every overlay, so an overlay that looks covered in a snapshot can be fine on screen: check it live.
  One hub runs at a time: a second `GenesisTools --hub …` hands its flags to the running hub and exits
  (Hub/HubSingleInstance.swift: the hub holds a `flock` on `~/.genesis-tools/hub/hub.lock`, dropped by the kernel on exit).
- A rebuild never deletes the replaced bundle: it moves to `~/.genesis-tools/app/retired/<ms>/` and is pruned once
  no GenesisTools process older than it runs. Claude sessions run inside the launcher binary they started with, and
  tccd denies every grant to a process whose binary is gone. The launcher also exports `GENESIS_TOOLS_APP_INODE`;
  `tools` re-enters the current launcher when it differs (`genesisAppLauncher()`). A build that finds no signing
  identity while the installed app is Developer ID signed refuses to install ad-hoc (a sandboxed shell cannot read
  the keychain). Worktree builds install the same way and keep the grants.
- After a rebuild, restart a running hub without stealing focus: `pkill -f 'MacOS/GenesisTools --hub'` then
  `tools hub --no-activate`.
