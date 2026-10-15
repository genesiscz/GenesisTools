//
//  PerfSpans.swift
//  GenesisKit
//
//  Spans, main-thread busy meters, the stall test and the layout-loop watch, on top of `PerfLog`. They were the
//  GenesisTools hub's (`HubPerf`, `HubMainBusy`, `HubStallTest`, `LayoutLoopWatch`); every app and every GenesisKit
//  component now measures through them, with the host's prefix (`PerfConfiguration.spanPrefix`: "hub" in
//  GenesisTools, so its lines and `scripts/perf-report.ts` stay as they were).
//

import Foundation
import os
import SwiftUI

/// Every load that can be slow (a `tools` call, git, a transcript page, a diff render) runs inside a span. Lines
/// land in the host's perf log (GenesisTools: `~/.genesis-tools/logs/app-perf.log`):
///
///     [05:02:11.412] hub.repoFacts 142.3ms
///     [05:02:11.412] mark hub.repoFacts SLOW 142.3ms bg: 3 paths pr=false
///     [05:02:12.020] hub.review.render.main 18.2ms
///
/// A `.main` suffix means the span ran on the main thread, where anything over a frame (16 ms) is
/// visible jank. Spans at or over `slowMs` add a `SLOW` mark with their detail. Spans are also
/// os_signpost intervals (the prefix, Points of Interest) for Instruments.
public enum PerfSpans {
    public static let slowMs = 100.0

    /// "hub" in GenesisTools, "genesis" in Genesis: the first word of every span and mark.
    public static var prefix: String { PerfConfiguration.current.spanPrefix }

    private static let signposter = OSSignposter(subsystem: PerfConfiguration.current.subsystem, category: .pointsOfInterest)

    public struct Span {
        fileprivate let label: String
        fileprivate let detail: String
        fileprivate let start: CFAbsoluteTime?
        fileprivate let onMain: Bool
        fileprivate let state: OSSignpostIntervalState?

        /// Ends the span; `extra` joins the detail of a SLOW mark (a count, "failed").
        public func end(_ extra: String = "") {
            guard let start else { return }
            if let state { PerfSpans.signposter.endInterval("span", state) }
            let name = "\(PerfSpans.prefix).\(label)\(onMain ? ".main" : "")"
            PerfLog.since(name, start)
            let ms = (CFAbsoluteTimeGetCurrent() - start) * 1000
            if ms >= PerfSpans.slowMs {
                let note = [detail, extra].filter { !$0.isEmpty }.joined(separator: " ")
                PerfLog.mark(String(format: "%@.%@ SLOW %.1fms %@%@", PerfSpans.prefix, label, ms, onMain ? "main" : "off-main", note.isEmpty ? "" : ": " + note))
            }
        }
    }

    /// `awaits: true` for a span that crosses an `await`: its wall time is waiting, not main-thread
    /// work, so it never gets the `.main` suffix even when it started on the main actor.
    public static func begin(_ label: String, _ detail: String = "", awaits: Bool = false) -> Span {
        guard PerfLog.enabled else {
            return Span(label: label, detail: detail, start: nil, onMain: false, state: nil)
        }
        let state = signposter.beginInterval("span", id: signposter.makeSignpostID(), "\(label, privacy: .public)")
        return Span(label: label, detail: detail, start: CFAbsoluteTimeGetCurrent(), onMain: !awaits && Thread.isMainThread, state: state)
    }

    @discardableResult
    public static func measure<T>(_ label: String, _ detail: String = "", _ body: () throws -> T) rethrows -> T {
        let span = begin(label, detail)
        defer { span.end() }
        return try body()
    }

    /// A point in time: "review.renderer ready", "repoFacts failed: …".
    public static func log(_ text: String) {
        PerfLog.mark("\(prefix).\(text)")
    }
}

/// Main-thread busy time after an event, one `<prefix>.<label> main busy …` line in the perf log. The meter is
/// `MainBusy` (Perf/MainBusy.swift); this adds the host's prefix.
@MainActor
public enum PerfMainBusy {
    public static func measure(_ label: String, window: TimeInterval = 0.6) {
        MainBusy.measure("\(PerfSpans.prefix).\(label)", window: window)
    }

    /// See `MainBusy.measureUntilSettled`.
    public static func measureUntilSettled(_ label: String, cap: TimeInterval = 10, quietMs: Double = 8, detail: @escaping () -> String) {
        MainBusy.measureUntilSettled("\(PerfSpans.prefix).\(label)", cap: cap, quietMs: quietMs, detail: detail)
    }
}

/// `GENESIS_HUB_STALL_TEST=<ms>`: blocks the main thread once, 3 s after launch, in a frame with a
/// known name, so a run proves the stall capture end to end (the stack file must name `block(ms:)`).
public enum StallTest {
    @MainActor
    public static func scheduleIfRequested() {
        guard let raw = ProcessInfo.processInfo.environment["GENESIS_HUB_STALL_TEST"], let ms = Double(raw), ms > 0 else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { block(ms: ms) }
    }

    @inline(never)
    public static func block(ms: Double) {
        let end = CFAbsoluteTimeGetCurrent() + ms / 1000
        var spins = 0
        while CFAbsoluteTimeGetCurrent() < end {
            spins &+= 1
        }
        PerfLog.mark("stall test: blocked the main thread \(Int(ms)) ms (\(spins) spins)")
    }
}

/// A view's width read into its own state, the shape behind a layout loop: the state changes the layout,
/// the layout changes the width, and SwiftUI runs transaction after transaction inside one run-loop pass.
/// The hub's main thread sat in such a pass for over 115 s on the PRs view (hang 2026-10-08 01:46,
/// `GraphHost.flushTransactions` → `RootGeometry` → `StackLayout.sizeThatFits`). Whole points only, so a
/// sub-pixel see-saw writes nothing, and more than 30 writes in a second log the label and its values.
public enum LayoutLoopWatch {
    nonisolated(unsafe) private static var windows: [String: (start: CFAbsoluteTime, values: [Int], logged: Bool)] = [:]

    public static func note(_ label: String, _ value: CGFloat) {
        let now = CFAbsoluteTimeGetCurrent()
        var window = windows[label] ?? (now, [], false)
        if now - window.start > 1 {
            window = (now, [], false)
        }
        window.values.append(Int(value))
        if window.values.count > 30, !window.logged {
            window.logged = true
            PerfSpans.log("layout.loop \(label): \(window.values.count) width writes in 1 s, last \(window.values.suffix(8).map(String.init).joined(separator: ","))")
        }
        windows[label] = window
    }
}

extension View {
    /// `.onGeometryChange` of the width into `width`, in whole points, watched by `LayoutLoopWatch`.
    public func measuredWidth(_ label: String, _ width: Binding<CGFloat>) -> some View {
        onGeometryChange(for: CGFloat.self, of: { $0.size.width.rounded() }) { value in
            LayoutLoopWatch.note(label, value)
            if width.wrappedValue != value {
                width.wrappedValue = value
            }
        }
    }
}
