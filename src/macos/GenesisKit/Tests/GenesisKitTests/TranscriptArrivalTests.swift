import Combine
import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

final class TranscriptArrivalTests: XCTestCase {
    private func section(_ id: String, _ rows: [String]) -> TranscriptSection {
        TranscriptSection(
            id: id,
            number: 1,
            startedAt: nil,
            duration: nil,
            toolCount: 0,
            errorCount: 0,
            usage: nil,
            rows: rows.map { TranscriptRow(id: $0, kind: .reply(text: $0, usage: nil, model: nil), at: nil, clock: nil, searchText: $0) }
        )
    }

    func testRowsAfterTheLastKnownRowAcrossANewSection() {
        let sections = [section("s1", ["a", "b"]), section("s2", ["c", "d"])]
        XCTAssertEqual(SessionTranscriptList.rows(after: "b", in: sections), ["c", "d"])
        XCTAssertEqual(SessionTranscriptList.rows(after: "d", in: sections), [])
        XCTAssertNil(SessionTranscriptList.rows(after: "gone", in: sections))
    }
}

final class TranscriptLiveActivityTests: XCTestCase {
    private func tool(_ id: String, pending: Bool) -> TranscriptRow {
        let line = TranscriptToolLine(
            toolId: id, name: "Bash", displayName: "Bash", symbol: "terminal", keyArgument: "ls", input: "ls",
            status: pending ? .pending : .ok
        )
        return TranscriptRow(id: "t-\(id)", kind: .tool(line), searchText: "")
    }

    private func document(_ rows: [TranscriptRow]) -> TranscriptDocument {
        let prompt = TranscriptRow(id: "p", kind: .prompt(text: "go", images: []), searchText: "go")
        return TranscriptDocument(
            sections: [TranscriptSection(id: "s1", number: 1, toolCount: rows.count, errorCount: 0, rows: [prompt] + rows)],
            turnCount: 1, toolCount: rows.count, errorCount: 0
        )
    }

