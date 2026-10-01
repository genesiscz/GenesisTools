import XCTest
@testable import GenesisTools

/// The review window's disk caches (Review/ReviewCache.swift): which slot a diff lives in, when its
/// contents are dropped, and blame entries that answer only while the file's text is unchanged.
final class ReviewCacheTests: XCTestCase {
    private var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory.appendingPathComponent("review-cache-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: dir)
    }

    private func source(_ session: String) -> AgentBlameSource {
        AgentBlameSource(provider: "claude", session: session, turn: "t1", ts: "2026-09-30T10:00:00Z", prompt: nil)
    }

    func testAPrsRangesShareOneSlotAndAnswerOnlyTheirOwnShas() {
        let old = DiffScope.range(base: "b1", head: "h1", label: "#7")
        let new = DiffScope.range(base: "b1", head: "h2", label: "#7")
        XCTAssertEqual(ReviewCache.diffSlot(repo: "/w", scope: old, session: nil), ReviewCache.diffSlot(repo: "/w", scope: new, session: nil),
                       "a new head of the same PR overwrites its slot instead of adding a file")
        XCTAssertNotEqual(ReviewCache.scopeKey(old, session: nil), ReviewCache.scopeKey(new, session: nil),
                          "the old head's snapshot must not answer the new head")
        XCTAssertNotEqual(ReviewCache.diffSlot(repo: "/w", scope: .lastTurns(1), session: "a"),
                          ReviewCache.diffSlot(repo: "/w", scope: .lastTurns(1), session: "b"), "a turns scope belongs to its session")
        XCTAssertNotEqual(ReviewCache.diffSlot(repo: "/w", scope: .uncommitted, session: nil),
                          ReviewCache.diffSlot(repo: "/x", scope: .uncommitted, session: nil))
    }

    func testAHugeDiffKeepsItsFileListAndCountsOnly() throws {
        let big = String(repeating: "x", count: ReviewCache.maxDiffBytes + 10)
        let file = DiffFile(id: "a", path: "a.txt", status: .modified, additions: 3, deletions: 1, oldContents: "", newContents: big)
        let data = try XCTUnwrap(ReviewCache.encodeDiff(.init(branch: "main", base: nil, files: [file]), scope: .uncommitted, session: nil))
        let diff = try JSONDecoder().decode(ReviewCache.Diff.self, from: data)
        XCTAssertTrue(diff.stripped)
        XCTAssertLessThan(data.count, 10_000)
        XCTAssertEqual(diff.files.map(\.path), ["a.txt"])
        XCTAssertEqual(diff.files[0].additions, 3)
        XCTAssertNil(diff.files[0].newContents)
        XCTAssertEqual(diff.files[0].skipped, ReviewCache.strippedNote)

        let small = DiffFile(id: "a", path: "a.txt", status: .modified, additions: 1, deletions: 0, oldContents: "a\n", newContents: "b\n")
        let kept = try JSONDecoder().decode(ReviewCache.Diff.self, from: XCTUnwrap(ReviewCache.encodeDiff(.init(branch: "main", base: nil, files: [small]), scope: .uncommitted, session: nil)))
        XCTAssertFalse(kept.stripped)
        XCTAssertEqual(kept.files, [small])
    }

    func testBlameAnswersFromDiskOnlyWhileTheFileTextIsUnchanged() throws {
        let repo = dir.appendingPathComponent("repo")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        try "one\ntwo\n".write(to: repo.appendingPathComponent("a.ts"), atomically: true, encoding: .utf8)
        try "x\n".write(to: repo.appendingPathComponent("b.ts"), atomically: true, encoding: .utf8)
        let cache = DiskCache(directory: dir.appendingPathComponent("cache"), namespace: "blame")

        let first = ReviewCache.readBlame(repo: repo.path, paths: ["a.ts", "b.ts"], in: cache)
        XCTAssertEqual(first.missing, ["a.ts", "b.ts"])
        // `tools` answers a.ts with the second of two sources; b.ts has no agent lines.
        let answer = AgentBlameResult(sources: [source("s0"), source("s1")], files: [AgentBlameFile(path: "a.ts", ranges: [[1, 2, 1]])], elapsedMs: 5)
        ReviewCache.writeBlame(answer, repo: repo.path, asked: first.missing, hashes: first.hashes, in: cache)

        let second = ReviewCache.readBlame(repo: repo.path, paths: ["a.ts", "b.ts"], in: cache)
        XCTAssertEqual(second.missing, [], "both files are answered from disk, b.ts with no agent lines")
        XCTAssertEqual(second.found.sources.map(\.session), ["s1"], "an entry keeps only the sources its ranges use")
        XCTAssertEqual(second.found.files.first { $0.path == "a.ts" }?.ranges, [[1, 2, 0]])

        try "one\nchanged\n".write(to: repo.appendingPathComponent("a.ts"), atomically: true, encoding: .utf8)
        XCTAssertEqual(ReviewCache.readBlame(repo: repo.path, paths: ["a.ts", "b.ts"], in: cache).missing, ["a.ts"],
                       "new text on disk: the cached lines would name other lines, so it asks again")
    }

    func testCombinedBlamePointsTheSecondRangesPastTheFirstSources() {
        let first = AgentBlameResult(sources: [source("s0")], files: [AgentBlameFile(path: "a", ranges: [[1, 1, 0]])], elapsedMs: nil)
        let second = AgentBlameResult(sources: [source("s1")], files: [AgentBlameFile(path: "b", ranges: [[4, 5, 0]])], elapsedMs: 9)
        let both = ReviewCache.combine(first, second)
        XCTAssertEqual(both.sources.map(\.session), ["s0", "s1"])
        XCTAssertEqual(both.files.map(\.ranges), [[[1, 1, 0]], [[4, 5, 1]]])
    }

    func testCachedThreadCardsShowWithoutReplyOrResolve() {
        let live = RenderedLiveThread(notes: [], resolved: false, resolvable: true, canReply: true)
        let card = RenderedComment(id: "live:T1", fileId: "f", side: .additions, startLine: 1, endLine: 1, body: "", author: "@bob", when: "",
                                   state: "open", remote: true, kind: "thread", live: live)
        let shown = PRThreadRendering.readOnly(card)
        XCTAssertEqual(shown.live?.canReply, false)
        XCTAssertEqual(shown.live?.resolvable, false)
        XCTAssertEqual(shown.body, card.body)
    }

    /// A range on commit ids is fixed; one on a name (HEAD, origin/main, a fallback base) follows file events.
    func testOnlyARangeOfCommitIDsIgnoresFileEvents() {
        let a = "1234567890abcdef1234567890abcdef12345678"
        let b = "abcdef1234567890abcdef1234567890abcdef12"
        XCTAssertFalse(DiffScope.range(base: a, head: b, label: "PR").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: "origin/main", head: b, label: "PR").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: a, head: "HEAD", label: "PR").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: a, head: b, label: "PR", fallbackBase: "origin/main").followsWorkingTree)
        XCTAssertFalse(DiffScope.commit(sha: a, title: "x").followsWorkingTree)
    }

}
