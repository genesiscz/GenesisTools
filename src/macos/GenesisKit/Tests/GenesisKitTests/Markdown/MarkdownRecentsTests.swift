import AppKit
import XCTest
@testable import GenesisKit

/// File → Open Recent: what is remembered, how an open and a closed file read, and what Clear Closed keeps.
@MainActor
final class MarkdownRecentsTests: XCTestCase {
    func testOpenAndCloseAreRememberedNewestFirstAndClosedSaysWhen() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("recents-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let plan = dir.appendingPathComponent("plan.md")
        let ideas = dir.appendingPathComponent("ideas.md")
        try "plan".write(to: plan, atomically: true, encoding: .utf8)
        try "ideas".write(to: ideas, atomically: true, encoding: .utf8)
        let suite = "recents.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))

        let model = MarkdownDocumentsModel(defaults: defaults)
        model.open([plan, ideas])
        XCTAssertEqual(model.recents.entries.map { ($0.path as NSString).lastPathComponent }, ["ideas.md", "plan.md"])
        let doc = try XCTUnwrap(model.docs.first { $0.url.lastPathComponent == "plan.md" })
        model.close(doc)
        let closed = try XCTUnwrap(model.recents.entries.first { $0.path.hasSuffix("plan.md") })
        XCTAssertNotNil(closed.closed)
        XCTAssertEqual(MarkdownRecents.note(for: closed, isOpen: false, now: closed.closed!.addingTimeInterval(3 * 3600)), "closed 3h ago")
        XCTAssertEqual(MarkdownRecents.note(for: closed, isOpen: true), "open")

        // Another window of the same defaults reads them back.
        let again = MarkdownDocumentsModel(defaults: defaults)
        XCTAssertEqual(again.recents, model.recents)

        model.clearRecents()
        XCTAssertEqual(model.recents.entries.map { ($0.path as NSString).lastPathComponent }, ["ideas.md"], "the open file stays")
        UserDefaults.standard.removePersistentDomain(forName: suite)
    }

    func testTheListKeepsAtMostFortyAndAReopenMovesToTheTop() {
        var recents = MarkdownRecents()
        for index in 0 ..< 45 { recents.opened(URL(fileURLWithPath: "/notes/\(index).md")) }
        XCTAssertEqual(recents.entries.count, MarkdownRecents.limit)
        recents.opened(URL(fileURLWithPath: "/notes/10.md"))
        XCTAssertEqual(recents.entries.first?.path, "/notes/10.md")
        XCTAssertEqual(recents.entries.filter { $0.path == "/notes/10.md" }.count, 1)
    }
}
