import AppKit
import SwiftUI
import XCTest

@testable import GenesisKitBase
@testable import GenesisKit

/// The Stats and Performance pages: ranges, comparisons, the dictation estimate, calendar bins and pictures of both
/// pages with the sample data.
@MainActor
final class ClickyStatsPagesTests: XCTestCase {
    private func calendar(firstWeekday: Int = 2) -> Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague")!
        calendar.locale = Locale(identifier: "en_US")
        calendar.firstWeekday = firstWeekday
        return calendar
    }

    private func date(_ text: String) -> Date { ISO8601DateFormatter().date(from: text)! }

    func testDictationEstimateAppliesTheDictatedShareToBothSidesAndAddsReview() {
        var totals = ClickyPerformanceBucket()
        totals.characters = 750; totals.corrections = 50; totals.activeSeconds = 180; totals.sessions = 2
        let estimate = ClickyDictationEstimate(totals: totals, wordsPerMinute: 140, setupPerSession: 3,
            dictatedShare: 0.7, reviewShare: 0.15)
        XCTAssertEqual(estimate.retainedWords, 98, accuracy: 0.0001)
        XCTAssertEqual(estimate.typingSeconds, 126, accuracy: 0.0001)
        XCTAssertEqual(estimate.speakingSeconds, 42, accuracy: 0.0001)
        XCTAssertEqual(estimate.setupSeconds, 4.2, accuracy: 0.0001)
        XCTAssertEqual(estimate.reviewSeconds, 6.3, accuracy: 0.0001)
        XCTAssertEqual(estimate.differenceSeconds, 126 - 52.5, accuracy: 0.0001)
        let none = ClickyDictationEstimate(totals: totals, wordsPerMinute: 140, setupPerSession: 3, dictatedShare: 0)
        XCTAssertEqual(none.differenceSeconds, 0, "0% dictated compares nothing")
    }

    func testRangesPreviousPeriodsAndCoverage() {
        let calendar = calendar()
        let now = date("2026-10-25T14:30:00Z")
        let week = ClickyRanges.interval(ClickyRanges.week, now: now, earliest: nil, calendar: calendar)
        XCTAssertEqual(ClickyRanges.dayCount(week, calendar: calendar), 7)
        let previous = ClickyRanges.previous(week, range: ClickyRanges.week, calendar: calendar)!
        XCTAssertEqual(ClickyRanges.dayCount(previous, calendar: calendar), 7)
        XCTAssertEqual(previous.end, calendar.date(byAdding: .day, value: -7, to: now))
        let today = ClickyRanges.interval(ClickyRanges.today, now: now, earliest: nil, calendar: calendar)
        let yesterday = ClickyRanges.previous(today, range: ClickyRanges.today, calendar: calendar)!
        XCTAssertEqual(yesterday.duration, today.duration, accuracy: 3600, "yesterday until the same time")
        XCTAssertNil(ClickyRanges.previous(today, range: ClickyRanges.all, calendar: calendar))
        let started = calendar.date(byAdding: .day, value: -2, to: now)!
        let year = ClickyRanges.interval(ClickyRanges.year, now: now, earliest: started, calendar: calendar)
        XCTAssertEqual(ClickyRanges.coverageText(year, earliest: started, calendar: calendar),
            "Recorded data covers 3 of the 366 days in this range.")
        XCTAssertNil(ClickyRanges.coverageText(today, earliest: started, calendar: calendar))
        XCTAssertEqual(ClickyRanges.groupings(for: year, now: now).map(\.rawValue), [3600, 86400, 604800],
            "no minute grouping past the 30 days of minute detail")
        XCTAssertEqual(ClickyRanges.grouping(for: ClickyRanges.custom, span: 86400), .fifteenMinutes)
        XCTAssertEqual(ClickyRanges.grouping(for: ClickyRanges.custom, span: 120 * 86400), .day)
    }

    func testWeekBinsStartOnTheCalendarsFirstWeekday() {
        let monday = calendar(firstWeekday: 2)
        let points = [
            NativeTimePoint(date: date("2026-10-21T10:00:00Z"), value: 2),  // Wednesday
            NativeTimePoint(date: date("2026-10-25T10:00:00Z"), value: 3),  // Sunday
        ]
        let start = date("2026-10-01T00:00:00Z")
        let end = date("2026-10-25T20:00:00Z")
        let mondayBins = NativeChartSampling.bins(points: points, start: start, end: end, step: 604800, calendar: monday)
        XCTAssertEqual(mondayBins.map(\.value), [5])
        XCTAssertEqual(monday.component(.weekday, from: mondayBins[0].date), 2, "the week bar is dated on Monday")
        let sunday = calendar(firstWeekday: 1)
        let sundayBins = NativeChartSampling.bins(points: points, start: start, end: end, step: 604800, calendar: sunday)
        XCTAssertEqual(sundayBins.map(\.value), [2, 3], "a Sunday-first calendar starts a new week on Sunday")
        let span = NativeChartSampling.spanText(mondayBins[0].date, step: 604800, calendar: monday)
        let sundayText = monday.date(byAdding: .day, value: 6, to: mondayBins[0].date)!
            .formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())
        XCTAssertTrue(span.hasSuffix(" to \(sundayText)"), "a week bar names its whole span: \(span)")
    }

    func testZoomFractionIsFiniteWithNoZoomRangeAndClampsNormalRanges() {
        XCTAssertEqual(NativeChartSampling.zoomFraction(1, minimum: 1, maximum: 1), 0)
        XCTAssertEqual(NativeChartSampling.zoomFraction(2, minimum: 1, maximum: 4), 0.5, accuracy: 0.0001)
        XCTAssertEqual(NativeChartSampling.zoomFraction(8, minimum: 1, maximum: 4), 1)
        XCTAssertEqual(NativeChartSampling.zoomFraction(0.5, minimum: 1, maximum: 4), 0)
    }

    func testFittedDomainIncludesTheFirstPartialWeek() {
        let calendar = calendar()
        let start = date("2026-10-21T10:00:00Z")
        let end = date("2026-12-25T10:00:00Z")
        var stats = ClickyStatistics()
        stats.record(keyCode: 0, release: false, at: start, calendar: calendar)
        let report = ClickyPerformanceReport(statistics: stats,
            filter: ClickyPerformanceFilter(start: start, end: end), grouping: .week, calendar: calendar)
        let first = report.timeline.first!.date
        XCTAssertLessThan(first, start)
        XCTAssertEqual(NativeChartSampling.fittedStart(start, firstPoint: first), first)
        let points = report.timeline.map { NativeTimePoint(date: $0.date, value: Double($0.totals.presses)) }
        let bins = NativeChartSampling.bins(points: points,
            start: NativeChartSampling.fittedStart(start, firstPoint: first), end: end, step: 604800, calendar: calendar)
        XCTAssertEqual(bins.reduce(0) { $0 + $1.value }, Double(report.total.presses))
        XCTAssertEqual(NativeChartSampling.fittedStart(start, firstPoint: nil), start)
    }

    func testComparisonUsesMinutesOnBothSidesOfPartialHourBoundaries() {
        let calendar = calendar()
        let now = date("2026-10-25T14:05:00Z")
        let start = calendar.startOfDay(for: now)
        let interval = DateInterval(start: start, end: now)
        let previous = ClickyRanges.previous(interval, range: ClickyRanges.today, calendar: calendar)!
        let cutoff = previous.end
        var stats = ClickyStatistics()
        for at in [cutoff.addingTimeInterval(-60), cutoff.addingTimeInterval(60), now.addingTimeInterval(-60)] {
            stats.record(keyCode: 0, release: false, at: at, calendar: calendar)
        }
        let report = ClickyStatsReport(statistics: stats, interval: interval, previous: previous,
            resolution: .minute, releases: false, now: now, calendar: calendar)
        XCTAssertEqual(report.total, 1)
        XCTAssertEqual(report.previousTotal, 1, "the later press is after yesterday's local-time cutoff, even across DST")
        XCTAssertFalse(report.approximateTotals)

        let partial = ClickyStatsReport(statistics: stats,
            interval: DateInterval(start: cutoff, end: cutoff.addingTimeInterval(120)),
            previous: nil, resolution: .minute, releases: false, now: now, calendar: calendar)
        XCTAssertEqual(partial.total, 1, "the leading boundary excludes the earlier press")
    }

    func testComparisonDisclosesExpiredMinutePrecision() {
        let calendar = calendar()
        let now = date("2026-10-25T14:05:00Z")
        let at = date("2026-08-24T14:04:00Z")
        var stats = ClickyStatistics()
        stats.record(keyCode: 0, release: false, at: at, calendar: calendar)
        stats.minutes = [:]
        let report = ClickyStatsReport(statistics: stats,
            interval: DateInterval(start: calendar.startOfDay(for: at), end: at.addingTimeInterval(60)),
            previous: nil, resolution: .hour, releases: false, now: now, calendar: calendar)
        XCTAssertEqual(report.total, 1)
        XCTAssertTrue(report.approximateTotals)
    }

    func testAverageBinsLeaveEmptySlotsOutAndDoNotAddRates() {
        let points = [
            NativeTimePoint(date: Date(timeIntervalSince1970: 0), value: 40),
            NativeTimePoint(date: Date(timeIntervalSince1970: 60), value: 60),
            NativeTimePoint(date: Date(timeIntervalSince1970: 600), value: 50),
        ]
        let bins = NativeChartSampling.bins(points: points, start: Date(timeIntervalSince1970: 0),
            end: Date(timeIntervalSince1970: 1200), step: 300, combine: .average)
        XCTAssertEqual(bins.map(\.value), [50, 50])
        XCTAssertEqual(bins.map(\.date.timeIntervalSince1970), [0, 600])
    }

    func testRecordsFindTheBusiestDayAndStreaks() {
        let calendar = calendar()
        let today = calendar.startOfDay(for: date("2026-10-25T10:00:00Z"))
        func day(_ offset: Int) -> Date { calendar.date(byAdding: .day, value: offset, to: today)! }
        let records = ClickyRecords(days: [day(-9): 5, day(-8): 50, day(-7): 5, day(-6): 5, day(-3): 0, day(-1): 1, day(0): 2],
            today: today, calendar: calendar)
        XCTAssertEqual(records.busiestDay, day(-8))
        XCTAssertEqual(records.longestStreak, 4)
        XCTAssertEqual(records.currentStreak, 2)
    }

    func testStatsReportTotalsComparesAndOrdersWeekdays() {
        let calendar = calendar(firstWeekday: 1)
        var stats = ClickyStatistics()
        let now = date("2026-10-25T14:30:00Z")
        for offset in (0..<10).reversed() {
            let at = calendar.date(byAdding: .day, value: -offset, to: now)!.addingTimeInterval(-3600)
            for _ in 0..<(offset + 1) { stats.record(keyCode: 0, release: false, at: at, calendar: calendar) }
        }
        let week = ClickyRanges.interval(ClickyRanges.week, now: now, earliest: stats.historyStartedAt, calendar: calendar)
        let report = ClickyStatsReport(statistics: stats, interval: week,
            previous: ClickyRanges.previous(week, range: ClickyRanges.week, calendar: calendar),
            resolution: .hour, releases: false, now: now, calendar: calendar)
        XCTAssertEqual(report.total, (1...7).reduce(0, +))
        XCTAssertEqual(report.previousTotal, 8 + 9 + 10)
        XCTAssertEqual(report.activeDays, 7)
        XCTAssertEqual(report.records.currentStreak, 7)
        XCTAssertEqual(report.heatmap.count, 7 * 24)
        XCTAssertEqual(ClickyWeekdays.order(calendar).first, 6, "a Sunday-first calendar lists Sunday first")
        let sundayRow = report.heatmap.filter { $0.row == 0 }.reduce(0) { $0 + $1.value }
        XCTAssertEqual(sundayRow, 1, "today is a Sunday with one press")
    }

    func testReleaseChartKeepsPressSummaryAndDailyRhythm() {
        let calendar = calendar()
        let now = date("2026-10-25T14:30:00Z")
        var stats = ClickyStatistics()
        stats.record(keyCode: 0, release: false, at: now.addingTimeInterval(-86400), calendar: calendar)
        stats.record(keyCode: 0, release: true, at: now.addingTimeInterval(-60), calendar: calendar)
        let interval = ClickyRanges.interval(ClickyRanges.week, now: now, earliest: stats.historyStartedAt, calendar: calendar)
        let report = ClickyStatsReport(statistics: stats, interval: interval, previous: nil,
            resolution: .minute, releases: true, now: now, calendar: calendar)
        XCTAssertEqual(report.total, 1)
        XCTAssertEqual(report.records.busiestDay, calendar.startOfDay(for: now.addingTimeInterval(-86400)))
        XCTAssertEqual(report.dayTimeline.reduce(0) { $0 + $1.value }, 1)
        XCTAssertEqual(report.dayTimeline.first { $0.date == calendar.startOfDay(for: now) }?.value, 0)
        XCTAssertEqual(report.timeline.reduce(0) { $0 + $1.value }, 1, "the Activity chart still shows releases")
    }

    func testStatsResolutionsRespectBothRetentionTiers() {
        let now = date("2026-10-25T14:30:00Z")
        func available(_ days: Double) -> [ClickyTimeResolution] {
            ClickyRanges.resolutions(for: DateInterval(start: now.addingTimeInterval(-days * 86400), end: now), now: now)
        }
        XCTAssertEqual(available(7), [.minute, .hour, .day])
        XCTAssertEqual(available(90), [.hour, .day])
        XCTAssertEqual(available(730), [.day], "a two-year hourly chart would silently omit its first year")
    }

    func testCustomGroupingClampsRestoredAndChangedChoicesToRetention() {
        let now = date("2026-10-25T14:30:00Z")
        let oldStart = now.addingTimeInterval(-180 * 86400)
        let oldDay = DateInterval(start: oldStart, end: oldStart.addingTimeInterval(86400))
        let suggested = ClickyRanges.grouping(for: ClickyRanges.custom, span: oldDay.duration)
        XCTAssertEqual(suggested, .fifteenMinutes)
        XCTAssertEqual(ClickyRanges.validGrouping(suggested, for: oldDay, now: now), .hour)
        XCTAssertEqual(ClickyRanges.validGrouping(.week, for: oldDay, now: now), .week)
        let recentDay = DateInterval(start: now.addingTimeInterval(-86400), end: now)
        XCTAssertEqual(ClickyRanges.validGrouping(suggested, for: recentDay, now: now), .fifteenMinutes)
        for preferred in ClickyPerformanceGrouping.allCases {
            XCTAssertTrue(ClickyRanges.groupings(for: oldDay, now: now)
                .contains(ClickyRanges.validGrouping(preferred, for: oldDay, now: now)))
        }
    }

    func testRetainedCoverageDoesNotCountExpiredYearsOrCustomDates() {
        let calendar = calendar()
        let now = date("2026-10-25T14:30:00Z")
        let original = calendar.date(byAdding: .year, value: -3, to: now)!
        var stats = ClickyStatistics()
        stats.record(keyCode: 0, release: false, at: original, calendar: calendar)
        stats.record(keyCode: 0, release: false, at: now.addingTimeInterval(-60), calendar: calendar)
        let history = ClickyRetention.historyStart(stats, now: now, calendar: calendar)!
        let performance = ClickyRetention.performanceStart(stats, now: now)!
        XCTAssertEqual(history, calendar.date(byAdding: .day, value: -729, to: calendar.startOfDay(for: now)))
        XCTAssertEqual(performance.timeIntervalSince1970, floor(now.timeIntervalSince1970 / 3600) * 3600 - 730 * 86400)
        XCTAssertEqual(stats.historyStartedAt, original, "the history-since label keeps the original date")
        XCTAssertEqual(stats.performanceStartedAt, original)
        let all = ClickyRanges.interval(ClickyRanges.all, now: now, earliest: history, calendar: calendar)
        let report = ClickyStatsReport(statistics: stats, interval: all, previous: nil,
            resolution: .day, releases: false, now: now, calendar: calendar)
        XCTAssertEqual(report.coveredDays, 730)
        XCTAssertEqual(report.total, 1)
        XCTAssertEqual(report.dailyAverage, 1.0 / 730, accuracy: 0.000001)
        let expired = DateInterval(start: original, end: original.addingTimeInterval(86400))
        XCTAssertEqual(ClickyRanges.coveredDays(expired, earliest: history, calendar: calendar), 0)
        XCTAssertEqual(ClickyRanges.coveredDays(expired, earliest: performance, calendar: calendar), 0)
        XCTAssertEqual(ClickyRanges.coverageText(expired, earliest: performance, calendar: calendar),
            "Nothing was recorded in this range yet.")
    }

    func testRetainedCoverageFallsBackToBucketsWithoutLegacyTimestamps() {
        let calendar = calendar()
        let now = date("2026-10-25T14:30:00Z")
        var stats = ClickyStatistics()
        XCTAssertNil(ClickyRetention.historyStart(stats, now: now, calendar: calendar))
        XCTAssertNil(ClickyRetention.performanceStart(stats, now: now))
        let day = calendar.startOfDay(for: now.addingTimeInterval(-86400))
        stats.days[Int(day.timeIntervalSince1970)] = ClickyActivityBucket(presses: 1)
        stats.performanceMinutes[Int(day.timeIntervalSince1970 / 60)] = ClickyPerformanceBucket()
        XCTAssertEqual(ClickyRetention.historyStart(stats, now: now, calendar: calendar), day)
        XCTAssertEqual(ClickyRetention.performanceStart(stats, now: now), day)
    }

    func testRecordingPauseReasonsFollowTheCollectionPolicy() {
        XCTAssertEqual(ClickyRecordingStatus.pause(systemSleeping: true, takingBreak: true, quiet: true, excluded: true), .macSleeping)
        XCTAssertEqual(ClickyRecordingStatus.pause(systemSleeping: false, takingBreak: true, quiet: true, excluded: true), .takingBreak)
        XCTAssertEqual(ClickyRecordingStatus.pause(systemSleeping: false, takingBreak: false, quiet: true, excluded: true), .quietHours)
        XCTAssertEqual(ClickyRecordingStatus.pause(systemSleeping: false, takingBreak: false, quiet: false, excluded: true), .excludedApplication)
        XCTAssertNil(ClickyRecordingStatus.pause(systemSleeping: false, takingBreak: false, quiet: false, excluded: false))
        for status in [ClickyRecordingStatus.takingBreak, .quietHours, .excludedApplication, .macSleeping] {
            XCTAssertNotNil(status.message)
        }
        XCTAssertEqual(ClickyRecordingStatus.takingBreak.actionTitle, "Resume Clicky")
        XCTAssertEqual(ClickyRecordingStatus.quietHours.actionTitle, "Turn Off Quiet Hours")
        XCTAssertTrue(ClickyRecordingStatus.excludedApplication.actionTitle.isEmpty)
        XCTAssertTrue(ClickyRecordingStatus.macSleeping.actionTitle.isEmpty)
    }

    func testRecordingStatusNamesTheReasonAndTheFix() {
        XCTAssertNil(ClickyRecordingStatus.recording.message)
        XCTAssertEqual(ClickyRecordingStatus.statisticsOff.actionTitle, "Turn On Statistics")
        XCTAssertTrue(ClickyRecordingStatus.inputMonitoringMissing.message?.contains("Input Monitoring") == true)
    }

    // MARK: Pictures

    private func page(_ content: some View) -> some View {
        ScrollView { content.padding(24) }
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
    }

    private func defaults(_ values: [String: Any]) -> UserDefaults {
        let name = "clicky.stats.shots.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: name)!
        defaults.removePersistentDomain(forName: name)
        for (key, value) in values { defaults.set(value, forKey: key) }
        return defaults
    }

    func testPerformancePageRendersTheSampleData() throws {
        let store = ClickyAnalyticsStore()
        store.flush(ClickyStatistics.example(now: Date()))
        for (range, name) in [("7 days", "clicky-performance-7days"), ("1 year", "clicky-performance-1year")] {
            let view = page(ClickyPerformanceView(store: store, defaults: defaults(["clicky.performance.range": range]),
                status: .clickyOff, fixRecording: {}))
            let rep = try KitShots.render(view, size: CGSize(width: 820, height: 3300), name: name, settle: 3)
            XCTAssertGreaterThan(KitShots.brightness(rep, in: CGRect(x: 0, y: 0, width: 820, height: 600), viewWidth: 820), 0.02)
        }
    }

    func testStatsPageRendersTheSampleData() throws {
        let store = ClickyAnalyticsStore()
        store.flush(ClickyStatistics.example(now: Date()))
        for (range, tab, name) in [("30 days", "Activity", "clicky-stats-30days"), ("1 year", "Rhythm", "clicky-stats-1year-rhythm")] {
            let view = page(ClickyAnalyticsView(store: store,
                defaults: defaults(["clicky.stats.range": range, "clicky.stats.tab": tab])))
            let rep = try KitShots.render(view, size: CGSize(width: 820, height: 1500), name: name, settle: 3)
            XCTAssertGreaterThan(KitShots.brightness(rep, in: CGRect(x: 0, y: 0, width: 820, height: 600), viewWidth: 820), 0.02)
        }
    }
}
