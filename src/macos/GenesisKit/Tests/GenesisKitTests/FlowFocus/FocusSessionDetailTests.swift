// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/FocusSessionDetailTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// Spec 22 (S6) §10.7 — the per-session breakdown.
///
/// The window is the one surface that claims to show EVERYTHING inside a pomodoro, so these
/// pin the two ways that claim can be false: an event that is dropped, and a span that is
/// counted outside the session it is drawn in.
@MainActor
final class FocusSessionDetailTests: XCTestCase {
    private var path: String!
    private var store: ActivityStore!
    private let base: Int64 = 1_700_000_000_000
    private let minute: Int64 = 60_000

    override func setUpWithError() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-session-detail-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        path = dir.appendingPathComponent("activity.db").path
        store = try ActivityStore(path: path)
    }

    override func tearDownWithError() throws {
        store = nil
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.removeItem(atPath: dir)
    }

    @discardableResult
    private func segment(_ startMin: Int64, _ durationMin: Int64, app: String,
                         host: String? = nil, idle: Bool = false,
                         session: Int64? = nil) throws -> Int64 {
        var row = ActivityStore.Segment(startedMs: base + startMin * minute,
                                        appBundle: "bundle.\(app)", appName: app)
        row.endedMs = base + (startMin + durationMin) * minute
        row.urlHost = host
        row.idle = idle
        row.sessionId = session
        let id = try store.openSegment(row)
        try store.closeSegment(id: id, at: row.endedMs!)
        return id
    }

    /// A 25-minute flow with Cursor, a browser detour, a pause, an idle tail and a capture gap.
    private func fixture() throws -> Int64 {
        let sessionId = try store.startSession(ActivityStore.FocusSession(
            kind: ActivityStore.SessionKind.flow.rawValue, plannedSec: 25 * 60,
            startedMs: base, state: ActivityStore.SessionState.running.rawValue,
            cycleIndex: 0, tag: "spec22", note: "wire the detail window"))
        try store.endSession(id: sessionId, at: base + 25 * minute,
                             state: ActivityStore.SessionState.done)

        let cursor = try segment(0, 10, app: "Cursor", session: sessionId)
        try segment(10, 5, app: "Brave", host: "github.com", session: sessionId)
        try segment(15, 5, app: "Cursor", session: sessionId)
        try segment(20, 5, app: "Cursor", idle: true, session: sessionId)
        // One minute of typing, in the first segment.
        try store.appendInput(bucketMs: base + 2 * minute, segmentId: cursor,
                              counts: ActivityStore.InputCounts(keys: 320, clicks: 12))
        _ = try store.recordPause(sessionId: sessionId, startedMs: base + 12 * minute,
                                  endedMs: base + 13 * minute, reason: .manual)
        _ = try store.recordGap(startedMs: base + 22 * minute, endedMs: base + 23 * minute,
                                reason: "capture_paused")
        return sessionId
    }

    // MARK: - Store queries

    func testSessionByIdReadsBackEverythingTheCardShows() throws {
        let id = try fixture()
        let session = try XCTUnwrap(try store.session(id: id))
        XCTAssertEqual(session.tag, "spec22")
        XCTAssertEqual(session.plannedSec, 25 * 60)
        XCTAssertEqual(session.state, ActivityStore.SessionState.done.rawValue)
        XCTAssertNil(try store.session(id: id + 999), "an unknown id is nil, never a fake row")
    }

    func testInputSeriesKeepsTheBucketsRatherThanTheirSum() throws {
        let id = try fixture()
        _ = id
        let series = try store.inputSeries(from: base, to: base + 25 * minute)
        XCTAssertEqual(series.count, 1)
        XCTAssertEqual(series.first?.counts.keys, 320)
        XCTAssertEqual(series.first?.bucketMs, base + 2 * minute)
    }

    func testPausesReadBackWithTheirReason() throws {
        let id = try fixture()
        let pauses = try store.pauses(sessionId: id)
        XCTAssertEqual(pauses.count, 1)
        XCTAssertEqual(pauses.first?.reason, "manual")
        XCTAssertEqual(pauses.first?.endedMs, base + 13 * minute)
    }

    // MARK: - The model

    func testEveryKindOfEventAppearsExactlyOnceAndInOrder() throws {
        let id = try fixture()
        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 30 * minute) / 1000))

        XCTAssertFalse(model.missing)
        // 4 segments + 1 pause + 1 gap.
        XCTAssertEqual(model.events.count, 6)
        XCTAssertEqual(model.events.map(\.startedMs), model.events.map(\.startedMs).sorted(),
                       "the log is chronological, whatever order the tables were read in")
        XCTAssertEqual(model.events.filter { $0.kind == .idle }.count, 1)
        XCTAssertEqual(model.events.filter { if case .pause = $0.kind { return true } else { return false } }.count, 1)
        XCTAssertEqual(model.events.filter { if case .gap = $0.kind { return true } else { return false } }.count, 1)
    }

    func testTotalsDescribeTheSessionAndNotTheDayAroundIt() throws {
        let id = try fixture()
        // Work either side of the session must not leak into its numbers.
        try segment(-30, 20, app: "Slack")
        try segment(40, 20, app: "Slack")

        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 70 * minute) / 1000))

        XCTAssertEqual(model.totals.focusedMs, 20 * minute)
        XCTAssertEqual(model.totals.idleMs, 5 * minute)
        XCTAssertEqual(model.appBuckets.map(\.key), ["Cursor", "Brave"])
        XCTAssertEqual(model.appBuckets.first?.ms, 15 * minute)
        XCTAssertFalse(model.appBuckets.contains { $0.key == "Slack" },
                       "a neighbouring app is not part of this pomodoro")
    }

    func testASegmentStraddlingTheStartIsClippedNotDropped() throws {
        let id = try fixture()
        try segment(-5, 10, app: "Ghostty")   // 5 minutes before, 5 inside

        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 30 * minute) / 1000))

        let ghostty = try XCTUnwrap(model.appBuckets.first { $0.key == "Ghostty" })
        XCTAssertEqual(ghostty.ms, 5 * minute, "only the part inside the session counts")
        XCTAssertEqual(model.events.first?.appName, "Ghostty")
        XCTAssertEqual(model.events.first?.startedMs, base, "clipped to the session start")
    }

    func testPausedAndUnmeasuredTimeAreReportedSeparately() throws {
        let id = try fixture()
        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 30 * minute) / 1000))

        XCTAssertEqual(model.pausedMs, minute)
        XCTAssertEqual(model.unmeasuredMs, minute)
        XCTAssertEqual(model.counts.keys, 320)
        XCTAssertEqual(model.counts.clicks, 12)
    }

    func testDensityIsFocusedTimeOverWallClockNotOverPlanned() throws {
        let id = try fixture()
        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 30 * minute) / 1000))

        XCTAssertEqual(model.actualMs, 25 * minute)
        XCTAssertEqual(model.completion, 1, accuracy: 0.001)
        XCTAssertEqual(model.density, 0.8, accuracy: 0.001, "20 focused minutes of 25 elapsed")
    }

    func testEffortChartStaysReadableForALongSession() throws {
        let id = try store.startSession(ActivityStore.FocusSession(
            kind: ActivityStore.SessionKind.flow.rawValue, plannedSec: 25 * 60,
            startedMs: base, state: ActivityStore.SessionState.running.rawValue, cycleIndex: 0))
        try store.endSession(id: id, at: base + 300 * minute, state: ActivityStore.SessionState.done)

        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 300 * minute) / 1000))

        XCTAssertLessThanOrEqual(model.effort.count, 60, "a five-hour overrun still fits the chart")
        XCTAssertGreaterThan(model.effort.count, 1)
    }

    func testAForgottenSessionSaysSoInsteadOfDrawingZeroes() throws {
        let model = FocusSessionDetailModel(store: store, sessionId: 4242)
        model.reload()
        XCTAssertTrue(model.missing)
        XCTAssertNil(model.session)
        XCTAssertTrue(model.markdown().contains("no longer"))
    }

    func testMarkdownCarriesTheSameNumbersTheWindowDraws() throws {
        let id = try fixture()
        let model = FocusSessionDetailModel(store: store, sessionId: id)
        model.reload(now: Date(timeIntervalSince1970: Double(base + 30 * minute) / 1000))

        let markdown = model.markdown()
        XCTAssertTrue(markdown.contains("spec22"))
        XCTAssertTrue(markdown.contains("wire the detail window"))
        XCTAssertTrue(markdown.contains("Keystrokes 320"))
        XCTAssertTrue(markdown.contains("## Apps"))
        XCTAssertTrue(markdown.contains("## Timeline"))
        XCTAssertTrue(markdown.contains("github.com"))
    }
}
