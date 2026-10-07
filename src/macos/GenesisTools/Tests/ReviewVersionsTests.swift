import XCTest
@testable import GenesisTools

/// Comparing two pushes of a PR across a rebase (Review/ReviewVersions.swift), on a real scratch
/// repository: the diff must show the author's change between the pushes and nothing the rebase
/// brought in from the target branch.
final class ReviewVersionsTests: XCTestCase {
    private var repo: URL!

    override func setUpWithError() throws {
        repo = FileManager.default.temporaryDirectory.appendingPathComponent("review-versions-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try git("init", "-q", "-b", "main")
        try git("config", "user.email", "alice@example.com")
        try git("config", "user.name", "Alice Example")
        try git("config", "commit.gpgsign", "false")
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: repo)
    }

    @discardableResult
    private func git(_ args: String...) throws -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo.path] + args
        let out = Pipe()
        process.standardOutput = out
        process.standardError = Pipe()
        try process.run()
        let data = out.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "git \(args.joined(separator: " "))")
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func write(_ name: String, _ text: String) throws {
        try text.write(to: repo.appendingPathComponent(name), atomically: true, encoding: .utf8)
    }

    private func commit(_ message: String) throws -> String {
        try git("add", "-A")
        try git("commit", "-q", "-m", message)
        return try git("rev-parse", "HEAD")
    }

    /// base1 → the PR's first push (line 2); upstream lands on main; the PR is rebased and then
    /// changes line 3. Returns the two ends.
    private func rebasedPR(upstreamTouchesLine2: Bool) throws -> (from: CompareEnd, to: CompareEnd) {
        try write("a.txt", "1\n2\n3\n")
        try write("u.txt", "upstream 0\n")
        let base1 = try commit("base")
        try git("checkout", "-q", "-b", "pr")
        try write("a.txt", "1\ntwo\n3\n")
        let head1 = try commit("pr: line 2")
        try git("checkout", "-q", "main")
        try write("u.txt", "upstream 1\n")
        if upstreamTouchesLine2 { try write("a.txt", "1\nTWO upstream\n3\n") }
        let base2 = try commit("upstream")
        try git("checkout", "-q", "-b", "pr2", base2)
        try write("a.txt", upstreamTouchesLine2 ? "1\ntwo\n3\n" : "1\ntwo\n3\n")
        _ = try commit("pr: line 2, rebased")
        try write("a.txt", "1\ntwo\nthree\n")
        let head2 = try commit("pr: line 3")
        return (CompareEnd(base: base1, head: head1), CompareEnd(base: base2, head: head2))
    }

    func testARebaseBetweenTwoPushesShowsOnlyTheAuthorsChange() throws {
        let (from, to) = try rebasedPR(upstreamTouchesLine2: false)
        let source = GitWorkingTreeSource(repo: repo)
        let replayed = try source.compareTree(from: from, to: to, targetRef: nil)
        XCTAssertEqual(replayed.conflicted, [])
        XCTAssertEqual(try git("diff", "--name-only", replayed.tree, to.head), "a.txt", "upstream's u.txt is not the author's change")
        XCTAssertTrue(try git("diff", replayed.tree, to.head).contains("+three"))
        // The naive head-to-head diff is what GitLab shows: upstream's change rides along.
        XCTAssertEqual(try git("diff", "--name-only", from.head, to.head), "a.txt\nu.txt")
    }

    func testTheBranchScopeComparesAgainstThePRTargetWhenItExists() throws {
        try write("a.txt", "1\n")
        _ = try commit("base")
        try git("branch", "stack-target")
        let source = GitWorkingTreeSource(repo: repo, preferredBase: "stack-target")
        XCTAssertEqual(source.baseBranch(), "stack-target", "a stacked PR's target, not the repo default")
        let missing = GitWorkingTreeSource(repo: repo, preferredBase: "origin/gone")
        XCTAssertEqual(missing.baseBranch(), "main", "a target that is not here falls back to the guess")
    }

    func testTheWorktreeChoiceListsEveryCheckoutAndReadsTheAgentsBranch() throws {
        try write("a.txt", "1\n")
        _ = try commit("base")
        try git("branch", "agent-base")
        let tree = repo.deletingLastPathComponent().appendingPathComponent("\(repo.lastPathComponent)-agent")
        defer { try? FileManager.default.removeItem(at: tree) }
        try git("worktree", "add", "-q", "-b", "agent/task", tree.path)
        try "1\nagent\n".write(to: tree.appendingPathComponent("a.txt"), atomically: true, encoding: .utf8)

        let trees = GitWorkingTreeSource(repo: repo).worktrees()
        XCTAssertEqual(trees.map(\.branch), ["main", "agent/task"])
        XCTAssertEqual(URL(fileURLWithPath: trees[1].path).resolvingSymlinksInPath(), tree.resolvingSymlinksInPath())

        // The agent's checkout against a picked base: its own edit, nothing of the main checkout.
        let snapshot = try GitWorkingTreeSource(repo: tree, preferredBase: "agent-base").load(scope: .branch)
        XCTAssertEqual(snapshot.branch, "agent/task")
        XCTAssertEqual(snapshot.files.map(\.path), ["a.txt"])
        XCTAssertEqual(GitWorkingTreeSource(repo: tree, preferredBase: "agent-base").baseBranch(), "agent-base")
        XCTAssertTrue(GitWorkingTreeSource(repo: repo).baseCandidates().contains("agent-base"))
    }

    func testWorktreePorcelainSkipsTheBareEntryAndNamesADetachedHead() {
        let porcelain = """
        worktree /repos/app.git
        bare

        worktree /repos/app
        HEAD 1111111111111111111111111111111111111111
        branch refs/heads/main

        worktree /repos/app-review
        HEAD 2222222222222222222222222222222222222222
        detached
        """
        let trees = RepoWorktree.parse(porcelain)
        XCTAssertEqual(trees.map(\.path), ["/repos/app", "/repos/app-review"])
        XCTAssertEqual(trees[1].branch, nil)
        XCTAssertEqual(trees[1].title, "detached 2222222  ·  app-review")
    }

    func testTheSameBaseIsAPlainDiffOfTheTwoHeads() throws {
        let (from, _) = try rebasedPR(upstreamTouchesLine2: false)
        let replayed = try GitWorkingTreeSource(repo: repo).compareTree(from: from, to: CompareEnd(base: from.base, head: from.head), targetRef: nil)
        XCTAssertEqual(replayed.tree, from.head)
    }

    func testAPathTheUpstreamAlsoChangedShowsTheOlderPushWithoutConflictMarkers() throws {
        let (from, to) = try rebasedPR(upstreamTouchesLine2: true)
        let replayed = try GitWorkingTreeSource(repo: repo).compareTree(from: from, to: to, targetRef: nil)
        XCTAssertEqual(replayed.conflicted, ["a.txt"])
        let left = try git("show", "\(replayed.tree):a.txt")
        XCTAssertEqual(left, "1\ntwo\n3", "the older push's copy, no <<<<<<< markers")
        XCTAssertEqual(try git("diff", "--name-only", replayed.tree, to.head), "a.txt", "u.txt still left out")
    }

    func testTheNoticeNamesThePusherAndOnlyTheNewCommits() throws {
        let json = """
        {"versions":[
          {"id":"12","headSha":"new","baseSha":"b2","createdAt":"2026-10-07T15:53:12Z",
           "pushedBy":{"name":"Alice Example","username":"alice"},
           "commits":[{"sha":"c3","title":"third","author":null},{"sha":"c2x","title":"second","author":null},{"sha":"c1x","title":"first","author":null}]},
          {"id":"11","headSha":"old","baseSha":"b1","createdAt":"2026-10-02T03:07:20Z","pushedBy":null,
           "commits":[{"sha":"c2","title":"second","author":null},{"sha":"c1","title":"first","author":null}]}
        ],"history":true}
        """
        let versions = try JSONDecoder().decode(PRVersionsPayload.self, from: Data(json.utf8)).versions
        let news = try XCTUnwrap(PRPushNews.between(shownHead: "old", versions: versions))
        XCTAssertEqual(news.newCommits.map(\.title), ["third"], "rebased copies of shown commits are not new")
        XCTAssertTrue(news.rebased)
        XCTAssertEqual(news.pushes, 1)
        XCTAssertTrue(news.headline.hasPrefix("alice rebased and pushed 1 new commit · "))
        XCTAssertNil(PRPushNews.between(shownHead: "new", versions: versions), "the newest push on screen: no notice")
    }
}
