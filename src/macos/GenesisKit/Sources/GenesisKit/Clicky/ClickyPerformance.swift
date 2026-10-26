import Foundation

public enum ClickyInputTime {
    public static func date(timestampNanoseconds: UInt64, now: Date = Date(),
        uptime: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Date {
        let seconds = Double(timestampNanoseconds) / 1_000_000_000
        guard timestampNanoseconds > 0, seconds <= uptime else { return now }
        return now.addingTimeInterval(seconds - uptime)
    }
}

public struct ClickyPerformanceBucket: Codable, Equatable, Sendable {
    public var presses = 0
    public var characters = 0
    public var corrections = 0
    public var activeSeconds = 0.0
    public var bursts = 0
    public var carriedBurst = false
    /// Typing sessions that start in this bucket: text after a minute or more without text.
    public var sessions = 0
    /// Frozen at the retention boundary before the preceding minute is discarded. Nil derives it from neighbours.
    var startsTypingSession: Bool?
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case presses, characters, corrections, activeSeconds, bursts, carriedBurst, sessions, startsTypingSession
    }

    /// Every key is optional, so buckets saved before `sessions` existed still load.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        presses = try values.decodeIfPresent(Int.self, forKey: .presses) ?? 0
        characters = try values.decodeIfPresent(Int.self, forKey: .characters) ?? 0
        corrections = try values.decodeIfPresent(Int.self, forKey: .corrections) ?? 0
        activeSeconds = try values.decodeIfPresent(Double.self, forKey: .activeSeconds) ?? 0
        bursts = try values.decodeIfPresent(Int.self, forKey: .bursts) ?? 0
        carriedBurst = try values.decodeIfPresent(Bool.self, forKey: .carriedBurst) ?? false
        sessions = try values.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        startsTypingSession = try values.decodeIfPresent(Bool.self, forKey: .startsTypingSession)
    }

    mutating func add(_ other: Self) {
        presses += other.presses
        characters += other.characters
        corrections += other.corrections
        activeSeconds += other.activeSeconds
        bursts += other.bursts
        sessions += other.sessions
    }
    var estimatedWords: Double { Double(characters) / 5 }
    var estimatedRetainedWords: Double { Double(max(0, characters - corrections)) / 5 }
    var wordsPerMinute: Double? {
        activeSeconds >= 1 && characters >= 5 ? estimatedWords * 60 / activeSeconds : nil
    }
    var correctionShare: Double { Double(corrections) / Double(max(1, characters + corrections)) }
}

extension ClickyStatistics {
    static let typingStopSeconds: TimeInterval = 5
    private static let modifierCodes: Set<UInt16> = [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]
    private static let characterCodes: Set<UInt16> = Set(0...50).subtracting([36, 48]).union([
        65, 67, 69, 75, 78, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 102
    ])

    public mutating func breakTypingBurst() { lastTypingAt = nil }

    /// Minute detail is kept for this long; older minutes are rolled into `performanceHours`.
    static let performanceMinuteDays = 30
    /// The hourly roll-up is kept for this long.
    static let performanceHourDays = 730

    /// Whether `minute` starts a typing session: it has text and the minute before it has none.
    static func startsSession(_ minute: Int, in minutes: [Int: ClickyPerformanceBucket]) -> Bool {
        minutes[minute]?.startsTypingSession
            ?? ((minutes[minute]?.characters ?? 0) > 0 && (minutes[minute - 1]?.characters ?? 0) == 0)
    }

    /// Rolls the minutes older than `horizon` into hourly buckets, then drops them and hours past their retention.
    mutating func rollUpPerformance(olderThan horizon: Int) {
        let old = performanceMinutes.filter { $0.key < horizon }
        // Freeze the first retained minute while its predecessor is still available, including across saves.
        if performanceMinutes[horizon] != nil {
            let starts = Self.startsSession(horizon, in: performanceMinutes)
            performanceMinutes[horizon]?.startsTypingSession = starts
        }
        for (minute, source) in old {
            var bucket = source
            bucket.carriedBurst = false
            bucket.sessions = Self.startsSession(minute, in: performanceMinutes) ? 1 : 0
            performanceHours[Int(floor(Double(minute) / 60)), default: ClickyPerformanceBucket()].add(bucket)
        }
        performanceMinutes = performanceMinutes.filter { $0.key >= horizon }
        let recordingMinute = horizon + Self.performanceMinuteDays * 24 * 60
        let oldestHour = recordingMinute / 60 - Self.performanceHourDays * 24
        performanceHours = performanceHours.filter { $0.key >= oldestHour }
    }

