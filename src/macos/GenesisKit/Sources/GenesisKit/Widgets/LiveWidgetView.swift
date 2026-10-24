import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

enum WidgetOutgoingControls {
    static func canCancel(_ state: String) -> Bool {
        ["preparing", "review", "queued", "failed", "waiting-route"].contains(state)
    }
}

private struct WidgetOutgoingPosition: Equatable {
    let session: String
    let messageID: String?
}

public struct LiveWidgetView: View {
    @ObservedObject var model: WidgetModel
    let edge: EdgePanelPlacement
    let cutout: CGFloat
    let compactHeight: CGFloat
    let embedded: Bool
    private var section: String {
        get { model.section }
        nonmutating set { model.section = newValue }
    }

    @State private var retry: WidgetOutgoing?
    @State private var choosingSession = false
    @State private var sourcesExpanded = false
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    /// An unknown delivery the user checked in the conversation and wants to drop, so later follow-ups can go.
    @State private var discard: WidgetOutgoing?
    @FocusState private var editing: Bool
    /// Heights for fitting the panel to its content (W3). A plain reference, so measuring never re-renders.
    @State private var fit = WidgetContentFit()
    /// The composer field's height, so its stand-in takes exactly its place while the panel moves.
    @State private var composerFieldHeight: CGFloat = 0
    @Environment(\.edgePanelMoving) private var panelMoving
    /// Dismiss and Mark complete wait out their Undo note before they reach the decision log.
    @ObservedObject private var ledgerUndo = WidgetLedgerUndo.shared
    /// The Conversation tab's merged list, rebuilt only when its inputs change.
    @State private var timelineCache = TimelineCache()

    public init(
        model: WidgetModel, edge: EdgePanelPlacement, cutout: CGFloat = 0, compactHeight: CGFloat = 36,
        embedded: Bool = false
    ) {
        self.model = model
        self.edge = edge
        self.cutout = cutout
        self.compactHeight = compactHeight
        self.embedded = embedded
    }

    private var items: [AgentWidgetItem] {
        model.sessions.map { session in
            AgentWidgetItem(
                id: session.key, provider: session.target.provider, project: session.project,
                title: session.title, request: "", context: "", question: "", status: session.visualStatus)
        }
    }

    public var body: some View {
        let _ = RenderProbe.hit("widget.live")
        Group {
            if embedded {
                content
            } else {
                legacySurface
            }
        }
        .alert(
            "Check the conversation before retrying",
            isPresented: Binding(get: { retry != nil }, set: { if !$0 { retry = nil } })
        ) {
            Button("Cancel", role: .cancel) { retry = nil }
            Button("I checked — retry") {
                if let retry {
                    model.action(["action": "retry", "id": .string(retry.id), "confirmedUnknown": true])
                }
                retry = nil
            }
        } message: {
            Text("The previous transport did not return a receipt. Retrying may send a second copy.")
        }
        .alert(
            "Discard this message?",
            isPresented: Binding(get: { discard != nil }, set: { if !$0 { discard = nil } })
        ) {
            Button("Keep it", role: .cancel) { discard = nil }
            Button("I checked — discard", role: .destructive) {
                if let discard {
                    model.action(["action": "cancel", "id": .string(discard.id), "confirmedUnknown": true])
                }
                discard = nil
            }
        } message: {
            Text("Its delivery is unknown. Discard it only when the conversation shows it arrived, or you no longer want it sent. Later messages to this conversation then go out.")
        }
    }

