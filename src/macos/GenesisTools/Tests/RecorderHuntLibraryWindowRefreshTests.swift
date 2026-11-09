import XCTest
@testable import GenesisToolsRecorder

/// The Recordings window reads its list again when anything a card shows changes in any of its folders (a stop, a
/// rename, a meeting's recording), and a change during a read is read once more instead of dropped.
@MainActor
final class RecorderHuntLibraryWindowRefreshTests: XCTestCase {
    private var root: URL!

    override func setUp() async throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("library-refresh-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAListedFileInARecordingFolderOfAnyRootReloadsAndFramesDoNot() {
        let roots = ["/r/library", "/r/meetings"]
        let live = "/r/live"
        XCTAssertTrue(LibraryModel.reloads(path: "/r/meetings/standup/recording.json", roots: roots, live: live))
        XCTAssertTrue(LibraryModel.reloads(path: "/r/library/video-1", roots: roots, live: live))
        XCTAssertTrue(LibraryModel.reloads(path: "/r/library/video-1/screen.mp4", roots: roots, live: live))
        XCTAssertTrue(LibraryModel.reloads(path: "/r/live/movie-1.json", roots: roots, live: live))
        XCTAssertFalse(LibraryModel.reloads(path: "/r/meetings/standup/frames/0001.png", roots: roots, live: live))
        XCTAssertFalse(LibraryModel.reloads(path: "/r/meetings/standup/ocr.jsonl", roots: roots, live: live))
        XCTAssertFalse(LibraryModel.reloads(path: "/r/library/.trash-probe", roots: roots, live: live))
    }

    func testARenameInTheSecondFolderShowsWhileTheWindowStaysOpen() throws {
        let library = root.appendingPathComponent("library")
        let meetings = root.appendingPathComponent("meetings")
        let recording = meetings.appendingPathComponent("2026-11-09_10-00-standup")
        try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: recording, withIntermediateDirectories: true)
        try manifest("Before", in: recording)

        let model = LibraryModel()
        model.folders = [library, meetings]
        model.liveFolder = root.appendingPathComponent("live")
        model.load()
        waitUntil("the first read") { model.items.first?.title == "Before" }
        model.startWatching()
        defer { model.stopWatching() }
        // FSEvents starts reporting a moment after the stream starts.
        RunLoop.main.run(until: Date().addingTimeInterval(0.5))

        try manifest("After", in: recording)
        waitUntil("the rename") { model.items.first?.title == "After" }
    }

    func testAChangeDuringAReadIsReadOnceMore() throws {
        let library = root.appendingPathComponent("library")
        try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
        let model = LibraryModel()
        model.folders = [library]
        model.liveFolder = root.appendingPathComponent("live")
        model.load()
        let second = library.appendingPathComponent("video-2")
        try FileManager.default.createDirectory(at: second, withIntermediateDirectories: true)
        try manifest("Second", in: second)
        model.load()
        waitUntil("the second read") { model.items.contains { $0.title == "Second" } }
    }

    private func manifest(_ title: String, in folder: URL) throws {
        try Data(#"{"title":"\#(title)","startedAt":"2026-11-09T10:00:00.000Z","frames":[]}"#.utf8)
            .write(to: folder.appendingPathComponent("recording.json"), options: .atomic)
    }

    private func waitUntil(_ what: String, timeout: TimeInterval = 5, _ done: () -> Bool) {
        let deadline = Date().addingTimeInterval(timeout)
        while !done() && Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        }
        XCTAssertTrue(done(), "\(what) did not land within \(timeout) s")
    }
}
