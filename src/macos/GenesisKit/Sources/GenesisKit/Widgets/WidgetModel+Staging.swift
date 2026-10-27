import AppKit
import Foundation

/// Staged decisions: a pick or a note kept to send later, together with others (Martin, 2026-10-23: "click on the
/// decision option should not send it immediatelly, but stage that change"). They are the decision log's own unsent
/// state (`drafted` with `draftOption` or `draft`), so every inbox, the hub and the CLI see one list, and nothing is
/// lost when the widget restarts.
extension WidgetModel {
    /// A click on a decision option or its number key stages it ("stage", the default) or sends it at once ("send").
    public var decisionClickStages: Bool { (snapshot?.state.preferences.decisionClick ?? "stage") == "stage" }

    /// What this click does: `decisionClickStages`, turned around while ⌘ is down (`decisionCommandSwaps`, on by
    /// default), so a ⌘-click sends at once while clicks stage, and stages while clicks send (Martin, 2026-10-26).
    public var clickStagesNow: Bool {
        DecisionAnswering.clickStages(snapshot?.state.preferences, command: NSEvent.modifierFlags.contains(.command))
    }

    /// Return in a decision's own answer field stages the text as its note ("stage", the default) or sends it.
    public var ownAnswerReturnStages: Bool { (snapshot?.state.preferences.ownAnswerReturn ?? "stage") == "stage" }

    /// Return (or ⌘-Return, `command`) in the own answer field of `ownAnswerCard`: stage the text as the decision's
    /// note or send it as the answer, by `ownAnswerReturn`; ⌘ does the other while `decisionCommandSwaps` is on.
    public func returnInOwnAnswer(command: Bool) {
        guard let card = ownAnswerCard else {
            send()
            return
        }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if DecisionAnswering.returnStages(snapshot?.state.preferences, command: command) {
            guard !text.isEmpty else {
                postNote("Write your answer first.")
                return
            }
            saveDraft(card)
        } else if card.kind == "decision", card.needsAnswer, draft.assetIds.isEmpty {
            // The staged pick goes with the typed words, as Send now sends them; the outbox sent the words alone.
            guard !text.isEmpty else {
                postNote("Write your answer first.")
                return
            }
            sendDecisionNow(card, option: nil, note: text)
        } else {
            submitOwnAnswer()
        }
    }

    /// The pick a card shows as staged: the one staged here a moment ago, else the snapshot's.
    public func stagedOption(_ sourceId: String, stored: String?) -> String? {
        if let pending = pendingStage[sourceId] { return pending.isEmpty ? nil : pending }
        return stored
    }

    /// The selected session's staged decisions.
    public var sessionStaged: [WidgetInboxItem] { stagedItems.filter { $0.key == selectedKey } }

