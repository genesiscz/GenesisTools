import SwiftUI

/// The inbox button's view: inbox entries from every session in one list, the waiting ones first. A row opens in place
/// to show its session and the way to that session's whole inbox (with the entry open) and its cmux pane.
struct WidgetInboxOverview: View {
    @ObservedObject var model: WidgetModel
    /// The filter picked here; until then the one the `overviewFilter` setting opens with.
    @State private var filterPick: String?
    @State private var openID: String?
    /// The row Up and Down chose (`WidgetModel.listKey`); Return opens or folds it. The pointer never moves it.
    @State private var focusID: String?
    @GenReduceMotion private var reduceMotion

    private var filter: String { filterPick ?? model.snapshot?.state.preferences.overviewFilter ?? "all" }

    private var items: [WidgetInboxItem] {
        let all = model.inboxOverviewItems
        switch filter {
        case "needs": return all.filter(\.needsAnswer)
        case "unread": return all.filter { !$0.needsAnswer }
        default: return all
        }
    }

    /// Entries under their session ("session", the default) or one list (Widgets → Inbox, and the header button).
    private var grouped: Bool { (model.snapshot?.state.preferences.inboxGrouping ?? "session") == "session" }

    /// The rows in the order they are drawn: grouped under their sessions, or the one list.
    private func drawnOrder(_ items: [WidgetInboxItem]) -> [WidgetInboxItem] {
        grouped ? Self.groups(items).flatMap(\.items) : items
    }

    var body: some View {
        let items = items
        let _ = RenderProbe.hit("widget.overview")
        // Inside the pane's scroll view: the proxy scrolls the row the keys chose into view.
        ScrollViewReader { proxy in
            list(items)
                .onChange(of: model.listKey) { _, key in
                    guard let key else { return }
                    handle(key.kind, rows: drawnOrder(items), proxy: proxy)
                }
        }
    }

    /// Up and Down move the highlight, Return opens or folds the highlighted row. No motion: keys repeat.
    private func handle(_ kind: WidgetListKey.Kind, rows: [WidgetInboxItem], proxy: ScrollViewProxy) {
        let current = focusID.flatMap { id in rows.firstIndex { $0.id == id } }
        switch kind {
        case .open:
            guard let current else { return }
            let id = rows[current].id
            model.releaseAgentFit()
            openID = openID == id ? nil : id
        case .up, .down:
            guard let target = WidgetModel.listTarget(current: current, step: kind == .up ? -1 : 1, count: rows.count)
            else { return }
            focusID = rows[target].id
            proxy.scrollTo(rows[target].id)
        }
    }

