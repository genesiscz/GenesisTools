# Gotchas, each with the fix

## Measurement traps

- **The profiler prints ≥ 1 s as seconds.** `[profile:x] walk 1.234s`. A grep for `[0-9]{4}ms` finds
  nothing and reads as "nothing is slow". Match `(\d+(?:\.\d+)?)(ms|s)`.
- **`app-perf.log` mixes processes.** A bench run or a second face writes the same `hub.*` lines.
  Before calling something a loop, check for `since-launch` phases and `hub.bench` marks around it.
- **Spans time work, not the layout it causes.** Use `HubMainBusy.measure(label)` after a state change.
  It is `@MainActor`: from a non-isolated method already on the main queue, call it inside
  `MainActor.assumeIsolated { }`.
- **Several `main busy` lines with the same number are one stall** (every open window measured the
  same 600 ms). Read the stack file, not the labels.
- **Inclusive sample counts:** a parent frame's count contains its children. Rank by the deepest app
  frame that still owns the time.
- **A restart lowers CPU by itself.** After rebuilding, a fresh process has no accumulated state; prove
  a fix with an A/B or a bench, not only "it is lower now".
- **`ps -o time` vs `%cpu`:** use CPU-time deltas; `%cpu` is a lifetime-decayed average.
- **"Main busy" can be WindowServer, not you.** A stall stack whose time sits in `SLSFindWindowAndOwner`
  (under `FindWindowOfClass`, the hit test of every mouse event) or in `SLSDisplayGetPreferHDR10` (WebKit's
  `screenPropertiesChanged`) is a synchronous call into an overloaded WindowServer. In one 16-second sample, 783 of
  ~1980 busy main-thread samples were that hit test. Check `WindowServer` CPU (80-100% here, with a screen
  recording and a computer-use agent running) before optimizing a view that only looks slow.

## SwiftUI / AppKit

- **A `repeatForever` animation can repeatedly invalidate layout.** Measure the affected view and
  animated properties; use a layer animation for a measured hot path (see performance.md).
- **`withAnimation` around a first load** animates every row; skip it when nothing was on screen.
- **`Process.waitUntilExit()` inside a body** spins the run loop and can double-free StackLayout
  (crash). Load in a store on a background queue (CLAUDE.md of the app).
- **A layer loses its animations when its view leaves the window.** Re-add them in `viewDidMoveToWindow`.
- **CA coordinate space:** an `NSView` layer has y up. `addArc(clockwise: true)` from angle 0 and a
  rotation to `-2π` look clockwise on screen, matching SwiftUI's `Circle().trim` + positive degrees.
- **A SwiftUI `List` viewport moved inside a row insert's resize** stops AppKit re-measuring rows (see
  the app CLAUDE.md, `TranscriptScrollAnchor.remeasureVisibleRows`).

## Expanding surfaces and input

