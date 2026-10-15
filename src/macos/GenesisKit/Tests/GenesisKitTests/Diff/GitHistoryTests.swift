import XCTest
@testable import GenesisKit

/// The git sidebar's data and actions: a file's history and the repository log, a past version read, restored and
/// compared.
@MainActor
final class GitHistoryTests: XCTestCase {
    private func git(_ args: [String], in repo: URL) throws {
        let result = try GenesisKitGTCLIProvider().git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
    }

    private func wait(_ what: String, until done: () -> Bool) async {
        let end = Date().addingTimeInterval(5)
        while !done(), Date() < end {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(done(), "timed out waiting for \(what)")
    }

    func testHistoryRevisionRestoreAndCompare() async throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("githistory-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let note = repo.appendingPathComponent("plan.md")
        let other = repo.appendingPathComponent("other.md")
        try git(["init", "-q", "-b", "main"], in: repo)
        try "first\n".write(to: note, atomically: true, encoding: .utf8)
        try "x\n".write(to: other, atomically: true, encoding: .utf8)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        try "second\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["commit", "-q", "-am", "Second"], in: repo)

        let history = GitHistoryModel()
        history.follow(.file(note))
        await wait("the file history") { history.commits.count == 2 }
        XCTAssertEqual(history.commits.map(\.subject), ["Second", "First"])
        let log = GitHistoryModel()
        log.follow(.repository(repo))
        await wait("the repository log") { log.commits.count == 2 }

        let defaults = try XCTUnwrap(UserDefaults(suiteName: "githistory.\(UUID().uuidString)"))
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.open([note, other])
        model.select(note.standardizedFileURL.path)
        let doc = try XCTUnwrap(model.selected)
        let first = history.commits[1]

        model.viewRevision(first, of: doc)
        await wait("the past version") { model.revisionView?.text == "first\n" }
        model.restoreRevision(try XCTUnwrap(model.revisionView), in: doc)
        XCTAssertEqual(doc.displayText, "first\n")
        XCTAssertTrue(doc.isDirty, "a restore is an unsaved edit")
        XCTAssertNil(model.revisionView)

        model.compareRevision(first, with: nil, of: doc)
        XCTAssertEqual(model.mode, .changes)
        XCTAssertEqual(model.revisionCompare?.old.sha, first.sha)
        let diff = GitFileDiffModel()
        diff.loadCompare(note, text: "third\n", old: first, new: history.commits[0])
        await wait("the compare") { diff.phase == .ready }
        XCTAssertEqual(diff.file?.oldContents, "first\n")
        XCTAssertEqual(diff.file?.newContents, "second\n")

        // Another tab drops the compare: it belonged to the note it was opened on.
        model.select(other.standardizedFileURL.path)
        XCTAssertNil(model.revisionCompare)
    }
}
