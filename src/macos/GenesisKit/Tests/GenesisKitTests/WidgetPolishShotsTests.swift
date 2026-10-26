import AppKit
import SwiftUI
import XCTest

@testable import GenesisKit

/// The widget's Panel background setting and the inbox header's sort label (Martin, 2026-10-25), checked as values and
/// rendered for the report with `WIDGET_POLISH_SHOTS=<folder>`.
@MainActor
final class WidgetPolishShotsTests: XCTestCase {
    private let key = "local:claude:fixture-polish:"

    /// The state folder of the last `model(…)`, whose `native-submissions` journal holds what a send queued.
    private var state: URL?

    private func model(panelBackground: String?, cards: [[String: Any]] = [], decisionClick: String? = nil) throws
        -> WidgetModel
    {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "widget.polish." + UUID().uuidString))
        // Its own state folder with the submission journal in place: a queued answer is written there first.
        let state = FileManager.default.temporaryDirectory.appendingPathComponent("widget-polish-" + UUID().uuidString)
        try FileManager.default.createDirectory(at: state.appendingPathComponent("native-submissions"),
                                                withIntermediateDirectories: true)
        self.state = state
        let model = WidgetModel(binaryPath: "/fixture/tools", stateRoot: state.path,
            defaults: defaults, appearance: NativeSettingsAppearance(defaults: defaults,
                notificationNamespace: "polish." + UUID().uuidString, observeExternalChanges: false))
        var preferences: [String: Any] = ["excludedKeys": [], "projects": [], "sessions": [], "showChanges": false,
            "placement": "both", "side": "right", "quietSeconds": 15, "voiceProvider": "openai", "voiceLanguage": "en",
            "previewSort": "recent"]
        if let panelBackground { preferences["panelBackground"] = panelBackground }
        if let decisionClick { preferences["decisionClick"] = decisionClick }
        let sessions: [[String: Any]] = ["Kalendora hotfix research", "gt-native-ux", "gt-fixes"].enumerated().map { index, title in
            ["key": key + "\(index)", "target": ["hostId": "local", "provider": "claude", "sessionId": "fixture-\(index)",
                "sourceHome": "", "cwd": "/fixture"], "title": title, "project": "Fixture",
             "activityAt": Date().timeIntervalSince1970 * 1000 - Double(index) * 60_000,
             "status": index == 0 ? "working" : "idle", "pinned": false, "visible": true, "hiddenByFilter": false]
        }
        let data = try JSONSerialization.data(withJSONObject: ["version": 1, "state": ["version": 1, "revision": 0,
            "selectedKey": key + "0", "preferences": preferences, "assets": [:], "drafts": [:], "outgoing": []],
            "sessions": sessions, "cards": cards, "manifests": [:], "errors": [], "selectedKey": key + "0",
            "notifications": ["unread": 0, "needsAnswer": 1, "complete": true, "truncated": false,
                "sessions": [["key": key + "0", "unread": 0, "needsAnswer": 1, "pendingItem": Self.pending(key + "0"),
                              "items": [Self.pending(key + "0")]]]]])
        model.receive([String(decoding: data, as: UTF8.self)])
        return model
    }

    static func pending(_ key: String) -> [String: Any] {
        ["id": "decision:d10", "sourceId": "d10", "kind": "decision", "key": key, "at": Date().timeIntervalSince1970 * 1000,
         "needsAnswer": true, "number": 10, "title": "P8 scope: where \"no automatic failover, show the error\" applies",
         "options": ["a) only the fleet publisher", "b) every remote call", "c) the installer as well"], "recommended": "b",
         "revision": 1]
    }

    /// Martin, 2026-10-26: an own answer sent from its card left the card's field, came back in the top reply field
    /// for a few seconds, and disappeared only when the hub's next snapshot cleared it. The perf log showed a draft
    /// save half a second after the send: the closing field wrote the sent text back into the emptied draft.
    func testASentOwnAnswerDoesNotComeBackInTheReplyField() throws {
        let card: [String: Any] = ["id": "decision:d10", "kind": "decision", "sessionKey": key + "0", "sourceId": "d10",
            "at": Date().timeIntervalSince1970 * 1000, "title": "Merge it in this run?", "body": "", "status": "open",
            "revision": 1, "number": 10, "choices": [["id": "a", "title": "Yes", "recommended": true]],
            "attachments": [], "refs": [], "read": false]
        let model = try model(panelBackground: nil, cards: [card])
        defer { model.stop() }
        let decision = try XCTUnwrap(model.cards.first)
        model.openCard(decision)
        model.openOwnAnswer(decision)
        model.actionRunner = { _ in ["ok": true] }
        let closingField = model.composerText(ownAnswer: decision.id)
        let oldReplyField = model.composerText()
        closingField.wrappedValue = "merge it after its round"

        model.send()
        XCTAssertNil(model.ownAnswerCard, "the card's field closes once the answer is queued")
        XCTAssertEqual(model.draft.text, "")
        closingField.wrappedValue = "merge it after its round"
        oldReplyField.wrappedValue = "merge it after its round"
        XCTAssertEqual(model.draft.text, "", "disposed fields cannot write into the next composer")
        model.composerText().wrappedValue = "merge it after its round"
        XCTAssertEqual(model.draft.text, "merge it after its round", "the active composer accepts an immediate repeat")
        model.setText("and one more thing")
        XCTAssertEqual(model.draft.text, "and one more thing", "new typing after the send is kept")
    }

    func testRegularComposerAcceptsAnImmediateRepeatAfterSend() throws {
        let model = try model(panelBackground: nil)
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let oldField = model.composerText()
        oldField.wrappedValue = "OK"
        model.send()
        oldField.wrappedValue = "OK"
        XCTAssertEqual(model.draft.text, "", "an old binding cannot restore sent text")
        model.composerText().wrappedValue = "OK"
        XCTAssertEqual(model.draft.text, "OK", "the active reply field accepts the same message immediately")
    }

    func testQueuedDraftSaveIsFencedBySendAndLaterSavesStillRun() async throws {
        let model = try model(panelBackground: nil)
        defer { model.stop() }
        var writes: [String] = []
        let laterSave = expectation(description: "new draft reached the backend")
        model.actionRunner = { value in
            if case .object(let fields) = value, fields["action"] == .string("draft-text"),
               case .string(let text) = fields["text"] {
                writes.append(text)
                if text == "next draft" { laterSave.fulfill() }
            }
            return ["ok": true]
        }
        var release: CheckedContinuation<Void, Never>?
        model.afterMutations { await withCheckedContinuation { release = $0 } }
        for _ in 0 ..< 200 where release == nil { try await Task.sleep(for: .milliseconds(5)) }
        guard let barrier = release else { return XCTFail("mutation barrier did not start") }
        defer { release?.resume() }
        model.setText("old queued draft")
        // Let the debounce put its save behind the blocked mutation before Send invalidates that revision.
        try await Task.sleep(for: .milliseconds(450))
        model.send()
        let drained = expectation(description: "send mutations drained")
        model.afterMutations { drained.fulfill() }
        release = nil
        barrier.resume()
        await fulfillment(of: [drained], timeout: 3)
        XCTAssertEqual(writes, [""], "the queued old save is skipped but the send's clear reaches the backend")
        model.setText("next draft")
        await fulfillment(of: [laterSave], timeout: 3)
        XCTAssertEqual(writes, ["", "next draft"], "a legitimate later draft still saves")
    }

    func testWaitingQuestionIsIncludedInThePreviewAccessibilityLabel() throws {
        let model = try model(panelBackground: nil)
        defer { model.stop() }
        let session = try XCTUnwrap(model.selected)
        let item = try XCTUnwrap(model.inboxFor(session.key)?.pendingItem)
        let question = try XCTUnwrap(AgentWidgetPreview.pendingQuestion(item, enabled: true))
        XCTAssertTrue(AgentWidgetPreview.rowAccessibilityLabel(session, question: question).contains(question))
        XCTAssertNil(AgentWidgetPreview.pendingQuestion(item, enabled: false))
        XCTAssertNil(AgentWidgetPreview.pendingQuestion(nil, enabled: true))
        XCTAssertEqual(AgentWidgetPreview.rowAccessibilityLabel(session, question: nil),
                       "Open " + session.title + ", " + session.visualStatus.label)
        var untitled = item
        untitled.title = ""
        XCTAssertNil(AgentWidgetPreview.pendingQuestion(untitled, enabled: true))
    }

    func testQuietCollapseRestartsWhenThePointerLeavesWithoutAnotherSnapshot() async throws {
        let model = try model(panelBackground: nil)
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        var wire = try XCTUnwrap(model.snapshot)
        wire.sessions = wire.sessions.map { session in
            var idle = session
            idle.status = "idle"
            return idle
        }
        wire.state.preferences.quietSeconds = 5
        model.receive([String(decoding: try JSONEncoder().encode(wire), as: UTF8.self)])
        let surface = WidgetSurfaceID(edge: .right)
        model.hover(surface, inside: true)
        model.open(.right)
        try await Task.sleep(for: .milliseconds(5300))
        XCTAssertEqual(model.expanded, .right, "quiet expiry keeps a panel under the pointer open")
        model.hover(surface, inside: false)
        try await Task.sleep(for: .milliseconds(5300))
        XCTAssertNil(model.expanded, "pointer exit rearms quiet collapse without a new snapshot")
    }

    func testQuietCollapseKeepsOverviewDecisionsFromOtherSessionsVisible() async throws {
        let model = try model(panelBackground: nil)
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        var wire = try XCTUnwrap(model.snapshot)
        wire.sessions = wire.sessions.map { session in
            var idle = session
            idle.status = "idle"
            return idle
        }
        wire.state.preferences.quietSeconds = 5
        var summary = try XCTUnwrap(wire.notifications)
        var entry = try XCTUnwrap(summary.sessions.first)
        let otherKey = wire.sessions[1].key
        var decision = try XCTUnwrap(entry.pendingItem)
        decision.key = otherKey
        entry.key = otherKey
        entry.pendingItem = decision
        entry.items = [decision]
        summary.sessions = [entry]
        wire.notifications = summary
        model.receive([String(decoding: try JSONEncoder().encode(wire), as: UTF8.self)])
        XCTAssertTrue(model.cards.isEmpty, "the selected session has no waiting card")
        XCTAssertEqual(model.inboxOverviewItems.first?.key, otherKey)
        model.inboxOverview = true
        model.open(.right)
        try await Task.sleep(for: .milliseconds(5300))
        XCTAssertEqual(model.expanded, .right, "a waiting overview decision protects keyboard readers too")
    }

    /// Each option of the alert is its own button (Martin, 2026-10-26: the read-only list under "Click to answer" was
    /// "still ugly"), so VoiceOver reads each one with what its click does and the recommendation.
    func testAnOptionSaysWhatItsClickDoesAndWhetherItIsRecommended() {
        XCTAssertEqual(WidgetOptionText.accessibilityLabel(letter: "b", text: "JSON loaded at run time", stages: true,
                                                           recommended: true),
                       "Stage b: JSON loaded at run time, recommended")
        XCTAssertEqual(WidgetOptionText.accessibilityLabel(letter: "a", text: "Keep", stages: false, recommended: false),
                       "Answer a: Keep")
        XCTAssertEqual(WidgetOptionText.text("a) generated TS `as const`", letter: "a"), "generated TS `as const`",
                       "a letter the agent wrote is not drawn twice beside the badge")
        XCTAssertEqual(WidgetOptionText.text("Keep", letter: "a"), "Keep")
        XCTAssertEqual(WidgetOptionText.letter(2), "c")
    }

    func testTheRecommendedOptionIsFoundByLetterOrText() {
        XCTAssertTrue(WidgetOptionText.isRecommended("b) every remote call", at: 1, "b"))
        XCTAssertTrue(WidgetOptionText.isRecommended("keep", at: 0, "keep"))
        XCTAssertFalse(WidgetOptionText.isRecommended("a) only the fleet publisher", at: 0, "b"))
        XCTAssertFalse(WidgetOptionText.isRecommended("bigger", at: 0, "b"))
        let options = ["Keep", "Drop"]
        XCTAssertEqual(options.enumerated().filter {
            WidgetOptionText.isRecommended($0.element, at: $0.offset, " B ")
        }.map(\.element), ["Drop"], "wire options have no letter prefix")
        XCTAssertFalse(WidgetOptionText.isRecommended("Drop", at: 1, nil))
        XCTAssertFalse(WidgetOptionText.isRecommended("Drop", at: 1, " "))
    }

    /// The alert's option stages in place, and its Send now sends a pick the snapshot does not list yet.
    func testTheAlertOptionStagesAndSendNowSendsIt() async throws {
        let model = try model(panelBackground: nil)
        defer { model.stop() }
        var calls: [String] = []
        model.actionRunner = { value in
            if case .object(let fields) = value, case .string(let action) = fields["action"] { calls.append(action) }
            return ["ok": true]
        }
        let item = try XCTUnwrap(model.inboxFor(key + "0")?.pendingItem)
        model.choose(item, option: "b")
        XCTAssertEqual(model.stagedOption(item.sourceId, stored: item.draftOption), "b", "the row says Staged at once")
        model.sendStaged([item.sourceId], known: [item])
        XCTAssertTrue(model.sendingDecisionIDs.contains(item.sourceId), "Send now says Sending… while it runs")
        model.sendStaged([item.sourceId], known: [item])
        let deadline = ContinuousClock.now + .seconds(3)
        while model.sendingDecisionIDs.contains(item.sourceId), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(20))
        }
        XCTAssertFalse(model.sendingDecisionIDs.contains(item.sourceId), "the send finished")
        XCTAssertEqual(calls.filter { $0 == "send-staged" }.count, 1, "a second press while it runs sends nothing more")
        XCTAssertLessThan(try XCTUnwrap(calls.firstIndex(of: "ledger")), try XCTUnwrap(calls.firstIndex(of: "send-staged")),
                          "the send waits for the stage it sends")
    }

    func testThePanelIsDarkUnlessGlassOrTheAppThemeIsPicked() throws {
        XCTAssertEqual(try model(panelBackground: nil).panelTheme, .graphite, "an older snapshot reads as dark")
        XCTAssertEqual(try model(panelBackground: "dark").panelTheme, .graphite)
        XCTAssertEqual(try model(panelBackground: "glass").panelTheme, .glass)
        let themed = try model(panelBackground: "theme")
        XCTAssertEqual(themed.panelTheme, themed.appearance.theme)
        defer { themed.stop() }
        themed.appearance.theme = .glass
        var wire = try XCTUnwrap(themed.snapshot)
        wire.state.preferences.glassEffect = false
        themed.receive([String(decoding: try JSONEncoder().encode(wire), as: UTF8.self)])
        XCTAssertEqual(themed.panelTheme, .glass, "the removed legacy glass toggle cannot override Same as the app")
        themed.appearance.theme = .midnight
        XCTAssertEqual(themed.panelTheme, .midnight, "Same as the app follows later theme changes too")
    }

    func testTheSortButtonNamesTheOrderInOneWord() {
        XCTAssertEqual(WidgetPreviewChoices.shortTitle(sort: "attention"), "Waiting")
        XCTAssertEqual(WidgetPreviewChoices.shortTitle(sort: "recent"), "Newest")
        XCTAssertEqual(WidgetPreviewChoices.shortTitle(sort: "project"), "Project")
    }

    /// What the sends queued, oldest first: each request's payload (the fixture's tools binary does not exist, so the
    /// journal keeps them).
    private func queuedPayloads() throws -> [[String: Any]] {
        let journal = try XCTUnwrap(state).appendingPathComponent("native-submissions")
        return try FileManager.default.contentsOfDirectory(at: journal, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            .map { file in
                let request = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
                return try XCTUnwrap(request["payload"] as? [String: Any])
            }
    }

    /// The reply composer is a reply, as its "Reply to …" says, even with a decision open; a "Send at once" option
    /// goes alone and leaves a reply being typed where it is; the number keys answer only a decision on screen.
    func testTheReplyComposerStaysAReplyBesideAnOpenDecision() throws {
        let model = try model(panelBackground: nil, cards: [Self.manifestCard(key + "0")], decisionClick: "send")
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let decision = try XCTUnwrap(model.cards.first)
        model.openCard(decision)
        XCTAssertEqual(model.answerCardOnScreen?.id, decision.id, "the open decision takes the number keys")
        model.section = "Conversation"
        XCTAssertNil(model.answerCardOnScreen, "a key on another tab does not answer the decision behind it")
        model.section = "Inbox"
        model.inboxOverview = true
        XCTAssertNil(model.answerCardOnScreen, "nor one behind the inbox of every session")
        model.inboxOverview = false

        model.setText("Also rebase it first")
        model.choose(decision, option: "b")
        XCTAssertEqual(model.draft.text, "Also rebase it first", "an option click leaves a reply being typed")
        model.send()
        // Both land in the same millisecond, so their journal names do not order them.
        let payloads = try queuedPayloads()
        XCTAssertEqual(payloads.compactMap { $0["kind"] as? String }.sorted(), ["decision", "followup"])
        let answer = try XCTUnwrap(payloads.first { $0["kind"] as? String == "decision" })
        let reply = try XCTUnwrap(payloads.first { $0["kind"] as? String == "followup" })
        XCTAssertEqual(answer["option"] as? String, "b")
        XCTAssertEqual(answer["text"] as? String, "", "the option went alone")
        XCTAssertEqual(reply["text"] as? String, "Also rebase it first", "the reply went as a reply")
    }

    /// Unstage on a card with a staged note: the pick goes, and the note comes back into the card's own answer field
    /// instead of being thrown away.
    func testUnstageGivesTheStagedNoteBack() throws {
        var card = Self.manifestCard(key + "0")
        card["status"] = "drafted"
        card["draftOption"] = "a"
        card["draft"] = "only for the CLI"
        let model = try model(panelBackground: nil, cards: [card])
        defer { model.stop() }
        model.actionRunner = { _ in ["ok": true] }
        let decision = try XCTUnwrap(model.cards.first)
        model.openCard(decision)
        model.unstage(decision)
        XCTAssertEqual(model.ownAnswerCard?.id, decision.id, "the note opens in the card's own answer field")
        XCTAssertEqual(model.draft.text, "only for the CLI")
        XCTAssertEqual(model.composerText(ownAnswer: decision.id).wrappedValue, "only for the CLI")
        XCTAssertEqual(model.composerText(ownAnswer: "decision:other").wrappedValue, "",
                       "another card's closed field shows none of it")
    }

    /// DECISION 15 of Martin's screenshot (2026-10-26 13:48), for the alert card and decision card renders.
    static let manifestOptions = ["a) generated TS `as const` (typed ids, a regen is a code diff)",
                                  "b) JSON loaded at run time", "c) both: JSON + a generated TS type"]

    static func manifestCard(_ key: String) -> [String: Any] {
        ["id": "decision:d15", "kind": "decision", "sessionKey": key, "sourceId": "d15",
         "at": Date().timeIntervalSince1970 * 1000, "title": "Field manifest format",
         "body": "The manifest lists every field of a work item type. Pick how the tool reads it.", "status": "open",
         "revision": 1, "number": 15,
         "choices": manifestOptions.enumerated().map { index, title in
             ["id": String(UnicodeScalar(97 + index).map(Character.init) ?? "?"), "title": title, "recommended": index == 0]
         }, "attachments": [], "refs": [], "read": false]
    }

    /// The alert card and the decision card with its own answer field, closed and open, at the panel's sizes.
    func testRendersTheDecisionAlertAndCard() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_POLISH_SHOTS"] else { return }
        let model = try model(panelBackground: "dark", cards: [Self.manifestCard(key + "0")])
        defer { model.stop() }
        func write(_ view: some View, _ size: CGSize, _ name: String) throws {
            let themed = view.frame(width: size.width, height: size.height, alignment: .top)
                .background(NativeThemePalette.graphiteBase)
                .environment(\.nativeSettingsTheme, model.panelTheme)
                .environment(\.colorScheme, .dark)
            let rep = try KitShots.render(themed, size: size, name: name, settle: 0.8)
            try XCTUnwrap(rep.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: folder).appendingPathComponent(name + ".png"))
        }
        let item = WidgetInboxItem(id: "decision:d15", sourceId: "d15", kind: "decision", key: key + "0",
            at: Date().timeIntervalSince1970 * 1000, needsAnswer: true, title: "Field manifest format", number: 15,
            options: Self.manifestOptions, recommended: "a", revision: 1)
        try write(WidgetPeekView(model: model, item: item).padding(WidgetPeekView.inset), CGSize(width: 310, height: 290),
                  "widget-alert-decision")
        let decision = try XCTUnwrap(model.cards.first)
        model.openCard(decision)
        let panel = CGSize(width: 420, height: 980)
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "widget-decision-card")
        model.openOwnAnswer(decision)
        try write(LiveWidgetView(model: model, edge: .right, embedded: true), panel, "widget-decision-own-answer")
    }

    func testRendersTheSettingAndTheHeader() throws {
        guard let folder = ProcessInfo.processInfo.environment["WIDGET_POLISH_SHOTS"] else { return }
        let model = try model(panelBackground: "dark")
        defer { model.stop() }
        let general = try XCTUnwrap(WidgetFeatureSettings.sections(model: model, modules: WidgetModuleChoice.builtins,
            openSession: { _ in }).flatMap(\.pages).first { $0.id == "widgets.general" })
        let page = ScrollView { general.content().padding(24) }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, .graphite)
            .environment(\.colorScheme, .dark)
        let pageShot = try KitShots.render(page, size: CGSize(width: 760, height: 1500), name: "widget-general", settle: 0.8)
        try XCTUnwrap(pageShot.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("widget-general-settings.png"))
        let preview = AgentWidgetPreview(model: model, surface: WidgetSurfaceID(edge: .right)).padding(10)
            .frame(width: 420, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, model.panelTheme)
            .environment(\.colorScheme, .dark)
        let previewShot = try KitShots.render(preview, size: CGSize(width: 420, height: 320), name: "widget-preview", settle: 0.6)
        try XCTUnwrap(previewShot.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("widget-inbox-sort-label.png"))
        // The alert card at the size of Martin's screenshot (2026-10-25 18:47): the pane is as tall as the rail.
        let item = try XCTUnwrap(model.inboxFor(key + "0")?.pendingItem)
        let peek = WidgetPeekView(model: model, item: item).padding(WidgetPeekView.inset)
            .frame(width: 310, height: 290, alignment: .top)
            .background(NativeThemePalette.graphiteBase)
            .environment(\.nativeSettingsTheme, model.panelTheme)
            .environment(\.colorScheme, .dark)
        let peekShot = try KitShots.render(peek, size: CGSize(width: 310, height: 290), name: "widget-peek", settle: 0.6)
        try XCTUnwrap(peekShot.representation(using: .png, properties: [:]))
            .write(to: URL(fileURLWithPath: folder).appendingPathComponent("widget-alert-card.png"))
    }
}
