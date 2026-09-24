// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/MonitorPerf.swift at 2026-09-24T03:59:28+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
import Foundation

/// Same file and subsystem as app `PerfLog` (`~/.genesis/logs/perf.log`).
/// Kit cannot import the app target.
public enum MonitorPerf {
    // GenesisTools adaptation: the same switch, subsystem and file as the stolen app PerfLog
    // (GENESIS_TOOLS_PERF, on by default, ~/.genesis-tools/logs/app-perf.log).
    // Every line goes through PerfLog's one serial writer: a second queue on the same file let two
    // seek-then-write appends land at the same offset, and both rotated the file under the other.
    static let enabled: Bool = PerfLog.enabled

    @discardableResult
    static func spanAsync<T>(_ label: String, _ body: () async throws -> T) async rethrows -> T {
        try await PerfLog.spanAsync("monitor.\(label)", body)
    }

    @discardableResult
    static func span<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        try PerfLog.span("monitor.\(label)", body)
    }

    /// Elapsed since a recorded start, for spans that cross an async boundary
    /// (status item click → first popup body).
    static func since(_ label: String, _ start: CFAbsoluteTime?) {
        PerfLog.since("monitor.\(label)", start)
    }

    static func now() -> CFAbsoluteTime? { PerfLog.now() }

    /// A one-line event (tool timeout, title repaint, profile line from a
    /// `tools` child) in the same file as the spans, so it sits in sequence.
    static func mark(_ text: String) {
        PerfLog.mark("monitor.\(text)")
    }

    /// A span measured elsewhere (a child process wall clock).
    static func record(_ label: String, ms: Double) {
        // PerfLog has no "record a duration" entry point; a start `ms` ago emits the same line.
        PerfLog.since("monitor.\(label)", CFAbsoluteTimeGetCurrent() - ms / 1000)
    }
}
