# Performance techniques

Each entry: the symptom you will see, why it happens, the fix, and the measurement that proved it.
The techniques are general; the "Measured" lines name where they were proved (details of that codebase
are in [genesistools.md](genesistools.md)). Add a new entry at the end of its section, with a date.

## Contents
- Animation: continuous animations · first loads and bulk changes
- Views and layout: custom `Layout` · width into state · dense lists and accessibility
- Web views: creation off the click path · scroll anchoring
- Data behind the UI: scope to what was asked · resident caches keyed by file identity · append-only
  files · stream, do not slurp · allocation · serial servers · wall time vs CPU · polling

## Animation

### Continuous animations belong to the render server, not to SwiftUI
- **Symptom:** an idle window costs CPU. `sample` shows `NSDisplayCycleFlush` → `layoutIfNeeded` and
  `CA::Transaction::commit` many times a second, with almost no app frames above them.
- **Why:** `.animation(.linear.repeatForever)`, `withAnimation(...repeatForever)`, `phaseAnimator` and
  `TimelineView(.animation)` are evaluated by SwiftUI in your process: every display frame re-runs the
  animatable attributes and lays the hosting view out. A 9 pt spinner keeps a whole window busy.
- **Fix:** an `NSViewRepresentable` that owns a layer and adds a `CABasicAnimation`
  (`repeatCount = .infinity`, `isRemovedOnCompletion = false`). Re-add it in `viewDidMoveToWindow`
  (a layer drops its animations when its view leaves a window). Drive on/off with a plain flag.
  Staggered effects: one `CAAnimationGroup` per dot with `beginTime = now + index × stagger` and
  `fillMode = .backwards`.
- **Measured:** A/B, one spinner in a small window, 15 s: 0.73 s CPU → 0.00 s. Three pulsing dots:
  0.74 s → 0.00 s. A widget app: 24.3% → 2.1% CPU (2026-10-08).

### Do not animate a first load or a bulk change
- `withAnimation(.spring)` around assigning a whole list builds an animated insertion (transition plus
  layout) for every row at once. Animate only a handful of changed rows in a list already on screen;
  a first load or a mostly-changed list appears without animation.
- **Measured:** a non-lazy list of PR threads, 1.4 s main-thread stall per open → no stall.

## Views and layout

### A custom `Layout` must not measure what it already knows
- `subview.sizeThatFits(ProposedViewSize(width: nil, …))` sizes the whole subtree at its ideal width,
  and `place` with another proposal sizes it again. A fixed-width child is placed at its constant.

### Width read into state: whole points and a loop detector
- `onGeometryChange` writing a `CGFloat` into `@State` can feed back (wrap → height → scroller → width).
  Round to whole points, and count writes per second per label: past ~30/s at a constant window size,
  log it as a layout loop. A burst during a window-resize animation is expected.

### Dense lists and accessibility clients
- Any accessibility client (dictation, automation tools, an AI computer-use agent) makes SwiftUI walk
  every focusable responder per changed accessibility node: cost ∝ rows × controls per row × rows.
  Rows take values, not observable models; buttons, tooltips and hover sensors exist only on the
  hovered row. Measure clicks with an accessibility client attached; without one the numbers lie
  (2-18× lower).
- A plain `VStack` is right for tens of rows when exact heights matter (anchoring that survives a width
  change); a lazy stack estimates rows above the viewport and moves the visible ones as it measures.

### Defer large recipient menus until the user opens them

- **Symptom:** a pane hangs before its opening animation starts, despite low idle CPU.
- **Why:** a SwiftUI menu Picker materializes AppKit menu items and their accessibility state while
  the containing pane is built. Sampling found `AppKitMenuCore.Child.value` and
  `AppKitPopUpAdaptor.updateMenu` on the main thread.
