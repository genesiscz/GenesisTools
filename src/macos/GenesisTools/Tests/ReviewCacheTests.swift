import XCTest
import GenesisKit
@testable import GenesisToolsHost
@testable import GenesisToolsHub

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
        // The parent of a picked commit is fixed as well; a ref with an ancestor step is not.
        XCTAssertFalse(DiffScope.range(base: a + "^", head: b, label: "5 commits").followsWorkingTree)
        XCTAssertFalse(DiffScope.range(base: "1234567~2^2", head: b, label: "x").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: "HEAD^", head: b, label: "x").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: "origin/main~1", head: b, label: "x").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: a + "^{tree}", head: b, label: "x").followsWorkingTree)
        XCTAssertTrue(DiffScope.range(base: a + "^", head: b, label: "x", fallbackBase: "origin/main").followsWorkingTree)
    }

    /// The ref-only reads (commits, worktrees, base candidates) run again after a ref moves, never for a file or the index.
    func testOnlyRefEventsMoveRefs() {
        let root = URL(fileURLWithPath: "/repo/wt")
        let layout = ReviewRepositoryLayout(root: root, gitDirectory: URL(fileURLWithPath: "/repo/main/.git/worktrees/wt"),
                                            commonDirectory: URL(fileURLWithPath: "/repo/main/.git"))
        XCTAssertFalse(layout.movesRefs("/repo/wt/src/app.ts"))
        XCTAssertFalse(layout.movesRefs("/repo/main/.git/worktrees/wt/index"))
        XCTAssertFalse(layout.movesRefs("/repo/main/.git/objects/ab/cdef"))
        XCTAssertFalse(layout.movesRefs("/repo/main/.git/worktrees/other/index"))
        XCTAssertTrue(layout.matters("/repo/wt/src/app.ts"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/worktrees/wt/HEAD"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/refs/heads/feature"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/packed-refs"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/worktrees/other/HEAD"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/worktrees/wt/gitdir"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/worktrees/other/gitdir"))
        XCTAssertTrue(layout.movesRefs("/repo/main/.git/worktrees/new"))
    }

}

private final class RepoWatcherProbe: @unchecked Sendable {
    private let lock = NSLock()
    private var callback: (@Sendable (FileEventBatch) -> Void)?
    private var operations: [(String, Bool)] = []
    private var boundary: UInt64?

    func attach(_ callback: @escaping @Sendable (FileEventBatch) -> Void) {
        lock.lock()
        self.callback = callback
        lock.unlock()
    }

    func record(_ operation: String, since: UInt64? = nil) {
        lock.lock()
        operations.append((operation, Thread.isMainThread))
        if let since { boundary = since }
        lock.unlock()
    }

    func emit(_ batch: FileEventBatch) {
        lock.lock()
        let callback = callback
        lock.unlock()
        callback?(batch)
    }

    var state: (operations: [String], onMain: [Bool], boundary: UInt64?) {
        lock.lock()
        defer { lock.unlock() }
        return (operations.map(\.0), operations.map(\.1), boundary)
    }
}

private final class ControlledRepoStream: RepoWatchStream, @unchecked Sendable {
    let onStart: @Sendable (UInt64?) -> Bool
    let onStop: @Sendable () -> Void

    init(onStart: @escaping @Sendable (UInt64?) -> Bool, onStop: @escaping @Sendable () -> Void) {
        self.onStart = onStart
        self.onStop = onStop
    }

    func start(since eventID: UInt64?) -> Bool { onStart(eventID) }
    func stop() { onStop() }
}

