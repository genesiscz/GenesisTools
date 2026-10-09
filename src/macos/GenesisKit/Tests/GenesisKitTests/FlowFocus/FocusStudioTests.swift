// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusStudioTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// Spec 22 (S6) §10.8 — the Studio's numbers must equal the CLI's for the same range.
/// These use the same fixture shape as `apps/cli/lib/activityDb.test.ts`, so when the two
/// disagree one of these fails rather than a screenshot quietly lying.
final class FocusAggregateTests: XCTestCase {
    private let base: Int64 = 1_700_000_000_000
    private let minute: Int64 = 60_000

    private func segment(_ startMin: Int64, _ durationMin: Int64, app: String,
                         host: String? = nil, project: String? = nil, idle: Bool = false) -> ActivityStore.Segment {
        var row = ActivityStore.Segment(startedMs: base + startMin * minute,
                                        appBundle: "bundle.\(app)", appName: app)
        row.endedMs = base + (startMin + durationMin) * minute
        row.urlHost = host
        row.project = project
        row.idle = idle
        row.id = startMin
        return row
    }

    /// Cursor 20, Brave 5 (github), Brave 5 (teams), Cursor 10, Cursor 20 idle.
    private var fixture: [ActivityStore.Segment] {
        [segment(0, 20, app: "Cursor", project: "genesis"),
         segment(20, 5, app: "Brave", host: "github.com", project: "genesis"),
         segment(25, 5, app: "Brave", host: "teams.microsoft.com"),
         segment(30, 10, app: "Cursor", project: "genesis"),
         segment(40, 20, app: "Cursor", project: "genesis", idle: true)]
    }

    func testIdleIsNeverCountedAsFocus() {
        let totals = FocusAggregate.totals(fixture, from: base, to: base + 120 * minute, now: base)
        XCTAssertEqual(totals.focusedMs, 40 * minute)
        XCTAssertEqual(totals.idleMs, 20 * minute)
    }

    func testSwitchesCountAppChangesAndIdleBreaksTheStretch() {
        let totals = FocusAggregate.totals(fixture, from: base, to: base + 120 * minute, now: base)
        // Cursor → Brave → Brave (same app) → Cursor = 2; the idle tail adds none.
        XCTAssertEqual(totals.switches, 2)
        XCTAssertEqual(totals.longestStretchMs, 20 * minute)
    }

    func testAppBucketsSumToFocusedTime() {
        let to = base + 120 * minute
        let totals = FocusAggregate.totals(fixture, from: base, to: to, now: base)
        let apps = FocusAggregate.buckets(fixture, from: base, to: to, now: base) { $0.appName }
        XCTAssertEqual(apps.reduce(Int64(0)) { $0 + $1.ms }, totals.focusedMs)
        XCTAssertEqual(apps.first?.key, "Cursor")
        XCTAssertEqual(apps.first?.ms, 30 * minute)
        XCTAssertEqual(apps.first?.visits, 2, "returning to an app is a second visit")
    }

    func testHostBucketsIgnoreSegmentsWithoutAHost() {
        let hosts = FocusAggregate.buckets(fixture, from: base, to: base + 120 * minute, now: base) { $0.urlHost }
        XCTAssertEqual(hosts.map(\.key).sorted(), ["github.com", "teams.microsoft.com"])
        XCTAssertEqual(hosts.reduce(Int64(0)) { $0 + $1.ms }, 10 * minute)
    }

    func testOpenSegmentIsClippedAtNowNotAtInfinity() {
        var open = segment(0, 0, app: "Cursor")
        open.endedMs = nil
        let now = base + 7 * minute
        let totals = FocusAggregate.totals([open], from: base, to: base + 120 * minute, now: now)
        XCTAssertEqual(totals.focusedMs, 7 * minute)
    }

    func testHeatmapAttributesToTheStartingHour() {
        let cells = FocusAggregate.heatmap(fixture, from: base, to: base + 120 * minute, now: base)
        XCTAssertFalse(cells.isEmpty)
        XCTAssertEqual(cells.reduce(Int64(0)) { $0 + $1.ms }, 40 * minute,
                       "idle segments stay out of the heatmap too")
    }

    func testHeatmapIsClippedToTheRangeLikeTheTotals() {
        // Cursor 0-20 starts before the range and Cursor 30-40 runs past it: only the part
        // inside counts, the same as the footer's focused total.
        let from = base + 10 * minute, to = base + 35 * minute
        let cells = FocusAggregate.heatmap(fixture, from: from, to: to, now: base)
        let totals = FocusAggregate.totals(fixture, from: from, to: to, now: base)
        XCTAssertEqual(cells.reduce(Int64(0)) { $0 + $1.ms }, totals.focusedMs)
        XCTAssertEqual(totals.focusedMs, 25 * minute)
    }
}

final class FocusFormatTests: XCTestCase {
    func testDurationReadsLikeAPersonWroteIt() {
        XCTAssertEqual(FocusFormat.duration(90 * 60_000), "1h 30m")
        XCTAssertEqual(FocusFormat.duration(45 * 60_000), "45m")
        XCTAssertEqual(FocusFormat.duration(20_000), "20s")
    }

    func testClockHandlesOverrunWithASign() {
        XCTAssertEqual(FocusHUDView.clock(125), "2:05")
        XCTAssertEqual(FocusHUDView.clock(-65), "+1:05", "an overrunning flow counts up")
        XCTAssertEqual(FocusHUDView.clock(0), "0:00")
        XCTAssertEqual(FocusHUDView.clock(-21_045), "+5:50:45", "an overrun past the hour shows hours")
    }

