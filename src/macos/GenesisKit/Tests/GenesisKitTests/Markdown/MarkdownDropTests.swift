import AppKit
import XCTest
@testable import GenesisKit

/// Dropping files from Finder onto the markdown window.
@MainActor
final class MarkdownDropTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-drop-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("folder"), withIntermediateDirectories: true)
        for name in ["a.md", "b.markdown", "notes.txt", "photo.png", "archive.zip"] {
            try "x".write(to: dir.appendingPathComponent(name), atomically: true, encoding: .utf8)
        }
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    func testReadableFilesBecomeTabsAndTheRestGoToTheirOwnApp() {
        let (tabs, external) = MarkdownDrop.split([
            dir.appendingPathComponent("a.md"),
            dir.appendingPathComponent("b.markdown"),
            dir.appendingPathComponent("notes.txt"),
            dir.appendingPathComponent("photo.png"),
            dir.appendingPathComponent("archive.zip"),
        ])
        XCTAssertEqual(tabs.map(\.lastPathComponent), ["a.md", "b.markdown", "notes.txt"])
        XCTAssertEqual(external.map(\.lastPathComponent), ["photo.png", "archive.zip"])
    }

    func testAFolderIsNeitherATabNorHandedToAnotherApp() {
        let folder = dir.appendingPathComponent("folder")
        let (tabs, external) = MarkdownDrop.split([folder])
        XCTAssertTrue(tabs.isEmpty)
        XCTAssertTrue(external.isEmpty)
        XCTAssertEqual(MarkdownDrop.firstFolder([folder])?.lastPathComponent, "folder")
    }

    func testAPathThatIsNotThereIsDroppedQuietly() {
        let (tabs, external) = MarkdownDrop.split([dir.appendingPathComponent("gone.md")])
        XCTAssertTrue(tabs.isEmpty)
        XCTAssertTrue(external.isEmpty)
    }

    func testDroppedNotesOpenAsTabsInOrderWithTheLastSelected() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-drop-\(UUID().uuidString)")!)
        model.acceptDrop([dir.appendingPathComponent("a.md"), dir.appendingPathComponent("notes.txt")])
        XCTAssertEqual(model.docs.map(\.url.lastPathComponent), ["a.md", "notes.txt"])
        XCTAssertEqual(model.selected?.url.lastPathComponent, "notes.txt")
    }

    func testDroppingAFolderPointsTheSidebarAtItAndOpensTheSidebar() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-drop-\(UUID().uuidString)")!)
        XCTAssertFalse(model.showFiles)
        model.acceptDrop([dir.appendingPathComponent("folder")])
        XCTAssertTrue(model.showFiles)
        XCTAssertEqual(model.filesRootURL.lastPathComponent, "folder")
    }

    func testTheSameFileDroppedTwiceStaysOneTab() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-drop-\(UUID().uuidString)")!)
        model.acceptDrop([dir.appendingPathComponent("a.md")])
        model.acceptDrop([dir.appendingPathComponent("a.md")])
        XCTAssertEqual(model.docs.count, 1)
    }

    func testAPasteboardWithoutFilesReadsAsNoDrop() {
        let board = NSPasteboard(name: .init("md-drop-test-\(UUID().uuidString)"))
        board.clearContents()
        board.setString("just text", forType: .string)
        XCTAssertEqual(MarkdownDrop.urls(from: board), [])
    }

    func testAPasteboardCarryingFilesReadsThemBack() {
        let board = NSPasteboard(name: .init("md-drop-test-\(UUID().uuidString)"))
        board.clearContents()
        board.writeObjects([dir.appendingPathComponent("a.md") as NSURL])
        XCTAssertEqual(MarkdownDrop.urls(from: board).map(\.lastPathComponent), ["a.md"])
    }
}
