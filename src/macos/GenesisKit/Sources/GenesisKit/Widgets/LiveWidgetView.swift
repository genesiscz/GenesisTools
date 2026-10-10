import AppKit
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
    /// Inbox rows the user folded. The open row is the selected card, the one the composer answers.
    @State private var collapsedCards: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var systemReduceMotion
    /// An unknown delivery the user checked in the conversation and wants to drop, so later follow-ups can go.
    @State private var discard: WidgetOutgoing?
    @FocusState private var editing: Bool

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
                select: { model.select($0, edge: edge) }, choose: { model.submit(choice: $0) },
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
                HStack {
                    Text(notice).font(.caption).foregroundStyle(.secondary)
                    Spacer()
                    IconButton(systemName: "xmark", tooltip: "Dismiss this note") { model.notice = nil }
                }
            }
            if let error = model.error {
                HStack(alignment: .top) {
                    Text(error).font(.system(size: 11)).foregroundStyle(.orange).textSelection(.enabled)
                        .lineLimit(4)
                    Spacer(minLength: 4)
                    IconButton(systemName: "xmark", tooltip: "Dismiss this error") { model.error = nil }
                }
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
            GenSegmentedTabs("View", items: sectionItems, selection: Binding(get: { section }, set: { section = $0 }))
                .accessibilityIdentifier("widget.sections")
            if model.snapshot == nil || (model.selected == nil && model.snapshot?.rosterLoading == true) {
                VStack(spacing: 12) {
                    ProgressView()
                    Text("Connecting to your local agents…").font(.callout).foregroundStyle(.secondary)
                    if model.error != nil || model.connectionLost { Button("Reconnect", action: model.start) }
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
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
                ScrollViewReader { reader in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 14) {
                            if section == "Inbox" {
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
                    }
                        .modifier(LatestScrollAnchor(enabled: section == "Conversation", identity: model.selectedKey))
                        .onChange(of: WidgetOutgoingPosition(session: model.selectedKey, messageID: model.outgoing.last?.id)) { previous, next in
                            guard section == "Inbox", previous.session == next.session, let id = next.messageID else { return }
                            ScrollViewPositioning.scroll(reader, to: "outgoing-" + id, anchor: .bottom)
                        }
                        // Outermost, so the scroll view's own anchor modifiers still sit directly on it.
                        .scrollOverflowHints()
                }
                if section != "Sessions" { composer }
            }
        }
        .mediaPreviewHost()
        .padding(18).frame(maxWidth: .infinity, maxHeight: .infinity)
        .onDrop(of: [.fileURL], isTargeted: nil) { providers in
            for provider in providers {
                _ = provider.loadObject(ofClass: URL.self) { url, error in
                    Task { @MainActor in
                        if let url {
                            model.importFile(url)
                        } else if let error {
                            model.error = error.localizedDescription
                        }
                    }
                }
            }
            return !providers.isEmpty
        }
    }

    private var header: some View {
        HStack(spacing: 9) {
            Button {
                choosingSession = true
            } label: {
                VStack(alignment: .leading, spacing: 3) {
                    Text(model.selected?.title ?? "Agent inbox").font(.system(size: 13, weight: .semibold))
                        .lineLimit(1)
                    Text(
                        [model.selected?.target.provider.capitalized, model.selected?.project].compactMap { $0 }
                            .joined(separator: " · ")
                    )
                    .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
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
            .onChange(of: choosingSession) { _, value in model.dialogOpen = value }
            Spacer(minLength: 0)
            IconButton(systemName: "pin.slash", tooltip: "Unpin this session from the widget", action: model.unpinSelected)
                .accessibilityLabel("Unpin selected session")
            IconButton(systemName: "rectangle.on.rectangle", tooltip: "Open this session in Hub") {
                model.openHub?(model.selected)
            }
            .accessibilityLabel("Open session in Hub")
            IconButton(systemName: "slider.horizontal.3", tooltip: "Widget settings and filters") {
                model.showSettings?()
            }
            .accessibilityLabel("Widget settings")
            IconButton(systemName: "xmark", tooltip: "Collapse (Esc)", action: model.collapse)
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
    @ViewBuilder private var inbox: some View {
        if !model.cards.isEmpty {
            HStack(spacing: 8) {
                Text(inboxHeadline).font(.system(size: 11)).foregroundStyle(.secondary)
                Spacer()
                markAllReadButton
            }
            ForEach(model.cards.reversed()) { card in
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
        let cards = model.cards
        let waiting = cards.filter(\.needsAnswer).count
        let unread = cards.filter { !$0.read && !$0.needsAnswer }.count
        return [cards.count == 1 ? "1 item" : "\(cards.count) items",
                waiting > 0 ? "\(waiting) need your answer" : nil,
                unread > 0 ? "\(unread) unread" : nil].compactMap { $0 }.joined(separator: " · ")
    }

    private func isOpen(_ card: WidgetCard) -> Bool {
        card.id == model.card?.id && !collapsedCards.contains(card.id)
    }

    private func toggle(_ card: WidgetCard) {
        if isOpen(card) {
            collapsedCards.insert(card.id)
        } else {
            collapsedCards.remove(card.id)
            model.openCard(card)
        }
    }

    private func inboxRow(_ card: WidgetCard) -> some View {
        let open = isOpen(card)
        return VStack(alignment: .leading, spacing: 0) {
            Button { toggle(card) } label: {
                HStack(alignment: .top, spacing: 9) {
                    Circle()
                        .fill(card.needsAnswer ? Color.orange : (card.read ? Color.clear : SessionPalette.blue))
                        .frame(width: 7, height: 7).padding(.top, 5)
                    Image(systemName: Self.kindSymbol(card.kind)).font(.system(size: 11))
                        .foregroundStyle(.secondary).frame(width: 14).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(card.title).font(.system(size: 12.5, weight: open ? .semibold : .medium))
                            .lineLimit(open ? 4 : 2).fixedSize(horizontal: false, vertical: true)
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
                        .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: open)
                        .padding(.top, 4)
                }
                .padding(.horizontal, 10).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 11))
            .accessibilityLabel(Self.kindLabel(card) + ": " + card.title)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityIdentifier("widget.inbox.row." + card.id)
            if open {
                cardDetail(card).padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 12)
            }
        }
        .background(Color.white.opacity(open ? 0.055 : 0.03), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(card.needsAnswer ? Color.orange.opacity(0.28) : .clear, lineWidth: 1))
    }

    @ViewBuilder private func cardDetail(_ card: WidgetCard) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            WidgetReceiptContextView(card: card, model: model)
                .id(card.id + "|" + String(card.at))
            if !card.body.isEmpty {
                WidgetMarkdown(text: card.body)
            }
            if !card.attachments.isEmpty {
                WidgetCardAttachments(card: card, height: 110, maxWidth: 260, compare: true, showMedia: showMedia)
            }
            if card.needsAnswer {
                if card.kind == "form" {
                    ForEach(card.formItems ?? []) { item in
                        formItem(item, card: card, showsPrompt: (card.formItems?.count ?? 0) != 1)
                            .disabled(model.cardPending)
                    }
                    Button(model.cardPending ? "Answer queued" : "Send answers") { model.submit(answering: true) }
                        .buttonStyle(.borderedProminent).pointerCursor(!model.cardPending)
                        .disabled(model.importing > 0 || model.cardPending)
                } else {
                    ForEach(Array(card.choices.enumerated()), id: \.element.id) { index, choice in
                        Button {
                            model.submit(choice: choice.id)
                        } label: {
                            HStack(alignment: .top, spacing: 8) {
                                Text(verbatim: choice.id).font(.system(size: 10.5, weight: .semibold, design: .rounded))
                                    .frame(width: 20, height: 20).background(
                                        .white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
                                Text(Self.choiceText(choice)).font(.system(size: 12)).fixedSize(
                                    horizontal: false, vertical: true)
                                    .padding(.top, 2)
                                Spacer(minLength: 0)
                                if choice.recommended {
                                    Image(systemName: "sparkle").foregroundStyle(.orange)
                                }
                            }.padding(9).frame(maxWidth: .infinity, alignment: .leading)
                                .background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 9))
                                .contentShape(RoundedRectangle(cornerRadius: 9))
                        }
                        .buttonStyle(RowButtonStyle(cornerRadius: 9)).disabled(model.importing > 0)
                        .instantTooltip("Answer \(choice.id)" + (choice.recommended ? " (recommended)" : "")
                                        + (index < 9 ? " · key \(index + 1)" : ""))
                        .accessibilityLabel("Answer \(choice.id): " + Self.choiceText(choice))
                    }
                }
            }
            HStack(spacing: 8) {
                if card.kind == "todo" && ["open", "acknowledged"].contains(card.status) {
                    if card.status == "open" {
                        Button("Acknowledge") { model.ledger(card, state: "acknowledged") }
                    }
                    Button("Mark complete") { model.ledger(card, state: "implemented") }
                    Button("Dismiss") { model.ledger(card, state: "dismissed") }
                } else if card.kind == "decision" && card.needsAnswer {
                    Button("Save draft") { model.ledger(card, state: "drafted") }
                    Button("Dismiss") { model.ledger(card, state: "dismissed") }
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
                Button(ref.value) { openReference(ref.value) }.buttonStyle(.link).font(.caption).lineLimit(1)
                    .truncationMode(.middle).pointerCursor()
            }
        }
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

    static func kindLabel(_ card: WidgetCard) -> String {
        if card.needsAnswer { return "Needs your answer" }
        switch card.kind {
        case "answer": return card.read ? "Answer" : "New answer"
        case "result": return card.read ? "Agent result" : "New agent result"
        case "todo": return "Task · " + WidgetTask.label(for: card.status)
        default: return card.kind.capitalized + " · " + card.status.capitalized
        }
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

    /// The option text without a letter the agent already wrote ("a) Record…"); the badge shows the letter.
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
                        Text(card.kind.capitalized + " · " + card.status).font(.caption2).foregroundStyle(
                            .secondary)
                        Text(card.title).font(.system(size: 12, weight: .semibold)).textSelection(.enabled)
                        if !card.body.isEmpty {
                            WidgetMarkdown(text: card.body)
                        }
                        if !card.attachments.isEmpty {
                            WidgetCardAttachments(card: card, height: 64, maxWidth: 140, compare: false, showMedia: showMedia)
                        }
                        if card.needsAnswer {
                            Button("Answer this question") {
                                collapsedCards.remove(card.id)
                                model.selectedCardID = card.id
                                section = "Inbox"
                            }.buttonStyle(.genHover())
                        }
                    }.padding(10).background(.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 11))
                case .outgoing(let message):
                    outgoing(message)
                case .activity(let event):
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "clock.arrow.circlepath").foregroundStyle(.secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(event.title).font(.caption)
                            Text(event.sourceId + " · " + event.body).font(.caption2).foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        if model.transcriptLoading {
            ProgressView("Loading recent conversation…").controlSize(.small)
        } else if timeline.isEmpty && model.transcriptError == nil {
            Text("There are no recorded messages for this session yet.").font(.caption).foregroundStyle(.secondary)
        }
    }

    private struct TimelineItem: Identifiable {
        enum Event {
            case turn(TranscriptTurn)
            case card(WidgetCard)
            case outgoing(WidgetOutgoing)
            case activity(WidgetActivityEvent)
        }
        let id: String
        let date: Date
        let event: Event
    }
    private var timeline: [TimelineItem] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        let turns = model.transcript.filter { !$0.text.isEmpty }.map { turn in
            TimelineItem(
                id: "turn:" + turn.id,
                date: turn.at.flatMap { iso.date(from: $0) ?? plain.date(from: $0) } ?? .distantPast,
                event: .turn(turn))
        }
        let cards = model.cards.map {
            TimelineItem(id: $0.id, date: Date(timeIntervalSince1970: $0.at / 1000), event: .card($0))
        }
        let outgoing = model.outgoing.map {
            TimelineItem(
                id: "out:" + $0.id, date: Date(timeIntervalSince1970: $0.createdAt / 1000),
                event: .outgoing($0))
        }
        let activity = (model.snapshot?.activity ?? []).map {
            TimelineItem(id: "event:" + $0.id, date: Date(timeIntervalSince1970: $0.at / 1000), event: .activity($0))
        }
        return (turns + cards + outgoing + activity).sorted {
            $0.date == $1.date ? $0.id < $1.id : $0.date < $1.date
        }
    }

    @ViewBuilder private var changes: some View {
        if let changes = model.snapshot?.changes, changes.available {
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
                Text(error).font(.caption2).foregroundStyle(.orange).textSelection(.enabled)
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

    private var composer: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !model.draft.assetIds.isEmpty {
                attachments(model.draft.assetIds, tile: CGSize(width: 88, height: 60), removable: true)
            }
            if model.voiceActive {
                HStack(spacing: 8) {
                    Image(systemName: "waveform").foregroundStyle(.red)
                    Text(
                        model.voiceText.isEmpty ? "Listening… tap Stop to edit the transcript" : model.voiceText
                    )
                    .font(.caption).lineLimit(2)
                    Spacer()
                    ProgressView(value: min(1, model.voiceLevel * 5)).frame(width: 40)
                }
            }
            if model.importing > 0 {
                ProgressView("Saving attachment…").controlSize(.small).font(.caption)
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(
                    "Reply to " + (model.selected?.target.provider.capitalized ?? "agent") + "…",
                    text: Binding(get: { model.draft.text }, set: model.setText), axis: .vertical
                )
                .textFieldStyle(.plain).font(.system(size: 12)).lineLimit(1...4).focused($editing)
                .onSubmit {
                    model.submit(
                        answering: model.card?.kind == "decision" && model.card?.needsAnswer == true
                            && !model.cardPending)
                }
                .accessibilityLabel("Reply to selected agent")
                Button {
                    model.submit(
                        answering: model.card?.kind == "decision" && model.card?.needsAnswer == true
                            && !model.cardPending)
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 23)).foregroundStyle(.blue)
                }.buttonStyle(.genHoverIcon(accent: .blue, diameter: 28)).disabled(model.importing > 0)
                    .instantTooltip("Send (Return)").accessibilityLabel("Send reply")
            }
            HStack(spacing: 15) {
                Button(action: model.chooseFiles) { Image(systemName: "paperclip") }.instantTooltip(
                    "Attach images or videos"
                ).accessibilityLabel("Attach media")
                Button {
                    _ = model.pasteMedia()
                } label: {
                    Image(systemName: "clipboard")
                }.instantTooltip("Paste image or video (⌘V)").accessibilityLabel("Paste media")
                Button(action: model.capture) { Image(systemName: "camera") }.instantTooltip("Capture a screenshot")
                    .accessibilityLabel("Capture screenshot")
                Button(action: model.toggleVoice) {
                    Image(systemName: model.voiceActive ? "stop.circle.fill" : "mic").padding(.horizontal, 8)
                        .padding(.vertical, 4)
                }
                .modifier(WidgetGlassControl())
                .foregroundStyle(model.voiceActive ? .red : .secondary)
                .instantTooltip(model.voiceActionLabel).accessibilityLabel(model.voiceActionLabel)
                Spacer()
                Text("⌘V media · Esc close").font(.system(size: 9)).foregroundStyle(.tertiary)
            }.font(.system(size: 12)).foregroundStyle(.secondary).buttonStyle(.genHoverIcon())
        }
        .padding(11).background(.white.opacity(0.065), in: RoundedRectangle(cornerRadius: 13))
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
        default: return message.state.capitalized
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
