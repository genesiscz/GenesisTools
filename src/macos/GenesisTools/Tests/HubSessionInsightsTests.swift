import XCTest
@testable import GenesisTools

/// The session-insights seams: the `tools hub insights|stuck|handoff --json` payloads (field sets as the
/// commands print them on 2026-09-26, values invented), the chart's bucketing and hit test, the
/// transcript bus's tool filter and row lookup, and the argv the hub hands to `tools`.
final class HubSessionInsightsTests: XCTestCase {
    private let insightsJSON = """
    {"sessionId":"sess-1","provider":"claude","filePath":"/tmp/gt/s.jsonl","title":"Build it","cwd":"/tmp/gt/app","branch":"feat/a",
     "turnCount":9,"priced":true,"pricingNote":"List prices",
     "totals":{"inputTokens":30,"outputTokens":20,"cacheReadTokens":900,"cacheWriteTokens":10,"reasoningTokens":0,"modelCalls":4,"costUsd":1.5},
     "turns":[
      {"number":0,"index":0,"turnId":"a0","label":"Before the first prompt","at":null,"durationMs":null,"inputTokens":1,"outputTokens":1,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"modelCalls":1,"costUsd":0.01,"models":["opus"],"toolCount":0,"errorCount":0,"rank":null},
      {"number":2,"index":1,"turnId":"u1","label":"Build it","at":"2026-01-10T10:00:00.000Z","durationMs":65000,"inputTokens":10,"outputTokens":10,"cacheReadTokens":400,"cacheWriteTokens":5,"reasoningTokens":0,"modelCalls":2,"costUsd":1.2,"models":["opus"],"toolCount":3,"errorCount":1,"rank":1},
      {"number":6,"index":5,"turnId":"u2","label":"Test it","at":"2026-01-10T10:05:00.000Z","durationMs":1200,"inputTokens":19,"outputTokens":9,"cacheReadTokens":500,"cacheWriteTokens":5,"reasoningTokens":0,"modelCalls":1,"costUsd":0.29,"models":[],"toolCount":0,"errorCount":0,"rank":2}
     ],
     "tools":[{"name":"mcp__genesis-tools__handoff_post","count":4,"failures":1,"failureRate":0.25,"totalMs":4000,"slowestMs":2500,"slowestToolId":"toolu_1","slowestTurnIndex":3,"timing":"upper-bound"},
              {"name":"Bash","count":2,"failures":0,"failureRate":0,"totalMs":0,"slowestMs":null,"slowestToolId":null,"slowestTurnIndex":null,"timing":"exact"}],
     "stuck":{"kind":"repeat-loop","tool":"Bash","argument":"bun run build","detail":"Bash ran the same call 6 times in a row, 5 failed","since":"2026-01-10T10:06:00.000Z","elapsedMs":60000,"count":6,"failures":5,"turnIndex":7,"toolId":"toolu_9"},
     "thresholds":{"toolMinutes":10,"repeats":5,"maxAgeHours":6,"activeMinutes":30,"ignoreLongTools":["Agent"],"ignoreRepeatTools":[]},
     "generatedAt":"2026-01-10T10:07:00.000Z"}
    """

    func testInsightsPayloadDecodesWithNullsAndRanks() throws {
        let payload = try HubInsights.decode(Data(insightsJSON.utf8))

        XCTAssertEqual(payload.turns.count, 3)
        XCTAssertEqual(payload.ranked.map(\.number), [2, 6])
        XCTAssertEqual(payload.prompts.map(\.number), [2, 6])
        XCTAssertEqual(payload.turns[0].rowId, "top")
        XCTAssertEqual(payload.turns[1].rowId, "p-u1")
        XCTAssertEqual(payload.turns[1].billableTokens, 25)
        XCTAssertEqual(payload.tools[0].displayName, "genesis-tools · handoff_post")
        XCTAssertEqual(payload.stuck?.isLoop, true)
        XCTAssertEqual(payload.stuck?.badge, "loop")
        XCTAssertEqual(payload.stuck?.line, "Looping? Bash ran the same call 6 times in a row, 5 failed: bun run build")
        XCTAssertEqual(payload.thresholds.repeats, 5)
    }

    func testSummaryAndFormats() throws {
        let payload = try HubInsights.decode(Data(insightsJSON.utf8))

        XCTAssertEqual(
            InsightFormat.summary(payload.turns[1], priced: true),
            "#2 Build it · $1.20 · in 10 · cache 405 · out 10 · 3 tools, 1 failed · 1m 05s · opus"
        )
        XCTAssertEqual(InsightFormat.percent(0), "0%")
        XCTAssertEqual(InsightFormat.percent(0.004), "<1%")
        XCTAssertEqual(InsightFormat.percent(0.25), "25%")
        XCTAssertEqual(InsightFormat.usd(0.004), "<$0.01")
        XCTAssertEqual(InsightFormat.usd(nil), "—")
    }

