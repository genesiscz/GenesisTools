import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The title bar's breadcrumb (Views/MarkdownPathBar.swift): its steps and how a long path folds.
final class MarkdownPathBarTests: XCTestCase {
    func testAPathUnderHomeStartsAtTildeAndEndsAtTheFile() {
        let segments = MarkdownPathBarLayout.segments(for: URL(fileURLWithPath: "/Users/alice/notes/daily/plan.md"), home: "/Users/alice")
        XCTAssertEqual(segments.map(\.title), ["~", "notes", "daily", "plan.md"])
        XCTAssertEqual(segments.map(\.url.path), ["/Users/alice", "/Users/alice/notes", "/Users/alice/notes/daily", "/Users/alice/notes/daily/plan.md"])
        XCTAssertEqual(segments.map(\.isFile), [false, false, false, true])
    }

    func testAPathOutsideHomeStartsAtTheDiskRoot() {
        let segments = MarkdownPathBarLayout.segments(for: URL(fileURLWithPath: "/Volumes/data/x.md"), home: "/Users/alice")
        XCTAssertEqual(segments.map(\.title), ["/", "Volumes", "data", "x.md"])
        XCTAssertEqual(segments.first?.url.path, "/")
        // A sibling of the home folder is not under it.
        XCTAssertEqual(MarkdownPathBarLayout.segments(for: URL(fileURLWithPath: "/Users/alicex/a.md"), home: "/Users/alice").first?.title, "/")
    }

    /// Widest first; the folders after `~` fold first, the file's own folder last, the file never.
    func testALongPathFoldsItsFirstFoldersFirstAndKeepsTheFile() {
        let segments = MarkdownPathBarLayout.segments(for: URL(fileURLWithPath: "/Users/alice/a/b/c/plan.md"), home: "/Users/alice")
        let candidates = MarkdownPathBarLayout.candidates(segments)
        XCTAssertEqual(candidates.map(MarkdownPathItem.outline), [
            ["~", "a", "b", "c", "plan.md"],
            ["~", "…", "b", "c", "plan.md"],
            ["~", "…", "c", "plan.md"],
            ["~", "…", "plan.md"],
            ["…", "plan.md"],
        ])
        guard case .collapsed(let hidden) = candidates[2][1] else { return XCTFail("no fold") }
        XCTAssertEqual(hidden.map(\.title), ["a", "b"], "the fold lists the folders it hides, in order")
        guard case .collapsed(let all) = candidates[4][0] else { return XCTFail("no fold") }
        XCTAssertEqual(all.map(\.title), ["~", "a", "b", "c"])
    }

    func testAShortPathHasNothingToFoldButTheLastResort() {
        let segments = MarkdownPathBarLayout.segments(for: URL(fileURLWithPath: "/Users/alice/plan.md"), home: "/Users/alice")
        XCTAssertEqual(MarkdownPathBarLayout.candidates(segments).map(MarkdownPathItem.outline), [["~", "plan.md"], ["…", "plan.md"]])
    }
}

/// "Show in Sidebar": the row in the tree, or a new root when it is outside or too deep.
final class MarkdownSidebarRevealTests: XCTestCase {
    private let root = URL(fileURLWithPath: "/Users/alice/vault", isDirectory: true)

    private func url(_ path: String) -> URL { root.appendingPathComponent(path) }

    func testDepthCountsTheFoldersBetweenTheRootAndTheRow() {
        XCTAssertEqual(MarkdownSidebarReveal.depth(of: url("a.md"), under: root), 0)
        XCTAssertEqual(MarkdownSidebarReveal.depth(of: url("a/b/c/d/x.md"), under: root), 4)
        XCTAssertNil(MarkdownSidebarReveal.depth(of: root, under: root))
        XCTAssertNil(MarkdownSidebarReveal.depth(of: URL(fileURLWithPath: "/Users/alice/vaultx/a.md"), under: root))
    }

    func testARowUpToFourFoldersDownStaysInTheTreeAndDeeperReRoots() {
        XCTAssertEqual(MarkdownSidebarReveal.plan(url("a.md"), isFolder: false, root: root), .row(depth: 0))
        XCTAssertEqual(MarkdownSidebarReveal.plan(url("a/b/c/d/x.md"), isFolder: false, root: root), .row(depth: 4))
        XCTAssertEqual(MarkdownSidebarReveal.plan(url("a/b/c/d/e/x.md"), isFolder: false, root: root), .reRoot(url("a/b/c/d/e").path))
        XCTAssertEqual(MarkdownSidebarReveal.plan(url("a/b/c/d/e"), isFolder: true, root: root), .row(depth: 4))
        XCTAssertEqual(MarkdownSidebarReveal.plan(url("a/b/c/d/e/f"), isFolder: true, root: root), .reRoot(url("a/b/c/d/e/f").path))
    }

