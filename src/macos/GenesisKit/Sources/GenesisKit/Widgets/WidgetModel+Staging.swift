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
        if staged != stagedRows { stagedRows = staged }
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

    /// Sends the staged decisions `ids`: one message per session. With `thenClose` (a send on the way out of the
    /// panel) the panel stays open until the hub answers and closes only when every answer was delivered, so a send
    /// that failed is read where it happened instead of in a closed panel (ux catalogue P1).
    public func sendStaged(_ ids: [String], thenClose: Bool = false) {
        let chosen = stagedItems.filter { ids.contains($0.sourceId) }
        guard !chosen.isEmpty else {
            if thenClose { collapse() }
            return
        }
        deliverDecisions(chosen, action: "send-staged", thenClose: thenClose)
    }

    /// Sends again answered decisions that no session took (the notice's Send again), for every kind of agent.
    public func resendAnswers(_ items: [WidgetInboxItem]) {
        guard !items.isEmpty else { return }
        postNote("Sending again…")
        deliverDecisions(items, action: "resend-answers")
    }

    /// One message per session through the hub, then a note that says what really happened: delivered, waiting
    /// for the session's next prompt (with why, and Send again), or not sent at all (an error, with the hub's own
    /// words behind Details). When the panel was closed meanwhile, the sessions that took nothing flash on the rail.
    private func deliverDecisions(_ items: [WidgetInboxItem], action: String, thenClose: Bool = false) {
        let staged = action == "send-staged"
        let opened = openedAt
        if thenClose { postNote("Sending " + Plural.count(items.count, "decision") + "…") }
        // The "Sending…" note this send put up; a failure takes it down, unless another note replaced it meanwhile.
        let sendingNote = thenClose || action == "resend-answers" ? notice : nil
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
                let text = outcome.notice(items: items, staged: staged)
                if let details = outcome.details { PerfLog.mark("widget.decision-send \(action) not delivered: \(details)") }
                let waiting = items.filter { item in
                    self.session(forKey: item.key).map { outcome.queuedSessions.contains($0.target.sessionId) } ?? false
                }
                if outcome.delivered {
                    postNote(text)
                    // Only the panel this send left from: one the user opened again meanwhile stays open.
                    if thenClose, expanded != nil, openedAt == opened { collapse() }
                    return
                }
                if outcome.failed > 0 {
                    if let sendingNote, notice == sendingNote { notice = nil }
                    fail(text, detail: outcome.details)
                    if staged { keptStaged.subtract(items.map(\.sourceId)) }
                } else {
                    // The summary names one reason at most; every session's own reason stays behind Details.
                    postNote(text, action: waiting.isEmpty ? nil
                        : WidgetNoticeAction(title: "Send again") { [weak self] in self?.resendAnswers(waiting) },
                        detail: outcome.details)
                }
                flashUnsent(waiting.isEmpty ? items : waiting)
            } catch {
                if let sendingNote, self.notice == sendingNote { self.notice = nil }
                PerfLog.mark("widget.decision-send \(action) failed: \(error.localizedDescription)")
                fail(staged ? "The decisions could not be sent. They stay staged, so you can send them again."
                         : "The answers could not be sent again. They still wait for the session's next prompt.",
                     detail: error.localizedDescription)
                if staged { keptStaged.subtract(items.map(\.sourceId)) }
                flashUnsent(items)
            }
        }
    }

    /// A send result that arrives after the panel closed: the sessions it concerns flash on the rail (the alert flash
    /// setting), so the note waiting in the panel is noticed.
    private func flashUnsent(_ items: [WidgetInboxItem]) {
        guard expanded == nil else { return }
        let seconds = WidgetAlerts.flashSeconds(snapshot?.state.preferences)
        for key in Set(items.map(\.key)) { flashAttention(key, seconds: seconds) }
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
        // Staged decisions answered at an earlier leave (kept, or already on their way) do not ask again, so a
        // second Esc while a send runs closes the panel.
        let fresh = Set(stagedItems.map(\.sourceId)).subtracting(keptStaged)
        guard expanded != nil, !fresh.isEmpty else {
            collapse()
            return
        }
        switch snapshot?.state.preferences.stagedOnLeave ?? "ask" {
        case "keep":
            collapse()
        case "send":
            keptStaged.formUnion(fresh)
            sendStaged(Array(fresh), thenClose: true)
        default:
            stagedLeavePrompt = true
        }
    }

    /// The answer to the leave question: "send", "keep" or "discard". Keep and Discard close the panel at once;
    /// Send closes it once the hub says every answer was delivered, and leaves it open with the reason otherwise.
    public func resolveStagedLeave(_ choice: String) {
        let ids = stagedItems.map(\.sourceId)
        stagedLeavePrompt = false
        stagedView = nil
        switch choice {
        case "send":
            keptStaged.formUnion(ids)
            sendStaged(ids, thenClose: true)
            return
        case "discard": discardStaged(ids)
        default: keptStaged = Set(ids)
        }
        collapse()
    }
}

