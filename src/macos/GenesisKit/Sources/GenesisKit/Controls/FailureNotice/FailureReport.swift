import Foundation

/// What the app knows about its own build, for a report an agent acts on: the version, and the checkout, branch and
/// commit the installed bundle was built from (`~/.genesis-tools/app/manifest.json`, written by every build).
public struct FailureAppFacts: Codable, Equatable, Sendable {
    public var name: String
    public var version: String?
    public var branch: String?
    public var commit: String?
    public var dirty: Bool
    public var checkout: String?

    public init(name: String, version: String? = nil, branch: String? = nil, commit: String? = nil, dirty: Bool = false,
                checkout: String? = nil) {
        self.name = name
        self.version = version
        self.branch = branch
        self.commit = commit
        self.dirty = dirty
        self.checkout = checkout
    }

    /// The running bundle's version and the build manifest under `home`. Reads one small file; call it when a
    /// failure is reported, not in a view body.
    public static func current(home: String = GenesisToolsHome.home(), bundle: Bundle = .main) -> FailureAppFacts {
        let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "GenesisTools"
        var facts = FailureAppFacts(name: name, version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        let manifest = GenesisToolsHome.url("app/manifest.json", in: home)
        guard let data = try? Data(contentsOf: manifest),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return facts }
        facts.branch = object["sourceBranch"] as? String
        facts.commit = object["sourceCommit"] as? String
        facts.dirty = object["sourceDirty"] as? Bool ?? false
        facts.checkout = object["sourceRoot"] as? String
        return facts
    }


    /// "GenesisTools 1.4, feat/x @ d9695acca149 (uncommitted changes), checkout `/…`".
    var line: String {
        var parts = [[name, version].compactMap { $0 }.joined(separator: " ")]
        if let commit {
            var build = [branch, String(commit.prefix(12))].compactMap { $0 }.joined(separator: " @ ")
            if dirty {
                build += " (uncommitted changes)"
            }
            parts.append(build)
        }
        if let checkout {
            parts.append("checkout `\(checkout)`")
        }
        return parts.joined(separator: ", ")
    }
}

/// A failure a person reads and an agent can act on: a one-sentence headline, what ran, where its output and files
/// are, and the raw output. The notice draws `detailsMarkdown()`; "Copy context for agents" copies `agentContext()`.
public struct FailureReport: Codable, Equatable, Sendable {
    /// The window's title, a few words on what failed ("Recording failed").
    public var title: String
    /// The real error in one sentence (`FailureLog.headline`), never a cut line of raw output.
    public var headline: String
    /// What the app was doing when it failed, in one sentence ("Recording a window stopped at once (exit 1).").
    public var summary: String?
    /// What it means for the person and what to do next.
    public var nextStep: String?
    /// The action in a few words ("Start a recording").
    public var action: String?
    /// The command that ran, as a person would type it.
    public var command: String?
    public var exitStatus: Int32?
    /// A folder the failure is about (the recording's), when there is one.
    public var folder: String?
    /// The file that holds this run's output.
    public var logFile: String?
    /// The 1-based line of `logFile` where this run's output starts ("Open log" goes there).
    public var logLine: Int?
    /// The app's day log (`~/.genesis-tools/logs/<date>.log`).
    public var dayLog: String?
    /// The whole raw output.
    public var log: String
    public var time: Date
    public var app: FailureAppFacts?
    /// What should have happened ("The recording starts.").
    public var expected: String?
    /// The bug form's "Affected tool" ("recorder").
    public var area: String?
    /// The environment `tools genesis-tools triage --json` reported, nil until it answered (or when it could not).
    public var environment: FailureEnvironment?
    /// The failed `tools` call, from the task's `ToolsCallLedger`: its trace id, argv, how it ran and its stderr.
    public var call: ToolsCallLedger.Call?
    /// The stack of the error where it was thrown (a TypeScript service's error reply carries it), as it printed.
    public var stack: String?
    /// The issue the place that threw named: the tool whose process failed and, when it gave one, a short title.
    public var issue: FailureIssue?

