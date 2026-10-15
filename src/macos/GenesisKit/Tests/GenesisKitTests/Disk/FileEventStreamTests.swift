import Foundation
import XCTest
@testable import GenesisKit

/// Collects batches from the stream's queue.
private final class BatchLog: @unchecked Sendable {
    private let lock = NSLock()
    private var batches: [FileEventBatch] = []
    private var onMain = 0

    func add(_ batch: FileEventBatch) {
        lock.lock()
        batches.append(batch)
        if Thread.isMainThread { onMain += 1 }
        lock.unlock()
    }

    var all: [FileEventBatch] { lock.lock(); defer { lock.unlock() }; return batches }
    var deliveredOnMain: Int { lock.lock(); defer { lock.unlock() }; return onMain }

    func flags(for path: String) -> FileEventFlags {
        all.flatMap(\.events).filter { $0.path == path }.reduce(into: FileEventFlags()) { $0.formUnion($1.flags) }
    }
}

private final class MemoryCursorStore: FileEventCursorStore, @unchecked Sendable {
    private let lock = NSLock()
    private var cursors: [String: FileEventCursor] = [:]

    func loadCursor(forKey key: String) -> FileEventCursor? {
        lock.lock()
        defer { lock.unlock() }
        return cursors[key]
    }

    func saveCursor(_ cursor: FileEventCursor, forKey key: String) {
        lock.lock()
        cursors[key] = cursor
        lock.unlock()
    }
}

final class FileEventStreamTests: XCTestCase {
    /// The real folder (`/private/var/...`); the stream reports paths in the `/var/...` spelling.
    private var directory: URL!
    private var root: String { directory.path }

