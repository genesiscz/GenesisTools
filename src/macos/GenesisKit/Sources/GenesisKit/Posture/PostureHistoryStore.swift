import Foundation

/// One minute of posture: seconds upright, slouching and away, and the slouch alerts that started in it.
/// Several rows may name the same minute (a pause flushes a partial minute); readers add them up.
public struct PostureMinute: Codable, Equatable, Sendable {
    /// The minute's start.
    public var minute: Date
    public var upright: Double
    public var slouch: Double
    public var away: Double
    public var alerts: Int

    public init(minute: Date, upright: Double = 0, slouch: Double = 0, away: Double = 0, alerts: Int = 0) {
        self.minute = minute
        self.upright = upright
        self.slouch = slouch
        self.away = away
        self.alerts = alerts
    }

    var isEmpty: Bool { upright == 0 && slouch == 0 && away == 0 && alerts == 0 }

    private enum CodingKeys: String, CodingKey {
        case minute = "m", upright = "u", slouch = "s", away = "a", alerts = "n"
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        minute = Date(timeIntervalSince1970: try container.decode(Double.self, forKey: .minute))
        upright = try container.decodeIfPresent(Double.self, forKey: .upright) ?? 0
        slouch = try container.decodeIfPresent(Double.self, forKey: .slouch) ?? 0
        away = try container.decodeIfPresent(Double.self, forKey: .away) ?? 0
        alerts = try container.decodeIfPresent(Int.self, forKey: .alerts) ?? 0
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(minute.timeIntervalSince1970.rounded(), forKey: .minute)
        if upright > 0 { try container.encode((upright * 10).rounded() / 10, forKey: .upright) }
        if slouch > 0 { try container.encode((slouch * 10).rounded() / 10, forKey: .slouch) }
        if away > 0 { try container.encode((away * 10).rounded() / 10, forKey: .away) }
        if alerts > 0 { try container.encode(alerts, forKey: .alerts) }
    }
}

/// One day's totals.
public struct PostureDaySummary: Equatable, Sendable {
    /// The day's start (local calendar).
    public var day: Date
    public var upright: Double
    public var slouch: Double
    public var away: Double
    public var alerts: Int

    public init(day: Date, upright: Double = 0, slouch: Double = 0, away: Double = 0, alerts: Int = 0) {
        self.day = day
        self.upright = upright
        self.slouch = slouch
        self.away = away
        self.alerts = alerts
    }

    /// Upright share of the watched time (upright + slouch), 0...1; nil with nothing watched.
    public var uprightFraction: Double? {
        let watched = upright + slouch
        return watched > 0 ? upright / watched : nil
    }
}

/// Folds time into per-minute rows as the monitor reports it. Pure: time in, finished rows out.
public struct PostureMinuteAccumulator: Sendable {
    private var current: PostureMinute?

    public init() {}

    /// Credits `seconds` of `activity` that ended at `end`, split across minute boundaries. Returns the
    /// rows of minutes that are now complete.
    public mutating func add(_ activity: PostureHistoryActivity, seconds: TimeInterval, endingAt end: Date) -> [PostureMinute] {
        guard seconds > 0 else { return [] }
        var finished: [PostureMinute] = []
        var cursor = end.addingTimeInterval(-seconds)
        while cursor < end {
            let start = minuteStart(cursor)
            let next = start.addingTimeInterval(60)
            let slice = min(next, end).timeIntervalSince(cursor)
            finished += roll(to: start)
            switch activity {
            case .upright: current?.upright += slice
            case .slouching: current?.slouch += slice
            case .away: current?.away += slice
            }
            cursor = cursor.addingTimeInterval(slice)
            if slice <= 0 { break }
        }
        return finished
    }

    /// Counts one alert at `date`.
    public mutating func addAlert(at date: Date) -> [PostureMinute] {
        let finished = roll(to: minuteStart(date))
        current?.alerts += 1
        return finished
    }

    /// Returns the open minute (possibly partial) and starts empty.
    public mutating func flush() -> [PostureMinute] {
        defer { current = nil }
        guard let current, !current.isEmpty else { return [] }
        return [current]
    }

    private mutating func roll(to start: Date) -> [PostureMinute] {
        if let current, current.minute == start { return [] }
        let done = current.flatMap { $0.isEmpty ? nil : $0 }
        current = PostureMinute(minute: start)
        return done.map { [$0] } ?? []
    }

    private func minuteStart(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }
}

public enum PostureHistoryActivity: Sendable {
    case upright, slouching, away
}

/// Per-minute posture history in a folder the host names: one append-only JSON-lines file per local
/// day (`posture-YYYY-MM-DD.jsonl`, about 70 bytes a row, at most about 100 KB a day). Files older than
/// `retentionDays` are pruned once a day, and a day file stops growing at `maxBytesPerDay`, so the folder
/// stays bounded. A line that cannot be read is skipped and the file is never rewritten, so its bytes
/// survive. Every read and write runs on the store's own utility queue.
public final class PostureHistoryStore: @unchecked Sendable {
    public let directory: URL
    public let retentionDays: Int
    public let maxBytesPerDay: Int
    private let calendar: Calendar
    private let queue = DispatchQueue(label: "genesiskit.posture.history", qos: .utility)
    private var lastPrunedDay: String?

    public init(directory: URL, retentionDays: Int = 60, maxBytesPerDay: Int = 512 * 1024,
                calendar: Calendar = .current) {
        self.directory = directory
        self.retentionDays = max(1, retentionDays)
        self.maxBytesPerDay = maxBytesPerDay
        self.calendar = calendar
    }

