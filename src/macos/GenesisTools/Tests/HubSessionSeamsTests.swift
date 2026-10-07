import XCTest
@testable import GenesisTools

/// The session readers the hub and the review window run through `tools`: every sample below has
/// the exact field set the command printed on 2026-09-24 (values invented). A field Swift declares
/// non-optional that the command can print as null fails the whole decode, so the nulls are kept.
final class HubSessionSeamsTests: XCTestCase {
    // MARK: tools agents changes

    /// `agents changes <id> --tool <toolUseId> --json`: a Bash call with a diff, and a file whose
    /// before-state nothing recorded (both oids null, `skipped` says why).
    private let oneToolJSON = """
    {"session":"s-1","turn":"p-1","turns":["p-1"],"files":[
      {"path":"/tmp/gt/app/src/a.ts","beforeOid":"1111111111111111111111111111111111111111","afterOid":"2222222222222222222222222222222222222222","status":"modified","source":"bash","skipped":null,"via":"bash","confidence":"high","toolUseIds":["toolu_a"],"span":1,"diff":"--- a/src/a.ts\\n+++ b/src/a.ts\\n@@ -1,1 +1,1 @@\\n-one\\n+two\\n","added":1,"removed":1},
      {"path":"/tmp/gt/app/src/b.ts","beforeOid":null,"afterOid":null,"status":"modified","source":"edit","skipped":"no-before-state","via":"edit","confidence":"exact","toolUseIds":["toolu_a"],"span":1,"agentIds":["agent-1"],"diff":null,"diffSkipped":"missing-blob"}
    ],"excluded":[{"path":"/tmp/x.log","reason":"temp-dir","via":"bash"}],"log":"/tmp/gt/.genesis-tools/agents/s-1/changes.jsonl","objects":"/tmp/gt/.genesis-tools/agents/_objects","transcript":null}
    """

    func testOneToolCallDecodesDiffAndSkippedFile() {
        let files = CLIToolChangeSource.decode(oneToolJSON)

        XCTAssertEqual(files.map(\.path), ["/tmp/gt/app/src/a.ts", "/tmp/gt/app/src/b.ts"])
        XCTAssertEqual(files[0].counts.additions, 1)
        XCTAssertEqual(files[0].firstLine, 1)
        // An unknown before-state is not a creation: status stays "modified", no diff is drawn.
        XCTAssertEqual(files[1].status, "modified")
        XCTAssertNil(files[1].beforeBlob)
        // The log's reason, not the diff's: "missing-blob" would read as a lost blob.
        XCTAssertEqual(files[1].skipReason, "no-before-state")
        XCTAssertEqual(files[1].skipLabel, "no diff: state before the call unknown")
    }

