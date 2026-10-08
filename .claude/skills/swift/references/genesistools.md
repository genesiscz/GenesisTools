# GenesisTools specifics

What the general references describe, as it exists in this repository. Paths are relative to the
GenesisTools checkout.

## Where things live

- App: `src/macos/GenesisTools/Sources/` (Hub/, Review/, App/); tests `swift test` there.
- Shared Swift: `src/macos/GenesisKit/Sources/GenesisKit/` (Sessions/, Controls/, Perf/, Window/); tests
  `swift test` there. A generic component belongs here, never as an app-local copy.
- Rules for the app: `src/macos/GenesisTools/CLAUDE.md` (never block the main thread in a body, measure
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
