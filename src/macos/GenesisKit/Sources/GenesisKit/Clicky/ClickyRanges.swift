import Foundation

/// The date ranges both statistics pages offer, and the arithmetic around them: the interval a range covers, the
/// previous period of the same length, how much of it has recorded data. One place, so the Stats and Performance
/// pages cannot drift apart.
enum ClickyRanges {
    static let today = "Today"
    static let week = "7 days"
    static let month = "30 days"
    static let quarter = "90 days"
    static let year = "1 year"
    static let all = "All kept data"
    static let custom = "Custom"
    static let presets = [today, week, month, quarter, year, all]

    /// A stored range name, or the default when the stored one is unknown (an older name such as "All time").
    static func known(_ range: String, allowed: [String]) -> String {
        if range == "All time" { return all }
        return allowed.contains(range) ? range : week
    }

    /// The interval a range covers. Presets end now; Custom covers whole days, `customEnd` included.
    static func interval(_ range: String, now: Date, earliest: Date?, customStart: Date = Date(),
        customEnd: Date = Date(), calendar: Calendar = .current) -> DateInterval {
        let today = calendar.startOfDay(for: now)
        let start: Date
        switch range {
        case Self.today: start = today
        case month: start = calendar.date(byAdding: .day, value: -29, to: today) ?? today
        case quarter: start = calendar.date(byAdding: .day, value: -89, to: today) ?? today
        case year: start = calendar.date(byAdding: .year, value: -1, to: today) ?? today
        case all: start = calendar.startOfDay(for: min(earliest ?? now, now))
        case custom: start = calendar.startOfDay(for: customStart)
        default: start = calendar.date(byAdding: .day, value: -6, to: today) ?? today
        }
        let end = range == custom
            ? calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: customEnd)) ?? now : now
        return DateInterval(start: start, end: max(start, end))
    }

    /// Calendar days the interval touches (a range that ends now counts today).
    static func dayCount(_ interval: DateInterval, calendar: Calendar = .current) -> Int {
        guard interval.end > interval.start else { return 0 }
        let first = calendar.startOfDay(for: interval.start)
        let last = calendar.startOfDay(for: interval.end.addingTimeInterval(-1))
        return (calendar.dateComponents([.day], from: first, to: last).day ?? 0) + 1
    }

    /// The period of the same length right before: Today compares with yesterday until the same time, 7 days with
    /// the 7 days before. "All kept data" has nothing before it.
    static func previous(_ interval: DateInterval, range: String, calendar: Calendar = .current) -> DateInterval? {
        guard range != all else { return nil }
        let days = dayCount(interval, calendar: calendar)
        guard days > 0, let start = calendar.date(byAdding: .day, value: -days, to: interval.start),
            let end = calendar.date(byAdding: .day, value: -days, to: interval.end) else { return nil }
        return DateInterval(start: start, end: end)
    }

    /// "yesterday", "the previous 7 days": the words a comparison uses.
    static func previousName(_ interval: DateInterval, range: String, calendar: Calendar = .current) -> String {
        let days = dayCount(interval, calendar: calendar)
        if range == today { return "yesterday" }
        if range == year { return "the year before" }
        return days == 1 ? "the day before" : "the previous \(days) days"
    }

    /// Days of the interval from the first recorded day on; `earliest == nil` means nothing was recorded.
    static func coveredDays(_ interval: DateInterval, earliest: Date?, calendar: Calendar = .current) -> Int {
        guard let earliest, earliest < interval.end else { return 0 }
        let start = max(interval.start, calendar.startOfDay(for: earliest))
        return dayCount(DateInterval(start: start, end: interval.end), calendar: calendar)
    }

    /// One line under the range picker when the range reaches before the first recorded day; nil when it is whole.
    static func coverageText(_ interval: DateInterval, earliest: Date?, calendar: Calendar = .current) -> String? {
        let total = dayCount(interval, calendar: calendar)
        let covered = coveredDays(interval, earliest: earliest, calendar: calendar)
        guard covered < total else { return nil }
        if covered == 0 { return "Nothing was recorded in this range yet." }
        return "Recorded data covers \(covered) of the \(total) days in this range."
    }

    /// The timeline grouping a range opens with: about 50 to 400 bars, never one bar per minute over a year.
    static func grouping(for range: String, span: TimeInterval = 0) -> ClickyPerformanceGrouping {
        switch range {
        case today: return .fifteenMinutes
        case week: return .hour
        case month, quarter: return .day
        case year, all: return .week
        case custom:
            if span <= 86400 * 1.5 { return .fifteenMinutes }
            if span <= 86400 * 8 { return .hour }
            if span <= 86400 * 200 { return .day }
            return .week
        default: return .day
        }
    }

    /// Minute detail exists only for the last `performanceMinuteDays`; an older range offers hour bars and wider.
    static func hasMinuteDetail(_ interval: DateInterval, now: Date) -> Bool {
        interval.start >= now.addingTimeInterval(-Double(ClickyStatistics.performanceMinuteDays) * 86400)
    }

    static func groupings(for interval: DateInterval, now: Date) -> [ClickyPerformanceGrouping] {
        hasMinuteDetail(interval, now: now) ? ClickyPerformanceGrouping.allCases
            : ClickyPerformanceGrouping.allCases.filter { $0.rawValue >= 3600 }
    }

    /// The Stats activity chart's opening resolution for a range.
    static func resolution(for range: String) -> ClickyTimeResolution {
        switch range {
        case today: return .minute
        case week: return .hour
        default: return .day
        }
    }

    static func resolutions(for interval: DateInterval, now: Date) -> [ClickyTimeResolution] {
        if interval.start < now.addingTimeInterval(-366 * 86400) { return [.day] }
        return hasMinuteDetail(interval, now: now) ? ClickyTimeResolution.allCases : [.hour, .day]
    }
}

