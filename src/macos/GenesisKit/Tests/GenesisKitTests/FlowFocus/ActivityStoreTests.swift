// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Tests/GenesisTests/ActivityStoreTests.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import SQLite3
import XCTest
@testable import GenesisKit
#if canImport(Genesis)
@testable import Genesis
#endif

/// Spec 22 (S6) T1 — the activity ledger. These pin the two things later tasks cannot work
/// around: the store's durations must equal wall clock, and the schema must have nowhere to
/// put keystroke content.
final class ActivityStoreTests: XCTestCase {
    private var path: String!
    private var store: ActivityStore!

    override func setUpWithError() throws {
        let dir = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("genesis-activity-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        path = dir.appendingPathComponent("activity.db").path
        store = try ActivityStore(path: path)
    }

    override func tearDownWithError() throws {
        store = nil
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.removeItem(atPath: dir)
    }

    private func segment(_ start: Int64, app: String = "dev.foltyn.genesis", title: String? = nil) -> ActivityStore.Segment {
        ActivityStore.Segment(startedMs: start, appBundle: app, appName: app, windowTitle: title)
    }

    // MARK: - Migration

    func testMigrationIsIdempotent() throws {
        // Opening the same file twice must not throw: migrate runs on every open.
        let second = try ActivityStore(path: path)
        XCTAssertEqual(second.dbPath, path)
    }

    func testFileIsPrivateToTheUser() throws {
        let attrs = try FileManager.default.attributesOfItem(atPath: path)
        let mode = (attrs[.posixPermissions] as? NSNumber)?.intValue ?? 0
        XCTAssertEqual(mode, 0o600, "the ledger must not be readable by other users")
    }

    // MARK: - Segments

    func testSegmentDurationIsWallClock() throws {
        let id = try store.openSegment(segment(1_000))
        try store.closeSegment(id: id, at: 4_000)
        let rows = try store.segments(from: 0, to: 10_000)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows[0].durationMs, 3_000)
    }

    func testClosingTwiceKeepsTheFirstEnd() throws {
        // A duplicate activation notification must never shorten a stretch already recorded.
        let id = try store.openSegment(segment(1_000))
        try store.closeSegment(id: id, at: 4_000)
        try store.closeSegment(id: id, at: 2_000)
        XCTAssertEqual(try store.segments(from: 0, to: 10_000)[0].endedMs, 4_000)
    }

    func testRangeQueryIncludesOverlapAndOpenSegments() throws {
        let before = try store.openSegment(segment(0))
        try store.closeSegment(id: before, at: 500)          // entirely before the window
        let overlapping = try store.openSegment(segment(900))
        try store.closeSegment(id: overlapping, at: 1_500)   // straddles the start
        _ = try store.openSegment(segment(2_000))            // still open

        let rows = try store.segments(from: 1_000, to: 3_000)
        XCTAssertEqual(rows.count, 2, "an open segment and a straddling one both count")
        XCTAssertEqual(rows.map(\.startedMs), [900, 2_000])
    }

    func testIdleAndAttributionRoundTrip() throws {
        var seg = segment(1_000, app: "com.brave.Browser", title: "PR #65")
        seg.urlHost = "github.com"
        seg.urlPath = "/anthropics/claude-code/pull/65"
        seg.project = "genesis"
        seg.cmuxSession = "genesisplayground-a7"
        seg.idle = true
        let id = try store.openSegment(seg)
        try store.closeSegment(id: id, at: 2_000)

        let row = try store.segments(from: 0, to: 5_000)[0]
        XCTAssertEqual(row.urlHost, "github.com")
        XCTAssertEqual(row.project, "genesis")
        XCTAssertEqual(row.cmuxSession, "genesisplayground-a7")
        XCTAssertTrue(row.idle)
    }

    // MARK: - Input counters

