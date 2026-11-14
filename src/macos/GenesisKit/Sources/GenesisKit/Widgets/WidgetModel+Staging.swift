import AppKit
import Foundation

/// Staged decisions: a pick or a note kept to send later, together with others (Martin, 2026-10-23: "click on the
/// decision option should not send it immediatelly, but stage that change"). They are the decision log's own unsent
/// state (`drafted` with `draftOption` or `draft`), so every inbox, the hub and the CLI see one list, and nothing is
/// lost when the widget restarts.
extension WidgetModel {
    /// A click on a decision option or its number key stages it ("stage", the default) or sends it at once ("send").
    public var decisionClickStages: Bool { preferences.decisionClick == "stage" }

    /// What this click does: `decisionClickStages`, turned around while ⌘ is down (`decisionCommandSwaps`, on by
    /// default), so a ⌘-click sends at once while clicks stage, and stages while clicks send (Martin, 2026-10-26).
    public var clickStagesNow: Bool {
        DecisionAnswering.clickStages(preferences, command: NSEvent.modifierFlags.contains(.command))
    }

    /// Return in a decision's own answer field stages the text as its note ("stage", the default) or sends it.
    public var ownAnswerReturnStages: Bool { preferences.ownAnswerReturn == "stage" }

    /// Return (or ⌘-Return, `command`) in the own answer field of `ownAnswerCard`: stage the text as the decision's
    /// note or send it as the answer, by `ownAnswerReturn`; ⌘ does the other while `decisionCommandSwaps` is on.
    public func returnInOwnAnswer(command: Bool) {
        guard let card = ownAnswerCard else {
            send()
            return
        }
        let text = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        // Return again on the empty field, after Return staged the note: the staged decision goes to its session now
        // (Martin, 2026-10-28: "if i enter to stage, then enter it again, it should probably send that one").
        if text.isEmpty, emptyReturnOnStaged(card) { return }
        if DecisionAnswering.returnStages(preferences, command: command) {
            guard !text.isEmpty else {
                // The warning tone: in the default grey this note was nearly invisible (Martin, 2026-10-28).
                postNote("Write your answer first.", tone: .warning)
                return
            }
            saveDraft(card)
        } else {
            submitOwnAnswer()
        }
    }

    /// Return on the empty own answer of a staged decision, by Settings → "Return on an empty answer"
    /// (`ownAnswerEmptyReturn`): send it ("send", the default), ask first in a note with Send ("confirm"), or only say
    /// so ("nothing"). False when nothing is staged on it, so the caller says the field is empty.
    func emptyReturnOnStaged(_ card: WidgetCard) -> Bool {
        guard isStaged(card), draft.assetIds.isEmpty else { return false }
        let decision = WidgetWords.decision(card.number)
        switch preferences.ownAnswerEmptyReturn {
        case "confirm":
            postNote("Send " + decision + " with its staged answer now?", action: WidgetNoticeAction(title: "Send") {
                [weak self] in _ = self?.sendStagedFromOwnAnswer(card)
            }, tone: .warning)
        case "nothing":
            postNote("The answer field is empty; " + decision + " stays staged. Send now sends it.", tone: .warning)
        default:
            sendStagedFromOwnAnswer(card)
        }
        return true
    }

    /// A pick or a note is staged on the card, here or in the snapshot, and no discard of it waits for its Undo.
    func isStaged(_ card: WidgetCard) -> Bool {
        !heldDecisionIDs.contains(card.sourceId)
            && (stagedOption(card.sourceId, stored: card.draftOption) != nil
                || (decisions.pending[card.sourceId]?.note ?? card.draft)?.isEmpty == false)
    }

