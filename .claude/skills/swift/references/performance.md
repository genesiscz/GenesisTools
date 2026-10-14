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
- Gate every poll on whether anyone can see the window: `NSWindow.occlusionState` (one notification covers
  covered, minimized, hidden and another Space). Hidden, start no process; keep a kernel-pushed watcher and
  queue what it reports; shown, drain the queue once and re-ask only past the safety interval. A loop calls
  `await untilVisible()` before each round. **Measured (2026-10-10):** a hub left in its Agents mode ran
  `tools hub agents --json` ~60×/hour all night (714 runs, 56.5 s of main-thread renders in one day).
  A scripted off-screen run reads as covered (alpha 0): never gate it.

### A view that takes closures re-renders with its parent
- SwiftUI cannot compare closures, so a pane built with callbacks (`onShowChange: { … }`) runs its body on
  every update of the view around it, and everything below it diffs again. Wrap a heavy pane in an
  `Equatable` view that compares the values it shows (not the callbacks) and apply `.equatable()`. Pass a
  model a view only hands on as a plain `let`, not `@ObservedObject`: observing it re-runs the view on every
  publish of that model, including flags no view reads (a `loading` flipped twice per refresh).
- **Measured (2026-10-10, `GENESIS_RENDER_PROBE=1` + HubBench `agents`):** each Agents list refresh re-ran the
  open lead's whole transcript list (`list.body`); after, only the changed row and the cheap screen around it.

## Thumbnails (media stream, 2026-10-10)
Key the cache by file identity (`stat`: inode, size, mtime), bucket pixel sizes to powers of two of the screen scale, and decode off the main thread with `kCGImageSourceShouldCacheImmediately`, so the first draw never decodes on the main thread. Measured: a 5K screenshot 50–65 ms (was 114–130 ms), a cache hit ~25 µs.


## From the widget motion stream (2026-10-10, 417458101)
"a computed property that filters or searches ~1000 elements, read in a layout pass, is paid once per panel per frame; store it when its inputs change". The measured share here was 25% of busy main-thread time.

## From the GenesisKit markdown viewer (2026-10-13 17:22)

### Thousands of rows: fold, page, then lazy
- A git panel listed every untracked file of a notes vault (3,416 rows) and hung the key window (see gotchas.md).
  Fold untracked files under the shallowest folder that holds no other change (as `git status` does without
  `-uall`), show 100 rows per list with "Show more", and put the rows in a `LazyVStack`. **Measured:** first layout
  of the panel on the real 3,416-entry repository 0.039–0.053 s in a hosted window.

### Precompute sort keys; never derive lists in a body
- A comparator that recomputed a group's newest modification date on every comparison cost O(n log n × group size)
  (one folder held 2,786 files), and the panel's body re-ran it 5 times per tab switch because its parent
  re-rendered. Compute derived lists once per change of their inputs (status generation, dates, order, filter) in a
  model, with keys computed once per element, and let the body read the result.

### Count publishes as well as bodies
- `RenderProbe.watch(model, "name")` (GenesisKit `Perf/RenderProbeWatch.swift`) counts every `objectWillChange` as
  `publish.name`, next to the `RenderProbe.hit` body counts, so a summary says which model fired and which bodies
  ran because of it. **Measured (baseline, 2026-10-13):** one tab switch in the markdown viewer published the
  documents model 10 times and ran the git repository panel 5 times, the git sidebar 5, the status bar 4, each tab
  twice; 70–90 ms synchronous, 140–380 ms main-thread busy (`MainBusy.Meter`), load average 23, hosted window
  without an accessibility client. Recipe: the bench in genesistools.md.

### A fresh web view per tab is a blank frame per tab
- A pane keyed by `.id(document.id)` that owns a `WKWebView` creates the web view and loads the whole template
  (markdown-it, highlight.js, mermaid) on every tab switch and every Source → Split: creation on the main thread, then
  a blank page until the first render. Keep a warm spare and keep the old content on screen until the new page
  confirms its render (see "Never create a WKWebView on a click").

