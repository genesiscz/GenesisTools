import Foundation

/// A failed `tools` call as a report: one function every caller uses, so a pane, a notice and a settings page say a
/// timeout, a missing binary and a failed command the same way.
public extension FailureReport {
    /// The report of a `tools` call that failed.
    ///
    /// - `outcome`: what the person misses, as a sentence start ("The transcript did not load").
    /// - `action`: what the app was doing, in a few words ("Read the transcript"): the issue's first step.
    /// - `call`: the call from the task's `ToolsCallLedger` (`ledger.failed`); it gives the trace id, the argv, how it
    ///   ran and its stderr. Without it, `argv` names the command.
    ///
    /// The log is empty here; `addingCallLog()` reads it off the main thread.
    static func toolsCall(_ error: Error, outcome: String, action: String, call: ToolsCallLedger.Call? = nil,
                          argv: [String]? = nil, title: String? = nil, area: String? = nil, expected: String? = nil,
                          time: Date? = nil, home: String = GenesisToolsHome.home()) -> FailureReport {
        let argv = call?.argv ?? argv
        let time = time ?? call?.ended ?? Date()
        let cause = ToolsCallCause(error: error, call: call)
        let words = argv.map(Self.commandWords)
        let headline = FailureLog.sentence("\(outcome): \(cause.clause(command: words))") ?? outcome
        let report = FailureReport(
            title: title ?? outcome,
            headline: headline,
            summary: cause.summary(command: words),
            nextStep: cause.nextStep,
            action: action,
            command: argv.map(Self.typedCommand),
            exitStatus: cause.exitStatus,
            dayLog: FailureReport.dayLogPath(home: home, time: time),
            time: time,
            app: FailureAppFacts.current(home: home),
            expected: expected,
            area: area,
            call: call)
        return report
    }

    /// The report with its `log`: the failed call's stderr, then the app-perf.log lines that carry its trace id and
    /// every `tools` call that ended in the minute before it, so the details show what else was slow. Reads the tail of
    /// the file off the main thread; "Open log" goes to the call's own line.
    func addingCallLog(perfLog: URL = PerfLog.fileURL, window: TimeInterval = 60) async -> FailureReport {
        var report = self
        let call = self.call
        let time = self.time
        let headline = self.headline
        let log = self.log
        let read = await Task.detached(priority: .utility) { () -> ToolsCallLog in
            var log = ToolsCallLog.read(perfLog: perfLog, call: call, failedAt: time, window: window)
            // The trace line is written by PerfLog's own queue a moment after the call ended.
            if call != nil, log.traceLine == nil, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(400))
                log = ToolsCallLog.read(perfLog: perfLog, call: call, failedAt: time, window: window)
            }
            return log
        }.value
        report.log = ToolsCallLog.text(headline: headline, call: call, lines: read.lines, output: log)
        if read.traceLine != nil {
            report.logFile = perfLog.path
            report.logLine = read.traceLine
        }
        return report
    }

    /// `ai sessions tail`: the subcommand's words, without ids, paths and flags.
    nonisolated static func commandWords(_ argv: [String]) -> String {
        let words = argv.prefix { !$0.hasPrefix("-") }.prefix(3).filter { word in
            !word.contains("/") && !word.contains(".") && word.range(of: #"^[a-z][a-z-]*$"#, options: .regularExpression) != nil
        }
        return words.isEmpty ? (argv.first ?? "tools") : words.joined(separator: " ")
    }

    /// `tools ai sessions tail 1b40… --json --limit 12`, as a person types it, credentials hidden.
    nonisolated static func typedCommand(_ argv: [String]) -> String {
        (["tools"] + ToolsCallTrace.redacted(argv).map(Self.shellQuoted)).joined(separator: " ")
    }

    nonisolated static func shellQuoted(_ word: String) -> String {
        guard !word.isEmpty else { return "''" }
        let plain = word.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) || "-_./:=@,+%".unicodeScalars.contains($0) }
        return plain ? word : "'" + word.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }
}

/// Why a `tools` call failed, in the words a person reads.
struct ToolsCallCause: Equatable {
    enum Kind: Equatable {
        case timeout(seconds: Int, server: Bool)
        case notInstalled(path: String)
        case exit(Int32, problem: String?)
        case refused(String)
        case other(String)
    }

    let kind: Kind

    init(kind: Kind) {
        self.kind = kind
    }

    init(error: Error, call: ToolsCallLedger.Call?) {
        let printed = call?.stderr.flatMap { FailureLog.headline(in: $0) }
        // A runner that throws its own error for a call it killed (not `ToolsBridgeError.timeout`).
        if let call, call.timedOut, (error as? ToolsBridgeError) == nil {
            let seconds = call.ended.map { Int($0.timeIntervalSince(call.started).rounded()) } ?? 0
            kind = .timeout(seconds: seconds, server: call.via == "server-timeout")
            return
        }
        switch error as? ToolsBridgeError {
        case .timeout(let seconds):
            kind = .timeout(seconds: seconds, server: call?.via == "server-timeout")
        case .binaryNotFound(let path):
            kind = .notInstalled(path: path)
        case .refused(let reason):
            if let exit = call?.exit, exit != 0, call?.timedOut == false {
                kind = .exit(exit, problem: printed ?? Self.stripCommand(reason))
            } else {
                kind = .refused(Self.stripCommand(reason))
            }
        case nil:
            if let exit = call?.exit, exit != 0, call?.timedOut == false {
                kind = .exit(exit, problem: printed)
            } else {
                let text = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                kind = .other(text)
            }
        }
    }

