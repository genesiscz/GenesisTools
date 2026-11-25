import AppKit
import Combine
import Observation
import SwiftUI
import UniformTypeIdentifiers

/// The hub Inbox card's stage and actions of one decision, for the kit's shared staged block. The stage comes from the
/// card's `InboxCardState` values, never from a model, so the card stays equal on its values and observes neither
/// model. Unstage keeps the note in the card's field, unstaged; the card's own closures say what its field holds.
@MainActor
struct HubInboxDecisionHost: DecisionStagingHost {
    let inbox: HubInboxModel
    let session: InboxSession
    let item: InboxItem
    let state: InboxCardState
    /// The card's note when it changed since it was saved, else nil, so an action never writes back a stale copy over a
    /// note staged in the widget or the session's sidebar.
    let note: () -> String?
    /// The note field's text, which Unstage leaves there.
    let field: () -> String
    let afterUnstage: () -> Void
    let openTranscript: () -> Void

    init(inbox: HubInboxModel, session: InboxSession, item: InboxItem, state: InboxCardState,
         note: @escaping () -> String?, field: @escaping () -> String = { "" },
         afterUnstage: @escaping () -> Void = {}, openTranscript: @escaping () -> Void = {}) {
        self.inbox = inbox
        self.session = session
        self.item = item
        self.state = state
        self.note = note
        self.field = field
        self.afterUnstage = afterUnstage
        self.openTranscript = openTranscript
    }

    var stage: DecisionStageValue {
        let letters = state.letters
        // A pick or a note is staged and not sent, on a decision this card can still answer.
        let staged = item.isOpen && session.sessionId != nil && !state.heldDismiss
            && (!letters.isEmpty || !(item.draft ?? "").trimmed.isEmpty)
        return DecisionStageValue(
            letters: letters.isEmpty ? nil : letters, takesSeveral: item.takesSeveral,
            recommendedSet: item.takesSeveral
                ? DecisionAnswering.recommendedSet(item.recommended, count: item.choices?.count ?? 0) : nil,
            phase: state.sessionSending ? .sending : .staged(since: nil, unsent: nil), staged: staged,
            busy: state.sessionSending || state.writing,
            // The session header's Send all staged sends them all; the card does not repeat it.
            othersStaged: 0)
    }

    func choose(_ letter: String) {
        let flags = NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags
        inbox.choose(item, in: session, letter: letter, note: note(), shift: flags.contains(.shift),
                     command: flags.contains(.command))
    }

    func pickSet(_ letters: String) { inbox.pickSet(item, in: session, option: letters, note: note()) }
    func send() { inbox.sendNow(item, in: session, note: note()) }
    func sendAll() { inbox.sendAllStaged() }

    func unstage() {
        inbox.unstage(item, in: session, keeping: field())
        afterUnstage()
    }

    func dismiss() { inbox.dismiss(item, in: session) }
    func undoDismiss() { inbox.undoDismiss(item) }
    func open() { openTranscript() }
}
