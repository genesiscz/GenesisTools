import Foundation

/// What the app knows about its own build, for a report an agent acts on: the version, and the checkout, branch and
/// commit the installed bundle was built from (`~/.genesis-tools/app/manifest.json`, written by every build).
public struct FailureAppFacts: Equatable, Sendable {
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
    public static func current(home: String = NSHomeDirectory(), bundle: Bundle = .main) -> FailureAppFacts {
        let name = bundle.object(forInfoDictionaryKey: "CFBundleName") as? String ?? "GenesisTools"
        var facts = FailureAppFacts(name: name, version: bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String)
        let manifest = URL(fileURLWithPath: home).appendingPathComponent(".genesis-tools/app/manifest.json")
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
public struct FailureReport: Equatable, Sendable {
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

    public init(title: String = "Failed", headline: String, summary: String? = nil, nextStep: String? = nil,
                action: String? = nil, command: String? = nil, exitStatus: Int32? = nil, folder: String? = nil,
                logFile: String? = nil, logLine: Int? = nil, dayLog: String? = nil, log: String = "", time: Date = Date(),
                app: FailureAppFacts? = nil) {
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
    }

    public var hasLog: Bool { !log.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// `<home>/.genesis-tools/logs/<local date>.log`, the file every `tools` process and the app log to that day.
    public static func dayLogPath(home: String = NSHomeDirectory(), time: Date = Date(), timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd"
        return URL(fileURLWithPath: home).appendingPathComponent(".genesis-tools/logs/\(formatter.string(from: time)).log").path
    }

    // MARK: - Markdown

    /// A markdown block an agent can act on without asking: the failure, what ran, when, where, which build, and the
    /// whole output with its stacks.
    public func agentContext(timeZone: TimeZone = .current) -> String {
        let formatter = DateFormatter()
        // en_GB names the zone ("CET", "CEST"); en_US_POSIX prints "GMT+1".
        formatter.locale = Locale(identifier: "en_GB")
        formatter.timeZone = timeZone
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss zzz"

        var lines = ["## \(app?.name ?? "GenesisTools") failure: \(headline)", ""]
        if let summary {
            lines += [summary, ""]
        }
        if let action, let command {
            lines.append("- **What ran:** \(action): `\(command)`")
        } else if let what = action ?? command.map({ "`\($0)`" }) {
            lines.append("- **What ran:** \(what)")
        }
        if let exitStatus {
            lines.append("- **Exit status:** \(exitStatus)")
        }
        lines.append("- **When:** \(formatter.string(from: time))")
        if let folder {
            let gone = FileManager.default.fileExists(atPath: folder) ? "" : " (no longer on disk)"
            lines.append("- **Recording folder:** `\(folder)`\(gone)")
        }
        if let app {
            lines.append("- **App:** \(app.line)")
        }
        if let logFile {
            lines.append("- **This run's log:** `\(logFile)`" + (logLine.map { " (from line \($0))" } ?? ""))
        }
        if let dayLog {
            lines.append("- **Day log:** `\(dayLog)`")
        }
        if hasLog {
            lines += ["", "### Output", "", "```text", log.trimmingCharacters(in: .newlines), "```"]
        }
        return lines.joined(separator: "\n") + "\n"
    }

    /// The notice's details under its headline (which is the error, so it is not repeated): each warning with its
    /// fields and pretty JSON (an error's stack folded to its first frame), then every step of the log on one line
    /// each. A log with no entries is shown as it came.
    public func detailsMarkdown() -> String {
        let events = FailureLog.events(in: log)
        var lines: [String] = []

        let warnings = events.filter { $0.level == .warning || ($0.level == .error && (!$0.fields.isEmpty || !$0.stack.isEmpty)) }
        if !warnings.isEmpty {
            lines += ["### Warnings (\(warnings.count))"]
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
        return lines.joined(separator: "\n") + "\n"
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