    private func turn(_ n: Int, cost: Double, rank: Int? = nil) -> InsightTurn {
        InsightTurn(
            number: n, index: n - 1, turnId: "t\(n)", label: "p\(n)", at: nil, durationMs: nil,
            inputTokens: n, outputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 0, reasoningTokens: 0,
            modelCalls: 1, costUsd: cost, models: [], toolCount: 0, errorCount: 0, rank: rank
        )
    }

    func testBucketsSumConsecutivePromptsAndKeepTheCostliestAsLead() {
        let turns = (1...200).map { turn($0, cost: $0 == 150 ? 9 : 0.1, rank: $0 == 150 ? 1 : nil) }
        let bars = InsightBar.bucket(turns, maxBars: 90, priced: true)

        // 200 prompts over at most 90 bars: three per bar.
        XCTAssertEqual(bars.count, 67)
        XCTAssertEqual(bars[0].turns.count, 3)
        XCTAssertEqual(bars[66].turns.count, 2)
        let marked = bars.first { $0.rank == 1 }
        XCTAssertEqual(marked?.lead.number, 150)
        XCTAssertEqual(marked?.cost ?? 0, 9.2, accuracy: 0.0001)
        XCTAssertEqual(InsightBar.bucket(Array(turns.prefix(5)), maxBars: 90, priced: true).count, 5)
        XCTAssertTrue(InsightBar.bucket([], maxBars: 90, priced: true).isEmpty)
    }

    func testBarHitTest() {
        XCTAssertEqual(InsightBar.index(at: 0, width: 270, count: 90), 0)
        XCTAssertEqual(InsightBar.index(at: 269.9, width: 270, count: 90), 89)
        XCTAssertEqual(InsightBar.index(at: 135, width: 270, count: 3), 1)
        XCTAssertNil(InsightBar.index(at: -1, width: 270, count: 3))
        XCTAssertNil(InsightBar.index(at: 270, width: 270, count: 3))
        XCTAssertNil(InsightBar.index(at: 10, width: 270, count: 0))
    }

    private func document() -> TranscriptDocument {
        let bash = TranscriptTool(id: "b1", name: "Bash", inputPreview: "ls", result: "ok", isError: false)
        let read = TranscriptTool(id: "r1", name: "Read", inputPreview: "/tmp/a", result: "x", isError: false)
        let turns = [
            TranscriptTurn(id: "u1", role: "user", at: nil, text: "one", tools: []),
            TranscriptTurn(id: "a1", role: "assistant", at: nil, text: "reply", tools: [bash, read]),
            TranscriptTurn(id: "u2", role: "user", at: nil, text: "two", tools: []),
            TranscriptTurn(id: "a2", role: "assistant", at: nil, text: "", tools: [read]),
        ]
        return TranscriptDocument.build(turns, fileExists: { _ in false })
    }

