import Foundation

/// One line per `tools` call in app-perf.log, whichever way it ran, so any call can be traced later:
///
///     mark call t=5f3a9c1e via=server pid=4242 ms=14 exit=0 out=282B start=02:51:07.311 argv=hub agents counts --session 1b4001ba …
///
/// `pid` is the app process that made the call, so the calls of one face (the Meetings window, the hub, a snapshot run)
/// can be told apart; `app/lifecycle.jsonl` names the face of each pid.
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

    /// Values hidden in argv must not reappear in a persisted error's message or stderr.
    public static func redactedText(_ text: String, argv: [String]) -> String {
        var safe = text
        for (raw, masked) in zip(argv, redacted(argv)) where raw != masked {
            let secret: String
            if masked.hasSuffix("=***"), let equals = raw.firstIndex(of: "=") {
                secret = String(raw[raw.index(after: equals)...])
            } else {
                secret = raw
            }
            guard !secret.isEmpty, safe.contains(secret) else { continue }
            if secret.count < 4 { return "[withheld: the error repeats a credential]" }
            safe = safe.replacingOccurrences(of: secret, with: "***")
        }
        return safe
    }

    private static let stamp: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss.SSS"
        formatter.locale = Locale(identifier: "en_US_POSIX")
        return formatter
    }()

    private static let stampLock = NSLock()

    /// The calls of the task that reads it, for a failure report. A caller binds one around the work that may fail:
    /// `ToolsCallTrace.$ledger.withValue(ledger) { try await … }`, then `ledger.last` names the call that failed.
    @TaskLocal public static var ledger: ToolsCallLedger?

    private static let observerLock = NSLock()
    nonisolated(unsafe) private static var failureObserver: (@Sendable (ToolsCallLedger.Call) -> Void)?

    /// The host's failure capture. Every caller reaches it, including older callers without a task ledger.
    public static func observeFailures(_ observer: (@Sendable (ToolsCallLedger.Call) -> Void)?) {
        observerLock.withLock { failureObserver = observer }
    }

    /// A call starts: logged before dispatch, and noted in the task's ledger when it has one.
    public static func began(traceId: String, argv: [String], started: Date = Date()) {
        ledger?.began(ToolsCallLedger.Call(traceId: traceId, argv: argv, started: started))
        PerfLog.diagnostic("call-start t=\(traceId) pid=\(ProcessInfo.processInfo.processIdentifier) argv="
            + String(redacted(argv).joined(separator: " ").prefix(300)))
    }

    public static func record(
        traceId: String,
        via: String,
        argv: [String],
        started: Date,
        exit: Int32,
        outBytes: Int,
        stderr: String
    ) {
        let ended = Date()
        ledger?.ended(traceId: traceId, via: via, exit: exit, stderr: stderr, ended: ended)
        let gathersContext = argv.count > 1 && argv[0] == "genesis-tools" && ["triage", "env"].contains(argv[1])
        if exit != 0, !gathersContext, let observer = observerLock.withLock({ failureObserver }) {
            observer(ToolsCallLedger.Call(traceId: traceId, argv: redacted(argv), started: started, via: via,
                                           exit: exit, stderr: stderr.isEmpty ? nil : String(redactedText(stderr, argv: argv).prefix(4096)), ended: ended))
        }
        PerfLog.diagnostic(callLine(traceId: traceId, via: via, argv: argv, started: started, ended: ended, exit: exit,
                                    outBytes: outBytes, stderr: stderr))
    }

    /// The `call` trace line of a call that ended. Built only when diagnostics write it (`PerfLog.diagnostic`).
    private static func callLine(traceId: String, via: String, argv: [String], started: Date, ended: Date, exit: Int32,
                                 outBytes: Int, stderr: String) -> String {
        let ms = Int(ended.timeIntervalSince(started) * 1000)
        let start = stampLock.withLock { stamp.string(from: started) }
        var line = "call t=\(traceId) via=\(via) pid=\(ProcessInfo.processInfo.processIdentifier) ms=\(ms) exit=\(exit) out=\(outBytes)B start=\(start) argv="
        line += String(redacted(argv).joined(separator: " ").prefix(300))
        // Only the size of a failed child's stderr: its text can echo a credential, and argv redaction
        // does not reach it.
        if exit != 0, !stderr.isEmpty {
            line += " err=\(stderr.utf8.count)B"
        }
        return line
    }
}

/// The `tools` calls one piece of work made, in order: what a failure report names as "what ran". Bound to a task
/// through `ToolsCallTrace.ledger`; `ToolsBridge.run` and the hub's runner note each call's start and end in it.
public final class ToolsCallLedger: @unchecked Sendable {
    public struct Call: Codable, Equatable, Sendable {
        public var traceId: String
        public var argv: [String]
        public var started: Date
        /// How it ran (`server`, `process`, `server-timeout`, `process-timeout`); nil until it ended.
        public var via: String?
        public var exit: Int32?
        /// The start of its stderr, at most 4 KB: the error a failed call printed.
        public var stderr: String?
        public var ended: Date?

        public init(traceId: String, argv: [String], started: Date, via: String? = nil, exit: Int32? = nil,
                    stderr: String? = nil, ended: Date? = nil) {
            self.traceId = traceId
            self.argv = argv
            self.started = started
            self.via = via
            self.exit = exit
            self.stderr = stderr
            self.ended = ended
        }

        public var timedOut: Bool { via?.hasSuffix("-timeout") ?? false }
    }

    private let lock = NSLock()
    private var list: [Call] = []

    public init() {}

    public var calls: [Call] { lock.withLock { list } }

    /// The call started last: the one that failed when the work runs its calls one after another.
    public var last: Call? { lock.withLock { list.last } }

    /// The newest call that ended with an error or never ended, else the newest call.
    public var failed: Call? {
        lock.withLock { list.last { $0.exit.map { $0 != 0 } ?? true } ?? list.last }
    }

    func began(_ call: Call) {
        lock.withLock {
            list.append(call)
            if list.count > 64 {
                list.removeFirst(list.count - 64)
            }
        }
    }

    func ended(traceId: String, via: String, exit: Int32, stderr: String, ended: Date) {
        lock.withLock {
            guard let index = list.lastIndex(where: { $0.traceId == traceId }) else { return }
            list[index].via = via
            list[index].exit = exit
            list[index].stderr = stderr.isEmpty ? nil : String(stderr.prefix(4096))
            list[index].ended = ended
        }
    }
}

public extension ToolsCallLedger {
    /// Runs `work` with this ledger bound, so every `tools` call inside it is noted here.
    func record<T>(_ work: () async throws -> T) async rethrows -> T {
        try await ToolsCallTrace.$ledger.withValue(self) { try await work() }
    }

    /// `record` for synchronous work (a runner that blocks a background thread).
    func recordSync<T>(_ work: () throws -> T) rethrows -> T {
        try ToolsCallTrace.$ledger.withValue(self) { try work() }
    }
}
