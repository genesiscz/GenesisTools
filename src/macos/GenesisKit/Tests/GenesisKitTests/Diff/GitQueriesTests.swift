import XCTest
@testable import GenesisKit

/// The CLI provider's git questions: the porcelain parsers on fixed output, then one scratch repository.
final class GitQueriesTests: XCTestCase {
    func testStatusParsesBranchCountsAndEveryEntryKind() {
        let output = [
            "# branch.oid 1234567890abcdef1234567890abcdef12345678",
            "# branch.head feat/notes",
            "# branch.upstream origin/feat/notes",
            "# branch.ab +2 -1",
            "1 .M N... 100644 100644 100644 aaa bbb notes/plan with space.md",
            "1 A. N... 000000 100644 100644 000 ccc notes/new.md",
            "2 R. N... 100644 100644 100644 ddd eee R100 notes/renamed.md",
            "notes/old.md",
            "u UU N... 100644 100644 100644 100644 fff ggg hhh notes/conflict.md",
            "? scratch.txt",
        ].joined(separator: "\0") + "\0"
        let status = GitQueries.parseStatus(output)
        XCTAssertEqual(status.branch, "feat/notes")
        XCTAssertEqual(status.upstream, "origin/feat/notes")
        XCTAssertEqual(status.ahead, 2)
        XCTAssertEqual(status.behind, 1)
        XCTAssertEqual(status.entries, [
            GitStatusEntry(path: "notes/plan with space.md", unstaged: .modified),
            GitStatusEntry(path: "notes/new.md", staged: .added),
            GitStatusEntry(path: "notes/renamed.md", oldPath: "notes/old.md", staged: .renamed),
            GitStatusEntry(path: "notes/conflict.md", staged: .conflicted, unstaged: .conflicted),
            GitStatusEntry(path: "scratch.txt", unstaged: .untracked),
        ])
    }

    func testDetachedHeadNamesItsCommit() {
        let status = GitQueries.parseStatus("# branch.oid abcdef0123456789\0# branch.head (detached)\0")
        XCTAssertEqual(status.branch, "detached abcdef0")
    }

    func testLogKeepsTheSubjectAndThePathOfEachCommit() {
        let output = "\u{1e}aaa1\u{1f}aaa\u{1f}Rename it\u{1f}Alice\u{1f}1700000100\n\nnotes/new.md\n"
            + "\u{1e}bbb2\u{1f}bbb\u{1f}First: with a colon\u{1f}Bob\u{1f}1700000000\n\nnotes/old.md\n"
        let commits = GitQueries.parseLog(output)
        XCTAssertEqual(commits.map(\.short), ["aaa", "bbb"])
        XCTAssertEqual(commits.map(\.subject), ["Rename it", "First: with a colon"])
        XCTAssertEqual(commits.map(\.path), ["notes/new.md", "notes/old.md"])
        XCTAssertEqual(commits[1].date, Date(timeIntervalSince1970: 1_700_000_000))
    }

    func testNumstatReadsOneFileAndBinaryAsZero() {
        XCTAssertEqual(GitQueries.parseNumstat("3\t1\tnotes/plan.md\n")?.additions, 3)
        XCTAssertEqual(GitQueries.parseNumstat("-\t-\timage.png\n")?.additions, 0)
        XCTAssertNil(GitQueries.parseNumstat(""))
    }

