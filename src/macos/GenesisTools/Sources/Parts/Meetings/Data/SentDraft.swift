/// What a form sent to a write that answers later (a label, a context note, a dictionary entry). The form stays
/// editable meanwhile, so its answer clears the form only while the form still shows what it sent: a draft typed after
/// the send survives the answer. A form edited since forgets the send, so no later answer clears it.
struct SentDraft<Draft: Equatable>: Equatable {
    private(set) var sent: Draft?

    mutating func send(_ draft: Draft) { sent = draft }

    mutating func reset() { sent = nil }

    /// True once (then the send is forgotten) when `saved` holds the sent draft and `form` still shows it. A form that
    /// changed forgets the send; an answer that does not hold the draft yet keeps it waiting.
    mutating func clears(form: Draft, saved: (Draft) -> Bool) -> Bool {
        guard let sent else { return false }
        guard form == sent else {
            self.sent = nil
            return false
        }
        guard saved(sent) else { return false }
        self.sent = nil
        return true
    }
}
