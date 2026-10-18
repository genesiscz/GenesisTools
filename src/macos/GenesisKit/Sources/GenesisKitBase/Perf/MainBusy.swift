//
//  MainBusy.swift
//
//  Main-thread busy time after an event: the run loop's awake time (after-waiting to before-waiting)
//  summed over a window, then one line in the perf file. It includes anything else the main thread did
//  in that window, so it is an upper bound; an idle window measures the floor. A span times work, not the
//  SwiftUI layout it causes: after a state change the renderer runs in the next run-loop passes, and this
//  is what an append or a reload really costs on screen.
//

import Foundation

@MainActor
public enum MainBusy {
    /// Run-loop awake time between `start()` and `stop()`: the sum, the longest single pass (the worst
    /// stall the reader felt) and the number of passes. For benches and tests; the log lines below use it.
    public final class Meter {
        public struct Reading: Sendable, Equatable {
            public var busyMs: Double
            public var longestMs: Double
            public var passes: Int
        }

        private var busy: CFAbsoluteTime = 0
        private var longest: CFAbsoluteTime = 0
        private var passes = 0
        private var wokeAt: CFAbsoluteTime?
        private var wake: CFRunLoopObserver?
        private var sleep: CFRunLoopObserver?

        public init() {}

        /// Counts from now: the pass this runs in counts as awake.
        public func start() {
            guard wake == nil else { return }
            wokeAt = CFAbsoluteTimeGetCurrent()
            let wake = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.afterWaiting.rawValue, true, Int.min) { [weak self] _, _ in
                self?.wokeAt = CFAbsoluteTimeGetCurrent()
            }
            let sleep = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, true, Int.max) { [weak self] _, _ in
                self?.close(at: CFAbsoluteTimeGetCurrent())
            }
            CFRunLoopAddObserver(CFRunLoopGetMain(), wake, .commonModes)
            CFRunLoopAddObserver(CFRunLoopGetMain(), sleep, .commonModes)
            self.wake = wake
            self.sleep = sleep
        }

        /// The total so far, the open pass counted up to now.
        public func read(now: CFAbsoluteTime = CFAbsoluteTimeGetCurrent()) -> Reading {
            let open = wokeAt.map { now - $0 } ?? 0
            return Reading(busyMs: (busy + open) * 1000, longestMs: max(longest, open) * 1000, passes: passes + (wokeAt == nil ? 0 : 1))
        }

        @discardableResult
        public func stop() -> Reading {
            let now = CFAbsoluteTimeGetCurrent()
            close(at: now)
            if let wake { CFRunLoopRemoveObserver(CFRunLoopGetMain(), wake, .commonModes) }
            if let sleep { CFRunLoopRemoveObserver(CFRunLoopGetMain(), sleep, .commonModes) }
            wake = nil
            sleep = nil
            return read(now: now)
        }

        private func close(at now: CFAbsoluteTime) {
            guard let woke = wokeAt else { return }
            let pass = now - woke
            busy += pass
            longest = max(longest, pass)
            passes += 1
            wokeAt = nil
        }
    }

    /// Labels with a window open: the same event again inside it (a keystroke in a filter) joins that
    /// window instead of logging a line per keystroke.
    private static var open = Set<String>()

    /// `<label> main busy <ms> of <window> ms` in the perf file, `window` seconds after now. The label is
    /// written as given (GenesisTools passes `hub.<area>`).
    public static func measure(_ label: String, window: TimeInterval = 0.6) {
        guard open.insert(label).inserted else { return }
        // Counted from here: the bodies this render evaluated (`GENESIS_RENDER_PROBE=1`). A snapshot, not
        // a reset: another window open at the same time keeps its own counts.
        let bodies = RenderProbe.snapshot()
        let meter = Meter()
        meter.start()
        DispatchQueue.main.asyncAfter(deadline: .now() + window) {
            MainActor.assumeIsolated {
                let reading = meter.stop()
                open.remove(label)
                PerfLog.mark(String(format: "%@ main busy %.1f ms of %.0f ms", label, reading.busyMs, window * 1000) + RenderProbe.summary(since: bodies))
            }
        }
    }

    /// The main thread's busy time from now until it settles, for work whose cost runs past any fixed
    /// window (a transcript's first page drew for 600 ms and more, and `measure` cut it off there). Settled:
    /// under `quietMs` of busy time in each of three 100 ms checks in a row; at most `cap` seconds. One line:
    /// `<label> main busy <ms>, settled after <ms>: <detail()>`, `detail` read at the end.
    public static func measureUntilSettled(_ label: String, cap: TimeInterval = 10, quietMs: Double = 8, detail: @escaping () -> String) {
        guard PerfLog.enabled, open.insert(label).inserted else { return }
        let bodies = RenderProbe.snapshot()
        let meter = Meter()
        let start = CFAbsoluteTimeGetCurrent()
        meter.start()
        var last = 0.0
        var quiet = 0
        var lastBusyAt = start
        func check() {
            let now = CFAbsoluteTimeGetCurrent()
            // The run loop pass this check runs in is not closed yet: `read` counts it up to now. The total
            // only grows, so the next step takes only what came after.
            let total = meter.read(now: now).busyMs
            let step = total - last
            last = total
            if step >= quietMs {
                quiet = 0
                lastBusyAt = now
            } else {
                quiet += 1
            }
            guard quiet >= 3 || now - start >= cap else {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { MainActor.assumeIsolated { check() } }
                return
            }
            meter.stop()
            open.remove(label)
            let capped = quiet < 3 ? " (cap)" : ""
            PerfLog.mark(String(format: "%@ main busy %.1f ms, settled after %.0f ms%@: %@", label, total, (lastBusyAt - start) * 1000, capped, detail()) + RenderProbe.summary(since: bodies))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { MainActor.assumeIsolated { check() } }
    }
}
