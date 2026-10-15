import AppKit
@testable import GenesisKit
import XCTest

/// The file sidebar's back and forward, and a picture opened as a tab.
final class MarkdownTreeHistoryTests: XCTestCase {
    private func place(_ root: String, _ open: Set<String> = [], _ y: Double = 0) -> MarkdownTreePlace {
        MarkdownTreePlace(root: root, expanded: open, scrollY: y)
    }

    func testBackAndForwardWalkThePlacesAndANewPlaceClearsForward() {
        let history = MarkdownTreeHistory()
        history.record(place("/v/a", ["/v/a/x"], 120))
        history.record(place("/v/b"))
        let current = place("/v/c", [], 40)

        XCTAssertEqual(history.goBack(from: current), place("/v/b"))
        XCTAssertEqual(history.goBack(from: place("/v/b")), place("/v/a", ["/v/a/x"], 120))
        XCTAssertFalse(history.canGoBack)
        XCTAssertEqual(history.goForward(from: place("/v/a", ["/v/a/x"], 120)), place("/v/b"))
        XCTAssertTrue(history.canGoForward)

        history.record(place("/v/b"))
        XCTAssertFalse(history.canGoForward, "a new place clears forward")
    }

    func testTheHistoryKeepsItsNewestFiftyPlaces() {
        let history = MarkdownTreeHistory()
        for i in 0..<60 { history.record(place("/v/\(i)")) }
        XCTAssertEqual(history.back.count, MarkdownTreeHistory.limit)
        XCTAssertEqual(history.back.first, place("/v/10"))
    }

    @MainActor
    func testARootChangeRecordsThePlaceAndBackRestoresIt() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-history-\(UUID().uuidString)")!)
        var current = place("/v/a", ["/v/a/x"], 80)
        model.treePlace = { current }
        model.filesRoot = "/v/a"
        model.filesRoot = "/v/b"
        XCTAssertEqual(model.treeHistory.back.last?.root, "/v/a")

