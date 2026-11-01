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

            var lines: [String] = []
            let end = Date().addingTimeInterval(5)
            while Date() < end, !lines.contains(where: { $0.contains("daily") }) {
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

    func testAFileTheViewerCannotShowIsAnInlineProblem() throws {
        try Data([0x89, 0x50]).write(to: root.appendingPathComponent("photo.png"))
        let model = MarkdownDocumentsModel()
        model.filesRoot = root.path
        XCTAssertEqual(model.goTo(root.path + "/photo.png"), "\u{201C}photo.png\u{201D} is not a file this viewer opens.")
        XCTAssertTrue(model.docs.isEmpty)
    }
}
