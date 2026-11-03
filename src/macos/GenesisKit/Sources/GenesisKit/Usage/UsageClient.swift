import Foundation

/// The time span a usage view reads: `--since` of every door that takes one.
public enum UsageRange: String, CaseIterable, Identifiable, Codable, Sendable {
    case sixHours = "6h", day = "24h", week = "7d", month = "30d"

    public var id: String { rawValue }
    public var title: String {
        switch self {
        case .sixHours: return "6 h"
        case .day: return "24 h"
        case .week: return "7 d"
        case .month: return "30 d"
        }
    }

    public var seconds: TimeInterval {
        switch self {
        case .sixHours: return 6 * 3600
        case .day: return 24 * 3600
        case .week: return 7 * 86400
        case .month: return 30 * 86400
        }
    }
}

/// The argv of each usage door, so every caller (the hub, the widget, Genesis) asks the CLI the same question.
/// Every door is read-only: none polls a provider (`limits` reads the last poll with `--cached`) and none writes.
public enum UsageDoor: Equatable, Sendable {
    case limits
    case series(UsageRange, step: String, agg: String)
    case health(UsageRange)
    case spikes(UsageRange)
    case events(UsageRange)
    case alerts
    case advise
    case attribution
    case drift
    case digest(week: Bool)
    case pivot(UsageRange, by: String)
    case plans
    case proxy
    case waste(UsageRange)
    case workers
    case sessionReport(id: String, harness: String?)

    /// The arguments after `tools`.
    public var argv: [String] {
        switch self {
        case .limits: return ["ai", "usage", "limits", "--cached", "--json"]
        case .series(let range, let step, let agg):
            return ["ai", "usage", "limits", "series", "--since", range.rawValue, "--step", step, "--agg", agg, "--json"]
        case .health(let range): return ["ai", "usage", "limits", "health", "--since", range.rawValue, "--json"]
        case .spikes(let range): return ["ai", "usage", "limits", "spikes", "--since", range.rawValue, "--json"]
        case .events(let range): return ["ai", "usage", "events", "--since", range.rawValue, "--json"]
        case .alerts: return ["ai", "usage", "alerts", "--json"]
        case .advise: return ["ai", "usage", "limits", "advise", "--json"]
        case .attribution: return ["ai", "usage", "limits", "attribution", "--json"]
        case .drift: return ["ai", "usage", "limits", "drift", "--json"]
        case .digest(let week): return ["ai", "usage", "digest", week ? "--week" : "--day", "--json"]
        case .pivot(let range, let by):
            return ["ai-spend", "pivot", "--since", range.rawValue, "--by", by, "--heatmap", "--json"]
        case .plans: return ["ai-spend", "plans", "--json"]
        case .proxy: return ["ai-spend", "proxy", "--json"]
        case .waste(let range): return ["ai-spend", "waste", "--since", range.rawValue, "--json"]
        case .workers: return ["ai-spend", "workers", "--by", "backend,model,outcome", "--json"]
        case .sessionReport(let id, let harness):
            return ["ai", "sessions", "report", id] + (harness.map { ["--provider", $0] } ?? []) + ["--json"]
        }
    }
}

public enum UsageClientError: Error, LocalizedError, Equatable {
    case schema(expected: String, got: String)

    public var errorDescription: String? {
        switch self {
        case .schema(let expected, let got): return "Expected \(expected), the CLI printed \(got)"
        }
    }
}

/// Runs a door and decodes it. `fetch` is the transport: the hub's server-first runner, the widget's `ToolsBridge`,
/// or a test's canned bytes.
public struct UsageClient: Sendable {
    public let fetch: @Sendable ([String]) async throws -> Data

    public init(fetch: @escaping @Sendable ([String]) async throws -> Data) {
        self.fetch = fetch
    }

    /// A client over `tools` at `binaryPath`, one process per call.
    public static func bridge(binaryPath: String, timeoutSeconds: Int = 60) -> UsageClient {
        let bridge = ToolsBridge(binaryPath: binaryPath)
        return UsageClient { argv in
            let result = try await bridge.run(subcommand: argv[0], args: Array(argv.dropFirst()), timeoutSeconds: timeoutSeconds)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(String(result.stderr.suffix(1200))) }
            return Data(result.stdout.utf8)
        }
    }

    /// An envelope door; the schema must name the verb the door asked for.
    public func envelope<T: Decodable & Sendable>(_ door: UsageDoor, as type: T.Type) async throws -> UsageEnvelope<T> {
        let data = try await fetch(door.argv)
        return try Self.decodeEnvelope(data, as: type, door: door)
    }

    public static func decodeEnvelope<T: Decodable & Sendable>(_ data: Data, as type: T.Type, door: UsageDoor) throws -> UsageEnvelope<T> {
        let envelope = try JSONDecoder().decode(UsageEnvelope<T>.self, from: data)
        if let expected = door.schemaVerb, envelope.verb != expected {
            throw UsageClientError.schema(expected: expected, got: envelope.schema)
        }
        return envelope
    }

    /// A door with its own shape (workers, the session report).
    public func plain<T: Decodable & Sendable>(_ door: UsageDoor, as type: T.Type) async throws -> T {
        try JSONDecoder().decode(T.self, from: try await fetch(door.argv))
    }
}

extension UsageDoor {
    /// The envelope verb the door prints; nil for a door that prints no envelope.
    public var schemaVerb: String? {
        switch self {
        case .limits: return "usage.limits"
        case .series: return "usage.limits.series"
        case .health: return "usage.limits.health"
        case .spikes: return "usage.limits.spikes"
        case .events: return "usage.events"
        case .alerts: return "usage.alerts"
        case .advise: return "usage.limits.advise"
        case .attribution: return "usage.limits.attribution"
        case .drift: return "usage.limits.drift"
        case .digest: return "usage.digest"
        case .pivot: return "usage.spend.pivot"
        case .plans: return "usage.spend.plans"
        case .proxy: return "usage.spend.proxy"
        case .waste: return "usage.spend.waste"
        case .workers, .sessionReport: return nil
        }
    }
}