    private func list(_ items: [WidgetInboxItem]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                GenSegmentedTabs(
                    "Inbox entries",
                    items: [.init("all", "All"), .init("needs", "Needs you"), .init("unread", "Unread")],
                    selection: Binding(get: { filter }, set: { value in
                        model.holdAgentFit()
                        filterPick = value
                    }), minSegmentWidth: 70, identifier: "widget.overview.filter")
                Spacer(minLength: 4)
                IconButton(systemName: grouped ? "list.bullet" : "rectangle.3.group",
                           tooltip: grouped ? "Show one list" : "Group the entries by session") {
                    model.holdAgentFit()
                    model.updatePreferences(["inboxGrouping": .string(grouped ? "list" : "session")])
                }.accessibilityLabel(grouped ? "Show one list" : "Group by session")
                if model.inboxCount > 0 {
                    Button("Mark all read", action: model.markAllRead)
                        .buttonStyle(.genHover()).font(.system(size: 11, weight: .medium))
                        .instantTooltip("Answers become read; older questions and decisions stop counting. Nothing is deleted.")
                }
            }
            if items.isEmpty {
                VStack(spacing: 10) {
                    GenesisWidgetMark()
                    Text(filter == "needs" ? "Nothing waits for your answer." : "Nothing new in the inbox.")
                        .font(.headline)
                    Text("Questions, screenshots and finished work from every session land here.")
                        .font(.caption).foregroundStyle(.secondary)
                }.frame(maxWidth: .infinity).padding(.vertical, 28)
            } else {
                Text(Self.summary(items)).font(.system(size: 11)).foregroundStyle(.secondary)
                // Hundreds of entries: lazy, so only the rows on screen exist (swift skill, dense lists).
                LazyVStack(alignment: .leading, spacing: 10) {
                    if grouped {
                        ForEach(Self.groups(items), id: \.key) { group in
                            Section {
                                ForEach(group.items, id: \.id) { item in row(item) }
                            } header: {
                                header(group.key, items: group.items)
                            }
                        }
                    } else {
                        ForEach(items, id: \.id) { item in row(item) }
                    }
                }
                if model.inbox.truncated {
                    Text("The newest entries are shown. Open a session for its whole inbox.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    /// The sessions in the order their first entry appears (the waiting ones first), each with its entries.
    static func groups(_ items: [WidgetInboxItem]) -> [(key: String, items: [WidgetInboxItem])] {
        var order: [String] = []
        var byKey: [String: [WidgetInboxItem]] = [:]
        for item in items {
            if byKey[item.key] == nil { order.append(item.key) }
            byKey[item.key, default: []].append(item)
        }
        return order.map { ($0, byKey[$0] ?? []) }
    }

    private func header(_ key: String, items: [WidgetInboxItem]) -> some View {
        let session = model.session(forKey: key)
        let waiting = items.filter(\.needsAnswer).count
        return HStack(spacing: 7) {
            if let session {
                AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 14)
            }
            Text(session?.title ?? "Unknown session").font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
            Text([Plural.count(items.count, "entry", "entries"), waiting > 0 ? "\(waiting) need you" : nil]
                .compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 10)).foregroundStyle(waiting > 0 ? Color.orange : .secondary)
            Spacer(minLength: 0)
            if let session {
                Button("Whole inbox") {
                    model.select(session.key)
                    model.section = "Inbox"
                }.buttonStyle(.genHoverPlain()).font(.system(size: 10.5))
            }
        }
        .padding(.top, 6).padding(.horizontal, 2)
        .accessibilityElement(children: .combine)
    }

    private static func summary(_ items: [WidgetInboxItem]) -> String {
        let waiting = items.filter(\.needsAnswer).count
        let sessions = Set(items.map(\.key)).count
        return [Plural.count(items.count, "entry", "entries"), waiting > 0 ? "\(waiting) need your answer" : nil,
                "from " + Plural.count(sessions, "session")].compactMap { $0 }.joined(separator: " · ")
    }

    private func toggle(_ item: WidgetInboxItem) {
        let opening = openID != item.id
        model.releaseAgentFit()
        GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) { openID = opening ? item.id : nil }
    }

