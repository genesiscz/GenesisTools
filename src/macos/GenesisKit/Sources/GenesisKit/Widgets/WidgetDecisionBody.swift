import SwiftUI

/// Where an open decision is drawn. Its values are the whole list of differences between the surfaces: the options
/// shown, the summary switch, the sections, the picture size, each list's spacing and scroll ids, and where Send and
/// Unstage sit. The own answer and the footer are the caller's slots.
enum WidgetDecisionSurface: Equatable {
    /// The alert popup (`WidgetPeekView`).
    case alert
    /// An open entry of the inbox of every session (`compact` false) or of the hover list's Items tab (true).
    case feed(compact: Bool)
    /// A session's inbox: the open card (`LiveWidgetView.cardDetail`).
    case session
    /// The staged review list (`WidgetStagedDecisionRow`).
    case staged

    /// The options the alert lists; the rest wait in the session's inbox.
    static let alertOptions = 4

    /// The options a click answers here; the rest wait behind "N more in its session".
    var optionLimit: Int? { self == .alert ? Self.alertOptions : nil }

    /// The gap between the body's blocks: each list's own rhythm.
    var spacing: CGFloat {
        switch self {
        case .alert, .staged: 8
        case .feed, .session: 10
        }
    }

    /// The gap between the options, and between them and the answer and the staged row under them.
    var optionSpacing: CGFloat {
        switch self {
        case .alert: 5
        case .feed, .staged: 6
        case .session: 10
        }
    }

    /// The card's pictures, as large as the list's density allows. The alert and the staged list show text only.
    var images: WidgetDecisionImages? {
        switch self {
        case .alert, .staged: nil
        case let .feed(compact):
            compact ? WidgetDecisionImages(height: 64, maxWidth: 64 * 2.4) : WidgetDecisionImages(height: 96, maxWidth: 96 * 2.4)
        case .session: WidgetDecisionImages(height: 110, maxWidth: 260)
        }
    }

    /// Where Send, Unstage and Send now (all N) sit: on their own line under a list row's options (the rows are 260 to
    /// 560 pt wide), or in the card's and the alert's footer.
    var placement: WidgetStagedActions.Placement {
        switch self {
        case .alert, .session: .footer
        case .feed, .staged: .row
        }
    }

    /// The card whose context, code, notes, pick and pictures this surface draws: a session's always; the feed's while
    /// the reader shows context in that list (`overviewSummary`); the alert's and the staged list's never.
    func sectionsCard(_ value: WidgetDecisionValue, preferences: WidgetPreferences) -> WidgetCard? {
        switch self {
        case .session: value.card
        case .feed: preferences.overviewSummary ? value.card : nil
        case .alert, .staged: nil
        }
    }

    /// This surface's Send, Unstage and Send now (all N), with its identifiers and its words for Unstage. The host
    /// decides what each does (an item's Unstage holds an Undo, a card's gives the note back to its field).
    @MainActor func stagedActions(_ value: WidgetDecisionValue, host: any DecisionStagingHost) -> WidgetStagedActions {
        let id = value.item.sourceId
        let several = value.item.takesSeveral
        switch self {
        case .alert:
            // A second click on the option unstages here, so the alert has no Unstage of its own.
            return WidgetStagedActions(host: host, placement: .footer, identifier: "widget.peek.send." + id, unstages: false)
        case .feed:
            return WidgetStagedActions(
                host: host, placement: .row,
                identifier: (several ? "widget.overview.sendSet." : "widget.overview.sendStaged.") + id,
                sendAllIdentifier: "widget.overview.sendAll." + id, unstageIdentifier: "widget.overview.unstage." + id,
                unstageTooltip: "Clears the staged pick and note. Undo brings them back.")
        case .session:
            return WidgetStagedActions(
                host: host, placement: .footer, identifier: "widget.card.send." + id,
                sendAllIdentifier: "widget.card.sendAll." + id,
                unstageTooltip: value.item.draft == nil ? "Clears the staged pick."
                    : "Clears the staged pick and puts the note back into the answer field.")
        case .staged:
            return WidgetStagedActions(
                host: host, placement: .row,
                identifier: (several ? "widget.staged.sendSet." : "widget.staged.sendStaged.") + id,
                unstageIdentifier: "widget.staged.unstage." + id,
                unstageTooltip: "Clears the staged pick and note. Undo brings them back.")
        }
    }
}