- **Fix:** keep the closed control cheap; construct a searchable chooser only on request. Reuse the
  shared agent-tree projection and roster rows, bound the first batch, and preserve exact child-agent
  identity. Keep the enclosing panel open while the chooser is presented.
- **Measured, 2026-10-08:** an actual hosted view with 800 recipients constructed native menus of
  1 and 801 items before the fix, versus only the unrelated 1-item menu afterward. The planted old
  implementation failed that regression. A synchronized old live opening delayed its first callback
  by 899 ms; three new openings measured 94.3 / 37.9 / 57.2 ms to first callback and 414.5 / 412.3 /
  411.4 ms total transition time. These are callback timings, not compositor frames or proof that
  search, selection and dismissal all work; verify those interactions separately.

## Web views

### Never create a `WKWebView` on a click
- Creation starts a web content process synchronously on the main thread: 140 ms median, 371 ms p90,
  1.2 s max (130 creations in one day). Keep one **fresh** spare, made a moment after the last one was
  taken, and hand it out on the click. Never hand a used page to another document: pages keep state.
  A spare may become ready before anyone listens, so consumers must not depend on the ready event;
  queue content until the page says it is ready.
- **Measured:** session switches 100-240 ms of renderer creation → 0.0 ms.
- Every web content process is notified on a display change (`screenPropertiesChanged`, a synchronous
  wait on the main thread); keep the number of live web views small.

### Scroll inside a web view
- WebKit has no CSS scroll anchoring (`overflow-anchor` is ignored). A virtualizer that re-places items
  mid-scroll moves the content: anchor by hand (same element, same file moved by more than a few px →
  correct `scrollTop` by the delta). A refresh that arrives mid-scroll waits for the scroll to end.

## Data behind the UI

### Scope the computation to what was asked
- A per-row request ("what did this tool call change?") must not recompute the whole document. Compute
  only the part the request names, and still read what can feed it (a script written earlier and run
  now). Prove parity on real data (hundreds of cases, 0 differences) and plant a regression to prove
  the parity check catches. **Measured:** 2.5 s → 1.4 s CPU per new row on a 218 MB transcript.

### Index the bounded active slice before loading large bodies

- **Symptom:** requesting the latest 100 inbox records scans and sorts historical rows containing
  large answer bodies, delaying a native update even though only a small result is needed.
- **Fix:** use an index matching the active-row predicate and descending timestamp. In SQLite the
  measured case uses `ON entries(ts DESC) WHERE superseded_by IS NULL`. Inspect the production
  query's plan; a final bounded sort may remain without bringing back the historical full scan.
- **Measured, 2026-10-08:** three alternating pairs on fresh copies of one frozen database, 20 reads
  per arm, used median 488 ms CPU without the index and 6 ms with it (98.77% less). All six output
  hashes matched. Index creation took 0.353–0.380 ms on this fixture. A subsequent native inbox
  receipt applied in 198.279 ms; that single receipt is not a general 500 ms guarantee.
- Keep benchmarks isolated from the live database. Retain ordering and superseded-row exclusion
  tests, and show that removing the index fails the query-plan regression.

### A resident process remembers what did not change
- Key caches by **file identity**: inode + size + exact mtime (a float; a value rebuilt from an ISO
  string loses sub-millisecond precision and never matches), plus any side file it reads.
- Recompute only clock-dependent fields (running/stopped from "now") on a hit.
- Bound every cache (LRU: delete + set on hit, drop the oldest past a limit).
- **Measured:** an agents tree refresh 430 → 42 ms wall, 630 → 57 ms CPU; output identical.

### Append-only files: resume, never re-read
- A transcript or event log only grows. Keep what was computed up to a safe offset and process only the
  new bytes:
  - **Scans:** keep matches up to `size − window` (every match before it is whole); scan the short
    unfinished tail into a copy on each call and never keep it.
  - **Parsed records:** keep records of complete lines; parse an unfinished last line fresh each time.
  - **Guard:** start over on another inode, a shorter file, or changed bytes at the file's start or just
    before the kept offset (cheap protection against in-place rewrites; true mid-file edits are out of
    contract and documented as such).
  - Hold the state only for files large enough to matter, and only a few at a time (memory).
