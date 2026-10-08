import Foundation

public enum ClickySwitch: String, CaseIterable, Codable, Identifiable {
    case basalt, violet, pebble, paper, honey, ember, cloud
    public var id: String { rawValue }
    public var name: String { rawValue.capitalized }
    public var detail: String {
        switch self {
        case .basalt: return "Deep · firm · resonant"
        case .violet: return "Bright · crisp · tactile"
        case .pebble: return "Rounded · hollow · playful"
        case .paper: return "Dry · soft · textured"
        case .honey: return "Warm · smooth · mellow"
        case .ember: return "Sharp · light · quick"
        case .cloud: return "Gentle · muted · airy"
        }
    }
    var frequency: Double {
        switch self {
        case .basalt: return 190
        case .violet: return 720
        case .pebble: return 380
        case .paper: return 1400
        case .honey: return 280
        case .ember: return 980
        case .cloud: return 460
        }
    }
    var decay: Double {
        switch self {
        case .basalt: return 0.027
        case .violet: return 0.014
        case .pebble: return 0.035
        case .paper: return 0.010
        case .honey: return 0.022
        case .ember: return 0.008
        case .cloud: return 0.019
        }
    }
}

public struct ClickyPreferences: Codable, Equatable {
    public var selectedSwitch: ClickySwitch = .basalt
    public var selectedPack: ClickyPackReference?
    public var volume: Double = 0.45
    public var releaseSounds = true
    public var randomizedPitch = true
    public var spatialAudio = true
    public var repeatSounds = false
    public var quietHours = false
    public var quietStart = 22 * 60
    public var quietEnd = 8 * 60
    public var excludedApplications: [String] = []
    public var visualizer = true
    public var notifications = false
    public var collectStats = true
    public var reduceMotion = false
    public var reduceTransparency = false

    public init() {}

    public mutating func normalize() {
        volume = volume.isFinite ? min(1, max(0, volume)) : 0.45
        quietStart = min(1439, max(0, quietStart))
        quietEnd = min(1439, max(0, quietEnd))
        excludedApplications = Array(Set(excludedApplications.filter { !$0.isEmpty })).sorted()
    }

    public func isQuiet(at date: Date, calendar: Calendar = .current) -> Bool {
        guard quietHours, quietStart != quietEnd else { return false }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let minute = (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
        if quietStart < quietEnd {
            return minute >= quietStart && minute < quietEnd
        }
        return minute >= quietStart || minute < quietEnd
    }

    public static func clockTime(minute: Int, on date: Date = Date(), calendar: Calendar = .current) -> Date {
        calendar.date(bySettingHour: minute / 60, minute: minute % 60, second: 0, of: date) ?? date
    }

    public func nextQuietBoundary(after date: Date, calendar: Calendar = .current) -> Date? {
        guard quietHours, quietStart != quietEnd else { return nil }
        return [quietStart, quietEnd].compactMap { minute in
            calendar.nextDate(
                after: date, matching: DateComponents(hour: minute / 60, minute: minute % 60),
                matchingPolicy: .nextTime)
        }.min()
    }
}

public struct ClickyStatistics: Codable, Equatable {
    public var presses: Int = 0
    public var releases: Int = 0
    public var sessions: Int = 0
    public var startedAt: Date = Date()
    public var historyStartedAt: Date?
    public var minutes: [Int: ClickyActivityBucket] = [:]
    public var hours: [Int: ClickyActivityBucket] = [:]
    public var days: [Int: ClickyActivityBucket] = [:]
    public var keys: [Int: Int] = [:]
    public var performanceMinutes: [Int: ClickyPerformanceBucket] = [:]
    public var performanceStartedAt: Date?
    var lastTypingAt: Date?
    private var latestMinute = 0
    private var prunedHour: Int?
    public init() {}

