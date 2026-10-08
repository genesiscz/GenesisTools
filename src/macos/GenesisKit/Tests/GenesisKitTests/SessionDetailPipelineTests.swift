import AppKit
import XCTest
@testable import GenesisKit

/// The session screen's load pipeline: tool-change batches, the one-builder document queue, paging and the
/// main-thread meter. Moved from GenesisTools' HubLogicTests and HubSessionSeamsTests with the code.
final class SessionDetailPipelineTests: XCTestCase {
    // MARK: Tool-change batches

    /// Records what the batcher sends, and answers each call with one file named after it.
    private actor FetchLog {
        var batches: [[String]] = []
        var fail = false
        /// Calls left out of the answer, as cut or unreadable output leaves them out.
        var omit: Set<String> = []

        func record(_ ids: [String]) -> [String: [ToolFileChange]]? {
            batches.append(ids)
            if fail { return nil }
            return Dictionary(uniqueKeysWithValues: ids.filter { !omit.contains($0) }.map { ($0, [ToolFileChange(path: "/tmp/\($0).ts", status: "modified", unifiedDiff: "@@ -1 +1 @@", beforeBlob: nil, afterBlob: nil)]) })
        }

        func setFail(_ value: Bool) { fail = value }
        func setOmit(_ value: Set<String>) { omit = value }
    }

    func testRowsThatAskTogetherShareOneRunAndAnAnswerIsKept() async {
        let log = FetchLog()
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let answers = await withTaskGroup(of: (String, [ToolFileChange]).self) { group in
            for id in ["a", "b", "c", "d", "e"] {
                group.addTask { (id, await batcher.request(sessionId: "s1", toolUseId: id)) }
            }
            var all: [String: [ToolFileChange]] = [:]
            for await (id, files) in group { all[id] = files }
            return all
        }
        XCTAssertEqual(answers["c"]?.first?.path, "/tmp/c.ts")
        let batches = await log.batches
        XCTAssertEqual(batches.count, 1)
        XCTAssertEqual(Set(batches[0]), ["a", "b", "c", "d", "e"])

        _ = await batcher.request(sessionId: "s1", toolUseId: "c")
        let after = await log.batches
        XCTAssertEqual(after.count, 1, "a kept answer starts no run")
    }

    func testARowThatLeavesBeforeItsBatchIsNotSent() async {
        let log = FetchLog()
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let gone = Task { await batcher.request(sessionId: "s1", toolUseId: "gone") }
        let stays = Task { await batcher.request(sessionId: "s1", toolUseId: "stays") }
        try? await Task.sleep(for: .milliseconds(20))
        gone.cancel()
        let goneFiles = await gone.value
        let staysFiles = await stays.value
        XCTAssertEqual(goneFiles.count, 0)
        XCTAssertEqual(staysFiles.count, 1)
        let batches = await log.batches
        XCTAssertEqual(batches, [["stays"]])
    }

    func testAFailedRunIsNotKeptSoTheRowAsksAgain() async {
        let log = FetchLog()
        await log.setFail(true)
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let first = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(first.count, 0)
        await log.setFail(false)
        let second = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(second.count, 1)
        let batches = await log.batches
        XCTAssertEqual(batches.count, 2)
    }

    func testACallMissingFromTheAnswerIsNotKeptSoTheRowAsksAgain() async {
        let log = FetchLog()
        await log.setOmit(["a"])
        let batcher = ToolChangeBatcher { _, ids in await log.record(ids) }
        let first = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(first.count, 0)
        await log.setOmit([])
        let second = await batcher.request(sessionId: "s1", toolUseId: "a")
        XCTAssertEqual(second.count, 1)
        let batches = await log.batches
        XCTAssertEqual(batches.count, 2)
    }

    /// A server answer stores no blobs: the first "more context" on one of its files names the call whose run stores
    /// them, once; every file of that call is then stored, and a file of another call keeps its own owner.
    func testUnstoredBlobsNameTheirCallOnce() {
        let unstored = UnstoredBlobs()
        let a = ToolFileChange(path: "/r/a.ts", status: "modified", beforeBlob: "b1", afterBlob: "a1")
        let b = ToolFileChange(path: "/r/b.ts", status: "added", afterBlob: "a2")
        let c = ToolFileChange(path: "/r/c.ts", status: "modified", beforeBlob: "b3", afterBlob: "a3")
        unstored.add([a, b], sessionId: "s", toolUseId: "t1")
        unstored.add([c], sessionId: "s", toolUseId: "t2")

        XCTAssertEqual(unstored.take(b), UnstoredBlobs.Owner(sessionId: "s", toolUseId: "t1"))
        XCTAssertNil(unstored.take(a), "the run for t1 stored a's blobs too")
        XCTAssertEqual(unstored.take(c)?.toolUseId, "t2")
        XCTAssertNil(unstored.take(ToolFileChange(path: "/r/d.ts", status: "modified", afterBlob: "zz")))
    }

