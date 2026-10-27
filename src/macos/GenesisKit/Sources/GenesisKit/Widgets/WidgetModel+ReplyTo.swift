import Foundation

/// What a follow-up from the reply composer names as the item it answers ("Reply to: <title>"), so the agent need not
/// guess. An agent once got "its ok already set up as plugin" with nothing more and answered that it could not tell
/// which question it answered (2026-10-27).
extension WidgetModel {
    /// "Replies name what they answer" (`replyNames`): "selected-or-newest" (default), "selected" or "never".
    public var replyNames: String { snapshot?.state.preferences.replyNames ?? "selected-or-newest" }

    /// The card a reply would name before the composer's ×: the card the user selected and left open, else (by
    /// default) the session's newest item from the agent. A folded or held (being dismissed) card is not looked at.
    public var replyToCandidate: WidgetCard? {
        let mode = replyNames
        guard mode != "never" else { return nil }
        let shown = cards.filter { !heldCardIDs.contains($0.id) }
        if let id = selectedCardID, !foldedCardIDs.contains(id), let card = shown.first(where: { $0.id == id }) {
            return card
        }
        guard mode == "selected-or-newest" else { return nil }
        return shown.max { $0.at < $1.at }
    }

    /// The card the next follow-up names: `replyToCandidate`, unless the composer's × dropped it for this message.
    public var replyToCard: WidgetCard? {
        guard let card = replyToCandidate, replyToDropped[selectedKey] != card.id else { return nil }
        return card
    }

    /// The composer's ×: the next follow-up names nothing; with `false` it names the card again.
    public func dropReplyTo(_ dropped: Bool = true) {
        guard let card = replyToCandidate else { return }
        replyToDropped[selectedKey] = dropped ? card.id : nil
    }
}
