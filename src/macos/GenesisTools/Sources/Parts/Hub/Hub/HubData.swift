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
    var isLive: Bool { isLive(at: Date()) }

    func isLive(at now: Date) -> Bool {
        if cacheStatus == .HOT {
            return true
        }

        guard let lastActivity else { return false }
        return now.timeIntervalSince(lastActivity) < 10 * 60
    }
}

enum HubSource {
    /// The resident hub server (`tools hub serve`, src/hub/server): the hub asks it first and runs a `tools`
    /// process only when it cannot answer. Started on demand; `GENESIS_HUB_SERVER=0` turns it off.
    static let server: ToolsServerClient? = {
        guard !NativePreview.enabled, ProcessInfo.processInfo.environment["GENESIS_HUB_SERVER"] != "0" else { return nil }
        return ToolsServerClient(startServer: { HubServerStarter.start() })
    }()

    static let bridge = ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath(), server: server)

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

/// The last `tools ai usage sessions` list (Hub/HubSWR.swift): the hub paints it at launch, marked
/// as refreshing, while the fresh list loads.
enum HubSessionListCache {
    private static let cache = HubSWR.cache("sessions")

    static func read(hours: Int) async -> [HubSession]? {
        await cache.load([HubSession].self, key: "hours=\(hours)")
    }

    static func write(_ rows: [HubSession], hours: Int) {
        Task.detached(priority: .utility) { cache.write(rows, key: "hours=\(hours)") }
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
    struct Estimate: Equatable, Sendable {
        let usd: Double
        let note: String
    }

    final class Cache: @unchecked Sendable {
        private struct Entry {
            let revision: Double
            let expires: Date
            let value: Estimate?
            let used: Date
        }
        private let condition = NSCondition()
        private var entries: [String: Entry] = [:]
        private var pending = Set<String>()
        let ttl: TimeInterval
        init(ttl: TimeInterval = 30) { self.ttl = ttl }

        func cached(_ key: String) -> Estimate? {
            condition.lock()
            defer { condition.unlock() }
            guard let entry = entries[key], entry.expires > Date() else { return nil }
            return entry.value
        }

        func fetch(key: String, revision: Double, force: Bool = false, now: () -> Date = Date.init, run: () throws -> Data) throws -> Estimate? {
            condition.lock()
            let deadline = Date().addingTimeInterval(65)
            var waited = false
            while pending.contains(key) {
                waited = true
                guard condition.wait(until: deadline) else {
                    condition.unlock()
                    throw NSError(domain: "HubSpend", code: 1, userInfo: [NSLocalizedDescriptionKey: "Timed out waiting for a spend estimate"])
                }
            }
            if let entry = entries[key], (!force || waited), entry.revision == revision, entry.expires > now() {
                condition.unlock()
                return entry.value
            }
            pending.insert(key)
            condition.unlock()
            do {
                let data = try run()
                guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let totals = object["totals"] as? [String: Any],
                      let usd = totals["totalCost"] as? Double, usd.isFinite, usd >= 0 else {
                    throw NSError(domain: "HubSpend", code: 2, userInfo: [NSLocalizedDescriptionKey: "Invalid spend estimate"])
                }
                let at = now()
                let value = estimate(from: data).map {
                    Estimate(usd: $0.usd, note: $0.note + " · as of " + at.formatted(date: .omitted, time: .shortened))
                }
                condition.lock()
                entries[key] = Entry(revision: revision, expires: at.addingTimeInterval(ttl), value: value, used: at)
                if entries.count > 64, let oldest = entries.min(by: { $0.value.used < $1.value.used })?.key {
                    entries.removeValue(forKey: oldest)
                }
                pending.remove(key)
                condition.broadcast()
                condition.unlock()
                return value
            } catch {
                condition.lock()
                pending.remove(key)
                condition.broadcast()
                condition.unlock()
                throw error
            }
        }
    }

    private static let cache = Cache()

    private static func key(_ session: HubSession) -> String { session.provider + ":" + session.sessionId }

    static func cached(_ session: HubSession) -> Estimate? {
        cache.cached(key(session))
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
    static func fetch(_ session: HubSession, force: Bool = false) -> Estimate? {
        let since = Date(timeIntervalSince1970: session.mtime / 1000 - 14 * 86_400)
        let day = DateFormatter()
        day.locale = Locale(identifier: "en_US_POSIX")
        day.dateFormat = "yyyyMMdd"
        do {
            return try cache.fetch(key: key(session), revision: session.mtime, force: force) {
                try ToolsCLIRunner.run(["ai-spend", "session", "--id", session.sessionId, "--json", "--since", day.string(from: since)])
            }
        } catch {
            HubPerf.log("spend.session failed for \(session.sessionId.prefix(8)): \(error)")
            return nil
        }
    }
}

/// Starts `tools hub serve` once, detached from any call: it outlives the call that found no server, exits by
/// itself after 10 minutes with no connection, and restarts when its code changes (src/hub/server/server.ts).
/// It runs through the same `tools` launcher chain as every per-call child, so its macOS privacy identity is
/// GenesisTools.app, as before.
enum HubServerStarter {
    static func start() {
        let binary = HubSource.bridge.binaryPath
        guard ToolsBridge.isExecutableFile(binary) else { return }

        let plan = ToolsBridge.launchPlan(binaryPath: binary, argv: ["hub", "serve"])
        let process = Process()
        process.executableURL = plan.executable
        process.arguments = plan.arguments
        process.currentDirectoryURL = plan.workingDirectory
        process.environment = ToolsBridge.scrubbedEnvironment()
        process.qualityOfService = .utility
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { finished in
            HubPerf.log("hub server pid=\(finished.processIdentifier) exited \(finished.terminationStatus)")
        }
        do {
            try process.run()
            HubPerf.log("hub server started pid=\(process.processIdentifier)")
        } catch {
            HubPerf.log("hub server cannot start: \(error.localizedDescription)")
        }
    }
}
