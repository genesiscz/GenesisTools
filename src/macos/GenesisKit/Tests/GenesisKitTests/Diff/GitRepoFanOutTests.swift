import XCTest
@testable import GenesisKit

/// How many git processes the viewer's views of ONE repository start for a burst of events. Genesis Markdown started
/// about 40 git runs every 10 s while other sessions worked in its repositories (2026-11-12: 462 `spawn.storm` marks,
/// `git rev-parse` ×56,304 and `git status` ×53,246 in one perf log): every status read woke each view, and each view
/// found its repository again (`rev-parse`) and read its own status, HEAD copy, history and line counts.
@MainActor
final class GitRepoFanOutTests: XCTestCase {
    /// The CLI provider, counting each git run by its subcommand.
    private final class CountingProvider: GenesisKitGTCLIProvider, @unchecked Sendable {
        private let lock = NSLock()
        private var counts: [String: Int] = [:]

        override func git(_ arguments: [String], in repo: URL, input: Data? = nil, gitDirectory: String? = nil, environment: [String: String]? = nil) throws -> GitRunResult {
            let command = arguments.first { !$0.hasPrefix("-") } ?? ""
            lock.lock()
            counts[command, default: 0] += 1
            lock.unlock()
            return try super.git(arguments, in: repo, input: input, gitDirectory: gitDirectory, environment: environment)
        }

        func take() -> [String: Int] {
            lock.lock()
            defer { lock.unlock() }
            let taken = counts
            counts = [:]
            return taken
        }
    }

    private func git(_ args: [String], in repo: URL) throws {
        let result = try GenesisKitGTCLIProvider().git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
    }

    private func wait(_ what: String, timeout: TimeInterval = 8, until done: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(done(), "timed out waiting for \(what)")
    }

    func testViewsOfOneRepositoryShareOneStatusPerBurstOfGitFolderEvents() async throws {
        let made = FileManager.default.temporaryDirectory.appendingPathComponent("git-fanout-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: made, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: made) }
        // The real path: FSEvents and git both name /private/var, not /var.
        let repo = URL(fileURLWithPath: GitWorkingTreeSource.realPath(made.path))
        let note = repo.appendingPathComponent("plan.md")
        try git(["init", "-q", "-b", "main"], in: repo)
        try "one\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        try "one\ntwo\n".write(to: note, atomically: true, encoding: .utf8)

        // The tree spells its marks under its root as Foundation standardizes it (no /private).
        let marked = note.standardizedFileURL.path
        let counting = CountingProvider()
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = counting
        defer { GenesisKitGT.provider = previous }

        _ = GitRepos.shared.lookup(for: repo)
        await wait("the repository") { GitRepos.shared.model(for: repo)?.status != nil }
        let model = try XCTUnwrap(GitRepos.shared.model(for: repo))

        // Five windows on the same note: each has a status bar, a gutter, a file tree and a file history.
        let views = 5
        let files = (0..<views).map { _ in GitFileStateModel() }
        let gutters = (0..<views).map { _ in GitGutterModel() }
        let trees = (0..<views).map { _ in GitTreeDecorationsModel() }
        let histories = (0..<views).map { _ in GitHistoryModel() }
        for index in 0..<views {
            files[index].follow(note)
            gutters[index].follow(note, text: "one\ntwo\n")
            trees[index].follow(repo)
            histories[index].follow(.file(note))
        }
        await wait("every view") {
            files.allSatisfy { $0.state?.unstagedAdditions == 1 } && gutters.allSatisfy { !$0.hunks.isEmpty }
                && trees.allSatisfy { $0.decorations.count(for: marked)?.additions == 1 } && histories.allSatisfy(\.loaded)
        }
        XCTAssertTrue(files.allSatisfy { $0.state?.unstagedAdditions == 1 }, "states: \(files.map { String(describing: $0.state?.summary) })")
        XCTAssertTrue(gutters.allSatisfy { !$0.hunks.isEmpty }, "gutters: \(gutters.map(\.hunks.count))")
        XCTAssertTrue(trees.allSatisfy { $0.decorations.count(for: marked)?.additions == 1 }, "trees: \(trees.map { String(describing: $0.decorations.count(for: marked)) })")
        XCTAssertTrue(histories.allSatisfy(\.loaded), "histories")
        try? await Task.sleep(for: .seconds(1.5))
        _ = counting.take()

        // Another session's git runs in this checkout: ten writes into the git folder that change no status (a
        // `git status` refreshing the index, a fetch writing FETCH_HEAD), 100 ms apart.
        let reads = model.reads
        let gitFolder = repo.appendingPathComponent(".git")
        for index in 0..<10 {
            try "x\n".write(to: gitFolder.appendingPathComponent("SCRATCH_\(index)"), atomically: true, encoding: .utf8)
            try? await Task.sleep(for: .milliseconds(100))
        }
        await wait("the status read") { model.reads > reads }
        try? await Task.sleep(for: .seconds(2.5))
        let burst = counting.take()
        let line = burst.sorted { $0.key < $1.key }.map { "\($0.key) ×\($0.value)" }.joined(separator: ", ")
        print("git runs for \(views) views and a burst of 10 git-folder events: \(burst.values.reduce(0, +)) (\(line))")

        XCTAssertEqual(burst["status"], 1, "one status for the burst, however many views follow the repository: \(line)")
        XCTAssertNil(burst["rev-parse"], "every view knows its repository already: \(line)")
        XCTAssertNil(burst["show"], "HEAD did not move, so no gutter reads its copy again: \(line)")
        XCTAssertNil(burst["log"], "HEAD did not move, so no history reloads: \(line)")
        XCTAssertLessThanOrEqual(burst["diff"] ?? 0, 2, "one shared numstat for the trees, one for the note's state: \(line)")
        XCTAssertTrue(files.allSatisfy { $0.state?.unstagedAdditions == 1 })

        // A real change still reaches every view: a stage moves the note to staged in every status bar.
        try git(["add", "plan.md"], in: repo)
        await wait("the staged state in every window") { files.allSatisfy { $0.state?.hasStaged == true && $0.state?.hasUnstaged == false } }
        // A commit moves HEAD: every gutter reads HEAD's copy again and finds no hunk left.
        try git(["commit", "-q", "-m", "Second"], in: repo)
        await wait("the gutters after the commit") { gutters.allSatisfy { $0.hunks.isEmpty } }
        await wait("the histories after the commit") { histories.allSatisfy { $0.commits.count == 2 } }
    }
}
