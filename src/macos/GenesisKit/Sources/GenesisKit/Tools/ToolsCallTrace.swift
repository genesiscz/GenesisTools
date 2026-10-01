import Foundation

/// One line per `tools` call in app-perf.log, whichever way it ran, so any call can be traced later:
///
///     mark call t=5f3a9c1e via=server ms=14 exit=0 out=282B start=02:51:07.311 argv=hub agents counts --session 1b4001ba …
///
/// The trace id goes to the CLI too (`GENESIS_TOOLS_TRACE_ID` for a process, `traceId` in a server request), where
/// the day log records and the profiling lines carry it (src/utils/trace.ts). The line is written by PerfLog's own
/// queue, never on the caller's thread.
public enum ToolsCallTrace {
    public static let environmentKey = "GENESIS_TOOLS_TRACE_ID"

    /// 8 hex characters: unique enough within a day's log, short enough to grep.
    public static func newId() -> String {
        String(format: "%08x", UInt32.random(in: 0...UInt32.max))
    }

    /// The value after a flag that names a credential is replaced, and so is a `--flag=value` form of it.
    public static func redacted(_ argv: [String]) -> [String] {
        var out: [String] = []
        var hideNext = false
        for part in argv {
            if hideNext {
                out.append("***")
                hideNext = false
                continue
            }

            let lower = part.lowercased()
            let flag = lower.split(separator: "=", maxSplits: 1).first.map(String.init) ?? lower
            // Header flags carry credentials in their value (`--headers 'Authorization: Bearer …'`, `-H x-api-key:…`).
            let headerFlag = ["-h", "--header", "--headers"].contains(flag)
            let secret = lower.hasPrefix("-")
                && (headerFlag || ["token", "secret", "password", "key", "auth"].contains { lower.contains($0) })
            if secret, let equals = part.firstIndex(of: "=") {
                out.append(part[..<equals] + "=***")
            } else {
                out.append(part)
                hideNext = secret
            }
        }
        return out
    }

    private static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private static let stampLock = NSLock()

    public static func record(
        traceId: String,
        via: String,
        argv: [String],
        started: Date,
        exit: Int32,
        outBytes: Int,
        stderr: String
    ) {
        guard PerfLog.enabled else { return }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        let start = stampLock.withLock { stamp.string(from: started) }
        var line = "call t=\(traceId) via=\(via) ms=\(ms) exit=\(exit) out=\(outBytes)B start=\(start) argv="
        line += String(redacted(argv).joined(separator: " ").prefix(300))
        // Only the size of a failed child's stderr: its text can echo a credential, and argv redaction
        // does not reach it.
        if exit != 0, !stderr.isEmpty {
            line += " err=\(stderr.utf8.count)B"
        }
        PerfLog.mark(line)
    }
}
