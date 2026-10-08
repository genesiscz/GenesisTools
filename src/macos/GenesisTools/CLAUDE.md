# GenesisTools.app (Swift) — rules for every window

Loaded automatically when you work under `src/macos/GenesisTools/`. The root CLAUDE.md rule still
applies: after ANY edit to `Sources/**`, `web/**` or `Info.plist`, run `bun run app` (build, sign,
install, reap stale faces). Swift UI you have not seen rendered is not done.

## Use the shared components (GenesisKit + Sources/Hub/HubComponents.swift), never hand-roll these

The components both apps use live in **`../GenesisKit`** (`src/macos/GenesisKit`), a SwiftPM package Genesis.app
depends on too; its README lists them. That is `IconButton`, `.instantTooltip`, the `.genHover*` button styles,
`.rowButton` / `RowButtonStyle`, `PathLabel`, `PathActionsMenu`, `PathOpener`, `Clipboard` / `CopyToast`, `CopyChip`,
`NoticePill`, `LiveAgo` / `LiveTime`, `MenuButton`, `ProviderBadge`, `Badge` / `CountBadge`, `GhostButton`,
`EmptyState`, `InfoStrip`, `.kicker` and the cmux picker (`CmuxTree`, `CmuxTargetPicker`, `CmuxSessionPanel`).
Change them there, never in a copy here: a second copy of a modifier or button style (`.instantTooltip`,
`.genHoverPlain()`) makes every call to it ambiguous. `Hub/GenesisKitHost.swift` re-exports the package and gives it
this app's log, cmux and panel find. Hub-only pieces (`ExternalLink`, `TitlebarHeader`, `GroupHeader`, …) stay in
Hub/HubComponents.swift.