    private var legacySurface: some View {
        AgentWidgetView(
            placement: edge, items: items, selectedID: model.selectedKey,
            expanded: model.expanded == edge,
            animationsActive: model.placement == "both" || (model.placement == "top" ? edge == .top : edge != .top),
            cutoutWidth: cutout, compactHeight: compactHeight,
            draft: Binding(get: { model.draft.text }, set: model.setText),
            actions: AgentWidgetActions(
                expand: { model.open(edge) }, collapse: model.collapse,
                select: { model.select($0, edge: edge) }, choose: { model.choose(option: $0) },
                submit: { model.submit() }, settings: { model.showSettings?() }, next: { model.next() }),
            liveContent: AnyView(content)
        )
        .widgetAccessibility(
            reduceMotion: model.reduceMotion, reduceTransparency: model.reduceTransparency
        )

    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let notice = model.notice {
                HStack(alignment: .top) {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    if let action = model.noticeAction {
                        Button(action.title) { action.run() }
                            .buttonStyle(.genHover())
                            .controlSize(.small)
                            .accessibilityIdentifier("widget.notice.action")
                    }
                    IconButton(systemName: "xmark", tooltip: "Dismiss this note") { model.notice = nil }
                }
                // A note under the pointer waits to fade. A note closed under the pointer gets no exit event.
                .onHover { model.noticeHovered($0) }
                .onDisappear { model.noticeHovered(false) }
            }
            if let error = model.error {
                // One sentence; the raw text (a process's stderr) only behind Details.
                NoticePill(text: error, more: model.errorDetail, tone: .error) { model.error = nil }
                    .accessibilityIdentifier("widget.error")
            }
            if model.connectionLost && model.snapshot != nil {
                HStack {
                    Image(systemName: "bolt.horizontal.circle")
                    Text("Disconnected. Sessions may be out of date and queued messages wait.")
                        .font(.system(size: 11))
                    Spacer(minLength: 4)
                    Button("Reconnect", action: model.start).font(.caption).buttonStyle(.genHover(accent: .orange))
                }.foregroundStyle(.orange)
            }
            if let errors = model.snapshot?.errors, !errors.isEmpty {
                GenDisclosure("Some sources are unavailable", isExpanded: $sourcesExpanded,
                              identifier: "widget.sources.unavailable") {
                    Text(errors.joined(separator: "\n")).font(.caption).foregroundStyle(.orange)
                        .textSelection(.enabled)
                }.font(.caption).foregroundStyle(.orange)
            }
            if !model.inboxOverview {
                GenSegmentedTabs("View", items: sectionItems, selection: Binding(get: { section }, set: { section = $0 }))
                    .accessibilityIdentifier("widget.sections")
            }
            if model.snapshot == nil || (model.selected == nil && model.snapshot?.rosterLoading == true) {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting to your local agents…").font(.callout).foregroundStyle(.secondary)
                    if model.error != nil || model.connectionLost { Button("Reconnect", action: model.start) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.inboxOverview {
                if model.stagedView == nil { WidgetStagedChip(model: model) }
                ScrollView {
                    Group {
                        if model.stagedView != nil { WidgetStagedList(model: model) } else { WidgetInboxOverview(model: model) }
                    }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
                        .scrollOverflowContent()
                        .modifier(DocumentHeight(onScrollView: false) { fit.document = $0; reportFit() })
                }
                .modifier(DocumentHeight(onScrollView: true) { fit.document = $0; reportFit() })
                .onGeometryChange(for: CGFloat.self, of: \.size.height) { fit.viewport = $0; reportFit() }
                .onDisappear { fit.viewport = nil; fit.document = nil; reportFit() }
                .scrollOverflowHints()
            } else if model.selected == nil {
                if model.inbox.sessions.isEmpty {
                    VStack(spacing: 10) {
                        GenesisWidgetMark()
                        Text("Nothing needs you.").font(.headline)
                        Text("Questions, screenshots, and finished work land here.").font(.caption)
                            .foregroundStyle(.secondary)
                        Button("Choose sessions") { model.showSettings?() }.buttonStyle(.genHover())
                    }.frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    waitingSessions
                }
            } else {
                if composerOnTop { composer }
                // Pinned above the list: inside it, a session that opened at its selected card scrolled the filter
                // under the top fade (Martin's image 24, 2026-10-23).
                if section == "Inbox", !model.cards.isEmpty { inboxFilterBar }
                if section == "Inbox", model.stagedView == nil { WidgetStagedChip(model: model) }
                ScrollViewReader { reader in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if model.stagedView != nil {
                                WidgetStagedList(model: model)
                            } else if section == "Inbox" {
                                inbox
                            } else if section == "Sessions" {
                                WidgetSessionBrowser(model: model)
                            } else if section == "Changes" {
                                changes
                            } else {
                                conversation
                            }
                            if section == "Inbox" {
                                ForEach(model.outgoing) { message in
                                    outgoing(message).id("outgoing-" + message.id)
                                }
                            }
                        }.frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 2)
                            .scrollOverflowContent()
                            .modifier(DocumentHeight(onScrollView: false) { fit.document = $0; reportFit() })
                    }
                        .modifier(LatestScrollAnchor(enabled: section == "Conversation", identity: model.selectedKey))
                        // A new view (section or session) starts at its own top: the Sessions list's deep offset,
                        // kept for the much shorter inbox, drew its rows over the header (Martin, 2026-10-23). The
                        // session list keeps its place when Up and Down pick another session in it.
                        .id(section == "Sessions" ? section : section + "|" + model.selectedKey)
                        .onChange(of: WidgetOutgoingPosition(session: model.selectedKey, messageID: model.outgoing.last?.id)) { previous, next in
                            guard section == "Inbox", previous.session == next.session, let id = next.messageID,
                                  Self.followsOutgoing(model.outgoing.last) else { return }
                            ScrollViewPositioning.scroll(reader, to: "outgoing-" + id, anchor: .bottom)
                        }
                        // Up and Down move the selection; the list brings the chosen row into view.
                        .onChange(of: model.listKey) { _, _ in
                            if section == "Inbox", let id = model.card?.id {
                                reader.scrollTo("card-" + id)
                            } else if section == "Sessions" {
                                reader.scrollTo(model.selectedKey)
                            }
                        }
                        .modifier(DocumentHeight(onScrollView: true) { fit.document = $0; reportFit() })
                        .onGeometryChange(for: CGFloat.self, of: \.size.height) { fit.viewport = $0; reportFit() }
                        .onDisappear { fit.viewport = nil; fit.document = nil; reportFit() }
                        // Outermost, so the scroll view's own anchor modifiers still sit directly on it.
                        .scrollOverflowHints()
                }
                // While a decision card holds the composer for an own answer, the bottom one would edit the same draft.
                if showsComposer && !composerOnTop {
                    composer
                }
            }
        }
        .mediaPreviewHost()
        .padding(18).frame(maxWidth: .infinity, maxHeight: .infinity)
        .overlay {
            if model.stagedLeavePrompt { WidgetStagedLeavePrompt(model: model) }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: model.stagedLeavePrompt)
        .onGeometryChange(for: CGFloat.self, of: \.size.height) { fit.outer = $0; reportFit() }
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, error in
                    Task { @MainActor in
                        if let url {
                            model.importFile(url)
                        } else if let error {
                            model.fail("This file could not be attached.", detail: error.localizedDescription)
                        }
                    }
                }
            }
            return !providers.isEmpty
        }
    }

    /// The pane needs its chrome plus the whole scroll document; without a list (connecting, nothing selected) a
    /// short fixed height is enough.
    /// The three heights change in separate callbacks of one layout pass; read them together after it.
    private func reportFit() {
        guard !fit.scheduled else { return }
        fit.scheduled = true
        DispatchQueue.main.async { [fit, model] in
            fit.scheduled = false
            guard let outer = fit.outer else { return }
            // The same condition that chooses the list over the connecting / nothing-selected placeholders.
            if model.snapshot != nil, model.selected != nil || model.inboxOverview {
                // The list is shown but not measured yet: wait instead of reporting the placeholder for a moment.
                guard let viewport = fit.viewport, let document = fit.document else { return }
                model.reportAgentFit(outer - viewport + document)
            } else {
                model.reportAgentFit(WidgetContentFit.placeholderHeight)
            }
        }
    }

    private var header: some View {
        HStack(spacing: 9) {
            Button {
                choosingSession = true
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.inboxOverview ? "Inbox" : model.selected?.title ?? "Agent inbox")
                        .font(.system(size: 13, weight: .semibold)).lineLimit(1)
                    if model.inboxOverview {
                        Text("Every session").font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    } else if let selected = model.selected {
                        WidgetSessionFacts(session: selected,
                            contextTokens: WidgetModel.contextTokens(model.transcript) ?? model.contextTokens[selected.key],
                            animate: !reduceMotion)
                    }
                }
                .padding(.horizontal, 6).padding(.vertical, 3)
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Choose another session or subagent")
            .padding(.leading, -6)
            .accessibilityLabel("Choose session or subagent")
            .popover(isPresented: $choosingSession, arrowEdge: .bottom) {
                ScrollView {
                    WidgetSessionBrowser(model: model) { session in
                        model.select(session.key, edge: edge)
                        choosingSession = false
                    }.padding(16)
                }.frame(width: 560, height: 520)
            }
            .onChange(of: choosingSession) { _, value in model.sessionChooserOpen = value }
            .onDisappear { model.sessionChooserOpen = false }
            Spacer(minLength: 0)
            if model.inboxOverview {
                if model.selected != nil {
                    IconButton(systemName: "chevron.left", tooltip: "Back to " + (model.selected?.title ?? "the session")) {
                        model.inboxOverview = false
                    }.accessibilityLabel("Back to the session")
                }
            } else {
                IconButton(systemName: "tray.full", tooltip: "Inbox items from every session") {
                    model.inboxOverview = true
                }.accessibilityLabel("Inbox from every session")
                if let selected = model.selected {
                    WidgetCmuxButton(model: model, session: selected, size: 12)
                }
            }
            // Both act on one session, which the overview of every session does not show.
            if !model.inboxOverview {
                IconButton(systemName: "pin.slash", tooltip: "Unpin this session from the widget", action: model.unpinSelected)
                    .accessibilityLabel("Unpin selected session")
                IconButton(systemName: "rectangle.on.rectangle", tooltip: "Open this session in Hub") {
                    model.openHub?(model.selected)
                }
                .accessibilityLabel("Open session in Hub")
            }
            IconButton(systemName: "slider.horizontal.3", tooltip: "Widget settings and filters") {
                model.showSettings?()
            }
            .accessibilityLabel("Widget settings")
            IconButton(systemName: "xmark", tooltip: WidgetKeymap.hint("Collapse", WidgetKeymap.collapse), action: model.requestCollapse)
                .accessibilityLabel("Collapse widget")
        }
    }

    private var sectionItems: [GenSegmentedTabs<String>.Item] {
        var items: [GenSegmentedTabs<String>.Item] = [.init("Inbox", "Inbox"), .init("Sessions", "Sessions"),
                                                      .init("Conversation", "Conversation")]
        if model.snapshot?.state.preferences.showChanges == true { items.append(.init("Changes", "Changes")) }
        return items
    }

    private var reduceMotion: Bool { systemReduceMotion || model.effectiveReduceMotion }

    /// While a decision card holds the composer for an own answer, a second one would edit the same draft.
    private var showsComposer: Bool {
        !model.inboxOverview && section != "Sessions" && !(section == "Inbox" && model.ownAnswerCard != nil)
    }

    /// The inbox's composer sits under the tabs unless the user moved it to the bottom (Widgets → Sessions).
    private var composerOnTop: Bool {
        showsComposer && section == "Inbox" && (model.snapshot?.state.preferences.inboxComposer ?? "top") == "top"
    }

    /// No session picked: the sessions that hold inbox items, so nothing waits out of sight.
    private var waitingSessions: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Sessions with inbox items").font(.system(size: 12, weight: .semibold))
                    Spacer()
                    markAllReadButton
                }.padding(.bottom, 4)
                ForEach(model.inbox.sessions, id: \.key) { entry in
                    let session = model.snapshot?.sessions.first { $0.key == entry.key }
                    Button {
                        model.select(entry.key, edge: edge)
                        section = "Inbox"
                    } label: {
                        HStack(spacing: 9) {
                            AIProviderGlyph(meta: AIProviders.meta(for: session?.target.provider ?? "unknown"), size: 18)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session?.title ?? entry.key).font(.system(size: 12, weight: .medium)).lineLimit(1)
                                Text(inboxSummary(entry)).font(.system(size: 10)).foregroundStyle(.secondary)
                            }
                            Spacer(minLength: 4)
                            WidgetInboxCount(count: entry.unread + entry.needsAnswer, needsAnswer: entry.needsAnswer > 0,
                                pulse: model.inboxPulseFor(entry.key), reduceMotion: model.effectiveReduceMotion,
                                complete: model.inbox.complete)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(RowButtonStyle(cornerRadius: 10))
                    .accessibilityLabel("Open " + (session?.title ?? "session") + ", " + inboxSummary(entry))
                }
            }
            .padding(.vertical, 2)
            .scrollOverflowContent()
        }
        .scrollOverflowHints()
    }

    private func inboxSummary(_ entry: WidgetInboxSession) -> String {
        [entry.needsAnswer > 0 ? "\(entry.needsAnswer) need your answer" : nil,
         entry.unread > 0 ? "\(entry.unread) unread" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    @ViewBuilder private var markAllReadButton: some View {
        if model.inboxCount > 0 {
            Button("Mark all read", action: model.markAllRead)
                .buttonStyle(.genHover()).font(.system(size: 11, weight: .medium))
                .instantTooltip("Answers become read; older questions and decisions stop counting. Nothing is deleted.")
                .accessibilityIdentifier("widget.inbox.markAllRead")
        }
    }

    /// Every item of the session as a row; the open row carries the whole card in place. Several answers from one
    /// session read as a list, not as one card behind a drop-down.
    private var inboxFilterBar: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                GenSegmentedTabs(
                    "Inbox filter",
                    items: [.init("all", "All"), .init("inbox", "Messages"), .init("decisions", "Decisions")],
                    // The model holds the filter, so Up and Down walk the rows on screen.
                    selection: Binding(get: { model.inboxFilter }, set: { value in
                        model.holdAgentFit()
                        model.inboxFilterPicked = true
                        model.inboxFilter = value
                    }), minSegmentWidth: 64, identifier: "widget.inbox.filter")
                Spacer()
                markAllReadButton
            }
            Text(inboxHeadline).font(.system(size: 11)).foregroundStyle(.secondary)
        }
    }

    /// The session's cards, each Dismiss or Mark complete that waits for its Undo note already applied.
    private var shownCards: [WidgetCard] {
        ledgerUndo.moves.isEmpty ? model.cards : model.cards.map { ledgerUndo.applied($0) }
    }

    @ViewBuilder private var inbox: some View {
        if !model.cards.isEmpty {
            let shown = Self.filtered(shownCards, by: model.inboxFilter)
            if shown.isEmpty {
                Text(model.inboxFilter == "decisions" ? "No decisions in this session." : "No messages in this session.")
                    .font(.callout).foregroundStyle(.secondary).padding(.vertical, 6)
            }
            ForEach(shown.reversed()) { card in
                inboxRow(card).id("card-" + card.id)
            }
        } else if model.inboxLoading {
            ProgressView("Loading this session’s inbox…")
                .controlSize(.small).padding(.vertical, 12)
                .accessibilityIdentifier("widget.inbox.loading")
        } else {
            Text("No inbox items for this session.").foregroundStyle(.secondary).font(.callout)
            Button("See conversation") { section = "Conversation" }.buttonStyle(.genHover())
        }
    }

    private var inboxHeadline: String {
        let cards = shownCards
        let waiting = cards.filter(\.needsAnswer).count
        let unread = cards.filter { !$0.read && !$0.needsAnswer }.count
        return [cards.count == 1 ? "1 item" : "\(cards.count) items",
                waiting > 0 ? "\(waiting) need your answer" : nil,
                unread > 0 ? "\(unread) unread" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    /// The open row is the selected card unless the user folded it (`WidgetModel.foldedCardIDs`); only an open
    /// decision is what the composer and the number keys answer (`WidgetModel.answerCard`).
    private func isOpen(_ card: WidgetCard) -> Bool {
        card.id == model.card?.id && !model.foldedCardIDs.contains(card.id)
    }

    /// Opens or folds a row in one `GenMotion` animation; the panel around it grows or shrinks to fit (W3).
    private func toggle(_ card: WidgetCard) {
        let opening = !isOpen(card)
        model.releaseAgentFit()
        GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) {
            if opening {
                model.openCard(card)
            } else {
                model.foldedCardIDs.insert(card.id)
            }
        }
    }

    private func inboxRow(_ card: WidgetCard) -> some View {
        let open = isOpen(card)
        let _ = RenderProbe.hit("widget.inbox.row")
        return VStack(alignment: .leading, spacing: 0) {
            Button { toggle(card) } label: {
                HStack(alignment: .top, spacing: 9) {
                    Circle()
                        .fill(card.needsAnswer ? Color.orange : (card.read ? Color.clear : SessionPalette.blue))
                        .frame(width: 7, height: 7).padding(.top, 5)
                    Image(systemName: Self.kindSymbol(card.kind)).font(.system(size: 11))
                        .foregroundStyle(.secondary).frame(width: 14).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        // A one-question form's title is its prompt, which the open card does not repeat: open, it
                        // shows whole and as Markdown, the way the form drew it.
                        let isPrompt = Self.asksOneQuestion(card)
                        (isPrompt ? Text(.init(card.title)) : Text(card.numberedTitle))
                            .font(.system(size: 12.5, weight: open ? .semibold : .medium))
                            .lineLimit(open ? (isPrompt ? nil : 4) : 2).fixedSize(horizontal: false, vertical: true)
                        if !open, let preview = Self.previewLine(card.body) {
                            Text(preview).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                        }
                        HStack(spacing: 4) {
                            Text(Self.kindLabel(card))
                            Text("·")
                            LiveAgo(date: Date(timeIntervalSince1970: card.at / 1000), style: .brief)
                        }.font(.system(size: 10)).foregroundStyle(card.needsAnswer ? Color.orange : .secondary)
                    }
                    Spacer(minLength: 4)
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .padding(.top, 4)
                }
                .padding(.horizontal, 10).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 11))
            .accessibilityLabel(Self.kindLabel(card) + ": " + card.numberedTitle)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("widget.inbox.row." + card.id)
            if open {
                cardDetail(card).padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 12)
                    .transition(.genReveal)
            }
        }
        // The card closes over its detail instead of the rows below sliding up over fading text.
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .background(Color.white.opacity(open ? 0.055 : 0.03), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(card.needsAnswer ? Color.orange.opacity(0.28) : .clear, lineWidth: 1))
    }

    /// A card whose pick or note is staged, here or in the snapshot.
    private func staged(_ card: WidgetCard) -> Bool {
        card.kind == "decision" && card.needsAnswer
            && (model.stagedOption(card.sourceId, stored: card.draftOption) != nil || card.draft != nil)
    }

    /// The key that picks the option at `index` (the open decision's number keys, as the keymap has them), or nil.
    static func choiceKey(_ index: Int) -> String? {
        guard index < 9 else { return nil }
        let label = WidgetKeymap.label(WidgetKeymap.choiceID(index + 1))
        return label.isEmpty ? nil : label
    }

    /// Dismiss or Mark complete: the card shows its new state at once, and the decision log hears of it only when
    /// the note with Undo goes away.
    private func holdMove(_ card: WidgetCard, to state: String) {
        ledgerUndo.hold(card, to: state, model: model, reduceMotion: reduceMotion)
    }

    static func choiceTooltip(_ choice: WidgetChoice, index: Int, stages: Bool, picked: Bool) -> String {
        let key = index < 9 ? " · key \(index + 1)" : ""
        if !stages { return "Answer \(choice.id)" + (choice.recommended ? " (recommended)" : "") + key }
        return (picked ? "Staged; click again to unstage" : "Stage \(choice.id), sent later with your other staged decisions")
            + (choice.recommended ? " (recommended)" : "") + key
    }

    @ViewBuilder private func cardDetail(_ card: WidgetCard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let saved = model.draftSavedAt[card.id] ?? (card.draft != nil ? Date(timeIntervalSince1970: card.at / 1000) : nil),
               card.kind == "decision", card.needsAnswer {
                HStack(spacing: 4) {
                    Image(systemName: "checkmark.circle.fill").foregroundStyle(SessionPalette.blue)
                    // "Staged", as the option badge and the hub say: a note that waits to be sent with the others.
                    Text(card.draft.map { "Note staged: " + $0 } ?? "Note staged").lineLimit(2)
                    if model.draftSavedAt[card.id] != nil {
                        Text("·")
                        LiveAgo(date: saved, style: .brief)
                    }
                }.font(.system(size: 11)).foregroundStyle(.secondary)
            }
            WidgetReceiptContextView(card: card, model: model)
                .id(card.id + "|" + String(card.at))
            if !card.body.isEmpty {
                WidgetMarkdown(text: card.body)
            }
            if !card.attachments.isEmpty {
                WidgetCardAttachments(card: card, height: 110, maxWidth: 260, compare: true, showMedia: showMedia)
            }
            if card.kind == "decision" && !card.needsAnswer {
                WidgetDecisionOutcome(card: card) { model.openDecision(id: $0.id, sessionKey: $0.sessionKey) }
            }
            if card.needsAnswer {
                if card.kind == "form" {
                    ForEach(card.formItems ?? []) { item in
                        formItem(item, card: card, showsPrompt: !Self.asksOneQuestion(card))
                            .disabled(model.cardPending)
                    }
                    Button(model.cardPending ? "Answer queued" : "Send answers") { model.submit(answering: true) }
                        .buttonStyle(.borderedProminent).pointerCursor(!model.cardPending)
                        .disabled(model.importing > 0 || model.cardPending)
                } else {
                    let staged = model.stagedOption(card.sourceId, stored: card.draftOption)
                    ForEach(Array(card.choices.enumerated()), id: \.element.id) { index, choice in
                        let picked = staged == choice.id
                        let key = Self.choiceKey(index)
                        Button {
                            model.choose(card, option: choice.id)
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                // The badge is the key that picks the option; the letter, which the agent and the
                                // hub name it by, leads its text.
                                Text(verbatim: key ?? choice.id).font(.system(size: 10.5, weight: .semibold, design: .rounded))
                                    .padding(.horizontal, 4)
                                    .frame(minWidth: 20, minHeight: 20).background(
                                        .white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
                                HStack(alignment: .firstTextBaseline, spacing: 5) {
                                    if key != nil {
                                        Text(verbatim: choice.id + ")").foregroundStyle(SessionPalette.secondary)
                                    }
                                    Text(Self.choiceText(choice)).fixedSize(horizontal: false, vertical: true)
                                }
                                .font(.system(size: 12))
                                .padding(.top, 2)
                                Spacer(minLength: 0)
                                if picked {
                                    Text("Staged").font(.system(size: 10, weight: .semibold))
                                        .foregroundStyle(SessionPalette.blue).padding(.top, 3)
                                }
                                if choice.recommended {
                                    Image(systemName: "sparkle").foregroundStyle(.orange)
                                }
                            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                                .background(picked ? SessionPalette.blue.opacity(0.16) : .white.opacity(0.065),
                                            in: RoundedRectangle(cornerRadius: 9))
                                .overlay(RoundedRectangle(cornerRadius: 9)
                                    .strokeBorder(picked ? SessionPalette.blue.opacity(0.7) : .clear, lineWidth: 1))
                                .contentShape(RoundedRectangle(cornerRadius: 9))
                        }
                        .buttonStyle(RowButtonStyle(cornerRadius: 9)).disabled(model.importing > 0)
                        .instantTooltip(Self.choiceTooltip(choice, index: index, stages: model.decisionClickStages,
                                                           picked: picked))
                        .accessibilityLabel((model.decisionClickStages ? "Stage " : "Answer ") + "\(choice.id): "
                                            + Self.choiceText(choice))
                        .accessibilityValue(picked ? "Staged" : "")
                    }
                    ownAnswer(card)
                }
            }
            HStack(spacing: 8) {
                if card.kind == "todo" && ["open", "acknowledged"].contains(card.status) {
                    if card.status == "open" {
                        Button("Acknowledge") { model.ledger(card, state: "acknowledged") }
                    }
                    Button("Mark complete") { holdMove(card, to: "implemented") }
                    Button("Dismiss") { holdMove(card, to: "dismissed") }
                } else if card.kind == "decision" && card.needsAnswer {
                    Button("Stage note") { model.saveDraft(card) }
                        .instantTooltip("Stages your text as this decision's note, sent later with your other staged decisions.")
                    if staged(card) {
                        Button("Send now") { model.sendStaged([card.sourceId]) }
                            .instantTooltip("Sends this staged decision alone, without the others.")
                        Button("Unstage") { model.discardStaged([card.sourceId]) }
                    }
                    Button("Dismiss") { holdMove(card, to: "dismissed") }
                }
                if card.kind == "result" || card.kind == "answer" {
                    Button("Create handoff") { model.destination("handoff") }
                    Button("New agent with context…") { model.destination("new") }
                }
                Spacer(minLength: 0)
                IconButton(systemName: model.reading ? "stop.fill" : "speaker.wave.2",
                           tooltip: model.reading ? "Stop reading" : "Read aloud", action: model.toggleRead)
                    .accessibilityLabel(model.reading ? "Stop reading" : "Read aloud")
            }
            .buttonStyle(.genHover()).font(.caption)
            ForEach(Array(card.refs.enumerated()), id: \.offset) { _, ref in
                if ref.value.hasPrefix("/") {
                    // A file is the shared path label (short, with reveal, copy and Cursor), never a raw absolute
                    // path. A transcript is named as such: its result is the text above, not raw JSON to open.
                    PathLabel(path: ref.value, font: .caption,
                              title: ref.value.hasSuffix(".jsonl") ? "Transcript" : nil)
                } else {
                    Button(ref.value) { openReference(ref.value) }.buttonStyle(.link).font(.caption).lineLimit(1)
                        .truncationMode(.middle).pointerCursor()
                }
            }
        }
    }

    /// "Write my own answer": a row under the options that opens the full composer (text, media, screenshot, voice)
    /// inside the card; Send delivers the draft as the answer with no option picked.
    @ViewBuilder private func ownAnswer(_ card: WidgetCard) -> some View {
        if model.ownAnswerCard?.id == card.id {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("Your own answer").font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    Spacer(minLength: 0)
                    Button("Back to the options") {
                        GenMotion.perform(expanding: false, reduceMotion: reduceMotion) { model.ownAnswerCardID = nil }
                    }.buttonStyle(.genHoverPlain()).font(.caption)
                }
                composer(ownAnswer: card).disabled(model.cardPending)
            }
            .transition(.genReveal)
            .onAppear { editing = true }
        } else {
            WidgetOwnAnswerRow {
                GenMotion.perform(expanding: true, reduceMotion: reduceMotion) { model.openOwnAnswer(card) }
            }.disabled(model.importing > 0 || model.cardPending)
        }
    }

    /// "inbox": answers, results and questions; "decisions": decisions and tasks; anything else: every card.
    static func filtered(_ cards: [WidgetCard], by filter: String) -> [WidgetCard] {
        switch filter {
        case "inbox": return cards.filter { !["decision", "todo"].contains($0.kind) }
        case "decisions": return cards.filter { ["decision", "todo"].contains($0.kind) }
        default: return cards
        }
    }

    /// A composer message lands under the list, and the list follows it. An answer sent from a card leaves the list
    /// where it is: three scrolls to the bottom moved the answered card away (Martin, 2026-10-23: "the whole widget
    /// jumped around … i totally lost idea about which one was it").
    static func followsOutgoing(_ message: WidgetOutgoing?) -> Bool {
        guard let message, case .object(let payload) = message.payload, case .string(let kind) = payload["kind"] else {
            return false
        }
        return kind == "followup"
    }

    static func kindSymbol(_ kind: String) -> String {
        switch kind {
        case "answer": return "text.bubble"
        case "result": return "checkmark.seal"
        case "form": return "questionmark.bubble"
        case "decision": return "arrow.triangle.branch"
        case "todo": return "checklist"
        default: return "tray"
        }
    }

    /// A form with one question: its title is that question's prompt, so the open card shows it once, in the header.
    static func asksOneQuestion(_ card: WidgetCard) -> Bool {
        card.kind == "form" && card.formItems?.count == 1
    }

    static func kindLabel(_ card: WidgetCard) -> String {
        if card.needsAnswer { return "Needs your answer" }
        switch card.kind {
        case "answer": return card.read ? "Answer" : "New answer"
        case "result": return card.read ? "Agent result" : "New agent result"
        case "todo": return "Task · " + WidgetTask.label(for: card.status)
        case "decision":
            if let replacement = card.supersededBy { return "Decision · Superseded by DECISION \(replacement.number)" }
            if let option = card.option, !option.isEmpty, ["acknowledged", "implemented", "sent", "answered"].contains(card.status) {
                return "Decision · Answered \(option) · " + statusPhrase(card.status, kind: card.kind)
            }
            return "Decision · " + statusPhrase(card.status, kind: card.kind)
        case "form": return "Question · " + statusPhrase(card.status, kind: card.kind)
        default: return sentenceCase(card.kind) + " · " + statusPhrase(card.status, kind: card.kind)
        }
    }

    /// One phrase for each state of the decision log and the question forms, the same in every tab and row.
    static func statusPhrase(_ status: String, kind: String) -> String {
        if kind == "todo" { return WidgetTask.label(for: status) }
        switch status {
        case "open", "pending": return "Waiting for your answer"
        case "drafted": return "Staged"
        // A decision's answer is chosen and waits for its delivery; a form's answer is the end.
        case "answered": return kind == "decision" ? "Waiting to send" : "Answered"
        case "sent": return "Sent"
        case "acknowledged": return "Acknowledged"
        case "implemented": return "Implemented"
        case "dismissed": return "Dismissed"
        case "superseded": return "Superseded"
        case "timeout": return "No answer in time"
        case "cancelled": return "Withdrawn"
        default: return sentenceCase(status)
        }
    }

    /// "waiting-route" reads "Waiting route", never "Waiting-Route".
    static func sentenceCase(_ value: String) -> String {
        let words = value.replacingOccurrences(of: "-", with: " ").replacingOccurrences(of: "_", with: " ")
        return words.prefix(1).uppercased() + words.dropFirst()
    }

    /// A collapsed row's one line: the body's first line of prose, without Markdown marks.
    static func previewLine(_ body: String) -> String? {
        for line in body.split(separator: "\n", omittingEmptySubsequences: true) {
            let text = line.trimmingCharacters(in: CharacterSet.whitespaces.union(CharacterSet(charactersIn: "#>*-`|")))
            if !text.isEmpty && !text.allSatisfy({ "=-_".contains($0) }) {
                return text.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "`", with: "")
            }
        }
        return nil
    }

    /// The option text without a letter the agent already wrote ("a) Record…"); the row draws the letter itself.
    static func choiceText(_ choice: WidgetChoice) -> String {
        let title = choice.title.trimmingCharacters(in: .whitespaces)
        for prefix in [choice.id + ")", "(" + choice.id + ")", choice.id + ".", choice.id + ":"] {
            if title.lowercased().hasPrefix(prefix.lowercased()) {
                return title.dropFirst(prefix.count).trimmingCharacters(in: .whitespaces)
            }
        }
        return title
    }

    private func formItem(_ item: WidgetFormItem, card: WidgetCard, showsPrompt: Bool = true) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            if showsPrompt {
                Text(.init(item.promptMarkdown)).font(.system(size: 12, weight: .medium)).textSelection(.enabled)
            }
            ForEach(item.choices ?? []) { choice in
                let selected =
                    model.formAnswers[card.id]?[item.id]?.selectedChoices?.contains(choice.id) == true
                Button {
                    var answer = model.formAnswers[card.id]?[item.id] ?? WidgetFormAnswer(itemId: item.id)
                    var selectedIDs = answer.selectedChoices ?? []
                    if item.allowMultiple == true {
                        if let index = selectedIDs.firstIndex(of: choice.id) {
                            selectedIDs.remove(at: index)
                        } else {
                            selectedIDs.append(choice.id)
                        }
                    } else {
                        selectedIDs = [choice.id]
                    }
                    answer.selectedChoices = selectedIDs
                    model.formAnswers[card.id, default: [:]][item.id] = answer
                } label: {
                    HStack {
                        Image(systemName: selected ? "checkmark.circle.fill" : "circle")
                        Text(choice.label).font(.system(size: 12))
                        Spacer()
                    }.padding(8).background(
                        .white.opacity(selected ? 0.12 : 0.045), in: RoundedRectangle(cornerRadius: 8))
                        .contentShape(RoundedRectangle(cornerRadius: 8))
                }.buttonStyle(RowButtonStyle(cornerRadius: 8))
                // The circle shows the pick; VoiceOver hears it as the selected trait and a value.
                .accessibilityLabel(choice.label)
                .accessibilityValue(selected ? "Selected" : "Not selected")
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            if item.allowFreeText != false {
                TextField(
                    "Your answer",
                    text: Binding(
                        get: { model.formAnswers[card.id]?[item.id]?.freeText ?? "" },
                        set: {
                            var answer = model.formAnswers[card.id]?[item.id] ?? WidgetFormAnswer(itemId: item.id)
                            answer.freeText = $0
                            model.formAnswers[card.id, default: [:]][item.id] = answer
                        }), axis: .vertical
                ).textFieldStyle(.roundedBorder).lineLimit(1...4)
            }
            if let answer = card.formAnswers?[item.id], !card.needsAnswer {
                Text(answer.freeText ?? answer.selectedChoices?.joined(separator: ", ") ?? "").font(
                    .caption)
            }
        }
    }

    @ViewBuilder private var conversation: some View {
        let timeline = timelineCache.items(for: TimelineCache.Inputs(
            transcript: model.transcript, cards: shownCards, outgoing: model.outgoing,
            activity: model.sessionActivity, provider: model.selected?.target.provider ?? ""))
        if let error = model.transcriptError {
            Text(error).font(.caption).foregroundStyle(.orange).textSelection(.enabled)
        }
        ForEach(timeline) { item in
            VStack(alignment: .leading, spacing: 5) {
                Text(item.date, style: .time).font(.system(size: 9, design: .monospaced)).foregroundStyle(
                    .tertiary)
                switch item.event {
                case .turn(let turn):
                    if !turn.text.isEmpty {
                        VStack(alignment: .leading, spacing: 5) {
                            Text(turn.role.capitalized).font(.system(size: 9, weight: .semibold)).foregroundStyle(
                                .secondary)
                            Text(.init(visibleText(turn.text))).font(.system(size: 12)).textSelection(.enabled)
                        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
                            .background(
                                turn.role == "user" ? Color.blue.opacity(0.16) : Color.white.opacity(0.04),
                                in: RoundedRectangle(cornerRadius: 11))
                    }
                case .card(let card):
                    VStack(alignment: .leading, spacing: 6) {
                        Text(Self.kindLabel(card)).font(.caption2).foregroundStyle(.secondary)
                        Text(card.numberedTitle).font(.system(size: 12, weight: .semibold)).textSelection(.enabled)
                        if !card.body.isEmpty {
                            WidgetMarkdown(text: card.body)
                        }
                        if !card.attachments.isEmpty {
                            WidgetCardAttachments(card: card, height: 64, maxWidth: 140, compare: false, showMedia: showMedia)
                        }
                        if card.needsAnswer {
                            Button("Answer this question") {
                                model.foldedCardIDs.remove(card.id)
                                model.selectedCardID = card.id
                                section = "Inbox"
                            }.buttonStyle(.genHover())
                        }
                    }.padding(10).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 11))
                case .outgoing(let message):
                    outgoing(message)
                case .activity(let line):
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(line.title).font(.caption)
                            if !line.detail.isEmpty {
                                Text(line.detail).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
        if model.transcriptLoading {
            ProgressView("Loading recent conversation…").controlSize(.small)
        } else if timeline.isEmpty && model.transcriptError == nil {
            Text("There are no recorded messages for this session yet.").font(.caption).foregroundStyle(.secondary)
        }
    }

    fileprivate struct TimelineItem: Identifiable {
        enum Event {
            case turn(TranscriptTurn)
            case card(WidgetCard)
            case outgoing(WidgetOutgoing)
            case activity(ActivityLine)
        }
        let id: String
        let date: Date
        let event: Event
    }

    /// A decision event in words, for the Conversation tab.
    struct ActivityLine: Equatable {
        let title: String
        let detail: String
    }

    /// The Conversation tab's list: turns, cards, outgoing messages and decision events in time order. The body runs
    /// on every publish of the model (a voice level, a hover), so the merge, the date parsing and the sort run only
    /// when an input changed. A plain reference in `@State`, so a rebuild never re-renders.
    @MainActor
    private final class TimelineCache {
        struct Inputs: Equatable {
            var transcript: [TranscriptTurn]
            var cards: [WidgetCard]
            var outgoing: [WidgetOutgoing]
            var activity: [WidgetActivityEvent]
            var provider: String
        }
        private var inputs: Inputs?
        private var items: [TimelineItem] = []

        func items(for next: Inputs) -> [TimelineItem] {
            if next != inputs {
                items = Self.merged(next)
                inputs = next
            }
            return items
        }

        private static func merged(_ inputs: Inputs) -> [TimelineItem] {
            let turns = inputs.transcript.filter { !$0.text.isEmpty }.map { turn in
                TimelineItem(id: "turn:" + turn.id, date: SessionFormat.parseISO(turn.at) ?? .distantPast,
                             event: .turn(turn))
            }
            let cards = inputs.cards.map {
                TimelineItem(id: $0.id, date: Date(timeIntervalSince1970: $0.at / 1000), event: .card($0))
            }
            let outgoing = inputs.outgoing.map {
                TimelineItem(
                    id: "out:" + $0.id, date: Date(timeIntervalSince1970: $0.createdAt / 1000),
                    event: .outgoing($0))
            }
            let numbers = Dictionary(inputs.cards.compactMap { card in card.number.map { (card.sourceId, $0) } },
                                     uniquingKeysWith: { first, _ in first })
            let activity = inputs.activity.map { event in
                TimelineItem(
                    id: "event:" + event.id, date: Date(timeIntervalSince1970: event.at / 1000),
                    event: .activity(LiveWidgetView.activityLine(
                        event, number: numbers[event.sourceId], provider: inputs.provider)))
            }
            return (turns + cards + outgoing + activity).sorted {
                $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date
            }
        }
    }

    /// A decision event from the log: what happened, then which decision (its number when the session's card is
    /// known, else the session's provider) and the state and route it reached. The wire carries the log's raw names
    /// ("Decision send_failed", "answered · cmux") and the row id, which mean nothing to the reader.
    static func activityLine(_ event: WidgetActivityEvent, number: Int?, provider: String) -> ActivityLine {
        let prefix = "Decision "
        let name = event.title.hasPrefix(prefix) ? String(event.title.dropFirst(prefix.count)) : ""
        let title: String
        switch name {
        case "created": title = "Decision posted"
        case "updated": title = "Decision updated"
        case "superseded": title = "Decision superseded"
        case "harvested": title = "Decision found in the conversation"
        case "delivery": title = "Answer delivered"
        case "stale": title = "Reminder sent: the decision still waits"
        case "send_failed": title = "Answer not delivered"
        default: title = sentenceCase(event.title)
        }
        let decision = number.map { "DECISION \($0)" } ?? AIProviders.meta(for: provider).displayName
        let facts = event.body.components(separatedBy: " · ").compactMap { part -> String? in
            routePhrase(part) ?? (decisionStates.contains(part) ? statusPhrase(part, kind: "decision") : nil)
        }
        return ActivityLine(title: title, detail: ([decision] + facts).filter { !$0.isEmpty }.joined(separator: " · "))
    }

    /// The states of the decision log (`src/question/lib/decisions/store.ts`).
    private static let decisionStates: Set<String> = [
        "open", "drafted", "answered", "sent", "acknowledged", "implemented", "dismissed", "superseded",
    ]

    /// How an answer reached its agent (the log's `delivery.route`).
    static func routePhrase(_ route: String) -> String? {
        switch route {
        case "cmux": return "through cmux"
        case "codex": return "through Codex"
        case "claude-peer": return "as a Claude message"
        case "prompt": return "as a new prompt"
        case "queued": return "queued for the session"
        case "resume": return "by resuming the session"
        default: return nil
        }
    }

    @ViewBuilder private var changes: some View {
        if let changes = model.sessionChanges, changes.available {
            ForEach(changes.files) { file in
                Button {
                    openReference(file.path)
                } label: {
                    HStack {
                        Image(systemName: "doc.text")
                        VStack(alignment: .leading) {
                            Text(URL(fileURLWithPath: file.path).lastPathComponent)
                            Text(file.path).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer()
                        Text(file.source).font(.caption2).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, 6).padding(.vertical, 4)
                    .contentShape(Rectangle())
                }.buttonStyle(RowButtonStyle(cornerRadius: 8))
            }
        } else {
            Text("No file-change receipts have been recorded for this session.").font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    private func outgoing(_ message: WidgetOutgoing) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if !message.text.isEmpty {
                Text(message.text).font(.system(size: 12)).textSelection(.enabled)
            }
            if !message.assetIds.isEmpty {
                attachments(message.assetIds, tile: CGSize(width: 120, height: 80), removable: false)
            }
            HStack {
                if ["preparing", "dispatching", "queued"].contains(message.state) {
                    ProgressView().controlSize(.mini)
                } else {
                    Image(
                        systemName: message.state == "sent" ? "checkmark.circle.fill" : "exclamationmark.circle"
                    )
                }
                Text(receiptLabel(message)).font(.system(size: 10))
                    .accessibilityIdentifier("widget.receipt." + message.id)
                Spacer(minLength: 0)
            }.foregroundStyle(message.state == "sent" ? .green : .secondary)
            if let error = message.error, !(message.state == "waiting-route" && message.receipt?.channel == "session-queue") {
                // What happened in one sentence; the transport's own text only behind Details.
                NoticePill(text: Self.outgoingProblem(message), more: error,
                           tone: message.state == "failed" ? .error : .warning)
            }
            if message.isWithdrawable || message.needsRecovery {
                HStack {
                    if message.needsRecovery {
                        Button("Retry") {
                            if message.state == "unknown" {
                                retry = message
                            } else {
                                model.action(["action": "retry", "id": .string(message.id)])
                            }
                        }
                    }
                    if message.isWithdrawable {
                        Button("Edit") { model.editOutgoing(message) }
                        Button("Cancel") { model.action(["action": "cancel", "id": .string(message.id)]) }
                    } else {
                        Button("Discard…") { discard = message }
                    }
                    if message.needsRecovery {
                        MenuButton(items: {
                            [.action("Resume this session in Hub…") { model.destination("resume") },
                             .action("New agent with prepared context…") { model.destination("new") },
                             .action("Create a handoff file") { model.destination("handoff") },
                             .action("Open conversation") { model.openHub?(model.selected) }]
                        }) {
                            Label("Choose destination…", systemImage: "chevron.down").labelStyle(.titleOnly)
                                .padding(.horizontal, 6).padding(.vertical, 3)
                        }
                    }
                }.font(.caption2).buttonStyle(.genHover())
            }
        }.padding(10).frame(maxWidth: .infinity, alignment: .leading)
            .background(.blue.opacity(0.12), in: RoundedRectangle(cornerRadius: 11))
    }

    private var composer: some View { composer(ownAnswer: nil) }

    /// The reply composer. With `ownAnswer` it sits in that decision's card and sends the draft as the answer.
    private func composer(ownAnswer: WidgetCard?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.draft.assetIds.isEmpty {
                attachments(model.draft.assetIds, tile: CGSize(width: 88, height: 60), removable: true)
            }
            if model.voiceActive {
                HStack(alignment: .center, spacing: 9) {
                    VoiceLevelBars(level: min(1, model.voiceLevel * 5), tint: .red, reduceMotion: model.effectiveReduceMotion)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(model.voiceMode == .note ? "Voice note" : "Dictation")
                            .font(.system(size: 10, weight: .semibold)).foregroundStyle(.secondary)
                        let transcript = model.voiceTranscript
                        // The newest words stay in view: a long dictation drops its beginning, not its end.
                        Text(transcript.isEmpty ? "Listening… the words appear here as you talk" : transcript)
                            .font(.caption).lineLimit(3).truncationMode(.head)
                    }
                    Spacer(minLength: 0)
                }
                .accessibilityElement(children: .combine)
            }
            if model.importing > 0 {
                ProgressView("Saving attachment…").controlSize(.small).font(.caption)
            }
            HStack(alignment: .bottom, spacing: 8) {
                let placeholder = ownAnswer.map { "Your own answer to DECISION \($0.number ?? 0)…" }
                    ?? "Reply to " + (model.selected?.target.provider.capitalized ?? "agent") + "…"
                if panelMoving, !editing, composerFieldHeight > 0 {
                    // While the panel's outline moves the composer rides its bottom edge; a drawn stand-in moves for
                    // free, the AppKit field would lay out and rebuild the key view loop on every frame.
                    Text(model.draft.text.isEmpty ? placeholder : model.draft.text)
                        .font(.system(size: 12)).lineLimit(1...4)
                        .foregroundStyle(model.draft.text.isEmpty ? .tertiary : .primary)
                        .frame(maxWidth: .infinity, minHeight: composerFieldHeight, maxHeight: composerFieldHeight,
                               alignment: .topLeading)
                } else {
                    TextField(placeholder, text: Binding(get: { model.draft.text }, set: model.setText), axis: .vertical)
                        .textFieldStyle(.plain).font(.system(size: 12)).lineLimit(1...4).focused($editing)
                        .onSubmit { model.send() }
                        .accessibilityLabel(ownAnswer == nil ? "Reply to selected agent" : "Your own answer")
                        .onGeometryChange(for: CGFloat.self, of: { $0.size.height.rounded() }) { composerFieldHeight = $0 }
                        .frameProbe("widget.composer.field")
                }
                Button {
                    model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 23)).foregroundStyle(.blue)
                }.buttonStyle(.genHoverIcon(accent: .blue, diameter: 28)).disabled(model.importing > 0)
                    .instantTooltip(ownAnswer == nil ? "Send (Return)" : "Send as your answer (Return)")
                    .accessibilityLabel(ownAnswer == nil ? "Send reply" : "Send your answer")
            }
            // Each icon is the kit's 22 pt target (IconButton), with 4 pt between neighbours instead of a 15 pt strip
            // where a click did nothing.
            HStack(spacing: 4) {
                IconButton(systemName: "paperclip", tooltip: "Attach images or videos", action: model.chooseFiles)
                    .accessibilityLabel("Attach media")
                IconButton(systemName: "clipboard", tooltip: WidgetKeymap.hint("Paste image or video", WidgetKeymap.paste)) {
                    _ = model.pasteMedia()
                }
                .accessibilityLabel("Paste media")
                IconButton(systemName: "camera", tooltip: "Capture a screenshot", action: model.capture)
                    .accessibilityLabel("Capture screenshot")
                IconButton(systemName: model.recordingVideo ? "stop.circle.fill" : "video",
                           tooltip: model.recordingVideo ? "Stop the recording and paste it into the draft"
                               : "Record a window, an app or a display (up to 10 min)",
                           tint: model.recordingVideo ? Color.red : nil, action: model.toggleVideoCapture)
                    .accessibilityLabel(model.recordingVideo ? "Stop and paste the recording" : "Record the screen")
                voiceButton
                Spacer(minLength: 8)
                composerKeys
            }.font(.system(size: 12)).foregroundStyle(.secondary).buttonStyle(.genHoverIcon())
        }
        .padding(11).background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 13))
        // The whole box is the field's target: a click beside the one-line field (or under it, in the padding) starts
        // typing. The buttons inside keep their own clicks, because a child's gesture wins over this one.
        .contentShape(RoundedRectangle(cornerRadius: 13))
        .onTapGesture { editing = true }
        .frameProbe("widget.composer")
    }

    /// The composer's keys, in a hint beside the field: Return sends, Option-Return adds a line (SwiftUI's own key
    /// for a vertical field with `onSubmit`), and the paste and close keys in force. A narrow card (an own answer)
    /// drops the last ones first. Text the user reads: 11 pt at 70% white.
    private var composerKeys: some View {
        let paste = WidgetKeymap.label(WidgetKeymap.paste)
        let close = WidgetKeymap.label(WidgetKeymap.collapse)
        let base = "↩ send · ⌥↩ new line"
        let media = paste.isEmpty ? base : base + " · \(paste) media"
        return ViewThatFits(in: .horizontal) {
            Text(close.isEmpty ? media : media + " · \(close) close")
            Text(media)
            Text(base)
        }
        .font(.system(size: 11)).foregroundStyle(SessionPalette.secondary).lineLimit(1)
        .layoutPriority(1)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Return sends. Option Return adds a new line.")
    }

    /// The microphone: Stop while a dictation runs; otherwise a menu of the two modes when the setting asks, else the
    /// set mode at once. Both are drawn buttons with the kit's hover and hand cursor (a SwiftUI `Menu` has neither).
    @ViewBuilder private var voiceButton: some View {
        let icon = Image(systemName: model.voiceActive ? "stop.circle.fill" : "mic")
            .padding(.horizontal, 8).padding(.vertical, 4)
        if model.voiceActive || model.composerVoiceChoice != "ask" {
            Button(action: model.toggleVoice) { icon }
                .modifier(WidgetGlassControl())
                .foregroundStyle(model.voiceActive ? .red : .secondary)
                .instantTooltip(model.voiceActionLabel).accessibilityLabel(model.voiceActionLabel)
        } else {
            MenuButton(style: .genHoverIcon(), items: {
                [.action("Dictate into the reply box") { model.startVoice(.dictate) },
                 .action("Voice note into the reply box (keeps the recording)", enabled: model.voiceNoteClip != nil) {
                     model.startVoice(.note)
                 }]
            }) { icon }
                .modifier(WidgetGlassControl())
                .foregroundStyle(.secondary)
                .instantTooltip(model.voiceActionLabel).accessibilityLabel(model.voiceActionLabel)
        }
    }

    private func attachments(_ ids: [String], tile: CGSize, removable: Bool) -> some View {
        WidgetAttachmentStrip(
            assets: ids.compactMap { model.snapshot?.state.assets[$0] },
            manifests: model.snapshot?.manifests ?? [:], tile: tile,
            remove: removable
                ? { asset in
                    model.action([
                        "action": "remove-asset", "key": .string(model.selectedKey), "id": .string(asset.id),
                    ])
                } : nil,
            showMedia: showMedia)
    }
    private func receiptLabel(_ message: WidgetOutgoing) -> String {
        switch message.state {
        case "sent":
            return message.receipt?.channel == "session-queue" ? "Received by agent" : "Sent · " + (message.receipt?.detail ?? message.target.provider)
        case "review": return "Review the skipped video frames before sending"
        case "preparing": return "Preparing video · message saved"
        case "queued": return "Queued"
        case "dispatching": return "Sending…"
        case "waiting-route":
            return message.receipt?.channel == "session-queue" ? "Queued for this session · waiting for the agent" : "Waiting for an available session route"
        case "unknown": return "Delivery unknown · check the conversation"
        case "failed": return "Not delivered"
        default: return Self.sentenceCase(message.state)
        }
    }

    /// The sentence over a message's raw delivery error: what it means for the message and what the buttons under
    /// it can do.
    static func outgoingProblem(_ message: WidgetOutgoing) -> String {
        switch message.state {
        case "failed": return "The agent did not get this message. Retry it, or choose another destination."
        case "waiting-route": return "No session can take this message yet. It goes out when one can."
        case "unknown": return "No receipt came back. Check the conversation before you retry."
        default: return "The last attempt to send this message did not work."
        }
    }
    private func showMedia(_ selection: WidgetMediaSelection) {
        model.showMedia?(selection)
    }
    private func openReference(_ value: String) {
        if let url = URL(string: value), ["https", "http"].contains(url.scheme ?? "") {
            NSWorkspace.shared.open(url)
        } else if value.hasPrefix("/") {
            NSWorkspace.shared.open(URL(fileURLWithPath: value))
        }
    }
    private func visibleText(_ text: String) -> String {
        text.replacingOccurrences(
            of: "<from(?:Image|Video)>[\\s\\S]*?</from(?:Image|Video)>", with: "",
            options: .regularExpression)
    }
}

