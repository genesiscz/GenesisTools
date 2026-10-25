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