/// One open decision as a body draws it: its inbox item, which every surface has; its card, in a session's inbox or
/// when that session's cards are cached here (`WidgetModel.card(for:)`); and its options in their order.
struct WidgetDecisionValue {
    struct Choice {
        let index: Int
        let letter: String
        /// The option's words as the inbox item carries them.
        let option: String
        /// The card's choice, with its rationale and its key, in a session's inbox.
        let card: WidgetChoice?
    }

    let item: WidgetInboxItem
    let card: WidgetCard?
    let choices: [Choice]

    /// A session card: its choices, each with its rationale.
    init(card: WidgetCard) {
        item = WidgetModel.inboxItem(card)
        self.card = card
        choices = card.choices.enumerated().map { Choice(index: $0, letter: $1.id, option: $1.title, card: $1) }
    }

    /// An inbox item: its options, and its card when one is cached, for the card's sections.
    init(item: WidgetInboxItem, card: WidgetCard?) {
        self.item = item
        self.card = card
        choices = (item.options ?? []).enumerated().map {
            Choice(index: $0, letter: WidgetOptionText.letter($0), option: $1, card: nil)
        }
    }

    /// An open decision or dialog that waits for its answer: a click on an option answers it.
    var answerable: Bool { Self.answerable(item) }

    static func answerable(_ item: WidgetInboxItem) -> Bool {
        ["decision", "dialog"].contains(item.kind) && item.needsAnswer
    }
}

/// One open decision on any surface, in this order: the summary (by the surface's switch), the card's sections, the
/// options with the agent's pick under its option, the recommended set, the own answer, the staged actions and the
/// footer. `WidgetDecisionSurface` holds every way the surfaces differ; what stays around a decision (receipts, the
/// header, the outcome, the answered line, the footer of a list entry) stays with its surface.
struct WidgetDecisionBody<OwnAnswer: View, Footer: View>: View {
    // lint-rules-ignore: one open decision, observes on purpose
    @ObservedObject var model: WidgetModel
    let value: WidgetDecisionValue
    let surface: WidgetDecisionSurface
    let host: any DecisionStagingHost
    /// The option the list's keys stand on (the overview's arrows), nil elsewhere.
    let focusedOption: String?
    /// Runs after a click on an option has staged or sent the pick (the alert's "After a send").
    let chosen: () -> Void
    let ownAnswer: OwnAnswer
    let footer: Footer

    init(model: WidgetModel, value: WidgetDecisionValue, surface: WidgetDecisionSurface, host: any DecisionStagingHost,
         focusedOption: String? = nil, chosen: @escaping () -> Void = {},
         @ViewBuilder ownAnswer: () -> OwnAnswer, @ViewBuilder footer: () -> Footer) {
        _model = ObservedObject(wrappedValue: model)
        self.value = value
        self.surface = surface
        self.host = host
        self.focusedOption = focusedOption
        self.chosen = chosen
        self.ownAnswer = ownAnswer()
        self.footer = footer()
    }

