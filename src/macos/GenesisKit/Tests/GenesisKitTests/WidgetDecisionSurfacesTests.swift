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

    /// `inbox`: the first session's waiting entries, and the only session in the inbox of every session; nil lists the
    /// three decisions of the 2026-10-27 audit under two sessions.
    private func model(preferences extra: [String: Any] = [:], cards: [[String: Any]] = [],
                       staged: [[String: Any]] = [], inbox: [[String: Any]]? = nil,
                       stateDirectory: URL? = nil) throws -> WidgetModel {
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
        var inboxSessions: [[String: Any]] = [
            ["key": key + "0", "unread": 0, "needsAnswer": 1, "pendingItem": first[0], "items": first],
            ["key": key + "1", "unread": 0, "needsAnswer": 2, "pendingItem": second[0], "items": second],
        ]
        if let inbox, let pending = inbox.first {
            inboxSessions = [["key": key + "0", "unread": 0, "needsAnswer": inbox.count, "pendingItem": pending,
                              "items": inbox]]
        }
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": key + "0", "preferences": preferences, "assets": [:], "drafts": [:], "outgoing": []],
            "sessions": sessions, "cards": cards, "manifests": [:], "errors": [], "selectedKey": key + "0",
            "notifications": ["unread": 0, "needsAnswer": inbox?.count ?? 3, "complete": true, "truncated": false,
                "staged": staged, "sessions": inboxSessions]])
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
        XCTAssertFalse(WidgetPeekView.sendOpensSession(open.snapshot?.state.preferences, staging: true),
                       "a staged pick, including Shift, is not a send")
    }

    /// A file link in a card follows Inbox behavior → Clicking a file link, read at the click, through one handler the
    /// model keeps: every panel then hands its texts the same link environment.
    func testFileLinkClicksFollowTheirSettingThroughOneHandler() throws {
        let plain = try model()
        defer { plain.stop() }
        XCTAssertEqual(plain.pathLinks.click(), .genesisMarkdown, "the default opens notes in Genesis Markdown")
        XCTAssertTrue(plain.pathLinks === plain.pathLinks, "one handler per model")
        let ask = try model(preferences: ["fileLinkClick": "ask"])
        defer { ask.stop() }
        XCTAssertEqual(ask.snapshot?.state.preferences.fileLinkClick, "ask", "the hub's key reaches the widget")
        XCTAssertEqual(ask.pathLinks.click(), .ask)
    }

    /// A link to a file that is gone says so in the widget's own note, which is announced, holds on hover and stays for
    /// the note duration setting; the default `CopyToast` at the pointer did none of that. Under every setting, and
    /// from the right-click menu's "Not on Disk" too. Nothing opens: the file is not there.
    func testALinkToAMissingFileSaysSoInTheWidgetsNote() throws {
        let gone = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("no-such-folder-\(UUID().uuidString)/Gone.md").path
        let shown = "Not on disk: " + PathDisplay.tilde(gone)
        XCTAssertTrue(shown.hasPrefix("Not on disk: ~/no-such-folder-"), shown)
        for click in ["genesis-markdown", "default-app", "ask"] {
            let model = try model(preferences: ["fileLinkClick": click])
            defer { model.stop() }
            XCTAssertEqual(model.pathLinks.perform(path: gone, lines: nil, menu: false), .missing(gone), click)
            XCTAssertEqual(model.notice, shown, click)
            XCTAssertEqual(model.noticeTone, .warning, click)

            model.notice = nil
            let entries = model.pathLinks.contextEntries([PathLinkRef(label: "Gone.md", path: gone, lines: nil)])
            guard case .item(let missing) = try XCTUnwrap(entries.first), missing.title == "Not on Disk" else {
                return XCTFail("no Not on Disk item for \(click)")
            }
            missing.run()
            XCTAssertEqual(model.notice, shown, "the menu item posts the same note (\(click))")
        }
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

    func testUnfinishedWidthPreviewExpires() async throws {
        let model = try model(preferences: ["showWidget": true])
        let coordinator = WidgetCoordinator(binaryPath: "/fixture/tools", openHub: { _ in }, model: model)
        defer { coordinator.stop() }
        coordinator.showLivePreview(width: 400, done: false, fallbackSeconds: 0.15)
        XCTAssertEqual(model.livePreviewWidth, 400)
        try await Task.sleep(for: .seconds(0.3))
        XCTAssertNil(model.livePreviewWidth)
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

    // MARK: - The hub Inbox card's context (2026-11-01)

    /// The decision of the 2026-11-01 screenshot with an invented session, paths and answer: a context taller than the
    /// fold, one cited file with its lines, a proposal, a reason on option b, high confidence. "sent" adds the pick,
    /// an answer of its own and a delivery.
    static func contextCard(_ key: String, status: String = "open") -> [String: Any] {
        let excerpt = [
            #"import { commandTokenIndex, commandWord, splitPipeline, tokenize } from "@genesiscz/utils/shell/scan";"#,
            "",
            "/** The `tools rm` verbs that let a request through, trust a folder, or change settings: a person's to run. */",
            "const RM_USER_VERB =",
            #"    /(?:^|[\s;&|(])(?:\S*\/)?tools\s+rm\s+(?:approve|roots\s+add|config\s+set|profile\s+(?:set|remove))\b|[\\/]rm[\\/]index\.ts\s+(?:approve|roots\s+add|config\s+set|profile\s+(?:set|remove))\b/;"#,
            "",
            "export const rmUserVerbs: ShellRule = {",
            #"    id: "rm-user-verbs","#,
            #"    kind: "destructive","#,
            #"    severity: "block","#,
            "};",
        ].joined(separator: "\n")
        let context = "The block protects nothing that the dialog does not already protect, but AGENTS.md is your "
            + "shared policy, so I do not change it without your word. The `--help` false positive of the same rule is "
            + "fixed separately and does not depend on this.\n\n"
            + "Today an agent that runs `tools rm approve <id>` is stopped before the dialog opens, so a large delete "
            + "waits until you type the command yourself.\n\n"
            + "- The dialog asks for Touch ID, so an agent cannot approve its own request.\n"
            + "- A size floor keeps small scratch deletes quiet.\n"
            + "- The rule's message names the command you can run instead.\n"
            + "- A refused approval says which rule refused it and where its setting lives.\n"
            + "- Nothing changes for a person who types the command in a terminal."
        var details: [String: Any] = [
            "context": context, "confidence": "high", "recommended": "a",
            "proposal": "a): it matches both of your instructions. The dialog stays the only approval path.",
            "refs": [[
                "path": "src/agents/lib/hooks/tool-rules.ts", "line": 9,
                "absolute": "/Users/alice/Projects/Fixture/src/agents/lib/hooks/tool-rules.ts",
                "excerpt": excerpt, "startLine": 6, "language": "typescript", "missing": false, "matches": 1,
                "from": "posted",
            ]],
        ]
        var card: [String: Any] = [
            "id": "decision:d1", "kind": "decision", "sessionKey": key, "sourceId": "d1",
            "at": Date().timeIntervalSince1970 * 1000 - 60_000,
            "title": "May an agent start `tools rm approve <id>` to open the approval dialog?", "body": "",
            "status": status, "revision": 1, "number": 1,
            "choices": [
                ["id": "a", "title": "allow at 1 GB or more", "recommended": true],
                ["id": "b", "title": "allow any size", "recommended": false,
                 "rationale": "every delete would ask for Touch ID"],
                ["id": "c", "title": "keep the block, fix the message", "recommended": false],
            ],
            "attachments": [], "refs": [["type": "file", "value": "src/agents/lib/hooks/tool-rules.ts"]], "read": true,
            "sourceContext": ["sessionId": "fixture-0", "agent": "claude", "project": "Fixture",
                              "cwd": "/Users/alice/Projects/Fixture", "repoRoot": "/Users/alice/Projects/Fixture",
                              "branch": "feat/2026-10-13-enhancements"],
        ]
        if status == "sent" {
            card["option"] = "a"
            card["answer"] = "a) allow it at the size I set, and have the agent ask before anything under 10 MB."
            card["answeredVia"] = "inbox"
            details["delivery"] = ["route": "claude-peer", "target": "original Claude session",
                                   "at": "2026-11-01T17:31:00.000Z"]
        }
        card["decision"] = details
        return card
    }

    /// A card and preferences from a hub older than the decision details still decode: no details, no reasons, and the
    /// card's text is its body.
    func testACardFromAnOlderHubDecodesWithoutDetails() throws {
        let old = try JSONDecoder().decode(WidgetCard.self, from: JSONSerialization.data(
            withJSONObject: Self.card(key + "0", number: 8)))
        XCTAssertNil(old.decision)
        XCTAssertTrue(old.choices.allSatisfy { $0.rationale == nil })
        XCTAssertEqual(old.fullText, old.body)
        let model = try model()
        defer { model.stop() }
        let preferences = try XCTUnwrap(model.snapshot?.state.preferences)
        XCTAssertNil(preferences.decisionContext)
        XCTAssertNil(preferences.decisionCode)
        XCTAssertNil(preferences.decisionProposal)
        // An older hub sends no `overviewSummary`: the inbox of every session shows the description (default on).
        XCTAssertNil(preferences.overviewSummary)
    }

    /// A card with the hub's details decodes every field in the hub's shape (`DecisionRef`, `DecisionDelivery`), and
    /// its whole text carries the context, the pick and the notes for read aloud and the previews.
    func testACardWithTheHubsDetailsDecodesThemAll() throws {
        let card = try JSONDecoder().decode(WidgetCard.self, from: JSONSerialization.data(
            withJSONObject: Self.contextCard(key + "0", status: "sent")))
        let details = try XCTUnwrap(card.decision)
        XCTAssertEqual(details.confidence, "high")
        XCTAssertEqual(details.recommended, "a")
        XCTAssertTrue(details.context?.hasPrefix("The block protects nothing") == true)
        let ref = try XCTUnwrap(details.refs?.first)
        XCTAssertEqual(ref.displayPath, "src/agents/lib/hooks/tool-rules.ts:9")
        XCTAssertEqual(ref.startLine, 6)
        XCTAssertTrue(ref.hasContent)
        XCTAssertEqual(ref.lines, MarkdownLineRange(first: 9, last: 9))
        XCTAssertEqual(ref.file(under: "/elsewhere"), "/Users/alice/Projects/Fixture/src/agents/lib/hooks/tool-rules.ts")
        XCTAssertEqual(card.choices[1].rationale, "every delete would ask for Touch ID")
        let delivery = try XCTUnwrap(details.delivery)
        XCTAssertFalse(delivery.isQueued)
        XCTAssertTrue(delivery.line.hasPrefix("Sent "), delivery.line)
        XCTAssertTrue(delivery.line.hasSuffix(" to original Claude session"), delivery.line)
        XCTAssertTrue(card.fullText.contains("The block protects nothing"))
        XCTAssertTrue(card.fullText.contains("it matches both of your instructions"))
        // Read aloud takes the card whole: the previews' text, then each option's words, as the hub's handoff writes
        // them. The previews leave the options to their buttons.
        XCTAssertFalse(card.fullText.contains("Options:"), card.fullText)
        XCTAssertEqual(card.wholeText, card.fullText + "\n\nOptions:\na) allow at 1 GB or more (recommended)\n"
            + "b) allow any size\n   Why: every delete would ask for Touch ID\nc) keep the block, fix the message")
        let missing = try JSONDecoder().decode(DecisionRef.self, from: Data(
            #"{"path":"src/gone.ts","line":3,"missing":true,"searched":["/Users/alice/Projects/Fixture"],"matches":0}"#.utf8))
        XCTAssertTrue(missing.hasContent)
        XCTAssertEqual(missing.unresolvedNote.label, "can't locate")
        XCTAssertEqual(missing.file(under: "/Users/alice/Projects/Fixture"), "/Users/alice/Projects/Fixture/src/gone.ts")
    }

    /// The agent's pick sits under the option it recommends, without the letter it starts with; above the options when
    /// it names another option, when the card is answered, or when the setting says so.
    func testTheAgentsPickSitsUnderItsOptionWithoutTheLetter() throws {
        XCTAssertEqual(WidgetProposal.underOption("a): it matches both", letter: "a"), "it matches both")
        XCTAssertEqual(WidgetProposal.underOption("(b) cheaper", letter: "b"), "cheaper")
        XCTAssertEqual(WidgetProposal.underOption("A. the safe one", letter: "a"), "the safe one")
        XCTAssertEqual(WidgetProposal.underOption("I would keep it", letter: "a"), "I would keep it")
        XCTAssertNil(WidgetProposal.underOption("b) the other one", letter: "a"))
        let open = try JSONDecoder().decode(WidgetCard.self, from: JSONSerialization.data(
            withJSONObject: Self.contextCard(key + "0")))
        let placed = try XCTUnwrap(WidgetProposal.placement(open, preferences: nil))
        XCTAssertEqual(placed.letter, "a")
        XCTAssertEqual(placed.text, "it matches both of your instructions. The dialog stays the only approval path.")
        let sent = try JSONDecoder().decode(WidgetCard.self, from: JSONSerialization.data(
            withJSONObject: Self.contextCard(key + "0", status: "sent")))
        XCTAssertNil(WidgetProposal.placement(sent, preferences: nil), "an answered card shows no options")
        let model = try model(preferences: ["decisionProposal": "above"])
        defer { model.stop() }
        XCTAssertNil(WidgetProposal.placement(open, preferences: model.snapshot?.state.preferences))
        // The Code section shows the cited file, so the list under the buttons does not name it again.
        XCTAssertTrue(LiveWidgetView.listedRefs(open, preferences: nil).isEmpty)
        let hidden = try self.model(preferences: ["decisionCode": "hide"])
        defer { hidden.stop() }
        XCTAssertEqual(LiveWidgetView.listedRefs(open, preferences: hidden.snapshot?.state.preferences).count, 1)
    }

    /// The open decision card as a session's inbox draws it, rendered in a window that is never ordered front: the
    /// Context section folded with Show all, the Code section with the cited path and its lines, the confidence chip,
    /// the Recommended badge, the reason on option b and the agent's pick under option a. Code set to Hide leaves the
    /// Code section out; Context set to Open drops Show all for Show less.
    func testTheOpenDecisionCardDrawsItsContextAndCode() throws {
        let text = try decisionCardText(preferences: [:])
        for expected in ["Context", "Show all", "Code", "tool-rules.ts:9", "High confidence", "Recommended",
                         "RM_USER_VERB", "every delete would ask", "it matches both of your instructions"] {
            XCTAssertTrue(text.contains(expected), "\(expected) in: \(text)")
        }
        XCTAssertFalse(text.contains("a): it matches"), "the pick under option a drops its letter: \(text)")
        let hidden = try decisionCardText(preferences: ["decisionCode": "hide", "decisionContext": "open"])
        XCTAssertFalse(hidden.contains("RM_USER_VERB"), hidden)
        XCTAssertFalse(hidden.contains("tool-rules.ts:9"), hidden)
        XCTAssertTrue(hidden.contains("Show less"), hidden)
        XCTAssertTrue(hidden.contains("types the command in a terminal"), "open shows the whole context: \(hidden)")
    }

    /// A file link in a decision's notes or in the agent's pick lists its ways to open on a right-click, as the card's
    /// body (`WidgetMarkdown`) and its Context section do: `.pathLinks` routes a left-click only, and SwiftUI exposes
    /// no view's context menu to a test, so the source is read.
    func testTheNotesAndThePickOfferTheFileLinkMenu() throws {
        let source = try String(contentsOf: URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/GenesisKit/Widgets/WidgetDecisionDetailsView.swift"), encoding: .utf8)
        let notes = try XCTUnwrap(source.range(of: "Text(.init(notes))"))
        let notesEnd = try XCTUnwrap(source.range(of: "if let proposal", range: notes.upperBound..<source.endIndex))
        XCTAssertTrue(source[notes.lowerBound..<notesEnd.lowerBound].contains(".pathLinkMenu(markdown: notes)"))
        let pick = try XCTUnwrap(source.range(of: "struct WidgetProposalLine"))
        let pickEnd = try XCTUnwrap(source.range(of: "enum WidgetProposal {", range: pick.upperBound..<source.endIndex))
        XCTAssertTrue(source[pick.lowerBound..<pickEnd.lowerBound].contains(".pathLinkMenu(markdown: text)"))
    }

    private func decisionCardText(preferences: [String: Any]) throws -> String {
        let model = try model(preferences: preferences, cards: [Self.contextCard(key + "0")])
        defer { model.stop() }
        model.error = nil
        model.openCard(try XCTUnwrap(model.cards.first { $0.number == 1 }))
        let view = LiveWidgetView(model: model, edge: .right, embedded: true)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, model.panelTheme)
            .environment(\.colorScheme, .dark)
        let rep = try KitShots.render(view, size: CGSize(width: Self.widgetWidth, height: 1400), name: "decision-context",
                                      settle: 1.2)
        return try recognizedText(try XCTUnwrap(rep.cgImage))
    }

    /// The narrowest real width of a session's inbox: the agents panel's 560 pt minimum
    /// (`WidgetClusterGeometry.detailSize`) less the 44 pt side rail (`WidgetSideStripMetrics.width`).
    static let widgetWidth: CGFloat = 560 - WidgetSideStripMetrics.width

    /// The decision card with the hub's context, open and answered, for the visual check of 2026-11-01:
    /// `WIDGET_DECISION_SHOTS=<folder>` writes `decision-context-<state>-<theme>.png` at the widget's narrowest real
    /// width. The widget draws dark only (`WidgetHostView`: `.preferredColorScheme(.dark)`), so the two looks are its
    /// default panel (graphite) and a coloured theme panel (dusk).
    func testRendersTheDecisionCardWithItsContext() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let themes: [(String, NativeSettingsTheme, Color)] = [
            ("graphite", .graphite, NativeThemePalette.graphiteBase), ("dusk", .dusk, NativeThemePalette.duskBase),
        ]
        for status in ["open", "sent"] {
            for (name, theme, base) in themes {
                let model = try model(cards: [Self.contextCard(key + "0", status: status)])
                defer { model.stop() }
                model.error = nil
                model.openCard(try XCTUnwrap(model.cards.first { $0.number == 1 }))
                let view = LiveWidgetView(model: model, edge: .right, embedded: true)
                    .frame(width: Self.widgetWidth, height: status == "open" ? 1240 : 1000, alignment: .top)
                    .background(base)
                    .environment(\.nativeSettingsTheme, theme)
                    .environment(\.colorScheme, .dark)
                let rep = try KitShots.render(view, size: CGSize(width: Self.widgetWidth, height: status == "open" ? 1240 : 1000),
                                              name: "decision-context-\(status)-\(name)", settle: 1.2)
                try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                    .write(to: URL(fileURLWithPath: folder).appendingPathComponent("decision-context-\(status)-\(name).png"))
            }
        }
    }

    // MARK: - Decision 31: options posted as bare letters (2026-11-01)

    static let letterTitle = "When to empty the removal folder (81.8 GB moved, not freed yet)"
    static let letterSummary = "Everything removed today is in /tmp/removable/disk-reclaim (1,546 paths, 81.8 GB by du, "
        + "with MANIFEST.tsv and restore.sh). A move frees nothing: free space is 8.3 GB. The space comes back only when "
        + "that folder is deleted. macOS also clears /tmp at a reboot, and its daily cleanup removes /tmp files not used "
        + "for 3 days, so the folder disappears by itself within days."
    static let letterWords = ["empty it now: I open one `tools rm ask` approval for the whole folder",
                              "keep it until tomorrow evening so you can check, then I ask again",
                              "let macOS clear it (reboot or the 3-day cleanup)"]
    static let letterReasoning = "One day is enough to notice anything missing, and restore.sh puts it back."

    /// Decision 31's entry in the inbox of every session as the hub sends it now: the options carry the words the agent
    /// wrote only in the prompt (`decisionOptionLabels`). `bare` is what it sent before: the letters.
    static func letterItem(_ key: String, bare: Bool = false) -> [String: Any] {
        let options: [String] = bare ? ["a", "b", "c"] : letterWords
        var item: [String: Any] = ["id": "decision:d31", "sourceId": "d31", "kind": "decision", "key": key]
        item["at"] = Date().timeIntervalSince1970 * 1000 - 27 * 60_000
        item["needsAnswer"] = true
        item["number"] = 31
        item["title"] = letterTitle
        item["summary"] = letterSummary
        item["options"] = options
        item["recommended"] = "b"
        item["revision"] = 1
        return item
    }

    /// Decision 31's card in its session's inbox as the hub sends it now: the words on the options, the body without the
    /// "a) …" lines that would repeat them, the reasoning as the agent's pick. `bare` is what it sent before: the letters
    /// as options, the lines in the body and the reasoning as the Context.
    static func letterCard(_ key: String, bare: Bool = false) -> [String: Any] {
        let letters = ["a", "b", "c"]
        let lines: [String] = zip(letters, letterWords).map { letter, words in letter + ") " + words }
        let body: String = bare ? letterSummary + "\n\n" + lines.joined(separator: "\n") : letterSummary
        var choices: [[String: Any]] = []
        for (index, letter) in letters.enumerated() {
            let title: String = bare ? letter : letterWords[index]
            choices.append(["id": letter, "title": title, "recommended": index == 1])
        }
        var details: [String: Any] = ["confidence": "medium", "recommended": "b"]
        details[bare ? "context" : "proposal"] = letterReasoning
        let source: [String: Any] = ["sessionId": "fixture-0", "agent": "claude", "project": "Fixture", "cwd": "/fixture"]
        var card: [String: Any] = ["id": "decision:d31", "kind": "decision", "sessionKey": key, "sourceId": "d31"]
        card["at"] = Date().timeIntervalSince1970 * 1000 - 27 * 60_000
        card["title"] = letterTitle
        card["body"] = body
        card["status"] = "open"
        card["revision"] = 1
        card["number"] = 31
        card["choices"] = choices
        card["decision"] = details
        card["attachments"] = [Any]()
        card["refs"] = [Any]()
        card["read"] = true
        card["sourceContext"] = source
        return card
    }

    /// The inbox of every session with decision 31's entry opened from the keyboard (Down, then Return), as the widget
    /// draws it at its narrowest real width on the graphite panel.
    private func openOverviewEntry(_ model: WidgetModel, name: String) throws -> NSBitmapImageRep {
        model.error = nil
        model.expanded = .right
        model.inboxOverview = true
        let size = CGSize(width: Self.widgetWidth, height: 760)
        let view = LiveWidgetView(model: model, edge: .right, embedded: true)
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
        let (window, host) = HostedShot.host(view, size: size)
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        XCTAssertTrue(model.moveInList(.down), "the overview takes Down")
        RunLoop.main.run(until: Date().addingTimeInterval(0.3))
        XCTAssertTrue(model.moveInList(.open), "the overview opens the entry Down chose")
        RunLoop.main.run(until: Date().addingTimeInterval(0.8))
        let rep = try XCTUnwrap(HostedShot.bitmap(host))
        if let folder = KitShots.folder {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: folder.appendingPathComponent(name + ".png"))
        }
        return rep
    }

    /// Decision 31's open card in its session's inbox, at the widget's narrowest real width on the graphite panel.
    private func openLetterCard(_ model: WidgetModel, name: String) throws -> NSBitmapImageRep {
        model.error = nil
        model.openCard(try XCTUnwrap(model.cards.first { $0.number == 31 }))
        let size = CGSize(width: Self.widgetWidth, height: 900)
        let view = LiveWidgetView(model: model, edge: .right, embedded: true)
            .frame(width: size.width, height: size.height, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
        return try KitShots.render(view, size: size, name: name, settle: 1.2)
    }

    /// An open entry in the inbox of every session shows the question's description above its options, as the alert
    /// popup does, and the options say their words (Martin, 2026-11-01: the entry showed "a", "b", "c" and nothing
    /// else). The setting turns the description off.
    func testAnOpenOverviewEntryShowsItsQuestionAboveItsOptions() throws {
        let model = try model(inbox: [Self.letterItem(key + "0")])
        defer { model.stop() }
        // Lines wrap where the width says, so the words are matched across a line break.
        let text = try recognizedText(try XCTUnwrap(openOverviewEntry(model, name: "overview-letters-open").cgImage))
            .replacingOccurrences(of: "\n", with: " ")
        for expected in ["81.8 GB by du", "free space is 8.3 GB", "empty it now", "keep it until tomorrow evening",
                         "let macOS clear it", "Recommended"] {
            XCTAssertTrue(text.contains(expected), "\(expected) in: \(text)")
        }
        let quiet = try self.model(preferences: ["overviewSummary": false], inbox: [Self.letterItem(key + "0")])
        defer { quiet.stop() }
        let hidden = try recognizedText(try XCTUnwrap(openOverviewEntry(quiet, name: "overview-letters-quiet").cgImage))
            .replacingOccurrences(of: "\n", with: " ")
        XCTAssertTrue(hidden.contains("empty it now"), hidden)
        XCTAssertFalse(hidden.contains("free space is 8.3 GB"), "the setting hides the description: \(hidden)")
    }

    /// Decision 31's card in its session's inbox: the options say their words, and the agent's reasoning sits under
    /// the recommended option behind the lightbulb, never under the Context label (the hub's Inbox card agrees:
    /// `HubInboxUXTests`).
    func testALetterDecisionCardShowsItsWordsAndTheReasoningAsThePick() throws {
        let model = try model(cards: [Self.letterCard(key + "0")])
        defer { model.stop() }
        let text = try recognizedText(try XCTUnwrap(openLetterCard(model, name: "card-letters-open").cgImage))
            .replacingOccurrences(of: "\n", with: " ")
        for expected in ["free space is 8.3 GB", "empty it now", "keep it until tomorrow evening", "let macOS clear it",
                         "One day is enough"] {
            XCTAssertTrue(text.contains(expected), "\(expected) in: \(text)")
        }
        XCTAssertFalse(text.contains("Context"), text)
    }

    /// The render check of 2026-11-01: decision 31's card and its open overview entry, as the hub sent them before
    /// (bare letters, the reasoning as Context; the overview without the description, as before the setting) and now.
    /// `WIDGET_DECISION_SHOTS=<folder>` writes `letters-<surface>-<before|after>-graphite.png`.
    func testRendersTheLetterDecisionBeforeAndAfter() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_DECISION_SHOTS"] else { return }
        let out = URL(fileURLWithPath: folder)
        try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        for (state, bare) in [("before", true), ("after", false)] {
            let cardModel = try model(cards: [Self.letterCard(key + "0", bare: bare)])
            defer { cardModel.stop() }
            try XCTUnwrap(try openLetterCard(cardModel, name: "letters-card-\(state)").representation(using: .png, properties: [:]))
                .write(to: out.appendingPathComponent("letters-card-\(state)-graphite.png"))
            let overviewModel = try model(preferences: bare ? ["overviewSummary": false] : [:],
                                          inbox: [Self.letterItem(key + "0", bare: bare)])
            defer { overviewModel.stop() }
            try XCTUnwrap(try openOverviewEntry(overviewModel, name: "letters-overview-\(state)")
                .representation(using: .png, properties: [:]))
                .write(to: out.appendingPathComponent("letters-overview-\(state)-graphite.png"))
        }
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
