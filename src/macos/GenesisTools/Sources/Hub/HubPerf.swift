import Foundation
import os

/// Spans for the hub and review window, on top of the stolen `PerfLog` (Hub/Stolen/UI/PerfLog.swift).
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

    static func measure(_ label: String, window: TimeInterval = 0.6) {
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
            HubPerf.log(String(format: "%@ main busy %.1f ms of %.0f ms", label, meter.busy * 1000, window * 1000))
        }
    }
}