    func testInputBucketsAccumulate() throws {
        let id = try store.openSegment(segment(60_000))
        try store.appendInput(bucketMs: 60_000, segmentId: id, counts: .init(keys: 10, clicks: 2, scrolls: 1, px: 300))
        try store.appendInput(bucketMs: 60_000, segmentId: id, counts: .init(keys: 5, clicks: 1, scrolls: 0, px: 120))

        let totals = try store.inputTotals(from: 0, to: 120_000)
        XCTAssertEqual(totals.keys, 15, "the same bucket must add, not replace")
        XCTAssertEqual(totals.clicks, 3)
        XCTAssertEqual(totals.px, 420)
    }

    func testSchemaHasNowhereToStoreKeystrokeContent() throws {
        // The privacy guarantee is structural, not a promise in a comment: if no column can hold
        // a character or a keycode, no future change can quietly start logging one.
        let forbidden = ["key_code", "keycode", "chars", "characters", "text", "content", "keystroke"]
        for table in ["input_bucket", "activity_segment"] {
            let columns = try self.columns(of: table)
            for name in columns {
                XCTAssertFalse(forbidden.contains(name),
                               "\(table).\(name) could hold input content")
            }
        }
        XCTAssertEqual(try columns(of: "input_bucket").sorted(),
                       ["bucket_ms", "clicks", "keys", "px", "scrolls", "segment_id"])
    }

    // MARK: - Sessions

    func testSessionLifecycleAndOpenSessionRecovery() throws {
        let id = try store.startSession(.init(kind: ActivityStore.SessionKind.flow.rawValue,
                                              plannedSec: 1_500, startedMs: 1_000,
                                              state: ActivityStore.SessionState.running.rawValue,
                                              cycleIndex: 0, tag: "Example project"))
        // Mid-flow crash: the next launch must find this session and resume it.
        let recovered = try store.openSession()
        XCTAssertEqual(recovered?.id, id)
        XCTAssertEqual(recovered?.tag, "Example project")

        try store.endSession(id: id, at: 2_500, state: .done)
        XCTAssertNil(try store.openSession())
        XCTAssertEqual(try store.sessions(from: 0, to: 5_000).first?.actualMs, 1_500)
    }

    func testPausedTimeIsExcludable() throws {
        let session = try store.startSession(.init(kind: "flow", plannedSec: 1_500, startedMs: 0,
                                                   state: "running", cycleIndex: 0))
        let pause = try store.recordPause(sessionId: session, startedMs: 1_000, endedMs: nil, reason: .idle)
        XCTAssertEqual(try store.pausedMs(sessionId: session, now: 3_000), 2_000,
                       "an open pause counts up to now")
        try store.closePause(id: pause, at: 2_000)
        XCTAssertEqual(try store.pausedMs(sessionId: session, now: 9_999), 1_000)
    }

    func testUpdateSessionKeepsUnsetFields() throws {
        let id = try store.startSession(.init(kind: "flow", plannedSec: 60, startedMs: 0,
                                              state: "running", cycleIndex: 0, tag: "keep"))
        try store.updateSession(id: id, tag: nil, note: "went well", interruptions: 2)
        let row = try store.sessions(from: 0, to: 1_000)[0]
        XCTAssertEqual(row.tag, "keep", "a nil field must not erase the stored value")
        XCTAssertEqual(row.note, "went well")
        XCTAssertEqual(row.interruptions, 2)
        try store.clearSessionTag(id: id)
        XCTAssertNil(try store.sessions(from: 0, to: 1_000)[0].tag, "clearing is its own write")
        XCTAssertEqual(try store.sessions(from: 0, to: 1_000)[0].note, "went well")
    }

    // MARK: - Deletion

    func testForgetRemovesTheRangeAndReportsWhatWent() throws {
        let kept = try store.openSegment(segment(10_000))
        try store.closeSegment(id: kept, at: 11_000)
        let doomed = try store.openSegment(segment(1_000))
        try store.closeSegment(id: doomed, at: 2_000)
        try store.appendInput(bucketMs: 1_000, segmentId: doomed, counts: .init(keys: 99))
        _ = try store.startSession(.init(kind: "flow", plannedSec: 60, startedMs: 1_200,
                                         state: "done", cycleIndex: 0))

        let removed = try store.forget(from: 0, to: 5_000)
        XCTAssertEqual(removed.segments, 1)
        XCTAssertEqual(removed.sessions, 1)
        XCTAssertEqual(try store.segments(from: 0, to: 100_000).map(\.id), [kept])
        XCTAssertEqual(try store.inputTotals(from: 0, to: 100_000).keys, 0,
                       "input buckets of a deleted segment must go with it")
        XCTAssertTrue(try store.sessions(from: 0, to: 100_000).isEmpty)
    }

