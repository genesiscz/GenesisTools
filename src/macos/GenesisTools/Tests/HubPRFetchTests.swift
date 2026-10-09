import XCTest
@testable import GenesisTools

/// A PR whose branch has no local worktree: the `tools hub pr fetch` argv, its answer and its error
/// sentences (Hub/HubPRFetch.swift), the range scope on the fetched head (Hub/HubPRs.swift), and the
/// host's copy of a file at that head (Hub/HubForgeLinks.swift, Review/ReviewRemoteHead.swift).
final class HubPRFetchTests: XCTestCase {
    private let fetchJSON = """
    {"repoRoot":"/tmp/scratch/app","number":12,"provider":"gitlab","remote":"origin","sourceRef":"refs/merge-requests/12/head",
     "headRef":"refs/genesis/pr/12/head","head":"aaaa1111bbbb2222cccc3333dddd4444eeee5555","base":"1234567890abcdef1234567890abcdef12345678",
     "baseRef":null,"mergeBase":"fedcba0987654321fedcba0987654321fedcba09","fetched":true,"elapsedMs":900,"warnings":[]}
    """

    private func decodePR(kind: String, headSha: String?, cross: Bool = false, headRepo: String = "null") throws -> HubPR {
        let web = kind == "gitlab" ? "https://gitlab.example.test/group/app" : "https://github.com/acme/app"
        let sha = headSha.map { "\"\($0)\"" } ?? "null"
        let json = """
        {"repo":"app","repoRoot":"/tmp/scratch/app","origin":{"kind":"\(kind)","host":"h","web":"\(web)"},
         "number":12,"title":"t","state":"OPEN","draft":false,"author":"alice","headBranch":"feature/widgets","baseBranch":"develop",
         "url":"\(web)/pull/12","labels":[],"reviewers":[],"headSha":\(sha),"crossRepository":\(cross),"headRepo":\(headRepo)}
        """
        return try JSONDecoder().decode(HubPR.self, from: Data(json.utf8))
    }

    func testArgumentsNameTheCheckoutTheHeadTheBaseAndTheTargetBranch() throws {
        let pr = try decodePR(kind: "gitlab", headSha: "aaaa1111")
        XCTAssertEqual(PRFetch.arguments(pr, root: "/tmp/scratch/app", base: "1234abcd"), [
            "hub", "pr", "fetch", "/tmp/scratch/app#12", "--json", "--provider", "gitlab",
            "--head", "aaaa1111", "--base", "1234abcd", "--base-branch", "develop",
        ])

        let unknown = try decodePR(kind: "github", headSha: nil)
        XCTAssertEqual(PRFetch.arguments(unknown, root: "/tmp/scratch/app", base: nil), [
            "hub", "pr", "fetch", "/tmp/scratch/app#12", "--json", "--provider", "github", "--base-branch", "develop",
        ], "no head: the verb always asks the host")
    }

