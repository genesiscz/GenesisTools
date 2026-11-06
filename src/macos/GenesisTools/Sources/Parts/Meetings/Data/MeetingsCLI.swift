import Foundation

/// The one way this part reads and changes meetings: `tools meetings …` through GenesisKit's `ToolsBridge` (the
/// resident server when it has the door, else a process). No Swift copy of any meetings rule lives here.
enum MeetingsCLI {
    /// The resident hub server answers the window's reads (src/hub/server/doors/meetings.ts) without a `tools` process
    /// each: about 330 ms of CPU per read went to starting the process (2026-11-06). Every other argv, and a read the
    /// door declines, still runs the process. The server reads the real home's store with the main checkout's code, so
    /// a window on a sandbox home (`GENESIS_TOOLS_HOME`), on a worktree's `tools` (`GENESIS_TOOLS_BIN`), the preview
    /// build and `GENESIS_HUB_SERVER=0` keep processes only.
    static let server: ToolsServerClient? = {
        let environment = ProcessInfo.processInfo.environment
        guard !NativePreview.enabled, environment["GENESIS_HUB_SERVER"] != "0",
              environment["GENESIS_TOOLS_HOME"] == nil, environment["GENESIS_TOOLS_BIN"] == nil else { return nil }
        return ToolsServerClient(startServer: { ToolsServerClient.startHubServer(binaryPath: ToolsBridge.defaultBinaryPath()) })
    }()

    /// Resolved at each call, so `GENESIS_TOOLS_BIN` (a worktree's `tools`) and a moved checkout apply at once.
    static let bridge = ToolsBridge(resolveBinaryPath: { ToolsBridge.defaultBinaryPath() }, server: server)

    /// A failed command: one sentence for the pane, the CLI's own text for Details, and the conflict code a refused
    /// write names (`✗ [config-stale] …`, src/utils/meetings/conflict.ts), so the pane can answer it.
    struct Failure: Error, CustomStringConvertible, Equatable {
        let sentence: String
        let detail: String
        var code: String? = nil
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
                          detail: "tools meetings \(args.joined(separator: " ")) exited \(result.exitCode):\n\(result.stderr)",
                          code: code(fromStderr: result.stderr))
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

    /// The CLI's own message: its last `✗` line, else its last non-empty line, without colour codes and without the
    /// conflict code in front.
    static func sentence(fromStderr stderr: String) -> String? {
        guard var line = errorLine(stderr) else { return nil }
        if let code = leadingCode(line) { line = String(line.dropFirst(code.count + 2)).trimmingCharacters(in: .whitespaces) }
        guard !line.isEmpty else { return nil }
        return line.prefix(1).uppercased() + line.dropFirst() + (line.hasSuffix(".") ? "" : ".")
    }

    /// The conflict code of the CLI's `✗ [code] …` line, if it has one.
    static func code(fromStderr stderr: String) -> String? {
        errorLine(stderr).flatMap(leadingCode)
    }

    private static func errorLine(_ stderr: String) -> String? {
        let lines = stderr.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
            .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        let marked = lines.last { $0.hasPrefix("✗") }.map { String($0.dropFirst()).trimmingCharacters(in: .whitespaces) }
        return marked ?? lines.last
    }

    private static func leadingCode(_ line: String) -> String? {
        guard let match = line.range(of: "^\\[[a-z0-9-]+\\]", options: .regularExpression) else { return nil }
        return String(line[match].dropFirst().dropLast())
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