    func testTheFollowsActivityLineDecodesBesideTurnsAndTotals() {
        let lines = [
            #"{"id":"m1","role":"assistant","at":null,"text":"hi","tools":[],"index":3}"#,
            #"{"kind":"totals","modelCalls":1,"terminated":null,"nextOffset":4,"turnCount":4}"#,
            #"{"kind":"activity","phase":"tool","since":1791656690000,"turnStartedAt":null,"tool":{"id":"t1","name":"Bash","summary":"Run the tests","startedAt":1791656690000},"openTools":2,"question":null,"stalled":false,"lastEventAt":1791656690000}"#,
        ]
        let batch = TranscriptLiveTail.batch(of: lines)
        XCTAssertEqual(batch.turns.map(\.index), [3])
        XCTAssertEqual(batch.totals?.nextOffset, 4)
        XCTAssertEqual(batch.activity?.phase, .tool)
        XCTAssertEqual(batch.activity?.tool?.summary, "Run the tests")
        XCTAssertEqual(batch.activity?.openTools, 2)

        let unknown = TranscriptLiveTail.batch(of: [#"{"kind":"activity","phase":"dreaming","stalled":false}"#])
        XCTAssertEqual(unknown.activity?.phase, .idle, "a phase a newer CLI adds reads as idle, not as a dropped line")
    }

    func testARunningToolBecomesTheActivityRowWithTheTurnsFinishedCalls() {
        let document = document([tool("a", pending: false), tool("b", pending: true)])
        XCTAssertEqual(document.finishedToolsInLastSection, 1)
        let running = TranscriptLiveActivity(
            phase: .tool, since: 1_000_000, tool: .init(id: "b", name: "Bash", summary: "Run the tests"), openTools: 2
        )

        let row = running.row(finishedTools: document.finishedToolsInLastSection)
        XCTAssertEqual(row?.label, "Running Bash")
        XCTAssertEqual(row?.detail, "Run the tests")
        XCTAssertEqual(row?.finishedTools, 1)
        XCTAssertEqual(row?.moreRunning, 1)
        XCTAssertEqual(row?.startedAt, Date(timeIntervalSince1970: 1000))
        XCTAssertEqual(TranscriptLiveActivity(phase: .thinking, since: 2_000_000).row(finishedTools: 0)?.label, "Thinking…")
        XCTAssertNil(TranscriptLiveActivity(phase: .idle).row(finishedTools: 1), "no row once the turn ended")
        let undated = TranscriptLiveActivity(phase: .thinking, lastEventAt: 3_000_000)
        XCTAssertEqual(undated.row(finishedTools: 0)?.startedAt, Date(timeIntervalSince1970: 3000), "a line with no phase start counts from its last event")
    }

    func testWaitingAndStalledActivitiesTakeTheirOwnTone() {
        let ask = TranscriptLiveActivity(phase: .waiting, since: 1, question: "Ship it?").row(finishedTools: 0)
        XCTAssertEqual(ask?.label, "Waiting for your answer")
        XCTAssertEqual(ask?.detail, "Ship it?")
        XCTAssertEqual(ask?.tone, .waiting)

        let plan = TranscriptLiveActivity(phase: .waiting, since: 1, tool: .init(id: "p", name: "ExitPlanMode", summary: ""))
        XCTAssertEqual(plan.row(finishedTools: 0)?.label, "Waiting for plan approval")
        let silent = TranscriptLiveActivity(phase: .thinking, since: 1, stalled: true)
        XCTAssertEqual(silent.row(finishedTools: 0)?.tone, .stalled)
        XCTAssertEqual(silent.row(finishedTools: 0)?.label, "No output", "ten silent minutes are not a think")
        XCTAssertEqual(silent.headerState, .stalled)
        XCTAssertEqual(TranscriptLiveActivity.status(.stalled, over: .running).label, "Stalled")
        XCTAssertFalse(silent.isWorking)
        let longRun = TranscriptLiveActivity(phase: .tool, tool: .init(id: "t", name: "Bash", summary: "make"), stalled: true)
        XCTAssertEqual(longRun.headerState, .working, "a tool may run that long: the header keeps Running, the row's time turns orange")
        XCTAssertEqual(longRun.row(finishedTools: 0)?.tone, .stalled)
        XCTAssertNil(TranscriptLiveActivity(phase: .interrupted).row(finishedTools: 3))
    }

    func testTheHeaderStatusFollowsTheActivityButNotEachToolCall() {
        let thinking = TranscriptLiveActivity(phase: .thinking).headerState
        let tool = TranscriptLiveActivity(phase: .tool, tool: .init(id: "t", name: "Bash", summary: "make")).headerState
        XCTAssertEqual(thinking, tool, "thinking and a running tool read the same in the header, so it does not redraw per call")
        XCTAssertEqual(TranscriptLiveActivity.status(thinking, over: .idle).liveness, .running)
        XCTAssertEqual(TranscriptLiveActivity.status(tool, over: .ended).liveness, .running)
        let waiting = TranscriptLiveActivity.status(TranscriptLiveActivity(phase: .waiting).headerState, over: .running)
        XCTAssertEqual(waiting.liveness, .idle)
        XCTAssertEqual(waiting.label, "Waiting")
        XCTAssertEqual(TranscriptLiveActivity.status(.idle, over: .running).liveness, .idle)
        XCTAssertEqual(TranscriptLiveActivity.status(.idle, over: .ended).liveness, .ended)
    }

    @MainActor
    func testTheFeedPublishesItsRowOnlyWhenTheRowChanges() {
        let feed = TranscriptActivityFeed()
        var published = 0
        let watch = feed.$row.dropFirst().sink { _ in published += 1 }
        defer { watch.cancel() }
        let bash = TranscriptLiveActivity(phase: .tool, since: 1_000_000, tool: .init(id: "a", name: "Bash", summary: "make"), openTools: 1)

        XCTAssertTrue(feed.receive(bash, finishedTools: 2))
        XCTAssertEqual(feed.row?.label, "Running Bash")
        XCTAssertFalse(feed.receive(bash, finishedTools: 2), "the same line again")
        XCTAssertEqual(published, 1)

        feed.refresh(finishedTools: 3)
        XCTAssertEqual(feed.row?.finishedTools, 3)
        feed.refresh(finishedTools: 3)
        XCTAssertEqual(published, 2)

        XCTAssertTrue(feed.receive(TranscriptLiveActivity(phase: .idle, since: 2_000_000), finishedTools: 3))
        XCTAssertNil(feed.row, "no row once the turn ended")
        XCTAssertEqual(published, 3)
    }
}
