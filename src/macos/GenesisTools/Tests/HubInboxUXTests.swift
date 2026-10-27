import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// The hub's decision surfaces as the user reads them (UX audit 2026-10-27): the Decisions pane's words, and the Inbox
/// card's words, keys and states.
final class HubInboxUXTests: XCTestCase {
    /// P4: the Decisions pane's caption follows the Decision click setting, and its empty text says what is empty.
    func testTheDecisionsPaneSaysWhatAClickDoesAndWhatIsEmpty() {
        XCTAssertEqual(DecisionsView.caption(stages: true).text, "A click stages an option · Send delivers")
        XCTAssertEqual(DecisionsView.caption(stages: false).text, "A click sends the option at once",
                       "it said \"stages\" while clicks sent")
        XCTAssertEqual(DecisionsView.emptyText(filter: "answered", hasAny: true), "No answered decisions in this session.",
                       "it said \"Nothing here.\"")
        XCTAssertEqual(DecisionsView.emptyText(filter: "open", hasAny: true), "No open decisions in this session.")
        XCTAssertEqual(DecisionsView.emptyText(filter: "all", hasAny: false), "No decisions recorded for this session.")
    }

    /// F19: Cancel on a slow send stops its `tools` child at once instead of letting it run out its two minutes.
    func testACancelledCaptureTerminatesItsChildAtOnce() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        let started = Date()
        let task = Task {
            try await ToolsCLIRunner.runCancellable { handle in
                try process.runCapturing(timeout: 60, afterStart: { handle.adopt(process) })
            }
        }
        try await Task.sleep(for: .milliseconds(300))
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled capture returned instead of throwing")
        } catch is CancellationError {}
        XCTAssertFalse(process.isRunning, "the child still runs after its task was cancelled")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the cancel waited for the child's own end")
    }

    /// F19: a cancelled send reads as cancelled, never as sent, waiting or failed, and keeps the answers staged.
    func testACancelledSendSaysTheAnswersStayStaged() {
        let delivery = InboxDelivery.cancelled
        XCTAssertTrue(delivery.isCancelled)
        XCTAssertFalse(delivery.isQueued, "a cancel is not \"Waiting to send\"")
        XCTAssertFalse(delivery.isError)
        XCTAssertEqual(delivery.summary, "Send cancelled. Nothing more was sent, and the answers stay staged.")
    }

    /// F1: an option whose label already starts with its letter shows the letter once, in the badge only.
    func testAnOptionShowsItsLetterOnce() throws {
        let item = try Self.decision(#"{"choices":[{"id":"a","label":"a) Keep the cache"},{"id":"b","label":"Drop it"}]}"#)
        XCTAssertEqual(item.choices?.map(\.shownLabel), ["Keep the cache", "Drop it"])
        XCTAssertTrue(item.findFields.contains { $0.key == "choice:a" && $0.text == "Keep the cache" })
        XCTAssertFalse(item.searchText.contains("a) a)"), item.searchText)
    }

    /// P12: Return in an empty note says what to do, as a hint; a note or a staged letter is enough to act.
    func testReturnInAnEmptyNoteSaysWhatItNeeds() {
        XCTAssertEqual(HubInboxModel.emptyNoteHint(note: " ", stored: nil, letters: "", stages: true), "Write a note first.")
        XCTAssertNil(HubInboxModel.emptyNoteHint(note: "", stored: "old note", letters: "", stages: true),
                     "Return in an emptied note clears the staged one")
        XCTAssertEqual(HubInboxModel.emptyNoteHint(note: "", stored: nil, letters: "", stages: false),
                       "Write your answer or pick an option first.")
        XCTAssertNil(HubInboxModel.emptyNoteHint(note: "", stored: nil, letters: "b", stages: false), "a staged letter sends")
        XCTAssertNil(HubInboxModel.emptyNoteHint(note: "keep it", stored: nil, letters: "", stages: true))
    }

    /// F18: a link to a decision names its session and number, so the notice can offer the way to it.
    func testARevealedDecisionIdNamesItsSessionAndNumber() {
        XCTAssertEqual(HubInboxModel.revealTarget("d_26_0a1b-c2_d"), .init(sessionId: "0a1b-c2_d", number: 26))
        XCTAssertNil(HubInboxModel.revealTarget("ask_17"))
        XCTAssertNil(HubInboxModel.revealTarget("d_x_s1"))
    }

    /// F7: a closed card shows the answer's own words only when they say more than the picked option.
    func testAClosedCardShowsTheAnswerOnlyWhenItAddsSomething() throws {
        let choices = #"[{"id":"a","label":"a) Keep the cache"},{"id":"b","label":"Drop it"}]"#
        let echo = try Self.decision(#"{"status":"sent","option":"a","answer":"a) Keep the cache","choices":\#(choices)}"#)
        XCTAssertNil(echo.answerBeyondPick)
        let letter = try Self.decision(#"{"status":"sent","option":"b","answer":"b","choices":\#(choices)}"#)
        XCTAssertNil(letter.answerBeyondPick)
        let own = try Self.decision(#"{"status":"acknowledged","option":"b","answer":"Drop it, and log why","choices":\#(choices)}"#)
        XCTAssertEqual(own.answerBeyondPick, "Drop it, and log why")
        XCTAssertEqual(LiveWidgetView.statusPhrase("answered", kind: "decision"), "Waiting to send")
    }

    /// F2, P3: the header counts what is staged, and answers no session took yet read "waiting to send".
    func testTheHeaderCountsStagedAndWaitingToSend() {
        let session = InboxSession(sessionId: "s1", provider: "claude", title: "Cart", project: nil, cwd: nil, branch: nil,
                                   account: nil, lastAt: "2026-10-27T00:00:00.000Z", waiting: 3, drafted: 1, queued: 1,
                                   stale: nil, reply: nil, items: [])
        XCTAssertEqual(InboxMain.summary([session], staged: 2), "3 waiting in 1 session · 2 staged · 1 waiting to send")
        XCTAssertEqual(InboxMain.summary([]), "Nothing waiting")
    }

    /// P3: a send no receiver took names the widget's state and the next step, never the decisions hook.
    func testANotDeliveredSendSaysWaitingToSend() throws {
        let queued = try JSONDecoder().decode(InboxDelivery.self, from: Data(
            #"{"text":"DECISION 2: a)","channel":"queued","delivered":false,"detail":"no cmux pane runs this session"}"#.utf8))
        XCTAssertEqual(queued.summary, "Waiting to send: no cmux pane runs this session. Send again once the session runs.")
        let codex = try JSONDecoder().decode(InboxDelivery.self, from: Data(
            #"{"channel":"codex","delivered":true,"target":"Codex worker w1"}"#.utf8))
        XCTAssertEqual(codex.summary, "Sent to Codex worker w1")
    }

    /// F8: the number row picks options by key code too, as on a Czech keyboard where it types letters.
    func testTheNumberRowKeyCodesAreOneToNine() {
        XCTAssertEqual(InboxMain.numberRow.count, 9)
        XCTAssertEqual(Set(InboxMain.numberRow.values), Set(1...9))
        XCTAssertEqual(InboxMain.numberRow[18], 1)
        XCTAssertEqual(InboxMain.numberRow[25], 9)
    }

    /// F8: Up and Down walk the open decisions across sessions and stop at the ends; the selected session's first open
    /// decision is the key card until one is picked.
    @MainActor
    func testTheKeyCardWalksOpenDecisionsAcrossSessions() throws {
        let inbox = HubInboxModel()
        let one = try Self.session("s1", items: [Self.decision(#"{"id":"d_1_s1"}"#), Self.decision(#"{"id":"d_2_s1","status":"sent"}"#)])
        let two = try Self.session("s2", items: [Self.decision(#"{"id":"d_3_s2"}"#), Self.decision(#"{"id":"d_4_s2"}"#)])
        let rows = [one, two]
        inbox.selectedID = "s2"
        XCTAssertEqual(inbox.keyCard(in: rows)?.item.id, "d_3_s2")
        XCTAssertEqual(inbox.moveKeyCard(-1, in: rows), "d_1_s1", "a closed decision is skipped")
        XCTAssertEqual(inbox.moveKeyCard(-1, in: rows), "d_1_s1", "Up stops at the first")
        XCTAssertEqual(inbox.moveKeyCard(1, in: rows), "d_3_s2")
        XCTAssertEqual(inbox.moveKeyCard(1, in: rows), "d_4_s2")
        XCTAssertEqual(inbox.moveKeyCard(1, in: rows), "d_4_s2", "Down stops at the last")
    }

    /// F1, F2, F7 as drawn: a staged option reads Staged with its letter once, the card says Staged, and a closed card
    /// says what became of it in the widget's words.
    @MainActor
    func testTheCardDrawsStagedAndClosedStatesInWords() throws {
        let choices = #"[{"id":"a","label":"a) Keep the cache"},{"id":"b","label":"b) Drop it"}]"#
        let staged = try Self.decision(#"{"number":4,"title":"Cache policy","draftOption":"a","choices":\#(choices)}"#)
        let open = try Self.read(card: staged)
        XCTAssertTrue(open.contains("Decision 4"), open)
        XCTAssertTrue(open.contains("Keep the cache"), open)
        XCTAssertTrue(open.contains("Staged"), open)
        XCTAssertTrue(open.contains("Send now"), open)
        XCTAssertFalse(open.contains("a) a)"), "the letter shows once: \(open)")
        let sent = try Self.decision(#"{"number":5,"title":"Port","status":"sent","option":"b","answer":"b) Drop it","choices":\#(choices)}"#)
        let closed = try Self.read(card: sent)
        XCTAssertTrue(closed.contains("Sent"), closed)
        XCTAssertFalse(closed.contains("Already"), closed)
        XCTAssertFalse(closed.contains("Send now"), closed)
    }

    // MARK: - Fixtures

    static func decision(_ fields: String) throws -> InboxItem {
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fields.utf8)) as? [String: Any])
        let defaults: [String: Any] = ["kind": "decision", "id": "d_4_s1", "number": 4, "status": "waiting",
                                       "at": "2026-10-27T00:00:00.000Z", "source": "store"]
        json.merge(defaults) { mine, _ in mine }
        return try JSONDecoder().decode(InboxItem.self, from: JSONSerialization.data(withJSONObject: json))
    }

    static func session(_ id: String, items: [InboxItem]) -> InboxSession {
        InboxSession(sessionId: id, provider: "claude", title: "Session \(id)", project: "demo", cwd: "/tmp/demo", branch: nil,
                     account: nil, lastAt: "2026-10-27T00:00:00.000Z", waiting: items.filter(\.isOpen).count,
                     drafted: nil, queued: nil, stale: nil, reply: nil, items: items)
    }

    /// The card's text as drawn: rendered off screen and read back with Vision (a SwiftUI view has no accessibility
    /// tree in a test).
    @MainActor
    static func read(card item: InboxItem) throws -> String {
        let model = HubModel(wantedSession: nil, tab: .transcript)
        let inbox = HubInboxModel()
        let view = InboxDecisionCard(model: model, inbox: inbox, session: session("s1", items: [item]), item: item)
            .frame(width: 760)
            .padding(10)
            .background(Color.black)
            .environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }
}
