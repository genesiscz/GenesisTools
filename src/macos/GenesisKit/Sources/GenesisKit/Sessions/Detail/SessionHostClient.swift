import Foundation
import GenesisKitBase

/// What a session window can do where a session lives. GenesisTools' host table decides what each one means: a cmux
/// pane raises or types, a T3 Code thread opens in T3 Code or takes a message.
public enum SessionHostAction: String, CaseIterable, Sendable {
    case focus
    case wake
    case keepalive
}

/// Asks GenesisTools where sessions live and acts there (`tools ai session-host`, src/ai/lib/session-host). The
/// window never names a host: it shows the answer and sends the action back.
public struct SessionHostClient {
    public typealias Runner = (_ args: [String], _ timeoutSeconds: Int) async throws -> ToolsRunResult

    private let runner: Runner

    public init(runner: @escaping Runner) {
        self.runner = runner
    }

    /// Through a `ToolsBridge`: its resident server when it has one, else a process.
    public init(bridge: ToolsBridge) {
        self.runner = { args, timeout in try await bridge.run(subcommand: "ai", args: args, timeoutSeconds: timeout) }
    }

    /// One answer per id, in order: each session's host, or the reason none holds it.
    public func describe(_ sessionIds: [String]) async throws -> [SessionHostAnswer] {
        let result = try await runner(["session-host", "describe"] + sessionIds + ["--json"], 20)
        guard result.exitCode == 0 else {
            throw ToolsBridgeError.refused("session-host describe failed: \(MonitorJSON.failureReason(result.stderr))")
        }
        return try JSONDecoder().decode(SessionHostAnswers.self, from: MonitorJSON.dataByDroppingPreamble(Data(result.stdout.utf8))).answers
    }

    /// Performs the action through the session's host. Every answer of the CLI comes back as a result: a refusal (no
    /// host, the action is off, the host failed) is `ok: false` with its reason, and a CLI that printed no JSON (an
    /// older `tools`, a crash) gives its first stderr line as the reason. Only the runner's own failure throws.
    public func act(_ action: SessionHostAction, sessionId: String) async throws -> SessionHostActResult {
        let result = try await runner(["session-host", action.rawValue, sessionId, "--json"], 45)
        if let data = try? MonitorJSON.dataByDroppingPreamble(Data(result.stdout.utf8)),
           let answer = try? JSONDecoder().decode(SessionHostActResult.self, from: data) {
            return answer
        }
        return SessionHostActResult(ok: false, reason: Self.reason(fromStderr: result.stderr))
    }

    /// The first stderr line that is not a profiler timing, without the CLI's leading status glyph.
    public static func reason(fromStderr stderr: String) -> String {
        let line = stderr
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .first { !$0.isEmpty && !$0.hasPrefix("[profile:") }
        guard let line else { return "the tools CLI reported no detail" }
        return line.hasPrefix("✘ ") ? String(line.dropFirst(2)) : line
    }
}