### Page overlays: one column, union rectangles, a resize observer
- Change bars drawn as `::before` on each marked block land inside a list's indent (over the item numbers) and do not
  appear at all on table rows (a `tr` cannot hold a positioned pseudo-element). Draw them in one absolutely
  positioned layer inside the reading column: one bar per change spanning the union of its blocks' rectangles, all at
  one x, re-placed by a `ResizeObserver` on the article. For row-precise marks give markdown-it's `tr_open` a source
  line like the other block tokens.

## Second pass on the markdown viewer (2026-10-13 18:18)

### Sample from inside the bench
- `sample <pid>` from the shell missed the bench: the test prints its lines only at exit, so a shell loop that waits
  for the first line samples nothing. Start `/usr/bin/sample <getpid()> 8 -file <out>` with `Process` inside the bench
  (`BENCH_SAMPLE=<path>`), then rank the main thread's own frames. It named the costs at once:
  `MarkdownWebView.makeNSView` 182 of 466 samples (39%, the web view per tab), `GitRepoPanel.body` 55 (the fold and
  sorts in the body), `GitFileStateModel.state.setter` 67 (a publish that re-ran the panel).

### Results of the fixes (tab-switch bench, same notes, load average 17 to 25)
- Warm spare page (`MarkdownWebSpare`): synchronous part of a switch 30–98 ms, was 56–109 ms.
- Repository panel lists derived off the main thread (`GitRepoPanelLists`) and the group sort keyed once.
- `select` publishes 3 times, was 10.
- Keeping the old page until the new one renders (`GenRenderSwap`) doubles `md.pane` bodies during the swap (two panes
  observe the model for up to 0.6 s) and raised main-thread busy per switch to 267–324 ms; the longest pass stayed
  55–97 ms and no frame is blank. A pane that must not re-render while it leaves needs its own model.

