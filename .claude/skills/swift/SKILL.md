---
name: swift
description: Swift, SwiftUI and AppKit work on GenesisTools.app (hub, review window, link relay, widget preview) and the shared GenesisKit package — above all performance work. Use it whenever you edit or debug anything under src/macos/ (GenesisTools, GenesisKit, GenesisWidgetPreview, GenesisClickyPreview), chase a hang, stall, "not responding", high CPU, frame drops, a slow click or a layout loop in the app, add a SwiftUI animation, a WKWebView, a List or a custom Layout, or need to measure, bench, sample or A/B a Swift change — even when the user only says "the hub is slow", "it jumps", "it uses 40% CPU" or "click around the hub".
---

# Swift work on GenesisTools.app and GenesisKit

The app is SwiftUI on AppKit, with WKWebView panes and a `tools` CLI (Bun) behind most data. Most of
its performance bugs are not slow algorithms. They are work the frameworks do on the main thread
because of how a view was written: an animation that lays out the window on every frame, a list that
builds every row, a web view created on a click, an accessibility client that multiplies every update.
So the loop is always the same: **see it in a measurement, find the frame that owns it, change the
shape of the code, measure again with the same harness.**

Rules that are already in `src/macos/GenesisTools/CLAUDE.md` (read it before an edit there) are not
repeated here; this skill holds the techniques, the evidence behind them and the traps.

## The loop

1. **Arm the monitor first.** Run `tools hub dev monitor --min-delay-ms 30000` under the Monitor tool
   (timeout 30 min, re-arm on expiry). It reports app hangs, stalls, layout loops, frame drops,
   crashes, and every CLI profiling timer of 1 s or more with the process that ran it. Details:
   [references/measuring.md](references/measuring.md).
2. **Attribute before you fix.** A `stall`/`hang` event names a stack file; read its app frames
   (`rg "^\s+[0-9.]+%\s+\[GenesisTools"`). A CPU complaint: measure per process tree over 30-120 s
   (`tree-cpu`), then `sample <pid> 10` and rank the main thread's frames. Know which process it is
   before you touch code: another session's preview app looks like "GenesisTools" in Activity Monitor.
3. **Reproduce off screen.** `GenesisTools --hub --bench` drives the hub's own views (opens, resizes,
   folds, mode switches) with `GENESIS_HUB_BENCH_AX=1` so the cost matches the live hub. For a single
   view technique, build a 40-line A/B harness (old vs new view in a tiny non-activating panel,
   15 s each, interleaved, two runs each) and compare process CPU time.
4. **Fix the shape, not the symptom.** The catalogue of fixes with numbers is in
   [references/performance.md](references/performance.md); the traps that cost hours are in
   [references/gotchas.md](references/gotchas.md).
5. **Prove it the same way you found it**: same bench, same harness, before/after numbers, plus a
   screenshot that the thing still looks and behaves the same. Never trade output quality for speed.
6. **Build, install, re-verify**: `bun run app` (it installs, signs and reaps stale faces), then the
   monitor again. Build traps: [references/build.md](references/build.md).
7. **Write down what you learnt here**: a new trick goes in `performance.md` with its numbers, a new
   trap in `gotchas.md` with its fix. This skill is meant to grow with every Swift fix.

## The ten things that mattered most (2026-10-08)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Idle app at 5-25% CPU | SwiftUI `.repeatForever` animation (spinner, pulsing dots, shimmer) lays out the window every frame | Core Animation layer animation: `SpinningArc`, `PulsingDots` (GenesisKit/Controls) |
| Click costs 10-20× more in the live hub | An accessibility client is attached; SwiftUI walks responders per changed AX node | Bench with `GENESIS_HUB_BENCH_AX=1`; keep dense rows value-typed, controls only on hover |
| 140 ms - 1.2 s on opening a session's changes | `WKWebView` creation starts a web content process on the main thread | `PierreWebDiffRenderer.make()` hands out a spare made in a quiet moment |
| 1.4 s stall when a PR's threads arrive | `withAnimation(.spring)` around the first payload builds an animated insertion for every row | Animate only small changes to a list already on screen |
| A tool row costs 2.5 s CPU per new transcript line | CLI recomputed the whole 200 MB session for one call | Scope the computation (`onlyTools`) and prove parity on real data |
| Layout pass sizes a whole subtree again | Custom `Layout` asks a fixed-width child `sizeThatFits(width: nil)` | Use the known width |
| Width read into state writes 30×/s | `onGeometryChange` → state → layout → new width | `measuredWidth(label:)` rounds to whole points and logs `layout.loop` |
| Code drawn over a sticky header while scrolling | Third-party z-index (pierre gutter 3 vs header 1) | Raise the header in injected CSS |
| Diff jumps while scrolling fast | WebKit has no scroll anchoring; virtualizer re-places files | Manual anchoring on the same line of the same file |
| Hub "frozen" for seconds | One `Process.waitUntilExit()`/sync spawn on main, or a hand-off waiting for an answer | Background queue store; fire-and-forget hand-off |

## Where things live

- App: `src/macos/GenesisTools/Sources/` (Hub/, Review/, App/), tests `swift test` there.
- Shared: `src/macos/GenesisKit/Sources/GenesisKit/` (Sessions/, Controls/, Perf/, Window/), tests `swift test` there. A generic component belongs here, never as an app-local copy.
- Perf plumbing: `HubPerf` (spans, `SLOW` at 100 ms), `HubMainBusy.measure(label)` (main busy over the next 600 ms), `PerfLog` → `~/.genesis-tools/logs/app-perf.log`, `HangWatch` → `~/.genesis-tools/logs/hangs/`, `LayoutLoopWatch`, `RenderProbe` (`GENESIS_RENDER_PROBE=1`).
- CLI side: `[profile:<scope>]` lines in `~/.genesis-tools/logs/<date>-profiling.log`, one `[profile:cli]` line per `tools` run.
