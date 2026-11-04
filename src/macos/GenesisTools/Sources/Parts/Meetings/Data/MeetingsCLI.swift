import Foundation

/// The one way this part reads and changes meetings: `tools meetings …` through GenesisKit's `ToolsBridge` (the
/// resident server when it has the door, else a process). No Swift copy of any meetings rule lives here.
enum MeetingsCLI {
    /// Resolved at each call, so `GENESIS_TOOLS_BIN` (a worktree's `tools`) and a moved checkout apply at once.
    static let bridge = ToolsBridge(resolveBinaryPath: { ToolsBridge.defaultBinaryPath() })

    /// A failed command: one sentence for the pane, the CLI's own text for Details.
    struct Failure: Error, CustomStringConvertible, Equatable {
        let sentence: String
        let detail: String
        var description: String { sentence }
    }

    /// Runs `tools meetings <args>`; stdout on success. A nonzero exit throws its last stderr line as the sentence.
    static func run(_ args: [String], timeoutSeconds: Int = 60) async throws -> Data {
        let span = HubPerf.begin("meetings.cli", args.prefix(2).joined(separator: " "))
        let result: ToolsRunResult
        do {
            result = try await bridge.run(subcommand: "meetings", args: args, timeoutSeconds: timeoutSeconds)
        } catch {
            span.end("failed")
            throw Failure(sentence: "The meetings command did not start.", detail: "\(error)")
        }
        guard result.exitCode == 0 else {
            span.end("exit \(result.exitCode)")
            throw Failure(sentence: sentence(fromStderr: result.stderr) ?? "The meetings command failed.",
                          detail: "tools meetings \(args.joined(separator: " ")) exited \(result.exitCode):\n\(result.stderr)")
        }
        span.end()
        return Data(result.stdout.utf8)
    }

    /// Runs a `--json` command and decodes its stdout.
    static func json<T: Decodable>(_ type: T.Type, _ args: [String], timeoutSeconds: Int = 60) async throws -> T {
        let data = try await run(args, timeoutSeconds: timeoutSeconds)
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw Failure(
                sentence: "The app and the tools command expect different formats. Updating both usually fixes it.",
                detail: "tools meetings \(args.joined(separator: " ")): \(error)\n\(String(decoding: data.prefix(1500), as: UTF8.self))")
        }
    }

    /// The CLI's own message: its last `✗` line, else its last non-empty line, without colour codes.
    static func sentence(fromStderr stderr: String) -> String? {
        let lines = stderr.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let marked = lines.last { $0.hasPrefix("✗") }.map { String($0.dropFirst()).trimmingCharacters(in: .whitespaces) }
        guard let line = marked ?? lines.last else { return nil }
        return line.prefix(1).uppercased() + line.dropFirst() + (line.hasSuffix(".") ? "" : ".")
    }

    /// A JSON value as one command-line argument (`config set <path> <json>`). A number is written in its shortest
    /// form: JSONSerialization wrote 0.05 as 0.050000000000000003, and that text would land in the config file.
    static func jsonArgument(_ value: Any) -> String {
        if let number = value as? Double, number.isFinite { return number == number.rounded() && abs(number) < 1e15 ? String(Int(number)) : "\(number)" }
        if let number = value as? Int { return String(number) }
        guard JSONSerialization.isValidJSONObject([value]),
              let data = try? JSONSerialization.data(withJSONObject: [value], options: [.withoutEscapingSlashes]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return String(text.dropFirst().dropLast())
    }

    /// A config path as the JSON array the CLI takes, so a project name with a dot stays one key.
    static func path(_ segments: String...) -> String {
        jsonArgument(segments)
    }
}
