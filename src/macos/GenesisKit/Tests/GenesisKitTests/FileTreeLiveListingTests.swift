import XCTest
@testable import GenesisKit

/// The tree lists what is on disk now, not what was there when a folder was first read. Another app (an agent
/// session saving notes) writes into folders the tree already read; on 2026-10-15 "Show in Sidebar" on such a note
/// did nothing, because its folder's listing predated the note.
@MainActor
final class FileTreeLiveListingTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("filetree-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root.appendingPathComponent("Návrhy"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("Návrhy/old.md"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func settle(until done: @escaping () -> Bool, seconds: Double = 2) async {
        let deadline = Date().addingTimeInterval(seconds)
        while !done(), Date() < deadline {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    /// A tree whose "Návrhy" folder is open and read.
    private func openTree() async -> FileTreeModel {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        model.reveal(root.appendingPathComponent("Návrhy/old.md"))
        await settle { model.rows.contains { $0.name == "old.md" } }
        XCTAssertTrue(model.rows.contains { $0.name == "old.md" })
        return model
    }

    func testShowInSidebarFindsANoteWrittenAfterItsFolderWasRead() async throws {
        let model = await openTree()
        let note = root.appendingPathComponent("Návrhy/2026-10-15-Proposals.sol3.md")
        try Data("# sol3".utf8).write(to: note)

        model.reveal(note)
        await settle { model.rows.contains { $0.name == note.lastPathComponent } }
        XCTAssertTrue(model.rows.contains { $0.name == note.lastPathComponent }, "the reveal reads the folder again")
        XCTAssertFalse(model.rows.contains { $0.loading }, "a quiet read shows no spinner")
    }

    func testAFolderAnotherAppWritesIntoListsTheNewNoteByItself() async throws {
        let model = await openTree()
        // FSEvents reports from the moment the stream starts; give it that moment.
        try? await Task.sleep(for: .milliseconds(300))
        try Data("# new".utf8).write(to: root.appendingPathComponent("Návrhy/new.md"))
        await settle(until: { model.rows.contains { $0.name == "new.md" } }, seconds: 5)
        XCTAssertTrue(model.rows.contains { $0.name == "new.md" })

        try FileManager.default.removeItem(at: root.appendingPathComponent("Návrhy/old.md"))
        await settle(until: { !model.rows.contains { $0.name == "old.md" } }, seconds: 5)
        XCTAssertFalse(model.rows.contains { $0.name == "old.md" }, "a deleted note leaves the tree too")
    }

    func testANoteSavedInPlaceChangesNoRows() async throws {
        let model = await openTree()
        try? await Task.sleep(for: .milliseconds(300))
        var changes = 0
        let watch = model.$rows.dropFirst().sink { _ in changes += 1 }
        defer { watch.cancel() }
        try Data("edited".utf8).write(to: root.appendingPathComponent("Návrhy/old.md"))
        try? await Task.sleep(for: .milliseconds(1500))
        XCTAssertEqual(changes, 0, "an edit inside a note is not a listing change")
    }
}
