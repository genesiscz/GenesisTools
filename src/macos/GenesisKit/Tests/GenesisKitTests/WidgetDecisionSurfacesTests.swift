import AppKit
import SwiftUI
import XCTest

@testable import GenesisKit

/// The widget's decision surfaces (the alert popup, the inbox of every session, a session's inbox, the staged list and
/// the leave question), checked as values and rendered for the UX audit of 2026-10-27 with
/// `WIDGET_DECISION_SHOTS=<folder>` (the same calls before and after a change, so the pairs match).
@MainActor
final class WidgetDecisionSurfacesTests: XCTestCase {
    private let key = "local:claude:fixture-decisions:"

    private func model(preferences extra: [String: Any] = [:], cards: [[String: Any]] = [],
                       staged: [[String: Any]] = []) throws -> WidgetModel {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.decisions." + UUID().uuidString))
        let state = FileManager.default.temporaryDirectory.appendingPathComponent("widget-decisions-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: state.appendingPathComponent("native-submissions"),
                                                withIntermediateDirectories: true)
        // A tools stand-in that answers every call with an empty JSON object, so no startup call shows an error.
        let tools = state.appendingPathComponent("tools")
        try "#!/bin/sh\necho '{}'\n".write(to: tools, atomically: true, encoding: .utf8)
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
        try write(page, CGSize(width: 760, height: 3600), "settings-general", model: model, folder: folder)
    }
}
