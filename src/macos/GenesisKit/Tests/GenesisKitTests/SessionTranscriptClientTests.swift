import XCTest
@testable import GenesisKit

final class SessionTranscriptClientTests: XCTestCase {
    func testDecodePairsToolNameAndPreview() throws {
        let json = """
        {"provider":"claude","sessionId":"abc","filePath":"/tmp/abc.jsonl","byteSize":12,"truncated":false,"nextOffset":2,"turns":[{"id":"a1","role":"assistant","at":null,"text":"reading","tools":[{"id":"toolu_01","name":"Read","inputPreview":"SessionDetailsPane.swift","result":"struct Pane","isError":false}]}]}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))
        XCTAssertEqual(envelope.provider, "claude")
        XCTAssertEqual(envelope.turns.count, 1)
        XCTAssertEqual(envelope.turns[0].tools[0].name, "Read")
        XCTAssertEqual(envelope.turns[0].tools[0].inputPreview, "SessionDetailsPane.swift")
        XCTAssertEqual(envelope.turns[0].tools[0].result, "struct Pane")
    }

    func testLiveFollowStartsAtTheOldestTurnThatCanStillChange() {
        func envelope(_ turns: [TranscriptTurn]) -> TranscriptEnvelope {
            TranscriptEnvelope(provider: "claude", sessionId: "fixture", filePath: "/fixture.jsonl",
                byteSize: 1, truncated: true, nextOffset: 50, turns: turns)
        }
        let done = TranscriptTool(id: "t1", name: "Read", inputPreview: "a", result: "ok")
        let waiting = TranscriptTool(id: "t2", name: "Bash", inputPreview: "b")
        let closed = (0..<5).map { TranscriptTurn(id: "c\($0)", role: "assistant", text: "", tools: [done]) }
        XCTAssertEqual(envelope(closed).liveFollowOffset, 49, "the last cached turn may still grow")
        var open = closed
        open[2] = TranscriptTurn(id: "open", role: "assistant", text: "", tools: [waiting])
        XCTAssertEqual(envelope(open).liveFollowOffset, 47, "a tool still waiting holds the follow at its turn")
        XCTAssertEqual(envelope([]).liveFollowOffset, 50)
    }

    func testArgumentsAskForJson() {
        XCTAssertEqual(
            SessionTranscriptClient.arguments(sessionId: "abc-def", limit: 40),
            ["sessions", "tail", "abc-def", "--json", "--limit", "40"]
        )
    }

    func testArgumentsCarryAnOffsetForAnEarlierPage() {
        XCTAssertEqual(
            SessionTranscriptClient.arguments(sessionId: "abc", limit: 100, offset: 120),
            ["sessions", "tail", "abc", "--json", "--limit", "100", "--offset", "120"]
        )
    }

    func testDecodeReadsExitCodeCostAndWindowStart() throws {
        let json = """
        {"provider":"claude","sessionId":"abc","filePath":"/tmp/abc.jsonl","byteSize":12,"truncated":true,"nextOffset":300,"totals":{"modelCalls":3,"costUsd":1.25},"turns":[{"id":"a1","role":"assistant","at":null,"text":"","tools":[{"id":"t1","name":"Bash","inputPreview":"false","result":"","isError":true,"exitCode":1,"resultChars":4096}]}]}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))
        XCTAssertEqual(envelope.turns[0].tools[0].exitCode, 1)
        XCTAssertEqual(envelope.turns[0].tools[0].resultChars, 4096)
        XCTAssertEqual(envelope.totals?.costUsd, 1.25)
        XCTAssertEqual(envelope.windowStart, 299)
        XCTAssertNil(envelope.turnCount, "an older tools prints no turn count")
    }

    func testDecodeReadsTheTranscriptTurnCount() throws {
        let json = """
        {"provider":"claude","sessionId":"abc","filePath":"/tmp/abc.jsonl","byteSize":12,"truncated":false,"nextOffset":150,"turnCount":420,"turns":[]}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))
        XCTAssertEqual(envelope.turnCount, 420)
        XCTAssertEqual(envelope.nextOffset, 150)
    }
}

private actor TranscriptCacheProbe {
    typealias Query = SessionTranscriptCache.Query
    private var calls: [Query: Int] = [:]
    private var continuations: [Query: CheckedContinuation<TranscriptEnvelope, Error>] = [:]
    private var shouldFail = false
    private let gated: Bool
    private let started: @Sendable (Query) -> Void

    init(gated: Bool = false, started: @escaping @Sendable (Query) -> Void = { _ in }) {
        self.gated = gated
        self.started = started
    }
    func count(_ query: Query) -> Int { calls[query, default: 0] }
    func failNext() { shouldFail = true }
    func fetch(_ query: Query) async throws -> TranscriptEnvelope {
        calls[query, default: 0] += 1
        if shouldFail { shouldFail = false; throw ToolsBridgeError.refused("Fixture load failed") }
        if gated {
            return try await withCheckedThrowingContinuation { continuation in
                continuations[query] = continuation
                started(query)
            }
        }
        started(query)
        return envelope(query)
    }
    func release(_ query: Query) {
        continuations.removeValue(forKey: query)?.resume(returning: envelope(query))
    }
    private func envelope(_ query: Query) -> TranscriptEnvelope {
        TranscriptEnvelope(provider: query.provider, sessionId: query.identity, filePath: query.query,
            byteSize: 512, truncated: true, nextOffset: 42,
            turns: [TranscriptTurn(id: "turn", role: "assistant", text: query.identity)], turnCount: 42)
    }
}

@MainActor
final class SessionTranscriptCacheTests: XCTestCase {
    private func query(_ identity: String, provider: String = "codex", file: String = "/fixture/session.jsonl") -> SessionTranscriptCache.Query {
        SessionTranscriptCache.Query(identity: identity, query: file, provider: provider)
    }

    func testHoverAndOpeningShareOneLoadAndRetainTheTailCatchupOffset() async throws {
        let started = expectation(description: "load started")
        let probe = TranscriptCacheProbe(gated: true, started: { _ in started.fulfill() })
        let cache = SessionTranscriptCache(load: { try await probe.fetch($0) })
        let wanted = query("codex:fixture:home-a")
        cache.prefetch(wanted)
        cache.prefetch(wanted)
        let opening = Task { try await cache.value(for: wanted) }
        await fulfillment(of: [started], timeout: 2)
        await probe.release(wanted)
        let initial = try await opening.value
        let cached = try await cache.value(for: wanted)
        let calls = await probe.count(wanted)
        XCTAssertEqual(calls, 1)
        XCTAssertEqual(cached, initial)
        XCTAssertEqual(cached.nextOffset, 42, "Live tail must catch up from the prefetched offset, not skip new turns")
        XCTAssertEqual(cached.filePath, wanted.query)
    }

    func testSameSessionIDDoesNotShareAcrossHomesProvidersOrTranscriptPaths() async throws {
        let probe = TranscriptCacheProbe()
        let cache = SessionTranscriptCache(capacity: 4, load: { try await probe.fetch($0) })
        let wanted = [query("codex:fixture:home-a"), query("codex:fixture:home-b"),
                      query("codex:fixture:home-a", provider: "grok"),
                      query("codex:fixture:home-a", file: "/fixture/new-rollout.jsonl")]
        for request in wanted {
            let envelope = try await cache.value(for: request)
            XCTAssertEqual(envelope.provider, request.provider)
            XCTAssertEqual(envelope.filePath, request.query)
            XCTAssertEqual(envelope.turns.first?.text, request.identity)
        }
        for request in wanted {
            _ = try await cache.value(for: request)
            let calls = await probe.count(request)
            XCTAssertEqual(calls, 1)
        }
    }

    func testTTLExpiryReloadsAndTheLeastRecentlyUsedEntryIsEvicted() async throws {
        let probe = TranscriptCacheProbe()
        var clock = Date(timeIntervalSince1970: 1000)
        let cache = SessionTranscriptCache(capacity: 2, lifetime: 15, now: { clock }, load: { try await probe.fetch($0) })
        let a = query("a"), b = query("b"), c = query("c")
        _ = try await cache.value(for: a)
        _ = try await cache.value(for: b)
        _ = try await cache.value(for: a)
        _ = try await cache.value(for: c)
        _ = try await cache.value(for: a)
        let retained = await probe.count(a)
        XCTAssertEqual(retained, 1, "Equal wall clocks must still preserve the most recently used entry")
        _ = try await cache.value(for: b)
        let evicted = await probe.count(b)
        XCTAssertEqual(evicted, 2)
        clock.addTimeInterval(15)
        _ = try await cache.value(for: b)
        let expired = await probe.count(b)
        XCTAssertEqual(expired, 3)
        clock.addTimeInterval(-30)
        _ = try await cache.value(for: b)
        let rewound = await probe.count(b)
        XCTAssertEqual(rewound, 4, "Moving the clock backwards cannot retain an entry forever")
    }

    func testCancellationRejectsACompletionEvenWhenTheLoaderIgnoresCancellation() async throws {
        let started = expectation(description: "load started")
        let probe = TranscriptCacheProbe(gated: true, started: { _ in started.fulfill() })
        let cache = SessionTranscriptCache(load: { try await probe.fetch($0) })
        let wanted = query("cancelled")
        let opening = Task { try await cache.value(for: wanted) }
        await fulfillment(of: [started], timeout: 2)
        cache.cancelPending()
        await probe.release(wanted)
        do {
            _ = try await opening.value
            XCTFail("A cancelled preload cannot become a visible transcript")
        } catch is CancellationError {
        }
    }

    func testLateOldSessionCompletionCannotReplaceTheNewSessionsCache() async throws {
        let first = expectation(description: "first session started")
        let second = expectation(description: "second session started")
        let probe = TranscriptCacheProbe(gated: true, started: { request in
            if request.identity == "a" { first.fulfill() } else { second.fulfill() }
        })
        let cache = SessionTranscriptCache(load: { try await probe.fetch($0) })
        let a = query("a"), b = query("b")
        cache.prefetch(a)
        await fulfillment(of: [first], timeout: 2)
        let opening = Task { try await cache.value(for: b) }
        await fulfillment(of: [second], timeout: 2)
        await probe.release(b)
        _ = try await opening.value
        await probe.release(a)
        let cached = try await cache.value(for: b)
        XCTAssertEqual(cached.turns.first?.text, "b")
        let calls = await probe.count(b)
        XCTAssertEqual(calls, 1)
    }

    func testFailedLoadsAreRetriedInsteadOfCachedAsEmptyTranscripts() async throws {
        let probe = TranscriptCacheProbe()
        let cache = SessionTranscriptCache(load: { try await probe.fetch($0) })
        let wanted = query("fixture")
        await probe.failNext()
        do {
            _ = try await cache.value(for: wanted)
            XCTFail("The first load must report its failure")
        } catch let error as ToolsBridgeError {
            XCTAssertEqual(error, .refused("Fixture load failed"))
        }
        let retry = try await cache.value(for: wanted)
        XCTAssertFalse(retry.turns.isEmpty)
        let calls = await probe.count(wanted)
        XCTAssertEqual(calls, 2)
    }
}
