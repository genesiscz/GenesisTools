import Foundation

// The output contract every `tools ai usage … --json` verb prints (design section 6, src/utils/ai/usage/contract/):
// one envelope, `schema` names the verb and its shape version, `data` is the verb's own shape. Swift reads only these
// doors (or the hub server's copy of them); it never opens the usage SQLite store or a transcript itself. `Codable`
// ignores keys it does not know, so a field the CLI adds later breaks no decoder.

/// One account of one provider. `accountId` is the stable key, `accountName` the label a person renamed it to.
public struct UsageAccountKey: Codable, Hashable, Sendable, Identifiable {
    public let provider: String
    public let accountId: String
    public let accountName: String

    public init(provider: String, accountId: String, accountName: String) {
        self.provider = provider
        self.accountId = accountId
        self.accountName = accountName
    }

    /// Keyed by provider and account: two providers may each have an account called "work".
    public var id: String { provider + "\u{1}" + accountId }
}

/// A sentence the CLI wants shown ("12 events are unpriced"): never dropped, never turned into a number.
public struct UsageWarning: Codable, Equatable, Sendable, Identifiable {
    public let code: String
    public let message: String
    /// The code and the message: one code can come with two messages, and each is its own row.
    public var id: String { code + "\u{1}" + message }

    /// The warnings of several doors in their order, each code and message once: two doors that both miss the
    /// history say so once. The rows keep distinct `id`s, so a list can show them.
    public static func merged(_ lists: [[UsageWarning]]) -> [UsageWarning] {
        var seen = Set<String>()
        return lists.flatMap { $0 }.filter { seen.insert($0.id).inserted }
    }
}

/// The span a verb read. Instants are ISO UTC; `tz` is the zone its day keys were cut in.
public struct UsageWindowRange: Codable, Equatable, Sendable {
    public let from: String
    public let to: String
    public let tz: String
    public let label: String
}

/// `{ schema, generatedAt, window?, selector, data, warnings }`.
public struct UsageEnvelope<T: Decodable & Sendable>: Decodable, Sendable {
    public let schema: String
    public let generatedAt: String
    public let window: UsageWindowRange?
    public let data: T
    public let warnings: [UsageWarning]

    private enum CodingKeys: String, CodingKey { case schema, generatedAt, window, data, warnings }

    public init(schema: String, generatedAt: String, window: UsageWindowRange? = nil, data: T, warnings: [UsageWarning] = []) {
        self.schema = schema
        self.generatedAt = generatedAt
        self.window = window
        self.data = data
        self.warnings = warnings
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schema = try container.decode(String.self, forKey: .schema)
        generatedAt = try container.decode(String.self, forKey: .generatedAt)
        window = try container.decodeIfPresent(UsageWindowRange.self, forKey: .window)
        data = try container.decode(T.self, forKey: .data)
        warnings = try container.decodeIfPresent([UsageWarning].self, forKey: .warnings) ?? []
    }

    /// The verb part of `schema` ("usage.limits.series@1" → "usage.limits.series").
    public var verb: String { String(schema.split(separator: "@").first ?? "") }
}

extension UsageEnvelope: Equatable where T: Equatable {}

/// The instants the CLI prints: `2026-11-03T05:08:04.922Z`, and the provider's own `2026-11-04T19:00:00.011935+00:00`
/// (six fraction digits, which `ISO8601DateFormatter` refuses). Parsed once into a `Date`; nil for an empty or odd value.
public enum UsageTime {
    private static let withFraction: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let plain = ISO8601DateFormatter()

    public static func date(_ value: String?) -> Date? {
        guard let value, !value.isEmpty else { return nil }
        if let date = withFraction.date(from: value) ?? plain.date(from: value) { return date }
        return trimmedFraction(value).flatMap { withFraction.date(from: $0) }
    }

    /// `…:00.011935+00:00` → `…:00.011+00:00`: the formatter reads milliseconds only.
    static func trimmedFraction(_ value: String) -> String? {
        guard let dot = value.firstIndex(of: ".") else { return nil }
        let digits = value[value.index(after: dot)...].prefix { $0.isNumber }
        guard digits.count > 3 else { return nil }
        let rest = value[value.index(dot, offsetBy: digits.count + 1)...]
        return String(value[..<dot]) + "." + digits.prefix(3) + rest
    }

    public static func iso(_ date: Date) -> String { withFraction.string(from: date) }
}

/// The share of a span's spend one session took (`SessionShare` in src/utils/ai/usage/attribution/spend-share.ts).
public struct UsageSessionShare: Codable, Equatable, Sendable, Identifiable {
    public let agent: String
    public let sessionId: String
    public let project: String
    public let costUsd: Double
    public let mainUsd: Double?
    public let subagentUsd: Double?
    public let tokens: Double?
    public let share: Double
    public let basis: String?
    public let approximate: Bool?
    /// The command that opens the session's own report.
    public let next: String?
    /// Points of the bar this session ate, where the verb converts dollars into points.
    public let barPercent: Double?

    public var id: String { agent + ":" + sessionId }
}

/// The spend of a span no account claims: no pin, or a home that names no account.
public struct UsageUnattributed: Codable, Equatable, Sendable {
    public let costUsd: Double
    public let tokens: Double?
    public let share: Double
}