/// The scroll document's height for the pane's fit. macOS 15 and later read it from the scroll view itself
/// (`onScrollView: true`); before, a geometry query of the content (`onScrollView: false`) measures it, which lays out
/// every row of a lazy list on each pass. Each scroll view carries both; one of them reports.
private struct DocumentHeight: ViewModifier {
    let onScrollView: Bool
    let report: (CGFloat) -> Void

    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            if onScrollView {
                content.onScrollGeometryChange(for: CGFloat.self, of: { $0.contentSize.height.rounded() }) { _, height in
                    report(height)
                }
            } else {
                content
            }
        } else if onScrollView {
            content
        } else {
            content.onGeometryChange(for: CGFloat.self, of: \.size.height) { report($0) }
        }
    }
}

/// Dismiss and Mark complete in a session's inbox wait for their Undo note before they reach the decision log. The
/// log has no move back from a dismissed decision, and the widget's `ledger` action cannot reopen a task, so the
/// change is held here instead of undone there: the card shows its new state at once, Undo drops the change, and the
/// change goes to the log when the note goes away (it faded after the note duration setting, was closed, or a newer
/// note replaced it). Shared by every panel of the widget, and kept while a panel is closed.
@MainActor
final class WidgetLedgerUndo: ObservableObject {
    static let shared = WidgetLedgerUndo()
    /// The longest a change waits, even under a note that stays until it is closed: a change still held when the app
    /// quits is lost, so it is not held for long.
    static let longestHold: Duration = .seconds(60)

