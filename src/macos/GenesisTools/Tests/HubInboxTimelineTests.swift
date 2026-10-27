import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// The Inbox and Today modes read `tools question inbox --json` and `tools hub timeline --json`
/// (src/question/lib/inbox, src/hub/lib/timeline.ts). These pin the JSON contract and the ordering.
final class HubInboxTimelineTests: XCTestCase {
    private let inboxJSON = """
    {
      "sessions": [
        {
          "sessionId": "s-alpha", "provider": "claude", "title": "parser work", "project": "app",
          "cwd": "/tmp/gt/app", "branch": "feat/parser", "account": "work", "lastAt": "2026-03-01T10:04:00.000Z",
          "waiting": 1,
          "items": [
            {
              "kind": "decision", "id": "d_3_s-alpha", "number": 3, "title": "Keep the cache?", "prompt": "Keep the cache?",
              "choices": [{ "id": "a", "label": "keep it" }, { "id": "b", "label": "drop it" }],
              "recommended": null, "blocking": false, "status": "waiting", "option": null, "answer": null,
              "source": "transcript", "at": "2026-03-01T10:04:00.000Z"
            }
          ]
        },
        {
          "sessionId": null, "provider": null, "title": null, "project": "shop", "cwd": "/tmp/gt/shop", "branch": null,
          "account": null, "lastAt": "2026-03-01T09:00:00.000Z", "waiting": 2,
          "items": [
            {
              "kind": "form", "id": "ask_1", "source": null, "status": "waiting", "at": "2026-03-01T09:00:00.000Z",
              "questions": [{ "itemId": "q1", "prompt": "Ship it?", "choices": [{ "id": "c1", "label": "yes" }], "multiple": false, "freeText": false, "required": true, "fileTags": false, "imagePaste": false }]
            }
          ]
        }
      ],
      "scanned": { "sessions": 2, "fromCache": 1, "read": 1, "failed": 0 },
      "elapsedMs": 12
    }
    """

    func testInboxDecodesDecisionsAndForms() throws {
        let envelope = try JSONDecoder().decode(InboxEnvelope.self, from: Data(inboxJSON.utf8))
        XCTAssertEqual(envelope.sessions.count, 2)
        let alpha = envelope.sessions[0]
        XCTAssertEqual(alpha.id, "s-alpha")
        XCTAssertEqual(alpha.items.first?.choices?.map(\.id), ["a", "b"])
        XCTAssertTrue(alpha.items.first?.isOpen == true)
        let forms = envelope.sessions[1]
        XCTAssertEqual(forms.id, "form:/tmp/gt/shop")
        XCTAssertEqual(forms.displayTitle, "Questions without a session")
        XCTAssertEqual(forms.items.first?.isForm, true)
        XCTAssertEqual(forms.items.first?.questions?.first?.choices.first?.label, "yes")
    }

    func testInboxSortsAndFilters() throws {
        let sessions = try JSONDecoder().decode(InboxEnvelope.self, from: Data(inboxJSON.utf8)).sessions
        XCTAssertEqual(InboxSort.recent.apply(sessions, filter: "").map(\.id), ["s-alpha", "form:/tmp/gt/shop"])
        XCTAssertEqual(InboxSort.oldest.apply(sessions, filter: "").map(\.id), ["form:/tmp/gt/shop", "s-alpha"])
        XCTAssertEqual(InboxSort.count.apply(sessions, filter: "").map(\.id), ["form:/tmp/gt/shop", "s-alpha"])
        XCTAssertEqual(InboxSort.project.apply(sessions, filter: "").map(\.projectName), ["app", "shop"])
        XCTAssertEqual(InboxSort.recent.apply(sessions, filter: "CACHE").map(\.id), ["s-alpha"], "the question text is searched")
    }

