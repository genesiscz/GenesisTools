import AppKit
@testable import GenesisKit
import XCTest

/// The file sidebar's back and forward, and a picture opened as a tab.
final class MarkdownTreeHistoryTests: XCTestCase {
    /// "Show only notes" (on by default) keeps folders and notes; off, the tree lists pictures, JSON and code too.
    func testNotesOnlyKeepsFoldersAndNotes() {
        let rows = [
            FileTreeRow(id: "/vault/Design", name: "Design", isFolder: true, depth: 0),
            FileTreeRow(id: "/vault/Design/Plan.md", name: "Plan.md", isFolder: false, depth: 1),
            FileTreeRow(id: "/vault/Design/shot.png", name: "shot.png", isFolder: false, depth: 1),
            FileTreeRow(id: "/vault/Board.canvas", name: "Board.canvas", isFolder: false, depth: 0),
            FileTreeRow(id: "/vault/data.json", name: "data.json", isFolder: false, depth: 0),
            FileTreeRow(id: "/vault/Tasks.base", name: "Tasks.base", isFolder: false, depth: 0),
        ]
        XCTAssertEqual(MarkdownFileTreeView.noteRows(rows).map(\.name), ["Design", "Plan.md", "Board.canvas", "Tasks.base"])
        // A revealed or selected picture stays, so "Show in Sidebar" on its tab finds the row.
        XCTAssertEqual(MarkdownFileTreeView.noteRows(rows, keep: ["/vault/Design/shot.png"]).map(\.name),
                       ["Design", "Plan.md", "shot.png", "Board.canvas", "Tasks.base"])
        let memo = MarkdownNoteRowsMemo()
        XCTAssertEqual(memo.rows(rows, keep: []).count, 4)
        XCTAssertEqual(memo.rows(rows, keep: ["/vault/data.json"]).count, 5, "a new kept path is not served from the old answer")
    }

    private func place(_ root: String, _ open: Set<String> = [], _ y: Double = 0) -> MarkdownTreePlace {
        MarkdownTreePlace(root: root, expanded: open, scrollY: y)
    }

    /// Back and Forward preserve places, and a new navigation discards the forward branch.
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

    /// Sidebar history retains only its newest fifty places.
    func testTheHistoryKeepsItsNewestFiftyPlaces() {
        let history = MarkdownTreeHistory()
        for i in 0..<60 { history.record(place("/v/\(i)")) }
        XCTAssertEqual(history.back.count, MarkdownTreeHistory.limit)
        XCTAssertEqual(history.back.first, place("/v/10"))
    }

    /// Changing the root records its place and Back restores its expanded folders and offset.
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

    /// Restoring a place reads its saved folders and closes folders outside that snapshot.
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

    /// An existing picture is marked binary, while a nonexistent file is marked missing.
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

    /// A clean picture skips web readiness while a text preview still waits for its page.
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

    /// Drafts and revisions remain readable when the disk file becomes binary.
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
        model.rendererRaw = MarkdownRenderer.web.rawValue
        XCTAssertTrue(MarkdownPaneContent.waitsForPage(doc, model: model), "the draft still renders a web page")
        model.setMode(.split)
        XCTAssertTrue(MarkdownPaneContent.waitsForPage(doc, model: model), "split also renders the draft")
        model.setMode(.preview)

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

    /// Slash and folders directly under it omit the muted parent-name prefix.
    @MainActor
    func testARootUnderSlashShowsNoParentPrefix() {
        XCTAssertNil(MarkdownFileTreeView.parentFolderName(URL(fileURLWithPath: "/")))
        XCTAssertNil(MarkdownFileTreeView.parentFolderName(URL(fileURLWithPath: "/Users")))
        XCTAssertEqual(MarkdownFileTreeView.parentFolderName(URL(fileURLWithPath: "/Users/Martin")), "Users")
    }

