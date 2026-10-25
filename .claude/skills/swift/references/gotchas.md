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
- **Wait for a free Swift slot by process name, never by command line.** `until ! pgrep -f 'swift-(build|test)|xctest'`
  waited forever on 2026-10-15: the `zsh -c` running the loop carries that pattern in its own command line, so
  `pgrep -f` matches the waiting shell itself. `pgrep -x swift-build` is not enough either: the same day a running
  `swift build` showed the process name `swift-package` (pid 6576), `pgrep -x swift-build` printed nothing, and a
  worker started its build beside it. Match the executable path, which the waiting shell never has:
  `while ps -axo comm= | grep -Eq '/(swift-build|swift-test|swift-package|swift-frontend|xctest)$'; do sleep 20; done`.
  `swift-frontend` also catches an Xcode build of another session, which uses the same CPU.
  Two waiters that poll the process list can still start together in the same second (two judge runs on
  2026-10-15). Run the command through `bun .claude/skills/babysit/scripts/swift-slot.ts -- swift test …`: it takes
  a kernel `flock` on a persistent lock inode, then waits for other sessions' Swift processes. Never unlink the
  lock file: the kernel releases ownership when the holder closes its descriptor or exits; there is no dead-PID takeover.
- **Display-driven tests fail while the screen is locked.** After the display sleeps or the screen locks, tests that
  wait for a display frame (edge panels, transcript scroll) fail with no code change, and `screencapture -l` cannot
  read a window (2026-10-15 07:05). Rerun them after the screen wakes before you call a change broken.

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

## From the GenesisKit markdown viewer — 2026-10-13 17:22

- **`NSWindowController.init(window:)` drops the window's frame autosave name.** It hands the window the controller's
  own `windowFrameAutosaveName`, which is empty, so `window.setFrameAutosaveName(...)` called before `super.init`
  is silently gone: no `NSWindow Frame <name>` key is ever written and every launch opens at the default size. Set
  `windowFrameAutosaveName` on the controller after `super.init`. Probed: the controller's setter restores a saved
  frame without overwriting it, and a later resize is saved. Test: assert `window.frameAutosaveName` after init
  (it read `""` before the fix). Check `defaults read <bundle id> | rg "NSWindow Frame"` when a size is not kept.
- **Every script that builds a package depending on GenesisKit by path needs `--disable-build-manifest-caching`,**
  not only `bun run app`: the Genesis install failed with "cannot find 'GitRepoPanel' in scope" right after a new
  kit file, because its `swift build -c release` reused the old plan.
- **A list that only looks heavy in the key window.** 3,416 rows (a vault's `git status -uall`: 20 modified, 3,396
  untracked), each a `Button` with `RowButtonStyle` and `.instantTooltip`, hung the real window at 99% main-thread
  CPU inside `AccessibilityNode.updateFocusResponder` → `ViewRendererHost.focusResponder(for:)`, with
  `swift_conformsToProtocol` / `_dyld_find_protocol_conformance_on_disk` at the top of the stack. A hosted test
  window (not key, no accessibility client) showed 0.01 s CPU for the same view: do not trust a background bench for
  focus or accessibility cost. Fix the shape instead: fold, page, lazy rows (see performance.md).
- **`git --no-optional-locks` is a git option, not a `status` option.** `git status --no-optional-locks` prints the
  usage text; a pipe into `wc -l` then "counted" 25 entries. Put it before the subcommand.
- **Git reports real paths** (`/private/tmp/...`), Foundation's `resolvingSymlinksInPath` drops `/private`: compare
  with one real-path function on both sides, or tree marks come out empty.
- **Never spin `RunLoop.main` inside an async `@MainActor` test.** It blocks WebKit's main-queue callbacks and the
  page never answers; `await Task.sleep` instead.
- **A test sandbox must cover every config read from outside the tool's own home.** The test preload moved
  `~/.genesis-tools`, but the vault lookup fell back to Obsidian's own `obsidian.json` in the real home, so the
  question tests wrote fixture folders and about 5,000 entries into the user's vault for a month. Point every such
  override (`OBSIDIAN_CONFIG_DIR`) at an empty temp folder in the preload, and make the override exclusive (a miss
  must not fall through to the real file). After any test run that touches a user-data sink, check the target.