        current = place("/v/b", [], 0)
        model.treeBack()
        XCTAssertEqual(model.filesRoot, "/v/a")
        XCTAssertEqual(model.pendingTreePlace, place("/v/a", ["/v/a/x"], 80))
        XCTAssertEqual(model.treeHistory.forward.last?.root, "/v/b", "going back is not itself recorded")
    }

    @MainActor
    func testRestoringOpenFoldersOpensExactlyThoseAndClosesTheRest() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("md-restore-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        for folder in ["a/inner", "b"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        try "x".write(to: root.appendingPathComponent("a/inner/n.md"), atomically: true, encoding: .utf8)
        let tree = FileTreeModel(root: root)
        tree.watchesDisk = false
        tree.setRoot(root)
        let a = root.appendingPathComponent("a").standardizedFileURL.path
        let inner = root.appendingPathComponent("a/inner").standardizedFileURL.path
        let b = root.appendingPathComponent("b").standardizedFileURL.path
        tree.restoreExpanded([b])
        tree.restoreExpanded([a, inner])
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, !tree.rows.contains(where: { $0.name == "n.md" }) {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertEqual(tree.expandedFolders, [a, inner])
        XCTAssertTrue(tree.rows.contains { $0.name == "n.md" }, "rows: \(tree.rows.map(\.name))")
    }

    @MainActor
    func testAPictureIsNotGoneItIsBinary() throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("md-binary-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        try Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0xFF, 0xFE, 0x00, 0x80]).write(to: file)
        let doc = MarkdownDocument(url: file)
        XCTAssertFalse(doc.missing)
        XCTAssertTrue(doc.binary)
        let gone = MarkdownDocument(url: file.deletingLastPathComponent().appendingPathComponent("nope-\(UUID().uuidString).png"))
        XCTAssertTrue(gone.missing)
        XCTAssertFalse(gone.binary)
    }

    @MainActor
    func testABinaryPaneDoesNotWaitForAWebPage() throws {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-binary-wait-\(UUID().uuidString)")!)
        model.rendererRaw = MarkdownRenderer.web.rawValue
        model.setMode(.preview)
        let picture = try pictureFile()
        let binary = MarkdownDocument(url: picture)
        XCTAssertFalse(MarkdownPaneContent.waitsForPage(binary, model: model), "a picture has no page to wait for")
        let note = picture.deletingLastPathComponent().appendingPathComponent("note.md")
        try "hello".write(to: note, atomically: true, encoding: .utf8)
        let text = MarkdownDocument(url: note)
        XCTAssertTrue(MarkdownPaneContent.waitsForPage(text, model: model), "a note in the web preview still waits")
        model.setMode(.source)
        XCTAssertFalse(MarkdownPaneContent.waitsForPage(text, model: model))
    }

    @MainActor
    func testADirtyDraftAndARevisionStayAheadOfTheBinaryFallback() throws {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-binary-draft-\(UUID().uuidString)")!)
        model.setMode(.preview)
        let note = FileManager.default.temporaryDirectory.appendingPathComponent("md-draft-\(UUID().uuidString).md")
        defer { try? FileManager.default.removeItem(at: note) }
        try "hello".write(to: note, atomically: true, encoding: .utf8)
        let doc = MarkdownDocument(url: note)
        doc.edit("unsaved")
        try Data([0x89, 0x50, 0x4E, 0x47, 0x00]).write(to: note)
        doc.reload()
        XCTAssertTrue(doc.binary)
        XCTAssertTrue(doc.isDirty)
        XCTAssertFalse(MarkdownPaneContent.showsBinary(doc, model: model), "an unsaved draft stays on screen")

        let picture = MarkdownDocument(url: try pictureFile())
        XCTAssertTrue(MarkdownPaneContent.showsBinary(picture, model: model))
        model.setMode(.changes)
        XCTAssertFalse(MarkdownPaneContent.showsBinary(picture, model: model), "Changes stays reachable")
        model.setMode(.preview)
        model.revisionView = MarkdownRevision(
            docID: picture.id,
            commit: GitCommit(sha: "abc", short: "abc", subject: "Old", author: "Ada", date: .distantPast),
            text: "was text"
        )
        XCTAssertFalse(MarkdownPaneContent.showsBinary(picture, model: model), "a past revision stays reachable")
    }

    @MainActor
    func testARootUnderSlashShowsNoParentPrefix() {
        XCTAssertNil(MarkdownFileTreeView.parentFolderName(URL(fileURLWithPath: "/")))
        XCTAssertNil(MarkdownFileTreeView.parentFolderName(URL(fileURLWithPath: "/Users")))
        XCTAssertEqual(MarkdownFileTreeView.parentFolderName(URL(fileURLWithPath: "/Users/Martin")), "Users")
    }

    @MainActor
    func testTheSidebarDropsItsPlaceProviderWhenItLeaves() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("md-place-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        weak var alive: MarkdownDocumentsModel?
        autoreleasepool {
            var model: MarkdownDocumentsModel? = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-place-\(UUID().uuidString)")!)
            alive = model
            model?.filesRoot = root.path
            let (window, _) = HostedShot.host(MarkdownFileTreeView(model: model!), size: CGSize(width: 280, height: 360))
            let appeared = Date().addingTimeInterval(2)
            while model?.treePlace == nil, Date() < appeared {
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            XCTAssertNotNil(model?.treePlace, "the sidebar publishes its place")
            window.contentView = nil
            window.close()
            RunLoop.main.run(until: Date().addingTimeInterval(0.2))
            model = nil
        }
        XCTAssertNil(alive, "leaving the sidebar releases the window model")
    }

    private func pictureFile() throws -> URL {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("md-picture-\(UUID().uuidString).png")
        try Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).write(to: file)
        return file
    }
}
