import XCTest
@testable import GenesisKit

/// "Go to Location…" (⇧⌘G) in the markdown window: what a typed path names, and Tab completion.
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

    func testTabCompletesASingleFolderWithASlashAndStopsAtTheSharedPrefix() {
        // "notes" and "nothing" share "not": completed that far, then it stays ambiguous.
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/no", base: root), root.path + "/not")
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/not", base: root), root.path + "/not")
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/note", base: root), root.path + "/notes/")
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/notes/d", base: root), root.path + "/notes/d")
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/notes/da", base: root), root.path + "/notes/daily/")
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/notes/pl", base: root), root.path + "/notes/plan.md")
        XCTAssertEqual(MarkdownGoTo.complete(root.path + "/zzz", base: root), root.path + "/zzz")
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
}