    /// "tools ai sessions tail: <detail>" says the command again; the report shows it on its own line.
    static func stripCommand(_ reason: String) -> String {
        guard reason.hasPrefix("tools "), let colon = reason.range(of: ": ") else { return reason }
        let head = reason[..<colon.lowerBound]
        guard !head.contains("  "), head.split(separator: " ").count <= 5 else { return reason }
        return String(reason[colon.upperBound...])
    }

    /// The part after "The transcript did not load: ".
    func clause(command: String?) -> String {
        let named = command.map { "`\($0)`" } ?? "the tools call"
        switch kind {
        case .timeout(let seconds, _): return "the tools call did not answer in \(seconds) s"
        case .notInstalled: return "the tools command is not installed where the app looks for it"
        case .exit(let status, let problem): return problem.map(Self.lowered) ?? "\(named) ended with exit \(status)"
        case .refused(let reason): return Self.lowered(reason)
        case .other(let text): return Self.lowered(text)
        }
    }

    /// The quiet line under the headline: what ran and how it ended.
    func summary(command: String?) -> String {
        let named = command.map { "`\($0)`" } ?? "The tools call"
        switch kind {
        case .timeout(let seconds, let server):
            return "\(named) did not answer in \(seconds) s" + (server ? " (the hub server held it the whole time)." : ".")
        case .notInstalled(let path): return "No tools command at \(path)."
        case .exit(let status, _): return "\(named) ended with exit \(status)."
        case .refused, .other: return "\(named) failed."
        }
    }

    var nextStep: String {
        switch kind {
        case .timeout:
            return "Try again. The Mac or the hub server may be busy: Details lists the calls of the minute before it."
        case .notInstalled:
            return "Run ./install.sh in your GenesisTools checkout, then reopen the app."
        case .exit, .refused, .other:
            return "Try again. If it fails the same way, report a bug: the report carries the command and its log."
        }
    }

    var exitStatus: Int32? {
        if case .exit(let status, _) = kind { return status }
        return nil
    }

    /// A sentence as a clause: its first letter lowered unless it starts a name ("GitHub", "PR"), its full stop gone.
    static func lowered(_ text: String) -> String {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while let last = text.last, last == "." {
            text.removeLast()
        }
        guard let first = text.first, first.isUppercase else { return text }
        // A name keeps its case: "GitHub", "PR", "macOS" have another capital or a digit in their first word.
        let word = text.dropFirst().prefix { !$0.isWhitespace && $0 != ":" }
        if word.contains(where: { $0.isUppercase || $0.isNumber }) { return text }
        return first.lowercased() + text.dropFirst()
    }
}

/// The app-perf.log lines a report of a failed call carries.
struct ToolsCallLog: Equatable {
    var lines: [String]
    /// The 1-based line in the whole file of the call's own trace line.
    var traceLine: Int?

    /// The tail read at most: the file grows to 16 MB before it rotates, and a minute of calls is a few KB.
    static let tailBytes = 2 * 1024 * 1024
    static let maxLines = 120

    static func read(perfLog: URL, call: ToolsCallLedger.Call?, failedAt: Date, window: TimeInterval,
                     timeZone: TimeZone = .current) -> ToolsCallLog {
        guard let handle = try? FileHandle(forReadingFrom: perfLog) else { return ToolsCallLog(lines: []) }
        defer { try? handle.close() }
        let size = (try? handle.seekToEnd()) ?? 0
        let start = size > UInt64(tailBytes) ? size - UInt64(tailBytes) : 0
        try? handle.seek(toOffset: start)
        let data = (try? handle.readToEnd()) ?? Data()
        var text = String(decoding: data, as: UTF8.self)
        if start > 0, let newline = text.firstIndex(of: "\n") {
            // The first line of a tail starts mid-line.
            text = String(text[text.index(after: newline)...])
        }
        let ended = call?.ended ?? failedAt
        let started = call?.started ?? failedAt
        var log = select(text, traceId: call?.traceId, from: started.addingTimeInterval(-window), to: ended.addingTimeInterval(2),
                         timeZone: timeZone)
        if let index = log.traceLine {
            let before = start > 0 ? newlines(in: perfLog, upTo: start) + 1 : 0
            log.traceLine = before + index
        }
        return log
    }