    func testTheBatchOutputDecodesPerToolCall() {
        let json = """
        {"session":"s1","tools":[
          {"toolUseId":"t1","files":[{"path":"/tmp/a.ts","beforeOid":"x","afterOid":"y","status":"modified","diff":"@@ -1 +1 @@\\n-a\\n+b"}],"excluded":[]},
          {"toolUseId":"t2","files":[],"excluded":[]}
        ]}
        """
        let decoded = BatchedToolChangeSource.decode(json)
        XCTAssertEqual(decoded["t1"]?.map(\.path), ["/tmp/a.ts"])
        XCTAssertEqual(decoded["t1"]?.first?.counts.additions, 1)
        XCTAssertEqual(decoded["t2"]?.count, 0)
    }


    func testBatchedToolCallsDecodePerCall() {
        let json = """
        {"session":"s-1","tools":[
          {"toolUseId":"toolu_a","files":[{"path":"/tmp/gt/app/a.ts","beforeOid":null,"afterOid":"3333333333333333333333333333333333333333","status":"added","source":"write","skipped":null,"via":"write","confidence":"exact","toolUseIds":["toolu_a"],"span":1,"diff":"--- /dev/null\\n+++ b/a.ts\\n@@ -0,0 +1,1 @@\\n+x\\n","added":1,"removed":0}],"excluded":[]},
          {"toolUseId":"toolu_none","files":[],"excluded":[]}
        ],"log":"/tmp/l","objects":"/tmp/o","transcript":null}
        """
        let byTool = BatchedToolChangeSource.decode(json)

        XCTAssertEqual(byTool["toolu_a"]?.map(\.status), ["added"])
        XCTAssertEqual(byTool["toolu_none"], [])
    }

    /// `agents changes <id> --last-turns N --json` as the review window's Last N turns reads it.

    @MainActor
    func testLatestDocumentWorkKeepsOneBuilderAndOnePendingRevision() async {
        let queue = TranscriptBuildQueue()
        let started = expectation(description: "first build starts")
        var release: CheckedContinuation<Void, Never>?
        var built: [Int] = []
        let first = Task { await queue.submit {
            built.append(0)
            await withCheckedContinuation { release = $0; started.fulfill() }
        } }
        await fulfillment(of: [started], timeout: 2)
        var tasks: [Task<Void, Never>] = []
        for revision in 1...8 {
            tasks.append(Task { await queue.submit { built.append(revision) } })
            await Task.yield()
        }
        release?.resume()
        await first.value
        for task in tasks { await task.value }
        XCTAssertEqual(built, [0, 8])
    }


    // MARK: Paging

    func testTheFirstPageIsAScreenfulUnlessTheEnvironmentSetsIt() {
        XCTAssertEqual(TranscriptPaging.firstPage(in: [:]), 12)
        XCTAssertEqual(TranscriptPaging.firstPage(in: ["GENESIS_HUB_FIRST_PAGE": "150"]), 150)
        XCTAssertEqual(TranscriptPaging.firstPage(in: ["GENESIS_TRANSCRIPT_FIRST_PAGE": "40", "GENESIS_HUB_FIRST_PAGE": "150"]), 40)
        XCTAssertEqual(TranscriptPaging.firstPage(in: ["GENESIS_TRANSCRIPT_FIRST_PAGE": "0"]), 12, "zero is no page")
        XCTAssertEqual(TranscriptPaging.refreshLimit(loaded: 12), 162)
        XCTAssertEqual(TranscriptPaging.refreshLimit(loaded: 0), 150)
    }

    func testARefreshAsksAgainUntilItsWindowReachesTheLatestTurn() {
        func envelope(next: Int, count: Int?, turns: Int) -> TranscriptEnvelope {
            TranscriptEnvelope(
                provider: "claude", sessionId: "s", filePath: "/tmp/s.jsonl", byteSize: 0, truncated: false, nextOffset: next,
                turns: (0..<turns).map { TranscriptTurn(id: "t\($0)", role: "user", text: "") },
                totals: nil, terminated: nil, turnCount: count
            )
        }
        XCTAssertEqual(TranscriptPaging.refetchLimit(after: envelope(next: 90, count: 120, turns: 50), start: 40, limit: 50), 80)
        XCTAssertNil(TranscriptPaging.refetchLimit(after: envelope(next: 120, count: 120, turns: 80), start: 40, limit: 80))
        // An older `tools` without a turn count: a full answer may have stopped short.
        XCTAssertEqual(TranscriptPaging.refetchLimit(after: envelope(next: 90, count: nil, turns: 50), start: 40, limit: 50), 100)
        XCTAssertNil(TranscriptPaging.refetchLimit(after: envelope(next: 70, count: nil, turns: 30), start: 40, limit: 50))
    }

    // MARK: Main-thread meter

    @MainActor
    func testTheMeterCountsABlockedPassAsTheLongest() {
        let meter = MainBusy.Meter()
        meter.start()
        let blocked = expectation(description: "a pass that blocks 60 ms")
        DispatchQueue.main.async {
            let end = CFAbsoluteTimeGetCurrent() + 0.06
            while CFAbsoluteTimeGetCurrent() < end {}
            blocked.fulfill()
        }
        wait(for: [blocked], timeout: 2)
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        let reading = meter.stop()
        XCTAssertGreaterThanOrEqual(reading.longestMs, 55)
        XCTAssertGreaterThanOrEqual(reading.busyMs, reading.longestMs)
        XCTAssertGreaterThan(reading.passes, 0)
        let after = meter.read()
        XCTAssertEqual(after, reading, "a stopped meter counts nothing more")
    }
}