    private enum CodingKeys: String, CodingKey {
        case presses, releases, sessions, startedAt, historyStartedAt, minutes, hours, days, keys
        case performanceMinutes, performanceStartedAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        presses = try values.decodeIfPresent(Int.self, forKey: .presses) ?? 0
        releases = try values.decodeIfPresent(Int.self, forKey: .releases) ?? 0
        sessions = try values.decodeIfPresent(Int.self, forKey: .sessions) ?? 0
        startedAt = try values.decodeIfPresent(Date.self, forKey: .startedAt) ?? Date()
        historyStartedAt = try values.decodeIfPresent(Date.self, forKey: .historyStartedAt)
        minutes = try values.decodeIfPresent([Int: ClickyActivityBucket].self, forKey: .minutes) ?? [:]
        hours = try values.decodeIfPresent([Int: ClickyActivityBucket].self, forKey: .hours) ?? [:]
        days = try values.decodeIfPresent([Int: ClickyActivityBucket].self, forKey: .days) ?? [:]
        keys = try values.decodeIfPresent([Int: Int].self, forKey: .keys) ?? [:]
        performanceMinutes = try values.decodeIfPresent([Int: ClickyPerformanceBucket].self, forKey: .performanceMinutes) ?? [:]
        performanceStartedAt = try values.decodeIfPresent(Date.self, forKey: .performanceStartedAt)
        latestMinute = minutes.keys.max() ?? 0
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.presses == rhs.presses && lhs.releases == rhs.releases && lhs.sessions == rhs.sessions
            && lhs.startedAt == rhs.startedAt && lhs.historyStartedAt == rhs.historyStartedAt
            && lhs.minutes == rhs.minutes && lhs.hours == rhs.hours && lhs.days == rhs.days && lhs.keys == rhs.keys
            && lhs.performanceMinutes == rhs.performanceMinutes && lhs.performanceStartedAt == rhs.performanceStartedAt
    }

    public mutating func record(keyCode: UInt16, release: Bool, at date: Date = Date(), calendar: Calendar = .current,
        shortcut: Bool = false) {
        let minute = Int(floor(date.timeIntervalSince1970 / 60))
        let hour = Int(floor(date.timeIntervalSince1970 / 3600))
        let day = Int(calendar.startOfDay(for: date).timeIntervalSince1970)
        if historyStartedAt == nil { historyStartedAt = date }
        if release { releases += 1 } else { presses += 1; keys[Int(keyCode), default: 0] += 1 }
        if !release { recordPerformance(keyCode: keyCode, shortcut: shortcut, at: date) }
        minutes[minute, default: ClickyActivityBucket()].record(release: release)
        hours[hour, default: ClickyActivityBucket()].record(release: release)
        days[day, default: ClickyActivityBucket()].record(release: release)
        latestMinute = max(latestMinute, minute)
        let retentionHour = latestMinute / 60
        if prunedHour != retentionHour {
            minutes = minutes.filter { $0.key >= latestMinute - 30 * 24 * 60 }
            performanceMinutes = performanceMinutes.filter { $0.key >= latestMinute - 30 * 24 * 60 }
            hours = hours.filter { $0.key >= retentionHour - 366 * 24 }
            let oldestDay = calendar.date(byAdding: .day, value: -730, to: date) ?? date
            days = days.filter { $0.key >= Int(oldestDay.timeIntervalSince1970) }
            prunedHour = retentionHour
        }
    }
}

public enum ClickyEventPolicy {
    public static func accepts(
        enabled: Bool, secureInput: Bool, sleeping: Bool, quiet: Bool,
        excluded: Bool, repeated: Bool, repeatSounds: Bool
    ) -> Bool {
        enabled && !secureInput && !sleeping && !quiet && !excluded && (!repeated || repeatSounds)
    }

    public static func pan(keyCode: UInt16) -> Float {
        let rows: [[UInt16]] = [
            [50, 18, 19, 20, 21, 23, 22, 26, 28, 25, 29, 27, 24, 51],
            [48, 12, 13, 14, 15, 17, 16, 32, 34, 31, 35, 33, 30, 42],
            [57, 0, 1, 2, 3, 5, 4, 38, 40, 37, 41, 39, 36],
            [56, 6, 7, 8, 9, 11, 45, 46, 43, 47, 44, 60],
        ]
        for row in rows {
            if let index = row.firstIndex(of: keyCode) {
                return Float(index) / Float(row.count - 1) * 1.5 - 0.75
            }
        }
        return 0
    }
}

struct ClickyKeyTransition: Equatable {
    let release: Bool
    let countsPress: Bool
}

struct ClickyInputState {
    private var held: Set<UInt16> = []

    mutating func clear() { held.removeAll() }

    mutating func transition(keyCode: UInt16, release: Bool, repeated: Bool, repeatSounds: Bool) -> ClickyKeyTransition?
    {
        if release {
            guard held.remove(keyCode) != nil else { return nil }
            return ClickyKeyTransition(release: true, countsPress: false)
        }
        if repeated {
            guard repeatSounds, held.contains(keyCode) else { return nil }
            return ClickyKeyTransition(release: false, countsPress: false)
        }
        guard held.insert(keyCode).inserted else { return nil }
        return ClickyKeyTransition(release: false, countsPress: true)
    }
}
