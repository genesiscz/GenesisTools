import Combine
import Foundation

public struct ClickyActivityBucket: Codable, Equatable, Sendable {
    public var presses = 0
    public var releases = 0
    public init(presses: Int = 0, releases: Int = 0) { self.presses = presses; self.releases = releases }
    mutating func record(release: Bool) {
        if release { releases += 1 } else { presses += 1 }
    }
}

public enum ClickyTimeResolution: String, CaseIterable, Identifiable {
    case minute = "Minute", hour = "Hour", day = "Day"
    public var id: Self { self }
    var seconds: TimeInterval { switch self { case .minute: return 60; case .hour: return 3600; case .day: return 86400 } }
    var initialWindow: TimeInterval { switch self { case .minute: return 3600; case .hour: return 86400; case .day: return 7 * 86400 } }
}

@MainActor
public final class ClickyAnalyticsStore: ObservableObject {
    @Published public private(set) var snapshot = ClickyStatistics()
    public private(set) var revision: UInt64 = 0
    private var publishTask: Task<Void, Never>?
    private var viewers = 0
    private var latest: (@MainActor () -> ClickyStatistics?)?

    /// A published snapshot shares the statistics' dictionaries, so the next key event pays a copy-on-write
    /// of the whole history. Nothing is published while no dashboard is open; the first viewer gets the
    /// current statistics at once.
    public func attach() {
        viewers += 1
        if viewers == 1, let latest { flush(latest()) }
    }

    public func detach() { viewers = max(0, viewers - 1) }

    func stage(_ source: @escaping @MainActor () -> ClickyStatistics?) {
        latest = source
        guard viewers > 0, publishTask == nil else { return }
        publishTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(1)) } catch { return }
            self?.flush(source())
        }
    }

    func flush(_ statistics: ClickyStatistics?) {
        publishTask?.cancel()
        publishTask = nil
        if let statistics {
            revision &+= 1
            snapshot = statistics
        }
    }
}

extension ClickyStatistics {
    func timeline(_ resolution: ClickyTimeResolution, releases: Bool = false) -> [NativeTimePoint] {
        let source: [Int: ClickyActivityBucket]
        let multiplier: Double
        switch resolution {
        case .minute: source = minutes; multiplier = 60
        case .hour: source = hours; multiplier = 3600
        case .day: source = days; multiplier = 1
        }
        return source.map { NativeTimePoint(date: Date(timeIntervalSince1970: Double($0.key) * multiplier),
            value: Double(releases ? $0.value.releases : $0.value.presses)) }.sorted { $0.date < $1.date }
    }

    func weekdayHeatmap(calendar: Calendar = .current) -> [NativeHeatmapCell] {
        var totals: [Int: Double] = [:]
        for (hour, bucket) in hours {
            let date = Date(timeIntervalSince1970: Double(hour) * 3600)
            let weekday = (calendar.component(.weekday, from: date) + 5) % 7
            let column = calendar.component(.hour, from: date)
            totals[weekday * 24 + column, default: 0] += Double(bucket.presses)
        }
        return (0..<7).flatMap { row in (0..<24).map { column in
            NativeHeatmapCell(row: row, column: column, value: totals[row * 24 + column, default: 0])
        } }
    }

