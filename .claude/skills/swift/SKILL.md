---
name: swift
description: Swift, SwiftUI and AppKit work on macOS apps, above all performance — and the data layer behind them. Use it whenever you edit or debug a SwiftUI/AppKit app (here GenesisTools.app, its hub, review window, widget preview and the shared GenesisKit package under src/macos/), chase a hang, stall, "not responding", high CPU, high memory, frame drops, a slow click or a layout loop, add a SwiftUI animation, a WKWebView, a List or a custom Layout, or need to measure, bench, sample or A/B a change — even when the user only says "the hub is slow", "it jumps", "it uses 40% CPU" or "click around the app". Also use it when the slow part is the CLI or server process that feeds the app data.
---

# Swift app performance

Most performance bugs in a SwiftUI/AppKit app are not slow algorithms. They are work the frameworks do
on the main thread because of how a view was written (an animation that lays the window out every
frame, a list that builds every row, a web view created on a click, an accessibility client that
multiplies every update), or work the data layer repeats because nothing remembered the last answer
(re-reading files that did not change, parsing a whole log for one new line, a process per call).

So the loop is always: **see it in a measurement, find the frame or the call that owns it, change the
shape of the code, measure again with the same instrument, and prove the output did not change.**

## The loop

1. **Watch continuously.** Stream hangs, stalls, layout loops, frame drops, crashes and slow CLI
   timers while you work, so a regression reaches you before the user sees a "not responding" banner.
2. **Rank before you fix.** Measure per process tree over 30-120 s (CPU-time deltas, not `%cpu`), rank
   the app's calls into its data layer by total time, and find which process it is before touching code:
   another app or a helper often carries the name the user sees in Activity Monitor.
3. **Attribute.** A stall: read the app frames of its stack. CPU: `sample <pid> 10` and rank the main
   thread's frames (inclusive counts contain children). A data call: `bun --cpu-prof`/a profiler on the
   call alone, not wall-time timers inside a busy process.
4. **Reproduce off screen.** A bench that drives the real views (opens, resizes, folds, mode switches)
   with an accessibility client attached, or a 40-line A/B harness for one view technique (old vs new in
   a tiny non-activating panel, interleaved runs, CPU time).
5. **Fix the shape.** Techniques with numbers: [references/performance.md](references/performance.md).
   Traps that cost hours: [references/gotchas.md](references/gotchas.md).
6. **Prove it.** Same instrument, before/after numbers, and **parity**: byte-identical output on real
   data (not only fixtures), screenshots that it still looks and moves the same. Never trade output
   quality for speed. Plant a regression to prove a new test catches it.
7. **Work in batches.** Take the baseline, make 10-20 minutes of changes, then build and install once,
   measure again, and report before/after with the commits.
8. **Write down what you learnt here**, generically: a technique in performance.md with its numbers, a
   trap in gotchas.md with its fix, codebase specifics in the project's reference file.

## The highest-yield fixes (measured)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Idle window at 5-25% CPU | SwiftUI `repeatForever` animation lays the window out every frame | Core Animation layer animation in an `NSViewRepresentable` |
| Click 2-18× slower in real use than in tests | An accessibility client is attached | Bench with one attached; value rows; controls only on hover |
| 140 ms - 1.2 s on opening a pane | `WKWebView` created on the click | A fresh spare made in a quiet moment |
| 1.4 s stall when a list arrives | `withAnimation` around a first load | Animate only small changes to a list on screen |
| Refresh re-reads unchanged files | No memory of the last answer | File-identity caches; resume append-only files |
| Seconds of CPU per new log line | Whole-file parse per change | Parse only appended lines; scope to what was asked |
| GBs of memory for a 200 MB file | `readFileSync` + split, side files all at once | Chunked line reader, lazy per file |
| Every call ~250 ms even when cached | A process per call (runtime startup) | Resident server door, byte-identical output |
| One slow call makes all calls slow | Serial server queue | Fix the slowest door first, re-rank |
| Width state writes 30×/s | Geometry → state → layout feedback | Whole points + a loop detector |

## Measuring

Instruments, what each answers and the traps in reading them: [references/measuring.md](references/measuring.md).
Build, install and verify: [references/build.md](references/build.md).

## This codebase

GenesisTools paths, tools (dev monitor, HubBench, server doors), what was done and what is open:
[references/genesistools.md](references/genesistools.md). Read it before working on src/macos/ or on the
CLI paths the app calls.
