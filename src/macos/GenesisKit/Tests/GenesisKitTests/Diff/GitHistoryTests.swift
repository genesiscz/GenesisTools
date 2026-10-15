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

    func testAnOldHistoryReplyCannotRestoreAStoppedOrRetargetedList() async throws {
        final class Delayed: GenesisKitGTCLIProvider {
            let gate = DispatchSemaphore(value: 0)
            let started: XCTestExpectation
            let finished: XCTestExpectation
            init(_ started: XCTestExpectation, _ finished: XCTestExpectation) {
                self.started = started; self.finished = finished
            }
            override func history(of file: URL, limit: Int) throws -> [GitCommit] {
                started.fulfill()
                _ = gate.wait(timeout: .now() + 5)
                finished.fulfill()
                return [GitCommit(sha: "abc1234", short: "abc1234", subject: "Old", author: "Alice", date: .distantPast)]
            }
        }
        for stop in [true, false] {
            let started = expectation(description: "history started"), finished = expectation(description: "history finished")
            let provider = Delayed(started, finished)
            let previous = GenesisKitGT.provider
            GenesisKitGT.provider = provider
            defer { GenesisKitGT.provider = previous }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("absent-history-\(UUID())")
            let model = GitHistoryModel()
            model.follow(.file(root.appendingPathComponent("old.md")))
            model.reload()
            await fulfillment(of: [started], timeout: 3)
            model.follow(stop ? nil : .file(root.appendingPathComponent("other/new.md")))
            provider.gate.signal()
            await fulfillment(of: [finished], timeout: 3)
            try await Task.sleep(for: .milliseconds(100))
            XCTAssertTrue(model.commits.isEmpty)
            XCTAssertFalse(model.loaded)
        }
    }

    func testLateRevisionCannotReplaceANewerRequestComparisonOrTabTransition() async throws {
        final class Delayed: GenesisKitGTCLIProvider {
            let gate = DispatchSemaphore(value: 0)
            let started: XCTestExpectation
            let finished: XCTestExpectation
            init(_ started: XCTestExpectation, _ finished: XCTestExpectation) {
                self.started = started; self.finished = finished
            }
            override func git(_ arguments: [String], in repo: URL, input: Data?, gitDirectory: String?, environment: [String: String]?) throws -> GitRunResult {
                if arguments == ["rev-parse", "--show-toplevel"] {
                    return GitRunResult(status: 0, stdout: Data(repo.path.utf8), stderr: Data())
                }
                if arguments.first == "show" {
                    if arguments.last?.hasPrefix("old:") == true {
                        started.fulfill()
                        _ = gate.wait(timeout: .now() + 5)
                        finished.fulfill()
                        return GitRunResult(status: 0, stdout: Data("old revision".utf8), stderr: Data())
                    }
                    return GitRunResult(status: 0, stdout: Data("new revision".utf8), stderr: Data())
                }
                return GitRunResult(status: 1, stdout: Data(), stderr: Data())
            }
            override func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus? { nil }
        }
        for action in ["newer", "compare", "tab"] {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("revision-order-\(UUID())")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let note = root.appendingPathComponent("note.md"), other = root.appendingPathComponent("other.md")
            try "draft".write(to: note, atomically: true, encoding: .utf8)
            try "other".write(to: other, atomically: true, encoding: .utf8)
            let started = expectation(description: "old revision started"), finished = expectation(description: "old revision finished")
            let provider = Delayed(started, finished)
            let previous = GenesisKitGT.provider
            GenesisKitGT.provider = provider
            defer { GenesisKitGT.provider = previous }
            let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "revision-order-\(UUID())")!)
            model.open([note, other])
            model.select(note.standardizedFileURL.path)
            let doc = try XCTUnwrap(model.selected)
            let old = GitCommit(sha: "old", short: "old", subject: "Old", author: "Alice", date: .distantPast)
            let new = GitCommit(sha: "new", short: "new", subject: "New", author: "Alice", date: .distantFuture)
            model.viewRevision(old, of: doc)
            await fulfillment(of: [started], timeout: 3)
            switch action {
            case "newer":
                model.viewRevision(new, of: doc)
                await wait("new revision") { model.revisionView?.commit.sha == "new" }
            case "compare": model.compareRevision(new, with: nil, of: doc)
            default:
                model.select(other.standardizedFileURL.path)
                model.select(doc.id)
            }
            provider.gate.signal()
            await fulfillment(of: [finished], timeout: 3)
            try await Task.sleep(for: .milliseconds(100))
            if action == "newer" { XCTAssertEqual(model.revisionView?.text, "new revision") }
            else { XCTAssertNil(model.revisionView) }
            if action == "compare" { XCTAssertEqual(model.revisionCompare?.old.sha, "new") }
            XCTAssertNil(model.exportError)
        }
    }

    func testFailedRevisionIsNotRestorableButAnEmptyBlobIs() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("revision-failure-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let note = root.appendingPathComponent("note.md")
        try git(["init", "-q", "-b", "main"], in: root)
        try "".write(to: note, atomically: true, encoding: .utf8)
        try git(["add", "."], in: root)
        try git(["commit", "-q", "-m", "Empty"], in: root)
        let commit = try XCTUnwrap(GenesisKitGTCLIProvider().history(of: note, limit: 1).first)
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "revision-\(UUID())")!)
        model.open([note])
        let doc = try XCTUnwrap(model.selected)
        doc.edit("unsaved draft")
        var invalid = commit
        invalid.sha = String(repeating: "0", count: 40)
        model.viewRevision(invalid, of: doc)
        await wait("revision error") { model.exportError != nil }
        XCTAssertNil(model.revisionView)
        XCTAssertEqual(doc.displayText, "unsaved draft")
        model.viewRevision(commit, of: doc)
        await wait("real empty revision") { model.revisionView != nil }
        XCTAssertEqual(model.revisionView?.text, "")
        XCTAssertNil(model.exportError)
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
