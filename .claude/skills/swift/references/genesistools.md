# GenesisTools specifics

What the general references describe, as it exists in this repository. Paths are relative to the
GenesisTools checkout.

## Where things live

- App: `src/macos/GenesisTools/Sources/` (Hub/, Review/, App/); tests `swift test` there.
- Shared Swift: `src/macos/GenesisKit/Sources/GenesisKit/` (Sessions/, Controls/, Perf/, Window/); tests
  `swift test` there. A generic component belongs here, never as an app-local copy.
- Rules for the app: `.claude/rules/macos-app.md` (never block the main thread in a body, measure
  every load, accessibility clients, transcript scroll rules, title bars).
- The data comes from the `tools` CLI (TypeScript, Bun). Data handling and caching belong on the
  TypeScript side, because the CLI serves more than the app (Martin, 2026-10-08).

## Measuring here

- `tools hub dev monitor --min-delay-ms 30000` under the Monitor tool (re-arm every 30 min).
- `HubPerf` spans (`SLOW` at 100 ms), `HubMainBusy.measure(label)` (main busy over the next 600 ms;
  `@MainActor`, wrap in `MainActor.assumeIsolated` from a non-isolated method on the main queue),
  `LayoutLoopWatch` / `.measuredWidth(label, $width)`, `RenderProbe` (`GENESIS_RENDER_PROBE=1`).
- Logs: `~/.genesis-tools/logs/app-perf.log` (app, all processes mixed), `logs/hangs/` (hang samples and
  stack files), `logs/<date>-profiling.log` (CLI timers, `[profile:cli]` one line per command run).
- Rank today's app→CLI calls by total time from `mark call t=… via=… ms=… argv=…` lines.
- HubBench: `GENESIS_HUB_BENCH_ONLY=open GENESIS_HUB_BENCH_OPEN=<id>,<id> GENESIS_HUB_BENCH_AX=1
  ~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --hub --bench <out.json> --panes transcript,changes`.

## What was done (2026-10-08, PR #479)

| Area | Change | Commit |
| --- | --- | --- |
| Animation | `SpinningArc`, `PulsingDots` (GenesisKit/Controls) replace SwiftUI `repeatForever`; the skeleton shimmer is a `CAGradientLayer` sweep under a static SwiftUI mask | 0f46e229b (widget worktree), 9f4a93293, skeleton commit after 60ae52883 |
| PR threads | `PRThreadsStore.show` animates only ≤ 8 changed threads | 3ab270370 |
| Web view | `PierreWebDiffRenderer.make()` spare; review windows build their own | 89002f2a1 |
| Layout | `SessionSidebarSplit` places the 301 pt sidebar without measuring | 851ac995a |
| CLI | `computeSessionChanges({ onlyTools })` for `agents changes --tools` | f0a37bf9b |
| CLI | `scanAppendOnly`, `readAgent` cache (src/utils/ai/transcripts) | 2ebffa076 |
| Server | doors `hub repo`, `ai usage sessions --json`, transcript `--provider` (src/hub/server/doors) | 822bd69c8 |
| CLI | `readRecordsAppendOnly` for live Codex/Grok transcripts | 6f8c55f48 |
| CLI | `readLinesSync` (src/utils/fs/read-lines.ts) for transcripts and sub-agents | ad11cfd9c |
| CLI | `foldJsonlResumable` (src/utils/agent-sessions/jsonl-fold.ts): Codex metadata resumes across processes | 60ae52883 |
| Monitor | profiling events, `[profile:cli]` lines, pid → process names | 12cc7ce78, 4e6c946fc, 294937ac9 |
| Code blocks | `WrappedCodeTextView.converted`: an `NSCache` of the AppKit text by content key, so a transcript row scrolled back into view does not convert its code again | a8a4e1364 |
| Server | `[profile:hub-server] <door> exit= cpu= <wall>` per call; `callHubServer()` TS client; usage daemon asks the server for rows | f4c883ac3, 57e1d6e7a |
| CLI | Codex turn fold (`createCodexTurnParser`, `turn-fold-cache.ts`), session-changes fold (`session-changes/fold.ts`), Codex projection via covering indexes | 32616839a, fb68333ba, 6877db4e6 |

## Open (by measured cost)

- `ai usage` poll daemon (every minute, a fresh process): ~1.0-1.1 s CPU per tick after 57e1d6e7a (rows come
  from the hub server); its phases are timed under `ai-usage` since 1bc8dec38.
- `agents changes --tools … --store-blobs` from GenesisKit `BatchedToolChangeSource` runs as a process for every
  new tool row of the session on screen (~1.5 s CPU on a 223 MB session). Needs a server door, which would write
  blobs: DECISION 63.
- `hub pr threads` / `readiness` / `list` / `versions`: network-bound, run as processes.
- `ai-spend session --id … --json` (44 process runs/day, ~500 ms mostly startup): no door yet; goes
  through the generic `runReport`.

- The widget watcher (`hub widget watch`, another session's worktree): a full snapshot every 5 s (~15% CPU).

## Markdown viewer (GenesisKit `Markdown/`, 2026-10-13 17:22)

- Body probes (`RenderProbe.hit`) sit in the window, tab bar, tabs, document pane, toolbar, status bar, git sidebar,
  file tree and its rows, outline, path bar, repository panel and the web view's `updateNSView`
  (`md.*`, `git.*`, `tree.*`). They cost one Bool read while `GENESIS_RENDER_PROBE` is off.
- Tab-switch bench: a hosted `MarkdownDocumentsView` with real notes (read only), file tree and git sidebar on;
  per switch `RenderProbe.snapshot()`, `MainBusy.Meter`, `model.select(id)` plus `layoutSubtreeIfNeeded()` and
  `displayIfNeeded()` for the synchronous part, then `RenderProbe.summary(since:)`. Watch the models with
  `RenderProbe.watch`. Background windows miss focus and accessibility cost (see gotchas.md).
- Testing the viewer never touches the user's windows: hosted never-ordered-front windows, `cacheDisplay` plus
  `WKWebView.takeSnapshot`. Two apps run the viewer: GenesisTools (`--markdown`, relaunch with `open -g -n
  ~/Applications/GenesisTools.app --args --markdown <file> --no-focus` after `bun run app`) and Genesis Markdown.app
  (`GENESIS_KIT_PATH=<GenesisTools>/src/macos/GenesisKit bun scripts/install.ts` in GenesisPlayground; it relaunches
  the viewer only if it was open). ⚠️ It stops the viewer with `pkill` (SIGTERM, no save prompt), and Genesis.app
  with it: unsaved drafts in the viewer are lost. Ask before installing while the user has the viewer open.
- File tree bench (2026-10-14): `MARKDOWN_TREE_BENCH=<folder> [MARKDOWN_TREE_BENCH_NOTE=<note>]
  [MARKDOWN_TREE_BENCH_SECTIONS=<n>] [MARKDOWN_TREE_BENCH_MARK=<file>] swift test --filter MarkdownTreeLagBench`:
  24 tabs, the tree rooted at the folder, then unrelated publishes (the preview's section), tree scroll steps and tab
  selections, each with busy time, longest pass and the bodies that ran. `MARK` appears when the publish loop starts,
  so `sample <pid>` from the shell can attach to it.
- Open (2026-10-13): warm spare web view and keep-until-rendered tab swap; the documents model's redundant publishes
  on select; the repository panel's derived lists into a model. Still open 2026-10-14: every documents-model publish
  re-runs the window, pane, toolbar, status bar, path bar and tree bodies (about 11 ms per publish with 24 tabs).
