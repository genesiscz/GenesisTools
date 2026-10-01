import Foundation

// From GenesisAIMonitorKit SessionListClient.swift, 2026-09-30: every `tools` JSON reader in both
// apps goes through it.

public enum MonitorJSON {
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
    public static func dataByDroppingPreamble(_ data: Data) throws -> Data {
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
    public static func failureDetail(_ error: Error, stdout: String, stderr: String) -> String {
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
    public static func describe(_ error: DecodingError) -> String {
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
    public static func preview(_ text: String, limit: Int = 200) -> String {
        let flat = text
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
            .joined(separator: " ⏎ ")
        return flat.count <= limit ? flat : String(flat.prefix(limit)) + "…"
    }

}