    func testRepositoryLogFailuresThrowButAnUnbornRepositoryHasNoLog() throws {
        final class Provider: GenesisKitGTCLIProvider {
            var unborn = false
            var failLog = true
            var logCalls = 0

            override func git(_ arguments: [String], in repo: URL, input: Data?, gitDirectory: String?, environment: [String: String]?) throws -> GitRunResult {
                if arguments == ["rev-parse", "--show-toplevel"] {
                    return GitRunResult(status: 0, stdout: Data(repo.path.utf8), stderr: Data())
                }
                if arguments.contains("--porcelain=v2") {
                    let oid = unborn ? "(initial)" : "abc1234"
                    return GitRunResult(status: 0, stdout: Data("# branch.oid \(oid)\0# branch.head main\0".utf8), stderr: Data())
                }
                if arguments.first == "log" {
                    logCalls += 1
                    if failLog { return GitRunResult(status: 128, stdout: Data(), stderr: Data("log unavailable".utf8)) }
                    return GitRunResult(status: 0, stdout: Data("\u{1e}abc1234\u{1f}abc1234\u{1f}Kept\u{1f}Alice\u{1f}1700000000\n".utf8), stderr: Data())
                }
                throw ReviewError.git("Unexpected git command")
            }
        }
        let provider = Provider()
        let root = URL(fileURLWithPath: "/tmp/history-fixture")
        XCTAssertThrowsError(try provider.repoStatus(root, commits: 15)) { error in
            XCTAssertTrue(String(describing: error).contains("log unavailable"))
        }
        XCTAssertEqual(provider.logCalls, 1, "the production repoStatus query must propagate its log failure")
        XCTAssertNotNil(try provider.repoStatus(root, commits: 0), "a status-only read does not need the log")
        XCTAssertEqual(provider.logCalls, 1)
        provider.unborn = true
        XCTAssertTrue(try XCTUnwrap(provider.repoStatus(root, commits: 15)).commits.isEmpty)
        XCTAssertEqual(provider.logCalls, 1, "an unborn branch is explicitly empty, without asking git log")
        provider.unborn = false
        provider.failLog = false
        XCTAssertEqual(try provider.repoStatus(root, commits: 15)?.commits.map(\.subject), ["Kept"])
    }

    func testAScratchRepositoryAnswersEveryQuestion() throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gitqueries-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("notes"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let provider = GenesisKitGTCLIProvider()
        func git(_ args: [String]) throws {
            let result = try provider.git(args, in: repo, input: nil, gitDirectory: nil, environment: [
                "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
                "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
            ])
            XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
        }
        let note = repo.appendingPathComponent("notes/plan.md")
        try git(["init", "-q", "-b", "main"])
        try "one\ntwo\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["add", "."])
        try git(["commit", "-q", "-m", "First"])
        try "one\ntwo\nthree\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["commit", "-q", "-am", "Second"])
        try "one\n2\nthree\nfour\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["add", "notes/plan.md"])
        try "one\n2\nthree\nfour\nfive\n".write(to: note, atomically: true, encoding: .utf8)
        try "scratch".write(to: repo.appendingPathComponent("scratch.txt"), atomically: true, encoding: .utf8)

        let state = try XCTUnwrap(provider.fileState(note))
        XCTAssertEqual(state.branch, "main")
        XCTAssertEqual(state.path, "notes/plan.md")
        XCTAssertEqual(state.entry?.staged, .modified)
        XCTAssertEqual(state.entry?.unstaged, .modified)
        XCTAssertEqual(state.unstagedAdditions, 1)
        XCTAssertEqual(state.stagedAdditions + state.stagedDeletions, 3)
        XCTAssertEqual(state.summary, "Modified · 1 line unstaged · 3 lines staged")

        XCTAssertEqual(try provider.contents(of: note, at: .head), "one\ntwo\nthree\n")
        XCTAssertEqual(try provider.contents(of: note, at: .index), "one\n2\nthree\nfour\n")
        let history = try provider.history(of: note, limit: 10)
        XCTAssertEqual(history.map(\.subject), ["Second", "First"])
        XCTAssertEqual(try provider.contents(of: note, at: .commit(history[1].sha)), "one\ntwo\n")

        let status = try XCTUnwrap(provider.repoStatus(repo, commits: 5))
        XCTAssertEqual(status.entries.map(\.path).sorted(), ["notes/plan.md", "scratch.txt"])
        XCTAssertEqual(status.commits.count, 2)
        let decorations = status.decorations
        XCTAssertEqual(decorations.change(for: status.root.path + "/scratch.txt"), .untracked)
        XCTAssertTrue(decorations.holdsChanges(status.root.path + "/notes"))

        let untracked = try XCTUnwrap(provider.fileState(repo.appendingPathComponent("scratch.txt")))
        XCTAssertEqual(untracked.summary, "new file, not in git")
        let outside = FileManager.default.temporaryDirectory.appendingPathComponent("not-a-repo-\(UUID().uuidString).md")
        try "x".write(to: outside, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: outside) }
        XCTAssertNil(try provider.fileState(outside))
    }
}
