import Foundation

/// Reads the output of a failed `tools` command: the sentence that names the problem, and the log as events.
///
/// The CLI's log lines start at column 0 (`[scope] message`, `WARN: [scope] message`, `error: …`, `note: …`, plain
/// lines), and each entry's fields follow indented by four spaces (`    key: value`), a JSON value over several deeper
/// lines, an error's stack printed raw inside its JSON. Anything indented belongs to the entry above it, so an
/// indented `    error: {` is a field, never the error.
public enum FailureLog {
    public struct Field: Equatable, Sendable {
        public var name: String
        /// The value as printed, its continuation lines dedented to the field: a string keeps its quotes.
        public var value: String

        public init(name: String, value: String) {
            self.name = name
            self.value = value
        }
    }

    public struct Event: Equatable, Sendable {
        public enum Level: String, Sendable {
            case info, note, warning, error
        }

        public var level: Level
        /// The logger's name in brackets (`recorder-video`), nil for a plain line.
        public var scope: String?
        public var message: String
        public var fields: [Field]
        /// An error's stack taken out of its field's JSON: the error line, then its `at …` frames.
        public var stack: [String]
        /// An `error: …` line at column 0 with no scope: what Commander and the CLI's own failure path print.
        var isErrorLine = false

        public init(level: Level, scope: String? = nil, message: String, fields: [Field] = [], stack: [String] = []) {
            self.level = level
            self.scope = scope
            self.message = message
            self.fields = fields
            self.stack = stack
        }
    }

    /// The sentence a person reads first: the last `error:` line at column 0, else the last warning or error event,
    /// else a note that the command printed its usage, else the last line at column 0. Capitalised, ending in one
    /// full stop. Nil when the output names nothing.
    public static func headline(in output: String) -> String? {
        let events = events(in: output)
        let problem = events.last { $0.level == .error && $0.scope == nil && $0.isErrorLine }?.message
            ?? events.last { $0.level == .warning || $0.level == .error }?.message
            ?? (events.contains { $0.message.hasPrefix("Usage:") } ? "the command printed its usage instead of running" : nil)
            ?? events.last?.message
        return problem.flatMap(sentence)
    }

    /// One sentence: trimmed, its first letter capitalised, one full stop at the end.
    public static func sentence(_ text: String) -> String? {
        var text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let first = text.first else { return nil }
        text = first.uppercased() + text.dropFirst()
        while let last = text.last, last == "." || last == ":" {
            text.removeLast()
        }
        if let last = text.last, "!?".contains(last) {
            return text
        }
        return text + "."
    }

    public static func events(in output: String) -> [Event] {
        var events: [Event] = []
        var field: (name: String, lines: [String])?

        func closeField() {
            guard let open = field, !events.isEmpty else {
                field = nil
                return
            }
            field = nil
            let (value, stack) = splitStack(open.lines)
            events[events.count - 1].fields.append(Field(name: open.name, value: value))
            events[events.count - 1].stack.append(contentsOf: stack)
        }

        for raw in output.split(separator: "\n", omittingEmptySubsequences: false).map(String.init) {
            let line = raw.replacingOccurrences(of: "\t", with: "    ")
            if line.trimmingCharacters(in: .whitespaces).isEmpty {
                continue
            }

            let indent = line.prefix { $0 == " " }.count
            if indent == 0 {
                closeField()
                events.append(event(line))
                continue
            }

            // Lines before the first event have nothing to belong to.
            guard !events.isEmpty else { continue }
            let body = String(line.dropFirst(min(indent, 4)))
            if indent == 4, let (name, value) = fieldStart(body) {
                closeField()
                field = (name, [value])
            } else if field != nil {
                field?.lines.append(body)
            } else {
                // An indented line under a plain entry (help text): part of its message.
                events[events.count - 1].message += "\n" + line.trimmingCharacters(in: .whitespaces)
            }
        }
        closeField()
        return events
    }

    // MARK: - Parsing

    private static func event(_ line: String) -> Event {
        let lower = line.lowercased()
        for (prefix, level) in [("warn:", Event.Level.warning), ("warning:", .warning), ("error:", .error), ("fatal:", .error)]
            where lower.hasPrefix(prefix) {
            let rest = String(line.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
            if let (scope, message) = scoped(rest) {
                return Event(level: level, scope: scope, message: message)
            }
            var plain = Event(level: level, message: rest)
            plain.isErrorLine = level == .error
            return plain
        }

        if lower.hasPrefix("note:") {
            return Event(level: .note, message: String(line.dropFirst(5)).trimmingCharacters(in: .whitespaces))
        }

        if let (scope, message) = scoped(line) {
            return Event(level: .info, scope: scope, message: message)
        }

        // "failed, nothing was recorded: …" is the command's own last word on a failure.
        return Event(level: lower.hasPrefix("failed") ? .error : .info, message: line)
    }

    /// `[scope] message`.
    private static func scoped(_ text: String) -> (String, String)? {
        guard text.hasPrefix("["), let close = text.firstIndex(of: "]") else { return nil }
        let scope = String(text[text.index(after: text.startIndex)..<close])
        guard !scope.isEmpty, !scope.contains(" ") else { return nil }
        return (scope, String(text[text.index(after: close)...]).trimmingCharacters(in: .whitespaces))
    }

    /// `key: value` or `key:` with the value on the lines below; a key is one word (letters, digits, `_`, `-`, `.`).
    private static func fieldStart(_ body: String) -> (String, String)? {
        guard let colon = body.firstIndex(of: ":") else { return nil }
        let name = body[..<colon]
        guard let first = name.first, first.isLetter || first == "_",
              name.allSatisfy({ $0.isLetter || $0.isNumber || "_-.".contains($0) }) else { return nil }
        return (String(name), String(body[body.index(after: colon)...]).trimmingCharacters(in: .whitespaces))
    }

    /// A field's lines without an error's raw `"stack":` member, and that stack's lines (trimmed). The stack runs from
    /// the line after `"stack":` to the next JSON member or the closing brace at the stack's own indent or less.
    private static func splitStack(_ lines: [String]) -> (String, [String]) {
        guard let start = lines.firstIndex(where: { $0.trimmingCharacters(in: .whitespaces).hasPrefix("\"stack\":") }) else {
            return (lines.joined(separator: "\n"), [])
        }
        let keyIndent = lines[start].prefix { $0 == " " }.count
        var end = start + 1
        var stack: [String] = []
        let inline = lines[start].trimmingCharacters(in: .whitespaces).dropFirst("\"stack\":".count)
            .trimmingCharacters(in: .whitespaces)
        if !inline.isEmpty {
            stack.append(inline.trimmingCharacters(in: CharacterSet(charactersIn: "\",")))
        }
        while end < lines.count {
            let line = lines[end]
            let indent = line.prefix { $0 == " " }.count
            if indent <= keyIndent {
                break
            }
            stack.append(line.trimmingCharacters(in: .whitespaces))
            end += 1
        }
        var kept = Array(lines[..<start]) + Array(lines[end...])
        // A stack that was the last member leaves a comma before the closing brace.
        if start > 0, start - 1 < kept.count, end >= lines.count || lines[end].trimmingCharacters(in: .whitespaces).hasPrefix("}"),
           kept[start - 1].hasSuffix(",") {
            kept[start - 1].removeLast()
        }
        return (kept.joined(separator: "\n"), stack)
    }
}