- **Stable endpoints can hide jumping icons.** A centered stack can overflow an intermediate window
  width. Give the rail an independent edge overlay and test actual hosted control rectangles during
  open, close and interrupted transitions. See [animation-verification.md](animation-verification.md#icons-stay-anchored-during-expansion).
- **A badge overlay does not enlarge its parent.** Include size-changing badges in intrinsic layout;
  use the measured size as the target, not the currently animated window width. Round measurements,
  ignore unchanged values and schedule native updates after the layout transaction.
- **Window-local drag translation changes as the window moves.** Track pointer events in screen
  coordinates from mouse-down; hold presentation height stable during the drag. Give the native
  handle its own accessibility identity rather than identifying the image behind it.
- **Padding and allocated height must include populated controls.** A side rail with 4 pt end
  padding looked flush to its curved edge; adding a badge to a nominal 28 pt button also outgrew
  its allocation. Reserve explicit end insets and include the badge row plus inter-row spacing in
  the shared compact-height calculation used by both host and coordinator. Test counts 0 → 128 → 0,
  not only empty inboxes. The reproduced fix used 12 pt end insets and a 42 pt badged button;
  the live rail grew from 354 to 384 pt, while the top header grew from 39 to 47 pt. These dimensions
  suit this design, not every panel. Inspect the first and last controls against the curved shape.
- **A closed SwiftUI Picker can still build every native menu item.** Thousands of choices can stall
  the pane that contains it before the picker is opened. Sample the opening and inspect native menu
  construction; defer a searchable, bounded chooser until requested.
- **An uncertain accessibility action may have executed.** Re-read the live window after an AX error
  before retrying. Otherwise a second press can close what the first press opened.
- **A perfect window capture can still be unclickable.** Verify the system hit-test at the control's
  screen coordinates. Set a top panel's final level after `isFloatingPanel`, whose setter can reset it.

## Build and install

- **`bun run app` says "cannot find '<NewType>' in scope"** right after you added a file to GenesisKit,
  while `swift build` in GenesisKit succeeds: the app builds GenesisKit through its own scratch path
  `src/macos/GenesisTools/.build/opt`, whose build manifest is cached. Fix once:
  `cd src/macos/GenesisTools && swift build -c debug -Xswiftc -O --scratch-path .build/opt --disable-build-manifest-caching`,
  then `bun run app` again. (Touching `Package.swift` did not help.)
- **`bun run app` reaps window faces**, including the hub the user had open; the link relay restarts
  it with `--hub --resume`. Check with `ps -Ao pid,command | rg "MacOS/GenesisTools --"`.
- **The widget preview (`GenesisTools Preview.app`) is built by `scripts/build-widget-preview.ts`**
  in its worktree and is not relaunched by it: `kill -TERM <pid>` then `open -g` the bundle.
- **`swiftc` with top-level code:** do not pass `-parse-as-library`.
- **`swift build --scratch-path "$S"` with an empty `$S`** builds into the package folder itself
  (`.lock`, `build.db`, `arm64-apple-macosx/`, `debug.yaml` next to `Package.swift`). Check the variable,
  or spell the path out (`--scratch-path .build/opt`).
- **Swift test suites:** `swift test` in GenesisTools (368 tests) and in GenesisKit; run both after a
  GenesisKit change, because the app compiles against it.

## Caches

- **A cache of parsed JSON costs about five times the file's bytes.** Caching the parsed records of a live
  163 MB rollout saved 147 ms per write and held **848 MB** resident in an always-on server (measured with
  `Bun.gc(true)` and RSS before/after). Measure the memory of a cache before shipping it; bound it by file
  size, by total bytes and by idle time (drop entries nobody read for a minute), or cache a smaller derived
  state instead of the parsed input.

## Tests

- **A test that spies on one I/O primitive breaks when the code switches primitives.** A snapshot test
  counted `fs.readFileSync` calls; after the switch to `openSync`/`readSync` it saw 0. Keep the test's
  intent (one read per snapshot) and spy on what the code now calls.
- **An in-memory cache makes a fixture rewritten in place look unchanged** (same inode, larger size).
  Test caches with a rewrite, a replacement (rename over) and an append; the rewrite test is the one that
  catches a weak identity check.
- **A new test file has a fixed cost on CI** (here ~0.37 s of runner time before it asserts). Fold small
  test sets into the neighbouring test file.

## Process and repo

- **Another session's worktree is not yours.** `.claude/worktrees/feat-agents-comms` (widget, Clicky)
  belongs to a Codex session; edit there only when Martin says so, commit only your paths.
- **placeholder-check blocks a push** on internal repo names in fixtures; replace them in a new
  commit (no history rewrite).

## Animated panel verification

For stroke geometry, native animation scheduling, callback-versus-display timing, trace privacy and
proof that a screenshot came from the new build, see [animation-verification.md](animation-verification.md).
Keep measured findings separate from hypotheses; faster CPU numbers alone do not prove visual parity.

## Shared data and file events — 2026-10-08 08:40

- FSEvents may report `/private/var/...` or `/private/tmp/...` while Foundation's resolved URL
  uses `/var/...` or `/tmp/...`. Normalize known aliases consistently before exact-path filters;
  preserve near-miss prefixes. A real atomic-file-write test exposed dropped events in the
  Tasks/Shelf watcher even though an unfiltered probe saw them. Use string normalization for
  those known aliases rather than doing filesystem work for every delivered event.
- Synthesized memberwise Swift initializers remain internal even when a struct's fields and
  type are public. A port into GenesisKit must expose explicit initializers used by its host.
  Build the host as well as the package before claiming the extraction is usable.
- A Swift6.3.3 compiler crash was reproduced when synthesized Encodable code used private
  CodingKeys declared in an extension in another file (LLVM reported an external global).
  Module-internal CodingKeys avoided that crash in this fixture. Treat this as a measured
  compiler workaround, not a language rule; preserve decoder validation and test old files.
- Replacing per-session queries with a grouped read can save substantial work, but retain
  interval semantics. The Studio fixture fell from 64 to 4 prepared statements for 30 sessions
  and 90 segments by sharing grouped segments and a cumulative input index; boundary tests
  still require inclusive starts and exclusive ends, plus whole-session picker data.

## Permission and settings controls

- A denied notification authorization is remembered by macOS; another request does not prompt
  again. Offer the app-specific Notification Settings link, refresh on application activation,
  and keep the user's feature preference separate from OS authorization. Test both denied recovery
  and the first-time request, including failure to open Settings.
- A window face needs the shared notification presentation delegate too. Without `willPresent`,
  an activation banner can be suppressed while its own settings window is frontmost.
- Make a disclosure header one button with a full-width content shape and a useful minimum height.
  Verify a click near the far edge, not only an accessibility press on its chevron. The live fixture
  expanded from a click12pt inside the far end of a634×36pt header.
- Native menu pickers may ignore the intended value font size. Inspect the installed UI; a shared
  number-menu label with an explicit text size and hit area can preserve readable hour/minute values.
  Verify a value changes, persists and can be restored, rather than only that the menu appears.
- Multiple processes with the same bundle identity can confuse app-name-based automation. Use exact
  PID/window identities where supported. If temporarily closing an owned preview to disambiguate,
  preserve user state and restore it; do not treat a refused automation action as an app failure.

## Calculated dashboards and bounded number controls

- Measure aggregate work at the actual retention limit. The Clicky fixture populated 43,200 minute buckets. Five debug samples per grouping took 84.4–103.7 ms for minute grouping, 36.4–41.5 ms for 15-minute grouping and 74.0–77.5 ms for daily grouping. This measured calculation cost, not presented FPS. MAIN .claude/plans/widget-v1-evidence/ClickyPerformanceBench.swift reproduces it using GenesisKit PerfLog and an isolated log folder.
- A query can meet a 500 ms loading target while still blocking several animation frames. Prepare large immutable reports away from the main actor, publish the result on the view's actor, and use the existing profiler for slow spans. ClickyPerformanceReport.prepare is the shared example; its calculation rules remain identical to the synchronous version.
- Use a stable snapshot revision and explicit filter values for .task(id:). Do not put a fresh Date() in the task identity: publishing its result would create another identity and repeat the query. Clock-dependent range bounds are sampled when the query runs.
- Cancellation must prevent stale publication. Tie cancellation to the detached worker and discard its result if the requesting task was cancelled. A short bounded calculation may finish after cancellation; that is different from applying its stale result to a newer filter. The async Clicky regression checks both normal totals and cancelled preparation.
- Large numeric ranges should support typed values and bounded increments instead of hundreds of menu rows. Commit and clamp edits on Return or focus loss. A focused text field must also reflect stepper changes, or it displays the old value and can overwrite the increment when focus leaves. Live QA caught this 140/141 mismatch; the shared control now synchronizes both.
- Distinguish selected filters visually and through accessibility values. On macOS, a tint on a bordered weekday button did not make its selected state clear. Prominent selected buttons and Included/Excluded values made the filter state observable in the installed UI.

## Rail coordinates and responsive expansion

- Proving the rail's X coordinate stays at the bezel does not prove its icons stay put. Measure Y too. Recomputing cluster centers from expanded heights moved neighboring bubbles and the active buttons under a stationary pointer. Derive rail anchors and drag travel from compact allocations; the content pane can have a larger allocation independently.
- A screen-anchored rail must compensate when its expanding native window is clamped at the display boundary. GenesisKit's ScreenAnchoredWidgetRail converts the requested screen center into its own AppKit coordinates and hosts a fixed-height control stack there. The interrupted-animation test covers both bezels near a display limit, 38 sampled frames each. A disabled-anchor control moved up to 140 points and failed. Whole-point AppKit frame rounding can appear in an intermediate frame; the test bounds this at one point and does not equate callback samples with presented FPS.
- A larger NSPanel is ineffective if an embedded SwiftUI child still fixes its width at 432 points. Let both the host and the detail body fill the available proposal. Bound screen-percentage dimensions on small displays, and exercise the actual NSScrollView width at more than one host size.
- An expansion glyph is only decoration until it is inside a Button. Give the entire preview header a content shape, a meaningful accessibility label and a stable identifier; verify the real press and resulting native bounds. Reserve preview chrome separately from scrollable module content so a taller Flow preview cannot clip its footer.
- Integrate a working indicator with its inbox count instead of allocating a separate dot, arc and badge. Measure the text before sizing the circular ring. Use Core Animation for the spin; do not bring back a SwiftUI repeatForever that invalidates the host every frame. Quiet sessions with no inbox items need no empty rail placeholder.
- A fixture whose initial snapshot misses its deadline must throw before geometry assertions run. Continuing with a nil model produced unrelated style/height failures and hid the real one-point coordinate check.

- Lay out an expanded detail at its final target width, then reveal it through the native window clip. Passing each animated intermediate width into a text-heavy SwiftUI pane rewraps and relays out the transcript every frame. In the Widget recording, callback work maxima were 114.6 ms before this change and 5.2/7.3 ms in the later side/top takes. These were different live takes under changing load, not a controlled CPU comparison or a presented-FPS guarantee; 64.9/74.6 ms callback gaps still occurred.
- A failed statistics decode must not silently become a writable empty history. The Clicky regression reproduced a 40-byte unreadable record being replaced by 136 bytes of fresh counts on activation. Keep the original bytes untouched, pause collection and retain a visible recovery warning. An explicit reset can archive the original before creating a new history. Test valid history with corrupt preferences separately; those independent stores should not erase each other.
- Quick Look returns a file-type icon, not an error, for an unreadable image. Check `QLThumbnailRepresentation.type == .icon` before showing it as the picture (media stream, 2026-10-10).
- `.scrollIndicators(.visible)` does not keep overlay scrollers visible while idle. Use an edge fade (`.scrollOverflowHints()`) as the overflow cue.
- A fast-changing measurement (a scroll offset) belongs in a reference box inside `@State`; only a flipped boolean goes into observed state, or every scroll step re-renders the view.
- A shared singleton that presents UI (`PermissionCenter`) uses a recording presenter in a test process and never calls `NSApp.activate` there, or the test run takes the user's keyboard.
- Static stored properties are not allowed in a generic type's nested class (`OverlayScrollViewport<Content>.Viewport`); use a computed one.
- "cannot find type X in scope" for a type whose file exists, with an `emit-module command failed`: look for "No space left on device" further down the log. A full disk breaks emit-module first.
