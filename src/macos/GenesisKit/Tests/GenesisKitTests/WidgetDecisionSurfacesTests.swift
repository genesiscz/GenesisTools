import AppKit
import SwiftUI
import Vision
import XCTest

@testable import GenesisKit

/// The widget's decision surfaces (the alert popup, the inbox of every session, a session's inbox, the staged list and
/// the leave question), checked as values and rendered for the UX audit of 2026-10-27 with
/// `WIDGET_DECISION_SHOTS=<folder>` (the same calls before and after a change, so the pairs match).
@MainActor
final class WidgetDecisionSurfacesTests: XCTestCase {
    private let key = "local:claude:fixture-decisions:"

    private func model(preferences extra: [String: Any] = [:], cards: [[String: Any]] = [],
                       staged: [[String: Any]] = [], stateDirectory: URL? = nil) throws -> WidgetModel {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.decisions." + UUID().uuidString))
        let state = stateDirectory ?? FileManager.default.temporaryDirectory.appendingPathComponent("widget-decisions-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: state.appendingPathComponent("native-submissions"),
                                                withIntermediateDirectories: true)
        // A tools stand-in that answers every call with an empty JSON object, so no startup call shows an error, and
        // `agents hooks doctor` with the settings' Agents card's fields.
        let tools = state.appendingPathComponent("tools")
        let doctor = #"{"config":{"decisions":{"questionNudge":"block","harvestListed":true}},"stopHookWired":true}"#
        try "#!/bin/sh\nfor a in \"$@\"; do if [ \"$a\" = doctor ]; then echo '\(doctor)'; exit 0; fi; done\necho '{}'\n"
            .write(to: tools, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: tools.path)
        let model = WidgetModel(binaryPath: tools.path, stateRoot: state.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "decisions." + UUID().uuidString, observeExternalChanges: false))
        var preferences: [String: Any] = ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
            "placement": "both", "side": "right", "quietSeconds": 15, "voiceProvider": "openai", "voiceLanguage": "en",
            "previewSort": "recent", "panelBackground": "dark"]
        preferences.merge(extra) { _, new in new }
        let titles = ["Kalendora hotfix research", "gt-native-ux", "gt-fixes"]
        let sessions: [[String: Any]] = titles.enumerated().map { index, title in
            ["key": key + "\(index)", "target": ["hostId": "local", "provider": "claude", "sessionId": "fixture-\(index)",
                "sourceHome": "", "cwd": "/fixture"], "title": title, "project": "Fixture",
             "activityAt": Date().timeIntervalSince1970 * 1000 - Double(index) * 60_000,
             "status": index == 0 ? "working" : "idle", "pinned": false, "visible": true, "hiddenByFilter": false]
        }
        let first = [Self.item(key + "0", number: 10, options: Self.sixOptions)]
        let second = [Self.item(key + "1", number: 4, options: Self.threeOptions),
                      Self.item(key + "1", number: 5, options: Self.threeOptions)]
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": key + "0", "preferences": preferences, "assets": [:], "drafts": [:], "outgoing": []],
            "sessions": sessions, "cards": cards, "manifests": [:], "errors": [], "selectedKey": key + "0",
            "notifications": ["unread": 0, "needsAnswer": 3, "complete": true, "truncated": false, "staged": staged,
                "sessions": [
                    ["key": key + "0", "unread": 0, "needsAnswer": 1, "pendingItem": first[0], "items": first],
                    ["key": key + "1", "unread": 0, "needsAnswer": 2, "pendingItem": second[0], "items": second],
                ]]])
        model.receive([String(decoding: data, as: UTF8.self)])
        return model
    }

    static let sixOptions = ["a) only the fleet publisher", "b) every remote call", "c) the installer as well",
                             "d) the CLI's own retries", "e) nothing until the next release", "f) ask again tomorrow"]
    static let threeOptions = ["a) keep it", "b) drop it", "c) ask the agent first"]
    static let titles = ["Where no automatic failover applies", "Keep the Maven cache out of reclaims?",
                         "Push the Marketplace 2.0 stack", "Measure the fix live on a Codex account?",
                         "One no-TTY guard for every prompt", "Rename the queue setting before the release?"]

    static func item(_ key: String, number: Int, options: [String], draftOption: String? = nil, draft: String? = nil)
        -> [String: Any]
    {
        var item: [String: Any] = ["id": "decision:d\(number)", "sourceId": "d\(number)", "kind": "decision", "key": key,
            "at": Date().timeIntervalSince1970 * 1000 - Double(number) * 1_000, "needsAnswer": true, "number": number,
            "title": titles[number % titles.count], "options": options, "recommended": "b",
            "revision": 1]
        if let draftOption { item["draftOption"] = draftOption }
        if let draft { item["draft"] = draft }
        return item
    }

    static func card(_ key: String, number: Int, status: String = "open", draftOption: String? = nil,
                     draft: String? = nil) -> [String: Any]
    {
        var card: [String: Any] = ["id": "decision:d\(number)", "kind": "decision", "sessionKey": key, "sourceId": "d\(number)",
            "at": Date().timeIntervalSince1970 * 1000 - Double(number) * 1_000, "title": "Field manifest format",
            "body": "The manifest lists every field of a work item type. Pick how the tool reads it.", "status": status,
            "revision": 1, "number": number,
            "choices": threeOptions.enumerated().map { index, title in
                ["id": String(UnicodeScalar(97 + index).map(Character.init) ?? "?"), "title": title, "recommended": index == 1]
            }, "attachments": [], "refs": [], "read": false]
        if let draftOption { card["draftOption"] = draftOption }
        if let draft { card["draft"] = draft }
        return card
    }

    private func staged() -> [[String: Any]] {
        [Self.item(key + "0", number: 7, options: Self.threeOptions, draftOption: "b", draft: "keep the old path for a week"),
         Self.item(key + "1", number: 4, options: Self.threeOptions, draftOption: "a"),
         Self.item(key + "1", number: 5, options: Self.threeOptions, draftOption: "c"),
         Self.item(key + "2", number: 2, options: Self.threeOptions, draftOption: "a"),
         Self.item(key + "2", number: 3, options: Self.threeOptions, draft: "only after the release")]
    }

    // MARK: - Values

    /// A reply names what it answers (`replyNames`): the selected open card, else the agent's newest item; the
    /// selected card only; or nothing. The composer's × drops it for one message. An agent got "its ok already set up
    /// as plugin" with no "Reply to" line and could not tell which question it answered (2026-10-27).
    func testAReplyNamesTheSelectedCardElseTheNewestAgentItem() throws {
        let answer: [String: Any] = ["id": "answer:a1", "kind": "answer", "sessionKey": key + "0", "sourceId": "a1",
            "at": Date().timeIntervalSince1970 * 1000, "title": "", "body": "The hook is\n  installed as a plugin now.",
            "status": "unread", "choices": [], "attachments": [], "refs": [], "read": false]
        let cards = [Self.card(key + "0", number: 4), answer]

        let state = FileManager.default.temporaryDirectory.appendingPathComponent("widget-reply-" + UUID().uuidString)
        let model = try model(cards: cards, stateDirectory: state)
        defer { model.stop() }
        XCTAssertEqual(model.replyNames, "selected-or-newest")
        XCTAssertEqual(model.replyToCard?.id, "answer:a1", "with nothing selected, the agent's newest item")
        let excerpt = WidgetReplyTo(card: try XCTUnwrap(model.replyToCard))
        XCTAssertEqual(excerpt, WidgetReplyTo(card: model.cards[1]))
        XCTAssertNil(excerpt.title)
        XCTAssertEqual(excerpt.excerpt, "The hook is installed as a plugin now.", "an untitled item sends its text")
        XCTAssertNil(excerpt.number)

        model.selectedCardID = "decision:d4"
        let decision = WidgetReplyTo(card: try XCTUnwrap(model.replyToCard))
        XCTAssertEqual([decision.id, decision.kind, decision.title], ["d4", "decision", "Field manifest format"])
        XCTAssertEqual(decision.number, 4)
        XCTAssertNil(decision.excerpt)

        model.foldedCardIDs.insert("decision:d4")
        XCTAssertEqual(model.replyToCard?.id, "answer:a1", "a folded card is not what the user looks at")
        model.foldedCardIDs.remove("decision:d4")

        model.dropReplyTo()
        XCTAssertNil(model.replyToCard, "the × leaves it out of this message")
        XCTAssertEqual(model.replyToCandidate?.id, "decision:d4", "and the composer still says what it dropped")
        model.dropReplyTo(false)
        XCTAssertEqual(model.replyToCard?.id, "decision:d4")

        model.selectedCardID = nil
        model.dropReplyTo()
        var newer = answer
        newer["id"] = "answer:a2"
        newer["sourceId"] = "a2"
        newer["at"] = Date().timeIntervalSince1970 * 1000 + 1000
        try receiveLookup(model, cards: cards + [newer], token: nil)
        XCTAssertEqual(model.replyToCandidate?.id, "answer:a2")
        XCTAssertNil(model.replyToCard, "a new card does not undo the opt-out")
        model.setText("A follow-up")
        model.send()
        let journal = state.appendingPathComponent("native-submissions")
        let files = try FileManager.default.contentsOfDirectory(at: journal, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: XCTUnwrap(files.first))) as? [String: Any])
        let payload = try XCTUnwrap(request["payload"] as? [String: Any])
        XCTAssertNil(payload["replyTo"], "the sent follow-up preserves the opt-out")
        XCTAssertNotNil(model.replyToCard, "the next composition restores reply naming")

        let selectedOnly = try self.model(preferences: ["replyNames": "selected"], cards: cards)
        XCTAssertNil(selectedOnly.replyToCard, "the selected card only: nothing selected names nothing")
        selectedOnly.selectedCardID = "decision:d4"
        XCTAssertEqual(selectedOnly.replyToCard?.id, "decision:d4")

        let never = try self.model(preferences: ["replyNames": "never"], cards: cards)
        never.selectedCardID = "decision:d4"
        XCTAssertNil(never.replyToCandidate, "off names nothing, selected or not")
    }

    /// F12, P3: one phrase for a waiting count that is right at 1, and "Decision 4" instead of "DECISION 4".
    func testTheWaitingCountAndTheDecisionNameReadTheSameEverywhere() {
        XCTAssertEqual(WidgetWords.waiting(1), "1 waiting for your answer", "it read \"1 need your answer\"")
        XCTAssertEqual(WidgetWords.waitingShort(1), "1 waiting", "it read \"1 need you\"")
        XCTAssertEqual(WidgetWords.numbered("Field manifest format", number: 4), "Decision 4: Field manifest format")
        XCTAssertEqual(WidgetWords.numbered("Field manifest format", number: nil), "Field manifest format")
        let item = WidgetInboxItem(id: "decision:d4", sourceId: "d4", kind: "decision", key: key, at: 0, needsAnswer: true,
                                   title: "Field manifest format", number: 4)
        XCTAssertEqual(WidgetInboxOverview.title(item), "Decision 4: Field manifest format")
        XCTAssertEqual(WidgetInboxOverview.kindLabel(item), "Decision · waiting for your answer")
    }

    /// F1 in the widget: a staged line drops the letter the agent wrote ("b) b) drop it").
    func testAStagedLineNamesTheLetterOnce() {
        let item = WidgetInboxItem(id: "decision:d7", sourceId: "d7", kind: "decision", key: key, at: 0, needsAnswer: true,
                                   title: "x", number: 7, options: Self.threeOptions, draftOption: "b",
                                   draft: "keep the old path")
        XCTAssertEqual(WidgetStagedText.line(item, option: "b"), "b) drop it · keep the old path")
        // F14: a ⇧-pick of two letters in the hub names both, each with its own text.
        XCTAssertEqual(WidgetStagedText.line(item, option: "ac"), "a) keep it / c) ask the agent first · keep the old path",
                       "it read \"ac) keep it\"")
    }

    /// P9: the own answer's hint names both keys in either Return setting.
    func testTheOwnAnswerHintNamesBothKeys() {
        XCTAssertEqual(LiveWidgetView.ownAnswerKeys(ownAnswer: true, returnStages: true, commandSwaps: true).hint,
                       "↩ stage · ⌘↩ send · ⌥↩ new line")
        XCTAssertEqual(LiveWidgetView.ownAnswerKeys(ownAnswer: true, returnStages: false, commandSwaps: true).hint,
                       "↩ send · ⌘↩ stage · ⌥↩ new line", "it read \"↩ send · ⌥↩ new line\"")
        XCTAssertEqual(LiveWidgetView.ownAnswerKeys(ownAnswer: true, returnStages: false, commandSwaps: false).hint,
                       "↩ send · ⌥↩ new line")
        XCTAssertEqual(LiveWidgetView.ownAnswerKeys(ownAnswer: false, returnStages: true, commandSwaps: true).hint,
                       "↩ send · ⌥↩ new line", "the reply composer sends on Return")
    }

    /// A decision link to a card the session lists, answered and behind the Messages filter: the Inbox shows it open,
    /// under a filter that has it, scrolled to and flashed (Martin, 2026-10-27: "it should expand the decision 172 so
    /// i see it and highlight").
    func testADecisionLinkOpensItsListedCardScrolledAndFlashed() throws {
        let model = try model(cards: [Self.card(key + "0", number: 10, status: "acknowledged"),
                                      Self.card(key + "0", number: 11)])
        model.inboxFilter = "inbox"
        model.section = "Conversation"

        model.openDecision(id: "d10", sessionKey: key + "0")

        XCTAssertEqual(model.section, "Inbox")
        XCTAssertEqual(model.inboxFilter, "all", "Messages hides decisions, so the card was not on screen")
        XCTAssertTrue(model.inboxFilterPicked, "the next snapshot must not put the filter back")
        XCTAssertEqual(model.selectedCardID, "decision:d10")
        XCTAssertFalse(model.foldedCardIDs.contains("decision:d10"))
        XCTAssertEqual(model.revealScroll, WidgetRevealScroll(rowID: "card-decision:d10", count: 1))
        XCTAssertEqual(model.revealTrigger("card-decision:d10"), 1)
        XCTAssertNotNil(model.revealStart("card-decision:d10"))
        XCTAssertEqual(model.revealTrigger("card-decision:d11"), 0, "only the linked card flashes")
        XCTAssertNil(model.chatDecision)

        model.inboxFilter = "decisions"
        model.openDecision(id: "d10", sessionKey: key + "0")
        XCTAssertEqual(model.inboxFilter, "decisions", "a filter that shows the card stays")
        XCTAssertEqual(model.revealScroll?.count, 2, "a second link scrolls and flashes again")
    }

    private func receiveLookup(_ model: WidgetModel, cards: [[String: Any]], token: String?) throws {
        let snapshot = try XCTUnwrap(model.snapshot)
        var value = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(snapshot)) as? [String: Any])
        value["cards"] = cards
        value["decisionLookup"] = token
        let data = try JSONSerialization.data(withJSONObject: value)
        model.receive([String(decoding: data, as: UTF8.self)])
    }

    func testDecisionRevealWaitsForItsTargetedSnapshotRatherThanCachedCards() throws {
        let model = try model(cards: [Self.card(key + "0", number: 10)])
        model.openDecision(id: "d11", sessionKey: key + "0")
        let token = try XCTUnwrap(model.pendingDecision?.token)
        try receiveLookup(model, cards: [Self.card(key + "0", number: 10)], token: nil)
        XCTAssertNil(model.chatDecision, "a fast-path snapshot cannot prove the new decision is absent")
        XCTAssertNotNil(model.pendingDecision)
        try receiveLookup(model, cards: [Self.card(key + "0", number: 10)], token: "older-request")
        XCTAssertNotNil(model.pendingDecision, "a different completed lookup cannot settle this request")
        try receiveLookup(model, cards: [Self.card(key + "0", number: 11, status: "acknowledged")], token: token)
        XCTAssertNil(model.chatDecision)
        XCTAssertEqual(model.revealScroll?.rowID, "card-decision:d11")
        XCTAssertNil(model.pendingDecision)
    }

    /// A decision asked only in a chat reply is not in the log (Decision 172, 2026-10-27): the panel says why the Inbox
    /// lacks it and shows the chat instead of an Inbox that silently lacks it.
    func testADecisionLinkToAChatOnlyDecisionShowsTheChatAndSaysWhy() throws {
        let model = try model(cards: [Self.card(key + "0", number: 10)])

        model.openDecision(id: "d_172_fixture-0", sessionKey: key + "0")
        XCTAssertNil(model.chatDecision, "a cached snapshot is not evidence of absence")
        let token = try XCTUnwrap(model.pendingDecision?.token)
        model.fail("An unrelated draft save failed")
        try receiveLookup(model, cards: [Self.card(key + "0", number: 10)], token: token)

        XCTAssertEqual(model.error, "An unrelated draft save failed")
        XCTAssertEqual(model.section, "Conversation")
        XCTAssertEqual(model.chatDecision?.number, 172)
        XCTAssertEqual(model.chatDecision?.id, "d_172_fixture-0")
        XCTAssertEqual(model.notice, "Decision 172 was asked only in chat and is not in the decision log. Showing the chat.")
        XCTAssertNil(model.revealScroll, "nothing to scroll to before the chat has loaded")
        XCTAssertEqual(model.selectedCardID, "decision:d_172_fixture-0")

        let turns = [TranscriptTurn(id: "t1", role: "user", text: "what about DECISION 1720?"),
                     TranscriptTurn(id: "t2", role: "assistant", text: "❓ DECISION 172\n**a)** keep it"),
                     TranscriptTurn(id: "t3", role: "user", text: "DECISION 172 a)"),
                     TranscriptTurn(id: "t4", role: "assistant", text: "Recorded DECISION 172.")]
        XCTAssertEqual(WidgetModel.firstTurnAsking(172, in: turns)?.id, "t2", "the first asking turn, never 1720")
        XCTAssertNil(WidgetModel.firstTurnAsking(17, in: turns))
        XCTAssertNil(WidgetModel.firstTurnAsking(172, in: Array(turns.suffix(2))),
                     "a user quote and assistant acknowledgement do not identify the asking turn")
        XCTAssertEqual(WidgetModel.firstTurnAsking(172, in: [TranscriptTurn(
            id: "heading", role: "assistant", text: "## ❓ DECISION 172\nChoose one")])?.id, "heading")
        XCTAssertEqual(WidgetModel.firstTurnAsking(172, in: [TranscriptTurn(
            id: "bold", role: "assistant", text: "❓ **DECISION 172** — Choose one\n**a)** keep it")])?.id, "bold")
        XCTAssertNil(WidgetModel.firstTurnAsking(17, in: [TranscriptTurn(
            id: "bold", role: "assistant", text: "❓ **DECISION 172** — Choose one")]))
        XCTAssertNil(WidgetModel.firstTurnAsking(172, in: [TranscriptTurn(
            id: "quote", role: "user", text: "❓ **DECISION 172** — Choose one")]))
        XCTAssertEqual(WidgetModel.decisionNumber("d_172_a1523c66-103f"), 172)
        XCTAssertNil(WidgetModel.decisionNumber("d10"))
    }

    /// A bad answer from `tools` reads as one sentence with the decoder's own words behind Details, never Foundation's
    /// "The data couldn't be read because it isn't in the correct format." alone; the panel's error offers Reconnect.
    func testAFailedCallSaysWhatHappenedInOneSentence() throws {
        struct Row: Decodable { let n: Int }
        var caught: Error?
        do { _ = try JSONDecoder().decode(Row.self, from: Data(#"{"n":"x"}"#.utf8)) } catch { caught = error }
        let decoding = try XCTUnwrap(caught)
        let words = WidgetErrorText.words(for: decoding)
        XCTAssertEqual(words.text, "The widget could not read the hub's answer. Try again, or reconnect.")
        XCTAssertTrue(words.detail?.contains("n") == true, words.detail ?? "")
        XCTAssertFalse(words.text.contains("correct format"))
        XCTAssertEqual(WidgetErrorText.words(for: ToolsBridgeError.timeout(seconds: 20)).text,
                       "The hub did not answer within 20 seconds. Try again, or reconnect.")
        XCTAssertEqual(WidgetErrorText.words(for: ToolsBridgeError.refused("Decision 4 changed since you read it.")).text,
                       "Decision 4 changed since you read it.", "a refusal keeps the CLI's own sentence")
        let model = try model(staged: staged())
        defer { model.stop() }
        model.report(decoding)
        XCTAssertEqual(model.error, words.text)
        XCTAssertNotNil(model.errorDetail, "the raw words wait behind Details")
    }

    /// P11: a pick sent from the alert popup stays there unless Alerts → After a send says "Open its session".
    func testAfterASendFollowsItsSetting() throws {
        XCTAssertFalse(WidgetPeekView.sendOpensSession(nil), "the default stays in the popup")
        let stay = try model()
        defer { stay.stop() }
        XCTAssertFalse(WidgetPeekView.sendOpensSession(stay.snapshot?.state.preferences))
        let open = try model(preferences: ["popupSendOpens": "session"])
        defer { open.stop() }
        XCTAssertEqual(open.snapshot?.state.preferences.popupSendOpens, "session", "the hub's key reaches the widget")
        XCTAssertTrue(WidgetPeekView.sendOpensSession(open.snapshot?.state.preferences))
    }

    /// F21: Discard checked waits behind the model's Undo window, and while it waits no view reads those decisions as
    /// staged (the session card, the overview row, the alert's option).
    func testADiscardInItsUndoWindowNoLongerReadsAsStaged() throws {
        let model = try model(staged: staged())
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let two = Array(model.stagedItems.prefix(2))
        XCTAssertEqual(two.count, 2)
        XCTAssertEqual(model.shownStagedOption(two[0].sourceId, stored: two[0].draftOption), "b")
        model.holdDiscard(two.map(\.sourceId))
        XCTAssertEqual(model.stagedItems.count, 3, "the discarded ones leave the staged list at once")
        XCTAssertNil(model.shownStagedOption(two[0].sourceId, stored: two[0].draftOption))
        XCTAssertNil(model.shownStagedNote(two[0].sourceId, two[0].draft))
        model.undoHeldDiscard()
        XCTAssertEqual(model.shownStagedOption(two[0].sourceId, stored: two[0].draftOption), "b", "Undo brings them back")
    }

    /// Decision audit F12 in the widget: a revision that clears a staged pick says so in plain words, with the name
    /// every surface uses ("Decision 7", not "DECISION 7").
    func testARevisionThatClearsAStagedPickSaysSoInPlainWords() throws {
        let model = try model()
        defer { model.stop() }
        let old = WidgetInboxItem(id: "decision:d7", sourceId: "d7", kind: "decision", key: key + "0", at: 0,
                                  needsAnswer: true, title: "x", number: 7, revision: 1, draftOption: "b")
        model.reconcileStaged([old])
        var revised = old
        revised.revision = 2
        revised.draftOption = nil
        model.reconcileStaged([], listed: [revised])
        XCTAssertEqual(model.notice, "Decision 7 changed. The agent wrote new text, so your staged pick b) is cleared. "
            + "Read the decision again and pick.")
        XCTAssertEqual(model.noticeTone, .warning)
    }

    /// ⇧-click adds a letter on every surface, so the shared tooltip says it, and says the other way on a picked one.
    func testTheOptionTooltipNamesTheShiftClick() {
        XCTAssertTrue(DecisionAnswering.optionTooltip("b", recommended: false, stages: true, picked: false, swaps: true)
            .hasSuffix(" · ⇧-click adds it to the pick"))
        XCTAssertTrue(DecisionAnswering.optionTooltip("b", recommended: false, stages: true, picked: true, swaps: true)
            .hasSuffix(" · ⇧-click takes it out of the pick"))
        XCTAssertEqual(DecisionAnswering.optionTooltip("b", recommended: true, stages: false, picked: false, swaps: true, key: 2),
                       "Answer b (recommended) · key 2 · ⌘-click stages it · ⇧-click adds it to the pick")
    }

    /// The leave question counts a pick made a moment before Esc, which no snapshot lists yet (decision audit F16).
    func testTheLeaveQuestionCountsAPickNoSnapshotListsYet() throws {
        let model = try model(staged: Array(staged().prefix(1)))
        defer { model.stop() }
        let fresh = WidgetInboxItem(id: "decision:d4", sourceId: "d4", kind: "decision", key: key + "1", at: 2,
                                    needsAnswer: true, title: "x", number: 4, options: Self.threeOptions, revision: 1)
        model.markPending("d4", "a", item: fresh)
        XCTAssertEqual(model.stagedItems.count, 1)
        XCTAssertEqual(model.stagedForLeave.count, 2)
        let renderer = ImageRenderer(content: WidgetStagedLeavePrompt(model: model)
            .frame(width: 420, height: 300).environment(\.colorScheme, .dark).background(Color.black))
        renderer.scale = 2
        let text = try recognizedText(XCTUnwrap(renderer.cgImage))
        XCTAssertTrue(text.contains("You have 2 decisions staged"), text)
    }

    func testDecisionLinkSelectsTheDecisionInAnOpenPanel() throws {
        let model = try model(preferences: ["showWidget": true])
        let coordinator = WidgetCoordinator(binaryPath: "/fixture/tools", openHub: { _ in }, model: model)
        defer { coordinator.stop() }
        model.expanded = .right
        model.inboxOverview = true
        model.stagedView = "all"
        model.hover(WidgetSurfaceID(edge: .right), inside: true)
        coordinator.showDecision("d4")
        XCTAssertEqual(model.selectedKey, key + "1")
        XCTAssertEqual(model.selectedCardID, "decision:d4")
        XCTAssertEqual(model.section, "Inbox")
        XCTAssertFalse(model.inboxOverview)
        XCTAssertNil(model.stagedView)
    }

    func testShutdownWaitsForHeldDiscard() async throws {
        let model = try model(staged: Array(staged().prefix(1)))
        let started = expectation(description: "held discard started")
        let finished = expectation(description: "widget shutdown finished")
        var release: CheckedContinuation<Void, Never>?
        var completed = false
        var actions: [WidgetJSON] = []
        model.actionRunner = { value in
            actions.append(value)
            if case .object(let fields) = value, fields["action"] == "unstage" {
                await withCheckedContinuation { continuation in
                    release = continuation
                    started.fulfill()
                }
            }
            return ["ok": true]
        }
        let coordinator = WidgetCoordinator(binaryPath: "/fixture/tools", openHub: { _ in }, model: model)
        // Snapshot application queues selection before the test installs its runner. Drain that setup write so
        // this case isolates the held discard; the separate ordering test covers a discard behind a held write.
        let setupDrained = expectation(description: "snapshot setup writes drained")
        model.afterMutations { setupDrained.fulfill() }
        await fulfillment(of: [setupDrained], timeout: 1)
        let ids = model.stagedItems.map(\.sourceId)
        XCTAssertEqual(ids, ["d7"], "the fixture must contain the staged decision")
        model.holdDiscard(ids)
        XCTAssertEqual(model.heldDiscard, ids, "shutdown must receive the held discard")
        Task { await coordinator.shutdown(); completed = true; finished.fulfill() }
        await fulfillment(of: [started], timeout: 1)
        XCTAssertFalse(completed, "shutdown waits for the held discard; actions: \(actions)")
        release?.resume()
        await fulfillment(of: [finished], timeout: 1)
        XCTAssertTrue(completed)
    }

    func testShutdownKeepsHeldDiscardBehindEarlierWrites() async throws {
        let model = try model(staged: Array(staged().prefix(1)))
        let earlierStarted = expectation(description: "earlier write started")
        let discardStarted = expectation(description: "held discard started")
        let finished = expectation(description: "shutdown writes finished")
        var release: CheckedContinuation<Void, Never>?
        var writes: [String] = []
        model.actionRunner = { value in
            if case .object(let fields) = value, case .string(let action) = fields["action"] {
                writes.append(action)
                if action == "unstage" { discardStarted.fulfill() }
            }
            return ["ok": true]
        }
        model.afterMutations {
            await withCheckedContinuation { continuation in
                release = continuation
                earlierStarted.fulfill()
            }
        }
        await fulfillment(of: [earlierStarted], timeout: 1)
        let ids = model.stagedItems.map(\.sourceId)
        XCTAssertEqual(ids, ["d7"])
        model.holdDiscard(ids)
        XCTAssertEqual(model.heldDiscard, ids)
        model.stop()
        var result: Bool?
        Task { result = await model.waitForShutdownMutations(); finished.fulfill() }
        XCTAssertFalse(writes.contains("unstage"), "the discard cannot pass the earlier write")
        release?.resume()
        await fulfillment(of: [discardStarted, finished], timeout: 1)
        XCTAssertEqual(result, true)
        XCTAssertEqual(writes.filter { $0 == "unstage" }.count, 1)
    }

    func testShutdownMutationWaitHasADeadline() async throws {
        let model = try model(staged: Array(staged().prefix(1)))
        let started = expectation(description: "stuck discard started")
        let finished = expectation(description: "bounded wait finished")
        var release: CheckedContinuation<Void, Never>?
        var result: Bool?
        model.actionRunner = { value in
            if case .object(let fields) = value, fields["action"] == "unstage" {
                await withCheckedContinuation { continuation in
                    release = continuation
                    started.fulfill()
                }
            }
            return ["ok": true]
        }
        let ids = model.stagedItems.map(\.sourceId)
        XCTAssertEqual(ids, ["d7"], "the fixture must contain the staged decision")
        model.holdDiscard(ids)
        XCTAssertEqual(model.heldDiscard, ids)
        model.stop()
        await fulfillment(of: [started], timeout: 1)
        Task { result = await model.waitForShutdownMutations(timeout: .milliseconds(30)); finished.fulfill() }
        await fulfillment(of: [finished], timeout: 1)
        XCTAssertEqual(result, false, "a stuck write cannot make shutdown wait without a deadline")
        release?.resume()
    }

    private func recognizedText(_ image: CGImage) throws -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    }

    /// P7: the primary button draws its accent in a window that is not key, where `.borderedProminent` turned grey.
    func testThePrimaryButtonKeepsItsColourOutsideAKeyWindow() throws {
        let button = Button("Send 3 now") {}.buttonStyle(.genPrimary())
            .frame(width: 140, height: 40).background(Color.black)
        let rep = try KitShots.render(button, size: CGSize(width: 140, height: 40), name: "gen-primary")
        // A point on the fill, left of the label.
        let color = try XCTUnwrap(KitShots.color(rep, at: CGPoint(x: 30, y: 20), viewWidth: 140)?.usingColorSpace(.sRGB))
        XCTAssertGreaterThan(color.blueComponent, color.redComponent + 0.25, "the fill is blue, not an inactive grey: \(color)")
        // The white label reads on it (WCAG 4.5:1); SessionPalette.blue as the fill gave 2.6:1.
        func linear(_ c: CGFloat) -> CGFloat { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        let luminance = 0.2126 * linear(color.redComponent) + 0.7152 * linear(color.greenComponent)
            + 0.0722 * linear(color.blueComponent)
        XCTAssertGreaterThanOrEqual(1.05 / (luminance + 0.05), 4.5, "white on \(color)")
    }

    // MARK: - Shots

    private func write(_ view: some View, _ size: CGSize, _ name: String, model: WidgetModel, folder: String) throws {
        // The fixture has no tools binary: its startup calls fail, which is not what these shots are about.
        model.error = nil
        let themed = view.frame(width: size.width, height: size.height, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, model.panelTheme)
            .environment(\.colorScheme, .dark)
        let rep = try KitShots.render(themed, size: size, name: name, settle: 0.8)
        try XCTUnwrap(rep.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + ".png"))
    }

    /// The alert popup: six options, the staged reminder, and a burst listed under the first alert.
    func testRendersThePopups() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let model = try model(staged: staged())
        defer { model.stop() }
        let six = try XCTUnwrap(model.inboxFor(key + "0")?.pendingItem)
        try write(WidgetPeekView(model: model, item: six).padding(WidgetPeekView.inset), CGSize(width: 310, height: 330),
                  "popup-six-options", model: model, folder: folder)
        let reminder = WidgetInboxItem(id: WidgetAlerts.stagedReminderID, sourceId: WidgetAlerts.stagedReminderID,
                                       kind: "staged", key: key + "0", at: Date().timeIntervalSince1970 * 1000,
                                       needsAnswer: false)
        try write(WidgetPeekView(model: model, item: reminder).padding(WidgetPeekView.inset),
                  CGSize(width: 310, height: 250), "popup-staged-reminder", model: model, folder: folder)
        let side = WidgetSurfaceID(edge: .right)
        model.showPeek(six, on: side, seconds: 0, many: .list)
        for number in 20..<25 {
            let later = WidgetInboxItem(id: "decision:d\(number)", sourceId: "d\(number)", kind: "decision", key: key + "1",
                at: six.at + Double(number), needsAnswer: true, title: "A later question number \(number)", number: number)
            model.showPeek(later, on: side, seconds: 0, many: .list)
        }
        try write(WidgetPeekView(model: model, item: six).padding(WidgetPeekView.inset), CGSize(width: 310, height: 520),
                  "popup-listed", model: model, folder: folder)
        // F5: a send from the popup shows its outcome there: delivered, then not delivered with Send again.
        model.dismissPeek(all: true)
        model.showPeek(six, on: side, seconds: 0, many: .list)
        model.peekOutcome = WidgetPeekOutcome(text: "1 decision delivered.", tone: .success)
        try write(WidgetPeekView(model: model, item: six).padding(WidgetPeekView.inset), CGSize(width: 310, height: 230),
                  "popup-outcome-delivered", model: model, folder: folder)
        model.peekOutcome = WidgetPeekOutcome(
            text: "Not delivered to Kalendora hotfix research: No open Claude terminal takes messages for this session. "
                + "The answers wait for its next prompt.", tone: .warning, sendAgain: [six],
            detail: "Kalendora hotfix research: No native Claude receiver claims this session.")
        try write(WidgetPeekView(model: model, item: six).padding(WidgetPeekView.inset), CGSize(width: 310, height: 300),
                  "popup-outcome-not-delivered", model: model, folder: folder)
    }

    /// F22: a note that reports a send no session took reads as a warning, not as a grey caption.
    func testRendersAWarningNote() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let model = try model(cards: [Self.card(key + "0", number: 8)], staged: staged())
        defer { model.stop() }
        model.error = nil
        model.postNote("Not delivered to Kalendora hotfix research: No open Claude terminal takes messages for this "
            + "session. The answers wait for its next prompt.", action: WidgetNoticeAction(title: "Send again") {},
            tone: .warning)
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), CGSize(width: 420, height: 520),
                  "session-inbox-warning-note", model: model, folder: folder)
    }

    /// The inbox of every session with its staged chip, the staged list, and the leave question.
    func testRendersTheOverviewAndTheStagedViews() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let model = try model(staged: staged())
        defer { model.stop() }
        let panel = CGSize(width: 420, height: 760)
        model.inboxOverview = true
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "overview", model: model, folder: folder)
        model.stagedView = "all"
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "staged-list", model: model, folder: folder)
        model.stagedView = nil
        model.stagedLeavePrompt = true
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "leave-prompt", model: model, folder: folder)
    }

    /// A session's inbox with a staged decision open, then its own answer open with Return set to send.
    func testRendersTheSessionInbox() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let card = Self.card(key + "0", number: 7, status: "drafted", draftOption: "b", draft: "keep the old path for a week")
        let model = try model(preferences: ["ownAnswerReturn": "send"], cards: [card, Self.card(key + "0", number: 8)],
                              staged: staged())
        defer { model.stop() }
        let panel = CGSize(width: 420, height: 900)
        let staged = try XCTUnwrap(model.cards.first { $0.number == 7 })
        model.openCard(staged)
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "session-inbox-staged",
                  model: model, folder: folder)
        let open = try XCTUnwrap(model.cards.first { $0.number == 8 })
        model.openCard(open)
        model.openOwnAnswer(open)
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "session-inbox-own-answer-send",
                  model: model, folder: folder)
    }

    /// Widgets → General, the Inbox behavior card's words.
    func testRendersTheSettings() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let model = try model()
        defer { model.stop() }
        let general = try XCTUnwrap(WidgetFeatureSettings.sections(model: model, modules: WidgetModuleChoice.builtins,
            openSession: { _ in }).flatMap(\.pages).first { $0.id == "widgets.general" })
        let page = ScrollView { general.content().padding(24) }
        try write(page, CGSize(width: 760, height: 5200), "settings-general", model: model, folder: folder)
    }
}