/// What Clicky keeps, said once for every page.
enum ClickyRetention {
    static let text = "Clicky keeps minute detail for 30 days, hourly key counts for 1 year, hourly typing performance for 2 years and daily key counts for 2 years. Older detail is removed; lifetime totals stay."
}

/// Weekdays in the user's calendar order. Clicky stores weekday indexes with 0 = Monday.
enum ClickyWeekdays {
    /// Monday-based indexes, starting at the calendar's first weekday.
    static func order(_ calendar: Calendar = .current) -> [Int] {
        let first = (calendar.firstWeekday + 5) % 7
        return (0..<7).map { (first + $0) % 7 }
    }

    static func shortName(_ index: Int, calendar: Calendar = .current) -> String {
        calendar.shortWeekdaySymbols[(index + 1) % 7]
    }

    static func name(_ index: Int, calendar: Calendar = .current) -> String {
        calendar.weekdaySymbols[(index + 1) % 7]
    }

    /// Monday-based index of a date.
    static func index(of date: Date, calendar: Calendar = .current) -> Int {
        (calendar.component(.weekday, from: date) + 5) % 7
    }
}

enum ClickyFormat {
    static let missing = "n/a"

    static func duration(_ seconds: Double) -> String {
        guard seconds.isFinite else { return missing }
        let value = max(0, Int(seconds.rounded()))
        if value >= 3600 { return "\(value / 3600)h \((value % 3600) / 60)m" }
        if value >= 60 { return "\(value / 60)m \(value % 60)s" }
        return "\(value)s"
    }

    static func percent(_ share: Double) -> String {
        share.formatted(.percent.precision(.fractionLength(1)))
    }

    /// "Up 12% from the previous 7 days"; nil when there is nothing to compare with.
    static func change(_ current: Double, _ previous: Double?, against name: String) -> String? {
        guard let previous, previous > 0, current.isFinite else { return nil }
        let ratio = (current - previous) / previous
        if abs(ratio) < 0.005 { return "Same as \(name)" }
        let amount = abs(ratio).formatted(.percent.precision(.fractionLength(0)))
        return "\(ratio > 0 ? "Up" : "Down") \(amount) from \(name)"
    }

    /// A change of a share in percentage points: "Down 1.2 pt from yesterday".
    static func pointChange(_ current: Double, _ previous: Double?, against name: String) -> String? {
        guard let previous, previous > 0 || current > 0 else { return nil }
        let points = (current - previous) * 100
        if abs(points) < 0.05 { return "Same as \(name)" }
        return "\(points > 0 ? "Up" : "Down") \(String(format: "%.1f", abs(points))) pt from \(name)"
    }
}

/// Busiest day and streaks of days with typing, from daily totals.
struct ClickyRecords: Equatable, Sendable {
    var busiestDay: Date?
    var busiestDayValue = 0.0
    var longestStreak = 0
    var currentStreak = 0

    init(days: [Date: Double], today: Date, calendar: Calendar = .current) {
        let active = days.filter { $0.value > 0 }
        if let best = active.max(by: { $0.value == $1.value ? $0.key > $1.key : $0.value < $1.value }) {
            busiestDay = best.key
            busiestDayValue = best.value
        }
        let sorted = Set(active.keys.map { calendar.startOfDay(for: $0) }).sorted()
        var run = 0
        var previous: Date?
        for day in sorted {
            if let previous, calendar.date(byAdding: .day, value: 1, to: previous) == day { run += 1 } else { run = 1 }
            longestStreak = max(longestStreak, run)
            previous = day
        }
        let set = Set(sorted)
        var cursor = calendar.startOfDay(for: today)
        if !set.contains(cursor) { cursor = calendar.date(byAdding: .day, value: -1, to: cursor) ?? cursor }
        while set.contains(cursor) {
            currentStreak += 1
            guard let next = calendar.date(byAdding: .day, value: -1, to: cursor) else { break }
            cursor = next
        }
    }
}

/// Whether Clicky records statistics right now, and if not, why.
public enum ClickyRecordingStatus: Equatable, Sendable {
    case recording, clickyOff, inputMonitoringMissing, statisticsOff

    var message: String? {
        switch self {
        case .recording: return nil
        case .clickyOff: return "Not recording: Clicky is off, so no key presses are counted."
        case .inputMonitoringMissing: return "Not recording: Input Monitoring is not allowed for Clicky."
        case .statisticsOff: return "Not recording: Keep local statistics is off."
        }
    }

    var actionTitle: String {
        switch self {
        case .recording: return ""
        case .clickyOff: return "Turn On Clicky"
        case .inputMonitoringMissing: return "Allow Input Monitoring"
        case .statisticsOff: return "Turn On Statistics"
        }
    }
}
