import Foundation

/// Staged decisions: a pick or a note kept to send later, together with others (Martin, 2026-10-23: "click on the
/// decision option should not send it immediatelly, but stage that change"). They are the decision log's own unsent
/// state (`drafted` with `draftOption` or `draft`), so every inbox, the hub and the CLI see one list, and nothing is
/// lost when the widget restarts.
extension WidgetModel {
    /// A click on a decision option or its number key stages it ("stage", the default) or sends it at once ("send").
    public var decisionClickStages: Bool { (snapshot?.state.preferences.decisionClick ?? "stage") == "stage" }

    /// The pick a card shows as staged: the one staged here a moment ago, else the snapshot's.
    public func stagedOption(_ sourceId: String, stored: String?) -> String? {
        if let pending = pendingStage[sourceId] { return pending.isEmpty ? nil : pending }
        return stored
    }

    /// The selected session's staged decisions.
    public var sessionStaged: [WidgetInboxItem] { stagedItems.filter { $0.key == selectedKey } }

    /// A click on a decision option in a session's inbox. A second click on the staged option clears the pick.
    public func choose(_ card: WidgetCard, option: String) {
        guard decisionClickStages else {
            // `submit` answers the selected card; another open row's click must answer its own decision.
            selectedCardID = card.id
            submit(choice: option)
            return
        }
        guard let selected, let revision = card.revision else { return }
        let current = stagedOption(card.sourceId, stored: card.draftOption)
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision,
              option: current == option ? nil : option)
    }

    /// The number keys: the open decision's option, as a click on it.
    public func choose(option: String) {
        guard let card = answerCard else {
            submit(choice: option)
            return
        }
        choose(card, option: option)
    }

    /// A click on a decision option in the inbox of every session. With "Send at once" the pick is staged on the
    /// item's own session and sent once the hub has it.
    public func choose(_ item: WidgetInboxItem, option: String) {
        guard let session = session(forKey: item.key), let revision = item.revision else { return }
        guard decisionClickStages else {
            stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision, option: option,
                  completed: { [weak self] in
                      self?.pendingStage[item.sourceId] = nil
                      self?.deliverDecisions([item], action: "send-staged")
                  })
            return
        }
        let current = stagedOption(item.sourceId, stored: item.draftOption)
        stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision,
              option: current == option ? nil : option)
    }

    /// Save draft on a decision card: the composer's text becomes that decision's note, staged with the others. Once
    /// the hub has it, the composer is cleared, so another decision's own answer does not open with this text; a
    /// refused save keeps the text.
    public func saveDraft(_ card: WidgetCard) {
        guard let selected, let revision = card.revision else { return }
        let key = selectedKey
        let typed = draft.text
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision,
              option: stagedOption(card.sourceId, stored: card.draftOption), note: text,
              completed: { [weak self] in
                  guard let self else { return }
                  self.draftSavedAt[card.id] = Date()
                  // Only the text that was saved: a session switch or new typing keeps the composer as it is.
                  if !text.isEmpty, self.selectedKey == key, self.draft.text == typed { self.setText("") }
              })
    }

    /// The own answer composer of a decision with a saved note opens with that note.
    public func openOwnAnswer(_ card: WidgetCard) {
        ownAnswerCardID = card.id
        if draft.text.isEmpty, let note = card.draft, !note.isEmpty { setText(note) }
    }

    private func stage(
        id: String, sessionId: String, revision: Int, option: String?, note: String? = nil,
        completed: (() -> Void)? = nil
    ) {
        pendingStage[id] = option ?? ""
        var fields: [String: WidgetJSON] = [
            "action": "ledger", "id": .string(id), "sessionId": .string(sessionId),
            "expectedRevision": .number(Double(revision)), "state": "drafted", "draftOption": .string(option ?? ""),
        ]
        if let note { fields["draft"] = .string(note) }
        action(.object(fields), failed: { [weak self] in self?.pendingStage[id] = nil }, completed: completed)
    }

    /// The staged items as the snapshot shows them, and the picks staged here that it now shows.
    func reconcileStaged(_ items: [WidgetInboxItem]) {
        let staged = items.filter(\.isStaged)
        if staged != stagedItems { stagedItems = staged }
        guard !pendingStage.isEmpty else { return }
        let shown = Dictionary(items.map { ($0.sourceId, $0.draftOption ?? "") }, uniquingKeysWith: { first, _ in first })
        // A decision the list no longer holds shows no pick, so a pending unstage ("") is done.
        for (id, option) in pendingStage where (shown[id] ?? "") == option {
            pendingStage[id] = nil
        }
    }

    /// "3 decisions will be sent to 2 sessions".
    nonisolated public static func stagedSummary(_ items: [WidgetInboxItem], future: Bool = true) -> String {
        let sessions = Set(items.map(\.key)).count
        let verb = future ? "will be sent" : (items.count == 1 ? "was sent" : "were sent")
        return Plural.count(items.count, "decision") + " \(verb) to " + Plural.count(sessions, "session")
    }

    /// Sends the staged decisions `ids`: one message per session.
    public func sendStaged(_ ids: [String]) {
        let chosen = stagedItems.filter { ids.contains($0.sourceId) }
        guard !chosen.isEmpty else { return }
        deliverDecisions(chosen, action: "send-staged")
    }

    /// Sends again answered decisions that no session took (the notice's Send again), for every kind of agent.
    public func resendAnswers(_ items: [WidgetInboxItem]) {
        guard !items.isEmpty else { return }
        notice = "Sending again…"
        deliverDecisions(items, action: "resend-answers")
    }

    /// One message per session through the hub, then a notice that says what really happened: delivered, waiting
    /// for the session's next prompt (with why, and Send again), or not sent at all. It waits for the hub writes
    /// queued before it, so a pick changed a moment ago is the one that goes.
    private func deliverDecisions(_ items: [WidgetInboxItem], action: String) {
        var targets: [String: WidgetJSON] = [:]
        var titles: [String: String] = [:]
        for item in items {
            guard let session = session(forKey: item.key) else { continue }
            let target = session.target
            var fields: [String: WidgetJSON] = ["provider": .string(target.provider)]
            if !target.sourceHome.isEmpty { fields["sourceHome"] = .string(target.sourceHome) }
            if !target.cwd.isEmpty { fields["cwd"] = .string(target.cwd) }
            targets[target.sessionId] = .object(fields)
            titles[target.sessionId] = session.title
        }
        afterMutations { [weak self] in
            guard let self else { return }
            do {
                let result = try await self.call([
                    "action": .string(action), "ids": .array(items.map { .string($0.sourceId) }),
                    "targets": .object(targets),
                ])
                let outcome = WidgetDecisionSendOutcome(result, titles: titles)
                self.notice = outcome.notice(items: items, staged: action == "send-staged")
                let waiting = items.filter { item in
                    self.session(forKey: item.key).map { outcome.queuedSessions.contains($0.target.sessionId) } ?? false
                }
                if !waiting.isEmpty {
                    self.noticeAction = WidgetNoticeAction(title: "Send again") { [weak self] in self?.resendAnswers(waiting) }
                }
            } catch {
                if action == "resend-answers" { self.notice = nil }
                self.report(error)
            }
        }
    }

    /// Discards the picks and notes of the staged decisions `ids`; they still wait for an answer.
    public func discardStaged(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        for id in ids { pendingStage[id] = "" }
        action(["action": "unstage", "ids": .array(ids.map { .string($0) })], failed: { [weak self] in
            for id in ids { self?.pendingStage[id] = nil }
        })
    }

    /// A close the user asked for (Esc, the close button, a click outside, the idle timer): with staged decisions it
    /// asks first, as `stagedOnLeave` says ("ask" by default; "keep" closes, "send" sends them and closes).
    public func requestCollapse() {
        let ids = Set(stagedItems.map(\.sourceId))
        guard expanded != nil, !ids.isEmpty else {
            collapse()
            return
        }
        switch snapshot?.state.preferences.stagedOnLeave ?? "ask" {
        case "keep":
            collapse()
        case "send":
            sendStaged(Array(ids))
            collapse()
        default:
            guard !ids.isSubset(of: keptStaged) else {
                collapse()
                return
            }
            stagedLeavePrompt = true
        }
    }

    /// The answer to the leave question: "send", "keep" or "discard". The panel closes after any of them.
    public func resolveStagedLeave(_ choice: String) {
        let ids = stagedItems.map(\.sourceId)
        stagedLeavePrompt = false
        switch choice {
        case "send": sendStaged(ids)
        case "discard": discardStaged(ids)
        default: keptStaged = Set(ids)
        }
        stagedView = nil
        collapse()
    }
}