    func testLastTurnsDecodeAndStatus() throws {
        let log = try JSONDecoder().decode(GitWorkingTreeSource.TurnChanges.self, from: Data(oneToolJSON.utf8))
        XCTAssertEqual(log.objects, "/tmp/gt/.genesis-tools/agents/_objects")

        let known = log.files[0]
        let unknownBefore = log.files[1]
        XCTAssertEqual(GitWorkingTreeSource.turnStatus(known, exists: true), .modified)
        XCTAssertEqual(GitWorkingTreeSource.turnStatus(known, exists: false), .deleted)
        // The file existed before the turn; nothing recorded its text. Never "added".
        XCTAssertEqual(GitWorkingTreeSource.turnStatus(unknownBefore, exists: true), .modified)
        XCTAssertEqual(GitWorkingTreeSource.turnStatus(unknownBefore, exists: false), .deleted)

        let created = try JSONDecoder().decode(
            GitWorkingTreeSource.TurnChanges.File.self,
            from: Data(#"{"path":"/tmp/gt/n.ts","beforeOid":null,"skipped":null}"#.utf8)
        )
        XCTAssertEqual(GitWorkingTreeSource.turnStatus(created, exists: true), .added)
        XCTAssertNil(GitWorkingTreeSource.turnStatus(created, exists: false))
    }

    // MARK: tools agents blame

    func testBlameDecodesWithExtraFieldsAndNullPrompt() throws {
        let json = """
        {"sources":[
          {"provider":"claude","session":"s-1","turn":"p-1","toolUseId":null,"ts":"2026-03-01T10:00:00.000Z","prompt":"fix the parser"},
          {"provider":"codex","session":"s-2","turn":"p-2","toolUseId":"call_1","ts":"2026-03-01T11:00:00.000Z","prompt":null}
        ],"files":[{"path":"src/a.ts","ranges":[[1,3,0],[5,5,1]]}],"scanned":{"logs":3,"events":10,"blobs":4},"elapsedMs":17}
        """
        let result = try JSONDecoder().decode(AgentBlameResult.self, from: Data(json.utf8))

        XCTAssertEqual(result.sources.map(\.prompt), ["fix the parser", nil])
        XCTAssertEqual(result.files.first?.ranges, [[1, 3, 0], [5, 5, 1]])
        XCTAssertEqual(result.elapsedMs, 17)

        let empty = try JSONDecoder().decode(AgentBlameResult.self, from: Data(#"{"sources":[],"files":[],"scanned":{"logs":0,"events":0,"blobs":0},"elapsedMs":4}"#.utf8))
        XCTAssertTrue(empty.files.isEmpty)
    }

    // MARK: tools ai sessions subagents / grep / tail

    func testSubagentsDecodeNullsAndStates() throws {
        let json = """
        {"sessionId":"s-1","subagents":[
          {"id":"a1","name":null,"description":"read the parser","agentType":"Explore","model":"sonnet","toolUseId":"toolu_1","startedAt":"2026-03-01T10:00:00.000Z","lastAt":"2026-03-01T10:05:00.000Z","state":"done","bytes":1200,"filePath":"/tmp/gt/s-1/subagents/agent-a1.jsonl"},
          {"id":"a2","name":"fixer","description":null,"agentType":null,"model":null,"toolUseId":null,"startedAt":null,"lastAt":"2026-03-01T10:06:00.000Z","state":"stopped","bytes":10,"filePath":"/tmp/gt/s-1/subagents/agent-a2.jsonl"},
          {"id":"a3","name":null,"description":"run the tests","agentType":"general-purpose","model":"opus","toolUseId":"toolu_3","startedAt":"2026-03-01T10:07:00.000Z","lastAt":"2026-03-01T10:08:00.000Z","state":"running","bytes":99,"filePath":"/tmp/gt/s-1/subagents/agent-a3.jsonl"}
        ]}
        """
        let rows = try HubSubagents.decode(Data(json.utf8))

        XCTAssertEqual(rows.map(\.id), ["toolu_1", "a2", "toolu_3"])
        // "stopped": its transcript stopped growing before it reported back, so it reads as idle.
        XCTAssertEqual(rows.map(\.state), [.done, .idle, .running])
        XCTAssertEqual(rows[1].summary, "fixer: a2")
        // No start stays no start: its last write would sort it as a newly started agent.
        XCTAssertNil(rows[1].startedAt)
        XCTAssertNotNil(rows[0].startedAt)
        XCTAssertEqual(try HubSubagents.decode(Data(#"{"sessionId":"s-9","subagents":[]}"#.utf8)), [])
    }

    func testGrepHitsDecode() throws {
        let hits = try JSONDecoder().decode(
            HubSessionSearch.Hits.self,
            from: Data(#"{"sessionId":"s-1","total":12,"turns":[3,17,902],"truncated":false}"#.utf8)
        )
        XCTAssertEqual(hits.turns, [3, 17, 902])
        XCTAssertEqual(hits.total, 12)
    }

    func testTailTurnsDecodeWithIndexUsageAndNullEnd() throws {
        let json = """
        {"provider":"claude","sessionId":"s-1","filePath":"/tmp/gt/s-1.jsonl","byteSize":2048,"truncated":true,"nextOffset":18,
         "turns":[
          {"id":"u-1","role":"user","at":"2026-03-01T10:00:00.000Z","text":"fix it","tools":[],"index":3},
          {"id":"m-1","role":"assistant","at":null,"text":"","tools":[{"id":"toolu_1","name":"Bash","inputPreview":"ls","result":null,"isError":false,"exitCode":0,"resultChars":12}],"usage":{"inputTokens":10,"cacheReadTokens":900,"outputTokens":40},"index":17}
         ],
         "totals":{"modelCalls":1,"inputTokens":10,"cacheReadTokens":900,"outputTokens":40,"reasoningTokens":0},"terminated":null}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))

        XCTAssertEqual(envelope.turns.map(\.index), [3, 17])
        XCTAssertEqual(envelope.turns[1].tools.first?.exitCode, 0)
        XCTAssertNil(envelope.terminated)
    }

    func testASparseSearchHitOpensItsOwnSectionInsteadOfJoiningAnEarlierPrompt() throws {
        let json = """
        [{"id":"u2","role":"user","text":"first prompt","tools":[],"index":2},
         {"id":"a3","role":"assistant","text":"its reply","tools":[],"index":3},
         {"id":"a50","role":"assistant","text":"a reply to a prompt not in the list","tools":[],"index":50},
         {"id":"u60","role":"user","text":"window prompt","tools":[],"index":60}]
        """
        let turns = try JSONDecoder().decode([TranscriptTurn].self, from: Data(json.utf8))
        let document = TranscriptDocument.build(turns)
        XCTAssertEqual(document.sections.map(\.id), ["s-u2", "s-gap-a50", "s-u60"])
        XCTAssertEqual(document.sections.map(\.number), [3, 0, 61])
    }

    func testSpendCacheReusesValidEmptyResultsAndExpiresWithoutCachingFailures() throws {
        let cache = HubSpend.Cache(ttl: 30)
        var now = Date(timeIntervalSince1970: 1000)
        var calls = 0
        func read() -> Data {
            calls += 1
            return Data(#"{"totals":{"totalCost":0}}"#.utf8)
        }
        for _ in 0..<10 {
            XCTAssertNil(try cache.fetch(key: "fixture", revision: 1, now: { now }, run: read))
        }
        XCTAssertEqual(calls, 1)
        now.addTimeInterval(31)
        _ = try cache.fetch(key: "fixture", revision: 1, now: { now }, run: read)
        _ = try cache.fetch(key: "fixture", revision: 2, now: { now }, run: read)
        XCTAssertEqual(calls, 3)
        XCTAssertThrowsError(try cache.fetch(key: "bad", revision: 1) { Data("invalid".utf8) })
        _ = try cache.fetch(key: "bad", revision: 1, run: read)
        XCTAssertEqual(calls, 4)
    }

    @MainActor
    func testSessionSearchAndTimeGroupsPreserveExactRowsAndBoundaries() {
        let now = Date(timeIntervalSince1970: 1_800_000_000)
        let live = HubSession(sessionId: "live", title: "Žlutý", project: "WORK", mtime: now.addingTimeInterval(-599).timeIntervalSince1970 * 1000)
        let today = HubSession(sessionId: "today", mtime: now.addingTimeInterval(-600).timeIntervalSince1970 * 1000)
        let old = HubSession(sessionId: "old", mtime: now.addingTimeInterval(-172800).timeIntervalSince1970 * 1000)
        let groups = HubModel.timeGroups([old, live, today], now: now)
        XCTAssertEqual(groups.map(\.title), ["Live", "Today", "Earlier"])
        XCTAssertEqual(groups.flatMap(\.rows).map(\.sessionId), ["live", "today", "old"])
        XCTAssertTrue(HubModel.searchText(live).contains("žlutý work"))
    }

    func testSearchMergeUsesTheLatestWindowAndReplacesAnEarlierHitNowLoaded() throws {
        let old = try JSONDecoder().decode([TranscriptTurn].self, from: Data(#"[{"id":"old","role":"user","text":"match earlier","tools":[],"index":1}]"#.utf8))
        let current = try JSONDecoder().decode([TranscriptTurn].self, from: Data(#"[{"id":"new","role":"assistant","text":"match live","tools":[]}]"#.utf8))
        let merged = HubSessionDetailHost.searchTurns(earlier: old, window: current, start: 10)
        XCTAssertEqual(merged.map(\.text), ["match earlier", "match live"])
        XCTAssertEqual(merged.map(\.index), [1, 10])
        XCTAssertEqual(HubSessionDetailHost.searchTurns(earlier: old, window: current, start: 0).map(\.text), ["match live"])
    }

    // MARK: tools ai-spend session

    func testSpendCacheCoalescesConcurrentReadersAndAllowsExplicitRefresh() async throws {
        let cache = HubSpend.Cache()
        let entered = expectation(description: "runner entered")
        let release = DispatchSemaphore(value: 0)
        let first = Task.detached {
            try cache.fetch(key: "codex:fixture", revision: 1) {
                entered.fulfill()
                guard release.wait(timeout: .now() + 3) == .success else { throw CocoaError(.userCancelled) }
                return Data(#"{"totals":{"totalCost":2}}"#.utf8)
            }
        }
        await fulfillment(of: [entered], timeout: 2)
        let second = Task.detached {
            try cache.fetch(key: "codex:fixture", revision: 1) {
                XCTFail("Concurrent reader started another runner")
                return Data()
            }
        }
        release.signal()
        let a = try await first.value
        let b = try await second.value
        XCTAssertEqual(a?.usd, 2)
        XCTAssertEqual(b?.usd, 2)
        let fresh = try cache.fetch(key: "codex:fixture", revision: 1, force: true) {
            Data(#"{"totals":{"totalCost":3}}"#.utf8)
        }
        XCTAssertEqual(fresh?.usd, 3)
    }

    func testSpendEstimateReadsTotalCostAndModels() {
        let json = """
        {"session":[{"agent":"codex","cacheCreationTokens":0,"cacheReadTokens":800,"inputTokens":100,"metadata":{"lastActivity":"2026-03-01T10:00:00.000Z"},
          "modelBreakdowns":[{"modelName":"model-a","inputTokens":100,"outputTokens":10,"cacheCreationTokens":0,"cacheReadTokens":800,"cost":3}],
          "modelsUsed":["model-a"],"outputTokens":10,"period":"rollout-2026-03-01T10-00-00-s-1","totalCost":3,"totalTokens":910}],
         "totals":{"inputTokens":100,"outputTokens":10,"cacheCreationTokens":0,"cacheReadTokens":800,"totalTokens":910,"totalCost":3}}
        """
        // An integral cost is still a JSON number the reader must take as a price.
        let estimate = HubSpend.estimate(from: Data(json.utf8))
        XCTAssertEqual(estimate?.usd, 3)
        XCTAssertEqual(estimate?.note.contains("model-a"), true)

        let none = #"{"session":[],"totals":{"inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"totalTokens":0,"totalCost":0}}"#
        XCTAssertNil(HubSpend.estimate(from: Data(none.utf8)))
    }
}