    struct Move: Equatable {
        let state: String
        /// The card's revision when the user acted. A snapshot with a newer one shows the card as it is.
        let revision: Int
    }

    private struct Hold {
        let move: Move
        let request: WidgetJSON
        let note: String
        var watch: AnyCancellable?
        var deadline: Task<Void, Never>?
    }

    /// Card id to the move the card shows.
    @Published private(set) var moves: [String: Move] = [:]
    private var holds: [String: Hold] = [:]

    /// `card` with its held or just committed move applied.
    func applied(_ card: WidgetCard) -> WidgetCard {
        guard let move = moves[card.id], move.revision == card.revision else { return card }
        var shown = card
        shown.status = move.state
        return shown
    }

    /// Moves `card` to `state` ("dismissed", "implemented") on screen now, and in the log when its note goes.
    func hold(_ card: WidgetCard, to state: String, model: WidgetModel, reduceMotion: Bool) {
        // The session is read now: the user may pick another one before the note goes.
        guard let session = model.selected?.target.sessionId, let revision = card.revision else { return }
        let id = card.id
        let move = Move(state: state, revision: revision)
        let note = Self.note(card, state: state)
        var hold = Hold(
            move: move,
            request: .object([
                "action": "ledger", "id": .string(card.sourceId), "sessionId": .string(session),
                "expectedRevision": .number(Double(revision)), "state": .string(state),
            ]),
            note: note)
        moves[id] = move
        // Folded, the card is no longer the decision the number keys and the composer answer.
        GenMotion.perform(expanding: false, reduceMotion: reduceMotion) { _ = model.foldedCardIDs.insert(id) }
        model.postNote(note, action: WidgetNoticeAction(title: "Undo") { [weak self, weak model] in
            guard let self, let model else { return }
            self.undo(id, model: model, reduceMotion: reduceMotion)
        })
        // The current value is this note; any later one (nil, or another note) means it went away.
        hold.watch = model.$notice.dropFirst().sink { [weak self, weak model] text in
            guard text != note else { return }
            Task { @MainActor [weak self, weak model] in
                guard let self, let model else { return }
                self.commit(id, model: model)
            }
        }
        hold.deadline = Task { [weak self, weak model] in
            do { try await Task.sleep(for: Self.longestHold) } catch { return }
            guard let self, let model else { return }
            self.commit(id, model: model)
        }
        holds[id] = hold
    }