    var body: some View {
        let preferences = model.preferences
        let sections = surface.sectionsCard(value, preferences: preferences)
        // The agent's pick sits under the option it recommends, else above the options (Decision cards → The agent's
        // pick).
        let pickUnder = sections.flatMap { WidgetProposal.placement($0, preferences: preferences) }
        VStack(alignment: .leading, spacing: surface.spacing) {
            summary
            if let sections {
                WidgetDecisionSections(card: sections, preferences: preferences, proposalAbove: pickUnder == nil,
                                       images: surface.images, showMedia: { model.showMedia?($0) })
            }
            VStack(alignment: .leading, spacing: surface.optionSpacing) {
                if value.answerable { options(pickUnder: pickUnder) }
                if surface == .session { recommendedPick }
                ownAnswer
                if surface == .session { stagedNote }
                // Send and Unstage of a staged pick or note, beside the options they send.
                if surface.placement == .row { surface.stagedActions(value, host: host).padding(.top, 2) }
            }
            if surface == .session {
                // Send now is the card's one primary action while a pick or a note waits, at the footer's start; the
                // footer's own buttons follow. Every staged decision at once, this one included, from the card being
                // read (Martin, 2026-10-28), while another one is staged too.
                HStack(spacing: 8) {
                    surface.stagedActions(value, host: host)
                    footer
                }
                .buttonStyle(.genHover()).font(.caption)
            } else {
                footer
            }
        }
    }

    /// A set the agent recommends, ticked in one click while it is not the ticked set already. The list rows draw it in
    /// their staged row instead.
    @ViewBuilder private var recommendedPick: some View {
        let stage = host.stage
        if value.answerable, stage.takesSeveral, let recommended = stage.recommendedSet, recommended != stage.letters {
            WidgetRecommendedPickButton(letters: recommended) { host.pickSet(recommended) }
                .disabled(model.cardPending || stage.busy)
                .padding(.leading, 4)
        }
    }

    /// "Note staged: …" under the own answer, beside the buttons that act on it: at the top of the card it pushed the
    /// options and the buttons down under the pointer.
    @ViewBuilder private var stagedNote: some View {
        if let card = value.card {
            let note = model.shownStagedNote(card.sourceId, card.draft)
            if let saved = model.draftSavedAt[card.id] ?? (note != nil ? Date(timeIntervalSince1970: card.at / 1000) : nil),
               card.kind == "decision", card.needsAnswer, !model.heldDecisionIDs.contains(card.sourceId) {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(SessionPalette.blue)
                    // "Staged", as the option badge and the hub say: a note that waits to be sent with the others.
                    Text(note.map { "Note staged: " + $0 } ?? "Note staged").lineLimit(2)
                    if model.draftSavedAt[card.id] != nil {
                        Text("·")
                        LiveAgo(date: saved, style: .brief)
                    }
                }.font(.system(size: 11)).foregroundStyle(SessionPalette.secondary)
            }
        }
    }

    /// The text above the options: the alert's and the feed's summary behind their switches (the feed's is the cached
    /// card's whole text when it has one), a card's body in a session's inbox, the card's text in the staged list.
    @ViewBuilder private var summary: some View {
        let item = value.item
        switch surface {
        case .alert:
            // The context the agent wrote under the title, so a pick here is not made blind (Martin, 2026-10-28: "in
            // this window you should probably have the description").
            if model.preferences.alertSummary, item.needsAnswer, let summary = item.summary, !summary.isEmpty {
                WidgetPeekSummary(summary: summary).equatable()
            }
        case .feed:
            if model.preferences.overviewSummary, item.needsAnswer,
               let text = [value.card?.body, item.summary].compactMap({ $0 }).first(where: { !$0.isEmpty }) {
                WidgetPeekSummary(summary: text, identifier: "widget.overview.summary").equatable()
            }
        case .session:
            if let body = value.card?.body, !body.isEmpty {
                WidgetMarkdown(text: body)
            }
        case .staged:
            if let text = value.card?.fullText, !text.isEmpty {
                WidgetMarkdown(text: text)
            }
        }
    }

    /// The options, at most the surface's limit, each with the agent's pick under it when it recommends that one.
    @ViewBuilder private func options(pickUnder: (letter: String, text: String)?) -> some View {
        let shown = surface.optionLimit.map { Array(value.choices.prefix($0)) } ?? value.choices
        ForEach(shown, id: \.letter) { choice in
            optionButton(choice)
            if let pickUnder, pickUnder.letter == choice.letter {
                // Under the option's text: the label's padding, its badge and the gap after it.
                WidgetProposalLine(text: pickUnder.text)
                    .padding(.leading, DecisionOptionMetrics.textInset(multiple: value.item.takesSeveral))
                    .padding(.trailing, 8)
            }
        }
        if let limit = surface.optionLimit, value.choices.count > limit {
            // A count opens what it counts (UX audit P5): the decision in its session, with every option.
            WidgetMoreButton(title: "\(value.choices.count - limit) more in its session",
                             tooltip: "Opens the decision in its session with all its options") { host.open() }
        }
    }

    /// One option: a session card's with its key badge, rationale, focus and scroll id; an inbox item's elsewhere,
    /// with the list's scroll id in the feed.
    @ViewBuilder private func optionButton(_ choice: WidgetDecisionValue.Choice) -> some View {
        let item = value.item
        if surface == .session, let card = value.card, let cardChoice = choice.card {
            let picked = model.shownStagedOption(card.sourceId, stored: card.draftOption)?.contains(cardChoice.id) ?? false
            WidgetOptionButton(model: model, card: card, choice: cardChoice, index: choice.index,
                               key: LiveWidgetView.choiceKey(choice.index), picked: picked,
                               focused: model.choiceFocus == WidgetChoiceFocus(cardID: card.id, choiceID: cardChoice.id))
                .id("choice-" + card.id + "-" + cardChoice.id)
        } else if case .feed = surface {
            WidgetOptionButton(model: model, item: item, index: choice.index, option: choice.option,
                               focused: focusedOption == choice.letter, chosen: chosen)
                .id(item.id + "#" + choice.letter)
        } else {
            WidgetOptionButton(model: model, item: item, index: choice.index, option: choice.option, chosen: chosen)
        }
    }
}