    func testForgetCutsASegmentAndSessionThatStartedBeforeTheRange() throws {
        let straddling = try store.openSegment(segment(1_000))
        try store.closeSegment(id: straddling, at: 9_000)
        try store.appendInput(bucketMs: 0, segmentId: straddling, counts: .init(keys: 3))
        try store.appendInput(bucketMs: 6_000, segmentId: straddling, counts: .init(keys: 40))
        let session = try store.startSession(.init(kind: "flow", plannedSec: 60, startedMs: 500,
                                                   state: "done", cycleIndex: 0))
        try store.endSession(id: session, at: 9_500, state: .done)

        try store.forget(from: 5_000, to: 20_000)
        let kept = try store.segments(from: 0, to: 100_000)
        XCTAssertEqual(kept.map(\.id), [straddling])
        XCTAssertEqual(kept.first?.endedMs, 5_000, "the part inside the range is no longer attributed to the window")
        XCTAssertEqual(try store.inputTotals(from: 0, to: 100_000).keys, 3, "input inside the range goes")
        XCTAssertEqual(try store.sessions(from: 0, to: 100_000).first?.endedMs, 5_000)
    }

    func testForgetKeepsTheOpenSegmentFromReclaimingTheRangeAndKeepsTimeAfterIt() throws {
        let open = try store.openSegment(segment(1_000, title: "open"))
        try store.touchSegment(id: open, at: 6_000)
        try store.appendInput(bucketMs: 0, segmentId: open, counts: .init(keys: 3))
        try store.appendInput(bucketMs: 6_000, segmentId: open, counts: .init(keys: 40))
        let long = try store.openSegment(segment(1_000, title: "long"))
        try store.closeSegment(id: long, at: 20_000)
        try store.appendInput(bucketMs: 12_000, segmentId: long, counts: .init(keys: 7))

        try store.forget(from: 5_000, to: 8_000)
        // The recorder still holds `open` and touches it on its next tick.
        try store.touchSegment(id: open, at: 10_000)

        let rows = try store.segments(from: 0, to: 100_000)
        for row in rows {
            XCTAssertTrue((row.endedMs ?? row.startedMs) <= 5_000 || row.startedMs >= 8_000,
                          "\(row.windowTitle ?? "") \(row.startedMs)-\(row.endedMs ?? -1) overlaps the forgotten range")
        }
        let opened = rows.filter { $0.windowTitle == "open" }
        XCTAssertEqual(opened.map(\.startedMs), [1_000, 8_000])
        XCTAssertEqual(opened.map(\.endedMs), [5_000, 10_000])
        XCTAssertEqual(try store.openSegments().map(\.id), [open], "the recorder's segment stays open under its id")
        let longRows = rows.filter { $0.windowTitle == "long" }
        XCTAssertEqual(longRows.map(\.startedMs), [1_000, 8_000])
        XCTAssertEqual(longRows.map(\.endedMs), [5_000, 20_000], "time after the range is not forgotten")
        let series = try store.inputSeries(from: 0, to: 100_000)
        XCTAssertEqual(series.map(\.bucketMs), [0, 12_000])
        XCTAssertEqual(series.first?.segmentId, opened.first?.id, "input before the range follows the part before it")
        XCTAssertEqual(series.last?.segmentId, long, "input after the range stays with the segment's id")
    }