    /// "DECISION 4 dismissed.", "Task 2 completed.": what changed, in the note that offers Undo.
    static func note(_ card: WidgetCard, state: String) -> String {
        let name = card.kind == "todo"
            ? card.number.map { "Task \($0)" } ?? "Task"
            : card.number.map { "DECISION \($0)" } ?? "Decision"
        return name + (state == "implemented" ? " completed." : " dismissed.")
    }

    private func commit(_ id: String, model: WidgetModel) {
        guard let hold = holds.removeValue(forKey: id) else { return }
        hold.watch?.cancel()
        hold.deadline?.cancel()
        // Its Undo could not take the change back any more.
        if model.notice == hold.note { model.notice = nil }
        model.action(hold.request, failed: { [weak self] in
            // The log refused it (the item changed elsewhere): the card shows its real state again, and the error
            // line says why.
            if self?.moves[id] == hold.move { self?.moves[id] = nil }
        }, completed: { [weak self] in
            // The card keeps its new look until a snapshot carries the newer revision; then the entry is inert.
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(30))
                if self?.moves[id] == hold.move { self?.moves[id] = nil }
            }
        })
    }

    private func undo(_ id: String, model: WidgetModel, reduceMotion: Bool) {
        guard let hold = holds.removeValue(forKey: id) else { return }
        hold.watch?.cancel()
        hold.deadline?.cancel()
        moves[id] = nil
        GenMotion.perform(expanding: true, reduceMotion: reduceMotion) { _ = model.foldedCardIDs.remove(id) }
        model.postNote("Undone.")
    }
}

/// Measured heights of LiveWidgetView's pane, its scroll viewport and the scroll document.
final class WidgetContentFit {
    static let placeholderHeight: CGFloat = 360
    var outer: CGFloat?
    var viewport: CGFloat?
    var document: CGFloat?
    var scheduled = false
}