    /// Appends rows (off the caller's thread).
    public func append(_ rows: [PostureMinute]) {
        let rows = rows.filter { !$0.isEmpty }
        guard !rows.isEmpty else { return }
        queue.async { self.appendNow(rows) }
    }

    /// Every row of one local day, summed per minute and sorted.
    public func minutes(on day: Date) async -> [PostureMinute] {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.minutesNow(on: day)) }
        }
    }

    /// The totals of the local day containing `date`.
    public func summary(for date: Date) async -> PostureDaySummary {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.summaryNow(for: date)) }
        }
    }

    /// The last `count` local days ending with the day of `date`, oldest first, days with no data
    /// included as zero rows.
    public func lastDays(_ count: Int, endingAt date: Date) async -> [PostureDaySummary] {
        await withCheckedContinuation { continuation in
            queue.async {
                let today = self.calendar.startOfDay(for: date)
                let days = (0..<max(count, 0)).reversed().compactMap {
                    self.calendar.date(byAdding: .day, value: -$0, to: today)
                }
                continuation.resume(returning: days.map { self.summaryNow(for: $0) })
            }
        }
    }

    /// Waits for queued writes (tests, quit).
    public func flush() { queue.sync {} }

    /// Deletes every stored day ("Clear history"), after the writes queued before it. `completion` (any
    /// queue) gets the first error, if any; a file that could not be deleted stays.
    public func clear(completion: (@Sendable (Error?) -> Void)? = nil) {
        queue.async {
            var firstError: Error?
            let names = (try? FileManager.default.contentsOfDirectory(atPath: self.directory.path)) ?? []
            for name in names where name.hasPrefix("posture-") && name.hasSuffix(".jsonl") {
                do {
                    try FileManager.default.removeItem(at: self.directory.appendingPathComponent(name))
                } catch {
                    if firstError == nil { firstError = error }
                }
            }
            completion?(firstError)
        }
    }

    // MARK: - Queue

    private func fileName(for date: Date) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "posture-%04d-%02d-%02d.jsonl", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    private func appendNow(_ rows: [PostureMinute]) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            GenesisKit.log("posture: history folder not created: \(error.localizedDescription)")
            return
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let byFile = Dictionary(grouping: rows) { fileName(for: $0.minute) }
        for (name, group) in byFile {
            let url = directory.appendingPathComponent(name)
            var data = Data()
            for row in group {
                guard let line = try? encoder.encode(row) else { continue }
                data.append(line)
                data.append(0x0A)
            }
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int) ?? 0
            guard size + data.count <= maxBytesPerDay else {
                GenesisKit.log("posture: history day file \(name) is full (\(size) bytes), rows dropped")
                continue
            }
            do {
                try Self.append(data, to: url)
            } catch {
                GenesisKit.log("posture: history append failed: \(error.localizedDescription)")
            }
        }
        pruneIfNeeded(now: rows.map(\.minute).max() ?? Date())
    }

    /// Appends with `O_APPEND`, never replacing the file. When the file does not end in a newline (a torn
    /// last line) a newline goes first, so the new row is not glued to the fragment. Opened for reading
    /// too, because checking that last byte needs it.
    static func append(_ data: Data, to url: URL) throws {
        let fd = open(url.path, O_RDWR | O_APPEND | O_CREAT | O_CLOEXEC, 0o644)
        guard fd >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        defer { close(fd) }
        var payload = data
        let size = lseek(fd, 0, SEEK_END)
        if size > 0 {
            var last: UInt8 = 0
            if pread(fd, &last, 1, size - 1) == 1, last != 0x0A { payload.insert(0x0A, at: 0) }
        }
        let written = payload.withUnsafeBytes { write(fd, $0.baseAddress, $0.count) }
        guard written == payload.count else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
    }

    private func pruneIfNeeded(now: Date) {
        let today = fileName(for: now)
        guard lastPrunedDay != today else { return }
        lastPrunedDay = today
        guard let oldest = calendar.date(byAdding: .day, value: -retentionDays, to: calendar.startOfDay(for: now)) else { return }
        let cutoff = fileName(for: oldest)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        for name in names where name.hasPrefix("posture-") && name.hasSuffix(".jsonl") && name < cutoff {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    private func minutesNow(on day: Date) -> [PostureMinute] {
        let url = directory.appendingPathComponent(fileName(for: day))
        guard let data = try? Data(contentsOf: url) else { return [] }
        let decoder = JSONDecoder()
        var byMinute: [Date: PostureMinute] = [:]
        for line in data.split(separator: 0x0A) where !line.isEmpty {
            guard let row = try? decoder.decode(PostureMinute.self, from: Data(line)) else { continue }
            var merged = byMinute[row.minute] ?? PostureMinute(minute: row.minute)
            merged.upright += row.upright
            merged.slouch += row.slouch
            merged.away += row.away
            merged.alerts += row.alerts
            byMinute[row.minute] = merged
        }
        return byMinute.values.sorted { $0.minute < $1.minute }
    }

    private func summaryNow(for date: Date) -> PostureDaySummary {
        var summary = PostureDaySummary(day: calendar.startOfDay(for: date))
        for row in minutesNow(on: date) {
            summary.upright += row.upright
            summary.slouch += row.slouch
            summary.away += row.away
            summary.alerts += row.alerts
        }
        return summary
    }
}
