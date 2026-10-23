import Foundation

/// The cmux CLI for every part that opens a session or a command in a pane: the hub's `CmuxHost` and the widget's cmux
/// button. One binary lookup, the new workspace / pane / tab / type-into-a-tab moves, and the reading of
/// `tools <agent> cmux focus --json`. Blocking (each call spawns a process): call it off the main thread.
public enum CmuxCommandRunner {
    public static var binary: String? {
        ["/Applications/cmux.app/Contents/Resources/bin/cmux", "~/.local/bin/cmux", "/usr/local/bin/cmux", "/opt/homebrew/bin/cmux"]
            .map { ($0 as NSString).expandingTildeInPath }
            .first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    @discardableResult
    public static func cmux(_ args: [String]) -> (ok: Bool, out: String) {
        guard let binary else { return (false, "cmux is not installed") }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = args
        var environment = ProcessInfo.processInfo.environment
        environment["CMUX_QUIET"] = "1"
        process.environment = environment
        guard let result = try? process.runCapturing() else { return (false, "cmux failed to start") }
        let text = String(decoding: result.stdout, as: UTF8.self)
        return (result.status == 0, result.status == 0 ? text : String(decoding: result.stderr, as: UTF8.self) + text)
    }

    /// Runs `command` in `cwd` at `target`. An error message, or nil when it opened. Words are shell-quoted here because
    /// cmux takes one command string.
    public static func run(_ command: [String], cwd: String, name: String, at target: CmuxTarget) -> String? {
        let words = command.map(ShellWords.word).joined(separator: " ")
        let line = cwd.isEmpty ? words : "cd \(ShellWords.word(cwd)) && \(words)"
        switch target {
        case .newWorkspace(let window):
            let result = cmux(["new-workspace", "--name", name, "--cwd", cwd, "--command", words, "--focus", "true"]
                + (window.map { ["--window", $0] } ?? []))
            return result.ok ? nil : result.out.trimmed
        case .newPane(let workspace):
            return typeInto(cmux(["new-pane", "--type", "terminal", "--direction", "right", "--workspace", workspace,
                                  "--focus", "true"]), workspace: workspace, line: line)
        case .newTab(let workspace, let pane):
            return typeInto(cmux(["new-surface", "--type", "terminal", "--workspace", workspace, "--pane", pane,
                                  "--focus", "true"]), workspace: workspace, line: line)
        case .surface(let workspace, let surface):
            return send(line, workspace: workspace, surface: surface)
        }
    }

    /// new-surface / new-pane print the new surface ref; the command is typed into it, then Enter.
    private static func typeInto(_ created: (ok: Bool, out: String), workspace: String, line: String) -> String? {
        guard created.ok else { return created.out.trimmed }
        guard let range = created.out.range(of: #"surface:\d+"#, options: .regularExpression) else {
            return "cmux did not report the new surface: \(created.out.trimmed)"
        }
        return send(line, workspace: workspace, surface: String(created.out[range]))
    }

    private static func send(_ line: String, workspace: String, surface: String) -> String? {
        let sent = cmux(["send", "--workspace", workspace, "--surface", surface, line])
        guard sent.ok else { return sent.out.trimmed }
        let enter = cmux(["send-key", "--workspace", workspace, "--surface", surface, "Enter"])
        return enter.ok ? nil : enter.out.trimmed
    }

    /// The command that resumes an agent session in a terminal, or nil for an agent with none.
    public static func resumeCommand(provider: String, sessionId: String) -> [String]? {
        switch provider {
        case "claude": return ["tools", "claude", "resume", sessionId]
        case "codex": return ["codex", "resume", sessionId]
        case "grok": return ["grok", "--resume", sessionId]
        default: return nil
        }
    }

    /// The `tools <agent>` that owns a session's cmux resolver: `tools codex cmux` and `tools grok cmux` know their own
    /// history (Grok has no journal and its own fallback); anything else goes through Claude's.
    public static func tool(provider: String?) -> String {
        switch provider {
        case "codex", "grok": return provider ?? "claude"
        default: return "claude"
        }
    }

    public static let paneGone = "That cmux pane is gone. Choose a pane to resume the session in."

    /// What `tools <agent> cmux focus --json` said, in words: nil when it focused. A recorded tab that was closed
    /// answers `gone`; before, the hub and Genesis showed cmux's raw "[socket] RPC error".
    public static func focusFailure(status: Int32, stdout: Data, stderr: Data) -> String? {
        guard status != 0 else { return nil }
        struct Opaque: Decodable {
            init(from decoder: Decoder) throws {}
        }
        struct Result: Decodable {
            let gone: Bool?
            let matches: [Opaque]?
        }
        if let result = try? JSONDecoder().decode(Result.self, from: stdout) {
            if result.gone == true {
                return paneGone
            }
            if result.matches?.isEmpty == true {
                return "No cmux pane shows this session. Choose a pane to resume it in."
            }
        }
        let lines = String(decoding: stderr, as: UTF8.self).split(whereSeparator: \.isNewline)
        let said = lines.map { $0.trimmingCharacters(in: CharacterSet(charactersIn: "│■▲● ").union(.whitespaces)) }
            .last { !$0.isEmpty }
        return said.map { String($0) } ?? "tools claude cmux focus exited \(status)"
    }

    /// `open-session --json` reports a failure as {ok: false, error} on stdout, with stderr empty.
    public static func openSessionFailure(status: Int32, stdout: Data, stderr: Data) -> String? {
        guard status != 0 else { return nil }
        struct Failure: Decodable { let error: String }
        if let failure = try? JSONDecoder().decode(Failure.self, from: stdout) {
            return failure.error
        }
        let text = String(decoding: stderr, as: UTF8.self).trimmed
        return text.isEmpty ? "tools claude cmux open-session exited \(status)" : String(text.suffix(300))
    }
}