    /// A click on a decision option in a session's inbox. A second click on the staged option clears the pick.
    /// ⇧ adds the letter to the staged ones or takes it out (`DecisionAnswering.nextPick`), and always stages.
    public func choose(_ card: WidgetCard, option: String) {
        let adding = NSEvent.modifierFlags.contains(.shift)
        guard clickStagesNow || adding else {
            // Media in this card's own answer cannot be staged: the outbox carries it with the pick.
            if ownAnswerCardID == card.id, !draft.assetIds.isEmpty {
                selectedCardID = card.id
                submit(choice: option, withDraft: true)
                return
            }
            // Only text written in this card's own answer field goes with the pick; a reply typed above stays a
            // reply. Without it the staged note goes, as Send now sends it.
            let typed = ownAnswerCardID == card.id ? draft.text.trimmingCharacters(in: .whitespacesAndNewlines) : ""
            sendDecisionNow(card, option: option, note: typed.isEmpty ? nil : typed)
            return
        }
        guard let selected, let revision = card.revision else { return }
        let current = stagedOption(card.sourceId, stored: card.draftOption)
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision,
              option: DecisionAnswering.nextPick(current, option, adding: adding), item: Self.inboxItem(card))
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
        let adding = NSEvent.modifierFlags.contains(.shift)
        guard clickStagesNow || adding else {
            stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision, option: option,
                  item: item, completed: { [weak self] in
                      self?.pendingStage[item.sourceId] = nil
                      self?.deliverDecisions([item], action: .sendStaged)
                  })
            return
        }
        let current = stagedOption(item.sourceId, stored: item.draftOption)
        stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision,
              option: DecisionAnswering.nextPick(current, option, adding: adding), item: item)
    }

    /// Sends `card`'s decision now the one way every decision send goes: stage the pick and the note, then
    /// send-staged, as Send now does. The session card's send at once and its own answer's Send went through the
    /// outbox, which took only the clicked letter or only the typed words and dropped the staged rest (decision
    /// audit F8). `option` nil keeps the staged letters, `note` nil the staged note; typed words leave the composer
    /// once the hub has them.
    func sendDecisionNow(_ card: WidgetCard, option: String?, note: String?) {
        guard let selected, let revision = card.revision else { return }
        let item = Self.inboxItem(card)
        let key = selectedKey
        let typed = draft.text
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision,
              option: option ?? stagedOption(card.sourceId, stored: card.draftOption), note: note, item: item,
              completed: { [weak self] in
                  guard let self else { return }
                  self.pendingStage[card.sourceId] = nil
                  if note != nil, self.selectedKey == key, self.draft.text == typed {
                      self.setText("")
                      if self.ownAnswerCardID == card.id { self.ownAnswerCardID = nil }
                  }
                  self.deliverDecisions([item], action: .sendStaged)
              })
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
              option: stagedOption(card.sourceId, stored: card.draftOption), note: text, item: Self.inboxItem(card),
              completed: { [weak self] in
                  guard let self else { return }
                  self.draftSavedAt[card.id] = Date()
                  // Only the text that was saved: a session switch or new typing keeps the composer as it is.
                  if !text.isEmpty, self.selectedKey == key, self.draft.text == typed { self.setText("") }
              })
    }

    /// The own answer field of a decision takes the draft (its card becomes the selected, open one); with a staged note
    /// and an empty draft it opens with that note.
    public func openOwnAnswer(_ card: WidgetCard) {
        selectedCardID = card.id
        foldedCardIDs.remove(card.id)
        ownAnswerCardID = card.id
        if draft.text.isEmpty, let note = card.draft, !note.isEmpty { setText(note) }
    }

    /// The own answer holds nothing and nothing is being added to it, so losing the keyboard may fold it.
    public var ownAnswerIdle: Bool {
        draft.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && draft.assetIds.isEmpty && !voiceActive
            && !recordingVideo && importing == 0
    }

    /// Unstage on a card: the pick and the note leave the staged list, and a staged note comes back into the card's
    /// own answer field, so the text the user wrote is never thrown away.
    public func unstage(_ card: WidgetCard) {
        discardStaged([card.sourceId])
        guard let note = card.draft?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty,
              selectedKey == card.sessionKey else { return }
        let typed = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.contains(note) { setText(typed.isEmpty ? note : typed + "\n" + note) }
        openOwnAnswer(card)
        draftSavedAt[card.id] = nil
    }

    /// A card as the inbox list carries it, for the sends that take list items (Send now, Send again).
    nonisolated static func inboxItem(_ card: WidgetCard) -> WidgetInboxItem {
        WidgetInboxItem(id: card.id, sourceId: card.sourceId, kind: card.kind, key: card.sessionKey, at: card.at,
                        needsAnswer: card.needsAnswer, title: card.title, number: card.number,
                        options: card.choices.map(\.title), recommended: card.choices.first(where: \.recommended)?.id,
                        revision: card.revision, draftOption: card.draftOption, draft: card.draft)
    }

    private func stage(
        id: String, sessionId: String, revision: Int, option: String?, note: String? = nil,
        item: WidgetInboxItem? = nil, completed: (() -> Void)? = nil
    ) {
        sendCloseRevision += 1
        markPending(id, option ?? "", item: item)
        var fields: [String: WidgetJSON] = [
            "action": "ledger", "id": .string(id), "sessionId": .string(sessionId),
            "expectedRevision": .number(Double(revision)), "state": "drafted", "draftOption": .string(option ?? ""),
        ]
        if let note { fields["draft"] = .string(note) }
        action(.object(fields), failed: { [weak self] in self?.pendingStage[id] = nil }, completed: { [weak self] in
            self?.pendingStageDone[id] = Date().timeIntervalSince1970 * 1000
            completed?()
        })
    }

    /// How long a pick made here shows after the hub took it, before a snapshot confirms it: a few snapshots' time.
    /// After it the snapshot is the truth again, so a pick that never landed, or a decision sent elsewhere, stops
    /// showing it. The clock starts when the hub answers: a write still queued behind others keeps its pick, which
    /// went away and came back when the hub was slow.
    nonisolated static let pendingStageLifetime: TimeInterval = 15
    /// The limit for a pick whose write never answered (a discard has no `pendingStageDone`).
    nonisolated static let pendingStageUnansweredLifetime: TimeInterval = 60

    /// A pick or a clear (`""`) made here, shown at once until a snapshot shows the decision log has it.
    func markPending(_ id: String, _ option: String, item: WidgetInboxItem? = nil) {
        pendingStage[id] = option
        pendingStageAt[id] = Date().timeIntervalSince1970 * 1000
        pendingStageDone[id] = nil
        if let item { pendingStageItems[id] = item }
    }

    /// The staged items as the snapshot shows them, and the picks staged here that it now shows. `listed`: every
    /// decision the snapshot lists, to say when a revision cleared a staged pick.
    func reconcileStaged(_ items: [WidgetInboxItem], listed: [WidgetInboxItem] = []) {
        let staged = items.filter(\.isStaged)
        noteClearedPicks(before: stagedRows, after: staged, listed: listed)
        if staged != stagedRows { stagedRows = staged }
        refreshPeekStaging(staged)
        let shown = Dictionary(items.map { ($0.sourceId, (pick: $0.draftOption ?? "", at: $0.updatedAt ?? 0)) },
                               uniquingKeysWith: { first, _ in first })
        let now = Date().timeIntervalSince1970 * 1000
        for (id, option) in pendingStage {
            let row = shown[id]
            // Shown as picked here (a decision the list no longer holds shows no pick, so a pending unstage "" is
            // done); or the row changed after this pick landed, so another surface or a revision wrote it since; or
            // no snapshot confirmed the pick in time.
            let confirmed = (row?.pick ?? "") == option
            let overtaken = pendingStageDone[id].map { done in (row?.at ?? 0) > done } ?? false
            let expired = pendingStageDone[id].map { done in now - done > Self.pendingStageLifetime * 1000 }
                ?? pendingStageAt[id].map { asked in now - asked > Self.pendingStageUnansweredLifetime * 1000 }
                ?? false
            if confirmed || overtaken || expired {
                if !confirmed { PerfLog.mark("widget.staged pending dropped id=\(id) overtaken=\(overtaken)") }
                pendingStage[id] = nil
            }
        }
        pendingStageAt = pendingStageAt.filter { pendingStage[$0.key] != nil }
        pendingStageDone = pendingStageDone.filter { pendingStage[$0.key] != nil }
        pendingStageItems = pendingStageItems.filter { pendingStage[$0.key] != nil }
    }

    /// A staged pick the agent's new text cleared (a revision drops the staged pick, since it was made on the old
    /// text) is said once, so it is not lost without a word (decision audit F12).
    private func noteClearedPicks(before: [WidgetInboxItem], after: [WidgetInboxItem], listed: [WidgetInboxItem]) {
        let still = Set(after.map(\.sourceId))
        let revised = before.compactMap { old -> (WidgetInboxItem, WidgetInboxItem)? in
            guard !still.contains(old.sourceId), !sendingDecisionIDs.contains(old.sourceId),
                  pendingStage[old.sourceId] != "", let oldRevision = old.revision,
                  let now = listed.first(where: { $0.sourceId == old.sourceId && $0.needsAnswer }),
                  (now.revision ?? 0) > oldRevision else { return nil }
            return (old, now)
        }
        guard let (old, now) = revised.first else { return }
        let pick = DecisionAnswering.pickWords(option: old.draftOption, note: old.draft)
        PerfLog.mark("widget.staged cleared by revision id=\(old.sourceId) revision=\(now.revision ?? 0)")
        postNote("\(WidgetWords.decision(now.number ?? old.number)) changed. The agent wrote new text, so your staged "
            + "\(pick) is cleared. Read the decision again and pick.", tone: .warning)
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
    /// `known`: items the caller holds whose pick was staged here a moment ago, before a snapshot listed them; the
    /// send waits for that stage (`afterMutations`), so a Send now right after the click sends it.
    public func sendStaged(_ ids: [String], thenClose: Bool = false, known: [WidgetInboxItem] = []) {
        var chosen = stagedItems.filter { ids.contains($0.sourceId) }
        for item in known where ids.contains(item.sourceId) && !chosen.contains(where: { $0.sourceId == item.sourceId })
            && (stagedOption(item.sourceId, stored: item.draftOption) != nil || item.draft != nil) {
            chosen.append(item)
        }
        guard !chosen.isEmpty else {
            // Nothing to send used to close the panel without a word, which read as a send that did nothing.
            PerfLog.mark("widget.send-staged nothing to send: \(ids.count) ids picked, \(stagedItems.count) staged")
            postNote(ids.isEmpty ? "No decision is checked, so nothing was sent."
                                 : "These decisions are no longer staged, so nothing was sent.")
            return
        }
        // A second press while the first send runs: that send's note answers it.
        let fresh = chosen.filter { !sendingDecisionIDs.contains($0.sourceId) }
        guard !fresh.isEmpty else { return }
        deliverDecisions(fresh, action: .sendStaged, thenClose: thenClose)
    }

    /// Sends again answered decisions that no session took (the notice's Send again), for every kind of agent.
    public func resendAnswers(_ items: [WidgetInboxItem]) {
        guard !items.isEmpty else { return }
        postNote("Sending again…")
        deliverDecisions(items, action: .resendAnswers)
    }

    /// One message per session through the hub, then a note that says what really happened: delivered, waiting
    /// for the session's next prompt (with why, and Send again), or not sent at all (an error, with the hub's own
    /// words behind Details). When the panel was closed meanwhile, the sessions that took nothing flash on the rail.
    private func deliverDecisions(_ items: [WidgetInboxItem], action: DecisionAnswering.SendAction, thenClose: Bool = false) {
        let staged = action == .sendStaged
        let opened = openedAt
        // Sent from the popup on screen (its Send now, or the staged reminder's): the popup shows the result.
        let fromPeek = peekItem.map { shown in
            items.contains { $0.sourceId == shown.sourceId } || shown.sourceId == WidgetAlerts.stagedReminderID
        } ?? false
        let closeRevision = sendCloseRevision
        let draftAtSend = draft
        let ids = Set(items.map(\.sourceId))
        sendingDecisionIDs.formUnion(ids)
        // Every staged send says it started: a Send now that changed nothing on screen read as a dead button.
        if staged { postNote("Sending " + Plural.count(items.count, "decision") + "…") }
        // The "Sending…" note this send put up; a failure takes it down, unless another note replaced it meanwhile.
        let sendingNote = staged || action == .resendAnswers ? notice : nil
        var targets: [String: DecisionAnswering.Target] = [:]
        var titles: [String: String] = [:]
        for item in items {
            guard let session = session(forKey: item.key) else { continue }
            let target = session.target
            targets[target.sessionId] = DecisionAnswering.Target(provider: target.provider, sourceHome: target.sourceHome,
                                                                 cwd: target.cwd)
            titles[target.sessionId] = session.title
        }
        PerfLog.mark("widget.decision-send \(action.rawValue) start: \(items.count) to "
            + titles.values.sorted().joined(separator: ", "))
        afterMutations { [weak self] in
            guard let self else { return }
            defer { self.sendingDecisionIDs.subtract(ids) }
            do {
                let result = try await self.call(DecisionAnswering.sendRequest(action, ids: items.map(\.sourceId),
                                                                               targets: targets))
                let outcome = WidgetDecisionSendOutcome(result, titles: titles)
                let text = outcome.notice(items: items, staged: staged)
                if let details = outcome.details { PerfLog.mark("widget.decision-send \(action.rawValue) not delivered: \(details)") }
                let waiting = items.filter { item in
                    self.session(forKey: item.key).map { outcome.queuedSessions.contains($0.target.sessionId) } ?? false
                }
                PerfLog.mark("widget.decision-send \(action.rawValue) result: \(text)")
                let tone: WidgetNoticeTone = outcome.delivered ? .success : .warning
                if fromPeek {
                    self.showPeekOutcome(WidgetPeekOutcome(text: text, tone: tone, sendAgain: waiting,
                                                           detail: outcome.details),
                                         sent: ids, delivered: outcome.delivered)
                } else if outcome.failed == 0 {
                    self.dropSentFromPeek(ids)
                }
                if outcome.delivered {
                    postNote(text, tone: .success)
                    // Only the panel this send left from: one the user opened again meanwhile stays open. It folds
                    // after the note was readable: closing at once hid "delivered" and read as "Send did nothing"
                    // (Martin, 2026-10-25).
                    let closeSeconds = snapshot?.state.preferences.sendCloseSeconds ?? 2.5
                    if thenClose, expanded != nil, openedAt == opened, sendCloseRevision == closeRevision,
                       closeSeconds > 0 {
                        Task { [weak self] in
                            do { try await Task.sleep(for: .seconds(closeSeconds)) } catch { return }
                            guard let self, self.expanded != nil, self.openedAt == opened,
                                  self.sendCloseRevision == closeRevision, self.draft == draftAtSend else { return }
                            self.collapse()
                        }
                    }
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
                        detail: outcome.details, tone: .warning)
                }
                flashUnsent(waiting.isEmpty ? items : waiting)
            } catch {
                if let sendingNote, self.notice == sendingNote { self.notice = nil }
                PerfLog.mark("widget.decision-send \(action.rawValue) failed: \(error.localizedDescription)")
                if fromPeek {
                    self.showPeekOutcome(WidgetPeekOutcome(text: staged
                        ? "Not sent: the hub refused it. It stays staged." : "Not sent again: the hub refused it.",
                        tone: .warning, detail: error.localizedDescription), sent: ids, delivered: false)
                }
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
    public func discardStaged(_ ids: [String], completed: (() -> Void)? = nil) {
        guard !ids.isEmpty else { return }
        sendCloseRevision += 1
        for id in ids { markPending(id, "") }
        action(["action": "unstage", "ids": .array(ids.map { .string($0) })], failed: { [weak self] in
            for id in ids { self?.pendingStage[id] = nil }
            completed?()
        }, completed: completed)
    }

    /// A close the user asked for (Esc, the close button, a click outside, the idle timer): with staged decisions it
    /// asks first, as `stagedOnLeave` says ("ask" by default; "keep" closes, "send" sends them and closes).
    public func requestCollapse(file: StaticString = #fileID, line: UInt = #line) {
        // Staged decisions answered at an earlier leave (kept, or already on their way) do not ask again, so a
        // second Esc while a send runs closes the panel.
        let items = stagedForLeave
        let fresh = Set(items.map(\.sourceId)).subtracting(keptStaged)
        guard expanded != nil, !fresh.isEmpty else {
            collapse(file: file, line: line)
            return
        }
        switch snapshot?.state.preferences.stagedOnLeave ?? "ask" {
        case "keep":
            collapse(file: file, line: line)
        case "send":
            keptStaged.formUnion(fresh)
            sendStaged(Array(fresh), thenClose: true, known: items)
        default:
            stagedLeavePrompt = true
        }
    }

    /// The staged decisions as the user sees them: the snapshot's, without picks cleared here, plus picks staged here
    /// that no snapshot listed yet. The leave question and a popup's end read this: a pick made less than a second
    /// before Esc was only in `pendingStage`, and the panel closed without asking (decision audit F16).
    public var stagedForLeave: [WidgetInboxItem] {
        let listed = Set(stagedItems.map(\.sourceId))
        let pending = pendingStage.compactMap { id, option -> WidgetInboxItem? in
            guard !option.isEmpty, !listed.contains(id), !heldDecisionIDs.contains(id),
                  var item = pendingStageItems[id] else { return nil }
            item.draftOption = option
            return item
        }
        return stagedItems.filter { pendingStage[$0.sourceId] != "" } + pending.sorted { $0.at < $1.at }
    }

    /// The answer to the leave question: "send", "keep" or "discard". Keep and Discard close the panel at once;
    /// Send closes it once the hub says every answer was delivered, and leaves it open with the reason otherwise.
    public func resolveStagedLeave(_ choice: String) {
        let items = stagedForLeave
        let ids = items.map(\.sourceId)
        stagedLeavePrompt = false
        stagedView = nil
        switch choice {
        case "send":
            keptStaged.formUnion(ids)
            sendStaged(ids, thenClose: true, known: items)
            return
        case "discard": holdDiscard(ids)
        default: keptStaged = Set(ids)
        }
        collapse()
    }

    /// Discards the staged decisions `ids` after the Undo window (`undoSeconds`): until then they leave every send
    /// (`heldDecisionIDs`) and `undoHeldDiscard` keeps them staged. A second hold sends the first one's discard now.
    public func holdDiscard(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        commitHeldDiscard()
        heldDiscard = ids
        heldDecisionIDs.formUnion(ids)
        PerfLog.mark("widget.staged discard held \(ids.count)")
        postNote(Plural.count(ids.count, "staged decision") + " discarded.",
                 action: WidgetNoticeAction(title: "Undo") { [weak self] in self?.undoHeldDiscard() })
        let seconds = undoSeconds
        discardTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(seconds)) } catch { return }
            self?.commitHeldDiscard()
        }
    }

    /// Undo of a held Discard: the decisions stay staged as they were; nothing reached the decision log.
    public func undoHeldDiscard() {
        guard !heldDiscard.isEmpty else { return }
        discardTask?.cancel()
        discardTask = nil
        heldDecisionIDs.subtract(heldDiscard)
        PerfLog.mark("widget.staged discard undone \(heldDiscard.count)")
        postNote(Plural.count(heldDiscard.count, "decision") + " kept staged.")
        heldDiscard = []
    }

    /// Sends a held Discard to the decision log now (its window ended, another discard came, or the widget stops).
    func commitHeldDiscard() {
        discardTask?.cancel()
        discardTask = nil
        guard !heldDiscard.isEmpty else { return }
        let ids = heldDiscard
        heldDiscard = []
        discardStaged(ids, completed: { [weak self] in self?.heldDecisionIDs.subtract(ids) })
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
