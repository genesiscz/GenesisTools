---
paths:
  - "src/macos/GenesisKit/Sources/GenesisKit/Markdown/**"
  - "src/macos/GenesisKit/Sources/GenesisKit/Diff/**"
  - "src/macos/GenesisKit/Tests/GenesisKitTests/Markdown/**"
  - "src/macos/GenesisKit/Tests/GenesisKitTests/Diff/**"
  - "src/macos/GenesisTools/Sources/Parts/Markdown/**"
---

# The GenesisKit markdown viewer and git components

Loaded by Claude Code when you read, write or edit the markdown viewer (`GenesisKit/Markdown/`), the git and diff
components (`GenesisKit/Diff/`) or GenesisTools' `--markdown` face. Written 2026-10-13 17:30 from the viewer's first
day of review (PRs #499, #501).

## Two hosts, two installs
- GenesisTools runs the viewer as its `--markdown` face; `bun run app` reaps it, so relaunch it in the background:
  `open -g -n ~/Applications/GenesisTools.app --args --markdown <file> --no-focus`.
- Genesis Markdown.app (GenesisPlayground) builds against this checkout's GenesisKit:
  `GENESIS_KIT_PATH=<GenesisTools>/src/macos/GenesisKit bun scripts/install.ts` in `GenesisPlayground/Genesis/apps/Genesis`.
  It starts the viewer after every install, in the background (`open -g`, with its saved tabs), open before or not. Its `swift build` needs `--disable-build-manifest-caching` too.
- The diff page (`src/macos/GenesisTools/web/diff-viewer`) is bundled by `buildDiffViewer` in
  `src/macos/lib/permissions/app.ts`; both installs call it.

## Testing without touching the user's windows
- Martin reads in these windows all day. Never click, raise or resize them to test; never switch their mode (the view
  mode is shared by every tab). Test in hosted, never-ordered-front windows. `cacheDisplay` does not capture a
  `WKWebView`; composite `WKWebView.takeSnapshot` at the web view's frame. In async `@MainActor` tests, wait with
  `await Task.sleep`, never by spinning `RunLoop.main` (WebKit's callbacks stop).
- A background window has no focus and no accessibility client, so it hides focus-walk and accessibility cost (a
  3,416-row list hung the real key window and cost 0.01 s in a hosted one). Verify list changes on the real app.
- Re-render counts: `RenderProbe.hit` sits in the main bodies (`md.*`, `git.*`, `tree.*`); `RenderProbe.watch(model,
  "name")` counts publishes. Set `RenderProbe.enabled` in a bench or `GENESIS_RENDER_PROBE=1` in the app.
- Real vault notes may be read in tests, never written; the vault is a git repository with thousands of untracked
  files, which is the stress case for every git list.
- A test window's page is `hidden`, so it gets no `requestAnimationFrame` (pierre lays a diff out in one). Map it to
  `setTimeout` with a document-start `WKUserScript` and reload, as `GitDiffViewLayoutTests` does, before you call a
  page test a reproduction.

## Facts the code depends on
- Page lines: `data-line` is a 0-based body line; body line = file line (0-based) − `MarkdownFrontmatter.bodyLineOffset`.
  Agent blame ranges are 1-based, inclusive, over the file on disk. Table rows carry lines (`tr_open` is lined).
- Renders converge: each carries a tag the page keeps, the host confirms it and sends again (a page can miss one).
  Every page problem goes through `MarkdownWebView.report` (host log, PerfLog, unified log subsystem `genesiskit`):
  `command log show --predicate 'subsystem == "genesiskit"'`.
- Links: a note name may hold dots (`1234.analysis` is `1234.analysis.md`); `MarkdownDocumentLinks.resolve` tries
  `.md` whenever the literal path is no file. A dead click logs `markdown: link <x> resolves to nothing`.
- Git runs through `GenesisKitGT.provider` (`GenesisKitGTCLIProvider`, or the host's: GenesisTools hands
  `HubGTProvider`). Status reads use `git --no-optional-locks status ...` (the option goes BEFORE the subcommand), so a
  read never rewrites the index and wakes the folder watcher. Compare git's real paths (`/private/tmp`) with one
  real-path function on both sides.
- `GitRepos.shared` runs one status per repository; no timer, refresh on git-folder events or `noteSaved`.
  `lookup(for:)` is tri-state: show "not in a git repository" only for `.none`, never while `.pending`.
- A tab switch takes a warm spare page (`MarkdownWebSpare`) and keeps the old tab on screen until the new page's
  render call returns (`GenRenderSwap`, shared with the hub's session switch). The leaving pane owns no sheet, find
  panel or web proxy (`leaving`).
- The window's frame autosave name is set on the controller (`windowFrameAutosaveName`) after `super.init`; set on
  the window before, `NSWindowController.init(window:)` drops it.

## Martin's UX calls for this viewer (2026-10-13)
- Lists of changes fold untracked files by folder and build only the rows on screen (an AppKit table; no pages and
  no "Show more" since 2026-10-25); counts are meaningful.
- Diffs: left strips for whole added or removed blocks, word marks inside changed lines, no row backgrounds; `+`
  green, `−` red. Commit choosers are popovers with details, built when opened. Tabs: `GenSegmentedTabs`, animated.
- A pane never goes blank between two contents: the old one stays until the new one has rendered.
- A pending lookup never shows its negative answer ("not in a git repository").
