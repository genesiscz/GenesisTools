# GenesisKit

The SwiftUI components GenesisTools.app and Genesis.app share. One copy, two consumers:

- GenesisTools.app: `.package(path: "../GenesisKit")`; `Sources/Hub/GenesisKitHost.swift` re-exports it
  (`@_exported import GenesisKit`) and implements `GenesisKitHost`.
- Genesis: `Genesis/lib/GenesisAIMonitorKit` depends on `../../../../GenesisTools/src/macos/GenesisKit` and
  re-exports it, so the Genesis app sees it through `import GenesisAIMonitorKit`. Genesis therefore builds only
  next to a GenesisTools checkout at `~/Tresors/Projects/GenesisTools`.

## What is here

| Need | Use |
|---|---|
| The cmux layout from `tools ai cmux tree --json` | `CmuxTree.decode(data)`, `CmuxTarget` |
| Pick where to open something in cmux (Tree / Layout) | `CmuxTargetPicker(tree:loading:selection:highlightSession:modeKey:modeStore:reload:onPick:)` |
| A session's cmux block (refs, Focus, Open in last pane, Choose a pane…) | `CmuxSessionPanel` |
| An icon-only button | `IconButton(systemName:tooltip:)` |
| A text action in a hairline outline | `GhostButton(_:symbol:tooltip:fullWidth:)` |
| A path | `PathLabel(path:line:title:)`, `PathActionsMenu`, `PathOpener` (folder in Finder by bundle id) |
| Copy a value | `CopyChip`, `Clipboard.copy(_:what:)` (shows `CopyToast`) |
| A pull-down menu | `MenuButton(items:label:)` or `MenuButton(style:items:label:)` |
| An agent's initial | `ProviderBadge(provider:size:)` |
| A tag, a status, a count | `Badge(_:color:look:)` (`.tag`, `.tone`, `.filled`), `CountBadge` |
| Nothing to show | `EmptyState(symbol:text:)` |
| A warning or note that stays | `InfoStrip(_:tone:action:dismiss:)`; a passing confirmation is `NoticePill` |
| A relative time | `LiveAgo(date:style:)`, `LiveTime(date:style:)` |

Also here: `.instantTooltip` (with `TooltipGuard`), the `.genHover*` button styles and `.genHoverEffect`, `.rowButton` /
`RowButtonStyle`, `.kicker`, and `KitPalette` / `KitTheme`.

## The visibility rule

A type an app declares shadows the package's public type of the same name, so an app copy and the package copy
can live side by side while a move is in progress. An extension member (`.instantTooltip`, `.genHoverPlain()`,
`.rowButton`) declared in both is "ambiguous use" in every file of the app. So never add an app copy of a modifier or
button style that lives here. (Until 2026-09-30 these stayed `internal` while both apps still had copies.)

## App hooks

`GenesisKitHost` (log line, open a terminal in a folder, render text a panel find can mark). The kit finds the
app's host by the Objective-C class name `GenesisKitHostAdapter`; `GenesisKit.install(_:)` sets one by hand.

## Check

`swift test` here, then build both apps (`bun run app` in GenesisTools, `bun scripts/install.ts --debug` in
`Genesis/apps/Genesis`).