/// A card's Context, Code, notes and the agent's pick (above the options when it does not sit under one), then its
/// pictures: what a session's inbox draws under a card's text, and the inbox of every session for a cached card.
struct WidgetDecisionSections: View {
    let card: WidgetCard
    let preferences: WidgetPreferences
    /// The agent's pick goes above the options, because it does not sit under one of them.
    let proposalAbove: Bool
    /// The pictures' size; nil shows none.
    let images: WidgetDecisionImages?
    let showMedia: (WidgetMediaSelection) -> Void

    var body: some View {
        // The hub Inbox card's context: Context, Code, the notes, the pick (WidgetDecisionDetailsView).
        if let details = card.decision {
            WidgetDecisionDetailsView(card: card, details: details, preferences: preferences,
                                      proposal: proposalAbove ? details.proposal : nil)
        }
        if let images, !card.attachments.isEmpty {
            WidgetCardAttachments(card: card, height: images.height, maxWidth: images.maxWidth, compare: true,
                                  showMedia: showMedia)
        }
    }
}

/// The size of a card's pictures on one surface.
struct WidgetDecisionImages {
    let height: CGFloat
    let maxWidth: CGFloat
}

/// A decision's own answer on a surface that does not type in place (the alert, the inbox of every session, the
/// hover list): one compact line with what the decision's own answer holds, and a click that opens the decision in
/// its session with the full field holding the keyboard.
struct WidgetCompactOwnAnswer: View {
    let text: String
    let identifier: String
    let open: () -> Void

    var body: some View {
        WidgetAnswerField<EmptyView, EmptyView>.compact(
            placeholder: "Write my own answer…", shownText: text,
            tooltip: "Opens it in its session with the answer field ready to type", identifier: identifier, activate: open)
            .padding(.top, 1)
    }
}

/// "2 more in its session": a quiet link-like button, since a count opens what it counts.
struct WidgetMoreButton: View {
    let title: String
    let tooltip: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Text(title)
                Image(systemName: "chevron.right").font(.system(size: 8.5, weight: .semibold))
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
        }
        .buttonStyle(.genHover())
        .padding(.leading, 2)
        .instantTooltip(tooltip)
    }
}