    mutating func recordPerformance(keyCode: UInt16, shortcut: Bool, at date: Date) {
        let minute = Int(floor(date.timeIntervalSince1970 / 60))
        performanceMinutes[minute, default: ClickyPerformanceBucket()].presses += 1
        if performanceStartedAt == nil { performanceStartedAt = date }
        guard !Self.modifierCodes.contains(keyCode) else { return }
        let character = Self.characterCodes.contains(keyCode)
        let correction = keyCode == 51 || keyCode == 117
        guard !shortcut && (character || correction) else {
            breakTypingBurst()
            return
        }
        if character { performanceMinutes[minute, default: ClickyPerformanceBucket()].characters += 1 }
        if correction { performanceMinutes[minute, default: ClickyPerformanceBucket()].corrections += 1 }
        if let previous = lastTypingAt {
            let elapsed = date.timeIntervalSince(previous)
            if elapsed >= 0 && elapsed <= Self.typingStopSeconds {
                var cursor = previous.timeIntervalSince1970
                let end = date.timeIntervalSince1970
                while cursor < end {
                    let bucket = Int(floor(cursor / 60))
                    let boundary = min(end, Double(bucket + 1) * 60)
                    performanceMinutes[bucket, default: ClickyPerformanceBucket()].activeSeconds += boundary - cursor
                    if bucket > Int(floor(previous.timeIntervalSince1970 / 60)) {
                        performanceMinutes[bucket, default: ClickyPerformanceBucket()].carriedBurst = true
                    }
                    cursor = boundary
                }
                // A press exactly on a minute boundary ends the loop before it visits the new minute, so that
                // minute is marked as continuing the burst here.
                if minute > Int(floor(previous.timeIntervalSince1970 / 60)) {
                    performanceMinutes[minute, default: ClickyPerformanceBucket()].carriedBurst = true
                }
            } else {
                performanceMinutes[minute, default: ClickyPerformanceBucket()].bursts += 1
            }
        } else {
            performanceMinutes[minute, default: ClickyPerformanceBucket()].bursts += 1
        }
        lastTypingAt = date
    }
}

struct ClickyPerformanceFilter: Equatable, Sendable {
    var start: Date
    var end: Date
    var weekdays: Set<Int> = Set(0..<7)
    var fromHour = 0
    var untilHour = 24

    func includes(_ date: Date, calendar: Calendar) -> Bool {
        guard date >= start && date < end,
            weekdays.contains((calendar.component(.weekday, from: date) + 5) % 7) else { return false }
        let hour = calendar.component(.hour, from: date)
        return fromHour < untilHour ? hour >= fromHour && hour < untilHour : hour >= fromHour || hour < untilHour
    }
}

enum ClickyPerformanceGrouping: Int, CaseIterable, Identifiable, Sendable {
    case minute = 60, fiveMinutes = 300, fifteenMinutes = 900, hour = 3600, day = 86400, week = 604800
    var id: Self { self }
    var label: String {
        switch self {
        case .minute: return "1 minute"
        case .fiveMinutes: return "5 minutes"
        case .fifteenMinutes: return "15 minutes"
        case .hour: return "Hour"
        case .day: return "Day"
        case .week: return "Week"
        }
    }
}

struct ClickyPerformancePoint: Identifiable, Sendable {
    let date: Date
    var totals: ClickyPerformanceBucket
    var id: Date { date }
}

struct ClickyPerformanceReport: Sendable {
    var total = ClickyPerformanceBucket()
    var timeline: [ClickyPerformancePoint] = []
    var hours = Array(repeating: ClickyPerformanceBucket(), count: 24)
    var weekdays = Array(repeating: ClickyPerformanceBucket(), count: 7)
    /// Totals per local calendar day, for active days, records and per-day averages.
    var days: [Date: ClickyPerformanceBucket] = [:]

    init() {}

    /// Days with any timed typing.
    var activeDays: Int { days.values.filter { $0.activeSeconds > 0 || $0.characters > 0 }.count }