    func testOutsideTheRootReRootsAndTheRootItselfOnlyPulses() {
        let outside = URL(fileURLWithPath: "/Users/alice/other/x.md")
        XCTAssertEqual(MarkdownSidebarReveal.plan(outside, isFolder: false, root: root), .reRoot("/Users/alice/other"))
        XCTAssertEqual(MarkdownSidebarReveal.plan(root, isFolder: true, root: root), .root)
    }

    func testNewItemsGoToTheRevealedFolderElseTheOpenNotesFolderElseTheRoot() {
        let revealed = url("projects")
        XCTAssertEqual(MarkdownSidebarReveal.newItemFolder(revealedFolder: revealed, selectedFile: url("a/x.md"), root: root).path, revealed.path)
        XCTAssertEqual(MarkdownSidebarReveal.newItemFolder(revealedFolder: nil, selectedFile: url("a/x.md"), root: root).path, url("a").path)
        let elsewhere = URL(fileURLWithPath: "/Users/alice/other/x.md")
        XCTAssertEqual(MarkdownSidebarReveal.newItemFolder(revealedFolder: nil, selectedFile: elsewhere, root: root).path, root.path)
    }

    func testTheTreeFontGrowsAPointPerSixtyPointsOfWidthUpToFour() {
        let standard = MarkdownSidebarWidth.standard
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: standard, scales: true), 13)
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: standard + 30, scales: true), 13.5)
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: standard + 60, scales: true), 14)
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: MarkdownSidebarWidth.maximum, scales: true), 17)
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: MarkdownSidebarWidth.minimum, scales: true), 13, "never below the base")
        XCTAssertEqual(MarkdownTreeFont.size(base: 13, width: MarkdownSidebarWidth.maximum, scales: false), 13)
    }
}

/// The model's side of the path verbs, on a real folder: reveal, navigate, search in a folder, create.
@MainActor
final class MarkdownPathVerbsTests: XCTestCase {
    private var root: URL!
    private var model: MarkdownDocumentsModel!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory
            .appendingPathComponent("md-paths-\(UUID().uuidString)")
            .standardizedFileURL
        try FileManager.default.createDirectory(at: root.appendingPathComponent("a/b/c/d/e"), withIntermediateDirectories: true)
        for path in ["readme.md", "a/plan.md", "a/b/c/d/e/deep.md"] {
            try "# \(path)".write(to: root.appendingPathComponent(path), atomically: true, encoding: .utf8)
        }
        model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-paths-\(UUID().uuidString)")!)
        model.filesRoot = root.path
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func url(_ path: String) -> URL { root.appendingPathComponent(path).standardizedFileURL }

    func testShowInSidebarPulsesARowInTheTreeAndReRootsForADeepOne() {
        let token = model.revealToken
        model.revealInSidebar(url("a/plan.md"))
        XCTAssertTrue(model.showFiles)
        XCTAssertEqual(model.filesRoot, root.path, "a shallow row keeps the root")
        XCTAssertEqual(model.revealPulse?.target, .row(url("a/plan.md").path))
        XCTAssertEqual(model.revealToken, token + 1)

        model.revealInSidebar(url("a/b/c/d/e/deep.md"))
        XCTAssertEqual(model.filesRoot, url("a/b/c/d/e").path, "five folders down: the tree goes to the folder")
        XCTAssertEqual(model.revealPulse?.target, .header)
        XCTAssertEqual(model.revealTarget?.path, url("a/b/c/d/e/deep.md").path)
    }

    func testNavigateInSidebarReRootsAtTheFolderOrTheFilesFolder() {
        model.navigateInSidebar(url("a/b"))
        XCTAssertEqual(model.filesRoot, url("a/b").path)
        XCTAssertEqual(model.revealPulse?.target, .header)
        model.navigateInSidebar(url("readme.md"))
        XCTAssertEqual(model.filesRoot, root.path)
    }

    func testSearchInFolderOpensTheSidebarSearchWithTheFolderAsItsScope() {
        let token = model.treeSearchToken
        model.searchInFolder(url("a"))
        XCTAssertTrue(model.showFiles)
        XCTAssertEqual(model.treeSearchToken, token + 1)
        XCTAssertEqual(model.treeSearchScope?.path, url("a").path)
    }

    func testANewFileOpensAsATabAndIsRevealedAndANewFolderOnlyRevealed() throws {
        model.filesRoot = ""
        model.open([url("readme.md")])
        let note = try FileOperations.create(.file, named: "Untitled.md", in: url("a"))
        model.didCreate(note)
        XCTAssertEqual(model.selected?.url.path, note.path, "the new file is the open tab")
        XCTAssertEqual(model.filesRoot, root.path, "the tree that followed the old tab is pinned, not moved")
        XCTAssertEqual(model.revealTarget?.path, note.path)

        let tabs = model.docs.count
        let folder = try FileOperations.create(.folder, named: "drafts", in: root)
        model.didCreate(folder)
        XCTAssertEqual(model.docs.count, tabs, "a folder is no tab")
        XCTAssertEqual(model.revealPulse?.target, .row(folder.path))
    }