    private func row(_ item: WidgetInboxItem) -> some View {
        let open = openID == item.id
        let focused = focusID == item.id
        let session = model.session(forKey: item.key)
        return VStack(alignment: .leading, spacing: 0) {
            Button { toggle(item) } label: {
                HStack(alignment: .top, spacing: 9) {
                    Circle().fill(item.needsAnswer ? Color.orange : SessionPalette.blue)
                        .frame(width: 7, height: 7).padding(.top, 5)
                    Image(systemName: LiveWidgetView.kindSymbol(item.kind)).font(.system(size: 11))
                        .foregroundStyle(.secondary).frame(width: 14).padding(.top, 1)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(Self.title(item)).font(.system(size: 12.5, weight: open ? .semibold : .medium))
                            .lineLimit(open ? 6 : 2).fixedSize(horizontal: false, vertical: true)
                        if let staged = stagedLine(item) {
                            Text("Staged: " + staged).font(.system(size: 11)).foregroundStyle(SessionPalette.blue)
                                .lineLimit(1)
                        }
                        HStack(spacing: 4) {
                            Text(Self.kindLabel(item))
                            Text("·")
                            // Under its session header the row does not repeat the session.
                            if !grouped {
                                Text(session?.title ?? "Unknown session").lineLimit(1)
                                Text("·")
                            }
                            LiveAgo(date: Date(timeIntervalSince1970: item.at / 1000), style: .brief)
                        }.font(.system(size: 10)).foregroundStyle(item.needsAnswer ? Color.orange : .secondary)
                    }
                    Spacer(minLength: 4)
                    if let count = item.count, count > 1 {
                        Text(verbatim: "×\(count)").font(.system(size: 10, weight: .semibold)).monospacedDigit()
                            .foregroundStyle(.secondary).padding(.top, 3)
                            .instantTooltip("\(count) entries like this one in this session")
                    }
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary).rotationEffect(.degrees(open ? 90 : 0)).padding(.top, 4)
                }
                .padding(.horizontal, 10).padding(.vertical, 9)
                .frame(maxWidth: .infinity, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 11))
            .accessibilityLabel(Self.kindLabel(item) + ": " + Self.title(item))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(focused ? .isSelected : [])
            .accessibilityIdentifier("widget.overview.row." + item.id)
            if open {
                detail(item, session: session).padding(.horizontal, 12).padding(.top, 2).padding(.bottom, 12)
                    .transition(.genReveal)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 11))
        .background(Color.white.opacity(open ? 0.055 : 0.03), in: RoundedRectangle(cornerRadius: 11))
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(item.needsAnswer ? Color.orange.opacity(0.28) : .clear, lineWidth: 1))
        // The keyboard's row: a focus ring, the look of the system's own.
        .overlay(RoundedRectangle(cornerRadius: 11)
            .strokeBorder(focused ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear, lineWidth: 2))
        .id(item.id)
    }

    private func stagedLine(_ item: WidgetInboxItem) -> String? {
        let option = model.stagedOption(item.sourceId, stored: item.draftOption)
        guard item.kind == "decision", item.needsAnswer, option != nil || item.draft != nil else { return nil }
        return WidgetStagedText.line(item, option: option)
    }

    /// An open decision's options, each staging (or sending, by the setting) that pick from here.
    @ViewBuilder private func choices(_ item: WidgetInboxItem) -> some View {
        if item.kind == "decision", item.needsAnswer, let options = item.options, !options.isEmpty {
            let staged = model.stagedOption(item.sourceId, stored: item.draftOption)
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(options.enumerated()), id: \.offset) { index, title in
                    let letter = String(UnicodeScalar(97 + index).map(Character.init) ?? "?")
                    let picked = staged == letter
                    Button { model.choose(item, option: letter) } label: {
                        HStack(alignment: .top, spacing: 8) {
                            Text(verbatim: letter).font(.system(size: 10.5, weight: .semibold, design: .rounded))
                                .frame(width: 20, height: 20).background(.white.opacity(0.07), in: RoundedRectangle(cornerRadius: 5))
                            Text(title).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true).padding(.top, 2)
                            Spacer(minLength: 0)
                            if picked {
                                Text("Staged").font(.system(size: 10, weight: .semibold)).foregroundStyle(SessionPalette.blue)
                                    .padding(.top, 3)
                            }
                            if item.recommended == letter { Image(systemName: "sparkle").foregroundStyle(.orange) }
                        }
                        .padding(8).frame(maxWidth: .infinity, alignment: .leading)
                        .background(picked ? SessionPalette.blue.opacity(0.16) : .white.opacity(0.06),
                                    in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(picked ? SessionPalette.blue.opacity(0.7) : .clear, lineWidth: 1))
                        .contentShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(RowButtonStyle(cornerRadius: 8))
                    .instantTooltip(LiveWidgetView.choiceTooltip(
                        WidgetChoice(id: letter, title: title, recommended: item.recommended == letter),
                        index: 10, stages: model.decisionClickStages, picked: picked))
                    .accessibilityLabel((model.decisionClickStages ? "Stage " : "Answer ") + letter + ": " + title)
                    .accessibilityValue(picked ? "Staged" : "")
                }
            }
        }
    }

    private func detail(_ item: WidgetInboxItem, session: WidgetSession?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            choices(item)
            if let session {
                HStack(spacing: 8) {
                    AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 18)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(session.title).font(.system(size: 11.5, weight: .medium)).lineLimit(1)
                        Text([session.project, session.visualStatus.label, String(session.target.sessionId.prefix(8))]
                            .filter { !$0.isEmpty }.joined(separator: " · "))
                            .font(.system(size: 10)).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            HStack(spacing: 8) {
                Button(item.needsAnswer ? "Answer in its session" : "Open in its session") { model.openInboxItem(item) }
                    .buttonStyle(.genHover(accent: item.needsAnswer ? .orange : KitTheme.accent))
                    .accessibilityIdentifier("widget.overview.open." + item.id)
                if let session {
                    Button("Whole inbox") {
                        model.select(session.key)
                        model.section = "Inbox"
                    }.buttonStyle(.genHover())
                    Spacer(minLength: 0)
                    WidgetCmuxButton(model: model, session: session, size: 12)
                }
            }.font(.caption)
        }
    }

    static func title(_ item: WidgetInboxItem) -> String {
        if let title = item.numberedTitle, item.title?.isEmpty == false {
            return title
        }
        return kindLabel(item)
    }

    static func kindLabel(_ item: WidgetInboxItem) -> String {
        if item.needsAnswer { return item.kind == "decision" ? "Decision · needs your answer" : "Needs your answer" }
        switch item.kind {
        case "answer": return "New answer"
        case "result": return "Agent result"
        default: return item.kind.capitalized
        }
    }
}
