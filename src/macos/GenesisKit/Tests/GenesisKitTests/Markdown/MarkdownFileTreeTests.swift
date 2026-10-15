import SwiftUI
import XCTest
@testable import GenesisKit

/// The file sidebar: a real filesystem, listed one folder at a time, showing
/// every file rather than only the three types the vault indexes.
@MainActor
final class MarkdownFileTreeTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("md-filetree-\(UUID().uuidString)")
        let deep = root.appendingPathComponent("notes/sub")
        try FileManager.default.createDirectory(at: deep, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: root.appendingPathComponent("assets"), withIntermediateDirectories: true)
        for (path, body) in [
            ("readme.md", "# readme"),
            ("data.json", "{}"),
            ("photo.png", "not really"),
            ("notes/a.md", "# a"),
            ("notes/sub/deep.md", "# deep"),
        ] {
            try body.write(to: root.appendingPathComponent(path), atomically: true, encoding: .utf8)
        }
        try "x".write(to: root.appendingPathComponent(".hidden"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAFolderListsEverythingInIt_foldersFirstThenFilesAlphabetically() {
        let names = FileTree.children(of: root).map(\.name)
        XCTAssertEqual(names, ["assets", "notes", "data.json", "photo.png", "readme.md"])
    }

    func testEveryFileShowsUpNotOnlyMarkdown() {
        let kinds = Dictionary(
            uniqueKeysWithValues: FileTree.children(of: root).map { ($0.name, $0.kind) }
        )
        XCTAssertEqual(kinds["readme.md"], .markdown)
        XCTAssertEqual(kinds["data.json"], .file)
        XCTAssertEqual(kinds["photo.png"], .file)
        XCTAssertEqual(kinds["notes"], .folder)
    }

    func testHiddenFilesStayHiddenUnlessAsked() {
        XCTAssertFalse(FileTree.children(of: root).contains { $0.name == ".hidden" })
        XCTAssertTrue(FileTree.children(of: root, includeHidden: true).contains { $0.name == ".hidden" })
    }

    func testListingIsOneLevelDeep_soPointingItAtAHomeDirectoryIsCheap() {
        // Children are filled in when a folder is expanded, never up front:
        // walking a subtree eagerly is how you pin a filesystem's worth of
        // vnodes for a sidebar nobody opened.
        for node in FileTree.children(of: root) {
            XCTAssertTrue(node.children.isEmpty, "\(node.name) was walked eagerly")
        }
    }

    func testAnUnreadableFolderYieldsNothingRatherThanFailingTheWindow() {
        XCTAssertEqual(FileTree.children(of: root.appendingPathComponent("nope")), [])
    }

    func testRevealingADocumentExpandsOnlyItsOwnAncestors() {
        let file = root.appendingPathComponent("notes/sub/deep.md")
        let path = FileTree.expansionPath(to: file, from: root)
        XCTAssertEqual(
            path,
            [root.path, root.appendingPathComponent("notes").path, root.appendingPathComponent("notes/sub").path]
        )
        XCTAssertFalse(path.contains(root.appendingPathComponent("assets").path))
    }

    func testAFileOutsideTheRootRevealsNothing() {
        XCTAssertEqual(FileTree.expansionPath(to: URL(fileURLWithPath: "/tmp/elsewhere.md"), from: root), [])
    }

    func testTheSidebarStartsInTheOpenDocumentsFolderAndWalksUp() {
        let defaults = UserDefaults(suiteName: "md-files-\(UUID().uuidString)")!
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.open([root.appendingPathComponent("notes/a.md")])
        XCTAssertEqual(model.filesRootURL.path, root.appendingPathComponent("notes").path)

        model.filesRootUp()
        XCTAssertEqual(model.filesRootURL.path, root.path)
        // Pinned now, so switching tabs does not move it back.
        XCTAssertEqual(model.filesRoot, root.path)
    }
}

/// The two sidebar toggles and the panes they open.
@MainActor
final class MarkdownSidebarToggleTests: XCTestCase {
    private func model() -> MarkdownDocumentsModel {
        MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-sidebar-\(UUID().uuidString)")!)
    }

    func testBothSidebarsToggleIndependentlyAndSurviveARelaunch() {
        let defaults = UserDefaults(suiteName: "md-sidebar-\(UUID().uuidString)")!
        let m = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertFalse(m.showFiles, "a fresh window opens with no file sidebar")

        m.showFiles = true
        m.showOutline = false
        XCTAssertTrue(defaults.bool(forKey: "markdownWindow.files"))
        XCTAssertFalse(defaults.bool(forKey: "markdownWindow.outline"))

        m.showOutline = true
        XCTAssertTrue(m.showFiles, "opening the outline must not close the files pane")

        // A relaunch reads them back from the same suite, not from the
        // process-wide standard one.
        let reopened = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertTrue(reopened.showFiles)
        XCTAssertTrue(reopened.showOutline)
    }

    func testAPinnedRootSurvivesSwitchingTabsButAnUnsetOneFollowsTheDocument() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-root-\(UUID().uuidString)")
        let other = dir.appendingPathComponent("other")
        try FileManager.default.createDirectory(at: other, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "# a".write(to: dir.appendingPathComponent("a.md"), atomically: true, encoding: .utf8)
        try "# b".write(to: other.appendingPathComponent("b.md"), atomically: true, encoding: .utf8)

        let m = model()
        m.open([dir.appendingPathComponent("a.md"), other.appendingPathComponent("b.md")])
        XCTAssertEqual(m.filesRootURL.path, other.path, "follows the selected document")

        m.filesRoot = dir.path
        m.select(dir.appendingPathComponent("a.md").path)
        XCTAssertEqual(m.filesRootURL.path, dir.path, "a pinned root stays put")
    }

    func testAPinnedRootThatIsGoneFallsBackToTheDocument() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-root-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        try "# a".write(to: dir.appendingPathComponent("a.md"), atomically: true, encoding: .utf8)

        let m = model()
        m.open([dir.appendingPathComponent("a.md")])
        m.filesRoot = "/nope/not/here"
        XCTAssertEqual(m.filesRootURL.path, dir.path)
    }
}