- **Pictures of a hosted window with a web view:** `cacheDisplay` does not capture `WKWebView` (out of process);
  composite `WKWebView.takeSnapshot` into the bitmap at the web view's frame.

## From the GenesisKit markdown viewer, second pass (2026-10-13 18:18)

- **A page in a window that is never shown is a hidden page: it gets no `requestAnimationFrame`.** pierre (the diff
  page) lays a changed diff out in an animation frame, so a hosted test saw `setOptions({diffStyle})` do nothing and
  "reproduced" a bug that the visible app does not have. `document.visibilityState` reads `hidden` in a borderless
  window, in an alpha-0 window below the desktop, and with WebKit's window-occlusion detection turned off. Check
  `visibilityState` and a probe `requestAnimationFrame` before you trust a page test; to test frame-driven work, add a
  `WKUserScript` at document start that maps `requestAnimationFrame` to `setTimeout(…, 16)`, then `reload()` (the
  renderers here send their state again on the page's `ready`). `GitDiffViewLayoutTests` does this.
- **A control drawn inside a list's frame is "inside the list" for a local event monitor.** The transcript's
  "N new" pill sits in the list's overlay, so its own click counted as the reader's click, and for 1.5 s every
  growth was treated as the reader's own and never followed: the glide stopped short of the end. A control that moves
  the viewport on the reader's behalf clears that state itself (`TranscriptScrollAnchor.scrollToEnd`).
- **`.instantTooltip` on every row of a dense list puts one AppKit hover view (a tracking area) on every row.**
  Scrolling a `LazyVStack` then creates and drops one per row. Rows that show their own text take `.help` (the system
  tooltip, no view); `instantTooltip` stays for icon buttons and controls.
- **An `@Published` assignment publishes even when the value does not change.** `select(id)` set ten properties
  and published ten times per tab switch, each re-running every observer. Assign only what changes
  (`if x != nil { x = nil }`): 10 → 3 publishes, measured with `RenderProbe.watch`.
- **`NSString` path helpers are slow on non-ASCII paths.** `deletingLastPathComponent` returns `NSPathStore2`
  strings that hash and compare through Unicode normalization one character at a time; a fold over 3,416 Czech
  vault paths spent most of its samples there. Slice `Substring` at the last `/` instead.
- **Swift 6 `@MainActor` class + `DispatchQueue.main.async { self… }` compiles only because the package is in Swift 5
  mode** (`swift-tools-version: 5.9`). New async hops in GenesisKit follow the file's existing pattern; do not mix
  `Task.detached` and GCD in one model.

## From the GenesisKit markdown viewer's file tree (2026-10-15 19:15)

- **`NSTableView` swallows clicks meant for SwiftUI buttons in its cells** until `validateProposedFirstResponder(_:for:)`
  returns `true`.
- **An `NSTableView` of hosted SwiftUI cells hides its rows from accessibility search** unless
  `accessibilityChildren` returns `NSAccessibility.unignoredChildren(from:)` of the on-screen cells. Raw row views or
  ignored `NSView`s make the rows vanish; all rows made an AX search take 3.6 to 4.1 s.
- **A right-click on an AppKit view laid over a SwiftUI root never reaches SwiftUI's `.contextMenu`.** AppKit sends an
  unhandled right-click up the clicked view's superviews only, and an overlay's superviews are AppKit's. Asking the
  root's `menu(for:)` returns nil, and a slot that declines the hit test hands SwiftUI a point over its placeholder,
  which opens nothing. What works: the overlay ends at its content, and a view inside the root (the slot) takes the
  rest of the hit and returns no menu, so AppKit walks up to the SwiftUI host.
- **A window whose content view is an AppKit container gives its first focus to the first view in the key-view loop**
  that accepts it. Here that was a sidebar divider: a blue focus ring the height of the window, and arrow keys that
  resized the sidebar. Gate such controls on keyboard navigation (`NSApp.isFullKeyboardAccessEnabled`) and draw focus
  as an accent line, not a ring.
- **Every file is not text.** A viewer that loads documents with `String(contentsOf:encoding: .utf8)` and treats a
  failure as "missing" shows "File is gone" for a PNG that exists. Check `fileExists` before calling a file missing.
- **A stuck window (clicks do nothing, AX presses work) after a held press:** `isMovableByWindowBackground` made the
  hosting view's whole area a window drag, which kept the mouse-up. Turn it off for windows with SwiftUI controls.
- **Proving a context menu:** `tools control` right-clicks are window events and open no SwiftUI context menu, and
  `AXShowMenu` on a SwiftUI button timed out (2026-10-15, being fixed in tools control). In a scratch app, send a
  real `rightMouseDown` through `NSWindow.sendEvent` and read the menu on `NSMenu.didBeginTrackingNotification`, then
  `cancelTrackingWithoutAnimation()`.
- **`git checkout --theirs <file>` takes the other side's whole file**, dropping this side's hunks that did not
  conflict. For "theirs wins only in conflicts" use `git merge-file --theirs ours base theirs`.
- **Restoring a table's scroll offset in the same pass as new rows puts it back at the top.** The tree's
  `onChange(of: rows)` ran before `updateNSView` handed the table its rows, and the reload landed at offset 0. Set the
  offset one run-loop turn later and check it again a moment after (`MarkdownFileTreeView.applyPendingPlaceScroll`).
- **A context menu opened by automation closes within seconds if nothing picks an item.** Run the right-click,
  `see --scope menu` and the press back-to-back (tools control #530, 2026-10-15).
## ScreenCaptureKit recording — 2026-10-14 03:33

- **replayd (ScreenCaptureKit's daemon) groups its clients by executable PATH.** When any process started from a path
  exits, every live stream of every other process from that same path stops with -3805 (connection interrupted). It
  fires at the second process's exit, not at its `stopCapture`, and also when that process only listed windows. Two
  `tools control capture record` runs therefore cut each other short until each recorder re-ran from its own disk
  clone (8648526b3 on #502, `native/ax-tool/SnapshotSupport/RecorderExecutable.swift`). A hard link to the same file
  is not a fix: it made `stopCapture` hang. A 40-line probe without ax-tool reproduced it 7 of 7 from one path and
  0 of 6 from a copy.
- **`SCStreamFrameInfo.contentRect` is in points, the frame's pixel buffer is in pixels.** Using the rect as pixels
  crops a Retina frame to its top-left quarter and scales that up 2x. Multiply by `scaleFactor` (from the same info
  dictionary) before cropping.
- **A sheet's window stream holds its whole parent window, shrunk to the sheet's size** (a 400x560 sheet arrived as
  the 440x760 parent at 0.737). Painting it into the sheet's frame draws a second, smaller parent. When the parent is
  also recorded, its own stream already shows the sheet; when the sheet is recorded alone, cut it out of the parent at
  the sheet's frame (dd532721a).

## A window's content sizes the whole tree on every update — 2026-10-14 16:35

- `window.contentView = NSHostingView(rootView:)` keeps the default `sizingOptions`, so every SwiftUI update makes
  AppKit ask the hosting view for its min, max and intrinsic size, and SwiftUI lays out every subview to answer. In the
  markdown viewer that was 59% of the main thread's layout for one changed string, and 600 to 1200 ms stalls on a click
  with 24 tabs. Set `sizingOptions = []` and the window's `minSize` (performance.md, third markdown pass).
- **`String.count` walks every character.** A path loop that compares `folder.count > root.count` at each level of
  each entry is quadratic in path length and slower still on accented names (grapheme breaking). Compare
  `utf8.count`, cut at a `/` found in the UTF-8 view, and compute fixed lengths once (2026-10-14, git tree marks:
  117 → 31 ms per call).

## Window moves, plants that pass, and tests that touch the system — 2026-10-14 22:41

- **A programmatic `setFrame(_:display:)` posts no move notification inside the call.** A flag set around the call
  (`placing = true; setFrame…; placing = false`) to tell your own moves from the user's drag guards nothing: the
  `didMoveNotification` of your own move can come later, when the flag is already off. Remember the frame you placed
  and treat a move as the user's only when the window is more than a point away from it (AppKit rounds the origin to
  whole pixels, and a centred default can sit on a half point). The draggable posture message, ba3f99f4c.
- **A plant that passes is a finding, not a formality.** Removing that flag broke no test, and the probe behind it
  showed the flag never worked. When a planted regression passes, find out whether the test is weak or the code is
  dead before you move on.
- **A test that calls a helper directly cannot catch the removal of its call site.** `trustedJoints` was tested as a
  static function, so deleting the one line in `process` that applies it passed every test (#514, afbf2ebd6). Test
  through the path that runs it, or say in the review that the call site is covered by reading only.
- **SwiftUI `onChange` can miss a change the body already saw.** A tab click changed the value and re-ran the body,
  and no `onChange` followed, so the old tab's page stayed on screen (ca64b32e0). Let the body start the work for a
  value that is neither current nor pending instead of driving it from `onChange` alone.
- **Never start an executable a test just made and then rename or delete it.** macOS scans every new executable in
  `syspolicyd` after it starts; a scan that finds the file gone crashed `syspolicyd` five times in ten minutes, launchd
  stopped restarting it, a permission check never answered, and the WindowServer watchdog froze the Mac (2026-10-14
  20:06). Build a test program once and keep it (`src/utils/test/persistent-fixture.ts`), and check that `syspolicyd`
  keeps its pid (`pgrep -x syspolicyd`) across the first run of such a test.
- **A new command-line flag needs a test through the parser that runs live.** `act --allow-outside` passed 13
  event-factory tests and failed at its first live call: ax-tool keeps a list of flags per command
  (`WorkflowArguments.swift`), and the new flag was not on it, so it was refused as unknown before anything ran
  (85d5d6967, fixed in 586f5b391). Add one parse test per new flag, and prove the path with a call that cannot
  dispatch (an invalid snapshot token must be the refusal, not the flag).
- **`UserDefaults(suiteName:)` in a test writes a real plist** in `~/Library/Preferences`. `removePersistentDomain`
  empties it but leaves a 42-byte file. Give test suites one prefix (`genesiskit-tests-…`) and remove them in a
  teardown block (9a11d77bd).

## Dialogs: modal loops, title bar insets, cut text — 2026-10-15 00:50

- **`NSAlert.runModal()` inside a `DispatchQueue.main` block stops every timer queued on the main queue.** The
  queue is serial and busy with the block that runs the modal loop, so `DispatchQueue.main.asyncAfter` never
  fires until the alert closes. The vault and account approval windows had a 170 s "deny by itself" deadline that
  never ran; the caller's own 180 s timeout killed the window with no audit line, and the caller asked again. Fix:
  a non-modal panel (GenesisKit `ApprovalPanelPresenter`) and the deadline as a cancellable `DispatchWorkItem`.
- **`NSHostingController` in a `.fullSizeContentView` window insets its content by the hidden title bar.** The
  first approval panel had an empty 28 pt band on top. `.ignoresSafeArea()` on the root view; the strip still
  drags through `.titlebarZone()`. `controller.sizingOptions = [.preferredContentSize]` makes the panel follow the
  view, so a disclosure grows and shrinks it.
- **A `Text` in a `Grid` cut a path in the middle at one line while the window had room for two.** The grid measured
  the row once at one line. `.fixedSize(horizontal: false, vertical: true)` with the `lineLimit` you want.
- **Five controls in one row of a 480 pt dialog cut the default button's title** ("Allow with…") and wrapped a
  countdown. Give a choice (a remember picker) its own row; `.fixedSize()` on the default button and the countdown.
- **Render a dialog for review without showing it:** `NSHostingView` in a borderless `NSWindow` that is never ordered
  front, then `cacheDisplay(in:to:)`. Unlike `ImageRenderer`, it draws AppKit-backed controls (buttons, pop-up
  menus). `VaultUnlockTests.testRenderTheVaultWindowWhenAsked` does it behind `APPROVAL_SNAPSHOT_DIR`.

## Dead clicks and accessibility cost in a big SwiftUI window — 2026-10-15 01:07

- **Log presses and actions, not just presses.** To diagnose "clicks do nothing", override the window's
  `sendEvent` and log every left down and up with the hit view, `clickCount`, key, active, modal and sheet state, and
  log the action each control runs. A press with no action after it is a click SwiftUI dropped; a press that never
  arrives is a window or event-routing problem (markdown viewer: f7eaab043, 5c8691e5b).
- **One click handler per control.** A `Button` with an `.onTapGesture` on the same view, under a parent
  `.onTapGesture(count: 2)`, gives SwiftUI three gestures to arbitrate for one click; the viewer's tabs had exactly
  that when its clicks went dead with 100 tabs (cause not proven).
- **Accessibility hit tests scale with the number of views.** With 100 tabs (about 880 accessibility elements), one
  `NSHostingView.accessibilityHitTest` from an outside AX client held the main thread 785 ms (HangWatch stack,
  2026-10-15 00:08). Every AX client (window managers, `tools control see`) pays it. Keep long strips lazy or capped.

## SwiftUI rows in tests, a tree's stale listings, and far scrolls — 2026-10-15 06:35

- **In-process accessibility cannot see SwiftUI list rows.** `accessibilityChildren()` walked from the list's
  `NSScrollView` never reaches them, and an xctest process has no accessibility windows (`tools control see --app
  <xctest pid>` answers "no AX windows"). To check which rows are on screen, render the scroll view
  (`cacheDisplay(in:to:)`) and read it with Vision (`TreeDrawnText` in GenesisKitTests). A narrow column cuts a name
  in the middle ("2026-10-15-…osals.sol3.md"): match its two ends.
- **A test can show the real window for a recording without taking focus.** `orderFrontRegardless()` from xctest
  never activates; write `window.windowNumber` to a file and run `tools control capture record --window-ids <n>`
  (`MarkdownSidebarRevealDemoTests`). The same test on the old and the new code gives a before and after video.
- **A file tree that caches folder listings must watch them.** Without a watcher a folder stays as its first read
  showed it. A note another app wrote later had no row, so "Show in Sidebar" found nothing and did nothing, silently
  (2026-10-15, note written 05:30:49, reveal 05:33:14). One FSEvents stream over the root; re-read only folders
  already listed, off the main thread, and rebuild only when the listing changed. A reveal also re-reads a folder
  whose listing lacks the file.
- **An animated `scrollTo` to a far row of a `LazyVStack` does not glide.** Recorded at 15 fps: it lands on an
  estimate, waits about half a second, then jumps to the row. `NSClipView.animator().setBoundsOrigin` on a SwiftUI
  `ScrollView` did not animate at all, and a position computed from the row index overshot. What works: scroll
  without animation so the row sits at the nearer edge (`Transaction.disablesAnimations`), wait a moment for the
  list to lay it out, then animate the last stretch to the centre.
- **Driving a background app's context menu with `tools control` is not safe yet.** `AXShowMenu` on a SwiftUI tab
  blocked 2 s and opened the parent's menu first; the menu rows were not in `see --scope menu`; a coordinate click
  into the open menu closed it without choosing. Trigger the code path from a test instead.

## Row-only controls with popovers, key modifiers, shared builds — 2026-10-23 15:17

- **A control that exists only on the hovered row must keep its popover open after the pointer leaves.** The
  popover's `isPresented` lives in the control; remove the control on hover-out and SwiftUI closes the popover.
  Keep the `.popover` modifier on a same-size `Color.clear` placeholder while the row is not live, and treat "popover
  open" as live (`WidgetCmuxButton(live:)`, GenesisKit Widgets). Hover is the row's, not the control's: a hover
  sensor on the button covers only the button (`WidgetHoverRow { hovering in … }`).
- **A popover from an edge panel needs its own "dialog open" flag.** Setting the host's shared `dialogOpen` from the
  popover's `onChange` can release a window the host opened when the popover closes. One flag per presenter, ORed
  into the getter (`sessionChooserOpen`, `cmuxPopoverOpen`).
- **`.onKeyPress(.downArrow) { … }` has no key press to read.** Its closure takes no argument; to read Shift use
  `.onKeyPress(.downArrow, phases: [.down, .repeat]) { press in press.modifiers.contains(.shift) }`. A click's
  modifiers come from `NSEvent.modifierFlags` inside the button action.
- **"input file … was modified during the build" is another session editing GenesisKit**, not your code. Rerun the
  build through `.claude/skills/babysit/scripts/swift-slot.ts`; do not stash or touch their file.

## A whole window ignores clicks after one exception in an action — 2026-10-23 16:58

- **`NSEvent.clickCount` raises for any event that is not a mouse click.** It is an Objective-C exception
  (`NSInternalInconsistencyException`), not a Swift error, and `NSApp.currentEvent` inside a SwiftUI button action is
  not always a mouse event: a key press, an accessibility press or a system-defined event can be current. The raise
  unwound through SwiftUI's event dispatch and left the Genesis Markdown window ignoring every click, tab bar and
  sidebar included, until relaunch (2026-10-23 16:36, the tab group chip's double-click check). Read the count through
  GenesisKit `MouseClick.current` or `MouseClick.count(of:)`, which checks the event type first. lint-rules
  `swift-current-event-click-count` fails `currentEvent?.clickCount`. Inside `mouseDown(with:)` or a monitor
  filtered to mouse types, `event.clickCount` is safe.
- **When "nothing is clickable", read the app's unified log for an exception first.** `command log show --predicate
  'processID == <pid>' --last 10m | rg -i "exception|raise|terminat"` found the line in one query; hit tests, AX
  walks and layout theories had found nothing.
- **A test window's synthesized click always makes a mouse event current.** `NSApp.postEvent` down and up gives the
  action a real `leftMouseUp`, so a test can never reproduce a crash that needs a key or AX event as the current
  one. A unit test of the reader with a key event (`NSEvent.keyEvent(...)`) covers it; a passing click test does not.
- **An AX hit test over a `WKWebView` names the web area, not the view on top.** `tools control hittest` at a tab
  that sat above the page reported `AXWebArea` (the web document's rect), while real clicks reached the tab. Judge
  delivery by the app's own action log, never by the AX hit test.
- **A hidden test window has no accessibility tree, so find click targets with `FrameProbe`.** GenesisKit
  `.frameProbe("name")` records a view's window frame only while `FrameProbe.enabled` (a test sets it); click the
  centre of `FrameProbe.frames["name"]`. Never scan a grid of clicks to find a target: the scan pressed the toolbar's
  Obsidian and Editor buttons and opened dialogs and editor tabs in the user's real apps.

## Trigger animations, and loops no stall detector sees — 2026-10-23 17:47

- **An animation started from `onChange(of: trigger)` never plays in a view built after the change.** The widget's
  hover list was opened by the same alert that bumped the flash counter, so its rows started with the new value and
  did not flash. Pass the start time too and play the rest on appear (`AttentionPulse(since:)`).
- **A SwiftUI update loop never delays a main-queue ping.** Each pass returns to the run loop, so a queue-latency
  watchdog reports nothing while the app burns a whole core (the widget, 2026-10-23 17:10, three minutes, no
  log line). Read the main thread's CPU time instead: `thread_info(THREAD_BASIC_INFO)` on the port from
  `mach_thread_self()` taken on the main thread (`HangWatch.SpinTracker`, `main-spin` lines).
- **Read a spin's sample for who schedules the next pass.** Inside the transaction, look for
  `asyncTransaction` callers: `LazyLayoutViewCache.signalPrefetch` (a lazy stack that never settles) and
  `EventBindingManager.enqueueHoverUpdateIfNeeded` (hover re-checked after every update) were the two in the widget's.
- **A test process has no `NSApp` until something makes one.** `NSApp.postEvent` or `nextEvent` then crashes
  with "unexpectedly found nil" on the line that reads `NSApp`; call `_ = NSApplication.shared` first.
- **A window resize lays SwiftUI out synchronously, and content can call back into its controller from there.** The
  edge panel moved its window in `begin`, the hover list measured itself in that layout and asked for its real size,
  and the nested request started a reshape that `begin` then overwrote with its own transition: the panel kept the
  estimate (336 instead of 489 pt). Defer a request made while a transition is being set up, and run the latest one
  after it (`EdgePanelController.applyingPresentation`).
- **A `CADisplayLink` keeps a strong reference to its target.** A ticker held only by a struct that gets overwritten
  never deinitialises and fires every frame for the life of the process. Stop it wherever the owner is replaced (a
  `didSet` on the property), and count live ones for a test (`EdgeFrameTicker.live`). Find them in a sample of the
  idle app: `EdgeFrameTicker.step` under `CA::Display::DisplayLink` with nothing animating.

## Hangs that reached the user on 2026-10-23, and why they got through — 2026-10-23 21:13

- **A face that does not start `HangWatch` reports nothing.** Only the hub, the review window and the link relay
  called `HangWatch.start()`; the widget, the markdown viewer and the settings window (which hosts Clicky) never did.
  So the spin detector added at 17:57 could not see the widget spin at 20:14, and the settings window's key-sound
  stalls were invisible. Every face's entry point starts it now (94cf0dd8f4). Check a new face: `rg -n
  'HangWatch.start' src/macos` must list it.
- **A guess is not a fix.** The 17:11 widget hang was blamed on leaked display links at 55% and called fixed. The
  20:14 sample had the same signature as the 17:11 one (`NSRunLoop.flushObservers → NSHostingView.beginTransaction →
  GraphHost.runTransaction`, `LazySubviewPlacements.placeSubviews`, no display link). Compare a new sample's
  signature with the old one's before you call a hang fixed, and keep every sample in scratch.
- **A layout loop with no body updates.** In the widget's inbox list the main thread re-ran layout on every
  run-loop pass while no view body was evaluated (RenderProbe counted only a clock tick). A replay of the real
  snapshot in a hidden window (`WidgetScrollReplayTests`, env-gated) reproduced it at some scroll offsets (700 to
  2000 passes per 0.5 s) and not at others, and with a plain `VStack` too, so neither the lazy stack nor the
  overflow fade nor the fit measurement alone is the cause. The root cause is still open; what ships is the
  breaker: `HangWatch.onSpin` closes the widget panel after a 5 s spin and says why.
- **Do not measure the whole scroll content to learn two edges.** A background `GeometryReader` or
  `onGeometryChange` on a scroll view's content lays out every row of a lazy list on each pass. On macOS 15 and
  later read `onScrollGeometryChange` (`visibleRect`, `contentSize`) instead (`ScrollOverflowHints`,
  `DocumentHeight` in LiveWidgetView).
- **Never start audio hardware on the main thread, least of all inside an event tap.** Clicky stopped its
  `AVAudioEngine` after 3 s idle and started it again inside the keyboard tap's callback: 360 ms to 1 s per start
  while the output device was slow, every typing pause, and a tap that waits delays every key in every app. Start it
  on its own queue and play the first click when it runs; keep the synchronous start only for offline rendering in
  tests (`isInManualRenderingMode`).

## A button that works once, and pictures that come out white — 2026-10-23 22:44

- **A SwiftUI button whose label has no hit-testable pixel ignores the click, with no error.** The widget's rail
  bubble put its count under `.allowsHitTesting(false)`, and its only background was a fill whose opacity was 0.07
  while the attention ring showed and 0 after it. SwiftUI does not hit-test a view at opacity 0 (nor `Color.clear`),
  so the first click worked (the ring showed) and every click after it fell through, hover too. AppKit still
  delivered the click to the hosting view (`mouseDown` logged, `tools control hittest` named the button), which made
  it look like an event problem. Fix: `.contentShape(Circle())` (or the control's shape) on any control whose label
  can become fully transparent. Test with a click at the control's edge, off its glyph (`WidgetBubbleHitTests`).
- **`cacheDisplay(in:to:)` and `CALayer.render(in:)` leave out SwiftUI materials and layer-drawn backgrounds.** A
  dark panel came out with its white text on white, and filling the bitmap dark first did not help. Use the window
  server's picture instead: `screencapture -x -o -l <windowNumber>` of the test window. The window must not be
  occluded (below the desktop it is never drawn), so show it at alpha 0.02 above the others with
  `ignoresMouseEvents`, then drop the alpha channel of the capture: the colours are stored unassociated, so the
  opaque copy is the panel as it looks on screen (`WidgetScrollReplayTests`, `GENESIS_WIDGET_REPLAY_PNG`).
- **A reused `NSHostingView` with `sizingOptions = []` measures 0x0 after a new root view once it has been on screen.**
  The recording picker set `hosting.rootView`, called `layoutSubtreeIfNeeded()` and sized its panel from
  `fittingSize`: right the first time, 0x1 on every later opening, and `onGeometryChange` never fired to repair it
  because the content's size had not changed. Make a fresh hosting view per presentation, or size from the view.
- **`tools control click` (an accessibility press) on a SwiftUI control sometimes does nothing on the first try.** In the
  live widget, the video button, Decisions tab and Stop and discard each needed a second press now and then. Check the
  effect after each press (a window appears, a value changes) and press again; never read one silent press as a broken
  control, and never as a working one.
- **A window per item stalls the main thread.** The recording outline made one borderless `NSPanel` per listed window
  up front (76 windows) so their ids could be excluded from the movie: 1.6 s of main thread at the recording start
  (hang stack: `RecordingTargetOutline.init`). One clear panel per display that draws every rect on it costs two or
  three windows. Read the `main-stall` stack after the first live run of any code that creates windows.
- **Under Bun, an abandoned child keeps the process alive three ways.** A cancelled caller of a detached build exited
  only when the build ended (20 s) until it unref'd the child, its stdout pipe and the build's deadline timer; the
  child alone was not enough (probe: 4 s with the child unref'd, 0.03 s with the pipe too).
- **SwiftUI does not hit-test Liquid Glass.** A view whose only background is `.glassEffect(in: shape)` takes taps and
  hover only on its opaque content: between two rows, or on the blank part of a card, a tap reaches nothing and
  `.onHover` reports false (scratch probe, 2026-10-24: row TAP, gap none, blank none; solid fill TAP everywhere). The
  window server still owns those points (`SLSFindWindowAndOwner` names the window), so the window is not
  click-through, and a hit test through AppKit looks fine. Add `.contentShape(shape)` after the glass. A window with a
  clear background does pass alpha-0 pixels through; `ignoresMouseEvents = false`, set explicitly, makes it take them.
  Synthetic `mouseMoved` events do not drive SwiftUI hover, so test the hit region with a click (`WidgetBubbleHitTests`).
- **Correction (2026-10-24 19:43): the hit-test gap above is real, but it was not why the widget's hover list closed.** Inside a
  ScrollView a gap between rows is hit-tested under plain glass, so the list's gaps were never the hole. SwiftUI's
  `.onHover` on the panel still reported "left" while the pointer sat on it during a scroll. A window-level "pointer
  inside" now comes from an `NSTrackingArea` on the window's root view (`.mouseEnteredAndExited`, `.activeAlways`,
  `.inVisibleRect`); SwiftUI hover only logs disagreements.
- **One process per item, on every refresh, is a storm.** A model per open document that spawns its own child on each
  repository change multiplies: Genesis Markdown ran 51 to 66 `tools agents blame` at once (each a full app launch),
  plus one `git rev-parse` per note. Queue such work per shared resource (one run for every item that asked, one run
  in flight, the next after it) and cache what is per folder. GenesisKit's launchers count starts (`SpawnMeter`), so
  the next one shows up as `spawn.storm` in the perf log.