    @MainActor
    func testTheOwnerDeletesActivityOlderThanTheRetentionPeriod() throws {
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        let day: Int64 = 86_400_000
        let old = try store.openSegment(segment(now - 40 * day, title: "old"))
        try store.closeSegment(id: old, at: now - 40 * day + 60_000)
        let recent = try store.openSegment(segment(now - day, title: "recent"))
        try store.closeSegment(id: recent, at: now - day + 60_000)
        let controller = FocusController()
        controller.ownsRuntime = true
        controller.configuration = FlowFocusConfiguration(directory: URL(fileURLWithPath: (path as NSString).deletingLastPathComponent))
        controller.start(appConfig: ["focus": ["retentionDays": 30]], databasePath: path,
                         liveServices: false, presentsWindows: false)
        defer { controller.stop() }
        XCTAssertEqual(try store.segments(from: 0, to: now + 1).map(\.windowTitle), ["recent"],
                       "activity older than 30 days is deleted; the last day stays")

        controller.apply(appConfig: ["focus": ["retentionDays": 1]])
        XCTAssertTrue(try store.segments(from: 0, to: now + 1).isEmpty, "shortening retention prunes at once")
    }

    func testForgetCanScopeToOneApp() throws {
        let brave = try store.openSegment(segment(1_000, app: "com.brave.Browser"))
        try store.closeSegment(id: brave, at: 2_000)
        let genesis = try store.openSegment(segment(1_000, app: "dev.foltyn.genesis"))
        try store.closeSegment(id: genesis, at: 2_000)

        let removed = try store.forget(from: 0, to: 5_000, appBundle: "com.brave.Browser")
        XCTAssertEqual(removed.segments, 1)
        XCTAssertEqual(removed.sessions, 0, "scoping to an app must not touch sessions")
        XCTAssertEqual(try store.segments(from: 0, to: 5_000).map(\.appBundle), ["dev.foltyn.genesis"])
    }

    // MARK: - Input counter

    func testAForcedFlushHandsOverTheBucketThatIsStillOpen() {
        // stop() flushes with force: without it, the counts of the current minute are dropped
        // with the tap on every stop and every capture pause.
        let counter = InputCounter()
        var flushed: [ActivityStore.InputCounts] = []
        counter.onFlush = { _, counts in flushed.append(counts) }
        counter.recordForTesting(type: .keyDown)
        counter.recordForTesting(type: .keyDown)

        let now = Date().timeIntervalSince1970 * 1000
        counter.flush(now: now)
        XCTAssertTrue(flushed.isEmpty, "an unforced flush waits for the minute to end")
        counter.flush(now: now, force: true)
        XCTAssertEqual(flushed.map(\.keys), [2])
        XCTAssertEqual(counter.snapshot(), ActivityStore.InputCounts(), "and starts a fresh bucket")
    }

    func testARestartFilesNewInputUnderTheRestartMinute() {
        // start() forces a flush to rebase the bucket. Without it, input after a restart in a
        // later minute is filed under the minute capture stopped in.
        let counter = InputCounter()
        var flushed: [Int64] = []
        counter.onFlush = { bucket, _ in flushed.append(bucket) }
        let stoppedAt = Date().timeIntervalSince1970 * 1000
        counter.recordForTesting(type: .keyDown)
        counter.flush(now: stoppedAt, force: true) // what stop() does

        let restartedAt = stoppedAt + 5 * 60_000
        counter.flush(now: restartedAt, force: true) // what start() does
        counter.recordForTesting(type: .keyDown)
        counter.flush(now: restartedAt + 60_000)
        XCTAssertEqual(flushed, [InputCounter.bucketStart(stoppedAt), InputCounter.bucketStart(restartedAt)])
    }

    // MARK: - Gaps and rollups

    func testCaptureGapIsRecordable() throws {
        let id = try store.recordGap(startedMs: 1_000, endedMs: nil, reason: "tap_disabled_by_timeout")
        XCTAssertGreaterThan(id, 0)
    }

    func testRollupCacheRoundTripsAndForgetClearsIt() throws {
        try store.cacheRollup(day: "2026-09-21", json: "{\"focusedSec\":42}", computedMs: 1)
        XCTAssertEqual(try store.cachedRollup(day: "2026-09-21"), "{\"focusedSec\":42}")
        _ = try store.forget(from: 0, to: 1)
        XCTAssertNil(try store.cachedRollup(day: "2026-09-21"),
                     "a deletion must invalidate the cached day, or the UI keeps showing it")
    }

