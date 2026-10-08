# Performance techniques, with the numbers behind them

Each entry: the symptom, why it happens, the fix, and the measurement that proved it. Add new ones at
the end of their section with a date and a commit.

## Animation

### Continuous animations run in the render server, never in SwiftUI
- **Symptom:** an idle window costs CPU; `sample` shows `NSDisplayCycleFlush` → `layoutIfNeeded` and
  `CA::Transaction::commit` many times a second with almost no app frames.
- **Why:** `.animation(.linear.repeatForever)`, `withAnimation(...repeatForever)`, `phaseAnimator` and
  `TimelineView(.animation)` are evaluated by SwiftUI in the app: every display frame re-runs the
  animatable attributes and lays the hosting view out. One 9 pt spinner kept a whole window busy.
- **Fix:** an `NSViewRepresentable` with a layer and a `CABasicAnimation` (`repeatCount = .infinity`,
  `isRemovedOnCompletion = false`); restart it in `viewDidMoveToWindow` (a layer drops animations when
  its view leaves a window); stop it with a `spinning`/`animated` flag. GenesisKit has `SpinningArc`
  (open arc, clockwise) and `PulsingDots` (staggered scale + opacity group).
- **Numbers:** A/B harness, 15 s: SwiftUI ring 0.73/0.71 s CPU → 0.00/0.00 s; SwiftUI dots 0.74/0.62 s
  → 0.00/0.00 s. Widget preview app 24.3% → 2.1% (commits 0f46e229b, 9f4a93293, 2026-10-08).
- **Still to convert:** `Skeleton.swift` shimmer (`withAnimation(.linear(duration: 1.4).repeatForever)`).

### Do not animate a first load or a bulk change
- `withAnimation(.spring)` around assigning a whole list builds an animated insertion (transition +
  layout) for every row at once. PR threads: 1.4 s main-thread stall per PR open. Animate only a
  handful of changed rows in a list already on screen (`PRThreadsStore.show`, limit 8, 3ab270370).

## Views and layout

### A custom `Layout` must not measure what it already knows
- `subview.sizeThatFits(ProposedViewSize(width: nil, …))` sizes the whole subtree at its ideal width,
  then `place` with another proposal sizes it again. For a fixed-width sidebar use the constant
  (`SessionSidebarSplit`, 2026-10-08).

### Width read into state: whole points and a loop detector
- `onGeometryChange` writing a `CGFloat` into `@State` can feed back (wrap → height → scroller → width).
  Use `.measuredWidth("label", $width)` (Hub/HubPerf.swift): rounds to whole points and logs
  `hub.layout.loop <label>: N width writes in 1 s` past 30/s. A burst during a window-resize animation
  is expected; a burst with a constant window size is a loop.

### Dense lists and accessibility
- The live hub always has an AX client (dictation, `tools control`, Codex computer use). With one,
  SwiftUI walks every focusable responder per changed AX node: cost ∝ rows × controls per row × rows.
  Rows take values not models, and buttons/tooltips/hover sensors exist only on the hovered row.
- A plain `VStack` is right for tens of rows when exact heights matter (PR threads: anchoring survives
  a width change); a lazy stack estimates rows above the viewport and moves the visible ones.

## Web views

### Never create a `WKWebView` on a click
- Creation starts a web content process synchronously: 140 ms median, 371 ms p90, 1.2 s max on the
  main thread (130 creations in one day). `PierreWebDiffRenderer.make()` hands out a spare made 2 s
  after the last one was taken; the review window builds its own (one review per window).
  Bench: renderer time on session switches 100-240 ms → 0.0 ms (89002f2a1).
- A spare page is fresh: never hand a used web view to another review; the page keeps comments,
  threads, blame, find and scroll state.
- `onEvent(.ready)` may fire before anyone listens on a spare; only rely on `show()`, which queues
  until the page is ready.

### Scroll inside a web view
- WebKit has no CSS scroll anchoring (`overflow-anchor` is ignored); a virtualizer that re-places items
  mid-scroll moves the content. Anchor by hand: same `data-line` in the same file moved by > 4 px →
  correct `scrollTop` by the delta (web/diff-viewer/main.ts `trackJump`).
- A refresh that arrives mid-scroll waits for the scroll to end; a refresh of the same diff restores
  the reader's line at the same pixel (`reviewState.beforeRefresh`).

## The CLI behind the app

### Scope the computation to what was asked
- `agents changes --tools <ids>` used to compute every turn of the session for each new transcript
  row: 2.5 s CPU and 2.9 GB on a 218 MB session. `computeSessionChanges({ onlyTools })` computes only
  the requested calls' turns and still reads an out-of-range command when it can feed a later one
  (a heredoc writing a file, or a script the session wrote). 1.4 s; parity 800 calls / 3 sessions, 0
  differences (f0a37bf9b). Remaining: transcript parse 0.6 s + 2.6 GB RSS.
- A cache keyed on "what can change" beats re-deriving; prove parity on real data, not only fixtures,
  and plant a regression to prove the parity test catches.

### A resident process should remember what did not change
- The hub's agents tree re-read every sub-agent transcript of every parent on each refresh (158
  refreshes a day, 1.29 s each through the server). Three generic caches, all keyed by file identity:
  1. **Append-only scan, resumed** (`scanAppendOnly`, src/utils/ai/transcripts/file-scan.ts): keep the
     result up to `size - window` (every match before it is whole), scan only new bytes, scan the short
     unfinished tail into a copy each time. Reset on another inode, a shorter file, or changed bytes at the
     file's start or before the kept offset (a cheap guard against in-place rewrites).
  2. **Parsed row per file** (`readAgent`): reuse when inode, size, mtime (exact float, not a value
     rebuilt from an ISO string: it loses sub-millisecond precision and never matches) and the meta
     file's mtime are equal; recompute only clock-dependent fields (`state`) per call.
  3. **Bounded LRU** (delete + set on hit, drop the oldest past a limit).
- Result: repeat refresh 430 → 42 ms wall, 630 → 57 ms CPU; first call 707 → 418 ms. Parity: 6934
  lines of output identical, tool counts of 368 finished agents identical (2ebffa076).

### Do not allocate for the worst case on every call
- `Buffer.alloc(4 MB)` per scan, zeroed, for files that needed a few hundred new bytes, was the top
  self-time entry. Size the buffer to what is left to read and use `allocUnsafe` when every used byte is
  read first.

### Serial servers turn one slow door into many slow calls
- The hub server answers calls one after another: `hub procs --json` took 350 ms from a shell but
  1.28 s on average through the server, waiting behind `hub agents`. Fix the slowest door first, then
  re-rank; the queue time of every other call falls with it.
- Every call the app runs as a process pays Bun startup and module loading (~240 ms CPU); a frequent
  command deserves a server door (src/hub/server/doors) and a server-first call site.

### Wall-time timers lie under concurrency and load
- `measureAsync` around one task inside a `Promise.all` measures its wall time, including the other
  tasks' turns on the event loop. `discover.walk` read 3.4 s in the usage poll daemon while a warm walk
  costs 107 ms (CPU-profile it alone). Rank by `process.cpuUsage()` deltas or a `--cpu-prof` run.

### Polling watchers
- A safety refresh every 5 s that runs a full snapshot (~1 s CPU) costs ~15% CPU on its own (widget
  watcher, 2026-10-08). Refresh on the event; keep the safety interval long and cheap.