### Keep the old content until the new one has rendered
- `GenRenderSwap(value:id:timeout:)` (GenesisKit `Controls/GenRenderSwap.swift`): the old content stays on top while
  the new one builds underneath, then fades out in 0.14 s (at once under Reduce Motion). The content signals with the
  `ready` it is handed, or through `@Environment(\.genRenderReady)` deeper down: the markdown page after its render
  call returns, the transcript after its first layout. A content with nothing to wait for calls `ready` on appear; the
  timeout (0.6 s) covers one that never signals. The leaving copy must give up shared things (sheets, find panels,
  the window's web proxy): the viewer passes `leaving` to its pane.

## From the GenesisKit markdown viewer's file tree (2026-10-15 19:15)

Release check app, a 600-row tree, 360 wheel events through the window, CPU per event, two interleaved rounds each.

### A SwiftUI `LazyVStack` of rows costs about 12 to 17 ms per scroll event

- Every scroll frame re-laid out the visible rows, hashed and compared their ids, and walked every row's responders
  for accessibility focus. With 100 tabs open, each publish re-ran the tree and increased the cost.
- **Fix: an `NSTableView` whose cells host the SwiftUI row** (`MarkdownTreeTable`). Scrolling only moves the clip
  view; a row's SwiftUI view is built when its cell comes into view or its value changes. 16.7 / 17.1 → 5.7 / 5.6 ms
  (debug), 15.7 / 16.1 → 5.2 / 5.8 ms (release).
- Folder open/close: diff the old and new row keys and `insertRows`/`removeRows` with `.slideDown`/`.slideUp`
  (`MarkdownTreeTable.animate`); reload only when Reduce Motion is on or the change is large.
- Row ids that are long paths: hash once (`FileTreeRowKey`), never re-hash a `String` per comparison.

### A hosted cell's safe area lays out the whole window

- Each cell's `NSHostingView` re-evaluated its safe area on scroll, and the invalidation climbed to the table's own
  SwiftUI host, so every frame laid out the window root. `host.safeAreaRegions = []` in the cell: 5.2 / 5.8 → 4.4 /
  5.1 ms. Found by breaking on `-[NSView setNeedsLayout:]` for the root view in a scratch app (never on Martin's apps).

### A scrolling AppKit view inside any SwiftUI host makes that host lay out every frame

- Moving the table into its own `NSHostingView` gave nothing (that host laid out every frame instead). Laying the
  table's scroll view over the window's SwiftUI root, as a sibling of the root (`MarkdownWindowContentView` +
  `MarkdownOverlaySlot`), stopped the root's layout (500–570 → 98 samples) but saved only 13% (5.5 / 5.1 → 4.8 / 4.2
  ms): the rest is SwiftUI building rows as they scroll in. A table of AppKit rows measured 2.0 ms beside the root.
- Cost of the overlay: the window's content view is AppKit's, so focus and right-clicks behave differently (see
  gotchas.md). Do it only when the measured gain is worth it.

### Measure scroll cost on a visible window

- A window behind the desktop or at alpha 0 is not drawn, so its scroll cost reads near zero. Use a visible window on
  a second display (or a quiet moment), interleave the before and after builds, and report each round.
- Debug builds cost about 25% more than release here. Install with `bun run start` (release) before judging lag.

### Divider drags: log, do not guess

- A resize that "is not 1:1" was not reproducible. The divider now logs one line per drag to the unified log
  (subsystem `genesiskit`): moves, pointer and divider travel, the largest gap, the overlay's drift from its slot.
  A drag that stops at the sidebar's maximum width (560 pt) looks like lag; check the clamp first.

### The installed app is the measurement that counts (2026-10-15 20:10)

- The same scripted scroll cost 4.2 to 4.8 ms per event in the check app and 8.1 ms in Martin's installed viewer
  (1720 × 1255 window, about 30 tabs, git marks, a large vault): at the 8.3 ms of one 120 Hz frame. A check app
  proves direction, not the user's number. Measure both: `ps -o cputime` of the app's pid around
  `tools control scroll --app <pid> --coords X,Y --direction down --pixels 3000 --time 1.5 --repeat 4 --alternate`.
- To find where the extra went, `/usr/bin/sample <pid> 5` during that scroll (read-only, safe on a user's app) and
  split `NSHostingView.layout` by its ancestors: 90 of 136 samples were inside the table's row cells, 15 in the window
  root. The rows' own SwiftUI hosting was the cost, not the git marks, the tab bar or tooltips.

### Price a SwiftUI row before you rewrite it in AppKit (2026-10-15 21:30)

Release check app, 600-row tree in an `NSTableView` whose cells host the row in an `NSHostingView`, 360 scripted wheel
events, ms of CPU per event, two interleaved rounds each:

| Cell | ms per event |
|---|---|
| Full SwiftUI row (Button, HStack, icons, git marks, `.contextMenu`, double-click gesture, hover style, hover preview) | 3.8–4.8 |
| The same row without `.contextMenu` / without the double-click gesture / without the hover style / without the hover preview | about 0.2–0.7 less each |
| The same row with all four off | 3.3 |
| A hosted SwiftUI `Text` only | 2.4–2.5 |
| A plain AppKit label (`NSTextField`) | 1.8–1.9 |

- Hosting itself is cheap: a hosted `Text` costs only about 0.6 ms more than an AppKit label. The cost is what the
  row carries. Per-row gestures, menus and hover styles each add a few tenths of a millisecond per scroll event.
- Body runs were not the problem: `RenderProbe` counted 519 row bodies for the whole scroll, one per row that came
  into view. `.equatable()` was already in place; removing an `AnyView` root changed nothing measurable.
- So the order is: count bodies (`RenderProbe` or `Self._printChanges()` in debug), then price each modifier by
  switching it off, then move per-row interaction to the container (one `menu(for:)`, one `doubleAction`, one tracking
  area), and only then consider AppKit cells.
- Research behind it (2026-10-15, three reports in the notes vault, Dev/Swift/Performance): Apple's WWDC22 10075
  documents one `NSHostingView` per cell with `rootView` updated on reuse; WWDC26 321 lists four lazy-stack rules
  (filter before the stack, keep unrelated environment reads out of row bodies, keep the row structure constant,
  avoid height changes after appear); a Stack Overflow answer (72070486) explains that a table asking each row for its
  height re-runs row bodies, so give rows a fixed height. Public case studies (kean.blog, troz.net) moved big lists to
  AppKit tables but published no per-row numbers.
## Third pass on the markdown viewer: the file tree "laggy" (2026-10-14 16:35)

Bench: `MarkdownTreeLagBenchTests` (genesistools.md), 24 tabs, the vault folder of the report, a hosted 1900×1150
window, load average 15 to 25. Stall reports from the real app showed 509 to 1268 ms on the main thread, all layout.

### A window root's hosting view must not size itself
- An `NSHostingView` with the default `sizingOptions` derives the window's min, max and intrinsic size from SwiftUI.
  On every update it sizes the WHOLE tree again (`NSHostingView.invalidateSizeConstraintsIfNecessary` →
  `minSize()` → `ViewGraph.sizeThatFits`): 1258 of 2133 layout samples for an update that changed one string. Set
  `sizingOptions = []` on a window's content and give the window an explicit `minSize` (the hub found the same in
  2026-09, `HubGlass`). **Measured:** 20 unrelated publishes 1104 to 1187 ms busy → 232 ms; the longest pass of a tab
  switch 621 to 827 ms → 112 to 156 ms.
- A frame-owned panel already did this; a plain `window.contentView = NSHostingView(rootView:)` is the trap. Build the
  content through one factory so tests host the same view the window does (`contentView(model:)`).
- The sizing it drops is real: the content held the window at 603 pt, 743 with three sidebars open. Measure that
  minimum per state with the standard sizing once, state it as a formula (`MarkdownWindowMinimum`), set
  `contentMinSize` when its inputs change and grow a narrower window, and test the formula against the measurement.

### A row list inside a view that observes a big model
- A tree view that observes a 30-property model walks its `ForEach` on every publish. `.equatable()` on each row skips
  the row's body, but the list still builds every visible row value. Move the list into an `Equatable` child that
  takes values (rows, selection, style, pulse, git marks) and compare those. **Measured (60 publishes):** 1214 ms →
  654 to 816 ms busy.
- Tabs the same: each tab observed the model, so one publish ran all 24 tab bodies (480 for 20 publishes). A tab now
  gets `active`, `preview` and its fill as values and observes only its document: 0 tab bodies for an unrelated
  publish, and only the changed tabs on a selection.

### Derived git marks off the main thread
- The file tree's marks (`GitTreeDecorationsModel.update`) were built from the whole repository status on the main
  thread, twice per refresh, plus two dictionary comparisons: 24% of the main thread in the tab-switch bench on a vault
  with 1,825 status entries, at every start, git change and move of the tree's root. Build and compare them on a
  utility queue and publish the result with a ticket. The folder walks also asked `String.count` per level of every
  entry; cutting at the last "/" in UTF-8 made one call 2.6 to 8.5 times faster (117 → 31 ms, debug), parity equal
  on three roots of the real vault.

### Count row construction, not only bodies
- A body probe (`tree.row`) cannot see a list that rebuilds its rows and then skips every body. A probe in the row's
  `init` (`tree.rowItem`) counts it, and it exists in the old code too, so a regression test can fail on the old
  version (`MarkdownWindowPublishCostTests`: 9 rows built and 9 tab bodies for 3 publishes before, 0 after).