extension ReviewCacheTests {
    @MainActor
    func testRepoWatcherNeverWaitsOnMainForStartOrStopAndDropsQueuedCallbacksAfterDeinit() async {
        let root = URL(fileURLWithPath: "/repo/watch-fixture")
        let layout = ReviewRepositoryLayout(root: root, gitDirectory: root.appendingPathComponent(".git"),
                                             commonDirectory: root.appendingPathComponent(".git"))
        let probe = RepoWatcherProbe()
        let entered = expectation(description: "background start entered")
        let stopped = expectation(description: "background stop completed")
        let mainRan = expectation(description: "main runs while native start is held")
        let release = DispatchSemaphore(value: 0)
        defer { release.signal() }
        var delivered = 0
        var watcher: RepoWatcher? = RepoWatcher(layout: layout, makeStream: { configuration, callback in
            XCTAssertFalse(configuration.ignoreSelf)
            XCTAssertEqual(configuration.latency, 0.35)
            probe.attach(callback)
            return ControlledRepoStream(onStart: { boundary in
                probe.record("start", since: boundary)
                entered.fulfill()
                if release.wait(timeout: .now() + 5) == .timedOut { XCTFail("start gate was not released") }
                return true
            }, onStop: {
                probe.record("stop")
                stopped.fulfill()
            })
        }) { _ in delivered += 1 }
        XCTAssertNotNil(watcher)
        await fulfillment(of: [entered], timeout: 2)
        probe.emit(.init(rescanRoots: [root.path]))
        watcher = nil
        DispatchQueue.main.async { mainRan.fulfill() }
        await fulfillment(of: [mainRan], timeout: 2)
        XCTAssertEqual(probe.state.operations, ["start"], "deinit returned while native start is held")
        XCTAssertEqual(delivered, 0, "the main-queue callback was cancelled before it ran")
        release.signal()
        await fulfillment(of: [stopped], timeout: 2)
        XCTAssertEqual(probe.state.operations, ["start", "stop"])
        XCTAssertEqual(probe.state.onMain, [false, false])
        XCTAssertNotNil(probe.state.boundary, "startup uses the event id captured before it was queued")
    }

    @MainActor
    func testRepoWatcherPreservesFlagsAndMainQueueBatchOrderAndCancelsAfterStop() async {
        let root = URL(fileURLWithPath: "/private/tmp/repo-watch-fixture")
        let reportedRoot = URL(fileURLWithPath: "/tmp/repo-watch-fixture")
        let layout = ReviewRepositoryLayout(root: root, gitDirectory: root.appendingPathComponent(".git"),
                                             commonDirectory: root.appendingPathComponent(".git"))
        let probe = RepoWatcherProbe()
        let started = expectation(description: "background start")
        let stopped = expectation(description: "background stop")
        let changed = expectation(description: "ordered batches on main")
        changed.expectedFulfillmentCount = 2
        var batches: [ReviewWatchBatch] = []
        var watcher: RepoWatcher?
        defer { watcher = nil }
        watcher = RepoWatcher(layout: layout, makeStream: { _, callback in
            probe.attach(callback)
            return ControlledRepoStream(onStart: { _ in started.fulfill(); return true }, onStop: { stopped.fulfill() })
        }) { batch in
            XCTAssertTrue(Thread.isMainThread)
            batches.append(batch)
            if batches.count == 2 { watcher?.stop() }
            changed.fulfill()
        }
        await fulfillment(of: [started], timeout: 2)
        probe.emit(.init(events: [
            .init(path: reportedRoot.appendingPathComponent("a.swift").path, flags: [.itemModified], id: 1),
            .init(path: reportedRoot.appendingPathComponent(".git/index").path, flags: [.itemModified], id: 2),
        ]))
        probe.emit(.init(events: [
            .init(path: reportedRoot.appendingPathComponent(".git/refs/heads/topic").path, flags: [.itemModified], id: 3),
        ], rescanRoots: [root.path], dropped: true))
        await fulfillment(of: [changed], timeout: 2)
        XCTAssertEqual(batches.count, 2)
        XCTAssertEqual(batches[0].paths, ["a.swift"])
        XCTAssertTrue(batches[0].index)
        XCTAssertFalse(batches[0].refs)
        XCTAssertTrue(batches[1].refs)
        XCTAssertTrue(batches[1].rescan)
        probe.emit(.init(rescanRoots: [root.path]))
        watcher?.stop()
        await fulfillment(of: [stopped], timeout: 2)
        let drained = expectation(description: "main queue drained")
        DispatchQueue.main.async { drained.fulfill() }
        await fulfillment(of: [drained], timeout: 2)
        XCTAssertEqual(batches.count, 2)
    }
}