    static func example(now: Date = Date(), calendar: Calendar = .current) -> ClickyStatistics {
        var result = ClickyStatistics()
        let start = calendar.date(byAdding: .day, value: -14, to: calendar.startOfDay(for: now)) ?? now
        result.startedAt = start
        result.historyStartedAt = start
        for index in 0..<(15 * 24 * 60) {
            let date = start.addingTimeInterval(Double(index) * 60)
            guard date <= now else { break }
            let hourOfDay = calendar.component(.hour, from: date)
            guard index % 17 < 12 else { continue }
            let weekday = calendar.component(.weekday, from: date)
            let factor = (weekday == 1 || weekday == 7 ? 0.3 : 1.0) * ((8..<22).contains(hourOfDay) ? 1.0 : 0.12)
            let presses = Int((20 + 90 * abs(sin(Double(index) / 37))) * factor)
            let bucket = ClickyActivityBucket(presses: presses, releases: presses)
            result.minutes[Int(date.timeIntervalSince1970 / 60)] = bucket
            var performance = ClickyPerformanceBucket()
            performance.presses = presses
            performance.characters = Int(Double(presses) * 0.8)
            performance.corrections = Int(Double(presses) * 0.05)
            performance.activeSeconds = min(55, Double(performance.characters) / (3.3 + 1.2 * abs(sin(Double(index) / 50))))
            performance.bursts = presses > 0 ? 1 : 0
            result.performanceMinutes[Int(date.timeIntervalSince1970 / 60)] = performance
            result.performanceStartedAt = start
            let hour = Int(date.timeIntervalSince1970 / 3600)
            let day = Int(calendar.startOfDay(for: date).timeIntervalSince1970)
            result.hours[hour, default: ClickyActivityBucket()].presses += presses
            result.hours[hour, default: ClickyActivityBucket()].releases += presses
            result.days[day, default: ClickyActivityBucket()].presses += presses
            result.days[day, default: ClickyActivityBucket()].releases += presses
            result.presses += presses
            result.releases += presses
        }
        // Before the minute detail: two years of hourly and daily totals, as the retention keeps them, so the long
        // ranges have something to show.
        let oldest = calendar.date(byAdding: .day, value: -730, to: start) ?? start
        let hourlyKeysFrom = calendar.date(byAdding: .day, value: -366, to: now) ?? start
        result.startedAt = oldest
        result.historyStartedAt = oldest
        result.performanceStartedAt = oldest
        var hourDate = oldest
        var index = 0
        while hourDate < start {
            let hourOfDay = calendar.component(.hour, from: hourDate)
            let weekday = calendar.component(.weekday, from: hourDate)
            let season = 0.75 + 0.25 * sin(Double(index) / 900)
            let factor = (weekday == 1 || weekday == 7 ? 0.3 : 1.0) * ((8..<22).contains(hourOfDay) ? 1.0 : 0.05) * season
            let presses = Int((900 + 2400 * abs(sin(Double(index) / 29))) * factor)
            index += 1
            defer { hourDate = hourDate.addingTimeInterval(3600) }
            guard presses > 0 else { continue }
            let hour = Int(hourDate.timeIntervalSince1970 / 3600)
            let day = Int(calendar.startOfDay(for: hourDate).timeIntervalSince1970)
            if hourDate >= hourlyKeysFrom { result.hours[hour] = ClickyActivityBucket(presses: presses, releases: presses) }
            result.days[day, default: ClickyActivityBucket()].presses += presses
            result.days[day, default: ClickyActivityBucket()].releases += presses
            var performance = ClickyPerformanceBucket()
            performance.presses = presses
            performance.characters = Int(Double(presses) * 0.8)
            performance.corrections = Int(Double(presses) * (0.04 + 0.02 * season))
            performance.activeSeconds = Double(performance.characters) / (3.6 + 0.6 * season)
            performance.bursts = max(1, presses / 40)
            performance.sessions = max(1, presses / 300)
            result.performanceHours[hour] = performance
            result.presses += presses
            result.releases += presses
        }
        let positions = ClickyKeyLayout.rows.flatMap { $0 }
        let weights = positions.enumerated().map { ($0.element.code, 1 + ($0.offset * 13) % 31) }
        let total = weights.reduce(0) { $0 + $1.1 }
        for (code, weight) in weights { result.keys[code] = result.presses * weight / total }
        result.keys[49, default: 0] += result.presses - result.keys.values.reduce(0, +)
        return result
    }
}

