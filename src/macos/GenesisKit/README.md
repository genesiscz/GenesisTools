# GenesisKit

The Swift code GenesisTools.app and Genesis.app share: the session screen, the `tools` clients under it, perf
logging, the title bar zone and the small controls. One copy, two consumers:

- GenesisTools.app: `.package(path: "../GenesisKit")`; `Sources/Hub/GenesisKitHost.swift` re-exports it
  (`@_exported import GenesisKit`) and implements `GenesisKitHost`.
- Genesis: the app target and `Genesis/lib/GenesisAIMonitorKit` depend on
  `../../../../GenesisTools/src/macos/GenesisKit`; the kit re-exports it. Genesis therefore builds only next to a
  GenesisTools checkout at `~/Tresors/Projects/GenesisTools`. The app lists it directly as well: through the
  re-export alone, a changed initializer here left a stale caller in the app and the link failed.

## Layout

One target, folders by job. A file goes where its job is, not where its first caller was.

| Folder | What |
|---|---|
| `Style/` | hover styles (`.genHover*`, `.genHoverEffect`), `.instantTooltip` + `TooltipGuard`, `.rowButton` / `RowButtonStyle`, `KitPalette` / `KitTheme`, `GenesisKitHost`, `SWR` (stale-while-revalidate: `changed`, `fade`, `rowTransition`, `animation`) + `.swrFlash` |
| `Controls/` | `IconButton`, `GhostButton`, `MenuButton`, `CopyChip`, `NoticePill`, `NewItemsPill` ("3 new ↓" over a live list while the reader is scrolled up) and `RowArrival` (a new row fades in and rises 8 pt, fade only under Reduce Motion), `InfoStrip`, `EmptyState`, `Badge` / `CountBadge`, `ProviderBadge`, `.kicker`, `RefreshingMark` (the spinner over last known data) |
| `Paths/` | `PathOpener` (folder in Finder by bundle id, file in Cursor at a line), `PathLabel`, `PathActionsMenu`, `Clipboard` + `CopyToast` |
| `Time/` | `LiveTime`, `LiveAgo`, `LiveTimeFormat` |
| `Cmux/` | `CmuxTree`, `CmuxTarget`, `CmuxTargetPicker` (Tree / Layout), `CmuxSessionPanel` |
| `Window/` | `WindowTitlebar`: `.titlebarZone()`, `.titlebarBackground`, `.titlebarRow()`, the snapshot audit; `HostWindow` + `HostWindowReader` (the window a view is in, without SwiftUI state) |
| `Perf/` | `PerfLog`, `HangWatch`, `MainStackSampler`, `MonitorPerf`, `RenderProbe`, `PerfConfiguration`, `MainBusy` (main-thread busy time after an event, `measureUntilSettled`, and a `Meter` for benches), `SessionOpenBench` (times one open of a session screen for the bench tests of both apps) |
| `Tools/` | `ToolsBridge` (runs `tools`), `ToolsLineStream` (one long-running `tools` child, stdout as whole lines on the main queue, stdin held open so the child ends with the app), `MonitorJSON`, `TitleFormatter`, `SessionTranscriptClient` (the `tools ai sessions tail` envelope), `TranscriptPromptPart`, `DiskCache` (last answers on disk; `load` / `loadData` read off the main thread), `DirectoryWatcher` (one FSEvents stream over several folders, a path filter, main-queue callback) |
| `Providers/` | `AIProviderMeta`, `AIProviders`, `AIProviderGlyph` |
| `Sessions/` | `SessionPalette`, `SessionFormat` |
| `Sessions/Transcript/` | `SessionTranscriptList`, `TranscriptDocument`, prompt parts, `TranscriptScrollAnchor`, `TranscriptBus` / `TranscriptFilters`, `TranscriptMarkdownStyle`, `TranscriptLiveTail` (one `tools ai sessions tail --live` child, or a server subscription, per open screen) |
| `Sessions/ToolCalls/` | `SessionToolCallView` + `TranscriptServices`, `SessionNativeLog` + `SessionNativeLogStore`, `SessionToolChanges`, `BatchedToolChangeSource` + `ToolChangeBatcher` (rows that ask within 100 ms share one `tools agents changes` run) |
| `Sessions/Code/` | `CodeBlock`, `CodeBlockText`, `SessionSyntaxHighlighter` |
| `Sessions/Detail/` | `SessionDetailScreen`, its header and sidebar, `SessionSidebarSplit`, `TranscriptPaging` (first page 12, pages of 150, refresh to the end), `TranscriptBuildQueue` (one document build at a time, newest pending wins) |

## API rules

- Views take values and closures, never an app's model. What an app does differently is a hook or an option,
  never a second copy and never an `#if`:
  - `GenesisKitHost` (one class per app, `@objc(GenesisKitHostAdapter)`, found by name): the log line, the perf
    configuration, the transcript's markdown renderer, text a panel find can mark, opening a terminal.
  - `TranscriptServices` (per loaded session): the session file, the change log, "Open diff", a detail loader,
    row actions, notice buttons, the search query.
  - `SessionDetailActions` (per screen): refresh, copy, Finder, Cursor, focus, wake, the alert and hub actions.
  - `TranscriptBus` / `TranscriptFilters`: a host that wants to reveal a row or filter to one tool posts there.
  - Options on the view: `followsLatest` (a live chat), `emptyMessage`, `sidebarExtraFirst`, `showsSidebar`.
- A public struct a host builds gets an explicit `public init` (the synthesized one is internal).
- Keep a component small and composed: a row, a strip, a panel. A new need is a parameter or a new component here,
  not a local copy in an app.

## The visibility rule

A type an app declares shadows the package's public type of the same name. An extension member (`.instantTooltip`,
`.genHoverPlain()`, `.rowButton`) declared in both is "ambiguous use" in every file of the app, and breaks the
build. So never add an app copy of anything that lives here.

## Tests

`swift test` here covers the shared code, including `SessionTranscriptScrollTests` (the transcript's scroll,
streaming and resize cost; `SESSION_SCROLL_PERF=1` for the timing runs) and `WindowTitlebarTests`, which open
windows at alpha 0, below the desktop, never activated. Then build both apps (`bun run app` in GenesisTools,
`bun scripts/install.ts --debug` in `Genesis/apps/Genesis`) and run their suites: GenesisTools `swift test`,
GenesisAIMonitorKit `swift test`, Genesis `bun run test:scope`.
