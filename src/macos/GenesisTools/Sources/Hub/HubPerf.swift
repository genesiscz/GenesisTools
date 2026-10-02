import Foundation
import os

/// Spans for the hub and review window, on top of GenesisKit's `PerfLog` (Perf/PerfLog.swift).
/// Every load that can be slow (a `tools` call, git, a transcript page, a diff render) runs inside a
/// span. Lines land in `~/.genesis-tools/logs/app-perf.log`:
///
///     [05:02:11.412] hub.repoFacts 142.3ms
///     [05:02:11.412] mark hub.repoFacts SLOW 142.3ms bg: 3 paths pr=false
///     [05:02:12.020] hub.review.render.main 18.2ms
///
/// A `.main` suffix means the span ran on the main thread, where anything over a frame (16 ms) is
/// visible jank. Spans at or over `slowMs` add a `SLOW` mark with their detail. Spans are also
/// os_signpost intervals ("hub", Points of Interest) for Instruments.
/// Summary: `bun src/macos/GenesisTools/scripts/perf-report.ts`. Off: `GENESIS_TOOLS_PERF=0`.
enum HubPerf {
    static let slowMs = 100.0

    private static let signposter = OSSignposter(subsystem: "com.genesiscz.genesistools", category: .pointsOfInterest)

    struct Span {
        fileprivate let label: String
        fileprivate let detail: String
        fileprivate let start: CFAbsoluteTime?
        fileprivate let onMain: Bool
        fileprivate let state: OSSignpostIntervalState?

        /// Ends the span; `extra` joins the detail of a SLOW mark (a count, "failed").
        func end(_ extra: String = "") {
            guard let start else { return }
            if let state { HubPerf.signposter.endInterval("hub", state) }
            let name = "hub.\(label)\(onMain ? ".main" : "")"
            PerfLog.since(name, start)
            let ms = (CFAbsoluteTimeGetCurrent() - start) * 1000
            if ms >= HubPerf.slowMs {
                let note = [detail, extra].filter { !$0.isEmpty }.joined(separator: " ")
                PerfLog.mark(String(format: "hub.%@ SLOW %.1fms %@%@", label, ms, onMain ? "main" : "off-main", note.isEmpty ? "" : ": " + note))
            }
        }
    }

    /// `awaits: true` for a span that crosses an `await`: its wall time is waiting, not main-thread
    /// work, so it never gets the `.main` suffix even when it started on the main actor.
    static func begin(_ label: String, _ detail: String = "", awaits: Bool = false) -> Span {
        guard PerfLog.enabled else {
            return Span(label: label, detail: detail, start: nil, onMain: false, state: nil)
        }
        let state = signposter.beginInterval("hub", id: signposter.makeSignpostID(), "\(label, privacy: .public)")
        return Span(label: label, detail: detail, start: CFAbsoluteTimeGetCurrent(), onMain: !awaits && Thread.isMainThread, state: state)
    }

    @discardableResult
    static func measure<T>(_ label: String, _ detail: String = "", _ body: () throws -> T) rethrows -> T {
        let span = begin(label, detail)
        defer { span.end() }
        return try body()
    }

    /// A point in time: "review.renderer ready", "repoFacts failed: …".
    static func log(_ text: String) {
        PerfLog.mark("hub.\(text)")
    }
}

/// Main-thread busy time after an event: the run loop's awake time (after-waiting to before-waiting)
/// summed over `window` seconds, then one line in app-perf.log. It includes anything else the main
/// thread did in that window, so it is an upper bound; an idle window measures the floor.
@MainActor
enum HubMainBusy {
    private final class Meter {
        var busy: CFAbsoluteTime = 0
        var wokeAt: CFAbsoluteTime?
    }

    /// Labels with a window open: the same event again inside it (a keystroke in a filter) joins that
    /// window instead of logging a line per keystroke.
    private static var open = Set<String>()