    private func reported(_ url: URL) -> String { DirectoryWatcher.normalizedEventPath(url.path) }

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("fse-\(UUID())")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        directory = base.resolvingSymlinksInPath()
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
    }

    private func waitUntil(_ message: String, timeout: TimeInterval = 10, _ condition: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            if Date() > deadline { return XCTFail("timed out: \(message)") }
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
    }

    private func config(ignoreSelf: Bool = false, cursorKey: String? = nil) -> FileEventStream.Configuration {
        FileEventStream.Configuration(paths: [root], latency: 0.2, ignoreSelf: ignoreSelf, cursorKey: cursorKey)
    }

    func testCreateGrowAndDeleteArriveOffTheMainThreadMergedPerPath() throws {
        let log = BatchLog()
        let stream = FileEventStream(configuration: config()) { log.add($0) }
        XCTAssertTrue(stream.start())
        defer { stream.stop() }
        let file = directory.appendingPathComponent("grow.bin")
        try Data(repeating: 1, count: 4096).write(to: file)
        let handle = try FileHandle(forWritingTo: file)
        try handle.seekToEnd()
        try handle.write(contentsOf: Data(repeating: 2, count: 4096))
        try handle.close()
        waitUntil("created and modified") {
            log.flags(for: reported(file)).isSuperset(of: [.itemCreated, .itemIsFile])
        }
        try FileManager.default.removeItem(at: file)
        waitUntil("removed") { log.flags(for: reported(file)).contains(.itemRemoved) }
        XCTAssertEqual(log.deliveredOnMain, 0, "batches are delivered on the stream's queue")
        for batch in log.all {
            XCTAssertEqual(Set(batch.events.map(\.path)).count, batch.events.count, "one event per path in a batch")
        }
        XCTAssertGreaterThan(stream.lastEventId, 0)
    }

    func testIgnoreSelfHidesOwnWritesButNotAChildProcess() throws {
        let log = BatchLog()
        let stream = FileEventStream(configuration: config(ignoreSelf: true)) { log.add($0) }
        XCTAssertTrue(stream.start())
        defer { stream.stop() }
        let own = directory.appendingPathComponent("own.txt")
        try Data("mine".utf8).write(to: own)
        let child = directory.appendingPathComponent("child.txt")
        let touch = Process()
        touch.executableURL = URL(fileURLWithPath: "/usr/bin/touch")
        touch.arguments = [child.path]
        _ = try touch.runCapturing(timeout: 10)
        waitUntil("the child's file") { !log.flags(for: reported(child)).isEmpty }
        RunLoop.current.run(until: Date().addingTimeInterval(0.5))
        XCTAssertTrue(log.flags(for: reported(own)).isEmpty, "this process's own write is hidden")
    }

    func testAStoppedStreamReplaysWhatHappenedMeanwhileFromItsCursor() throws {
        let store = MemoryCursorStore()
        let first = FileEventStream(configuration: config(cursorKey: "fixture"), cursorStore: store) { _ in }
        XCTAssertTrue(first.start())
        first.stop()
        let saved = try XCTUnwrap(store.loadCursor(forKey: "fixture"))
        XCTAssertGreaterThan(saved.eventId, 0)
        XCTAssertFalse(saved.deviceUUIDs.isEmpty, "the volume's FSEvents UUID is kept with the id")

        let missed = directory.appendingPathComponent("while-stopped.txt")
        try Data("missed".utf8).write(to: missed)
        // Make sure fseventsd has the write before the replay starts.
        RunLoop.current.run(until: Date().addingTimeInterval(1.5))

        let log = BatchLog()
        let second = FileEventStream(configuration: config(cursorKey: "fixture"), cursorStore: store) { log.add($0) }
        XCTAssertTrue(second.start())
        defer { second.stop() }
        waitUntil("replayed and history done") {
            !log.flags(for: reported(missed)).isEmpty && log.all.contains(where: \.historyDone)
        }
        XCTAssertTrue(log.all.first { $0.events.contains { $0.path == self.reported(missed) } }?.isReplay ?? false)
        XCTAssertFalse(log.all.contains(where: \.historyInvalid))
    }

    func testACursorFromAnotherVolumeIsDroppedAndEveryRootIsRescanned() throws {
        let store = MemoryCursorStore()
        store.saveCursor(FileEventCursor(eventId: 5, deviceUUIDs: ["00000000-0000-0000-0000-000000000000"], savedAt: Date()),
                         forKey: "fixture")
        let log = BatchLog()
        let caller = Thread.current
        final class Threads: @unchecked Sendable { var onCaller = false }
        let threads = Threads()
        let stream = FileEventStream(configuration: config(cursorKey: "fixture"), cursorStore: store) {
            if Thread.current == caller { threads.onCaller = true }
            log.add($0)
        }
        XCTAssertTrue(stream.start())
        defer { stream.stop() }
        waitUntil("the rescan batch") { !log.all.isEmpty }
        XCTAssertFalse(threads.onCaller, "delivered on the stream's queue, not inside start()")
        let first = try XCTUnwrap(log.all.first)
        XCTAssertTrue(first.historyInvalid)
        XCTAssertEqual(first.rescanRoots, [reported(directory)])
        XCTAssertNotEqual(store.loadCursor(forKey: "fixture")?.deviceUUIDs, ["00000000-0000-0000-0000-000000000000"],
                          "the bad cursor is replaced at once")
    }

    func testStopIsSafeFromTheCallbackAndTwice() throws {
        final class Holder: @unchecked Sendable { var stream: FileEventStream? }
        let log = BatchLog()
        let holder = Holder()
        holder.stream = FileEventStream(configuration: config()) { batch in
            log.add(batch)
            holder.stream?.stop()
        }
        XCTAssertTrue(holder.stream?.start() ?? false)
        try Data("x".utf8).write(to: directory.appendingPathComponent("stop.txt"))
        waitUntil("one batch") { !log.all.isEmpty }
        waitUntil("stopped") { holder.stream?.isRunning == false }
        holder.stream?.stop()
        holder.stream = nil
    }

    func testAnEmptyPathListDoesNotStart() {
        XCTAssertFalse(FileEventStream(configuration: .init(paths: [])) { _ in }.start())
    }

    // MARK: - Pure batch rules

    func testABatchMergesPerPathAndTurnsLossFlagsIntoRescans() {
        let roots = ["/private/var/folders/ab/T/root"]
        let raw: [(path: String, flags: UInt32, id: UInt64)] = [
            ("/private/var/folders/ab/T/root/a", UInt32(kFSEventStreamEventFlagItemCreated | kFSEventStreamEventFlagItemIsFile), 10),
            ("/private/var/folders/ab/T/root/a", UInt32(kFSEventStreamEventFlagItemModified | kFSEventStreamEventFlagItemIsFile), 12),
            ("/private/var/folders/ab/T/root/sub", UInt32(kFSEventStreamEventFlagMustScanSubDirs), 13),
            ("/private/var/folders/ab/T/root/sub/deeper", UInt32(kFSEventStreamEventFlagMustScanSubDirs), 14),
            ("/private/var/folders/ab/T/root/b", UInt32(kFSEventStreamEventFlagItemRemoved | kFSEventStreamEventFlagItemIsFile), 11),
        ]
        let batch = FileEventStream.makeBatch(raw, roots: roots, replaying: false)
        XCTAssertEqual(batch.events.map(\.path), ["/var/folders/ab/T/root/a", "/var/folders/ab/T/root/b"])
        XCTAssertEqual(batch.events.first?.flags, [.itemCreated, .itemModified, .itemIsFile])
        XCTAssertEqual(batch.events.first?.id, 12)
        XCTAssertEqual(batch.rescanRoots, ["/var/folders/ab/T/root/sub"], "a folder inside another rescan is left out")
        XCTAssertEqual(batch.lastEventId, 14)
        XCTAssertFalse(batch.dropped)

        let dropped = FileEventStream.makeBatch(
            [("/private/var/folders/ab/T/root", UInt32(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped), 20),
             ("/", UInt32(kFSEventStreamEventFlagHistoryDone), 21)],
            roots: roots, replaying: true)
        XCTAssertTrue(dropped.dropped)
        XCTAssertEqual(dropped.rescanRoots, ["/var/folders/ab/T/root"])
        XCTAssertTrue(dropped.historyDone)
        XCTAssertTrue(dropped.isReplay)
        XCTAssertTrue(dropped.events.isEmpty, "the history-done path is not an event")

        let wrapped = FileEventStream.makeBatch([("/", UInt32(kFSEventStreamEventFlagEventIdsWrapped), 1)],
                                                roots: roots, replaying: false)
        XCTAssertEqual(wrapped.rescanRoots, ["/var/folders/ab/T/root"])
    }

    func testCollapseAndReplayRules() {
        XCTAssertEqual(FileEventStream.collapse(["/a/b", "/a", "/ab", "/a/", "/c/d/e", "/c/d"]), ["/a", "/ab", "/c/d"])
        XCTAssertEqual(FileEventStream.collapse(["/", "/x"]), ["/"])
        XCTAssertEqual(FileEventStream.collapse(["/a/b", "/a/b.old", "/a/b/c"]), ["/a/b", "/a/b.old"],
                       "a root inside an earlier kept one is left out, not only inside the last one")
        let cursor = FileEventCursor(eventId: 100, deviceUUIDs: ["B", "A"], savedAt: Date())
        XCTAssertTrue(FileEventStream.canReplay(cursor, deviceUUIDs: ["A", "B"], currentId: 200))
        XCTAssertFalse(FileEventStream.canReplay(cursor, deviceUUIDs: ["A"], currentId: 200), "another volume set")
        XCTAssertFalse(FileEventStream.canReplay(cursor, deviceUUIDs: ["A", "B"], currentId: 50), "an id from the future")
        XCTAssertFalse(FileEventStream.canReplay(cursor, deviceUUIDs: [], currentId: 200), "no history on the volume")
    }

    func testTheCursorFileStoreRoundTrips() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("cursors-\(UUID())")
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = FileEventCursorFileStore(directory: folder)
        XCTAssertNil(store.loadCursor(forKey: "disk/radar"))
        let cursor = FileEventCursor(eventId: 42, deviceUUIDs: ["U"], savedAt: Date(timeIntervalSince1970: 1))
        store.saveCursor(cursor, forKey: "disk/radar")
        XCTAssertEqual(store.loadCursor(forKey: "disk/radar"), cursor)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appendingPathComponent("disk_radar.json").path))
    }
}