/// How long an Undo row holds a removed item back (Remove from shelf, Discard of a voice note): as long as a note with
/// a button stays (`noteSeconds`, at least 10 s), so every Undo in the widget lasts the same. With notes set to stay
/// until closed (`noteSeconds` 0), the row stays until it is closed, but 60 s at most, since the delete must happen.
public extension WidgetModel {
    nonisolated static func undoSeconds(_ preferences: WidgetPreferences?) -> Double {
        noteSeconds(preferences, hasAction: true) ?? 60
    }

    /// `undoSeconds` for the current preferences; the coordinator hands this to the shelf and voice-notes stores.
    var undoSeconds: Double { Self.undoSeconds(snapshot?.state.preferences) }
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
    /// Sessions whose answers no receiver took: the session id, its title, the reason as one sentence, and the hub's
    /// own words (for Details and the log).
    var waiting: [(session: String, title: String, reason: String, detail: String?)] = []
    /// The hub's own words for each session whose send threw, as "<title>: <error>".
    var failures: [String] = []

    var queuedSessions: Set<String> { Set(waiting.map(\.session)) }
    /// Every answer reached a live receiver.
    var delivered: Bool { waiting.isEmpty && failed == 0 }
    /// The hub's raw reasons, one line per session, for Details and the log; nil when it gave none.
    var details: String? {
        let lines = waiting.compactMap { entry in entry.detail.map { "\(entry.title): \($0)" } } + failures
        return lines.isEmpty ? nil : lines.joined(separator: "\n")
    }

    init(_ result: WidgetJSON, titles: [String: String]) {
        guard case .object(let fields) = result else { return }
        if case .number(let value) = fields["sent"] { sent = Int(value) }
        if case .number(let value) = fields["queued"] { queued = Int(value) }
        if case .number(let value) = fields["failed"] { failed = Int(value) }
        guard case .array(let sessions) = fields["sessions"] else { return }
        for case .object(let entry) in sessions {
            guard case .string(let session) = entry["session"] else { continue }
            let title = titles[session] ?? "the session"
            if case .string(let error) = entry["error"], !error.isEmpty {
                failures.append("\(title): \(error)")
                continue
            }
            guard case .object(let answer) = entry["result"], answer["delivered"] != .bool(true) else { continue }
            var detail: String?
            if case .string(let text) = answer["detail"], !text.isEmpty { detail = text }
            waiting.append((session, title, Self.sentence(for: detail), detail))
        }
    }

    /// Why no receiver took the answers, in one sentence. The hub words its reasons for logs ("No native Claude
    /// receiver claims this session.", "no cmux pane runs this session"); the known ones are matched here, and
    /// anything else reads as the generic sentence with the hub's text behind Details (ux catalogue P24). The hub's
    /// reasons: `src/question/lib/decisions/deliver.ts` (`resolveDeliveryTarget`, `nativeWorkers`, `undelivered`)
    /// and `delivery-text.ts` (`deliverySentence`).
    static func sentence(for detail: String?) -> String {
        let generic = "No running agent took them."
        guard let text = detail?.lowercased(), !text.isEmpty else { return generic }
        let known: [(needle: String, sentence: String)] = [
            ("worker is busy", "Its worker is busy with another turn."),
            ("worker session has not started", "Its worker has not started yet."),
            ("not ready for another turn", "Its worker is not ready for another turn."),
            ("claude terminals run this session",
             "Several Claude terminals run this session, so none was picked. Close the extra one, then send again."),
            ("no native claude receiver", "No open Claude terminal takes messages for this session."),
            ("receiver belongs to another source home", "Its Claude terminal runs under another account."),
            ("worker belongs to another source home", "Its worker runs under another account."),
            ("several owned workers match", "Several workers match this session, so none was picked."),
            ("worker runs this thread", "No Codex worker runs this conversation."),
            ("cmux is not running", "cmux is not running."),
            ("workspace of this session was closed", "Its cmux workspace was closed."),
            ("no cmux pane runs this session", "No cmux pane runs this session."),
            ("cmux panes match this session", "Several cmux panes match this session, so none was picked."),
            ("does not identify the exact recipient", "No cmux pane could be matched to this session for certain."),
            ("cmux send failed", "cmux could not type the answers."),
            ("too large to save for later", "The answers are too long to keep for a later delivery."),
            ("already saved this message", "An earlier send already saved them for this session."),
        ]
        return known.first { text.contains($0.needle) }?.sentence ?? generic
    }

    /// The note: a plain summary when everything went out, else what did not and why.
    func notice(items: [WidgetInboxItem], staged: Bool) -> String {
        var parts: [String] = []
        if sent > 0 { parts.append(Plural.count(sent, "decision") + " delivered.") }
        if let first = waiting.first {
            if waiting.count == 1 {
                parts.append("Not delivered to \(first.title): \(first.reason) The answers wait for its next prompt.")
            } else {
                // One reason for all of them is worth saying; several differ per session and live behind Details.
                let why = Set(waiting.map(\.reason)).count == 1 ? first.reason + " " : ""
                parts.append("Not delivered to \(Plural.count(waiting.count, "session")): \(why)"
                             + "The answers wait for each session's next prompt.")
            }
        }
        if failed > 0 {
            parts.append("\(Plural.count(failed, "decision")) could not be sent" + (staged ? " and stay staged." : "."))
        }
        return parts.isEmpty ? WidgetModel.stagedSummary(items, future: false) + "." : parts.joined(separator: " ")
    }
}