    /// An empty own answer of a staged decision sends that decision, as its Send now does. False when nothing is
    /// staged on it, or media waits in the field (the media goes with a typed answer, never alone).
    @discardableResult
    func sendStagedFromOwnAnswer(_ card: WidgetCard) -> Bool {
        guard draft.assetIds.isEmpty, isStaged(card) else { return false }
        let note = decisions.pending[card.sourceId]?.note ?? card.draft
        PerfLog.mark("widget.own-answer send staged \(card.sourceId)")
        // The note staged a moment ago is not in a snapshot yet; the item carries it, as the leave question's does.
        var item = Self.inboxItem(card)
        item.draft = note
        item.draftOption = stagedOption(card.sourceId, stored: card.draftOption)
        sendStaged([card.sourceId], known: [item])
        return true
    }

    /// A Send of `card` while its own answer field holds words or media: the words become its staged note and go with
    /// the staged pick, and the field empties only once the hub has the note (`sendDecisionNow`); media cannot be staged,
    /// so it goes with the pick and the words through the durable outbox, as a click with media does. False when the
    /// field is empty, so the staged pick and note go as they are.
    func sendOwnAnswerWithStage(_ card: WidgetCard, thenClose: Bool = false) -> Bool {
        let typed = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard card.kind == "decision", card.needsAnswer, !typed.isEmpty || !draft.assetIds.isEmpty else { return false }
        PerfLog.mark("widget.send-staged own answer goes with \(card.sourceId)")
        guard draft.assetIds.isEmpty else {
            submit(choice: stagedOption(card.sourceId, stored: card.draftOption), answering: true, thenClose: thenClose)
            return true
        }
        sendDecisionNow(card, option: nil, note: typed, thenClose: thenClose)
        return true
    }

    /// The pick a card shows as staged: the one staged here a moment ago, else the snapshot's.
    public func stagedOption(_ sourceId: String, stored: String?) -> String? {
        if let pending = decisions.pending[sourceId]?.option { return pending.isEmpty ? nil : pending }
        return stored
    }

    /// The selected session's staged decisions.
    public var sessionStaged: [WidgetInboxItem] { stagedItems.filter { $0.key == selectedKey } }

    /// A click on a decision option in a session's inbox. A second click on the staged option clears the pick.
    /// ⇧ adds the letter to the staged ones or takes it out (`DecisionAnswering.nextPick`), and always stages.
    /// A decision that takes any set of its options does what ⇧ does on every click and number key, in every click
    /// mode ("Send at once" too): only its Send sends the ticked set (Martin, 2026-11-07, DECISION 15).
    public func choose(_ card: WidgetCard, option: String) {
        if card.kind == "dialog" {
            answerDialog(key: card.sourceId, option: option)
            return
        }
        let adding = NSEvent.modifierFlags.contains(.shift) || card.takesSeveral
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

    func answerDialog(key: String, option: String) {
        guard dialogSendingIDs.insert(key).inserted else { return }
        afterMutations { [weak self] in
            guard let self else { return }
            defer { self.dialogSendingIDs.remove(key) }
            do {
                let result = try await self.call(["action": "dialog-answer", "key": .string(key), "option": .string(option)])
                if case .object(let fields) = result, fields["delivered"] == .bool(true) {
                    self.postNote("Dialog answer delivered.")
                } else if case .object(let fields) = result, fields["uncertain"] == .bool(true),
                          case .string(let detail) = fields["detail"] {
                    self.postNote("Answer not confirmed: " + detail, tone: .warning)
                } else if case .object(let fields) = result, case .string(let error) = fields["error"] {
                    self.postNote("Answer not confirmed: " + error, tone: .warning)
                } else {
                    self.postNote("Answer not confirmed. Check the dialog before retrying.", tone: .warning)
                }
            } catch {
                self.postNote("Answer not confirmed. Check the dialog before retrying.", tone: .warning)
            }
        }
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
    /// item's own session and sent once the hub has it. A decision that takes any set of its options ticks or unticks
    /// the letter instead, in every click mode, as `choose(_:option:)` on a card does.
    public func choose(_ item: WidgetInboxItem, option: String) {
        if item.kind == "dialog" {
            answerDialog(key: item.sourceId, option: option)
            return
        }
        guard let session = session(forKey: item.key), let revision = item.revision else { return }
        let adding = NSEvent.modifierFlags.contains(.shift) || item.takesSeveral
        guard clickStagesNow || adding else {
            stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision, option: option,
                  item: item, completed: { [weak self] version in
                      guard let self, self.canSendStaged(item.sourceId, version: version) else { return }
                      self.decisions.forget(item.sourceId, version: version)
                      self.deliverDecisions([item], action: .sendStaged)
                  })
            return
        }
        let current = stagedOption(item.sourceId, stored: item.draftOption)
        stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision,
              option: DecisionAnswering.nextPick(current, option, adding: adding), item: item)
    }