    func testDeliverySummaries() throws {
        let decode = { (json: String) in try JSONDecoder().decode(InboxDelivery.self, from: Data(json.utf8)) }
        let typed = try decode(#"{"session":"s","text":"DECISION 3: b) drop it","channel":"cmux","delivered":true}"#)
        XCTAssertFalse(typed.isQueued)
        XCTAssertEqual(typed.summary, "Sent to the session's cmux pane")
        let queued = try decode(#"{"session":"s","text":"DECISION 3: b)","channel":"queued","delivered":false,"detail":"no cmux pane matched"}"#)
        XCTAssertTrue(queued.isQueued)
        XCTAssertTrue(queued.summary.contains("no cmux pane matched"))
        let refused = try decode(#"{"error":"DECISION 3 is already sent"}"#)
        XCTAssertTrue(refused.isError)
        XCTAssertEqual(refused.summary, "DECISION 3 is already sent")
    }

    func testANoteQueuedBehindAPickKeepsThePick() {
        let base = ["question", "inbox", "draft", "--session", "s", "--decision", "3"]
        let pick = base + ["--option", "b", "--text", ""]
        let note = base + ["--text", "because"]
        XCTAssertEqual(HubInboxModel.keepingPick(note, from: pick), note + ["--option", "b"])
        XCTAssertEqual(HubInboxModel.keepingPick(note, from: nil), note, "nothing earlier: the note alone")
        let repick = base + ["--option", "a", "--text", "because"]
        XCTAssertEqual(HubInboxModel.keepingPick(repick, from: pick), repick, "a newer pick wins")
        let dismiss = ["question", "inbox", "dismiss", "--session", "s", "--decision", "3"]
        XCTAssertEqual(HubInboxModel.keepingPick(dismiss, from: pick), dismiss, "a dismiss never gets letters")
    }

    func testSendAndResumeNeverSendAfterAFailure() throws {
        struct Broken: Error, CustomStringConvertible {
            var description: String { "tools question exited 1: no store" }
        }

        let target = { (json: String) in try JSONDecoder().decode(InboxTargetResolution.self, from: Data(json.utf8)) }
        let failed = HubInboxModel.sendStep(.failure(Broken()))
        guard case .report(let why, let raw) = failed else {
            return XCTFail("a failed target read must not send or queue: \(failed)")
        }
        // One sentence on screen; the tool's own words behind Details (F10).
        XCTAssertFalse(why.contains("no store"), why)
        XCTAssertTrue(raw?.contains("no store") == true)
        XCTAssertFalse(HubInboxModel.queueHook(from: .failure(Broken())), "a failed lookup never offers Keep queued")
        XCTAssertTrue(HubInboxModel.queueHook(from: .success(try target(#"{"kind":"none","queueHookOn":true}"#))))
        XCTAssertEqual(HubInboxModel.sendStep(.success(try target(#"{"kind":"none"}"#))), .askWhereToResume)
        XCTAssertEqual(HubInboxModel.sendStep(.success(try target(#"{"kind":"cmux","label":"work"}"#))), .deliver(resumeTarget: nil))

        XCTAssertEqual(HubInboxModel.resumeStep(.cancelled), .nothing)
        XCTAssertEqual(HubInboxModel.resumeStep(.launched("Resume: fix the cart")), .deliver(resumeTarget: "resumed — Resume: fix the cart"))
        guard case .report(let refused, let raw) = HubInboxModel.resumeStep(.failed("cmux: no socket")) else {
            return XCTFail("a failed resume must not deliver")
        }
        XCTAssertEqual(refused, "Nothing was sent: the session did not resume. The answers stay staged.")
        XCTAssertEqual(raw, "cmux: no socket")
    }

    func testTimelineDecodesEveryKind() throws {
        let json = """
        {
          "since": "2026-03-02T00:00:00.000Z", "until": "2026-03-02T15:00:00.000Z", "repos": ["/tmp/gt/app"],
          "counts": { "session.start": 0, "session.turn": 1, "commit": 1, "push": 0, "pr": 1, "thread": 0 },
          "warnings": [], "elapsedMs": 40, "cached": false,
          "events": [
            { "id": "turn:s", "kind": "session.turn", "at": "2026-03-02T14:00:00.000Z", "title": "parser work", "detail": "last turn",
              "project": "app", "repo": "/tmp/gt/app", "sessionId": "s", "provider": "claude" },
            { "id": "commit:a", "kind": "commit", "at": "2026-03-02T10:00:00.000Z", "title": "feat: parser", "detail": "aaaaaaaa",
              "project": "app", "repo": "/tmp/gt/app", "sha": "aaaa", "author": "Alice" },
            { "id": "pr-open:acme/app#7", "kind": "pr", "at": "2026-03-02T10:10:00.000Z", "title": "Parser rewrite", "detail": "opened acme/app#7",
              "project": "app", "repo": null, "pr": { "ref": "acme/app#7", "number": 7, "url": "https://github.com/acme/app/pull/7" },
              "url": "https://github.com/acme/app/pull/7" }
          ]
        }
        """
        let envelope = try JSONDecoder().decode(TimelineEnvelope.self, from: Data(json.utf8))
        XCTAssertEqual(envelope.events.map(\.timelineKind), [.session, .commit, .pr])
        XCTAssertEqual(HubPRRef(envelope.events[2].pr?.ref ?? "")?.number, 7)
        XCTAssertEqual(HubPRRef(envelope.events[2].pr?.ref ?? "")?.project, "acme/app")
    }

    func testModesMatchTheCLI() {
        // src/hub/lib/open.ts HUB_MODES and src/hub/lib/timeline.ts TIMELINE_KINDS.
        XCTAssertEqual(HubMode.allCases.map(\.rawValue), ["sessions", "worktrees", "prs", "inbox", "timeline", "agents"])
        XCTAssertEqual(TimelineKind.allCases.map(\.rawValue), ["session.start", "session.turn", "commit", "push", "pr", "thread", "decision", "ci"])
    }
}

/// The session Decisions pane: store items become cards, drafts become one `--batch`.
final class HubDecisionsSourceTests: XCTestCase {
    func testStoreItemsBecomeCardsAndDraftsBecomeBatchEntries() throws {
        let json = """
        { "sessionId": "s-alpha", "decisions": [
          { "kind": "decision", "id": "d_1_s-alpha", "number": 1, "title": null, "prompt": "Which port?\\nThe demo needs one.",
            "choices": [{ "id": "a", "label": "3000" }, { "id": "b", "label": "4000" }], "recommended": "b", "blocking": true,
            "status": "drafted", "option": null, "answer": null, "source": "store", "at": "2026-03-01T08:00:00.000Z",
            "proposal": "b", "reasoning": "free port", "confidence": "high", "excerpt": "const port = 3000", "refs": [{ "path": "src/server.ts", "line": 12 }],
            "draft": "after the release" },
          { "kind": "decision", "id": "d_2_s-alpha", "number": 2, "title": "Rename?", "prompt": "Rename?", "choices": [],
            "recommended": null, "blocking": false, "status": "sent", "option": "a", "answer": null, "source": "store",
            "at": "2026-03-01T09:00:00.000Z", "proposal": null, "reasoning": null, "confidence": null, "excerpt": null, "refs": [], "draft": null }
        ] }
        """
        let envelope = try JSONDecoder().decode(SessionDecisionsEnvelope.self, from: Data(json.utf8))
        let items = envelope.decisions
        XCTAssertEqual(items[0].prompt?.split(separator: "\n").first.map(String.init), "Which port?")
        XCTAssertEqual(items[0].excerpt, "const port = 3000")
        XCTAssertEqual(items[0].confidence, "high")
        XCTAssertTrue(items[0].isOpen, "drafted still needs sending")
        XCTAssertEqual(items[0].draft, "after the release")
        XCTAssertFalse(items[1].isOpen)
        XCTAssertEqual(items[1].option, "a")

        // The pane shows the same session shape as the Inbox: a stored note counts as a draft.
        let session = InboxSession(
            sessionId: envelope.sessionId, provider: "claude", title: "s", project: nil, cwd: "/tmp/gt/app", branch: nil,
            account: nil, lastAt: "", waiting: 1, drafted: nil, queued: nil, stale: nil, reply: nil, items: items
        )
        XCTAssertEqual(session.draftedItems.map(\.id), ["d_1_s-alpha"])
    }

    /// The arrow keys step through the rows the Inbox shows: the quiet sessions only while their fold is open, whichever
    /// row is selected (a fold opened with the mouse, and one left open after the selection moved up).
    func testTheInboxArrowKeysFollowTheQuietFold() {
        func session(_ id: String, stale: Bool) -> InboxSession {
            InboxSession(
                sessionId: id, provider: "claude", title: id, project: nil, cwd: "/tmp/gt/app", branch: nil,
                account: nil, lastAt: "", waiting: 1, drafted: nil, queued: nil, stale: stale, reply: nil, items: []
            )
        }
        let rows = [session("fresh-a", stale: false), session("quiet-b", stale: true), session("fresh-c", stale: false)]
        XCTAssertEqual(HubInboxModel.keyOrder(rows, showsQuiet: false), ["fresh-a", "fresh-c"])
        XCTAssertEqual(HubInboxModel.keyOrder(rows, showsQuiet: true), ["fresh-a", "fresh-c", "quiet-b"])
    }

    /// A staging click MARKS an option: plain click replaces the pick (and clears it on the chosen one),
    /// ⇧-click adds or removes a letter.
    func testAClickMarksAndShiftClickAdds() {
        XCTAssertEqual(InboxDecisionCard.toggled("", "a", add: false), "a")
        XCTAssertEqual(InboxDecisionCard.toggled("a", "a", add: false), "", "a second click clears")
        XCTAssertEqual(InboxDecisionCard.toggled("a", "b", add: false), "b", "a plain click replaces")
        XCTAssertEqual(InboxDecisionCard.toggled("a", "c", add: true), "ac", "⇧-click adds")
        XCTAssertEqual(InboxDecisionCard.toggled("ac", "a", add: true), "c", "⇧-click on a marked letter removes it")
    }

    /// A click answers as in the widget: it stages, or with Send at once (or ⌘ while clicks stage) it sends that one
    /// letter now; ⇧-click always stages another letter.
    func testAClickStagesOrSendsAsTheWidgetSettingSays() {
        XCTAssertTrue(HubInboxModel.clickPlan(letters: "", letter: "a", shift: false, stages: true) == ("a", false))
        XCTAssertTrue(HubInboxModel.clickPlan(letters: "a", letter: "a", shift: false, stages: true) == ("", false),
                      "a click on the staged letter clears it")
        XCTAssertTrue(HubInboxModel.clickPlan(letters: "ac", letter: "b", shift: false, stages: false) == ("b", true),
                      "a send sends the clicked letter only")
        XCTAssertTrue(HubInboxModel.clickPlan(letters: "a", letter: "c", shift: true, stages: false) == ("ac", false),
                      "⇧-click stages another letter even while clicks send")
    }

    /// A send through the widget's engine reads as the widget's note, and a delivery over a Claude session's own
    /// channel no longer reads "Not sent".
    func testASendReadsAsTheWidgetSaysIt() {
        let waiting = InboxDelivery.outcome(WidgetDecisionSendOutcome(["sent": 0, "queued": 1, "failed": 0, "sessions": [
            ["session": "s1", "numbers": [4], "result": ["delivered": false, "detail": "no cmux pane runs this session"]],
        ]], titles: ["s1": "gt-fixes"]), ids: ["d_4_s1"], resend: false)
        XCTAssertEqual(waiting.summary,
                       "Not delivered to gt-fixes: No cmux pane runs this session. The answers wait for its next prompt.")
        XCTAssertTrue(waiting.isQueued)
        XCTAssertEqual(waiting.resendIDs, ["d_4_s1"], "Send again sends the waiting answers")
        let sent = InboxDelivery.outcome(WidgetDecisionSendOutcome(["sent": 2, "queued": 0, "failed": 0, "sessions": [
            ["session": "s1", "numbers": [4, 5], "result": ["delivered": true]],
        ]], titles: [:]), ids: ["d_4_s1", "d_5_s1"], resend: false)
        XCTAssertEqual(sent.summary, "2 decisions delivered.")
        XCTAssertFalse(sent.isQueued || sent.isError)
        let failed = InboxDelivery.outcome(WidgetDecisionSendOutcome(["sent": 0, "queued": 0, "failed": 1, "sessions": [
            ["session": "s1", "numbers": [4], "error": "boom"],
        ]], titles: ["s1": "gt-fixes"]), ids: ["d_4_s1"], resend: false)
        XCTAssertTrue(failed.isError)
        XCTAssertEqual(failed.summary, "1 decision could not be sent and stay staged.")
        let peer = InboxDelivery(text: "DECISION 4: a)", channel: "claude-peer", delivered: true,
                                 target: "original Claude session", error: nil, raw: nil, detail: nil)
        XCTAssertEqual(peer.summary, "Sent to original Claude session")
        let skipped = InboxDelivery.outcome(WidgetDecisionSendOutcome(["sessions": [], "sent": 0, "queued": 0, "failed": 0],
                                                                      titles: [:]), ids: ["d_4_s1"], resend: false)
        XCTAssertEqual(skipped.summary, "These decisions are no longer staged, so nothing was sent.")
        // A Mac without the decisions hook: nothing delivers a queued answer by itself, so the note must not promise it.
        let stuck = InboxDelivery.outcome(WidgetDecisionSendOutcome(["sent": 0, "queued": 1, "failed": 0, "sessions": [
            ["session": "s1", "numbers": [4], "deliversLater": false,
             "result": ["delivered": false, "detail": "no cmux pane runs this session"]],
        ]], titles: ["s1": "gt-fixes"]), ids: ["d_4_s1"], resend: false)
        XCTAssertEqual(stuck.summary, "Not delivered to gt-fixes: No cmux pane runs this session. "
                       + "Nothing sends them by itself: Send again once the session is open.")
    }

    func testANotWaitingDecisionSaysWhatBecameOfIt() throws {
        let item = try JSONDecoder().decode(InboxItem.self, from: Data(#"""
        {"kind":"decision","id":"d_26_s1","number":26,"status":"acknowledged","option":"b",
         "answer":"as a separate draft pr","at":"2026-10-27T00:41:00.000Z","revision":2}
        """#.utf8))
        XCTAssertEqual(item.revision, 2)
        XCTAssertEqual(HubInboxModel.notWaitingSentence(number: 26, item: item),
                       "Decision 26 is not waiting: it was answered (b) as a separate draft pr).")
        XCTAssertEqual(HubInboxModel.notWaitingSentence(number: 26, item: nil),
                       "Decision 26 is not in the decision log any more.")
    }

    func testARefusedWriteSaysTheCLIsSentence() {
        let stdout = Data(#"{"error":"DECISION 4 changed: the agent posted a new text since you read it."}"#.utf8)
        let refused = HubInboxModel.refusal(ProcessCapture(status: 1, stdout: stdout, stderr: Data()))
        XCTAssertEqual(refused.text, "DECISION 4 changed: the agent posted a new text since you read it.")
        XCTAssertNil(refused.raw)
        // A bare exit: one plain sentence, and the exit status with stderr behind Details, uncut (F10).
        let failed = HubInboxModel.refusal(ProcessCapture(status: 2, stdout: Data(), stderr: Data("boom\n".utf8)))
        XCTAssertEqual(failed.text, "the decision log refused the change. Try again.")
        XCTAssertEqual(failed.raw, "tools exited 2: boom")
    }
}

final class InboxDeliveryRecordTests: XCTestCase {
    func testTheLineNamesTheRoute() throws {
        let decode = { (json: String) in try JSONDecoder().decode(InboxDeliveryRecord.self, from: Data(json.utf8)) }
        let pane = try decode(#"{"route":"cmux","target":"work · agent","at":"2026-03-01T10:00:00.000Z"}"#)
        XCTAssertTrue(pane.line.hasPrefix("Sent "))
        XCTAssertTrue(pane.line.hasSuffix("to cmux pane work · agent"))
        XCTAssertFalse(pane.isQueued)
        XCTAssertTrue(try decode(#"{"route":"codex","target":"w1","at":"2026-03-01T10:00:00.000Z"}"#).line.hasSuffix("to Codex worker w1"))
        XCTAssertTrue(try decode(#"{"route":"codex","target":"codex worker w2","at":"2026-03-01T10:00:00.000Z"}"#).line.hasSuffix("to Codex worker w2"))
        let queued = try decode(#"{"route":"queued","target":"no cmux pane runs this session","at":"2026-03-01T10:00:00.000Z"}"#)
        XCTAssertTrue(queued.isQueued)
        XCTAssertTrue(queued.line.hasPrefix("Waiting to send since "))
        XCTAssertTrue(queued.line.hasSuffix(": no cmux pane runs this session."))
        // A Claude session's own channel delivered it: "Sent", never "queued … when the decisions hook is on" (F7).
        let peer = try decode(#"{"route":"claude-peer","target":"original Claude session","at":"2026-03-01T10:00:00.000Z"}"#)
        XCTAssertFalse(peer.isQueued)
        XCTAssertTrue(peer.line.hasPrefix("Sent "))
        XCTAssertTrue(peer.line.hasSuffix("to original Claude session"))
        XCTAssertFalse(peer.line.contains("hook"))
    }
}