    /// `beforeBuild` runs on the worker before the report is built; tests use it to cancel while the worker runs.
    static func prepare(statistics: ClickyStatistics, filter: ClickyPerformanceFilter,
        grouping: ClickyPerformanceGrouping, calendar: Calendar = .current,
        beforeBuild: (@Sendable () -> Void)? = nil) async -> Self? {
        guard !Task.isCancelled else { return nil }
        let worker = Task.detached(priority: .userInitiated) {
            beforeBuild?()
            return PerfLog.span("clicky.performance.report", over: PerfLog.frameMs) {
                Self(statistics: statistics, filter: filter, grouping: grouping, calendar: calendar)
            }
        }
        let report = await withTaskCancellationHandler {
            await worker.value
        } onCancel: {
            worker.cancel()
        }
        return Task.isCancelled ? nil : report
    }

    init(statistics: ClickyStatistics, filter: ClickyPerformanceFilter,
        grouping: ClickyPerformanceGrouping, calendar: Calendar = .current) {
        var groups: [Date: ClickyPerformanceBucket] = [:]
        let minuteBuckets = statistics.performanceMinutes.map { minute, source -> (Date, ClickyPerformanceBucket) in
            var bucket = source
            bucket.sessions = ClickyStatistics.startsSession(minute, in: statistics.performanceMinutes) ? 1 : 0
            return (Date(timeIntervalSince1970: Double(minute) * 60), bucket)
        }
        // Rolled-up hours hold only minutes that are no longer kept, so the two never count the same press twice.
        let hourBuckets = statistics.performanceHours.map { (Date(timeIntervalSince1970: Double($0.key) * 3600), $0.value) }
        for (date, source) in minuteBuckets + hourBuckets {
            guard filter.includes(date, calendar: calendar) else { continue }
            var bucket = source
            if bucket.carriedBurst && !filter.includes(date.addingTimeInterval(-60), calendar: calendar) {
                bucket.bursts += 1
            }
            total.add(bucket)
            hours[calendar.component(.hour, from: date)].add(bucket)
            weekdays[(calendar.component(.weekday, from: date) + 5) % 7].add(bucket)
            let day = calendar.startOfDay(for: date)
            days[day, default: ClickyPerformanceBucket()].add(bucket)
            let key = grouping == .week ? (calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? day)
                : grouping == .day ? day
                : Date(timeIntervalSince1970: floor(date.timeIntervalSince1970 / Double(grouping.rawValue)) * Double(grouping.rawValue))
            groups[key, default: ClickyPerformanceBucket()].add(bucket)
        }
        timeline = groups.map { ClickyPerformancePoint(date: $0.key, totals: $0.value) }.sorted { $0.date < $1.date }
    }
}

struct ClickyDictationEstimate {
    let typingSeconds: Double
    let speakingSeconds: Double
    let setupSeconds: Double
    let reviewSeconds: Double
    let retainedWords: Double
    var dictationSeconds: Double { speakingSeconds + setupSeconds + reviewSeconds }
    var differenceSeconds: Double { typingSeconds - dictationSeconds }

    /// One dictation covers a whole typing session, so its setup counts once per session, not per 5-second burst:
    /// with setup per burst, 8,042 bursts in a week cost 6.7 h of setup and the estimate said dictation saved nothing
    /// (Martin's data, 2026-10-25: 718 sessions in the same week).
    ///
    /// `dictatedShare` (0...1) is the part of the typing the user would dictate at all: code, commands and passwords
    /// stay typed, and Clicky cannot tell them apart without reading text. It scales both sides and the sessions
    /// alike. `reviewShare` adds reading and fixing the transcript, as a share of the speaking time.
    init(totals: ClickyPerformanceBucket, wordsPerMinute: Int, setupPerSession: Int,
        dictatedShare: Double = 1, reviewShare: Double = 0) {
        let share = min(1, max(0, dictatedShare))
        retainedWords = totals.estimatedRetainedWords * share
        typingSeconds = totals.activeSeconds * share
        speakingSeconds = retainedWords * 60 / Double(max(1, wordsPerMinute))
        setupSeconds = Double(totals.sessions * max(0, setupPerSession)) * share
        reviewSeconds = speakingSeconds * max(0, reviewShare)
    }
}
