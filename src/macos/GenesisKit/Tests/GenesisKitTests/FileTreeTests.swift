import XCTest
@testable import GenesisKit

/// The shared file tree: folders first in Finder's order, a flat row list where an open folder's children
/// sit under it, listings off the main thread, and Finder's rename, duplicate and trash rules.
@MainActor
final class FileTreeTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("filetree-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("beta/inner"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("Alpha"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("note 10.md"))
        try Data("x".utf8).write(to: root.appendingPathComponent("note 2.md"))
        try Data("x".utf8).write(to: root.appendingPathComponent(".hidden"))
        try Data("x".utf8).write(to: root.appendingPathComponent("beta/inner/deep.md"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func settle(_ model: FileTreeModel, until done: @escaping () -> Bool) async {
        for _ in 0..<200 where !done() {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testListingPutsFoldersFirstInFinderOrderAndSkipsHiddenFiles() {
        let names = FileTreeListing.entries(of: root.path).map(\.name)
        XCTAssertEqual(names, ["Alpha", "beta", "note 2.md", "note 10.md"])
    }

    func testRevealOpensTheChainAndRowsAreFlatWithDepth() async {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        model.reveal(root.appendingPathComponent("beta/inner/deep.md"))
        await settle(model) { model.rows.contains { $0.name == "deep.md" } }

        XCTAssertEqual(model.rows.map(\.name), ["Alpha", "beta", "inner", "deep.md", "note 2.md", "note 10.md"])
        XCTAssertEqual(model.rows.map(\.depth), [0, 0, 1, 2, 0, 0])

        model.toggle(root.appendingPathComponent("beta").standardizedFileURL.path)
        XCTAssertEqual(model.rows.map(\.name), ["Alpha", "beta", "note 2.md", "note 10.md"], "closing a folder hides its subtree at once")
    }

    func testReRootingReadsAnOpenFolderWhoseReadItDropped() async {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        await settle(model) { model.rows.contains { $0.name == "beta" } }

        // Both reads start, then the new root drops them before they land.
        model.reveal(root.appendingPathComponent("beta/inner/deep.md"))
        model.setRoot(root.appendingPathComponent("beta"))
        await settle(model) { model.rows.contains { $0.name == "deep.md" } }

        XCTAssertEqual(model.rows.map(\.name), ["inner", "deep.md"])
    }

    func testRefreshDuringAPendingReadReadsTheFolderAgain() async throws {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        // The read starts, lists off the main actor while the main actor sleeps, and cannot publish yet:
        // its listing has the old name.
        await Task.yield()
        Thread.sleep(forTimeInterval: 0.2)
        _ = try FileOperations.rename(root.appendingPathComponent("note 2.md"), to: "renamed.md")
        model.refresh(root.standardizedFileURL.path)
        await settle(model) { model.rows.contains { $0.name == "renamed.md" } }

        XCTAssertEqual(model.rows.map(\.name), ["Alpha", "beta", "note 10.md", "renamed.md"])
    }

    func testDuplicateFollowsFinderNamingAndRenameRefusesBadNames() throws {
        let note = root.appendingPathComponent("note 2.md")
        let first = try FileOperations.duplicate(note)
        let second = try FileOperations.duplicate(note)
        XCTAssertEqual(first.lastPathComponent, "note 2 copy.md")
        XCTAssertEqual(second.lastPathComponent, "note 2 copy 2.md")

        XCTAssertNotNil(FileOperations.problem(renaming: note, to: "a/b.md"))
        XCTAssertNotNil(FileOperations.problem(renaming: note, to: "  "))
        XCTAssertNotNil(FileOperations.problem(renaming: note, to: "note 10.md"), "an existing name is refused")
        XCTAssertNil(FileOperations.problem(renaming: note, to: "renamed.md"))
        XCTAssertNil(FileOperations.problem(renaming: note, to: "Note 2.md"), "a case-only rename names the same file")
        let renamed = try FileOperations.rename(note, to: "renamed.md")
        XCTAssertTrue(FileManager.default.fileExists(atPath: renamed.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: note.path))
    }
}