    func testTouchThenCloseUsesTheFinalBoundaryAndCannotBeRetouched() throws {
        let id = try store.openSegment(segment(1_000))
        try store.touchSegment(id: id, at: 2_000)
        try store.closeSegment(id: id, at: 2_500)
        try store.touchSegment(id: id, at: 9_000)
        try store.closeSegment(id: id, at: 10_000)
        XCTAssertEqual(try store.segments(from: 0, to: 20_000).first?.endedMs, 2_500)
    }

    func testInputTotalsAndSeriesKeepSixtyFourBitCounters() throws {
        let id = try store.openSegment(segment(0))
        try store.appendInput(bucketMs: 0, segmentId: id, counts: .init(keys: 2_000_000_000, clicks: 0, scrolls: 0, px: 2_000_000_000))
        try store.appendInput(bucketMs: 0, segmentId: id, counts: .init(keys: 2_000_000_000, clicks: 0, scrolls: 0, px: 2_000_000_000))
        XCTAssertEqual(try store.inputTotals(from: 0, to: 60_000).px, 4_000_000_000)
        XCTAssertEqual(try store.inputSeries(from: 0, to: 60_000).first?.counts.keys, 4_000_000_000)
        try store.appendInput(bucketMs: 0, segmentId: id, counts: .init(keys: 4_000_000_000, clicks: 0, scrolls: 0, px: 0))
        XCTAssertEqual(try store.inputSeries(from: 0, to: 60_000).first?.counts.keys, 8_000_000_000)
    }

    func testForgetRollsBackEveryTableWhenOneDeletionFails() throws {
        let id = try store.openSegment(segment(1_000))
        try store.appendInput(bucketMs: 1_000, segmentId: id, counts: .init(keys: 7, clicks: 0, scrolls: 0, px: 0))
        try store.cacheRollup(day: "fixture", json: "{}", computedMs: 1_000)
        for table in ["input_bucket", "activity_segment"] {
            try executeFixtureSQL("CREATE TRIGGER deny_fixture_delete BEFORE DELETE ON \(table) BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;")
            XCTAssertThrowsError(try store.forget(from: 0, to: 2_000))
            XCTAssertEqual(try store.segments(from: 0, to: 2_000).count, 1)
            XCTAssertEqual(try store.inputTotals(from: 0, to: 2_000).keys, 7, "a later failure rolls back the earlier bucket delete")
            XCTAssertNotNil(try store.cachedRollup(day: "fixture"))
            try executeFixtureSQL("DROP TRIGGER deny_fixture_delete;")
        }
        XCTAssertEqual(try store.forget(from: 0, to: 2_000).segments, 1)
        XCTAssertEqual(try store.inputTotals(from: 0, to: 2_000).keys, 0)
    }

    func testForgetClipsAndSplitsCaptureGapsWithoutDeletingOutsideTime() throws {
        _ = try store.recordGap(startedMs: 1_000, endedMs: 5_000, reason: "spanning")
        _ = try store.recordGap(startedMs: 2_500, endedMs: 3_000, reason: "inside")
        _ = try store.recordGap(startedMs: 3_500, endedMs: nil, reason: "open")
        _ = try store.recordGap(startedMs: 6_000, endedMs: 7_000, reason: "outside")
        _ = try store.forget(from: 2_000, to: 4_000)
        XCTAssertTrue(try store.gaps(from: 2_000, to: 4_000).isEmpty)
        let rows = try store.gaps(from: 0, to: 10_000)
        XCTAssertEqual(rows.filter { $0.reason == "spanning" }.map(\.startedMs), [1_000, 4_000])
        XCTAssertEqual(rows.filter { $0.reason == "spanning" }.map(\.endedMs), [2_000, 5_000])
        XCTAssertEqual(rows.first { $0.reason == "open" }?.startedMs, 4_000)
        XCTAssertEqual(rows.first { $0.reason == "outside" }?.endedMs, 7_000)
    }

