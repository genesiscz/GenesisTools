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

### Polling watchers
- A safety refresh every 5 s that runs a full snapshot (~1 s CPU) costs ~15% CPU on its own (widget
  watcher, 2026-10-08). Refresh on the event; keep the safety interval long and cheap.
