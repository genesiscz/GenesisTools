# Measuring the app and the CLI behind it

Pick the instrument by the question. Every number in a fix report should name the instrument it came from.

## 1. `tools hub dev monitor` — what is going wrong right now

```bash
tools hub dev monitor --min-delay-ms 30000          # under the Monitor tool, timeout 1800000, re-arm on expiry
tools hub dev monitor --from-start --min-stall-ms 1000 --min-profile-ms 500   # replay today first
```

Sources and event kinds (src/hub/lib/dev-monitor.ts):
- `app-perf.log`: `wedge`, `hang` (with the hang/stack file), `stall` (≥ 500 ms), `layout-loop`,
  `slow-main` (main-thread spans and `main busy` windows ≥ 400 ms), `jank` (frame drops), `error`.
- the day's profiling log: `slow` = any CLI timer ≥ 1 s, collapsed per batch as `×N, max …`, with
  `[pid N <tool verbs>]`. A `[profile:cli]` whole-run line counts by CPU unless `caller=app`
  (then wall time: the app waits on it). A long-lived server is never reported for its lifetime.
- link-relay journal problems, new hang files without a log line, new `Genesis*` crash reports.

Read the named file before anything else. Several processes write `app-perf.log`; a bench run's lines
look exactly like the live hub's (`since-launch` phases and `hub.bench` marks tell them apart).

## 2. Process CPU over a window — "it uses 40%"

`ps %cpu` is a decaying average and `top` one snapshot; neither attributes a process tree. Sum CPU-time
deltas of a root and its children (short-lived children between samples may be missed), e.g. a 30-line Bun script
polling `ps -Ao pid=,ppid=,time=,command=` every 500 ms. Measure 30-120 s; say what the user and the
agents were doing meanwhile. Activity Monitor's "GenesisTools" can be `GenesisTools Preview`
(the widget preview) or any `tools` child, because the launcher owns them.

## 3. `sample` — which code

```bash
sample <pid> 10 -file /tmp/cc/<…>/x.sample.txt
```
- The main thread is `Thread_…: Main Thread` (sometimes `DispatchQueue_1: com.apple.main-thread`).
- Busy vs idle: samples under `mach_msg2_trap` inside `RunCurrentEventLoopInMode` are idle.
- App frames have no module prefix: rank with
  `rg -o "^[ +!:|]*([0-9]+) (.+?)  \(in GenesisTools\)" -r '$1|$2'` and sum per symbol. Counts are
  inclusive: a `Layout.placeSubviews` total contains every child placed under it.
- Framework-only time (AttributeGraph, `NSDisplayCycleFlush`, `CA::Transaction::commit` every frame)
  with no app frame on top usually means an animation or a layout invalidation loop, not slow code.

## 4. HubBench — the hub's own views, off screen

```bash
GENESIS_HUB_BENCH_ONLY=open GENESIS_HUB_BENCH_OPEN=<id-prefix>,<id-prefix> GENESIS_HUB_BENCH_AX=1 \
  ~/Applications/GenesisTools.app/Contents/MacOS/GenesisTools --hub --bench /tmp/cc/<…>/b.json --panes transcript,changes
```
Steps: `sidebar`, `files`, `window`, `split`, `fold` (PRs), `activity`, `inbox`, `open`, `panes`.
Always `GENESIS_HUB_BENCH_AX=1` for clicks: transcript open measured 69-128 ms without and 342-367 ms
with an AX client (the live hub had 1.5-1.8 s). Results: the JSON plus `hub.*` lines in app-perf.log.
It runs the installed bundle: `bun run app` first.

## 5. A/B harness — one view technique

When the question is "is view A cheaper than view B", build both in one tiny executable and measure
process CPU time. Template (worked for the ring and the dots, 2026-10-08):

```swift
let window = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 160, height: 220),
                     styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
window.contentView = NSHostingView(rootView: Rows(old: mode == "old"))   // a dozen rows around the view under test
window.level = .floating; window.orderFrontRegardless()                    // never activates
DispatchQueue.main.asyncAfter(deadline: .now() + 25) { exit(0) }
```
`swiftc -O -o ab New.swift main.swift` (no `-parse-as-library` with top-level code), then
`for m in old new old new; do ./ab $m & …; ps -o time= -p $P` at 5 s and 20 s`. Screenshot it with
`tools control screenshot --app <pid>` twice 0.4 s apart to prove the new one still animates.

## 6. CLI profiling — the `tools` side

- On globally: `tools config profiling --json` (enabled, all scopes, file). Lines:
  `[profile:<scope>] <label> [outcome] <dur> trace=<id> pid=<n>`; ≥ 1 s prints as `1.234s`, not ms.
- New timer: `const prof = profiler.scope("<scope>")` + `prof.measure/measureAsync/start`; add the
  scope to `PROFILER_SCOPE_NAMES`. A duration measured elsewhere: `prof.record(label, ms, outcome)`.
- `trace=` joins an app call (`mark call t=<id> … argv=…` in app-perf.log) to its CLI lines.
- For a slow CLI path: `bun --cpu-prof --cpu-prof-dir=<dir> src/<tool>/index.ts …` and rank
  self/total time from the `.cpuprofile` JSON.
