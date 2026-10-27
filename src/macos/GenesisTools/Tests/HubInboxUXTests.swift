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

    /// F19: a Cancel that comes after a send started writing waits for the child's own end and returns what it
    /// printed, so the hub reads what the send did instead of "cancelled" while it lands.
    func testAStoppedCaptureReturnsWhatTheChildFinished() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        // On TERM the child finishes its work and answers, as a widget send past its cancel point does.
        process.arguments = ["-c", "trap 'kill $!; echo finished; exit 0' TERM; sleep 30 & wait"]
        let started = Date()
        let task = Task {
            try await ToolsCLIRunner.runStoppable { handle in
                try process.runCapturing(timeout: 60, afterStart: { handle.adopt(process) })
            }
        }
        try await Task.sleep(for: .milliseconds(300))
        task.cancel()
        let run = try await task.value
        XCTAssertTrue(run.stopped)
        XCTAssertEqual(run.value.status, 0)
        XCTAssertEqual(String(decoding: run.value.stdout, as: UTF8.self).trimmed, "finished")
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the stop did not reach the child")
    }

    /// F19: a send the Cancel came too late for reads as delivered, never as cancelled, so nobody sends it twice; one
    /// the Cancel stopped before it wrote reads as cancelled; a failure without a Cancel stays a failure.
    func testASendTheCancelCameTooLateForReadsAsDelivered() {
        let answer = #"{"sent":2,"queued":0,"failed":0,"sessions":[{"session":"s1","numbers":[4,5],"result":{"delivered":true}}]}"#
        let delivered = ProcessCapture(status: 0, stdout: Data(answer.utf8), stderr: Data())
        let late = HubInboxModel.widgetDelivery(delivered, stopped: true, ids: ["d_4_s1", "d_5_s1"], titles: [:], resend: false)
        XCTAssertFalse(late.isCancelled || late.isQueued || late.isError)
        XCTAssertEqual(late.summary, "Too late to cancel: the send had started. 2 decisions delivered.")
        XCTAssertEqual(late.resendIDs, [], "a delivered send offers no Send again")
        let plain = HubInboxModel.widgetDelivery(delivered, stopped: false, ids: ["d_4_s1", "d_5_s1"], titles: [:], resend: false)
        XCTAssertEqual(plain.summary, "2 decisions delivered.")

        let aborted = ProcessCapture(status: 1, stdout: Data(), stderr: Data("The operation was aborted.".utf8))
        XCTAssertTrue(HubInboxModel.widgetDelivery(aborted, stopped: true, ids: ["d_4_s1"], titles: [:], resend: false).isCancelled)
        let failed = HubInboxModel.widgetDelivery(aborted, stopped: false, ids: ["d_4_s1"], titles: [:], resend: false)
        XCTAssertTrue(failed.isError)
        XCTAssertFalse(failed.isCancelled)
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

    /// F1: an open card at rest draws its empty note as the placeholder text, not as a text field (a platform responder
    /// per card; an off-screen render shows no AppKit field, so the old card read no placeholder at all).
    @MainActor
    func testAnOpenCardAtRestDrawsItsNotePlaceholderWithoutAField() throws {
        let item = try Self.decision(#"{"number":6,"title":"Cache","choices":[{"id":"a","label":"Keep the cache"}]}"#)
        let text = try Self.read(card: item)
        XCTAssertTrue(text.contains("Write my own answer"), text)
    }

    @MainActor
    func testNoteSurvivesRejectedWriteAndCardRecreation() async throws {
        let inbox = HubInboxModel()
        let item = try Self.decision(#"{"id":"d_4_s1","draft":"old","revision":1}"#)
        let session = Self.session("s1", items: [item])
        let settled = expectation(description: "rejected write settled")
        inbox.captureWrite = { _ in ProcessCapture(status: 1, stdout: Data(#"{"error":"DECISION 4 changed"}"#.utf8), stderr: Data()) }
        inbox.reloadAfterWrite = { settled.fulfill() }
        inbox.noteTexts[item.id] = "unsaved note"
        inbox.stageNote(item, in: session, note: "unsaved note")
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertNotNil(inbox.writeErrors[item.id])
        XCTAssertEqual(inbox.noteForCard(item), "unsaved note", "a recreated card uses the unsaved note")
        XCTAssertEqual(inbox.noteTexts[item.id], "unsaved note", "the note remains dirty for retry")
        XCTAssertEqual(inbox.cardState(for: item, in: session, hubSession: nil).noteAcknowledgement, 0,
                       "a refused write cannot acknowledge the note")
    }

    @MainActor
    func testOlderSuccessfulNoteWriteDoesNotClearANewerEdit() async throws {
        let inbox = HubInboxModel()
        let item = try Self.decision(#"{"id":"d_4_s1","draft":"old","revision":1}"#)
        let session = Self.session("s1", items: [item])
        let started = expectation(description: "write started")
        let settled = expectation(description: "write settled")
        let gate = DispatchSemaphore(value: 0)
        inbox.captureWrite = { _ in
            started.fulfill()
            _ = gate.wait(timeout: .now() + 2)
            return ProcessCapture(status: 0, stdout: Data(), stderr: Data())
        }
        inbox.reloadAfterWrite = { settled.fulfill() }
        inbox.noteTexts[item.id] = "first"
        inbox.stageNote(item, in: session, note: "first")
        await fulfillment(of: [started], timeout: 1)
        inbox.noteTexts[item.id] = "newer"
        gate.signal()
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertEqual(inbox.noteForCard(item), "newer", "the old success cannot acknowledge a later edit")
        XCTAssertEqual(inbox.cardState(for: item, in: session, hubSession: nil).noteAcknowledgement, 0,
                       "a success for an older note cannot acknowledge a newer edit")
    }

    @MainActor
    func testSuccessfulMatchingNoteWriteClearsTheDirtyCopy() async throws {
        let inbox = HubInboxModel()
        let item = try Self.decision(#"{"id":"d_4_s1","draft":"old","revision":1}"#)
        let session = Self.session("s1", items: [item])
        let settled = expectation(description: "successful write settled")
        inbox.captureWrite = { _ in ProcessCapture(status: 0, stdout: Data(), stderr: Data()) }
        inbox.reloadAfterWrite = { settled.fulfill() }
        inbox.noteTexts[item.id] = "saved"
        inbox.stageNote(item, in: session, note: "saved")
        await fulfillment(of: [settled], timeout: 2)
        XCTAssertNil(inbox.writeErrors[item.id])
        XCTAssertNil(inbox.noteTexts[item.id], "only a matching successful write acknowledges the note")
        XCTAssertEqual(inbox.cardState(for: item, in: session, hubSession: nil).noteAcknowledgement, 1)
    }

    @MainActor
    func testSavingTheSameStoredNoteAcknowledgesEachSuccessfulWrite() async throws {
        let inbox = HubInboxModel()
        let item = try Self.decision(#"{"id":"d_4_s1","draft":"same","revision":1}"#)
        let session = Self.session("s1", items: [item])
        inbox.captureWrite = { _ in ProcessCapture(status: 0, stdout: Data(), stderr: Data()) }
        for expected in 1...2 {
            let settled = expectation(description: "same note write \(expected) settled")
            inbox.reloadAfterWrite = { settled.fulfill() }
            inbox.stageNote(item, in: session, note: "same")
            await fulfillment(of: [settled], timeout: 2)
            XCTAssertNil(inbox.noteTexts[item.id])
            XCTAssertEqual(item.draft, "same", "the stored draft value did not change")
            XCTAssertEqual(inbox.cardState(for: item, in: session, hubSession: nil).noteAcknowledgement, expected,
                           "the mounted card must observe each success even without a draft change")
        }
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
