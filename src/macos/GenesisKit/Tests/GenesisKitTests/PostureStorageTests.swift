import XCTest
@testable import GenesisKit
@testable import GenesisKitPosture

final class PostureCalibrationTests: XCTestCase {
    private func calibrated() throws -> PostureBaseline {
        try XCTUnwrap(PostureBaseline.calibrate(upright: (0..<4).map { _ in PostureMetrics(sample: postureSample()) }))
    }

    func testTheStandardBookHasHomeOfficeAndCafe() {
        let book = PostureCalibrationBook.standard
        XCTAssertEqual(book.slots.map(\.name), ["Home", "Office", "Cafe"])
        XCTAssertEqual(book.activeSlotID, "home")
        XCTAssertFalse(book.slots.contains(where: \.isCalibrated))
    }

    func testAutoSelectPicksTheSlotOfTheConnectedDisplays() throws {
        var book = PostureCalibrationBook.standard
        let base = try calibrated()
        book.store(base, referencePose: nil, cameraID: "cam-a", displaySet: ["B", "A"], in: "office")
        book.store(base, referencePose: nil, cameraID: "cam-b", displaySet: ["C"], in: "cafe")
        XCTAssertEqual(book.activeSlotID, "cafe")
        XCTAssertEqual(book.slot(id: "office")?.displaySet, ["A", "B"])
        // Exact match.
        XCTAssertTrue(book.autoSelect(displaySet: ["A", "B"]))
        XCTAssertEqual(book.activeSlotID, "office")
        XCTAssertFalse(book.autoSelect(displaySet: ["A", "B"]), "no change, no report")
        // No exact match: the slot sharing the most displays wins (C is the cafe's).
        XCTAssertTrue(book.autoSelect(displaySet: ["C", "Z"]))
        XCTAssertEqual(book.activeSlotID, "cafe")
        XCTAssertNil(book.slot(matching: ["Q"]))
        book.autoSelectByDisplays = false
        XCTAssertFalse(book.autoSelect(displaySet: ["A", "B"]))
    }

    func testCustomSlotsAddAndRemove() throws {
        var book = PostureCalibrationBook.standard
        let id = book.addCustom(name: "Standing desk")
        book.activeSlotID = id
        book.store(try calibrated(), referencePose: postureSample(), cameraID: nil, displaySet: [])
        XCTAssertTrue(try XCTUnwrap(book.slot(id: id)).isCalibrated)
        book.clear(id: id)
        XCTAssertFalse(try XCTUnwrap(book.slot(id: id)).isCalibrated)
        book.remove(id: id)
        XCTAssertNil(book.slot(id: id))
        XCTAssertEqual(book.activeSlotID, "home")
    }

    func testACalibrationSessionSkipsEmptyAndDarkSamples() throws {
        var session = PostureCalibrationSession()
        session.add(PoseSample(time: 0, engine: .visionBody), as: .upright)
        session.add(PoseSample(time: 0, engine: .visionBody, joints: postureSample().joints, lowLight: true), as: .upright)
        XCTAssertFalse(session.canFinish)
        for index in 0..<4 { session.add(postureSample(time: Double(index)), as: .upright) }
        session.add(postureSample(noseY: 0.6), as: .slouch)
        XCTAssertTrue(session.canFinish)
        let baseline = try XCTUnwrap(session.baseline())
        XCTAssertEqual(baseline.uprightCount, 4)
        XCTAssertEqual(baseline.slouchCount, 1)
        XCTAssertNotNil(session.referencePose)
    }

    func testTheStoreRoundTripsAndNeverOverwritesAnUnreadableFile() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-cal-\(UUID().uuidString)")
        let store = PostureCalibrationStore(directory: dir)
        let missing = await store.load()
        XCTAssertEqual(missing, .missing)
        var book = PostureCalibrationBook.standard
        book.store(try calibrated(), referencePose: postureSample(), cameraID: "cam", displaySet: ["A"],
                   at: Date(timeIntervalSince1970: 1_000_000))
        store.save(book)
        store.flush()
        let loaded = await store.load()
        XCTAssertEqual(loaded, .loaded(book))

        try Data("{ not json".utf8).write(to: store.fileURL)
        guard case .unreadable = await store.load() else { return XCTFail("expected unreadable") }
        store.save(PostureCalibrationBook.standard)
        store.flush()
        XCTAssertEqual(try Data(contentsOf: store.fileURL), Data("{ not json".utf8), "the unreadable bytes survive")
        store.discardUnreadable()
        store.save(PostureCalibrationBook.standard)
        store.flush()
        let replaced = await store.load()
        XCTAssertEqual(replaced, .loaded(.standard))
    }

    /// M17: a save before the first load is refused (it could replace slots nobody read yet), and a file
    /// that exists but cannot be read is unreadable, not missing.
    func testTheStoreRefusesToSaveBeforeLoadingAndOnlyANoSuchFileIsMissing() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-cal-\(UUID().uuidString)")
        let store = PostureCalibrationStore(directory: dir)
        final class Box: @unchecked Sendable { var error: Error? }
        let box = Box()
        store.save(.standard) { box.error = $0 }
        store.flush()
        XCTAssertNotNil(box.error)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL.path))

        // A folder where the file should be: reading fails with something other than "no such file".
        try FileManager.default.createDirectory(at: store.fileURL, withIntermediateDirectories: true)
        guard case .unreadable = await store.load() else { return XCTFail("a folder read as missing") }
    }
}

