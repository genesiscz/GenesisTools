import XCTest
@testable import GenesisTools

/// Keyboard-first review and "Fix these threads": the argv of `tools hub pr fix`, the order j / k walk
/// the thread cards in, and n / p over the files. Nothing here runs `tools` or types into a pane.
final class ReviewKeysTests: XCTestCase {
    private let files = [
        DiffFile(id: "f1", path: "src/a.ts", status: .modified, additions: 1, deletions: 0),
        DiffFile(id: "f2", path: "src/b.ts", status: .modified, additions: 1, deletions: 0),
        DiffFile(id: "f3", path: "src/c.ts", status: .modified, additions: 1, deletions: 0),
    ]

    private func card(_ id: String, file: String, line: Int, kind: String = "thread", live: Bool = true) -> RenderedComment {
        RenderedComment(id: id, fileId: file, side: .additions, startLine: line, endLine: line, body: "", author: "@bob", when: "",
                        state: "open", remote: true, kind: kind,
                        live: live ? RenderedLiveThread(notes: [], resolved: false, resolvable: true, canReply: true) : nil)
    }

    // MARK: argv

    func testTheFixVerbNamesTheCheckoutThePrAndTheThreads() {
        XCTAssertEqual(
            PRCommand.fix(.ref("https://github.com/acme/shop/pull/7"), repo: "/work/shop", threads: ["T1", "T2"], session: "abc12345"),
            ["hub", "pr", "fix", "--repo", "/work/shop", "--pr", "https://github.com/acme/shop/pull/7", "--threads", "T1,T2",
             "--session", "abc12345", "--json"]
        )
        XCTAssertEqual(
            PRCommand.fix(.repo("/work/shop"), repo: "/work/shop", threads: ["T1"], dryRun: true),
            ["hub", "pr", "fix", "--repo", "/work/shop", "--threads", "T1", "--dry-run", "--json"],
            "a branch target has no --pr, and a plan sends nothing"
        )
        XCTAssertTrue(PRCommand.fix(.repo("/w"), repo: "/w", threads: ["T1"], send: false).contains("--no-send"),
                      "a new agent only needs the task file and its prompt")
    }

    func testPostingAPendingDraftPublishesOnceThenDeletesTheDraft() {
        let target = PRTarget.ref("https://github.com/acme/shop/pull/7")
        let steps = PRCommand.postPendingDraft(target, draftId: "PRRC_9", path: "src/cart.ts", line: 14, startLine: nil,
                                               side: .additions, bodyFile: "/tmp/b.md")
        XCTAssertEqual(steps.count, 2)
        XCTAssertEqual(steps[0], PRCommand.comment(target, path: "src/cart.ts", line: 14, startLine: nil, side: .additions, bodyFile: "/tmp/b.md"),
                       "the comment is published on its own line first")
        XCTAssertEqual(steps[1], ["hub", "pr", "draft", "delete", "PRRC_9", "--pr", "https://github.com/acme/shop/pull/7", "--json"],
                       "then the pending draft of the same comment goes, so the PR shows it once")
        XCTAssertFalse(steps.flatMap { $0 }.contains("publish"), "publishing the review would send every other draft")
    }

    func testTheFixVerbNeverPublishes() {
        let args = PRCommand.fix(.repo("/w"), repo: "/w", threads: ["T1"], session: "s")
        XCTAssertFalse(args.contains("publish"))
        XCTAssertFalse(args.contains("reply"))
    }

    // MARK: j / k

    func testThreadCardsGoFileByFileThenByLineAndSkipEverythingButLiveThreads() {
        let cards = ReviewKeyNav.threadCards([
            card("live:c", file: "f3", line: 2),
            card("live:b2", file: "f2", line: 40),
            card("live:b1", file: "f2", line: 5),
            card("local:x", file: "f1", line: 1, kind: "local", live: false),
            card("draft:y", file: "f1", line: 1, kind: "draft", live: false),
            card("thread:old", file: "f1", line: 9, live: false),
        ], files: files)
        XCTAssertEqual(cards.map(\.id), ["live:b1", "live:b2", "live:c"])
    }

    func testJAndKWrapAroundFromTheMarkedCard() {
        let cards = ReviewKeyNav.threadCards([card("live:1", file: "f1", line: 1), card("live:2", file: "f2", line: 1), card("live:3", file: "f3", line: 1)], files: files)
        XCTAssertEqual(ReviewKeyNav.step(cards, from: "live:2", by: 1, files: files, selectedFile: nil), "live:3")
        XCTAssertEqual(ReviewKeyNav.step(cards, from: "live:3", by: 1, files: files, selectedFile: nil), "live:1")
        XCTAssertEqual(ReviewKeyNav.step(cards, from: "live:1", by: -1, files: files, selectedFile: nil), "live:3")
    }

    func testWithNoMarkJStartsAtTheSelectedFileAndKBeforeIt() {
        let cards = ReviewKeyNav.threadCards([card("live:1", file: "f1", line: 1), card("live:3", file: "f3", line: 1)], files: files)
        XCTAssertEqual(ReviewKeyNav.step(cards, from: nil, by: 1, files: files, selectedFile: "f2"), "live:3")
        XCTAssertEqual(ReviewKeyNav.step(cards, from: nil, by: -1, files: files, selectedFile: "f2"), "live:1")
        XCTAssertEqual(ReviewKeyNav.step(cards, from: "gone", by: 1, files: files, selectedFile: nil), "live:1",
                       "a mark whose card left the diff starts over")
        XCTAssertNil(ReviewKeyNav.step([], from: nil, by: 1, files: files, selectedFile: nil))
    }

    // MARK: n / p, ids