    func testOnlyToolKeepsItsCallsUnderTheirPromptsAndDropsOtherPrompts() {
        let sections = HubTranscriptBus.onlyTool("Bash", in: document().sections)

        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections[0].rows.map(\.id), ["p-u1", "t-b1"])
        XCTAssertEqual(HubTranscriptBus.onlyTool(nil, in: document().sections).count, 2)
        XCTAssertTrue(HubTranscriptBus.onlyTool("Grep", in: document().sections).isEmpty)
    }

    func testVisibleRowFindsACallInsideAFoldedGroup() {
        let folded = TranscriptDocument.folded(document().sections)

        XCTAssertEqual(HubTranscriptBus.visibleRow("t-r1", in: folded), "g-t-b1")
        XCTAssertEqual(HubTranscriptBus.visibleRow("p-u2", in: folded), "p-u2")
        XCTAssertNil(HubTranscriptBus.visibleRow("t-missing", in: folded))
    }

    func testBusMessagesReachOnlyTheirSession() {
        let note = Notification(name: HubTranscriptBus.list, object: HubTranscriptMessage(sessionId: "s-1", command: .reveal(rowId: "p-u1")))

        XCTAssertEqual(HubTranscriptBus.message(note, for: HubTranscriptBus.list, sessionId: "s-1"), .reveal(rowId: "p-u1"))
        XCTAssertNil(HubTranscriptBus.message(note, for: HubTranscriptBus.list, sessionId: "s-2"))
        XCTAssertNil(HubTranscriptBus.message(note, for: HubTranscriptBus.request, sessionId: "s-1"))
        // A list whose services have not loaded (empty id) takes nothing.
        let unloaded = Notification(name: HubTranscriptBus.list, object: HubTranscriptMessage(sessionId: "", command: .reveal(rowId: "top")))
        XCTAssertNil(HubTranscriptBus.message(unloaded, for: HubTranscriptBus.list, sessionId: ""))
    }

    func testStuckEnvelopeDecodes() throws {
        let json = """
        {"thresholds":{"toolMinutes":10,"repeats":5,"maxAgeHours":6,"activeMinutes":30,"ignoreLongTools":[],"ignoreRepeatTools":[]},
         "checked":2,"sessions":[
          {"sessionId":"s-1","provider":"claude","title":null,"verdict":{"kind":"long-tool","tool":"Bash","argument":"make","detail":"Bash has waited 12m 0s for its result","since":"2026-01-10T10:00:00.000Z","elapsedMs":720000,"count":1,"failures":0,"turnIndex":4,"toolId":"t-1"}},
          {"sessionId":"s-2","provider":"codex","title":"Other","verdict":null,"error":"not found"}]}
        """
        let envelope = try HubStuck.decode(Data(json.utf8))

        XCTAssertEqual(envelope.checked, 2)
        XCTAssertEqual(envelope.sessions[0].verdict?.badge, "stuck")
        XCTAssertEqual(envelope.sessions[1].error, "not found")
        XCTAssertEqual(HubStuck.arguments(["s-1", "s-2"]), ["hub", "stuck", "check", "--json", "--session", "s-1", "s-2"])
    }

    private func session(cwd: String, account: String?, title: String) throws -> HubSession {
        var object: [String: Any] = [
            "provider": "claude", "sessionId": "sess-1", "title": title, "cwd": cwd, "cwdShort": cwd,
            "mtime": 0, "modelSwitched": false, "filePath": "/tmp/gt/s.jsonl",
        ]
        if let account { object["account"] = account }
        return try JSONDecoder().decode(HubSession.self, from: JSONSerialization.data(withJSONObject: object))
    }

    func testHandoffArgumentsCarryFreeTextAsFlagValues() throws {
        let row = try session(cwd: "/tmp/gt/app", account: "work", title: "-starts with a dash")
        let args = HubHandoff.arguments(session: row, branch: "feat/a", range: .range(from: 9, to: 3), extra: ["--post", "--owner"])

        XCTAssertEqual(Array(args.prefix(4)), ["hub", "handoff", "sess-1", "--json"])
        // A reversed range is put in order.
        XCTAssertEqual(Array(args[4..<8]), ["--from", "3", "--to", "9"])
        XCTAssertTrue(args.contains("--title=\(row.displayTitle)"))
        XCTAssertTrue(args.contains("--cwd=/tmp/gt/app"))
        XCTAssertTrue(args.contains("--branch=feat/a"))
        XCTAssertTrue(args.contains("--account=work"))
        XCTAssertEqual(Array(args.suffix(2)), ["--post", "--owner"])

        let bare = HubHandoff.arguments(session: try session(cwd: "", account: nil, title: "t"), branch: nil, range: .last(4))
        XCTAssertEqual(Array(bare[4...5]), ["--last", "4"])
        XCTAssertFalse(bare.contains { $0.hasPrefix("--cwd") || $0.hasPrefix("--account") || $0.hasPrefix("--branch") })
    }

    func testHandoffDraftDecodes() throws {
        let json = """
        {"title":"Continue: Build it","markdown":"# Continue\\n","fromNumber":2,"toNumber":6,"promptCount":2,"goal":"Build it",
         "openItems":["Bash failed"],"changedFiles":[],"readFiles":[],"commits":[],"sessionId":"sess-1","provider":"claude",
         "savedTo":null,"copied":false,"posted":{"id":"h_1","name":null,"paste":"handoff_get h_1"}}
        """
        let draft = try HubHandoff.decode(Data(json.utf8))

        XCTAssertEqual(draft.openItems, ["Bash failed"])
        XCTAssertNil(draft.savedTo)
        XCTAssertEqual(draft.posted?.id, "h_1")
    }

    func testCompactDurationKeepsOneUnitForTheNarrowTable() {
        XCTAssertEqual(InsightFormat.compactDuration(ms: 500), "<1s")
        XCTAssertEqual(InsightFormat.compactDuration(ms: 42_000), "42s")
        XCTAssertEqual(InsightFormat.compactDuration(ms: 462_000), "7m")
        XCTAssertEqual(InsightFormat.compactDuration(ms: 5_400_000), "1.5h")
        XCTAssertEqual(InsightFormat.compactDuration(ms: 259_200_000), "3d")
        XCTAssertEqual(InsightFormat.compactDuration(ms: nil), "—")
    }
}
