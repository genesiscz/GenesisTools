import Foundation

/// A `tools` call that exited non-zero, read once for every caller: the CLI's own message and code, the variables a
/// prompt still needs, the exit status and the end of stderr. Each feature keeps its own mapping from `code` to a
/// sentence; this type only reads what the CLI said.
///
/// The message comes from, in this order:
/// - a JSON error on stdout, in the shapes `src/utils/cli/failures/watch.ts` (`jsonErrorMessage`) knows:
///   `{"error":"…","code":"…","missing":[…]}`, `{"error":{"message":"…","code":"…"}}` and
///   `{"type":"error","message":"…"}`, as the whole output after a preamble or as its last JSON line;
/// - the last `✗` line of stderr, with a leading `[code]` read as the code (`✗ [config-stale] …`);
/// - Commander's `error: …` line at column 0 of stderr (its usage text follows it);
/// - else "tools <verb> exited <status>: <stderr tail>", or the stdout tail when stderr is empty.
public struct ToolsFailure: Error, LocalizedError, CustomStringConvertible, Equatable, Sendable {
    public let message: String
    public let code: String?
    public let missing: [String]?
    public let exitCode: Int32
    /// The end of stderr (300 characters at most) without the `[profile:` timing lines.
    public let stderrTail: String
    /// "tools hub pr fetch exited 1: <all of stderr>": the raw text behind a failure's Details, uncut.
    public let summary: String
    /// True when the CLI named the problem itself (a JSON error, a `✗` line or an `error:` line), false when `message`
    /// is only the exit status with the stderr tail.
    public let named: Bool

    public init(message: String, code: String? = nil, missing: [String]? = nil, exitCode: Int32, stderrTail: String, summary: String,
                named: Bool = true) {
        self.message = message
        self.code = code
        self.missing = missing
        self.exitCode = exitCode
        self.stderrTail = stderrTail
        self.summary = summary
        self.named = named
    }

    /// Reads a finished call. `argv` names the command in `summary`.
    public init(argv: [String], capture: ProcessCapture) {
        let stdout = String(decoding: capture.stdout, as: UTF8.self)
        let stderr = String(decoding: capture.stderr, as: UTF8.self)
        let tail = Self.tail(stderr)
        let command = "tools \(argv.prefix(3).joined(separator: " ")) exited \(capture.status)"
        let whole = stderr.trimmingCharacters(in: .whitespacesAndNewlines)
        let summary = command + (whole.isEmpty ? "" : ": \(whole)")
        // Stripped of colour codes once, for both readers of a human-facing stderr line.
        let plainLines = Self.stripColour(stderr).split(whereSeparator: \.isNewline)
        if let json = Self.jsonError(stdout) {
            self.init(message: json.message, code: json.code, missing: json.missing, exitCode: capture.status, stderrTail: tail,
                      summary: summary)
        } else if let marked = Self.markedLine(plainLines) {
            self.init(message: marked.message, code: marked.code, exitCode: capture.status, stderrTail: tail, summary: summary)
        } else if let commander = Self.commanderError(plainLines) {
            self.init(message: commander, exitCode: capture.status, stderrTail: tail, summary: summary)
        } else {
            // A tool that prints its reason on stdout only (no JSON, empty stderr) still says it.
            let said = tail.isEmpty ? Self.tail(stdout) : tail
            self.init(message: command + (said.isEmpty ? "" : ": \(said)"), exitCode: capture.status, stderrTail: tail, summary: summary,
                      named: false)
        }
    }

    public var description: String { message }
    public var errorDescription: String? { message }

    /// A capture's stdout when it exited 0, else its failure.
    public static func check(_ capture: ProcessCapture, argv: [String]) throws -> Data {
        guard capture.status == 0 else { throw ToolsFailure(argv: argv, capture: capture) }
        return capture.stdout
    }

    // MARK: - The shapes

    private struct JSONError {
        let message: String
        let code: String?
        let missing: [String]?
    }

    /// The whole output first (pretty-printed JSON spans lines), then each line that starts with `{`, last first.
    private static func jsonError(_ stdout: String) -> JSONError? {
        if let data = try? MonitorJSON.dataByDroppingPreamble(Data(stdout.utf8)), let found = jsonError(data) {
            return found
        }
        let lines = stdout.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
        for line in lines.reversed() where line.hasPrefix("{") {
            if let found = jsonError(Data(line.utf8)) { return found }
        }
        return nil
    }

    private static func jsonError(_ data: Data) -> JSONError? {
        guard let record = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return nil }
        let missing = record["missing"] as? [String]
        if record["type"] as? String == "error", let message = record["message"] as? String {
            return JSONError(message: message, code: record["code"] as? String, missing: missing)
        }
        if let message = record["error"] as? String {
            return JSONError(message: message, code: record["code"] as? String, missing: missing)
        }
        if let nested = record["error"] as? [String: Any], let message = nested["message"] as? String {
            return JSONError(message: message, code: nested["code"] as? String ?? record["code"] as? String, missing: missing)
        }
        return nil
    }

    /// The last `✗` line of stderr's lines without colour codes; a leading `[code]` is the code and leaves the message.
    private static func markedLine(_ plainLines: [Substring]) -> (message: String, code: String?)? {
        let lines = plainLines.map { $0.trimmingCharacters(in: .whitespaces) }
        guard let last = lines.last(where: { $0.hasPrefix("✗") }) else { return nil }
        var line = String(last.dropFirst()).trimmingCharacters(in: .whitespaces)
        var code: String?
        if let match = line.range(of: "^\\[[a-z0-9-]+\\]", options: .regularExpression) {
            code = String(line[match].dropFirst().dropLast())
            line = String(line[match.upperBound...]).trimmingCharacters(in: .whitespaces)
        }
        return line.isEmpty ? nil : (line, code)
    }

    /// Commander's `error: …` line. Only lines at column 0 count: an indented `    error: {` is a field of a log entry.
    private static func commanderError(_ plainLines: [Substring]) -> String? {
        let lines = plainLines.filter { $0.first.map { !$0.isWhitespace } ?? false }
        guard let line = lines.first(where: { $0.lowercased().hasPrefix("error:") }) else { return nil }
        let message = line.dropFirst("error:".count).trimmingCharacters(in: .whitespaces)
        return message.isEmpty ? nil : message
    }

    private static func stripColour(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
    }

    private static func tail(_ stderr: String) -> String {
        let lines = stderr.split(whereSeparator: \.isNewline).filter { !$0.hasPrefix("[profile:") }
        let text = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return String(text.suffix(300))
    }
}