- **Measured:** a live 163 MB rollout, 175 ms → 28 ms per write; envelopes identical on 16 appends.

### Stream, do not slurp
- `readFileSync(path, "utf8")` of a 218 MB file became a 640 MB string (UTF-16 as soon as one character
  is not ASCII) before a line was looked at; reading 192 side files the same way, all at once, doubled
  it. Read lines in chunks, cut at newline **bytes** (a multi-byte character is never split), and read
  side files lazily (a generator per file). **Measured:** peak memory 2.6 GB → 1.2 GB, output
  byte-identical, same time. Memory pressure stalls the whole machine, not just your process.

### Directory walks: stat first, read only what changed
- A directory's mtime changes when an entry is added, removed or renamed. A resident process keeps each
  directory's sorted entries with its mtime and inode, `stat`s every directory on the next walk and reads
  only the changed ones. `stat` before `readdir`, so a change between them shows up as a newer mtime on
  the next walk. Measured: 3,942 directories, `readdir` 74 ms vs `stat` 6 ms; a repeat walk of 30k
  session files 259 → 74 ms CPU. Prove it with a test that adds, renames and removes between walks in
  one process, and a planted break (cache ignores mtime) that fails it.

### Do not allocate for the worst case on every call
- A zeroed 4 MB buffer per scan for files that needed a few hundred new bytes was the top self-time
  entry of a refresh. Size buffers to what is left to read; `allocUnsafe` when every used byte is read
  first.

### Serial servers turn one slow door into many slow calls
- A single-threaded server answers calls one after another: a 350 ms call took 1.28 s on average while
  waiting behind a 1.3 s one. Fix the slowest door first, then re-rank by total time.
- A process per call pays runtime startup and module loading (~240 ms CPU for Bun with many imports).
  Frequent calls belong in the resident server; its answer must be byte-identical to the CLI's
  (move the JSON-building code into the library first, compare outputs on real data).
- A shape the server does not accept silently falls back to a process: one unhandled flag that the
  caller always sends (`--provider`) sent every live-tail call to a process.

### Wall-time timers lie under concurrency and load
- `measureAsync` around one task inside a `Promise.all` measures wall time including the other tasks'
  turns. A walk read 3.4 s in a busy process and costs 107 ms alone. Rank by CPU (`process.cpuUsage()`
  deltas, a `--cpu-prof` run, `sample`), and note the machine's load average next to any number.

### System-wide observers do the least possible per event
- An observer of `NSWorkspace.didActivateApplicationNotification` runs on every app switch of the whole
  machine, in every process of your app that installed it. A `CGWindowListCopyWindowInfo` there (a
  WindowServer round trip building a dictionary per window) showed up in an idle app's samples. Gate the
  expensive part on whether this process can need the result now (here: only a process a link can
  reach needs the window stacking), and keep the check itself to a syscall or two.

### Polling watchers
- A safety refresh every 5 s that runs a full snapshot (~1 s CPU) averages ~20% of one core. Refresh on
  the event; keep the safety interval long and the safety check cheap.

## Thumbnails (media stream, 2026-10-10)
Key the cache by file identity (`stat`: inode, size, mtime), bucket pixel sizes to powers of two of the screen scale, and decode off the main thread with `kCGImageSourceShouldCacheImmediately`, so the first draw never decodes on the main thread. Measured: a 5K screenshot 50–65 ms (was 114–130 ms), a cache hit ~25 µs.


## From the widget motion stream (2026-10-10, 417458101)
"a computed property that filters or searches ~1000 elements, read in a layout pass, is paid once per panel per frame; store it when its inputs change". The measured share here was 25% of busy main-thread time.