    /// Picture requests decode through the cache and invalidate only for changed file or size buckets.
    @MainActor
    func testABinaryPictureLoadsAndItsRequestFollowsTheFileAndSize() async throws {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("md-picture-load-\(UUID().uuidString).png")
        defer { try? FileManager.default.removeItem(at: file) }
        let image = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: 2, pixelsHigh: 2, bitsPerSample: 8,
            samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
            bytesPerRow: 0, bitsPerPixel: 0
        )!
        try XCTUnwrap(image.representation(using: .png, properties: [:])).write(to: file)
        let date = Date(timeIntervalSince1970: 100)
        let request = MarkdownPaneContent.PictureRequest(url: file, modifiedAt: date, pixels: 400)
        guard case .ready(let thumbnail) = await request.load() else {
            return XCTFail("the binary pane loads through the async thumbnail cache")
        }
        XCTAssertEqual(thumbnail.sourceSize, CGSize(width: 2, height: 2))
        XCTAssertEqual(request, MarkdownPaneContent.PictureRequest(url: file, modifiedAt: date, pixels: 401),
                       "resizing inside one decode bucket does not restart the image task")
        XCTAssertNotEqual(request, MarkdownPaneContent.PictureRequest(url: file, modifiedAt: date.addingTimeInterval(1), pixels: 400))
        XCTAssertNotEqual(request, MarkdownPaneContent.PictureRequest(url: file, modifiedAt: date, pixels: 800))
        XCTAssertNotEqual(request, MarkdownPaneContent.PictureRequest(url: file.appendingPathExtension("other"), modifiedAt: date, pixels: 400))
    }

    /// Folder labels use slash for the filesystem root and names for ordinary folders.
    @MainActor
    func testTheRootFolderHasANameInMenusAndTooltips() {
        XCTAssertEqual(MarkdownFileTreeView.folderName(URL(fileURLWithPath: "/")), "/")
        XCTAssertEqual(MarkdownFileTreeView.folderName(URL(fileURLWithPath: "/notes")), "notes")
    }

    /// The view uses this scheduler for every delayed scroll phase; an obsolete callback must write and acknowledge nothing.
    func testANewerRestoreAndNavigationInvalidateQueuedScrollCallbacks() {
        let restore = MarkdownTreeRestore()
        var queued: [(delay: TimeInterval, action: () -> Void)] = []
        let scheduler: MarkdownTreeRestore.Scheduler = { delay, action in
            queued.append((delay, action))
        }
        var scroll = 0
        var forced = 0
        var completions = 0
        let first = restore.begin()
        restore.schedule(first, after: 1, using: scheduler) { forced += 1 }
        restore.schedule(first, using: scheduler) { scroll = 100 }
        restore.schedule(first, after: 0.25, using: scheduler) { completions += 1 }
        let second = restore.begin()
        restore.schedule(second, using: scheduler) { scroll = 200 }
        XCTAssertEqual(queued.map(\.delay), [1, 0, 0.25, 0])

        // Drain exactly the callbacks the view queued before the newer restore, including its forced fallback.
        for callback in queued.prefix(3) { callback.action() }
        XCTAssertEqual(forced, 0, "the obsolete forced retry cannot consume the newer pending offset")
        XCTAssertEqual(scroll, 0, "the obsolete next-turn placement cannot scroll")
        XCTAssertEqual(completions, 0, "the obsolete correction cannot acknowledge the newer place")
        queued[3].action()
        XCTAssertEqual(scroll, 200, "the current placement still runs")

        restore.schedule(second, after: 0.25, using: scheduler) { completions += 1 }
        queued[4].action()
        XCTAssertEqual(completions, 1, "the current correction still acknowledges its place")
        restore.schedule(second, after: 1, using: scheduler) { scroll = 300 }
        restore.cancel()
        queued[5].action()
        XCTAssertEqual(scroll, 200, "navigation or sidebar removal cancels an already queued write")
    }

    /// Dismantling the hosted sidebar releases its place callback and window model.
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
            model = nil
        }
        let released = Date().addingTimeInterval(2)
        while alive != nil, Date() < released {
            RunLoop.main.run(until: Date().addingTimeInterval(0.02))
        }
        XCTAssertNil(alive, "leaving the sidebar releases the window model")
    }

    private func pictureFile() throws -> URL {
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("md-picture-\(UUID().uuidString).png")
        try Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).write(to: file)
        return file
    }
}