    func testTheAnswerDecodesAndFailuresReadAsOneSentence() throws {
        let fetch = try JSONDecoder().decode(HubPRFetch.self, from: Data(fetchJSON.utf8))
        XCTAssertEqual(fetch.headRef, "refs/genesis/pr/12/head")
        XCTAssertEqual(fetch.mergeBase, "fedcba0987654321fedcba0987654321fedcba09")

        let auth = Data(#"{"error":"origin refused the fetch (Permission denied (publickey).)","code":"auth"}"#.utf8)
        XCTAssertEqual(PRFetch.sentence(stdout: auth, stderr: Data(), status: 1),
                       "Sign-in needed to fetch the PR head: origin refused the fetch (Permission denied (publickey).)")
        let missing = Data(#"{"error":"origin has no refs/pull/12/head","code":"ref-missing"}"#.utf8)
        XCTAssertTrue(PRFetch.sentence(stdout: missing, stderr: Data(), status: 1).hasPrefix("The host has no head for this PR"))
        let network = Data(#"{"error":"could not reach origin","code":"network"}"#.utf8)
        XCTAssertTrue(PRFetch.sentence(stdout: network, stderr: Data(), status: 1).hasPrefix("The host did not answer"))
        XCTAssertEqual(PRFetch.sentence(stdout: Data(), stderr: Data("boom\n".utf8), status: 2), "tools hub pr fetch exited 2: boom")
    }

    @MainActor
    func testTheRangeUsesTheFetchedHeadAndTheBaseTheFetchMadeSureOf() throws {
        let pr = try decodePR(kind: "gitlab", headSha: "aaaa1111")
        let fetch = try JSONDecoder().decode(HubPRFetch.self, from: Data(fetchJSON.utf8))

        XCTAssertEqual(PRsModel.scope(pr, detail: nil, fetch: fetch),
                       .range(base: fetch.base!, head: fetch.head, label: "!12 vs develop"))
        XCTAssertEqual(PRsModel.scope(pr, detail: nil),
                       .range(base: "origin/develop", head: "aaaa1111", label: "!12 vs develop"),
                       "a worktree PR keeps the list's head and origin/<base>")
    }

    func testTheHostsCopyOfAFileAtTheHead() throws {
        let github = try decodePR(kind: "github", headSha: nil)
        XCTAssertEqual(github.blobURL("abc123", path: "src/a b.ts", line: 7)?.absoluteString,
                       "https://github.com/acme/app/blob/abc123/src/a%20b.ts#L7")
        let gitlab = try decodePR(kind: "gitlab", headSha: nil)
        XCTAssertEqual(gitlab.blobURL("abc123", path: "src/a.ts")?.absoluteString,
                       "https://gitlab.example.test/group/app/-/blob/abc123/src/a.ts")
        let fork = try decodePR(kind: "gitlab", headSha: nil, cross: true, headRepo: "\"dave/app\"")
        XCTAssertEqual(fork.blobURL("abc123", path: "a.ts", line: 1)?.absoluteString,
                       "https://gitlab.example.test/dave/app/-/blob/abc123/a.ts#L1", "a GitLab fork's files live in the fork")
        XCTAssertNil(github.blobURL("", path: "a.ts"))

        let head = ReviewRemoteHead(branch: "feature/widgets", sha: "aaaa1111bbbb", base: "base0", blob: { _, _, _ in nil })
        XCTAssertEqual(head.commitRange, ["base0..aaaa1111bbbb"])
        XCTAssertEqual(ReviewRemoteHead(branch: "b", sha: "s", base: nil, blob: { _, _, _ in nil }).commitRange, ["s"])
        XCTAssertEqual(head.branchNote, "feature/widgets at aaaa1111bb, not checked out in this folder")
    }

    func testTheRemoteHeadMovesWithThePushOnScreen() throws {
        let fork = try decodePR(kind: "gitlab", headSha: nil, cross: true, headRepo: "\"dave/app\"")
        let head = ReviewRemoteHead(branch: "feature/widgets", sha: "aaaa1111bbbb", base: "base0", forge: fork.commitForge)

        // Reload to a newer push: links, the Committed list and the agent note name the new push.
        let newer = head.following(.range(base: "base1", head: "cccc2222dddd", label: "!12"))
        XCTAssertEqual(newer.sha, "cccc2222dddd")
        XCTAssertEqual(newer.commitRange, ["base1..cccc2222dddd"])
        XCTAssertEqual(newer.branchNote, "feature/widgets at cccc2222dd, not checked out in this folder")
        XCTAssertEqual(newer.hostURL("a.ts", 3)?.absoluteString, fork.blobURL("cccc2222dddd", path: "a.ts", line: 3)?.absoluteString)

        // A compare's new end is the push on screen; an end without a recorded base keeps the old one.
        let compared = head.following(.compare(from: CompareEnd(base: "base0", head: "aaaa1111bbbb"),
                                               to: CompareEnd(base: nil, head: "eeee3333ffff"), label: "x"))
        XCTAssertEqual(compared.commitRange, ["base0..eeee3333ffff"])

        // A single commit, a working-tree scope or a range to a moving name leave the PR's head alone,
        // and a commit's links still open at that commit.
        XCTAssertEqual(head.following(.commit(sha: "1234567abc", title: "one")).sha, "aaaa1111bbbb")
        XCTAssertEqual(head.following(.range(base: "base0", head: "HEAD", label: "x")).sha, "aaaa1111bbbb")
        XCTAssertEqual(head.following(.uncommitted).commitRange, ["base0..aaaa1111bbbb"])
        XCTAssertEqual(head.hostURL("a.ts", nil, at: "1234567abc")?.absoluteString,
                       fork.blobURL("1234567abc", path: "a.ts", line: nil)?.absoluteString)
        XCTAssertEqual(head.moved(to: "aaaa1111bbbb", base: "other").commitRange, ["base0..aaaa1111bbbb"], "the same push keeps its base")
    }

    func testAStandaloneReviewWindowRebuildsTheRemoteHeadFromItsArguments() throws {
        let fork = try decodePR(kind: "gitlab", headSha: nil, cross: true, headRepo: "\"dave/app\"")
        let args = ["--review", "--repo", "/work/app", "--range", "base0..aaaa1111bbbb", "--label", "!12"]
            + ReviewRemoteHead.launchArguments(branch: "feature/widgets", sha: "aaaa1111bbbb", base: "base0", forge: fork.commitForge)
        let head = try XCTUnwrap(ReviewRemoteHead(launchArguments: args))
        XCTAssertEqual(head.branch, "feature/widgets")
        XCTAssertEqual(head.commitRange, ["base0..aaaa1111bbbb"], "the Committed menu lists the PR's commits")
        XCTAssertEqual(head.hostURL("a.ts", 3)?.absoluteString, fork.blobURL("aaaa1111bbbb", path: "a.ts", line: 3)?.absoluteString,
                       "a line click opens the host's file, as in the hub")
        XCTAssertNotNil(head.hostURL("a.ts", 3))

        let noBase = try XCTUnwrap(ReviewRemoteHead(launchArguments: ReviewRemoteHead.launchArguments(branch: "b", sha: "s", base: nil, forge: nil)))
        XCTAssertEqual(noBase.commitRange, ["s"])
        XCTAssertNil(noBase.hostURL("a.ts", nil))
        XCTAssertNil(ReviewRemoteHead(launchArguments: ["--review", "--repo", "/work/app"]), "a worktree PR has no remote head")
    }

    func testOnlyCommitAndRangeScopesWorkWithoutTheCheckout() {
        XCTAssertFalse(DiffScope.range(base: "a", head: "b", label: "l").readsTheCheckout)
        XCTAssertFalse(DiffScope.commit(sha: "a", title: "t").readsTheCheckout)
        for scope in [DiffScope.uncommitted, .unstaged, .staged, .branch, .lastTurns(1)] {
            XCTAssertTrue(scope.readsTheCheckout, "\(scope)")
        }
    }

    /// A show answer moves the row only while the row still has the head the request started from.
    func testAnOlderShowAnswerNeverRollsBackANewerListHead() {
        // show(A) starts, the list installs B, show(A) lands: the row keeps B.
        XCTAssertFalse(PRsModel.showMovesHead(started: "a", current: "b", shown: "a"))
        // show starts at A, a push makes the show answer B while the row still shows A: it follows B.
        XCTAssertTrue(PRsModel.showMovesHead(started: "a", current: "a", shown: "b"))
        XCTAssertFalse(PRsModel.showMovesHead(started: "a", current: "a", shown: "a"))
        XCTAssertFalse(PRsModel.showMovesHead(started: "a", current: "a", shown: nil))
    }

    /// show(A) starts, the list installs B, show(A) lands: its detail is stale and is not installed.
    func testAShowAnswerOlderThanTheListIsStale() {
        XCTAssertTrue(PRsModel.showIsStale(started: "a", current: "b", shown: "a"))
        XCTAssertFalse(PRsModel.showIsStale(started: "a", current: "b", shown: "b"))
        XCTAssertFalse(PRsModel.showIsStale(started: "a", current: "a", shown: "c"))
    }

    /// A list restored at 120 per project (an old global "Load more" raised it) holds 120 rows of a project:
    /// that project's next page asks for 160, never 80, which would replace its 120 rows with fewer.
    @MainActor
    func testAProjectsNextPageStartsFromTheRowsTheListAlreadyHolds() {
        XCTAssertEqual(PRsModel.projectLimit(own: nil, listed: 120, more: true), 160)
        XCTAssertEqual(PRsModel.projectLimit(own: 80, listed: 120, more: true), 160, "its own page is behind the list's")
        XCTAssertEqual(PRsModel.projectLimit(own: 200, listed: 120, more: true), 240, "its own page is ahead of the list's")
        XCTAssertEqual(PRsModel.projectLimit(own: nil, listed: 40, more: true), 80, "an untouched list: one page more")
        XCTAssertEqual(PRsModel.projectLimit(own: nil, listed: 40, more: false), 40, "opened from More projects")
        XCTAssertEqual(PRsModel.projectLimit(own: 120, listed: 40, more: false), 120, "a reload keeps the pages it has")
    }

}
