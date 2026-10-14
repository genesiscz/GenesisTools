import Foundation
import SnapshotSupport
import XCTest

/// Each recorder must run from a file of its own: replayd ends every stream of the processes started
/// from one executable path when any of them exits, and a hard link to the shared binary left
/// `stopCapture` hanging. These tests pin what the recorder relies on without a screen recording.
final class RecorderExecutableTests: XCTestCase {
    private var root: URL!
    private var source: URL!

    override func setUpWithError() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-executable-\(UUID().uuidString)")
        root = base.appendingPathComponent("recorders")
        source = base.appendingPathComponent("ax-tool")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        try Data("binary".utf8).write(to: source)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: source.path)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: source.deletingLastPathComponent())
    }

    private func inode(_ url: URL) throws -> Int {
        try XCTUnwrap(FileManager.default.attributesOfItem(atPath: url.path)[.systemFileNumber] as? Int)
    }

    func testEveryRecorderGetsItsOwnFileAtItsOwnPath() throws {
        let first = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4001, isRunning: { _ in true })
        let second = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4002, isRunning: { _ in true })

        XCTAssertNotEqual(first.path, source.path, "a recorder at the shared path dies when any ax-tool there exits")
        XCTAssertNotEqual(first.path, second.path, "two recorders at one path end each other")
        XCTAssertNotEqual(try inode(first), try inode(source), "a hard link to the shared binary hangs stopCapture")
        XCTAssertNotEqual(try inode(first), try inode(second))
        XCTAssertEqual(try Data(contentsOf: first), try Data(contentsOf: source))
        XCTAssertTrue(FileManager.default.isExecutableFile(atPath: first.path))
        XCTAssertEqual(first.lastPathComponent, "ax-tool")
    }

    func testCopiesOfDeadRecordersAreSweptAndLiveOnesKept() throws {
        let dead = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4001, isRunning: { _ in true })
        let live = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4002, isRunning: { _ in true })
        let unrelated = root.appendingPathComponent("notes")
        try FileManager.default.createDirectory(at: unrelated, withIntermediateDirectories: true)

        _ = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4003, isRunning: { $0 == 4002 })

        XCTAssertFalse(FileManager.default.fileExists(atPath: dead.path), "a recorder killed before its cleanup leaves its copy")
        XCTAssertTrue(FileManager.default.fileExists(atPath: live.path), "a running recorder keeps the file it executes")
        XCTAssertTrue(FileManager.default.fileExists(atPath: unrelated.path), "a name that is not a pid is not the recorder's")
    }

    func testRemoveCopyDeletesOnlyTheOwnersDirectory() throws {
        let mine = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4001, isRunning: { _ in true })
        let other = try RecorderExecutable.makePrivateCopy(of: source, root: root, pid: 4002, isRunning: { _ in true })

        RecorderExecutable.removeCopy(other, root: root, pid: 4001)
        XCTAssertTrue(FileManager.default.fileExists(atPath: other.path), "a recorder never removes another recorder's copy")
        RecorderExecutable.removeCopy(source, root: root, pid: 4001)
        XCTAssertTrue(FileManager.default.fileExists(atPath: source.path), "the shared binary is never removed")

        RecorderExecutable.removeCopy(mine, root: root, pid: 4001)
        XCTAssertFalse(FileManager.default.fileExists(atPath: mine.deletingLastPathComponent().path))
    }

    func testStaleEntriesNeedAPidThatNoLongerRuns() {
        XCTAssertEqual(RecorderExecutable.staleEntries(["12", "13", "x", "0", "-4", ".DS_Store"], isRunning: { $0 == 13 }), ["12"])
        XCTAssertTrue(RecorderExecutable.processIsRunning(getpid()))
    }
}