final class PostureHistoryTests: XCTestCase {
    func testClearReportsDirectoryEnumerationFailure() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("posture-clear-\(UUID())")
        try Data("not a directory".utf8).write(to: directory)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = PostureHistoryStore(directory: directory)
        let completed = expectation(description: "clear reports failure")
        store.clear { error in
            XCTAssertNotNil(error)
            completed.fulfill()
        }
        wait(for: [completed], timeout: 5)
        XCTAssertEqual(try String(contentsOf: directory, encoding: .utf8), "not a directory")
    }

    private var calendar: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Prague")!
        return calendar
    }

    private func date(_ day: Int, _ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
        calendar.date(from: DateComponents(year: 2026, month: 10, day: day, hour: hour, minute: minute, second: second))!
    }

    func testTheAccumulatorSplitsTimeAtMinuteBoundaries() {
        var accumulator = PostureMinuteAccumulator()
        XCTAssertEqual(accumulator.add(.upright, seconds: 50, endingAt: date(13, 10, 0, 50)), [])
        let rolled = accumulator.add(.slouching, seconds: 20, endingAt: date(13, 10, 1, 10))
        XCTAssertEqual(rolled, [PostureMinute(minute: date(13, 10, 0), upright: 50, slouch: 10)])
        _ = accumulator.addAlert(at: date(13, 10, 1, 10))
        XCTAssertEqual(accumulator.flush(), [PostureMinute(minute: date(13, 10, 1), slouch: 10, alerts: 1)])
        XCTAssertEqual(accumulator.flush(), [])
    }

    func testTheStoreSumsRowsPerMinuteAndSummarisesDays() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-history-\(UUID().uuidString)")
        let store = PostureHistoryStore(directory: dir, calendar: calendar)
        store.append([
            PostureMinute(minute: date(13, 9, 0), upright: 40, slouch: 20, alerts: 1),
            PostureMinute(minute: date(13, 9, 0), upright: 0, slouch: 0, away: 0, alerts: 0),
            PostureMinute(minute: date(12, 23, 59), upright: 60),
        ])
        // A partial minute flushed by a pause, then the rest of that minute.
        store.append([PostureMinute(minute: date(13, 9, 1), upright: 10)])
        store.append([PostureMinute(minute: date(13, 9, 1), upright: 30, away: 5)])
        store.flush()
        let minutes = await store.minutes(on: date(13, 12, 0))
        XCTAssertEqual(minutes, [
            PostureMinute(minute: date(13, 9, 0), upright: 40, slouch: 20, alerts: 1),
            PostureMinute(minute: date(13, 9, 1), upright: 40, away: 5),
        ])
        let today = await store.summary(for: date(13, 18, 0))
        XCTAssertEqual(today.upright, 80)
        XCTAssertEqual(today.slouch, 20)
        XCTAssertEqual(try XCTUnwrap(today.uprightFraction), 0.8, accuracy: 1e-9)
        let week = await store.lastDays(7, endingAt: date(13, 18, 0))
        XCTAssertEqual(week.count, 7)
        XCTAssertEqual(week.last?.upright, 80)
        XCTAssertEqual(week[week.count - 2].upright, 60)
        XCTAssertNil(week.first?.uprightFraction)
    }

    func testABadLineIsSkippedAndTheFileIsKept() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("posture-2026-10-13.jsonl")
        try Data("garbage\n".utf8).write(to: file)
        let store = PostureHistoryStore(directory: dir, calendar: calendar)
        store.append([PostureMinute(minute: date(13, 9, 0), upright: 60)])
        store.flush()
        let minutes = await store.minutes(on: date(13, 9, 0))
        XCTAssertEqual(minutes.map(\.upright), [60])
        XCTAssertTrue(String(decoding: try Data(contentsOf: file), as: UTF8.self).hasPrefix("garbage\n"))
    }

    func testOldDaysArePrunedAndADayFileStopsAtItsCap() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let old = dir.appendingPathComponent("posture-2026-07-01.jsonl")
        try Data().write(to: old)
        let store = PostureHistoryStore(directory: dir, retentionDays: 30, maxBytesPerDay: 200, calendar: calendar)
        for minute in 0..<10 { store.append([PostureMinute(minute: date(13, 9, minute), upright: 60)]) }
        store.flush()
        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        let size = try XCTUnwrap(FileManager.default.attributesOfItem(
            atPath: dir.appendingPathComponent("posture-2026-10-13.jsonl").path)[.size] as? Int)
        XCTAssertLessThanOrEqual(size, 200)
        XCTAssertGreaterThan(size, 0)
    }

    func testClearDeletesEveryDayAndNothingElse() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let other = dir.appendingPathComponent("notes.txt")
        try Data("keep".utf8).write(to: other)
        let store = PostureHistoryStore(directory: dir, calendar: calendar)
        store.append([PostureMinute(minute: date(12, 9, 0), upright: 60), PostureMinute(minute: date(13, 9, 0), upright: 60)])
        let cleared = expectation(description: "cleared")
        store.clear { error in
            XCTAssertNil(error)
            cleared.fulfill()
        }
        await fulfillment(of: [cleared], timeout: 5)
        let minutes = await store.minutes(on: date(13, 9, 0))
        XCTAssertEqual(minutes, [])
        let names = try FileManager.default.contentsOfDirectory(atPath: dir.path)
        XCTAssertEqual(names, ["notes.txt"])
    }

    /// Item 32: a day file whose last line was torn (no newline) gets the next row on a line of its own.
    func testARowAfterATornLineStartsOnItsOwnLine() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("posture-history-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("posture-2026-10-13.jsonl")
        try Data("{\"m\":\"2026-10-13T07:00:00Z\",\"u\":6".utf8).write(to: file)
        let store = PostureHistoryStore(directory: dir, calendar: calendar)
        store.append([PostureMinute(minute: date(13, 9, 5), upright: 30)])
        store.flush()
        let minutes = await store.minutes(on: date(13, 9, 0))
        XCTAssertEqual(minutes.map(\.upright), [30])
    }
}
