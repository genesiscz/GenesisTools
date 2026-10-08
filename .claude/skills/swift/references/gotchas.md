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

## SwiftUI / AppKit

- **`repeatForever` = per-frame layout of the window.** See performance.md; use a layer animation.
- **`withAnimation` around a first load** animates every row; skip it when nothing was on screen.
- **`Process.waitUntilExit()` inside a body** spins the run loop and can double-free StackLayout
  (crash). Load in a store on a background queue (CLAUDE.md of the app).
- **A layer loses its animations when its view leaves the window.** Re-add them in `viewDidMoveToWindow`.
- **CA coordinate space:** an `NSView` layer has y up. `addArc(clockwise: true)` from angle 0 and a
  rotation to `-2π` look clockwise on screen, matching SwiftUI's `Circle().trim` + positive degrees.
- **A SwiftUI `List` viewport moved inside a row insert's resize** stops AppKit re-measuring rows (see
  the app CLAUDE.md, `TranscriptScrollAnchor.remeasureVisibleRows`).

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