    /// The lines of `text` that carry `traceId`, and the `call` lines whose end stamp lies in `from…to`.
    /// `traceLine` is the 1-based line of the trace's `call` line within `text`.
    static func select(_ text: String, traceId: String?, from: Date, to: Date, timeZone: TimeZone = .current) -> ToolsCallLog {
        let needle = traceId.map { "t=\($0)" }
        let fromSecond = secondOfDay(from, timeZone: timeZone)
        let span = max(0, to.timeIntervalSince(from))
        var lines: [String] = []
        var traceLine: Int?
        var number = 0
        text.enumerateLines { line, _ in
            number += 1
            let isCall = line.contains(" call t=")
            let own = needle.map { line.contains($0 + " ") || line.hasSuffix($0) } ?? false
            guard own || isCall else { return }
            if !own {
                guard let second = stampSecond(line) else { return }
                // Seconds after `from`, across midnight.
                let after = (second - fromSecond + 86_400).truncatingRemainder(dividingBy: 86_400)
                guard after <= span else { return }
            }
            if own, isCall, traceLine == nil {
                traceLine = number
            }
            lines.append(line)
        }
        if lines.count > maxLines {
            lines = Array(lines.suffix(maxLines))
        }
        return ToolsCallLog(lines: lines, traceLine: traceLine)
    }

    /// The log a report carries: the error, the call's stderr, then the perf lines.
    static func text(headline: String, call: ToolsCallLedger.Call?, lines: [String], output: String = "") -> String {
        var out = ["error: \(headline)"]
        let output = output.trimmingCharacters(in: .whitespacesAndNewlines)
        if !output.isEmpty {
            out += ["", output]
        }
        if let call {
            let ms = call.ended.map { Int($0.timeIntervalSince(call.started) * 1000) }
            var facts = ["trace t=\(call.traceId)"]
            if let via = call.via { facts.append("via \(via)") }
            if let ms { facts.append("\(ms) ms") }
            out.append("note: " + facts.joined(separator: ", "))
            if let stderr = call.stderr?.trimmingCharacters(in: .whitespacesAndNewlines), !stderr.isEmpty {
                out += ["", stderr]
            }
        }
        if !lines.isEmpty {
            out += ["", "note: app-perf.log, this call and the calls of the minute before it"] + lines
        }
        return out.joined(separator: "\n") + "\n"
    }

    /// `[19:31:18.823] …` as seconds since midnight.
    static func stampSecond(_ line: String) -> Double? {
        guard line.hasPrefix("["), line.count > 13 else { return nil }
        let stamp = line.dropFirst().prefix(12)
        let parts = stamp.split(separator: ":")
        guard parts.count == 3, let hours = Double(parts[0]), let minutes = Double(parts[1]), let seconds = Double(parts[2])
        else { return nil }
        return hours * 3600 + minutes * 60 + seconds
    }

    static func secondOfDay(_ date: Date, timeZone: TimeZone) -> Double {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.hour, .minute, .second, .nanosecond], from: date)
        return Double(parts.hour ?? 0) * 3600 + Double(parts.minute ?? 0) * 60 + Double(parts.second ?? 0)
            + Double(parts.nanosecond ?? 0) / 1e9
    }

    /// Newlines in the first `limit` bytes of the file, read in 1 MB chunks.
    static func newlines(in url: URL, upTo limit: UInt64) -> Int {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return 0 }
        defer { try? handle.close() }
        var count = 0
        var remaining = limit
        while remaining > 0 {
            let chunk = handle.readData(ofLength: Int(min(remaining, 1 << 20)))
            if chunk.isEmpty { break }
            remaining -= UInt64(chunk.count)
            count += chunk.reduce(0) { $1 == 0x0A ? $0 + 1 : $0 }
        }
        return count
    }
}

public extension FailureReport {
    /// Shows the report at once through `set`, then again with its log (`addingCallLog`) once that is read, unless
    /// `isCurrent` says a newer load or a success took its place.
    @MainActor
    func deliver(_ set: @escaping @MainActor (FailureReport) -> Void, isCurrent: @escaping @MainActor (FailureReport) -> Bool) {
        FailureCapture.record(self)
        set(self)
        let shown = self
        Task { @MainActor in
            let full = await shown.addingCallLog()
            if isCurrent(shown) {
                set(full)
            }
        }
    }
}

public extension FailureReport {
    /// A failure that is not a `tools` call (git, a file, a decode): the headline from `outcome` and the error's own
    /// sentence, the raw text as the log. Builds no app facts from disk when `app` is given, so it is cheap to call.
    static func unexpected(_ message: String, outcome: String, action: String, title: String? = nil, area: String? = nil,
                           log: String? = nil, time: Date = Date(), app: FailureAppFacts? = nil,
                           home: String = GenesisToolsHome.home()) -> FailureReport {
        let clause = ToolsCallCause.lowered(message.components(separatedBy: .newlines).first ?? message)
        return FailureReport(
            title: title ?? outcome,
            headline: FailureLog.sentence("\(outcome): \(clause)") ?? outcome,
            nextStep: "Try again. If it fails the same way, report a bug: the report carries the error and its log.",
            action: action,
            dayLog: FailureReport.dayLogPath(home: home, time: time),
            log: log ?? message,
            time: time,
            app: app ?? FailureAppFacts.current(home: home),
            area: area)
    }
}