/// A button beside the widget's notice line.
public struct WidgetNoticeAction {
    public let title: String
    public let run: @MainActor () -> Void

    public init(title: String, run: @escaping @MainActor () -> Void) {
        self.title = title
        self.run = run
    }
}

/// What a decision send did, read from the hub's answer: how many went out, waited or failed, and why a session
/// took nothing.
struct WidgetDecisionSendOutcome {
    var sent = 0
    var queued = 0
    var failed = 0
    /// Session ids whose answers no receiver took, with the hub's one-line reason and the session's title.
    var waiting: [(session: String, title: String, reason: String)] = []

    var queuedSessions: Set<String> { Set(waiting.map(\.session)) }

    init(_ result: WidgetJSON, titles: [String: String]) {
        guard case .object(let fields) = result else { return }
        if case .number(let value) = fields["sent"] { sent = Int(value) }
        if case .number(let value) = fields["queued"] { queued = Int(value) }
        if case .number(let value) = fields["failed"] { failed = Int(value) }
        guard case .array(let sessions) = fields["sessions"] else { return }
        for case .object(let entry) in sessions {
            guard case .string(let session) = entry["session"], case .object(let answer) = entry["result"],
                  answer["delivered"] != .bool(true) else { continue }
            var reason = "No live receiver took them."
            if case .string(let detail) = answer["detail"], !detail.isEmpty { reason = detail }
            waiting.append((session, titles[session] ?? "the session", reason))
        }
    }

    /// The notice line: a plain summary when everything went out, else what did not and why.
    func notice(items: [WidgetInboxItem], staged: Bool) -> String {
        var parts: [String] = []
        if sent > 0 { parts.append(Plural.count(sent, "decision") + " delivered.") }
        if let first = waiting.first {
            let reason = first.reason.hasSuffix(".") ? first.reason : first.reason + "."
            let place = waiting.count == 1 ? first.title : Plural.count(waiting.count, "session")
            parts.append("Not delivered to \(place): \(reason) The answers wait for its next prompt.")
        }
        if failed > 0 {
            parts.append("\(Plural.count(failed, "decision")) could not be sent" + (staged ? " and stay staged." : "."))
        }
        return parts.isEmpty ? WidgetModel.stagedSummary(items, future: false) + "." : parts.joined(separator: " ")
    }
}
