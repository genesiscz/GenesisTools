import SwiftUI

/// The stage of one decision on one surface, as values: what is picked, where its send is, and whether others wait.
public struct DecisionStageValue: Equatable, Sendable {
    public var letters: String?
    public var takesSeveral: Bool
    public var recommendedSet: String?
    public var phase: WidgetStagePhase
    public var staged: Bool
    public var busy: Bool
    public var othersStaged: Int

    public init(letters: String?, takesSeveral: Bool, recommendedSet: String?, phase: WidgetStagePhase, staged: Bool,
                busy: Bool, othersStaged: Int) {
        self.letters = letters
        self.takesSeveral = takesSeveral
        self.recommendedSet = recommendedSet
        self.phase = phase
        self.staged = staged
        self.busy = busy
        self.othersStaged = othersStaged
    }
}

/// The stage and the actions of ONE decision on one surface. The widget has a host for an inbox item and one for a
/// session card, the hub one for its Inbox card: each unstages its own way (an item with Undo, a card back into its
/// field, the hub keeping the note), so the shared staged block never decides it.
@MainActor public protocol DecisionStagingHost {
    var stage: DecisionStageValue { get }
    func choose(_ letter: String)
    func pickSet(_ letters: String)
    func send()
    func sendAll()
    func unstage()
    func dismiss()
    func undoDismiss()
    func open()
}

/// A session card's decision: Unstage puts a staged note back into the card's own answer field (`unstage(card)`).
struct WidgetCardStagingHost: DecisionStagingHost {
    let model: WidgetModel
    let card: WidgetCard
    private let renderedBatch: [WidgetInboxItem]

    init(model: WidgetModel, card: WidgetCard) {
        self.model = model
        self.card = card
        renderedBatch = [WidgetModel.inboxItem(card)] + model.stagedForLeave.filter { $0.sourceId != card.sourceId }
    }

    var stage: DecisionStageValue {
        let staged = card.kind == "decision" && card.needsAnswer
            && model.shownStaged(card.sourceId, option: card.draftOption, draft: card.draft)
        return DecisionStageValue(
            letters: model.shownStagedOption(card.sourceId, stored: card.draftOption), takesSeveral: card.takesSeveral,
            recommendedSet: card.takesSeveral ? DecisionAnswering.recommendedSet(
                card.choices.filter(\.recommended).map(\.id).joined(), count: card.choices.count) : nil,
            phase: model.stagePhase(card.sourceId, draftedAt: card.draftedAt), staged: staged,
            busy: model.sendingDecisionIDs.contains(card.sourceId), othersStaged: staged ? renderedBatch.count - 1 : 0)
    }

    func choose(_ letter: String) { model.choose(card, option: letter) }
    func pickSet(_ letters: String) { model.pickSet(card, option: letters) }
    func send() { model.sendStaged([card.sourceId], known: [WidgetModel.inboxItem(card)]) }
    func sendAll() {
        model.sendStaged(renderedBatch.map(\.sourceId), known: renderedBatch)
    }
    func unstage() { model.unstage(card) }
    /// Writes the dismissal at once. The session card's own Dismiss holds it for its Undo note
    /// (`LiveWidgetView.holdMove`), and no other surface calls this one.
    func dismiss() { model.ledger(card, state: "dismissed") }
    func undoDismiss() { model.ledger(card, state: "open") }
    func open() { model.openCard(card) }
}

/// An inbox item's decision (the hover list, the overview, the staged review list, the alert): Unstage holds the
/// discard with an Undo note (`holdDiscard`). `sendsAll`: the surface offers Send now (all N), as the hover list does.
struct WidgetItemStagingHost: DecisionStagingHost {
    let model: WidgetModel
    let item: WidgetInboxItem
    let surface: WidgetSurfaceID?
    let sendsAll: Bool
    private let renderedBatch: [WidgetInboxItem]
    /// What the surface does after its send (the alert leaves for the session when its setting says so).
    var afterSend: (() -> Void)?
    /// The surface's own Open, in place of opening the item in its session (the alert's, which flashes the card).
    var opens: (() -> Void)?

    init(model: WidgetModel, item: WidgetInboxItem, surface: WidgetSurfaceID?, sendsAll: Bool,
         afterSend: (() -> Void)? = nil, opens: (() -> Void)? = nil) {
        self.model = model
        self.item = item
        self.surface = surface
        self.sendsAll = sendsAll
        renderedBatch = [item] + model.stagedForLeave.filter { $0.sourceId != item.sourceId }
        self.afterSend = afterSend
        self.opens = opens
    }

    var stage: DecisionStageValue {
        let staged = item.kind == "decision" && item.needsAnswer
            && model.shownStaged(item.sourceId, option: item.draftOption, draft: item.draft)
        return DecisionStageValue(
            letters: model.shownStagedOption(item.sourceId, stored: item.draftOption), takesSeveral: item.takesSeveral,
            recommendedSet: item.takesSeveral
                ? DecisionAnswering.recommendedSet(item.recommended, count: item.options?.count ?? 0) : nil,
            phase: model.stagePhase(item.sourceId, draftedAt: item.draftedAt), staged: staged,
            busy: model.sendingDecisionIDs.contains(item.sourceId), othersStaged: sendsAll && staged ? renderedBatch.count - 1 : 0)
    }

    func choose(_ letter: String) { model.choose(item, option: letter) }
    func pickSet(_ letters: String) { model.pickSet(item, option: letters) }
    func send() {
        model.sendStaged([item.sourceId], known: [item])
        afterSend?()
    }
    func sendAll() {
        model.sendStaged(renderedBatch.map(\.sourceId), known: renderedBatch)
    }
    func unstage() { model.holdDiscard([item.sourceId]) }
    /// Writes the dismissal of the item's card at once, when the session's cards are cached; no surface calls it yet.
    func dismiss() { model.card(for: item).map { model.ledger($0, state: "dismissed") } }
    func undoDismiss() { model.card(for: item).map { model.ledger($0, state: "open") } }
    func open() {
        if let opens { opens() } else { model.openInboxItem(item, on: surface) }
    }
}
