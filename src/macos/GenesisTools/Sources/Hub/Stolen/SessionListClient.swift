// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/lib/GenesisAIMonitorKit/Sources/GenesisAIMonitorKit/SessionListClient.swift at 2026-09-24T03:58:53+02:00 at commit hash 0d268a43e86e6e5e0ce16132aed8c862e201923e
import Foundation

public enum SessionListClient {
    public static func decode(_ data: Data) throws -> SessionListEnvelope {
        let payload = try MonitorJSON.dataByDroppingPreamble(data)
        return try JSONDecoder().decode(SessionListEnvelope.self, from: payload)
    }

    public static let defaultHours = 24

    /// `tools ai usage sessions`: every provider in one list. Claude, Codex and Grok
    /// rows carry a prompt-cache clock (1 h / 30 min / 30 min warning).
    public static let subcommand = "ai"

    public static func arguments(hours: Int = defaultHours, minRows: Int? = nil) -> [String] {
        var args = ["usage", "sessions", "--json", "--hours", String(hours)]
        if let minRows {
            args += ["--min", String(minRows)]
        }
        return args
    }

    public static func fetch(
        using bridge: ToolsBridge,
        hours: Int = defaultHours,
        minRows: Int? = nil,
        extraEnv: [String: String] = [:]
    ) async throws -> SessionListEnvelope {
        let result = try await bridge.run(
            subcommand: subcommand,
            args: arguments(hours: hours, minRows: minRows),
            timeoutSeconds: 60,
            extraEnv: extraEnv
        )
        if result.exitCode != 0 {
            throw ToolsBridgeError.refused(
                "usage sessions failed (exit \(result.exitCode)): \(MonitorJSON.preview(result.stderr))"
            )
        }
        do {
            return try decode(Data(result.stdout.utf8))
        } catch {
            throw ToolsBridgeError.refused(
                "tools ai usage sessions returned unreadable output — "
                    + MonitorJSON.failureDetail(error, stdout: result.stdout, stderr: result.stderr)
            )
        }
    }
}

enum MonitorJSON {
    /// A `tools` child may print a banner, a warning or a `[profile:…]` line
    /// before its JSON. Strip whatever comes first and hand back the object.
    ///
    /// Two things this must NOT do, because both reached the user as the bare
    /// string "expected JSON object" in a Session Details banner with no way
    /// to tell what went wrong (2026-09-10):
    ///  - take the first `{` in the stream on faith. A warning line that
    ///    happens to contain a brace made the decode start mid-noise, and the
    ///    reader got "the data couldn't be read" instead.
    ///  - throw away the output. The error now quotes what actually arrived,
    ///    which is the only thing that makes the banner actionable.
    static func dataByDroppingPreamble(_ data: Data) throws -> Data {
        if (try? JSONSerialization.jsonObject(with: data)) != nil {
            return data
        }
        let text = String(data: data, encoding: .utf8) ?? ""
        if text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw ToolsBridgeError.refused("the tools command printed nothing (expected JSON)")
        }
        // Every `{` is a candidate start, nearest first; the first one whose
        // tail actually parses wins.
        var searchFrom = text.startIndex
        var attempts = 0
        while attempts < 8, let idx = text[searchFrom...].firstIndex(of: "{") {
            attempts += 1
            let candidate = Data(text[idx...].utf8)
            if (try? JSONSerialization.jsonObject(with: candidate)) != nil {
                return candidate
            }
            guard idx < text.endIndex else { break }
            searchFrom = text.index(after: idx)
        }
        throw ToolsBridgeError.refused("no JSON object in the tools output — got: \(preview(text))")
    }

    /// One sentence naming why the output could not be read, with the output
    /// itself attached. `DecodingError.localizedDescription` alone is the
    /// useless "the data couldn't be read because it isn't in the correct
    /// format", which is what a reader saw in the Session Details banner.
    static func failureDetail(_ error: Error, stdout: String, stderr: String) -> String {
        var parts: [String] = []
        if let refused = error as? ToolsBridgeError, case .refused(let message) = refused {
            parts.append(message)
        } else if let decoding = error as? DecodingError {
            parts.append(describe(decoding))
        } else {
            parts.append(error.localizedDescription)
        }
        let out = preview(stdout, limit: 160)
        if !out.isEmpty { parts.append("stdout: \(out)") }
        let err = preview(stderr, limit: 160)
        if !err.isEmpty { parts.append("stderr: \(err)") }
        return parts.joined(separator: " · ")
    }

    /// `DecodingError` says which key or type broke; keep that, drop the rest.
    static func describe(_ error: DecodingError) -> String {
        func path(_ context: DecodingError.Context) -> String {
            let keys = context.codingPath.map(\.stringValue).filter { !$0.isEmpty }
            return keys.isEmpty ? "the root" : keys.joined(separator: ".")
        }
        switch error {
        case .keyNotFound(let key, let context):
            return "missing key \(key.stringValue) at \(path(context))"
        case .typeMismatch(let type, let context):
            return "expected \(type) at \(path(context))"
        case .valueNotFound(let type, let context):
            return "no value for \(type) at \(path(context))"
        case .dataCorrupted(let context):
            return "malformed JSON at \(path(context))"
        @unknown default:
            return "could not decode the response"
        }
    }

    /// A short, single-line quote of the output for an error message.
    static func preview(_ text: String, limit: Int = 200) -> String {
        let flat = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ⏎ ")
        return flat.count <= limit ? flat : String(flat.prefix(limit)) + "…"
    }

    static func decodeScored(_ data: Data) throws -> ScoredUsageEnvelope {
        let payload = try dataByDroppingPreamble(data)
        return try JSONDecoder().decode(ScoredUsageEnvelope.self, from: payload)
    }
}