| Need | Use | Never |
|---|---|---|
| An icon-only button | `IconButton(systemName:tooltip:action:)` | a bare `Button { Image(...) }` without a tooltip |
| Any other control that is not self-explanatory | `.instantTooltip("…")` (GenesisKit) | `.help(...)` alone: it shows after a long delay and is easy to miss |
| A link to a web page (repo, branch, PR, commit) | `ExternalLink(text:url:)` (opens in Brave, shows the ↗ glyph) | plain text that happens to be a URL |
| Repo / branch web URLs, the branch's PR/MR | `RepoFactsStore.shared.facts(for: path, pr:)` (fed by `tools hub repo --json`) + `PullRequestLink` | parsing `git remote` in Swift, or any `Process` in a view body |
| A file or folder path | `PathLabel(path:line:title:)`: a click opens by kind (`PathOpener.primary`: folder in Finder, file in Cursor at `line`), right-click lists Finder, reveal, Cursor, cmux, copy (`PathActionsMenu`), plus copy / reveal / Cursor icons | a bare `Text(path)`, `NSWorkspace.open` on a folder (LaunchServices handed folders to QuickTime), `activateFileViewerSelecting` by hand |
| Open a file at a line | `PathOpener.cursor(path, line:)` | `open -a` without the line |
| A side panel | `ResizableSidePanel(key:edge:title:minWidth:maxWidth:autoCollapse:fitWidth:)` (Hub/HubPanels.swift: grip on hover, release below the minimum collapses to a rail, width saved on release only; during a drag the layout keeps the start width and the panel draws over its neighbour, one reflow on release, unless `holdsLayout: false`: then the neighbour moves with the edge on each step (no gap) and wraps its content in `.freezesWidthWhileDragging(panel: key)`, so it reflows once on release (the hub sidebar outside Sessions mode; beside the PR overview panel the columns hold with `.freezesWidthWhileResizing()`); the parent passes the room it has as `maxWidth` and `autoCollapse` when there is none, which shows the rail and opens the panel as a drawer; `fitWidth` opens it at its content's width, as the Files list does with `FileListFit`, until the reader drags it in that window) | a fixed `.frame(width:)` sidebar, a width written to `@AppStorage` on every drag step, or moving the neighbouring panes per step (each move of a focusable list makes SwiftUI rebuild the key view loop over every transcript row: 82 ms/step) |
| A heavy pane (transcript, diff) | `.freezesWidthWhileResizing()`: keeps its size while `HubLiveResize` is active (panel drag, window live resize, pane divider) and reflows once at the end. `heavy: false` for a pane that should follow a pane-divider drag live (everything but the transcript list; frozen, it left a dark gap beside the divider) | letting a `List` re-measure every row per resize step (395 ms/step measured), or ending a divider drag on a local mouse-up monitor (NSSplitView's tracking loop swallows it; `HubLiveResize` polls the button instead) |
| A pull-down menu in a header or toolbar | `MenuButton(items:label:)` (GenesisKit): a drawn label, the NSMenu is built at the click | a SwiftUI `Menu` (an NSPopUpButton) or any other AppKit control inside a `ViewThatFits`: it builds each option's platform views again for every measurement, a dozen pop-up buttons per step of a divider drag in the review header (bench `split` busy p50 46.7 → 23.5 ms, 2026-09-26) |
| A list row that acts as a button | `.rowButton(cornerRadius:)` → `RowButtonStyle` (GenesisKit): soft fill in the row's own frame; keep gaps and insets OUTSIDE the button so hover box = selection box | `genHoverRow(accent: .white)` (45 % white outline) or padding inside the button |
| A background | `.hubSurface(.chrome / .content / .bar)`: opaque normally, translucent in glass mode (`HubGlass`, ⌘⇧G) | `ReviewPalette.sidebar` / `.background` directly |
| A sidebar group header | `GroupHeader` + `GroupPrefs` (collapse, pin, move up/down, persisted) | an uppercase static label |
| A status message | `NoticePill` (fades, error stays) | a raw colored `Text` line |
| A relative time on screen ("5 min. ago", "active 20s ago") | `LiveAgo(date:)` or `LiveTime(date:style:)` (GenesisKit): the label keeps its own clock, nothing above it re-renders per tick | `HubFormat.ago` in a body (formats once and goes stale), or a `Timer` / `TimelineView` above the label (re-renders the whole row or list per tick) |
| Find inside a panel (⌘F) | Hub/HubPanelFind.swift: `@State` `PanelFindModel`, `PanelFindBar` under the header as its own row above the scroll view, `.panelFind(find, revision:rows:)` on the root, `.findRow(id)` per row, `FindText(text, field:)` for shown text (`MarkdownContentView` + `.findField(key)` for markdown). A pane with its own find registers with `.panelFindNative(scope)`, an overlay that owns the keyboard with `.panelFindModal()` | a bar in `.safeAreaInset(edge: .top)` (selectable text draws through it), a SwiftUI `.keyboardShortcut("f")` button or a local key monitor per view: `PanelFindRouter` is the one ⌘F / ⌘G / ⇧⌘G / Esc owner and sends the key to the panel of the last click |
| A main view's header (every hub mode, and any new one) | `TitlebarHeader { row } details: { rows }` (Hub/HubComponents.swift): the first row goes into the title bar row, the rest under it, then the hairline; plain title text in the row gets `.titlebarLabel()` so a double-click on it zooms | a header with `.padding(.top, 34)` under the title bar: every hub mode had one, an empty band the `--snapshot` audit now names ("an empty band N pt tall under the title bar") |
| A window whose content runs under the title bar (`.fullSizeContentView`, transparent title bar) | `.titlebarZone()` on the window's root view, `.titlebarBackground(fill)` for any fill that paints the strip (`.hubSurface` already does), `.titlebarRow()` for a row of controls placed in the strip (GenesisKit Window/WindowTitlebar.swift) | a view, or a `.background(… .ignoresSafeArea(edges: .top))`, over the title bar without them: the double-click never reaches the window, so it does not zoom |
| A PR/MR's review threads or any write to them | `ReviewModel.attachPR` → `PRThreadsStore` + `PRCommand` argv (Review/PRThreads.swift, fed by `tools hub pr`). The diff's thread cards carry Reply / Resolve / Edit / Delete (web/diff-viewer/main.ts, `renderLiveThread`): the page only posts `thread.action`, and Swift confirms, runs `tools`, then answers `threadDone`. The PR bar and threads list are in Review/PRThreadsPanel.swift. 🛑 `PRCommand.publish` has one caller, the Submit review confirmation (a test scans Sources for it) | `tools github …` / `tools gitlab …` calls from a view, or a second path to `publish` |

**Every button has a hover effect.** Icon buttons: `IconButton` (uses `.genHoverIcon()`); text-like buttons and
links: `.buttonStyle(.genHoverPlain())`; list rows and menu rows: `.buttonStyle(.genHoverRow())` (all from
GenesisKit). Never `.buttonStyle(.borderless)` on something clickable.

**Every button that shows only an icon has a tooltip.** Check before you finish: `rg -n 'Image\(systemName' Sources | rg -v 'IconButton|instantTooltip'` and look at each hit.

## 🛑 Every title bar zooms on a double-click and drags on empty chrome

Martin, 2026-09-28: "the top of the window is not clickable to fill in the whole display.. this keeps reoccuring in
all swift stuff you do". In a `.fullSizeContentView` window the SwiftUI hosting view covers the title bar, so every
click there lands in SwiftUI (hit test: `NSHostingView`, never `NSTitlebarView`) and AppKit never zooms the window.
The window server still drags it from anywhere in the strip, a control placed there included. So every window with
a title bar gets, through GenesisKit Window/WindowTitlebar.swift:

- `.titlebarZone()` on its root view: the empty strip does what System Settings says on a double-click
  (`AppleActionOnDoubleClick`: zoom, minimize or nothing) and drags the window; controls keep their clicks and drags.
- `.titlebarBackground(fill)` for every fill that reaches up into the strip. A plain hit-testable fill there takes
  the strip's clicks before the zone sees them.
- `.titlebarRow()` for controls moved up into the strip: the strip's height, clear of the traffic lights and title.

Never put a view over the title bar without these. A window with a standard (not full-size) title bar needs nothing.
🛑 No `.instantTooltip`, `.help`, `.onHover`, gesture or context menu on a NON-control in the strip: it takes the
pointer, and a flexible-width one (a path `Text` with `.lineLimit(1)`) kills the double-click along the whole row (Genesis
Markdown, 2026-10-01). Full rules and the check: `.claude/docs/swift-headers.md` (local-only here, tracked in GenesisPlayground).
Check it: the `--hub` and `--review` snapshots print `titlebar …; ok` or the problem (`WindowTitlebar.audit`), and
`swift test --filter WindowTitlebarTests` covers the behaviour.

## 🛑 Never block the main thread inside a view body

`Process.waitUntilExit()` spins the main run loop. Inside a SwiftUI `body` that lets AppKit lay out
the view that is still being computed: AttributeGraph prints `cycle detected` and SwiftUI's
StackLayout array is freed twice (EXC_BAD_ACCESS in `StackLayout.Child`, hub crash 2026-09-24).
A body only reads cached state; anything that spawns, reads git, or hits the disk more than a
stat goes through a store that loads on a background queue (see `RepoFactsStore`). Data that the
`tools` CLI can compute comes from `tools`, not from Swift reimplementations.
To find a cycle: `AG_TRAP_CYCLES=1 GenesisTools --hub … --snapshot /tmp/x.png`, then read the
newest `~/Library/Logs/DiagnosticReports/GenesisTools-*.ips` stack.

## 🛑 Run `tools hub dev monitor` under the Monitor tool while you work on the app

Martin, 2026-10-08: hangs and crashes reached him as a "GenesisTools is not responding" banner and an
"unexpectedly quit" dialog while the agent changing the app saw nothing. Before the first edit of a
session on this app, start the stream under the Monitor tool (not as a Bash call that waits):

```bash
tools hub dev monitor            # one line per event, from now on
tools hub dev monitor --json     # the same as JSON objects
tools hub dev monitor --from-start --min-stall-ms 1000   # replay today's log first
```

It follows `~/.genesis-tools/logs/app-perf.log` (wedges, hang samples and their stacks, stalls of
500 ms or more, `layout.loop`, main-thread spans of 400 ms or more, heavy frame drops, failures),
`~/.genesis-tools/app/link-relay.log` (only lines that say the relay is not doing its job), new hang
files with no log line, and new `Genesis*` crash reports in `~/Library/Logs/DiagnosticReports`
(GenesisTools, Genesis, Genesis Markdown, GenesisTools Preview). Each line names the file to read
(the hang sample, the stack file, the `.ips`). An event during your own test is your bug until
the stack says otherwise; read the file before you change anything else. Source:
src/hub/lib/dev-monitor.ts.

## Measure every load

Every load that can be slow runs in a span: `HubPerf.begin("area.what", detail)` then
`span.end()`, or `HubPerf.measure(...)`. Spans, stalls and hang samples go to
`~/.genesis-tools/logs/app-perf.log` (stolen `PerfLog`; `.main` suffix = ran on the main
thread; `SLOW` marks at 100 ms). `HangWatch` samples the main thread into
`~/.genesis-tools/logs/hangs/` after 1 s. Summary: `bun scripts/perf-report.ts --tail 5000` (run in
this folder). Watch it while you click: `tail -f ~/.genesis-tools/logs/app-perf.log | rg 'SLOW|stall|main '`.
A span times work, not the SwiftUI layout it causes: after a state change the renderer runs in the
next run-loop passes. `HubMainBusy.measure("area.what")` (HubPerf.swift) logs the main thread's busy
time over the next 600 ms, which is what an append or a reload really costs on screen.

🛑 The live hub always has an accessibility client, and then SwiftUI walks every responder of the
window once per accessibility node an update touches: a click's cost grows with rows × controls per
row × rows (stall stacks: `AccessibilityNode.updateFocusResponder`). Rows of a dense list take values,
not the hub's models (`TimelineRowView`), and carry buttons, hover sensors and tooltips only while the
pointer is on them (its `live`, `ExternalLink(interactive:)`). A list that inserts rows above the
viewport holds it with `TranscriptScrollAnchor` (GenesisKit Sessions/Transcript/TranscriptScrollAnchor.swift).

🛑 Moving a SwiftUI `List`'s viewport inside the resize of a row insert (a frame-change observer that
scrolls at once, as `TranscriptScrollAnchor` does to stay still) stops AppKit re-measuring the rows on
screen: their height listener is gone and `noteHeightOfRows` returns the cached height. A row that grows
later (an opened tool call) keeps its old height and draws over the rows below; with the live tail every
row of a running session did it (2026-09-28). An insert without that move is fine (measured). Such a list
needs `TranscriptScrollAnchor.remeasureVisibleRows` after each such move, and that re-measure is expensive
(about 230 ms per call, 2026-09-30). So move inside the resize only when the rows on screen would jump
otherwise (a prepend under a hold); follow appends at the latest turn one turn later (`scheduleFollow`).

🛑 A live transcript moves the reader ONLY while they are at the end (`TranscriptScrollAnchor.atEnd`), with one
0.2 s ease-out glide per change (instant under Reduce Motion); scrolled up, it never moves them and shows
`NewItemsPill` ("N new ↓") instead. New rows fade in with `RowArrival`. No second `scrollTo` after an append: the
three-pass scroll that used to follow each new row moved the viewport twice more and read as a jump (2026-10-01).

## Look

- Palette: `ReviewPalette` (Review/ReviewWindow.swift) for hub and review; `SessionPalette` (GenesisKit) inside the session screen. Dark only, near-black background, white-alpha hairlines, green/red/orange/blue status colours.
- Group and project names keep their own case. No uppercase section titles except tiny kickers ("AGENT ANALYSIS").
- Dense rows (24–28 pt), monospaced numbers with `Text(verbatim:)` (locale grouping turned "+7711" into "+7 711").

## Shared with Genesis: GenesisKit, and the three copies left in Hub/Stolen/

The session screen and everything under it lives once in `../GenesisKit` (Sessions/: transcript list and
document, tool calls, code blocks, detail screen and sidebar, prompt parts, scroll anchor; Tools/: ToolsBridge,
TitleFormatter, SessionTranscriptClient, MonitorJSON; Perf/: PerfLog, HangWatch, MainStackSampler, RenderProbe;
Window/: WindowTitlebar). Change them there; its README has the layout and the API rules. What differs between
the apps is a host hook, never a marked copy: `GenesisKitHost` (Hub/GenesisKitHost.swift: perf file, markdown
renderer, panel find, cmux), `TranscriptServices`, `TranscriptBus` / `TranscriptFilters` (the sidebar's reveal
and tool filter), and options such as `sidebarExtraFirst`. The provenance headers and `/steal-code --reconcile` do
not apply to any of it.

Hub/Stolen/ still holds `MonitorSnapshot` (excerpt), `SessionListClient` and `SessionStatusFormat`: they need the
monitor kit's session-row types, which move to GenesisKit once that file's pending edits in GenesisPlayground are
committed. Keep them verbatim until then; `Hub/StolenShims.swift` stands in for the scored-usage type.

## Verify without a screen

- `GenesisTools --review --repo <path> [--scope branch] [--proposal <file>] --snapshot /tmp/x.png`
- `GenesisTools --hub [--mode worktrees|prs] [--session <id>] [--pr <n>] [--tab …] [--panes transcript,changes,files] [--file <path>] [--style unified] [--glass on] [--width <pt>] --snapshot /tmp/x.png`
  (`--file` renders that one file of the diff; a file only scrolled into view never paints in the invisible snapshot window)
- Resize performance: `GenesisTools --hub --session <id> --panes transcript,changes --bench /tmp/b.json`
  (sidebar drag, file-list drag, window and pane-divider sweeps with jitter; main-thread busy ms per step from run-loop
  observers, plus layout-flip probes; `GENESIS_HUB_BENCH_ONLY=sidebar` for one sweep, e.g. under `sample`). Scripted
  runs use a scratch copy of the hub's settings (`HubDefaults`), never the live layout. `--mode timeline` adds
  `activity` (the Activity rail's filters clicked) and `inbox` (the mode switch). 🛑 Measure clicks with
  `GENESIS_HUB_BENCH_AX=1`: the live hub always has an accessibility client (dictation, `tools control`), and with
  one SwiftUI walks every responder per changed accessibility node; a click that costs 90 ms without it costs 1.6 s.
- Logic tests: `swift test` in this folder (Tests/), and in `../GenesisKit` for the shared code (its SessionTranscriptScrollTests
  and WindowTitlebarTests open windows the same way). Here only LiveTimeTests
  open a window, alpha 0 below the desktop and never activated; `SESSION_SCROLL_PERF=1` adds the transcript's scroll and idle cost lines.
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
- The open transcript follows its session with ONE long-running `tools ai sessions tail <id> --live --offset <n>`
  per open detail (GenesisKit `TranscriptLiveTail` on `ToolsLineStream`, shared with Genesis): each stdout line is a turn with its
  `index` (a changed turn comes again and replaces its row) or a totals line. It stops when the detail closes, the
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
- A rebuild never deletes the replaced bundle: it moves to `~/.genesis-tools/app/retired/<ms>/` and is pruned once
  no GenesisTools process older than it runs. Claude sessions run inside the launcher binary they started with, and
  tccd denies every grant to a process whose binary is gone. The launcher also exports `GENESIS_TOOLS_APP_INODE`;
  `tools` re-enters the current launcher when it differs (`genesisAppLauncher()`). A build that finds no signing
  identity while the installed app is Developer ID signed refuses to install ad-hoc (a sandboxed shell cannot read
  the keychain). Worktree builds install the same way and keep the grants.
- After a rebuild, restart a running hub without stealing focus, by its pid only (a `pkill -f` pattern also
  killed other agents' snapshot runs, 2026-09-24): `kill <pid of MacOS/GenesisTools --hub>` if the build did not
  reap it, then `tools hub open --no-activate` with the flags it had.
