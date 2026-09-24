// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/SessionTranscriptClient.swift at 2026-09-24T05:05:15+02:00 at commit hash 786292605d31a39fe795dafe34fb0f8d6f96d0a1
import Foundation

public struct TranscriptTool: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var name: String
    public var inputPreview: String
    public var result: String?
    public var isError: Bool
    /// Process exit status when the tool ran a command. Absent on older payloads.
    public var exitCode: Int?
    /// Length of the full result before GenesisTools clipped it, so a reader knows what was cut.
    public var resultChars: Int?
}

/// What one model call cost. Present on assistant turns; a user turn has none.
public struct TranscriptUsage: Equatable, Sendable, Codable {
    public var inputTokens: Int?
    public var cacheReadTokens: Int?
    public var outputTokens: Int?
    public var reasoningTokens: Int?

    public init(inputTokens: Int? = nil, cacheReadTokens: Int? = nil, outputTokens: Int? = nil, reasoningTokens: Int? = nil) {
        self.inputTokens = inputTokens
        self.cacheReadTokens = cacheReadTokens
        self.outputTokens = outputTokens
        self.reasoningTokens = reasoningTokens
    }
}

/// Every model call in the window, summed. `modelCalls` is the count, not a token figure.
public struct TranscriptTotals: Equatable, Sendable, Codable {
    public var modelCalls: Int?
    public var inputTokens: Int?
    public var cacheReadTokens: Int?
    public var outputTokens: Int?
    public var reasoningTokens: Int?
    /// Booked cost in USD, when the provider reports one. Never derived here.
    public var costUsd: Double?

    public init(modelCalls: Int? = nil, inputTokens: Int? = nil, cacheReadTokens: Int? = nil, outputTokens: Int? = nil, reasoningTokens: Int? = nil, costUsd: Double? = nil) {
        self.modelCalls = modelCalls
        self.inputTokens = inputTokens
        self.cacheReadTokens = cacheReadTokens
        self.outputTokens = outputTokens
        self.reasoningTokens = reasoningTokens
        self.costUsd = costUsd
    }
}

extension TranscriptUsage {
    /// `in 2.3K · cache 81.8K · out 911 · reasoning 36`, skipping what is absent.
    ///
    /// Same rule as `TranscriptTotals.summary`: a zero is dropped, because `reasoning 0` reads
    /// as a measurement of the model's thinking and it is an absence of one.
    public var summary: String? {
        let parts: [String] = [
            ("in", inputTokens),
            ("cache", cacheReadTokens),
            ("out", outputTokens),
            ("reasoning", reasoningTokens),
        ]
        .filter { ($0.1 ?? 0) > 0 }
        .map { "\($0.0) \(TranscriptTotals.tokens($0.1 ?? 0))" }

        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

extension TranscriptTotals {
    /// `12 calls · in 51.6K · cache 2.4M · out 12.7K · reasoning 2.8K`, skipping what is absent.
    ///
    /// A zero is dropped rather than printed: `reasoning 0` on a model that reports no
    /// reasoning reads as a measurement, and it is an absence of one. In the kit rather than
    /// the view so it can be tested — the whole reason these four fields went unnoticed for
    /// months is that nothing failed when they were missing.
    public var summary: String? {
        var parts: [String] = []

        if let calls = modelCalls, calls > 0 {
            parts.append("\(calls) call\(calls == 1 ? "" : "s")")
        }
        for (label, value) in [
            ("in", inputTokens),
            ("cache", cacheReadTokens),
            ("out", outputTokens),
            ("reasoning", reasoningTokens),
        ] where (value ?? 0) > 0 {
            parts.append("\(label) \(TranscriptTotals.tokens(value ?? 0))")
        }

        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// A token COUNT: `911`, `1.2K`, `2.4M`.
    ///
    /// Not `TitleFormatter.formatCtx`, which renders `1.2k ctx` — that suffix means a context
    /// SIZE, and these are per-call token counts. Printing one as the other invents a meaning.
    public static func tokens(_ value: Int) -> String {
        if value >= 1_000_000 {
            return String(format: "%.1fM", Double(value) / 1_000_000)
        }
        if value >= 1000 {
            return String(format: "%.1fK", Double(value) / 1000)
        }
        return String(value)
    }
}

public struct TranscriptTurn: Equatable, Sendable, Codable, Identifiable {
    public var id: String
    public var role: String
    public var at: String?
    public var text: String
    public var tools: [TranscriptTool]
    /// The model's own reasoning for this turn, when the provider records it.
    public var reasoning: String?
    /// This call's token cost. Absent on a user turn, and on a provider that reports none.
    public var usage: TranscriptUsage?
}

public struct TranscriptEnvelope: Equatable, Sendable, Codable {
    public var provider: String
    public var sessionId: String
    public var filePath: String
    public var byteSize: Int
    public var truncated: Bool
    public var nextOffset: Int
    public var turns: [TranscriptTurn]
    /// Summed cost of the window. Absent on a provider that reports no usage at all.
    public var totals: TranscriptTotals?
    /// How the session ended, when it has. `nil` means it is still open, and is a real answer.
    public var terminated: String?

    /// Turn index of the first turn in this window. `nextOffset` is the index after the last one.
    public var windowStart: Int { max(0, nextOffset - turns.count) }
}

public enum SessionTranscriptClient {
    /// `offset` is a turn index. nil asks for the last `limit` turns, which is what a first open wants;
    /// a "load earlier" page passes the window start minus the page size.
    public static func arguments(sessionId: String, limit: Int = 80, offset: Int? = nil) -> [String] {
        var args = ["sessions", "tail", sessionId, "--json", "--limit", String(limit)]
        if let offset {
            args += ["--offset", String(max(0, offset))]
        }
        return args
    }

    public static func decode(_ data: Data) throws -> TranscriptEnvelope {
        let payload = try MonitorJSON.dataByDroppingPreamble(data)
        return try JSONDecoder().decode(TranscriptEnvelope.self, from: payload)
    }

    public static func fetch(
        using bridge: ToolsBridge,
        sessionId: String,
        limit: Int = 80,
        offset: Int? = nil
    ) async throws -> TranscriptEnvelope {
        let result = try await bridge.run(
            subcommand: "ai",
            args: arguments(sessionId: sessionId, limit: limit, offset: offset),
            timeoutSeconds: 30,
            extraEnv: ["PROFILE": "ai-transcript"]
        )
        if result.exitCode != 0 {
            let detail = MonitorJSON.preview(result.stderr)
            throw ToolsBridgeError.refused(
                detail.isEmpty
                    ? "tools ai sessions tail exited \(result.exitCode)"
                    : "tools ai sessions tail: \(detail)"
            )
        }
        do {
            return try decode(Data(result.stdout.utf8))
        } catch {
            // The command "succeeded" and produced something we cannot read.
            // Name the command and quote the output: the banner used to say
            // only "expected JSON object", which told the reader nothing.
            throw ToolsBridgeError.refused(
                "tools ai sessions tail returned unreadable output — "
                    + MonitorJSON.failureDetail(error, stdout: result.stdout, stderr: result.stderr)
            )
        }
    }
}