    static func measure(_ label: String, window: TimeInterval = 0.6) {
        guard open.insert(label).inserted else { return }
        // Counted from here: the bodies this render evaluated (`GENESIS_RENDER_PROBE=1`). A snapshot, not
        // a reset: another window open at the same time keeps its own counts.
        let bodies = RenderProbe.snapshot()
        let meter = Meter()
        meter.wokeAt = CFAbsoluteTimeGetCurrent()
        let wake = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { _, _ in
            meter.wokeAt = CFAbsoluteTimeGetCurrent()
        }
        let sleep = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { _, _ in
            if let woke = meter.wokeAt {
                meter.busy += CFAbsoluteTimeGetCurrent() - woke
                meter.wokeAt = nil
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), wake, .commonModes)
        CFRunLoopAddObserver(CFRunLoopGetMain(), sleep, .commonModes)
        DispatchQueue.main.asyncAfter(deadline: .now() + window) {
            if let woke = meter.wokeAt {
                meter.busy += CFAbsoluteTimeGetCurrent() - woke
            }
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), wake, .commonModes)
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), sleep, .commonModes)
            open.remove(label)
            HubPerf.log(String(format: "%@ main busy %.1f ms of %.0f ms", label, meter.busy * 1000, window * 1000) + RenderProbe.summary(since: bodies))
        }
    }

    /// The main thread's busy time from now until it settles, for work whose cost runs past any fixed
    /// window (a transcript's first page drew for 600 ms and more, and `measure` cut it off there). Settled:
    /// under `quietMs` of busy time in each of three 100 ms checks in a row; at most `cap` seconds. One line:
    /// `<label> main busy <ms>, settled after <ms>: <detail()>`, `detail` read at the end.
    static func measureUntilSettled(_ label: String, cap: TimeInterval = 10, quietMs: Double = 8, detail: @escaping () -> String) {
        guard PerfLog.enabled, open.insert(label).inserted else { return }
        let bodies = RenderProbe.snapshot()
        let meter = Meter()
        let start = CFAbsoluteTimeGetCurrent()
        meter.wokeAt = start
        let wake = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { _, _ in
            meter.wokeAt = CFAbsoluteTimeGetCurrent()
        }
        let sleep = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { _, _ in
            if let woke = meter.wokeAt {
                meter.busy += CFAbsoluteTimeGetCurrent() - woke
                meter.wokeAt = nil
            }
        }
        CFRunLoopAddObserver(CFRunLoopGetMain(), wake, .commonModes)
        CFRunLoopAddObserver(CFRunLoopGetMain(), sleep, .commonModes)
        var last = 0.0
        var quiet = 0
        var lastBusyAt = start
        func check() {
            let now = CFAbsoluteTimeGetCurrent()
            // The run loop pass this check runs in is not in `busy` until its before-waiting: counted up to
            // now here. `total` only grows, so the next step takes only what came after.
            let total = meter.busy + (meter.wokeAt.map { now - $0 } ?? 0)
            let step = (total - last) * 1000
            last = total
            if step >= quietMs {
                quiet = 0
                lastBusyAt = now
            } else {
                quiet += 1
            }
            guard quiet >= 3 || now - start >= cap else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { check() }
                return
            }
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), wake, .commonModes)
            CFRunLoopRemoveObserver(CFRunLoopGetMain(), sleep, .commonModes)
            open.remove(label)
            let capped = quiet < 3 ? " (cap)" : ""
            HubPerf.log(String(format: "%@ main busy %.1f ms, settled after %.0f ms%@: %@", label, total * 1000, (lastBusyAt - start) * 1000, capped, detail()) + RenderProbe.summary(since: bodies))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { check() }
    }
}

/// `GENESIS_HUB_STALL_TEST=<ms>`: blocks the main thread once, 3 s after launch, in a frame with a
/// known name, so a run proves the stall capture end to end (the stack file must name `block(ms:)`).
enum HubStallTest {
    @MainActor
    static func scheduleIfRequested() {
        guard let raw = ProcessInfo.processInfo.environment["GENESIS_HUB_STALL_TEST"], let ms = Double(raw), ms > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { block(ms: ms) }
    }

    @inline(never)
    static func block(ms: Double) {
        let end = CFAbsoluteTimeGetCurrent() + ms / 1000
        var spins = 0
        while CFAbsoluteTimeGetCurrent() < end {
            spins &+= 1
        }
        PerfLog.mark("stall test: blocked the main thread \(Int(ms)) ms (\(spins) spins)")
    }
}
