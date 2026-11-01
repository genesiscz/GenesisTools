import SwiftUI
import XCTest
@testable import GenesisKit

/// "Go to Location…" (⇧⌘G) in the markdown window: what a typed path names and what Return does with it. The list
/// under the field is `MarkdownPathCompletionTests`.
@MainActor
final class MarkdownGoToTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("goto-\(UUID().uuidString)")
        for folder in ["notes/daily", "notes/drafts", "nothing"] {
            try FileManager.default.createDirectory(at: root.appendingPathComponent(folder), withIntermediateDirectories: true)
        }
        try "# Plan".write(to: root.appendingPathComponent("notes/plan.md"), atomically: true, encoding: .utf8)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    func testAPastedPathLosesItsQuotesAndATildeOrFileUrlIsExpanded() {
        let base = URL(fileURLWithPath: "/tmp")
        XCTAssertEqual(MarkdownGoTo.url(from: "'/tmp/a b.md'\n", base: base)?.path, "/tmp/a b.md")
        XCTAssertEqual(MarkdownGoTo.url(from: "~/x.md", base: base)?.path, NSHomeDirectory() + "/x.md")
        XCTAssertEqual(MarkdownGoTo.url(from: "file:///tmp/c.md", base: base)?.path, "/tmp/c.md")
        XCTAssertEqual(MarkdownGoTo.url(from: "notes/plan.md", base: base)?.path, "/tmp/notes/plan.md")
        XCTAssertNil(MarkdownGoTo.url(from: "   ", base: base))
    }

    func testAFolderRevealsInTheTreeAndAFileOpensWithoutMovingIt() {
        let model = MarkdownDocumentsModel()
        model.filesRoot = root.path
        XCTAssertNil(model.goTo(root.path + "/notes/daily"))
        XCTAssertEqual(model.revealTarget?.path, root.appendingPathComponent("notes/daily").standardizedFileURL.path)
        XCTAssertEqual(model.filesRoot, root.path, "a folder under the root does not re-root the tree")

        XCTAssertNil(model.goTo(root.path + "/notes/plan.md"))
        XCTAssertEqual(model.selected?.url.lastPathComponent, "plan.md")
        XCTAssertEqual(model.filesRoot, root.path, "opening a file keeps the tree where it is")

        XCTAssertNotNil(model.goTo(root.path + "/missing.md"))
    }

    func testThePreviewTabSettingOpensTheFileInThePreviewTab() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "md-goto-\(UUID().uuidString)"))
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.configuration = GenesisKitMarkdownConfiguration(defaults: defaults)
        model.filesRoot = root.path
        try "# Two".write(to: root.appendingPathComponent("notes/two.md"), atomically: true, encoding: .utf8)

        model.configuration.goToOpensAs = .previewTab
        XCTAssertNil(model.goTo(root.path + "/notes/plan.md"))
        XCTAssertNil(model.goTo(root.path + "/notes/two.md"))
        XCTAssertEqual(model.docs.map(\.url.lastPathComponent), ["two.md"], "the second preview takes the first one's place")

        model.configuration.goToOpensAs = .tab
        XCTAssertNil(model.goTo(root.path + "/notes/plan.md"))
        XCTAssertEqual(Set(model.docs.map(\.url.lastPathComponent)), ["two.md", "plan.md"])
    }

    /// The sheet as drawn, in a window that is never ordered front: the recent file under "Recent", then the folder's
    /// entries. `GENESIS_GOTO_SHOTS=<folder>` keeps the picture for a person to look at.
    func testTheSheetDrawsTheRecentFileAndThenTheFolderEntries() async throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "md-goto-sheet-\(UUID().uuidString)"))
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.configuration = GenesisKitMarkdownConfiguration(defaults: defaults)
        try "# Old".write(to: root.appendingPathComponent("old.md"), atomically: true, encoding: .utf8)
        try Data([0x89, 0x50]).write(to: root.appendingPathComponent("notes/photo.png"))
        model.open([root.appendingPathComponent("old.md")])
        // The open note: the sheet starts in its folder and leaves it out of the recent files.
        model.open([root.appendingPathComponent("notes/plan.md")])

        // The palette is the viewer's shared default: put back what the test process had.
        let palette = model.themeRaw
        defer { model.themeRaw = palette }

        for theme in [MarkdownTheme.genesis, .light] {
            model.themeRaw = theme.rawValue
            let host = NSHostingView(rootView: MarkdownGoToSheet(model: model))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 560, height: 460), styleMask: [.borderless],
                                  backing: .buffered, defer: false)
            // As the viewer's window does (MarkdownDocumentWindow), and a sheet takes its window's look.
            window.appearance = NSAppearance(named: model.theme.isDark ? .darkAqua : .aqua)
            window.contentView = host
            defer { window.contentView = nil }
            let shot = ProcessInfo.processInfo.environment["GENESIS_GOTO_SHOTS"]
                .map { $0 + "/markdown-goto-sheet-\(theme.rawValue).png" }

            // The list arrives one layout pass before the window grows to fit it, and that frame shows only the list
            // (the header and the buttons are outside it): wait for a frame with the header, a row and the buttons.
            func whole(_ lines: [String]) -> Bool {
                ["Go to Location", "daily", "Open"].allSatisfy { word in lines.contains { $0.contains(word) } }
            }
            var lines: [String] = []
            let end = Date().addingTimeInterval(5)
            while Date() < end, !whole(lines) {
                try await Task.sleep(for: .milliseconds(100))
                host.layoutSubtreeIfNeeded()
                lines = TreeDrawnText.lines(of: host, savingTo: shot)
            }
            XCTAssertTrue(lines.contains { $0.contains("Go to Location") }, "\(theme.rawValue): \(lines)")
            XCTAssertTrue(lines.contains { $0.contains("Recent") }, "\(theme.rawValue): \(lines)")
            XCTAssertTrue(lines.contains { $0.contains("old.md") }, "\(theme.rawValue): \(lines)")
            XCTAssertTrue(lines.contains { $0.contains("daily") }, "\(theme.rawValue): \(lines)")
            XCTAssertTrue(lines.contains { $0.contains("Open") }, "the buttons read in both looks: \(lines)")
            XCTAssertFalse(lines.contains { $0.contains("photo.png") }, "notes only: \(lines)")
        }
    }

    /// While the list of a newer text loads, the older list stays on screen but takes no key and no click: Up and
    /// Down wait for the new list and then move on it, and a click on the older list acts only on a row the new list
    /// also has, at its place there.
    func testWhileTheNextListLoadsKeysWaitAndAClickActsOnlyOnTheNewList() throws {
        let older = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root,
                                                   recents: [root.path + "/notes/plan.md"])
        let newer = MarkdownPathCompletion.suggest(root.path + "/notes/da", base: root)
        XCTAssertEqual(older.rows.map(\.name), ["plan.md", "daily", "drafts", "plan.md"])
        XCTAssertEqual(newer.rows.map(\.name), ["daily", "drafts"])

        var cursor = MarkdownGoToCursor()
        let none = cursor.arrived(older)
        XCTAssertNil(none)
        XCTAssertEqual(cursor.selection, 0, "the newest recent file")

        // The text changed: the older list is on screen, the newer one loads.
        cursor.reset()
        XCTAssertFalse(cursor.move(1, in: nil))
        XCTAssertFalse(cursor.move(1, in: nil))
        XCTAssertEqual(cursor.selection, 0, "the older list's selection does not move")
        XCTAssertFalse(cursor.moved, "so no place carries into the newer list")
        XCTAssertFalse(cursor.click(older.rows[0], in: nil), "a click on the older list does nothing")
        cursor.wait(for: .go(reveal: false))
        XCTAssertFalse(cursor.move(1, in: nil))

        let waiting = cursor.arrived(newer)
        XCTAssertEqual(waiting, MarkdownGoToCursor.Pending(steps: 2, key: .go(reveal: false)),
                       "two steps, then Return; the step after Return is dropped")
        XCTAssertEqual(cursor.selection, 0, "the newer list's automatic row")
        XCTAssertTrue(cursor.move(2, in: newer))
        XCTAssertEqual(cursor.pick(in: newer), .chosen(newer.rows[1]), "Return takes drafts, on the newer list")
        XCTAssertNil(cursor.pending)

        // A row view kept from the older list: found by its id on the newer list, or nothing.
        XCTAssertFalse(cursor.click(older.rows[0], in: newer), "the recent file is not on the newer list")
        XCTAssertEqual(cursor.selection, 1)
        XCTAssertTrue(cursor.click(older.rows[1], in: newer))
        XCTAssertEqual(cursor.selection, 0, "daily is the newer list's first row")
        XCTAssertEqual(cursor.tabRow(in: newer), newer.rows[0])
    }

    /// The settings window can turn "Recent files first" off while the sheet is open: the options the sheet reloads on
    /// change, and the list leaves the recent files out, so Return no longer opens one.
    func testTurningRecentFilesOffChangesTheOptionsAndTheListLeavesThemOut() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "md-goto-recents-\(UUID().uuidString)"))
        let configuration = GenesisKitMarkdownConfiguration(defaults: defaults)
        let on = MarkdownPathOptions(configuration)
        configuration.goToRecents = false
        let off = MarkdownPathOptions(configuration)
        XCTAssertNotEqual(on, off, "the sheet builds its list again when its options change")

        let recents = [root.path + "/notes/plan.md"]
        let shown = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root, recents: recents, options: on)
        XCTAssertEqual(shown.recents.map(\.name), ["plan.md"])
        XCTAssertEqual(shown.automaticIndex, 0)
        let left = MarkdownPathCompletion.suggest(root.path + "/notes/", base: root, recents: recents, options: off)
        XCTAssertTrue(left.recents.isEmpty)
        XCTAssertNil(left.automaticIndex, "Return shows the folder; it opens no recent file")
    }

    func testAFileTheViewerCannotShowIsAnInlineProblem() throws {
        try Data([0x89, 0x50]).write(to: root.appendingPathComponent("photo.png"))
        let model = MarkdownDocumentsModel()
        model.filesRoot = root.path
        XCTAssertEqual(model.goTo(root.path + "/photo.png"), "\u{201C}photo.png\u{201D} is not a file this viewer opens.")
        XCTAssertTrue(model.docs.isEmpty)
    }
}
