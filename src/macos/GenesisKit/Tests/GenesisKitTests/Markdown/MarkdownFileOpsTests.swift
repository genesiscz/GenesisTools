import XCTest
@testable import GenesisKit

/// What the open tabs do when a file verb (GenesisKit `FileItemMenu`) renames or trashes their file:
/// a real folder on disk, the model's own reconciliation, no Finder menu.
@MainActor
final class MarkdownFileOpsTests: XCTestCase {
    private var root: URL!
    private var model: MarkdownDocumentsModel!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("md-fileops-\(UUID().uuidString)")
            .standardizedFileURL
        try FileManager.default.createDirectory(at: root.appendingPathComponent("notes/sub"), withIntermediateDirectories: true)
        for path in ["readme.md", "notes/a.md", "notes/sub/deep.md"] {
            try "# \(path)".write(to: root.appendingPathComponent(path), atomically: true, encoding: .utf8)
        }
        model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-fileops-\(UUID().uuidString)")!)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func url(_ path: String) -> URL { root.appendingPathComponent(path).standardizedFileURL }

    func testAnUnsavedTabBlocksItsFileAndEveryFolderAboveIt() {
        model.open([url("notes/sub/deep.md"), url("readme.md")])
        model.docs.first { $0.url == url("notes/sub/deep.md") }?.edit("changed")

        XCTAssertNotNil(model.unsavedReason(url("notes")))
        XCTAssertNotNil(model.unsavedReason(url("notes/sub/deep.md")))
        XCTAssertNil(model.unsavedReason(url("readme.md")))
        XCTAssertNil(model.unsavedReason(url("notes/a.md")))
    }

    func testAFolderRenameMovesEveryTabUnderItAndKeepsAnUnrelatedSelection() throws {
        model.open([url("notes/a.md"), url("notes/sub/deep.md"), url("readme.md")])
        try FileManager.default.moveItem(at: url("notes"), to: url("renamed"))

        model.applyFileChange(.renamed(from: url("notes"), to: url("renamed")))

        XCTAssertEqual(Set(model.docs.map(\.url)), [url("renamed/a.md"), url("renamed/sub/deep.md"), url("readme.md")])
        XCTAssertEqual(model.selected?.url, url("readme.md"), "a selection outside the folder stays")
        XCTAssertTrue(model.recentlyClosed.isEmpty, "an old path is not a tab to reopen")
    }

    func testARenamedSelectedFileStaysSelectedAtItsNewPath() throws {
        model.open([url("readme.md"), url("notes/a.md")])
        try FileManager.default.moveItem(at: url("notes/a.md"), to: url("notes/b.md"))

        model.applyFileChange(.renamed(from: url("notes/a.md"), to: url("notes/b.md")))

        XCTAssertEqual(model.selected?.url, url("notes/b.md"))
        XCTAssertTrue(model.recentlyClosed.isEmpty)
    }

    func testATrashClosesOnlyTheTabsUnderItAndLeavesNothingToReopen() {
        model.open([url("notes/a.md"), url("notes/sub/deep.md"), url("readme.md")])

        model.applyFileChange(.trashed(url("notes/sub")))

        XCTAssertEqual(Set(model.docs.map(\.url)), [url("notes/a.md"), url("readme.md")])
        XCTAssertTrue(model.recentlyClosed.isEmpty)

        model.close(model.docs.first { $0.url == url("readme.md") }!)
        XCTAssertEqual(model.recentlyClosed, [url("readme.md")], "a tab the reader closes is still remembered")
    }

    func testSourceFilesOpenAsTabs() {
        XCTAssertTrue(FileTree.isReadable(URL(fileURLWithPath: "/x/Report.ts")))
        XCTAssertTrue(FileTree.isReadable(URL(fileURLWithPath: "/x/App.swift")))
        XCTAssertFalse(FileTree.isReadable(URL(fileURLWithPath: "/x/photo.png")))
    }
}