    public init(title: String = "Failed", headline: String, summary: String? = nil, nextStep: String? = nil,
                action: String? = nil, command: String? = nil, exitStatus: Int32? = nil, folder: String? = nil,
                logFile: String? = nil, logLine: Int? = nil, dayLog: String? = nil, log: String = "", time: Date = Date(),
                app: FailureAppFacts? = nil, expected: String? = nil, area: String? = nil,
                environment: FailureEnvironment? = nil, call: ToolsCallLedger.Call? = nil, stack: String? = nil,
                issue: FailureIssue? = nil) {
        self.title = title
        self.headline = headline
        self.summary = summary
        self.nextStep = nextStep
        self.action = action
        self.command = command
        self.exitStatus = exitStatus
        self.folder = folder
        self.logFile = logFile
        self.logLine = logLine
        self.dayLog = dayLog
        self.log = log
        self.time = time
        self.app = app
        self.expected = expected
        self.area = area
        self.environment = environment
        self.call = call
        self.stack = stack
        self.issue = issue
        if call != nil { FailureCapture.record(self) }
    }

    public var hasLog: Bool {
        !log.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || !(stack ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// The checkbox lines of the bug form's Impact question (GitHub task list markdown): the poster ticks one.
    public static let impactChoices = [
        "Blocks my work completely",
        "Frequent failure or major degradation",
        "Occasional failure",
        "Cosmetic",
    ]

    /// The tool the failure belongs to: the one that threw (`issue.tool`), else the report's area.
    public var issueTool: String? {
        [issue?.tool, area].compactMap { $0?.trimmingCharacters(in: .whitespaces) }.first { !$0.isEmpty }
    }

    /// The issue's title before any length cut: `[<tool>] <title>`, the title the place that threw gave, else the
    /// headline. Without a tool: `<window title>: <headline>`.
    public var issueTitle: String {
        var text = (issue?.title?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 }
            ?? headline.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.hasSuffix(".") {
            text.removeLast()
        }
        guard let tool = issueTool else { return "\(title): \(text)" }
        return "[\(tool)] \(text)"
    }

    /// The stack's frames (`at …` lines), trimmed.
    var stackFrames: [String] {
        (stack ?? "").split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { $0.hasPrefix("at ") }
    }

    /// `<home>/.genesis-tools/logs/<local date>.log`, the file every `tools` process and the app log to that day.
    public static func dayLogPath(home: String = GenesisToolsHome.home(), time: Date = Date(), timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return GenesisToolsHome.url("logs/\(formatter.string(from: time)).log", in: home).path
    }

    // MARK: - Markdown

    /// A markdown block an agent can act on without asking: the issue body under a heading, then every environment
    /// fact `tools genesis-tools env` gave.
    public func agentContext(timeZone: TimeZone = .current) -> String {
        var text = "## \(app?.name ?? "GenesisTools") failure: \(headline)\n\n"
        text += "- **Issue title:** \(issueTitle)\n"
        if let command {
            text += "- **Command:** `\(command)`" + (exitStatus.map { " (exit \($0))" } ?? "") + "\n"
        }
        text += "\n" + issueBody(timeZone: timeZone)
        if let environment, !environment.fields.isEmpty, !environment.markdown.isEmpty {
            text += "\n### All environment facts\n\n" + environment.markdown + "\n"
        }
        return PathDisplay.shortenHome(in: text)
    }

    /// Everything the report knows as one plain text, for "Raw log" and "Copy log": the error, the command, where the
    /// logs are, the time, the whole output, the whole stack, and the environment once it arrived.
    public func rawText(timeZone: TimeZone = .current) -> String {
        var text = actual(timeZone: timeZone)
        if let environment, !environment.markdown.isEmpty {
            text += "\n\nenvironment:\n" + environment.markdown.trimmingCharacters(in: .newlines)
        }
        return PathDisplay.shortenHome(in: text)
    }

    /// The issue body in the bug form's sections, in its order and with its names (`.github/ISSUE_TEMPLATE/
    /// bug_report.yml`, read by `tools genesis-tools env`). Without the form: What happened, Steps to reproduce,
    /// Expected, Actual (error + log) and Environment. The form's checkboxes are left out: they are the poster's.
    public func issueBody(timeZone: TimeZone = .current) -> String {
        let fields = environment?.fields.filter { $0.type != "checkboxes" } ?? []
        guard !fields.isEmpty else {
            let environmentText = environment?.markdown.isEmpty == false ? environment?.markdown ?? "" : fallbackEnvironment()
            return PathDisplay.shortenHome(in: [
                section("What happened", whatHappened()),
                section("Steps to reproduce", steps()),
                section("Expected", expected ?? "It works without an error."),
                section("Actual (error + log)", fenced(actual(timeZone: timeZone), "shell")),
                section("Environment", environmentText),
            ].joined(separator: "\n"))
        }

        return PathDisplay.shortenHome(in: fields.map { field in
            let value: String
            switch field.id {
            case "what-happened": value = whatHappened()
            case "steps": value = steps()
            case "expected": value = expected ?? "It works without an error."
            case "actual": value = actual(timeZone: timeZone)
            case "area": value = area ?? "other"
            case "impact": value = Self.impactChoices.map { "- [ ] \($0)" }.joined(separator: "\n")
            default: value = environment?.values[field.id] ?? "_No response_"
            }
            return section(field.label, field.render.map { fenced(value, $0) } ?? value)
        }.joined(separator: "\n"))
    }

    private func section(_ label: String, _ value: String) -> String {
        "### \(label)\n\n\(value.trimmingCharacters(in: .newlines))\n"
    }

    private func fenced(_ value: String, _ language: String) -> String {
        "```\(language)\n\(value.trimmingCharacters(in: .newlines))\n```"
    }

    private func whatHappened() -> String {
        [summary, headline].compactMap { $0 }.joined(separator: " ")
    }

    private func steps() -> String {
        var lines: [String] = []
        if let action, let command {
            lines.append("1. \(action): `\(command)`")
        } else if let what = action ?? command.map({ "`\($0)`" }) {
            lines.append("1. \(what)")
        } else {
            lines.append("1. (what you did)")
        }
        lines.append("2. It failed" + (exitStatus.map { " (exit \($0))" } ?? "") + ".")
        return lines.joined(separator: "\n")
    }

    /// The form renders "Actual" as a shell block: the error, where the log is, when, then the whole output.
    private func actual(timeZone: TimeZone) -> String {
        let formatter = DateFormatter()
        // en_GB names the zone ("CET", "CEST"); en_US_POSIX prints "GMT+1".
        formatter.locale = Locale(identifier: "en_GB")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"
        var lines = ["error: \(headline)"]
        if let issueTool {
            lines.append("tool: \(issueTool)" + (issue?.title.map { " (issue: \($0))" } ?? ""))
        }
        if let command {
            lines.append("command: \(command)" + (exitStatus.map { " (exit \($0))" } ?? ""))
        }
        if let logFile {
            lines.append("log: \(logFile)" + (logLine.map { " (from line \($0))" } ?? ""))
        }
        if let dayLog {
            lines.append("day log: \(dayLog)")
        }
        if let folder {
            lines.append("folder: \(folder)" + (FileManager.default.fileExists(atPath: folder) ? "" : " (no longer on disk)"))
        }
        if let call {
            lines.append("trace: t=\(call.traceId)" + (call.via.map { " (via \($0))" } ?? ""))
        }
        lines.append("time: \(formatter.string(from: time))")
        if hasLog {
            lines += ["", log.trimmingCharacters(in: .newlines)]
        }
        if let stack = stack?.trimmingCharacters(in: .newlines), !stack.isEmpty {
            lines += ["", "stack:", stack]
        }
        return lines.joined(separator: "\n")
    }

    private func fallbackEnvironment() -> String {
        var lines: [String] = []
        if let app {
            lines.append("- **App:** \(app.line)")
        }
        lines.append("- **macOS:** \(ProcessInfo.processInfo.operatingSystemVersionString)")
        return lines.joined(separator: "\n")
    }

    /// The notice's details under its headline (which is the error, so it is not repeated): each warning with its
    /// fields and pretty JSON (an error's stack folded to its first frame), then every step of the log on one line
    /// each. A log with no entries is shown as it came.
    public func detailsMarkdown() -> String {
        let events = FailureLog.events(in: log)
        var lines: [String] = []

        if let stack = Self.stackLine(stackFrames) {
            lines += ["### Stack", "", stack + " (the whole stack is under Raw log)"]
        }

        let warnings = events.filter { $0.level == .warning || ($0.level == .error && (!$0.fields.isEmpty || !$0.stack.isEmpty)) }
        if !warnings.isEmpty {
            lines += (lines.isEmpty ? [] : [""]) + ["### Warnings (\(warnings.count))"]
            for warning in warnings {
                lines += ["", Self.title(warning)]
                var short: [String] = []
                var blocks: [String] = []
                for field in warning.fields {
                    if field.value.contains("\n") {
                        blocks += ["", "**\(field.name)**", "", "```json", Self.pretty(field.value), "```"]
                    } else {
                        short.append("- **\(field.name)** `\(Self.unquoted(field.value))`")
                    }
                }
                if !short.isEmpty {
                    lines += [""] + short
                }
                lines += blocks
                if let stack = Self.stackLine(warning.stack) {
                    lines += ["", stack]
                }
            }
        }

        if !events.isEmpty {
            lines += (lines.isEmpty ? [] : [""]) + ["### Steps (\(events.count))", ""]
            for (index, event) in events.enumerated() {
                var line = "\(index + 1). \(Self.title(event))"
                let fields = event.fields.map { "**\($0.name)** `\(Self.compact($0.value))`" }
                if !fields.isEmpty {
                    line += " · " + fields.joined(separator: " · ")
                }
                lines.append(line)
            }
        }
        return PathDisplay.shortenHome(in: lines.joined(separator: "\n") + "\n")
    }

    /// "**Warning** · `recorder-camera` the camera did not start".
    static func title(_ event: FailureLog.Event) -> String {
        let level: String? = switch event.level {
        case .warning: "**Warning**"
        case .error: "**Error**"
        case .note: "*Note*"
        case .info: nil
        }
        let scope = event.scope.map { "`\($0)`" }
        let head = [level, scope].compactMap { $0 }.joined(separator: " · ")
        let message = event.message.replacingOccurrences(of: "\n", with: " ")
        return head.isEmpty ? message : "\(head) \(message)"
    }

    /// "Stack: 3 frames, from `camera.start` at `src/recorder/lib/host.ts:234:19`": the first frame only; the raw log
    /// and the agent context keep the whole stack.
    static func stackLine(_ stack: [String]) -> String? {
        let frames = stack.filter { $0.hasPrefix("at ") }
        guard let first = frames.first else { return nil }
        var text = String(first.dropFirst(3))
        var place: String?
        if let open = text.lastIndex(of: "("), text.hasSuffix(")") {
            place = String(text[text.index(after: open)..<text.index(before: text.endIndex)])
            text = String(text[..<open]).trimmingCharacters(in: .whitespaces)
        }
        if let full = place, let src = full.range(of: "/src/") {
            place = "src/" + full[src.upperBound...]
        }
        let noun = frames.count == 1 ? "frame" : "frames"
        return "Stack: \(frames.count) \(noun), from `\(text)`" + (place.map { " at `\($0)`" } ?? "")
    }

    /// A JSON value re-printed with sorted keys and two-space indents; anything else as it came.
    static func pretty(_ value: String) -> String {
        guard let data = value.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
              let out = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]),
              let text = String(data: out, encoding: .utf8) else { return value }
        return text
    }