    func testLedgerSidecarsArePrivateWithoutChangingAnExistingSharedParent() throws {
        let parent = (path as NSString).deletingLastPathComponent
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: parent)
        for file in [path!, path + "-wal", path + "-shm"] {
            if FileManager.default.fileExists(atPath: file) {
                try FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: file)
            }
        }
        let another = try ActivityStore(path: path)
        _ = try another.openSegment(segment(100))
        for file in [path!, path + "-wal", path + "-shm"] {
            let attributes = try FileManager.default.attributesOfItem(atPath: file)
            XCTAssertEqual((attributes[.posixPermissions] as? NSNumber)?.intValue, 0o600, file)
        }
        let parentMode = try FileManager.default.attributesOfItem(atPath: parent)[.posixPermissions] as? NSNumber
        XCTAssertEqual(parentMode?.intValue, 0o755, "do not chmod a caller's shared existing parent")
        let nested = parent + "/private-ledger/activity.db"
        let nestedStore = try ActivityStore(path: nested)
        _ = nestedStore
        let nestedMode = try FileManager.default.attributesOfItem(atPath: (nested as NSString).deletingLastPathComponent)[.posixPermissions] as? NSNumber
        XCTAssertEqual(nestedMode?.intValue, 0o700)
    }

    func testLegacySegmentsMigrateWithoutReopeningClosedHistory() throws {
        let closed = try store.openSegment(segment(1_000))
        try store.closeSegment(id: closed, at: 2_000)
        let open = try store.openSegment(segment(3_000))
        store = nil
        try executeFixtureSQL("ALTER TABLE activity_segment DROP COLUMN is_closed;")
        store = try ActivityStore(path: path)
        XCTAssertEqual(try store.openSegments().map(\.id), [open])
        try store.touchSegment(id: closed, at: 9_000)
        XCTAssertEqual(try store.segments(from: 0, to: 10_000).first?.endedMs, 2_000)
        try store.touchSegment(id: open, at: 4_000)
        try store.closeSegment(id: open, at: 4_500)
        XCTAssertTrue(try store.openSegments().isEmpty)
    }

    func testBriefConcurrentWriterContentionWaitsAndThenSucceeds() throws {
        final class Connection: @unchecked Sendable {
            let handle: OpaquePointer
            init(_ handle: OpaquePointer) { self.handle = handle }
            deinit { sqlite3_close(handle) }
        }
        var handle: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil), SQLITE_OK)
        let connection = Connection(try XCTUnwrap(handle))
        XCTAssertEqual(sqlite3_exec(connection.handle, "BEGIN IMMEDIATE;", nil, nil, nil), SQLITE_OK)
        let released = expectation(description: "external writer released its lock")
        DispatchQueue.global().asyncAfter(deadline: .now() + 0.1) {
            XCTAssertEqual(sqlite3_exec(connection.handle, "COMMIT;", nil, nil, nil), SQLITE_OK)
            released.fulfill()
        }
        XCTAssertNoThrow(try store.openSegment(segment(1_000)))
        wait(for: [released], timeout: 2)
        XCTAssertEqual(try store.segments(from: 0, to: 2_000).count, 1)
    }

    private func executeFixtureSQL(_ sql: String) throws {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK else {
            throw ActivityStore.StoreError.sqlite("fixture open failed")
        }
        defer { sqlite3_close(handle) }
        guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else {
            throw ActivityStore.StoreError.sqlite(String(cString: sqlite3_errmsg(handle)))
        }
    }

    // MARK: - Helpers

    private func columns(of table: String) throws -> [String] {
        let probe = try ActivityStore(path: path)
        _ = probe // keep the store alive while we read through a fresh handle
        var names: [String] = []
        var db: OpaquePointer?
        XCTAssertEqual(sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY, nil), SQLITE_OK)
        defer { sqlite3_close(db) }
        var stmt: OpaquePointer?
        XCTAssertEqual(sqlite3_prepare_v2(db, "PRAGMA table_info(\(table));", -1, &stmt, nil), SQLITE_OK)
        defer { sqlite3_finalize(stmt) }
        while sqlite3_step(stmt) == SQLITE_ROW {
            if let raw = sqlite3_column_text(stmt, 1) { names.append(String(cString: raw)) }
        }
        return names
    }
}