    func testNAndPStopAtTheEnds() {
        XCTAssertEqual(ReviewKeyNav.stepFile(files, from: "f2", by: 1), "f3")
        XCTAssertEqual(ReviewKeyNav.stepFile(files, from: "f3", by: 1), "f3")
        XCTAssertEqual(ReviewKeyNav.stepFile(files, from: "f1", by: -1), "f1")
        XCTAssertEqual(ReviewKeyNav.stepFile(files, from: nil, by: -1), "f3")
        XCTAssertNil(ReviewKeyNav.stepFile([], from: nil, by: 1))
    }

    func testACardIdNamesItsThread() {
        XCTAssertEqual(ReviewKeyNav.threadID(ofCard: "live:PRRT_1"), "PRRT_1")
        XCTAssertEqual(ReviewKeyNav.threadID(ofCard: "thread:PRRT_1"), "PRRT_1")
        XCTAssertEqual(ReviewKeyNav.threadID(ofCard: "PRRT_1"), "PRRT_1")
    }

    // MARK: agent blame

    private func source(_ session: String, _ turn: String) -> AgentBlameSource {
        AgentBlameSource(provider: "claude", session: session, turn: turn, ts: "2026-09-24T10:00:00Z", prompt: "fix the cart total")
    }

    func testBlameAnswersMergeOnceEachTurnAndPointAtTheDiffsFileIds() {
        var state = AgentBlameState()
        state.merge(AgentBlameResult(sources: [source("s1", "t1"), source("s1", "t2")],
                                     files: [AgentBlameFile(path: "src/a.ts", ranges: [[1, 3, 1], [5, 5, 0]])], elapsedMs: 5),
                    files: files, asked: ["f1"])
        state.merge(AgentBlameResult(sources: [source("s1", "t2"), source("s2", "t9")],
                                     files: [AgentBlameFile(path: "src/b.ts", ranges: [[2, 2, 1], [4, 4, 0], [9, 9, 7]])], elapsedMs: 5),
                    files: files, asked: ["f2", "f3"])
        XCTAssertEqual(state.sources.map(\.turn), ["t1", "t2", "t9"], "t2 came twice and is listed once")
        XCTAssertEqual(state.ranges["f1"], [[1, 3, 1], [5, 5, 0]])
        XCTAssertEqual(state.ranges["f2"], [[2, 2, 2], [4, 4, 1]], "indices follow the merged list; an unknown one is dropped")
        XCTAssertEqual(state.payload.loaded, ["f1", "f2", "f3"], "a file with no agent lines counts as asked")
        XCTAssertNil(state.source(at: 3))
    }

    func testBlameAsksOnlyForFilesWithNewLinesAndOpensTheTurnBySearch() {
        var deleted = DiffFile(id: "d", path: "gone.ts", status: .deleted, additions: 0, deletions: 4)
        deleted.skipped = nil
        XCTAssertNil(AgentBlame.arguments(repo: "/w", files: [deleted], scope: .branch))
        XCTAssertEqual(AgentBlame.arguments(repo: "/w", files: [files[0], deleted], scope: .branch),
                       ["agents", "blame", "--repo", "/w", "--files", "src/a.ts", "--json"])
        let comma = DiffFile(id: "c", path: "src/a,b.ts", status: .modified, additions: 2, deletions: 0)
        XCTAssertEqual(AgentBlame.arguments(repo: "/w", files: [files[0], comma], scope: .branch),
                       ["agents", "blame", "--repo", "/w", "--files", "src/a.ts", "src/a,b.ts", "--json"],
                       "one argument per path: the CLI no longer splits on commas")
        XCTAssertEqual(AgentBlame.hubArguments(for: source("s1", "t1")),
                       ["--hub", "--session", "s1", "--tab", "transcript", "--transcript-query", "fix the cart total"])
        XCTAssertEqual(AgentBlame.query("there's a weird gap here [Image #38] of the bgcolor"), "there's a weird gap here",
                       "the search stops before the first bracket, so it matches the turn's text as written")
        XCTAssertEqual(AgentBlame.query("make the cart total round up to cents please"), "make the cart total round up")
        XCTAssertNil(AgentBlame.query("<pasted_content id=\"5f\">"), "a prompt that starts with a tag has no words to search")
        XCTAssertNil(AgentBlame.query(nil))
    }

    /// `tools agents blame` numbers the lines of the file on disk; the page looks them up by the diff's
    /// new-side line. Where the new side is a commit or the index, those numbers name other lines.
    func testBlameRunsOnlyWhereTheDiffsNewSideIsTheWorkingTree() {
        let working: [DiffScope] = [.uncommitted, .unstaged, .branch, .lastTurns(2)]
        let elsewhere: [DiffScope] = [.staged, .commit(sha: "abc1234", title: "fix totals"),
                                      .range(base: "a1", head: "b2", label: "PR head")]
        for scope in working {
            XCTAssertNotNil(AgentBlame.arguments(repo: "/w", files: [files[0]], scope: scope), "\(scope.title) reads the working tree")
        }
        for scope in elsewhere {
            XCTAssertNil(AgentBlame.arguments(repo: "/w", files: [files[0]], scope: scope),
                         "\(scope.title): its new side is not on disk, so blame's line numbers would name other lines")
        }
    }

    func testOnlyTheReviewKeysParse() {
        XCTAssertEqual(ReviewKey(rawValue: "j"), .nextThread)
        XCTAssertEqual(ReviewKey(rawValue: "s"), .submit)
        XCTAssertNil(ReviewKey(rawValue: "?"), "the key list stays on the page")
        XCTAssertNil(ReviewKey(rawValue: "J"))
    }
}
