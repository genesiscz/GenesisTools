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

    /// A click on a decision option in the inbox of every session.
    public func choose(_ item: WidgetInboxItem, option: String) {
        guard let session = session(forKey: item.key), let revision = item.revision else { return }
        let current = stagedOption(item.sourceId, stored: item.draftOption)
        stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision,
              option: current == option ? nil : option)
    }

    /// Save draft on a decision card: the composer's text becomes that decision's note, staged with the others, and
    /// the composer is cleared, so another decision's own answer does not open with this text.
    public func saveDraft(_ card: WidgetCard) {
        guard let selected, let revision = card.revision else { return }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision,
              option: stagedOption(card.sourceId, stored: card.draftOption), note: text)
        draftSavedAt[card.id] = Date()
        if !text.isEmpty { setText("") }
    }

    /// The own answer composer of a decision with a saved note opens with that note.
    public func openOwnAnswer(_ card: WidgetCard) {
        ownAnswerCardID = card.id
        if draft.text.isEmpty, let note = card.draft, !note.isEmpty { setText(note) }
    }

    private func stage(id: String, sessionId: String, revision: Int, option: String?, note: String? = nil) {
        pendingStage[id] = option ?? ""
        var fields: [String: WidgetJSON] = [
            "action": "ledger", "id": .string(id), "sessionId": .string(sessionId),
            "expectedRevision": .number(Double(revision)), "state": "drafted", "draftOption": .string(option ?? ""),
        ]
        if let note { fields["draft"] = .string(note) }
        action(.object(fields), failed: { [weak self] in self?.pendingStage[id] = nil })
    }

    /// The staged items as the snapshot shows them, and the picks staged here that it now shows.
    func reconcileStaged(_ items: [WidgetInboxItem]) {
        let staged = items.filter(\.isStaged)
        if staged != stagedItems { stagedItems = staged }
        guard !pendingStage.isEmpty else { return }
        let shown = Dictionary(items.map { ($0.sourceId, $0.draftOption ?? "") }, uniquingKeysWith: { first, _ in first })
        for (id, option) in pendingStage where shown[id] == option {
            pendingStage[id] = nil
        }
    }

    /// "3 decisions will be sent to 2 sessions".
    public static func stagedSummary(_ items: [WidgetInboxItem], future: Bool = true) -> String {
        let sessions = Set(items.map(\.key)).count
        let verb = future ? "will be sent" : (items.count == 1 ? "was sent" : "were sent")
        return Plural.count(items.count, "decision") + " \(verb) to " + Plural.count(sessions, "session")
    }

    /// Sends the staged decisions `ids`: one message per session.
    public func sendStaged(_ ids: [String]) {
        let chosen = stagedItems.filter { ids.contains($0.sourceId) }
        guard !chosen.isEmpty else { return }
        var targets: [String: WidgetJSON] = [:]
        for item in chosen {
            guard let target = session(forKey: item.key)?.target else { continue }
            var fields: [String: WidgetJSON] = ["provider": .string(target.provider)]
            if !target.sourceHome.isEmpty { fields["sourceHome"] = .string(target.sourceHome) }
            if !target.cwd.isEmpty { fields["cwd"] = .string(target.cwd) }
            targets[target.sessionId] = .object(fields)
        }
        let summary = Self.stagedSummary(chosen, future: false)
        Task {
            do {
                let result = try await call([
                    "action": "send-staged", "ids": .array(chosen.map { .string($0.sourceId) }), "targets": .object(targets),
                ])
                guard case .object(let fields) = result, case .number(let failed) = fields["failed"] else {
                    notice = summary + "."
                    return
                }
                notice = failed > 0
                    ? "\(Int(failed)) staged \(failed == 1 ? "decision" : "decisions") could not be sent and stay staged."
                    : summary + "."
            } catch { report(error) }
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
