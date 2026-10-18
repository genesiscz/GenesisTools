import Foundation

/// The monitor's spans (`monitor.<label>`) in the app's perf file. From the GenesisTools copy: every
/// line goes through PerfLog's one serial writer, where Genesis's kit had a second queue on the same
/// file that let two seek-then-write appends land at the same offset.
public enum MonitorPerf {
    public static let enabled: Bool = PerfLog.enabled

    @discardableResult
    public static func spanAsync<T>(_ label: String, _ body: () async throws -> T) async rethrows -> T {
        try await PerfLog.spanAsync("monitor.\(label)", body)
    }

    @discardableResult
    public static func span<T>(_ label: String, _ body: () throws -> T) rethrows -> T {
        try PerfLog.span("monitor.\(label)", body)
    }

    /// Elapsed since a recorded start, for spans that cross an async boundary
    /// (status item click → first popup body).
    public static func since(_ label: String, _ start: CFAbsoluteTime?) {
        PerfLog.since("monitor.\(label)", start)
    }

    public static func now() -> CFAbsoluteTime? { PerfLog.now() }

    /// A one-line event (tool timeout, title repaint, profile line from a
    /// `tools` child) in the same file as the spans, so it sits in sequence.
    public static func mark(_ text: String) {
        PerfLog.mark("monitor.\(text)")
    }

    /// A span measured elsewhere (a child process wall clock).
    public static func record(_ label: String, ms: Double) {
        // PerfLog has no "record a duration" entry point; a start `ms` ago emits the same line.
        PerfLog.since("monitor.\(label)", CFAbsoluteTimeGetCurrent() - ms / 1000)
    }
}
