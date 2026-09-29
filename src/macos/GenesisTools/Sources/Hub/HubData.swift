import Foundation

// The hub's data layer is Genesis's (Hub/Stolen/*, copied from GenesisAIMonitorKit with provenance):
// `tools ai usage sessions --json --hours N` for the list (MonitorSessionRow: account pin, cmux
// ref, cache clock, tokens) and `tools ai sessions tail <id> --json` for transcripts of every
// provider (TranscriptEnvelope, grouped by TranscriptTimeline). This file only adapts them.

typealias HubSession = MonitorSessionRow

extension MonitorSessionRow {
    var lastActivity: Date? {
        mtime > 0 ? Date(timeIntervalSince1970: mtime / 1000) : nil
    }

    /// A warm prompt cache means the agent talked to the model within its TTL: the best "someone
    /// is working here" signal the providers give us.
    var isLive: Bool {
        if cacheStatus == .HOT {
            return true
        }

        guard let lastActivity else { return false }
        return Date().timeIntervalSince(lastActivity) < 10 * 60
    }
}

enum HubSource {
    static let bridge = ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())

    static func sessions(hours: Int) async throws -> [HubSession] {
        let span = HubPerf.begin("sessions.list", "hours=\(hours)", awaits: true)
        defer { span.end() }
        return try await SessionListClient.fetch(using: bridge, hours: hours).rows
    }

    static func transcript(_ session: HubSession, limit: Int) async throws -> TranscriptEnvelope {
        let span = HubPerf.begin("transcript.fetch", "limit=\(limit)", awaits: true)
        defer { span.end() }
        return try await SessionTranscriptClient.fetch(using: bridge, sessionId: session.sessionId, limit: limit)
    }
}

enum HubFormat {
    static let iso: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let isoPlain = ISO8601DateFormatter()

    static let relative: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    /// Formats against the moment it runs, so it goes stale on screen: a label is a `LiveAgo`
    /// (Hub/HubComponents.swift). This is for text that leaves the screen (an export, a copy).
    static func ago(_ date: Date?) -> String {
        guard let date else { return "" }
        return relative.localizedString(for: date, relativeTo: Date())
    }

    /// Parsed once per string. The Activity feed groups every event by day and hour on each body pass
    /// and its rows print each event's time, and the two parsers per call (fractional seconds, then
    /// plain) were 196 ms of main thread in a 35 s bench run over 70 events (2026-09-26 `sample`).
    static func date(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        let key = iso as NSString
        if let hit = parsed.object(forKey: key) {
            return hit.date
        }

        let date = Self.iso.date(from: iso) ?? isoPlain.date(from: iso)
        parsed.setObject(ParsedDate(date), forKey: key)
        return date
    }

    private final class ParsedDate {
        let date: Date?

        init(_ date: Date?) {
            self.date = date
        }
    }

    private static let parsed: NSCache<NSString, ParsedDate> = {
        let cache = NSCache<NSString, ParsedDate>()
        cache.countLimit = 20_000
        return cache
    }()
}

// The session's Decisions pane draws `InboxItem` (Hub/HubInbox.swift) through the same card as the
// Inbox; Hub/HubDecisionsSource.swift loads it, Hub/HubDecisionsPane.swift shows it.

/// A session's price from `tools ai-spend session --id <id> --json`: list prices over every model
/// call, subagents included. It is an estimate, and the UI says so; the session file has no price.
enum HubSpend {
    struct Estimate: Equatable {
        let usd: Double
        let note: String
    }

    private static let lock = NSLock()
    private static var cache: [String: Estimate] = [:]

    static func cached(_ sessionId: String) -> Estimate? {
        lock.lock()
        defer { lock.unlock() }
        return cache[sessionId]
    }

    /// `tools ai-spend session --json` stdout (src/ai-spend/lib/reports/session.ts); nil for no spend.
    static func estimate(from data: Data) -> Estimate? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let totals = object["totals"] as? [String: Any],
              let usd = totals["totalCost"] as? Double, usd > 0
        else { return nil }

        let rows = (object["session"] as? [[String: Any]])?.first?["modelBreakdowns"] as? [[String: Any]] ?? []
        let models = rows.compactMap { row -> String? in
            guard let name = row["modelName"] as? String, let cost = row["cost"] as? Double else { return nil }
            return "\(name) \(SessionFormat.usd(cost))"
        }
        let note = "List-price estimate by tools ai-spend (subagents included)" + (models.isEmpty ? "" : ": " + models.joined(separator: ", "))
        return Estimate(usd: usd, note: note)
    }

    /// Blocking (a `tools` run of several seconds): call it off the main thread only.
    static func fetch(_ session: HubSession) -> Estimate? {
        let since = Date(timeIntervalSince1970: session.mtime / 1000 - 14 * 86_400)
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyyMMdd"
        guard let data = try? ToolsCLIRunner.run(["ai-spend", "session", "--id", session.sessionId, "--json", "--since", day.string(from: since)]),
              let estimate = estimate(from: data)
        else {
            HubPerf.log("spend.session none for \(session.sessionId.prefix(8))")
            return nil
        }

        lock.lock()
        cache[session.sessionId] = estimate
        lock.unlock()
        return estimate
    }
}