public enum ClickyKeyLayout {
    public struct Key: Identifiable { public let code: Int; public let label: String; public var id: Int { code } }
    public static let rows: [[Key]] = [
        [(53,"Esc"),(122,"F1"),(120,"F2"),(99,"F3"),(118,"F4"),(96,"F5"),(97,"F6"),(98,"F7"),(100,"F8"),(101,"F9"),(109,"F10"),(103,"F11"),(111,"F12")],
        [(50,"`"),(18,"1"),(19,"2"),(20,"3"),(21,"4"),(23,"5"),(22,"6"),(26,"7"),(28,"8"),(25,"9"),(29,"0"),(27,"−"),(24,"="),(51,"⌫")],
        [(48,"⇥"),(12,"Q"),(13,"W"),(14,"E"),(15,"R"),(17,"T"),(16,"Y"),(32,"U"),(34,"I"),(31,"O"),(35,"P"),(33,"["),(30,"]"),(42,"\\")],
        [(57,"⇪"),(0,"A"),(1,"S"),(2,"D"),(3,"F"),(5,"G"),(4,"H"),(38,"J"),(40,"K"),(37,"L"),(41,";"),(39,"'"),(36,"↵")],
        [(56,"⇧"),(6,"Z"),(7,"X"),(8,"C"),(9,"V"),(11,"B"),(45,"N"),(46,"M"),(43,","),(47,"."),(44,"/"),(60,"⇧ R")],
        [(63,"Fn"),(59,"⌃"),(58,"⌥"),(55,"⌘"),(49,"Space"),(54,"⌘ R"),(61,"⌥ R"),(123,"←"),(126,"↑"),(125,"↓"),(124,"→")]
    ].map { $0.map { Key(code: $0.0, label: $0.1) } }
    public static func label(_ code: Int) -> String {
        rows.lazy.flatMap { $0 }.first { $0.code == code }?.label ?? "Key \(code)"
    }
}

/// Everything the Stats page shows for one range, built off the main thread once per refresh instead of in the view
/// body on every published second.
struct ClickyStatsReport: Sendable {
    var interval = DateInterval()
    var total = 0
    var previousTotal: Int?
    var approximateTotals = false
    var totalDays = 0
    var coveredDays = 0
    var activeDays = 0
    var records = ClickyRecords(days: [:], today: Date())
    var busiestHour: Date?
    var busiestHourValue = 0
    var peakMinute: Date?
    var peakMinuteValue = 0
    var timeline: [NativeTimePoint] = []
    var dayTimeline: [NativeTimePoint] = []
    /// Hour-of-day by weekday, rows in the calendar's weekday order.
    var heatmap: [NativeHeatmapCell] = []
    /// Average presses per occurrence of each weekday in the range, Monday-based.
    var weekdayAverages = Array(repeating: 0.0, count: 7)
    var loaded = false

    init() {}

    var dailyAverage: Double { coveredDays > 0 ? Double(total) / Double(coveredDays) : 0 }