    func testDayKeyUsesTheLocalCalendarNotUTC() {
        // A local midnight formatted through ISO would land on the previous day east of UTC,
        // which is the bug this helper exists to avoid.
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague") ?? .current
        let date = calendar.date(from: DateComponents(year: 2026, month: 9, day: 21, hour: 0, minute: 30))!
        XCTAssertEqual(FocusFormat.dayKey(date, calendar: calendar), "2026-09-21")
    }
}

/// 09:00 local on the day that starts at `dayStartMs`. Adding 9 hours to midnight lands on 10:00 on a spring-forward
/// day, and the Studio lays its lanes out in local time.
func localMs(hour: Int, onDayOf dayStartMs: Int64) -> Int64 {
    let start = Date(timeIntervalSince1970: Double(dayStartMs) / 1000)
    let date = Calendar.current.date(bySettingHour: hour, minute: 0, second: 0, of: start)!
    return Int64(date.timeIntervalSince1970 * 1000)
}

final class FocusRangeTests: XCTestCase {
    /// UTC has no daylight-saving days, so a day is always 24 hours here; a local day can be 23 or 25.
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar
    }

    func testDayRangeIsExactlyOneDay() {
        let date = utc.date(from: DateComponents(year: 2026, month: 9, day: 23, hour: 12))!
        let range = FocusRange.make(.day, containing: date, calendar: utc)
        XCTAssertEqual(range.toMs - range.fromMs, 86_400_000)
        XCTAssertEqual(range.granularity, .day)
    }

    func testWeekRangeStartsOnMonday() {
        var calendar = Calendar(identifier: .gregorian)
        calendar.firstWeekday = 2
        let wednesday = calendar.date(from: DateComponents(year: 2026, month: 9, day: 23))!
        let range = FocusRange.make(.week, containing: wednesday, calendar: calendar)
        let start = Date(timeIntervalSince1970: Double(range.fromMs) / 1000)
        XCTAssertEqual(calendar.component(.weekday, from: start), 2, "Monday")
        XCTAssertEqual(range.toMs - range.fromMs, 7 * 86_400_000)
    }

    func testSteppingMovesByTheGranularity() {
        let date = utc.date(from: DateComponents(year: 2026, month: 9, day: 23, hour: 12))!
        let day = FocusRange.make(.day, containing: date, calendar: utc)
        let yesterday = day.stepped(by: -1, calendar: utc)
        XCTAssertEqual(day.fromMs - yesterday.fromMs, 86_400_000)
        XCTAssertEqual(yesterday.granularity, .day)
    }
}

@MainActor
final class FocusStudioModelTests: XCTestCase {
    private var path: String!
    private var store: ActivityStore!
    private var model: FocusStudioModel!