    func testTheWindowsMenusCarryItsOwnVerbs() {
        let folderMenu = PathMenuEntry.outline(model.pathMenu(for: url("a"), kind: .folder))
        for title in ["Show in Sidebar", "Navigate in Sidebar", "Search in Folder…", "New File…", "New Folder…", "Open in Finder", "Open in Cursor", "Copy Path"] {
            XCTAssertTrue(folderMenu.contains(title), "\(title) in \(folderMenu)")
        }
        let fileMenu = PathMenuEntry.outline(model.pathMenu(for: url("a/plan.md"), kind: .file))
        for title in ["Show in Sidebar", "Show in Finder", "Rename…", "Duplicate", "Move to Trash"] {
            XCTAssertTrue(fileMenu.contains(title), "\(title) in \(fileMenu)")
        }
        XCTAssertFalse(fileMenu.contains("New File…"), "a file is no place to create one")
    }
}

/// "Search in Folder…": the sidebar's search limited to one folder.
@MainActor
final class FileTreeSearchScopeTests: XCTestCase {
    func testAScopeStaysWhenTheTreeReRootsAtOrAboveIt() {
        XCTAssertTrue(FileTreeSearch.keepsScope("/r/a", newRoot: "/r"))
        XCTAssertTrue(FileTreeSearch.keepsScope("/r/a", newRoot: "/r/a"))
        XCTAssertFalse(FileTreeSearch.keepsScope("/r", newRoot: "/r/a"))
        XCTAssertFalse(FileTreeSearch.keepsScope("/rx", newRoot: "/r"))
        XCTAssertTrue(FileTreeSearch.keepsScope("/r/a", newRoot: "/"))
    }

    func testAScopedSearchFindsOnlyInsideTheFolder() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("scope-\(UUID().uuidString)").standardizedFileURL
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("notes"), withIntermediateDirectories: true)
        try "x".write(to: dir.appendingPathComponent("plan.md"), atomically: true, encoding: .utf8)
        try "x".write(to: dir.appendingPathComponent("notes/plan.md"), atomically: true, encoding: .utf8)

        let model = FileTreeSearchModel()
        model.setRoot(dir)
        model.setScope(dir.appendingPathComponent("notes"))
        XCTAssertEqual(model.searchRoot, dir.appendingPathComponent("notes").path)
        model.query = "plan"
        model.run()
        for _ in 0..<100 where model.searching || model.hits.isEmpty {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(model.hits.map(\.relative), ["plan.md"])
        XCTAssertEqual(model.hits.first?.path, dir.appendingPathComponent("notes/plan.md").path)

        model.setRoot(dir.appendingPathComponent("notes/sub"))
        XCTAssertNil(model.scope, "a root inside the scope drops it")
    }
}

/// The breadcrumb sits in the title bar: its steps are controls, the chevrons between them and the
/// strip's right end stay the zone (drag, double-click zoom), and nothing reaches the traffic lights.
final class MarkdownPathBarTitlebarTests: XCTestCase {
    @MainActor
    func testTheBreadcrumbIsInTheStripAndTheEmptyStripStillZooms() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-crumb-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("notes"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let note = dir.appendingPathComponent("notes/plan.md")
        try "# Plan".write(to: note, atomically: true, encoding: .utf8)
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-crumb-\(UUID().uuidString)")!)
        model.open([note])

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 600),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "plan.md"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: MarkdownDocumentWindowController.root(model: model))
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        RunLoop.main.run(until: Date().addingTimeInterval(1.0))

        let audit = WindowTitlebar.audit(window, expectsRow: true)
        XCTAssertEqual(audit.problems, [], audit.line)
        let content = audit.runs.filter { $0.kind == .content }
        XCTAssertGreaterThanOrEqual(content.count, 4, "one control per step: \(audit.line)")
        guard content.count >= 2 else { return }
        // A chevron between two steps is a label: the strip is the zone across it, not just in the 1 pt
        // spacing on either side.
        let first = content[0]
        let second = content[1]
        let gap = audit.runs.first { $0.kind == .zone && $0.minX >= first.maxX && $0.maxX <= second.minX }
        XCTAssertGreaterThanOrEqual(gap.map { $0.maxX - $0.minX } ?? 0, 4, audit.line)
        // The strip's right end stays empty, to drag and to double-click.
        let edge = window.frame.width - 20
        let trailing = try XCTUnwrap(audit.runs.first { $0.minX <= edge && edge < $0.maxX }, audit.line)
        XCTAssertEqual(trailing.kind, .zone, audit.line)
        XCTAssertGreaterThanOrEqual(trailing.maxX - trailing.minX, MarkdownPathBar.trailingRoom, audit.line)
    }
}
