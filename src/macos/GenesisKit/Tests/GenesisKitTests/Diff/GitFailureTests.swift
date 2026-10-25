import XCTest
@testable import GenesisKit

/// A failed git read reaches the user as one sentence with the raw text behind Details, keeps what was shown before,
/// and is never taken for an empty answer.
@MainActor
final class GitFailureTests: XCTestCase {
    private func git(_ args: [String], in repo: URL) throws {
        let result = try GenesisKitGTCLIProvider().git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
    }

    private func repoWithOneCommit() throws -> (repo: URL, note: URL) {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gitfailure-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        let note = repo.appendingPathComponent("plan.md")
        try git(["init", "-q", "-b", "main"], in: repo)
        try "one\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        return (repo, note)
    }

    /// A provider whose history or status reads fail while `failing` is set.
    private final class FailingProvider: GenesisKitGTCLIProvider, @unchecked Sendable {
        private let lock = NSLock()
        private var _failing = true
        var failing: Bool {
            get { lock.withLock { _failing } }
            set { lock.withLock { _failing = newValue } }
        }

        override func history(of file: URL, limit: Int) throws -> [GitCommit] {
            if failing { throw ReviewError.git("git log --follow: fatal: unable to read index") }
            return try super.history(of: file, limit: limit)
        }

        override func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus? {
            if failing { throw ReviewError.git("git status: fatal: Unable to create '/x/.git/index.lock': File exists.") }
            return try super.repoStatus(folder, commits: commits)
        }
    }

    func testKnownCausesReadAsOneSentenceWithTheRawTextBehindDetails() {
        let base = GitFailure(ReviewError.git("no merge base with main"), fallback: "fallback")
        XCTAssertEqual(base.message, "This branch shares no history with its base branch, so there is nothing to compare.")
        XCTAssertEqual(base.detail, "no merge base with main")

        let missing = GitFailure(ReviewError.git("git show HEAD:a.md: fatal: path 'a.md' exists on disk, but not in 'HEAD'"), fallback: "fallback")
        XCTAssertEqual(missing.message, "That version of the file is not in git.")

        let locked = GitFailure(ReviewError.git("fatal: Unable to create '/x/.git/index.lock': File exists."), fallback: "fallback")
        XCTAssertEqual(locked.message, "Another git command is using this repository. Try again in a moment.")

        let unknown = GitFailure(ReviewError.git("fatal: something new"), fallback: "Git could not read this file.")
        XCTAssertEqual(unknown.message, "Git could not read this file.")
        XCTAssertEqual(unknown.detail, "fatal: something new")

        let outside = GitFailure(ReviewError.notRepository("/tmp/x"), fallback: "fallback")
        XCTAssertTrue(outside.message.hasSuffix("is not a git repository, so it has no changes to show."), outside.message)
        XCTAssertNil(outside.detail, "the sentence is the whole story")
    }

    func testAFailedHistoryReadIsNotNoCommitsYet() throws {
        let (repo, note) = try repoWithOneCommit()
        defer { try? FileManager.default.removeItem(at: repo) }
        let provider = FailingProvider()
        XCTAssertThrowsError(try GitFileDiffModel.sides(note, text: "one\n", scope: .lastCommit, pick: nil, provider: provider)) { error in
            let failure = (error as? GitFailure.Thrown)?.failure
            XCTAssertEqual(failure?.message, "Could not read this file's history. Try again.")
            XCTAssertEqual(failure?.detail?.contains("unable to read index"), true)
        }
        // A scope that does not need the history still shows its diff.
        XCTAssertEqual(try GitFileDiffModel.sides(note, text: "two\n", scope: .uncommitted, pick: nil, provider: provider).old, "one\n")
        // Read, the history gives the commit.
        provider.failing = false
        XCTAssertEqual(try GitFileDiffModel.sides(note, text: "one\n", scope: .lastCommit, pick: nil, provider: provider).commit?.subject, "First")
    }

    func testTheModelSaysTheSentenceAndTryAgainReadsAgain() async throws {
        let (repo, note) = try repoWithOneCommit()
        defer { try? FileManager.default.removeItem(at: repo) }
        let provider = FailingProvider()
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = provider
        defer { GenesisKitGT.provider = previous }

        let model = GitFileDiffModel()
        model.load(note, text: "one\n", scope: .lastCommit)
        await wait("the failure") { if case .failed = model.phase { true } else { false } }
        XCTAssertEqual(model.phase, .failed("Could not read this file's history. Try again."))
        XCTAssertNotNil(model.failure?.detail)

        provider.failing = false
        model.retry()
        await wait("the empty commit diff") { if case .ready = model.phase { true } else { false } }
        XCTAssertNil(model.failure)
        XCTAssertEqual(model.commit?.subject, "First")
    }

    func testAFailedStatusKeepsTheLastListAndSaysSo() async throws {
        let (repo, note) = try repoWithOneCommit()
        defer { try? FileManager.default.removeItem(at: repo) }
        try "one\ntwo\n".write(to: note, atomically: true, encoding: .utf8)
        let provider = FailingProvider()
        provider.failing = false
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = provider
        defer { GenesisKitGT.provider = previous }

        let model = GitRepoModel(root: repo)
        await wait("the status") { model.status?.entry(for: note) != nil }
        let shown = model.status
        let generation = model.generation

        provider.failing = true
        model.retry()
        await wait("the failed read") { model.generation > generation }
        XCTAssertEqual(model.status, shown, "the list stays")
        XCTAssertEqual(model.failure?.message, "Another git command is using this repository. Try again in a moment.")

        provider.failing = false
        model.retry()
        await wait("the read after Try again") { model.failure == nil }
        XCTAssertEqual(model.status, shown)
    }

    private func wait(_ what: String, timeout: TimeInterval = 5, until done: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(done(), "timed out waiting for \(what)")
    }
}