    /// "Pick the recommended a + b + c" on a card: the staged pick becomes exactly `option`; nothing is sent.
    public func pickSet(_ card: WidgetCard, option: String) {
        guard let selected, let revision = card.revision else { return }
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision, option: option,
              item: Self.inboxItem(card))
    }

    /// "Pick the recommended a + b + c" on an inbox item: the staged pick becomes exactly `option`; nothing is sent.
    public func pickSet(_ item: WidgetInboxItem, option: String) {
        guard let session = session(forKey: item.key), let revision = item.revision else { return }
        stage(id: item.sourceId, sessionId: session.target.sessionId, revision: revision, option: option, item: item)
    }

    /// ⌘-Return on an option of a decision that takes any set: the ticked set goes to its session now; with nothing
    /// ticked, `letter` is ticked first and goes alone. Return alone only ticks (`choose`).
    func sendSet(_ card: WidgetCard, orLetter letter: String) {
        if stagedOption(card.sourceId, stored: card.draftOption) == nil { choose(card, option: letter) }
        sendStaged([card.sourceId], known: [Self.inboxItem(card)])
    }

    /// `sendSet(_:orLetter:)` for an entry of the inbox of every session.
    func sendSet(_ item: WidgetInboxItem, orLetter letter: String) {
        if stagedOption(item.sourceId, stored: item.draftOption) == nil { choose(item, option: letter) }
        sendStaged([item.sourceId], known: [item])
    }

    /// Sends a card's selected option by staging its pick and note, then sending the staged decision.
    /// `option` nil keeps the staged letters, `note` nil keeps the staged note; typed words leave the composer
    /// once the hub has them. Text-only own answers use the durable outbox and carry their staged pick there.
    /// `thenClose`: the send came from a Send on the way out of the panel, which folds once the hub took the answer.
    func sendDecisionNow(_ card: WidgetCard, option: String?, note: String?, thenClose: Bool = false) {
        guard let selected, let revision = card.revision else { return }
        let item = Self.inboxItem(card)
        let key = selectedKey
        let typed = draft.text
        stage(id: card.sourceId, sessionId: selected.target.sessionId, revision: revision,
              option: option ?? stagedOption(card.sourceId, stored: card.draftOption), note: note, item: item,
              completed: { [weak self] version in
                  guard let self, self.canSendStaged(card.sourceId, version: version) else { return }
                  self.decisions.forget(card.sourceId, version: version)
                  if note != nil, self.selectedKey == key, self.draft.text == typed {
                      self.setText("")
                      if self.ownAnswerCardID == card.id { self.ownAnswerCardID = nil }
                  }
                  self.deliverDecisions([item], action: .sendStaged, thenClose: thenClose)
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
              completed: { [weak self] _ in
                  guard let self else { return }
                  self.draftSavedAt[card.id] = Date()
                  // Only the text that was saved: a session switch or new typing keeps the composer as it is.
                  if !text.isEmpty, self.selectedKey == key, self.draft.text == typed { self.setText("") }
              })
    }

    /// The card behind an inbox item, for its text: the selected session's, else the one cached for its session; nil
    /// while no snapshot of that session was read here.
    func card(for item: WidgetInboxItem) -> WidgetCard? {
        cards.first { $0.id == item.id } ?? sessionCache[item.key]?.cards.first { $0.id == item.id }
    }

    /// The own answer field of a decision takes the draft (its card becomes the selected, open one); with a staged note
    /// and an empty draft it opens with that note.
    public func openOwnAnswer(_ card: WidgetCard) {
        selectedCardID = card.id
        foldedCardIDs.remove(card.id)
        ownAnswerCardID = card.id
        if draft.text.isEmpty, let note = card.draft, !note.isEmpty { setText(note) }
    }

    /// The words a decision's own answer holds now, for a field that shows them without editing (the alert's compact
    /// field): the session's draft while that decision holds it, else the text kept for it, else its staged note.
    public func ownAnswerText(for item: WidgetInboxItem) -> String {
        if ownAnswerCardID == item.id { return drafts[ownAnswerKey ?? item.key]?.text ?? "" }
        if let kept = parkedAnswers[item.id], !kept.isEmpty { return kept }
        return shownStagedNote(item.sourceId, item.draft) ?? ""
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
        openOwnAnswer(card)
        let typed = draft.text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.contains(note) { setText(typed.isEmpty ? note : typed + "\n" + note) }
        draftSavedAt[card.id] = nil
    }

    /// A card as the inbox list carries it, for the sends that take list items (Send now, Send again).
    nonisolated static func inboxItem(_ card: WidgetCard) -> WidgetInboxItem {
        // A set's recommendation keeps every letter ("abc"), which `isRecommended` and `recommendedSet` read.
        let recommendedSet = card.choices.filter(\.recommended).map(\.id).joined()
        let recommended = card.takesSeveral ? (recommendedSet.isEmpty ? nil : recommendedSet)
            : card.choices.first(where: \.recommended)?.id
        return WidgetInboxItem(id: card.id, sourceId: card.sourceId, kind: card.kind.rawValue, key: card.sessionKey, at: card.at,
                               needsAnswer: card.needsAnswer, title: card.title, number: card.number,
                               options: card.choices.map(\.title), recommended: recommended,
                               revision: card.revision, draftOption: card.draftOption, draft: card.draft,
                               multiple: card.multiple)
    }

    /// Stages `option` (nil: no pick) and `note` (nil: the note staged here, if any) for the decision `id` through the
    /// staging engine. `completed` gets the change's version once its write and every write of the decision before it
    /// landed; a refused or unanswered write drops it.
    func stage(
        id: String, sessionId: String, revision: Int, option: String?, note: String? = nil,
        item: WidgetInboxItem? = nil, completed: ((UUID) -> Void)? = nil
    ) {
        sendCloseRevision += 1
        keptStaged.remove(id)
        if let item { pendingStageItems[id] = item }
        // An option-only write keeps a locally pending note even if the earlier note write is refused.
        let stagedNote = note ?? decisions.pending[id]?.note
        // `completed` runs after `stage` returned, so it reads the version the engine gave this change.
        var version = UUID()
        version = decisions.stage(DecisionAddress(id: id, sessionId: sessionId, revision: revision),
                                  option: option ?? "", note: stagedNote,
                                  then: completed.map { completed in { completed(version) } })
        stageAgain[id] = { [weak self] in
            self?.stage(id: id, sessionId: sessionId, revision: revision, option: option, note: stagedNote, item: item,
                        completed: completed)
        }
    }

    /// The limit of one stage write. It writes one row of the decision log on this Mac and delivers nothing, so 30 s
    /// without an answer is a stalled Mac: of 624 widget calls in five days, 6 that answered took longer. At the limit
    /// the pick stays shown with Try again (`Pending.unsaved`); it waited 120 s and was dropped before.
    nonisolated static let stageWriteTimeoutSeconds = 30
    /// The engine's key of the leave question's held Discard: one at a time, so a second one writes the first.
    nonisolated static let heldDiscardKey = "widget.staged-discard"

    func makeDecisions() -> DecisionAnswering.Engine {
        let engine = DecisionAnswering.Engine(log: WidgetDecisionLog(model: self))
        engine.written = { [weak self] id, action, answer in self?.decisionWritten(id, action, answer) }
        engine.drained = { [weak self] _ in self?.runAfterDecisionWrites() }
        // Only the shown picks redraw the panel; a write starting or ending changes nothing on screen.
        decisionChanges = engine.$pending.dropFirst().sink { [weak self] _ in self?.objectWillChange.send() }
        return engine
    }

    /// A stage write the hub did not answer: no answer is not a refusal, so the pick and its note stay here with Try
    /// again. A click on 2026-11-10 was dropped after its write was killed at 120 s on a Mac at load 500, and the user
    /// learned it from an agent that waited.
    private func decisionWritten(_ id: String, _ action: DecisionLogAction, _ answer: DecisionLogAnswer) {
        guard case .stage = action, case .unanswered(let seconds) = answer, decisions.pending[id]?.unsaved == true,
              let again = stageAgain[id] else { return }
        PerfLog.mark("widget.staged write unanswered id=\(id) after \(seconds)s; the pick stays")
        postNote("The hub did not answer within \(seconds) seconds, so this pick is not saved yet. It stays here.",
                 action: WidgetNoticeAction(title: "Try again") { again() }, tone: .warning)
    }

    /// Runs `work` once no write of the staging engine runs or waits, at once when none does. The engine keeps each
    /// decision's writes until the one before has landed, so a send waits here for the picks staged before it, as it
    /// waited behind them in the queue of hub writes (a Send now right after a click sends that pick).
    func whenDecisionWritesEnd(_ work: @escaping () -> Void) {
        guard decisions.writing.isEmpty else {
            afterDecisionWrites.append(work)
            return
        }
        work()
    }

    /// `whenDecisionWritesEnd` for a caller that awaits it (the shutdown).
    func decisionWritesEnded() async {
        await withCheckedContinuation { continuation in whenDecisionWritesEnd { continuation.resume() } }
    }

    private func runAfterDecisionWrites() {
        guard decisions.writing.isEmpty, !afterDecisionWrites.isEmpty else { return }
        let ready = afterDecisionWrites
        afterDecisionWrites = []
        ready.forEach { $0() }
    }

    /// A staged decision as a write addresses it. A clear goes by id; the session is the one it is listed under.
    private func stagedAddress(_ id: String) -> DecisionAddress {
        let item = stagedRows.first { $0.sourceId == id } ?? pendingStageItems[id]
        return DecisionAddress(id: id, sessionId: item.flatMap { session(forKey: $0.key)?.target.sessionId } ?? "",
                               revision: item?.revision)
    }

    /// A later edit has its own staged intent; an older send must not send that edit instead.
    private func canSendStaged(_ id: String, version: UUID) -> Bool {
        guard decisions.version(id) == version else {
            postNote("This decision changed. Review it before sending.")
            return false
        }
        return true
    }

    /// The staged items as the snapshot shows them, and the picks staged here that it now shows (the engine's
    /// confirmation: shown, overtaken by a newer row, or expired). `listed`: every decision the snapshot lists, to say
    /// when a revision cleared a staged pick.
    func reconcileStaged(_ items: [WidgetInboxItem], listed: [WidgetInboxItem] = []) {
        let staged = items.filter(\.isStaged)
        noteClearedPicks(before: stagedRows, after: staged, listed: listed)
        if staged != stagedRows { stagedRows = staged }
        alertPopup.stagingChanged(staged)
        let rows = Dictionary(items.map {
            ($0.sourceId, DecisionAnswering.Engine.Row(option: $0.draftOption, note: $0.draft, updatedAt: $0.updatedAt))
        }, uniquingKeysWith: { first, _ in first })
        let before = decisions.pending
        decisions.reconcile(rows)
        for (id, entry) in before where decisions.pending[id] == nil && (rows[id]?.option ?? "") != (entry.option ?? "") {
            PerfLog.mark("widget.staged pending dropped id=\(id) unconfirmed")
        }
        pendingStageItems = pendingStageItems.filter { decisions.pending[$0.key] != nil }
        stageAgain = stageAgain.filter { decisions.pending[$0.key] != nil }
    }

    /// A staged pick the agent's new text cleared (a revision drops the staged pick, since it was made on the old
    /// text) is said once, so it is not lost without a word (decision audit F12).
    private func noteClearedPicks(before: [WidgetInboxItem], after: [WidgetInboxItem], listed: [WidgetInboxItem]) {
        let still = Set(after.map(\.sourceId))
        let revised = before.compactMap { old -> (WidgetInboxItem, WidgetInboxItem)? in
            guard !still.contains(old.sourceId), !sendingDecisionIDs.contains(old.sourceId),
                  decisions.pending[old.sourceId]?.option != "", let oldRevision = old.revision,
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
        // Words typed in the own answer field of a decision being sent go with its staged pick, as Return there sends
        // them. Send sent the ticked set alone, and the words left with the field when the card closed (2026-11-10: a
        // 957-character note on a decision that takes several options).
        if let card = ownAnswerCard, ids.contains(card.sourceId), !sendingDecisionIDs.contains(card.sourceId),
           sendOwnAnswerWithStage(card, thenClose: thenClose) {
            let rest = ids.filter { $0 != card.sourceId }
            if !rest.isEmpty { sendStaged(rest, thenClose: thenClose, known: known) }
            return
        }
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
        // A second press while the first send runs: that send's note answers it. It says so too: a Send now that
        // changed nothing read as a dead button (Martin, 2026-10-28: "the Send now in the quit dialog didnt send it").
        let fresh = chosen.filter { !sendingDecisionIDs.contains($0.sourceId) }
        guard fresh.count == chosen.count else {
            keptStaged.subtract(chosen.map(\.sourceId))
            PerfLog.mark("widget.send-staged already sending: \(chosen.count - fresh.count) of \(ids.count) ids")
            postNote("Still sending " + Plural.count(chosen.count - fresh.count, "decision")
                     + "… New stages remain staged; send again when it finishes.")
            return
        }
        deliverDecisions(fresh, action: .sendStaged, thenClose: thenClose)
    }

    /// Sends again answered decisions that no session took (the notice's Send again), for every kind of agent.
    public func resendAnswers(_ items: [WidgetInboxItem]) {
        guard !items.isEmpty else { return }
        postNote("Sending again…")
        deliverDecisions(items, action: .resendAnswers)
    }

    /// The delayed fold of a send on the way out of the panel, after the hub took the answer: it waits
    /// `sendCloseSeconds` (0 keeps the panel open) so the note is readable, and folds only the panel this send left
    /// from. One the user opened again, edited or switched meanwhile stays open.
    func foldPanelAfterSend(opened: TimeInterval, closeRevision: Int, draft draftAtSend: WidgetDraft) {
        let closeSeconds = preferences.sendCloseSeconds
        guard expanded != nil, openedAt == opened, sendCloseRevision == closeRevision, closeSeconds > 0 else { return }
        Task { [weak self] in
            do { try await Task.sleep(for: .seconds(closeSeconds)) } catch { return }
            guard let self, self.expanded != nil, self.openedAt == opened,
                  self.sendCloseRevision == closeRevision, self.draft == draftAtSend else { return }
            self.collapse()
        }
    }

    /// One message per session through the hub, then a note that says what really happened: delivered, waiting
    /// for the session's next prompt (with why, and Send again), or not sent at all (an error, with the hub's own
    /// words behind Details). When the panel was closed meanwhile, the sessions that took nothing flash on the rail.
    private func deliverDecisions(_ items: [WidgetInboxItem], action: DecisionAnswering.SendAction, thenClose: Bool = false) {
        let staged = action == .sendStaged
        let opened = openedAt
        // Sent from the popup on screen (its Send now, or the staged reminder's): the popup shows the result.
        let fromPeek = alertPopup.item.map { shown in
            items.contains { $0.sourceId == shown.sourceId } || shown.sourceId == WidgetAlerts.stagedReminderID
        } ?? false
        let closeRevision = sendCloseRevision
        let draftAtSend = draft
        let ids = Set(items.map(\.sourceId))
        sendingDecisionIDs.formUnion(ids)
        for id in ids { sendingStageVersions[id] = decisions.version(id) }
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
        whenDecisionWritesEnd { [weak self] in self?.afterMutations { [weak self] in
            guard let self else { return }
            defer {
                self.sendingDecisionIDs.subtract(ids)
                for id in ids { self.sendingStageVersions[id] = nil }
            }
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
                    self.applyAlertPopup(self.alertPopup.sendEnded(
                        WidgetPeekOutcome(text: text, tone: tone, sendAgain: waiting, detail: outcome.details),
                        sent: ids, delivered: outcome.delivered))
                } else if outcome.failed == 0 {
                    self.applyAlertPopup(self.alertPopup.sent(ids))
                }
                if outcome.delivered {
                    postNote(text, tone: .success)
                    // Only the panel this send left from: one the user opened again meanwhile stays open. It folds
                    // after the note was readable: closing at once hid "delivered" and read as "Send did nothing"
                    // (Martin, 2026-10-25).
                    if thenClose {
                        foldPanelAfterSend(opened: opened, closeRevision: closeRevision, draft: draftAtSend)
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
                    self.applyAlertPopup(self.alertPopup.sendEnded(WidgetPeekOutcome(text: staged
                        ? "Not sent: the hub refused it. It stays staged." : "Not sent again: the hub refused it.",
                        tone: .warning, detail: error.localizedDescription), sent: ids, delivered: false))
                }
                fail(staged ? "The decisions could not be sent. They stay staged, so you can send them again."
                         : "The answers could not be sent again. They still wait for the session's next prompt.",
                     detail: error.localizedDescription)
                if staged { keptStaged.subtract(items.map(\.sourceId)) }
                flashUnsent(items)
            }
        } }
    }

    /// A send result that arrives after the panel closed: the sessions it concerns flash on the rail (the alert flash
    /// setting), so the note waiting in the panel is noticed.
    private func flashUnsent(_ items: [WidgetInboxItem]) {
        guard expanded == nil else { return }
        let seconds = WidgetAlerts.flashSeconds(preferences)
        for key in Set(items.map(\.key)) { flashAttention(key, seconds: seconds) }
    }

    /// Discards the picks and notes of the staged decisions `ids`; they still wait for an answer. Each shows as
    /// cleared until a snapshot does; a refused clear shows the stored pick again.
    public func discardStaged(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        sendCloseRevision += 1
        keptStaged.subtract(ids)
        decisions.unstage(ids.map(stagedAddress))
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
        switch preferences.stagedOnLeave {
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
    /// before Esc was only pending here, and the panel closed without asking (decision audit F16).
    /// A decision whose send runs is on its way, not staged, unless it was staged again after the send took its pick:
    /// on 2026-11-04 two sends waited 100 s for a slow hub, the leave question called them staged, and their Send now
    /// read as a button that only staged.
    public var stagedForLeave: [WidgetInboxItem] {
        stagedOrPending.filter { item in
            !sendingDecisionIDs.contains(item.sourceId)
                || decisions.version(item.sourceId).map { $0 != sendingStageVersions[item.sourceId] } ?? false
        }
    }

    private var stagedOrPending: [WidgetInboxItem] {
        let listed = Set(stagedItems.map(\.sourceId))
        let pending = decisions.pending.compactMap { id, entry -> WidgetInboxItem? in
            let option = entry.option ?? ""
            guard (!option.isEmpty || entry.note?.isEmpty == false), !listed.contains(id),
                  !heldDecisionIDs.contains(id), var item = pendingStageItems[id] else { return nil }
            item.draftOption = option.isEmpty ? nil : option
            if let note = entry.note { item.draft = note }
            return item
        }
        let listedItems = stagedItems.compactMap { item -> WidgetInboxItem? in
            let entry = decisions.pending[item.sourceId]
            guard entry?.option != "" || entry?.note?.isEmpty == false else { return nil }
            var fresh = item
            if let note = entry?.note { fresh.draft = note }
            return fresh
        }
        return listedItems + pending.sorted { $0.at < $1.at }
    }

    /// The answer to the leave question: "send", "keep", "discard" or "stay". Keep and Discard close the panel at once;
    /// Send closes it once the hub says every answer was delivered, and leaves it open with the reason otherwise. Stay
    /// (a click beside the box, Dismiss, its close button) only ends the question: the panel stays as it was.
    public func resolveStagedLeave(_ choice: String) {
        let items = stagedForLeave
        PerfLog.mark("widget.staged-leave \(choice): \(items.count) staged")
        guard choice != "stay" else {
            stagedLeavePrompt = false
            return
        }
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

    /// Discards the staged decisions `ids` after the Undo window (`undoSeconds`): the engine holds the clear, until then
    /// they leave every send (`heldDecisionIDs`) and `undoHeldDiscard` keeps them staged. A second hold sends the first
    /// one's discard now. Once the log answered the clear, the decisions show the snapshot's state again.
    public func holdDiscard(_ ids: [String]) {
        guard !ids.isEmpty else { return }
        commitHeldDiscard()
        heldDecisionIDs.formUnion(ids)
        PerfLog.mark("widget.staged discard held \(ids.count)")
        postNote(Plural.count(ids.count, "staged decision") + " discarded.",
                 action: WidgetNoticeAction(title: "Undo") { [weak self] in self?.undoHeldDiscard() })
        decisions.hold(Self.heldDiscardKey, .unstage(ids.map(stagedAddress)), seconds: undoSeconds,
                       ended: { [weak self] _ in
                           guard let self else { return }
                           self.sendCloseRevision += 1
                           self.keptStaged.subtract(ids)
                           self.heldDecisionIDs.subtract(ids)
                       })
    }

    /// Undo of a held Discard: the decisions stay staged as they were; nothing reached the decision log.
    public func undoHeldDiscard() {
        let ids = heldDiscard
        guard !ids.isEmpty else { return }
        decisions.undo(Self.heldDiscardKey)
        heldDecisionIDs.subtract(ids)
        PerfLog.mark("widget.staged discard undone \(ids.count)")
        postNote(Plural.count(ids.count, "decision") + " kept staged.")
    }

    /// Sends a held Discard to the decision log now (another discard came, or the widget stops); the end of its
    /// window sends it by itself.
    func commitHeldDiscard() {
        decisions.commit(Self.heldDiscardKey)
    }
}

/// How long an Undo row holds a removed item back (Remove from shelf, Discard of a voice note): as long as a note with
/// a button stays (`noteSeconds`, at least 10 s), so every Undo in the widget lasts the same. With notes set to stay
/// until closed (`noteSeconds` 0), the row stays until it is closed, but 60 s at most, since the delete must happen.
public extension WidgetModel {
    nonisolated static func undoSeconds(_ preferences: WidgetPreferences) -> Double {
        noteSeconds(preferences, hasAction: true) ?? 60
    }

    /// `undoSeconds` for the current preferences; the coordinator hands this to the shelf and voice-notes stores.
    var undoSeconds: Double { Self.undoSeconds(preferences) }
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