    override func setUpWithError() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-studio-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        path = dir.appendingPathComponent("activity.db").path
        store = try ActivityStore(path: path)
        model = FocusStudioModel(store: store)
    }

    override func tearDownWithError() throws {
        model = nil
        store = nil
        try? FileManager.default.removeItem(atPath: (path as NSString).deletingLastPathComponent)
    }

    private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }

    func testFilteredRecordedActivityDoesNotClaimNothingWasRecorded() throws {
        let from = localMs(hour: 9, onDayOf: model.range.fromMs)
        _ = try store.openSegment(.init(startedMs: from, endedMs: from + 60_000,
                                        appBundle: "test.editor", appName: "Fixture editor"))
        model.search = "does-not-match-any-fixture"
        model.reload(now: Date(timeIntervalSince1970: Double(from + 120_000) / 1000))
        XCTAssertEqual(model.emptiness, .noMatches)
        XCTAssertTrue(model.bars.isEmpty)
    }

    func testSelectedSessionClipsTimelineBarsToTheSameWindowAsTotals() throws {
        let nine = localMs(hour: 9, onDayOf: model.range.fromMs)
        let id = try store.startSession(.init(kind: "flow", plannedSec: 900, startedMs: nine + 900_000, state: "running", cycleIndex: 1))
        try store.endSession(id: id, at: nine + 1_800_000, state: .done)
        _ = try store.openSegment(.init(startedMs: nine, endedMs: nine + 3_000_000, sessionId: id,
                                        appBundle: "test.editor", appName: "Fixture editor"))
        model.sessionFilter = id
        model.reload(now: Date(timeIntervalSince1970: Double(nine + 3_600_000) / 1000))
        XCTAssertEqual(model.totals.focusedMs, 900_000)
        XCTAssertEqual(model.bars.first?.startedMs, nine + 900_000)
        XCTAssertEqual(model.bars.last?.endedMs, nine + 1_800_000)
    }

    func testSessionCardsUseABoundedNumberOfLedgerQueries() throws {
        let base = model.range.fromMs + 2 * 3_600_000
        for index in 0 ..< 30 {
            let start = base + Int64(index) * 600_000
            let id = try store.startSession(.init(kind: "flow", plannedSec: 600, startedMs: start, state: "running", cycleIndex: 1))
            try store.endSession(id: id, at: start + 600_000, state: .done)
            for part in 0 ..< 3 {
                let began = start + Int64(part) * 120_000
                let segment = try store.openSegment(.init(startedMs: began, endedMs: began + 60_000, sessionId: id,
                                                          appBundle: "test.editor", appName: "Fixture editor"))
                try store.appendInput(bucketMs: began, segmentId: segment, counts: .init(keys: part + 1))
            }
        }
        let now = Date(timeIntervalSince1970: Double(base + 30 * 600_000) / 1000)
        let before = store.preparedStatementCount
        model.reload(now: now)
        let queries = store.preparedStatementCount - before
        print("STUDIO_QUERY_COUNT sessions=30 segments=90 prepared=\(queries)")
        XCTAssertLessThanOrEqual(queries, 6)
        XCTAssertEqual(model.sessionCards.count, 30)
        XCTAssertEqual(model.sessionOptions.count, 30)
        XCTAssertTrue(model.sessionCards.allSatisfy { $0.keys == 6 })
        if ProcessInfo.processInfo.environment["FLOW_STUDIO_BENCH"] == "1" {
            measure(metrics: [XCTCPUMetric()]) { model.reload(now: now) }
        }
    }

    func testSessionPickerKeepsWholePhaseDataWhenAnotherSessionIsSelected() throws {
        let base = model.range.fromMs
        var ids: [Int64] = []
        for offset: Int64 in [0, 3_600_000] {
            let start = base + offset
            let id = try store.startSession(.init(kind: "flow", plannedSec: 180,
                                                  startedMs: start, state: "running", cycleIndex: 1))
            ids.append(id)
            try store.endSession(id: id, at: start + 180_000, state: .done)
            let segment = try store.openSegment(.init(startedMs: start, endedMs: start + 180_000,
                                                      sessionId: id, appBundle: "test.editor", appName: "Fixture editor"))
            try store.appendInput(bucketMs: start, segmentId: segment, counts: .init(keys: 2))
            try store.appendInput(bucketMs: start + 180_000, segmentId: segment, counts: .init(keys: 100))
        }
        model.sessionFilter = ids[1]
        model.reload(now: Date(timeIntervalSince1970: Double(base + 7_200_000) / 1000))
        XCTAssertEqual(model.sessionCards.map(\.id), [ids[1]])
        XCTAssertEqual(model.sessionOptions.count, 2)
        XCTAssertTrue(model.sessionOptions.allSatisfy { $0.topApps.first?.ms == 180_000 })
        XCTAssertTrue(model.sessionOptions.allSatisfy { $0.keys == 2 }, "input at the exclusive phase end is not counted")
        XCTAssertEqual(model.keys, 2)
        XCTAssertEqual(model.availableProjects, [])
    }

    func testClockFormattingMatchesTheOriginalHourMinuteContract() {
        let reference = DateFormatter()
        reference.dateFormat = "HH:mm"
        for hour in 0 ..< 48 {
            let ms = model.range.fromMs + Int64(hour) * 3_600_000 + 1_020_000
            XCTAssertEqual(FocusFormat.clockTime(ms), reference.string(from: Date(timeIntervalSince1970: Double(ms) / 1000)))
        }
    }

    func testAnEmptyDayWithCaptureOnReadsAsNothingRecorded() {
        model.reload()
        XCTAssertEqual(model.emptiness, .nothingRecorded)
    }

    func testAnEmptyDayWithCaptureOffReadsAsNotMeasured() throws {
        // The distinction the empty state exists for: "you did nothing" versus "I recorded
        // nothing". A gap covering the elapsed range is the second one.
        let start = FocusRange.make(.day).fromMs
        try store.recordGap(startedMs: start, endedMs: nil, reason: "capture_paused")
        model.reload()
        XCTAssertEqual(model.emptiness, .captureWasOff)
        XCTAssertGreaterThan(model.unmeasuredMs, 0)
    }

    func testDowntimeBecomesAVisibleGapRatherThanASilentHole() throws {
        // The app was closed for an hour. That hour is not idle time and not an empty day: it
        // is unmeasured, and the timeline has to be able to draw it.
        let dayStart = FocusRange.make(.day).fromMs
        let earlier = localMs(hour: 9, onDayOf: dayStart)
        let id = try store.openSegment(.init(startedMs: earlier, appBundle: "dev.cursor", appName: "Cursor"))
        try store.closeSegment(id: id, at: earlier + 10 * 60_000)

        let recorder = ActivityRecorder(store: store)
        recorder.closeDowntime(launchedAt: Date(timeIntervalSince1970: Double(earlier + 70 * 60_000) / 1000))

        model.reload()
        XCTAssertEqual(model.gapBars.count, 1)
        XCTAssertEqual(model.gapBars.first?.reason, "app_not_running")
        XCTAssertEqual(model.gapBars.first?.label, "app closed")
        XCTAssertEqual(model.gapBars.first?.startedMs, earlier + 10 * 60_000,
                       "the gap starts where the record stopped")
        XCTAssertGreaterThan(model.unmeasuredMs, 55 * 60_000)
    }

    func testTheTagFilterScopesEveryViewAndNotJustTheSessionsList() throws {
        // Martin, 2026-09-21: "tag filter doesnt seem to filter anything at all." It filtered
        // the session cards only, so the timeline, breakdown and heatmap ignored it entirely.
        let dayStart = FocusRange.make(.day).fromMs
        let nine = localMs(hour: 9, onDayOf: dayStart)
        let eleven = localMs(hour: 11, onDayOf: dayStart)

        let tagged = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                  plannedSec: 1500, startedMs: nine,
                                                  state: ActivityStore.SessionState.done.rawValue,
                                                  cycleIndex: 0, tag: "spec22"))
        try store.endSession(id: tagged, at: nine + 25 * 60_000, state: .done)
        let other = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                 plannedSec: 1500, startedMs: eleven,
                                                 state: ActivityStore.SessionState.done.rawValue,
                                                 cycleIndex: 1, tag: "email"))
        try store.endSession(id: other, at: eleven + 25 * 60_000, state: .done)

        for (start, session, app) in [(nine, tagged, "Cursor"), (eleven, other, "Mail")] {
            var row = ActivityStore.Segment(startedMs: start, appBundle: "bundle.\(app)", appName: app)
            row.sessionId = session
            let id = try store.openSegment(row)
            try store.closeSegment(id: id, at: start + 20 * 60_000)
        }

        model.tagFilter = "spec22"
        model.reload()

        XCTAssertEqual(model.appBuckets.map(\.key), ["Cursor"], "the other tag's work is out of scope")
        XCTAssertEqual(model.totals.focusedMs, 20 * 60_000)
        XCTAssertEqual(model.phaseBands.map(\.sessionId), [tagged])
        XCTAssertEqual(model.sessionCards.map(\.id), [tagged])
        XCTAssertEqual(model.availableTags, ["email", "spec22"],
                       "the menu still offers every tag in the range, or it would empty itself")

        model.tagFilter = nil
        model.reload()
        XCTAssertEqual(model.appBuckets.map(\.key).sorted(), ["Cursor", "Mail"])
    }

    func testKeystrokesFollowTheTagFilterToo() throws {
        // The footer kept printing the whole day's keystrokes while every other number was
        // scoped, because input buckets are keyed by time rather than by session.
        let dayStart = FocusRange.make(.day).fromMs
        let nine = localMs(hour: 9, onDayOf: dayStart)
        let eleven = localMs(hour: 11, onDayOf: dayStart)

        let tagged = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                  plannedSec: 1500, startedMs: nine,
                                                  state: ActivityStore.SessionState.done.rawValue,
                                                  cycleIndex: 0, tag: "spec22"))
        try store.endSession(id: tagged, at: nine + 25 * 60_000, state: .done)

        var row = ActivityStore.Segment(startedMs: nine, appBundle: "dev.cursor", appName: "Cursor")
        row.sessionId = tagged
        let inside = try store.openSegment(row)
        try store.closeSegment(id: inside, at: nine + 20 * 60_000)
        let outside = try store.openSegment(.init(startedMs: eleven, appBundle: "com.apple.mail", appName: "Mail"))
        try store.closeSegment(id: outside, at: eleven + 20 * 60_000)

        try store.appendInput(bucketMs: nine + 60_000, segmentId: inside,
                              counts: ActivityStore.InputCounts(keys: 400))
        try store.appendInput(bucketMs: eleven + 60_000, segmentId: outside,
                              counts: ActivityStore.InputCounts(keys: 900))

        model.reload()
        XCTAssertEqual(model.keys, 1300, "unfiltered, the day counts both")

        model.tagFilter = "spec22"
        model.reload()
        XCTAssertEqual(model.keys, 400, "filtered, only the tagged session's typing counts")
    }

    func testUntaggedWorkIsExcludedWhileATagIsChosen() throws {
        let dayStart = FocusRange.make(.day).fromMs
        let nine = localMs(hour: 9, onDayOf: dayStart)
        let session = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                   plannedSec: 1500, startedMs: nine,
                                                   state: ActivityStore.SessionState.done.rawValue,
                                                   cycleIndex: 0, tag: "spec22"))
        try store.endSession(id: session, at: nine + 25 * 60_000, state: .done)

        var inside = ActivityStore.Segment(startedMs: nine, appBundle: "dev.cursor", appName: "Cursor")
        inside.sessionId = session
        let insideId = try store.openSegment(inside)
        try store.closeSegment(id: insideId, at: nine + 10 * 60_000)

        // Work outside any pomodoro: it carries no tag, so a tag filter cannot include it.
        let loose = try store.openSegment(.init(startedMs: nine + 40 * 60_000,
                                                appBundle: "com.apple.Safari", appName: "Safari"))
        try store.closeSegment(id: loose, at: nine + 50 * 60_000)

        model.tagFilter = "spec22"
        model.reload()
        XCTAssertEqual(model.appBuckets.map(\.key), ["Cursor"])
        XCTAssertEqual(model.totals.focusedMs, 10 * 60_000)
    }

    func testEveryLaneIsDrawnFromItsOwnStartSoAnHourFillsTheWidth() throws {
        // Martin, 2026-09-21: "new hours should start at the left not waterfall. the whole hour
        // is the whole width." A lane's x axis is the offset inside that lane, never the
        // position of the clock in the day.
        let dayStart = FocusRange.make(.day).fromMs
        let nineTwenty = localMs(hour: 9, onDayOf: dayStart) + 20 * 60_000
        let id = try store.openSegment(.init(startedMs: nineTwenty, appBundle: "dev.cursor", appName: "Cursor"))
        try store.closeSegment(id: id, at: nineTwenty + 10 * 60_000)

        model.reload()
        let bar = try XCTUnwrap(model.bars.first)
        XCTAssertEqual(bar.laneKey, "09:00")
        XCTAssertEqual(bar.offsetStartMs, 20 * 60_000, "20 minutes into its own lane")
        XCTAssertEqual(bar.offsetEndMs, 30 * 60_000)
        XCTAssertEqual(model.laneSpanMinutes, 60, "a day view draws one hour per lane")
    }

    func testTheRepeatedHourWhenClocksGoBackGetsItsOwnLane() throws {
        let previous = NSTimeZone.default
        let prague = try XCTUnwrap(TimeZone(identifier: "Europe/Prague"))
        NSTimeZone.default = prague
        defer { NSTimeZone.default = previous }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = prague
        // 2026-10-25 00:30Z is 02:30 CEST; 01:30Z is 02:30 CET, the same wall-clock hour again.
        let start: Int64 = 1_792_888_200_000
        let hour: Int64 = 3_600_000
        let id = try store.openSegment(.init(startedMs: start, appBundle: "dev.cursor", appName: "Cursor"))
        try store.closeSegment(id: id, at: start + hour)
        model.range = FocusRange.make(.day, containing: Date(timeIntervalSince1970: Double(start) / 1000),
                                      calendar: calendar)

        model.reload()
        XCTAssertEqual(model.lanes.count, 2)
        XCTAssertEqual(model.lanes.first, "02:00")
        XCTAssertTrue(model.lanes.last?.hasPrefix("02:00 ") == true, "\(model.lanes)")
        XCTAssertEqual(model.bars.reduce(0) { $0 + $1.offsetEndMs - $1.offsetStartMs }, hour)
    }

    func testASegmentThatCrossesAnHourIsDrawnInBothLanes() throws {
        let dayStart = FocusRange.make(.day).fromMs
        let nineFifty = localMs(hour: 9, onDayOf: dayStart) + 50 * 60_000
        let id = try store.openSegment(.init(startedMs: nineFifty, appBundle: "dev.cursor", appName: "Cursor"))
        try store.closeSegment(id: id, at: nineFifty + 25 * 60_000) // 09:50 → 10:15

        model.reload()
        let byLane = Dictionary(uniqueKeysWithValues: model.bars.map { ($0.laneKey, $0) })
        XCTAssertEqual(model.lanes, ["09:00", "10:00"])
        XCTAssertEqual(byLane["09:00"]?.offsetStartMs, 50 * 60_000)
        XCTAssertEqual(byLane["09:00"]?.offsetEndMs, 60 * 60_000, "clipped at the top of the hour")
        XCTAssertEqual(byLane["10:00"]?.offsetStartMs, 0, "and starts again at the left of the next lane")
        XCTAssertEqual(byLane["10:00"]?.offsetEndMs, 15 * 60_000)
    }

    func testAPhaseBandIsDrawnOnlyInTheLanesItCrosses() throws {
        // Observed live on 2026-09-21: every band was drawn in every lane, so a flow that ran at
        // 20:30 painted the 18:00 row too and the day read as one continuous pomodoro.
        let dayStart = FocusRange.make(.day).fromMs
        let nine = localMs(hour: 9, onDayOf: dayStart)
        let twenty = localMs(hour: 20, onDayOf: dayStart)

        // Work in two different hours, so the timeline has two lanes.
        for start in [nine, twenty] {
            let id = try store.openSegment(.init(startedMs: start, appBundle: "dev.cursor", appName: "Cursor"))
            try store.closeSegment(id: id, at: start + 20 * 60_000)
        }
        // One flow, entirely inside the 20:00 hour.
        let session = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                   plannedSec: 1500, startedMs: twenty,
                                                   state: ActivityStore.SessionState.running.rawValue,
                                                   cycleIndex: 0))
        try store.endSession(id: session, at: twenty + 25 * 60_000, state: .done)

        model.reload()
        XCTAssertEqual(model.lanes, ["09:00", "20:00"])
        XCTAssertEqual(model.phaseBands.map(\.laneKey), ["20:00"],
                       "a 20:00 flow has no business painting the 09:00 lane")
    }

    func testABandThatCrossesAnHourIsCutAtTheBoundary() throws {
        let dayStart = FocusRange.make(.day).fromMs
        let nine = localMs(hour: 9, onDayOf: dayStart)
        // Work in both hours the flow crosses, so both lanes exist.
        for start in [nine + 50 * 60_000, nine + 70 * 60_000] {
            let id = try store.openSegment(.init(startedMs: start, appBundle: "dev.cursor", appName: "Cursor"))
            try store.closeSegment(id: id, at: start + 5 * 60_000)
        }
        let session = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                                   plannedSec: 1500, startedMs: nine + 50 * 60_000,
                                                   state: ActivityStore.SessionState.running.rawValue,
                                                   cycleIndex: 0))
        try store.endSession(id: session, at: nine + 75 * 60_000, state: .done)

        model.reload()
        let bands = model.phaseBands.sorted { $0.laneKey < $1.laneKey }
        XCTAssertEqual(bands.map(\.laneKey), ["09:00", "10:00"])
        XCTAssertEqual(bands[0].endedMs, nine + 3_600_000, "clipped at the top of the hour")
        XCTAssertEqual(bands[1].startedMs, nine + 3_600_000, "and picked up again in the next lane")
        XCTAssertEqual(Set(bands.map(\.sessionId)).count, 1, "still one session, drawn twice")
    }

    func testAShortRestartIsNotDrawnAsAGap() throws {
        let dayStart = FocusRange.make(.day).fromMs
        let earlier = localMs(hour: 9, onDayOf: dayStart)
        let id = try store.openSegment(.init(startedMs: earlier, appBundle: "dev.cursor", appName: "Cursor"))
        try store.closeSegment(id: id, at: earlier + 60_000)

        let recorder = ActivityRecorder(store: store)
        recorder.closeDowntime(launchedAt: Date(timeIntervalSince1970: Double(earlier + 75_000) / 1000))

        model.reload()
        XCTAssertTrue(model.gapBars.isEmpty, "a fifteen-second relaunch is noise, not a gap")
    }

    func testAnUncleanExitLeavesNoSegmentRunningForever() throws {
        // No end at all: the process died before the first heartbeat. It must be finished where
        // it started rather than counted up to now.
        // An hour ago, not a fixed hour of today: at 00:02, "08:00 today" is still in the future,
        // and the query up to now below could never find it (failed 2026-09-24 00:01).
        let startedMs = Int64(Date().timeIntervalSince1970 * 1000) - 3_600_000
        let orphan = try store.openSegment(.init(startedMs: startedMs,
                                                 appBundle: "dev.cursor", appName: "Cursor"))
        let recorder = ActivityRecorder(store: store)
        recorder.closeDowntime()

        let rows = try store.segments(from: 0, to: Int64(Date().timeIntervalSince1970 * 1000) + 1)
        let row = try XCTUnwrap(rows.first { $0.id == orphan })
        XCTAssertNotNil(row.endedMs, "an orphaned segment is closed at launch")
        XCTAssertEqual(row.durationMs, 0)
    }

    func testAnExpiredCapturePauseClosesItsGap() throws {
        // A pause that simply runs out must close the gap it opened; an open gap keeps reading
        // as "not measured" up to now while capture is in fact running again.
        let recorder = ActivityRecorder(store: store)
        let until = Date().addingTimeInterval(60)
        recorder.pauseCapture(until: until)
        let nowMs = Int64(Date().timeIntervalSince1970 * 1000)
        let opened = try store.gaps(from: 0, to: nowMs + 1)
        XCTAssertEqual(opened.count, 1, "the pause opens a gap")
        XCTAssertNil(opened.first?.endedMs)

        XCTAssertFalse(recorder.resumeIfPauseExpired(now: until.addingTimeInterval(-1)), "still paused")
        XCTAssertTrue(recorder.resumeIfPauseExpired(now: until.addingTimeInterval(1)))

        let gaps = try store.gaps(from: 0, to: nowMs + 120_000)
        XCTAssertEqual(gaps.count, 1)
        XCTAssertEqual(gaps.first?.reason, "capture_paused")
        XCTAssertNotNil(gaps.first?.endedMs, "the gap is closed when the pause expires")
        XCTAssertNil(recorder.pausedUntil)
    }

    func testACapturePauseOutlivesTheRecorderThatTookIt() throws {
        // The elected owner exits a minute after "Pause capture for 1 hour"; its successor builds a new recorder.
        let first = ActivityRecorder(store: store, liveServices: false)
        let until = Date().addingTimeInterval(3_600)
        first.pauseCapture(until: until)
        first.pauseCapture(until: until.addingTimeInterval(600))
        first.stop()

        let replacement = ActivityRecorder(store: store, liveServices: false)
        replacement.closeDowntime()
        let restored = try XCTUnwrap(replacement.pausedUntil, "an owner change is not consent to resume")
        XCTAssertEqual(restored.timeIntervalSince1970, until.addingTimeInterval(600).timeIntervalSince1970, accuracy: 0.001,
                       "a pause extended in place keeps its latest deadline")
        let open = try store.gaps(from: 0, to: nowMs() + 1).filter { $0.endedMs == nil }
        XCTAssertEqual(open.map(\.reason), ["capture_paused"], "one gap, still open")
        XCTAssertFalse(replacement.resumeIfPauseExpired(now: Date()))
        XCTAssertTrue(replacement.resumeIfPauseExpired(now: restored.addingTimeInterval(1)))
        XCTAssertTrue(try store.gaps(from: 0, to: nowMs() + 1).allSatisfy { $0.endedMs != nil },
                      "the restored pause closes its own gap when it runs out")
    }

    func testAPersistedPauseThatRanOutWhileNobodyWatchedEndsAtItsDeadline() throws {
        let launch: Int64 = 1_800_000_000_000
        _ = try store.recordGap(startedMs: launch - 600_000, endedMs: nil, reason: "capture_paused", untilMs: launch - 300_000)
        let recorder = ActivityRecorder(store: store, liveServices: false)
        recorder.closeDowntime(launchedAt: Date(timeIntervalSince1970: Double(launch) / 1000))
        XCTAssertNil(recorder.pausedUntil)
        XCTAssertEqual(try store.gaps(from: 0, to: launch + 1).first { $0.reason == "capture_paused" }?.endedMs,
                       launch - 300_000)
    }

    func testRelaunchClosesPersistedOpenGapsEvenWithoutAnyActivityRows() throws {
        let launch: Int64 = 1_800_000_000_000
        _ = try store.recordGap(startedMs: launch - 120_000, endedMs: nil, reason: "capture_off")
        let recorder = ActivityRecorder(store: store)
        recorder.closeDowntime(launchedAt: Date(timeIntervalSince1970: Double(launch) / 1000))
        XCTAssertEqual(try store.gaps(from: 0, to: launch + 1).first?.endedMs, launch)
        XCTAssertTrue(try store.gaps(from: launch, to: launch + 60_000).isEmpty)
    }

    func testASleepLongerThanTheTickBudgetEndsTheSegmentWhereTheLastTickSawIt() throws {
        let recorder = ActivityRecorder(store: store)
        recorder.applyProbe(.init(title: "Fixture", url: nil, displayId: nil),
                            bundle: "dev.cursor", appName: "Cursor", settings: FocusSettings(), idle: false)
        let lastTick = nowMs()
        recorder.noteTick(at: lastTick)
        recorder.noteTick(at: lastTick + 2_000)
        let wake = lastTick + 2_000 + 8 * 3_600_000
        recorder.noteTick(at: wake)
        let row = try XCTUnwrap(try store.segments(from: 0, to: wake + 1).last)
        XCTAssertEqual(row.endedMs, lastTick + 2_000, "the night is not counted as work")
        let gap = try XCTUnwrap(try store.gaps(from: 0, to: wake + 1).first { $0.reason == "system_sleep" })
        XCTAssertEqual(gap.startedMs, lastTick + 2_000)
        XCTAssertEqual(gap.endedMs, wake)
    }

    func testResumingAPauseDoesNotCloseTheCaptureOffGap() throws {
        let recorder = ActivityRecorder(store: store, liveServices: false)
        recorder.start()
        recorder.stop()
        recorder.pauseCapture(until: Date().addingTimeInterval(600))
        recorder.resumeCapture()
        let gaps = try store.gaps(from: 0, to: nowMs() + 1)
        XCTAssertEqual(gaps.map(\.reason), ["capture_off"])
        XCTAssertNil(gaps.first?.endedMs, "capture is still off, so its gap stays open")
    }

    func testKeysTypedBeforeAMidMinuteSwitchStayWithTheFirstApp() throws {
        let recorder = ActivityRecorder(store: store)
        recorder.applyProbe(.init(title: "Editor fixture", url: nil, displayId: nil),
                            bundle: "test.editor", appName: "Editor", settings: FocusSettings(), idle: false)
        for _ in 0..<3 { recorder.recordKeyForTesting() }
        recorder.applyProbe(.init(title: "Browser fixture", url: nil, displayId: nil),
                            bundle: "test.browser", appName: "Browser", settings: FocusSettings(), idle: false)
        recorder.recordKeyForTesting()
        recorder.attach(sessionId: nil)
        let rows = try store.segments(from: 0, to: nowMs() + 1)
        let editor = try XCTUnwrap(rows.first { $0.appBundle == "test.editor" })
        let browser = try XCTUnwrap(rows.first { $0.appBundle == "test.browser" })
        let series = try store.inputSeries(from: 0, to: nowMs() + 60_000)
        XCTAssertEqual(series.filter { $0.segmentId == editor.id }.map(\.counts.keys).reduce(0, +), 3)
        XCTAssertEqual(series.filter { $0.segmentId == browser.id }.map(\.counts.keys).reduce(0, +), 1)
    }

    func testTitlePrivacyAlsoCoversCmuxSessionAndPane() throws {
        for mode in [FocusSettings.TitleMode.full, .hashed, .appOnly] {
            var settings = FocusSettings()
            settings.titleMode = mode
            settings.projects = [.init(name: "Fixture project", cmuxSession: "fixture-project", titleContains: nil, host: nil)]
            let recorder = ActivityRecorder(store: store, settings: settings)
            recorder.applyProbe(.init(title: "fixture-project · fixture-pane", url: nil, displayId: nil),
                                bundle: "com.cmuxterm.app", appName: "Terminal fixture", settings: settings, idle: false)
            let row = try XCTUnwrap(try store.segments(from: 0, to: nowMs() + 1).last)
            XCTAssertEqual(row.project, "Fixture project", "explicit project rules match transient raw metadata in every privacy mode")
            recorder.attach(sessionId: nil)
            XCTAssertEqual(try store.segments(from: 0, to: nowMs() + 1).last?.project, "Fixture project", "phase splits preserve resolved attribution")
            if mode == .full {
                XCTAssertEqual(row.cmuxSession, "fixture-project")
                XCTAssertEqual(row.cmuxPane, "fixture-pane")
            } else if mode == .hashed {
                XCTAssertTrue(row.cmuxSession?.hasPrefix("sha256:") ?? false)
                XCTAssertTrue(row.cmuxPane?.hasPrefix("sha256:") ?? false)
            } else {
                XCTAssertNil(row.cmuxSession)
                XCTAssertNil(row.cmuxPane)
            }
            if mode != .full {
                XCTAssertFalse(row.windowTitle?.contains("fixture-project") ?? false)
                XCTAssertFalse(row.cmuxSession?.contains("fixture-project") ?? false)
                XCTAssertFalse(row.cmuxPane?.contains("fixture-pane") ?? false)
            }
        }
    }

    func testExcludedAppsAndHostsLeaveGapsWithoutPersistingTheirTitles() throws {
        var settings = FocusSettings()
        settings.excludedBundles.insert("test.private-app")
        settings.excludedHosts = ["example.test"]
        let recorder = ActivityRecorder(store: store, settings: settings)
        recorder.applyProbe(.init(title: "Visible fixture", url: nil, displayId: nil),
                            bundle: "test.editor", appName: "Editor", settings: settings, idle: false)
        recorder.applyProbe(.init(title: "Private app fixture", url: nil, displayId: nil),
                            bundle: "test.private-app", appName: "Private app", settings: settings, idle: false)
        XCTAssertNil(recorder.current)
        XCTAssertFalse(try store.gaps(from: 0, to: nowMs() + 1).isEmpty)
        recorder.applyProbe(.init(title: "Private mail fixture", url: "https://mail.example.test/inbox", displayId: nil),
                            bundle: "com.apple.Safari", appName: "Browser", settings: settings, idle: false)
        XCTAssertNil(recorder.current)
        recorder.applyProbe(.init(title: "Visible again", url: nil, displayId: nil),
                            bundle: "test.editor", appName: "Editor", settings: settings, idle: false)
        let rows = try store.segments(from: 0, to: nowMs() + 1)
        XCTAssertFalse(rows.contains { $0.windowTitle?.contains("Private") ?? false })
        XCTAssertTrue(try store.gaps(from: 0, to: nowMs() + 1).allSatisfy { $0.endedMs != nil })
    }

    func testDelayedProbeCannotReopenCaptureAfterPauseStopOrPrivacyChange() async throws {
        for action in ["pause", "stop", "settings"] {
            let entered = expectation(description: "fixture probe entered for \(action)")
            let release = DispatchSemaphore(value: 0)
            let recorder = ActivityRecorder(store: store, liveServices: false, probeReader: { _, _ in
                entered.fulfill()
                guard release.wait(timeout: .now() + 2) == .success else {
                    XCTFail("fixture probe release timed out")
                    return AXFocusProbe.Result()
                }
                return AXFocusProbe.Result(title: "Delayed private fixture", url: nil, displayId: nil)
            })
            recorder.start()
            let pending = try XCTUnwrap(recorder.requestProbe(pid: 42, bundle: "test.editor", appName: "Editor", idle: false))
            await fulfillment(of: [entered], timeout: 1)
            if action == "pause" { recorder.pauseCapture(until: Date().addingTimeInterval(60)) }
            else if action == "stop" { recorder.stop() }
            else {
                var settings = FocusSettings()
                settings.titleMode = .hashed
                recorder.apply(settings: settings)
            }
            release.signal()
            await pending.value
            XCTAssertTrue(try store.segments(from: 0, to: nowMs() + 1).isEmpty, action)
            XCTAssertNil(recorder.current, action)
            recorder.stop()
        }
        let active = ActivityRecorder(store: store, liveServices: false, probeReader: { _, _ in
            AXFocusProbe.Result(title: "Current fixture", url: nil, displayId: nil)
        })
        active.start()
        let accepted = try XCTUnwrap(active.requestProbe(pid: 42, bundle: "test.editor", appName: "Editor", idle: false))
        await accepted.value
        XCTAssertEqual(try store.segments(from: 0, to: nowMs() + 1).first?.windowTitle, "Current fixture")
        active.stop()
    }

    func testHostExclusionsCoverSubdomainsAndCaseWithoutSuffixLookalikes() {
        var settings = FocusSettings()
        settings.excludedHosts = ["Example.TEST."]
        XCTAssertFalse(settings.records(host: "example.test"))
        XCTAssertFalse(settings.records(host: "mail.example.test"))
        XCTAssertFalse(settings.records(host: "MAIL.EXAMPLE.TEST."))
        XCTAssertTrue(settings.records(host: "notexample.test"))
        XCTAssertTrue(settings.records(host: "example.test.other.test"))
    }

    func testCaptureResumedInTheSameWindowOpensANewSegment() throws {
        // PR #82 review: the pause closed the segment but kept the snapshot, so the first probe
        // after it looked like "same segment" and nothing was recorded until a window switch.
        let recorder = ActivityRecorder(store: store)
        let probe = AXFocusProbe.Result(title: "main.swift", url: nil, displayId: nil)
        func sameWindow() {
            recorder.applyProbe(probe, bundle: "dev.cursor", appName: "Cursor", settings: FocusSettings(), idle: false)
        }
        sameWindow()
        let until = Date().addingTimeInterval(60)
        recorder.pauseCapture(until: until)
        XCTAssertTrue(recorder.resumeIfPauseExpired(now: until.addingTimeInterval(1)))
        sameWindow()

        let rows = try store.segments(from: 0, to: Int64(Date().timeIntervalSince1970 * 1000) + 1)
        XCTAssertEqual(rows.count, 2, "one segment before the pause, one after it")
        XCTAssertNotNil(rows.first?.endedMs, "the pause closed the first")
        XCTAssertNil(rows.last?.endedMs, "the one after the pause is open")
    }

    func testHeartbeatKeepsAnOpenSegmentHonest() throws {
        let start = Int64(Date().timeIntervalSince1970 * 1000) - 10_000
        let id = try store.openSegment(.init(startedMs: start, appBundle: "dev.cursor", appName: "Cursor"))
        try store.touchSegment(id: id, at: start + 4_000)

        let last = try XCTUnwrap(try store.lastRecordedMs())
        XCTAssertEqual(last, start + 4_000, "the record stops where the last heartbeat landed")
    }

    func testAppBucketsCarryTheBundleSoRowsCanDrawAnIcon() throws {
        let start = localMs(hour: 9, onDayOf: FocusRange.make(.day).fromMs)
        let id = try store.openSegment(.init(startedMs: start, appBundle: "com.brave.Browser", appName: "Brave"))
        try store.closeSegment(id: id, at: start + 60_000)
        model.reload()
        XCTAssertEqual(model.appBuckets.first?.bundleId, "com.brave.Browser")
        XCTAssertEqual(model.bars.first?.appBundle, "com.brave.Browser")
    }

    func testReloadPopulatesEveryViewFromOneQuery() throws {
        let start = localMs(hour: 9, onDayOf: FocusRange.make(.day).fromMs)
        var segment = ActivityStore.Segment(startedMs: start, appBundle: "dev.cursor", appName: "Cursor")
        segment.project = "genesis"
        let id = try store.openSegment(segment)
        try store.closeSegment(id: id, at: start + 20 * 60_000)
        _ = try store.startSession(.init(kind: "flow", plannedSec: 1_500, startedMs: start,
                                         endedMs: start + 25 * 60_000, state: "done",
                                         cycleIndex: 0, tag: "genesis", note: "landed"))
        model.reload()

        XCTAssertEqual(model.emptiness, .notEmpty)
        XCTAssertEqual(model.totals.focusedMs, 20 * 60_000)
        XCTAssertEqual(model.appBuckets.first?.key, "Cursor")
        XCTAssertEqual(model.projectBuckets.first?.key, "genesis")
        XCTAssertEqual(model.bars.count, 1)
        XCTAssertEqual(model.sessionCards.count, 1)
        XCTAssertEqual(model.sessionCards.first?.tag, "genesis")
        XCTAssertEqual(model.availableTags, ["genesis"])
    }

    func testDigestMarkdownCarriesTheSameNumbersTheFooterShows() throws {
        let start = localMs(hour: 9, onDayOf: FocusRange.make(.day).fromMs)
        let id = try store.openSegment(.init(startedMs: start, appBundle: "dev.cursor", appName: "Cursor"))
        try store.closeSegment(id: id, at: start + 30 * 60_000)
        model.reload()

        let markdown = model.digestMarkdown()
        XCTAssertTrue(markdown.contains(FocusFormat.duration(model.totals.focusedMs)))
        XCTAssertTrue(markdown.contains("Cursor"))
        XCTAssertTrue(markdown.contains("\(model.totals.switches) context switches"))
    }

    func testProjectFilterExcludesEverythingElse() throws {
        let start = localMs(hour: 9, onDayOf: FocusRange.make(.day).fromMs)
        var genesis = ActivityStore.Segment(startedMs: start, appBundle: "dev.cursor", appName: "Cursor")
        genesis.project = "genesis"
        let a = try store.openSegment(genesis)
        try store.closeSegment(id: a, at: start + 10 * 60_000)
        var other = ActivityStore.Segment(startedMs: start + 10 * 60_000, appBundle: "com.brave.Browser", appName: "Brave")
        other.project = "Other project"
        let b = try store.openSegment(other)
        try store.closeSegment(id: b, at: start + 20 * 60_000)

        model.projectFilter = "genesis"
        model.reload()
        XCTAssertEqual(model.appBuckets.map(\.key), ["Cursor"])
        XCTAssertEqual(model.totals.focusedMs, 10 * 60_000)
    }
}