    /// A value on one line: JSON compacted, a quoted string without its quotes.
    static func compact(_ value: String) -> String {
        if value.contains("\n"),
           let data = value.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]),
           let out = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys, .withoutEscapingSlashes]),
           let text = String(data: out, encoding: .utf8) {
            return text
        }
        return unquoted(value).replacingOccurrences(of: "\n", with: " ")
    }

    /// A JSON string's text without its quotes; anything else as it came.
    public static func unquoted(_ value: String) -> String {
        guard value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") else { return value }
        return String(value.dropFirst().dropLast())
    }
}

/// The issue a failure is filed as, from the error reply of the process that failed (`rpcErrorBody` in
/// src/utils/rpc/errors.ts): the tool whose process answered (`meetings`, filled by that process, never typed at a
/// throw) and the short title the place that threw gave. The drafted title is `[<tool>] <title>`.
public struct FailureIssue: Codable, Equatable, Sendable {
    public var tool: String
    public var title: String?

    public init(tool: String, title: String? = nil) {
        self.tool = tool
        self.title = title
    }

    /// The `issue` member of a JSON-RPC error; nil when there is none or it names no tool.
    public init?(json: Any?) {
        guard let object = json as? [String: Any], let tool = object["tool"] as? String, !tool.isEmpty else { return nil }
        let title = (object["title"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.init(tool: tool, title: title?.isEmpty == false ? title : nil)
    }
}

/// What `tools genesis-tools triage --json` (or `env --json`) answered: the environment bullets, the bug form's fields in order (empty when
/// the checkout has no `.github/ISSUE_TEMPLATE/bug_report.yml`), and the environment answers by field id.
public struct FailureEnvironment: Codable, Equatable, Sendable {
    public struct Field: Codable, Equatable, Sendable {
        public var id: String
        public var label: String
        public var type: String
        public var render: String?

        public init(id: String, label: String, type: String, render: String? = nil) {
            self.id = id
            self.label = label
            self.type = type
            self.render = render
        }
    }

    public var markdown: String
    public var fields: [Field]
    public var values: [String: String]

    public init(markdown: String, fields: [Field] = [], values: [String: String] = [:]) {
        self.markdown = markdown
        self.fields = fields
        self.values = values
    }

    public static func parse(json: String) -> FailureEnvironment? {
        guard let data = json.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        let issue = object["issue"] as? [String: Any]
        let fields = (issue?["fields"] as? [[String: Any]] ?? []).compactMap { row -> Field? in
            guard let id = row["id"] as? String, let label = row["label"] as? String else { return nil }
            return Field(id: id, label: label, type: row["type"] as? String ?? "textarea", render: row["render"] as? String)
        }
        return FailureEnvironment(markdown: object["markdown"] as? String ?? "", fields: fields,
                                  values: issue?["values"] as? [String: String] ?? [:])
    }

    /// Runs `tools genesis-tools triage --json`: the build facts of `env` and the state of the Mac at this moment
    /// (load, memory pressure, top CPU and memory, whether the hub server answers, the app faces, the commands that
    /// failed and the calls that were slow just before). A checkout without `triage` answers through `env --json`,
    /// which has the same shape without the state. Nil when both fail.
    public static func load(bridge: ToolsBridge = ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())) async -> FailureEnvironment? {
        let deadline = Date().addingTimeInterval(4)
        for command in ["triage", "env"] {
            let remaining = Int(deadline.timeIntervalSinceNow.rounded(.down))
            guard remaining > 0 else { break }
            if let run = try? await bridge.run(subcommand: "genesis-tools", args: [command, "--json"], timeoutSeconds: remaining),
               run.exitCode == 0, let environment = parse(json: run.stdout) {
                return environment
            }
        }
        return nil
    }
}