    init(statistics: ClickyStatistics, interval: DateInterval, previous: DateInterval?,
        resolution: ClickyTimeResolution, releases: Bool, now: Date, calendar: Calendar = .current) {
        self.interval = interval
        loaded = true
        let earliest = ClickyRetention.historyStart(statistics, now: now, calendar: calendar)
        totalDays = ClickyRanges.dayCount(interval, calendar: calendar)
        coveredDays = ClickyRanges.coveredDays(interval, earliest: earliest, calendar: calendar)
        let minuteRetention = floor(now.timeIntervalSince1970 / 3600) * 3600 - 30 * 86400
        let hourRetention = floor(now.timeIntervalSince1970 / 3600) * 3600 - 366 * 86400
        func presses(in range: DateInterval) -> (count: Int, approximate: Bool) {
            var count = 0
            var approximate = false
            for (key, bucket) in statistics.days {
                let day = Date(timeIntervalSince1970: Double(key))
                let dayEnd = calendar.date(byAdding: .day, value: 1, to: day) ?? day.addingTimeInterval(86400)
                guard day < range.end, dayEnd > range.start else { continue }
                if day >= range.start && dayEnd <= range.end {
                    count += bucket.presses
                } else if day.timeIntervalSince1970 >= hourRetention {
                    for (hour, hourly) in statistics.hours {
                        let start = Double(hour) * 3600
                        let end = start + 3600
                        guard start >= day.timeIntervalSince1970, start < dayEnd.timeIntervalSince1970,
                            start < range.end.timeIntervalSince1970, end > range.start.timeIntervalSince1970 else { continue }
                        if start >= range.start.timeIntervalSince1970 && end <= range.end.timeIntervalSince1970 {
                            count += hourly.presses
                        } else if start >= minuteRetention {
                            count += statistics.minutes.reduce(0) { sum, entry in
                                let date = Date(timeIntervalSince1970: Double(entry.key) * 60)
                                return entry.key / 60 == hour && date >= range.start && date < range.end
                                    ? sum + entry.value.presses : sum
                            }
                        } else {
                            count += hourly.presses
                            approximate = true
                        }
                    }
                } else {
                    count += bucket.presses
                    approximate = true
                }
            }
            return (count, approximate)
        }
        let current = presses(in: interval)
        total = current.count
        approximateTotals = current.approximate
        if let previous, let earliest, earliest < previous.end {
            let comparison = presses(in: previous)
            previousTotal = comparison.count
            approximateTotals = approximateTotals || comparison.approximate
        }

        var daily: [Date: Double] = [:]
        for (key, bucket) in statistics.days {
            let day = Date(timeIntervalSince1970: Double(key))
            guard day >= calendar.startOfDay(for: interval.start), day < interval.end else { continue }
            daily[day] = Double(bucket.presses)
        }
        activeDays = daily.values.filter { $0 > 0 }.count
        records = ClickyRecords(days: daily, today: now, calendar: calendar)
        dayTimeline = daily.map { NativeTimePoint(date: $0.key, value: $0.value) }.sorted { $0.date < $1.date }

        var cells: [Int: Double] = [:]
        for (key, bucket) in statistics.hours {
            let date = Date(timeIntervalSince1970: Double(key) * 3600)
            guard interval.contains(date), date < interval.end else { continue }
            if bucket.presses > busiestHourValue { busiestHourValue = bucket.presses; busiestHour = date }
            cells[ClickyWeekdays.index(of: date, calendar: calendar) * 24 + calendar.component(.hour, from: date),
                default: 0] += Double(bucket.presses)
        }
        let order = ClickyWeekdays.order(calendar)
        heatmap = order.enumerated().flatMap { row, weekday in
            (0..<24).map { NativeHeatmapCell(row: row, column: $0, value: cells[weekday * 24 + $0, default: 0]) }
        }
        var occurrences = Array(repeating: 0, count: 7)
        if let earliest, coveredDays > 0 {
            var day = max(calendar.startOfDay(for: interval.start), calendar.startOfDay(for: earliest))
            while day < interval.end {
                occurrences[ClickyWeekdays.index(of: day, calendar: calendar)] += 1
                guard let next = calendar.date(byAdding: .day, value: 1, to: day) else { break }
                day = next
            }
        }
        var weekdayTotals = Array(repeating: 0.0, count: 7)
        for (day, value) in daily { weekdayTotals[ClickyWeekdays.index(of: day, calendar: calendar)] += value }
        weekdayAverages = (0..<7).map { occurrences[$0] > 0 ? weekdayTotals[$0] / Double(occurrences[$0]) : 0 }

        let firstMinute = Int(floor(interval.start.timeIntervalSince1970 / 60))
        for (minute, bucket) in statistics.minutes where minute >= firstMinute && bucket.presses > peakMinuteValue {
            peakMinuteValue = bucket.presses
            peakMinute = Date(timeIntervalSince1970: Double(minute) * 60)
        }
        timeline = statistics.timeline(resolution, releases: releases).filter { $0.date >= interval.start }
    }

    static func prepare(statistics: ClickyStatistics, interval: DateInterval, previous: DateInterval?,
        resolution: ClickyTimeResolution, releases: Bool, now: Date) async -> Self? {
        let worker = Task.detached(priority: .userInitiated) {
            PerfLog.span("clicky.stats.report", over: PerfLog.frameMs) {
                Self(statistics: statistics, interval: interval, previous: previous, resolution: resolution,
                    releases: releases, now: now)
            }
        }
        let report = await withTaskCancellationHandler { await worker.value } onCancel: { worker.cancel() }
        return Task.isCancelled ? nil : report
    }
}
