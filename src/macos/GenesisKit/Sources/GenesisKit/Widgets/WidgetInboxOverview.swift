import SwiftUI

/// The inbox button's view: inbox items from every session in one list, in the chosen order. A row opens in place
/// to show its session and the way to that session's whole inbox (with the entry open) and its cmux pane.
struct WidgetInboxOverview: View {
    @ObservedObject var model: WidgetModel
    /// The host supplies its fitted scroll view so that the reader and the arrival button surround the viewport.
    var viewport: (AnyView) -> AnyView = { $0 }
    @State private var belowTop = false
    @State private var readingBoundary: WidgetInboxItem?
    @State private var visibleOpenID: String?
    @State private var orderAnchor: String?
    /// The filter picked here; until then the one the `overviewFilter` setting opens with.
    @State private var filterPick: String?
    @State private var openID: String?
    /// The row Up and Down chose (`WidgetModel.listKey`); Return opens or folds it. The pointer never moves it.
    @State private var focusID: String?
    /// The option letter of the focused row's open decision that the keys chose; nil on the row itself.
    @State private var focusedOption: String?
    @GenReduceMotion private var reduceMotion

    private var filter: String { filterPick ?? model.preferences.overviewFilter }

    private var items: [WidgetInboxItem] {
        let all = model.inboxOverviewItems
        switch filter {
        case "needs": return all.filter(\.needsAnswer)
        case "unread": return all.filter { !$0.needsAnswer }
        default: return all
        }
    }

    private var grouped: Bool { model.preferences.inboxGrouping == "session" }
    private var feed: Bool { model.preferences.inboxGrouping == "feed" }

    var body: some View {
        let items = items
        let feedRows = WidgetFeedReadingPlace.split(model.inboxFeeds[filter], at: readingBoundary)
        let drawn = feed ? feedRows.runs.flatMap(\.items) : grouped ? Self.groups(items).flatMap(\.items) : items
        let _ = RenderProbe.hit("widget.overview")
        ScrollViewReader { proxy in
            viewport(AnyView(list(items, runs: feedRows.runs)))
                .overlay(alignment: .top) {
                    if feed, feedRows.pending > 0 {
                        Button(Plural.count(feedRows.pending, "new item")) {
                            readingBoundary = nil
                            proxy.scrollTo("widget.overview.top", anchor: .top)
                        }
                        .font(.system(size: 10, weight: .semibold))
                        .buttonStyle(.genHoverPlain())
                        .padding(.horizontal, 6)
                        .background(SessionPalette.blue.opacity(0.18), in: Capsule())
                        .padding(.top, 2)
                    }
                }
                .onChange(of: model.preferences.inboxGrouping) { _, _ in
                    readingBoundary = feed && belowTop ? model.inboxFeeds[filter].first?.items.first : nil
                    if let id = orderAnchor ?? visibleOpenID, id == openID { proxy.scrollTo(id, anchor: .top) }
                    orderAnchor = nil
                }
                .onChange(of: model.preferences.inboxFeedRuns) { _, _ in
                    if feed, let id = orderAnchor ?? visibleOpenID, id == openID { proxy.scrollTo(id, anchor: .top) }
                    orderAnchor = nil
                }
                .onChange(of: filter) { _, _ in
                    readingBoundary = feed && belowTop ? model.inboxFeeds[filter].first?.items.first : nil
                }
                .onChange(of: model.listKey) { _, key in
                    guard let key else { return }
                    handle(key.kind, alternate: key.alternate, rows: drawn, proxy: proxy)
                }
                .onChange(of: focusID) { _, id in model.inboxOverviewHasFocus = id != nil }
                // A row that left the list (a filter, the grouping or a snapshot) cannot keep the keys' highlight, or
                // Return would still answer it.
                .onChange(of: drawn.map(\.id)) { _, ids in
                    if let id = focusID, !ids.contains(id) {
                        focusID = nil
                        focusedOption = nil
                    }
                }
                .onDisappear { model.inboxOverviewHasFocus = false }
        }
    }

    /// The option letters of `item` when it is an open decision that waits for an answer: "a", "b", ….
    private func openOptions(_ item: WidgetInboxItem) -> [String] {
        guard openID == item.id, ["decision", "dialog"].contains(item.kind), item.needsAnswer, let options = item.options else { return [] }
        return options.indices.map(Self.letter)
    }

    static func letter(_ index: Int) -> String { WidgetOptionText.letter(index) }

    /// Up and Down move the highlight, and inside an open decision walk its options first; Return opens or folds the
    /// highlighted row, or stages the highlighted option as a click does; with "Send at once" Return does not send,
    /// as in a session's inbox. ⌘-Return (`alternate`) does the other, as ⌘-click does: it sends while a click stages,
    /// and stages while a click sends, so a keyboard user can answer in either setting (UX audit F15). No motion: keys
    /// repeat.
    private func handle(_ kind: WidgetListKey.Kind, alternate: Bool = false, rows: [WidgetInboxItem],
                        proxy: ScrollViewProxy) {
        let current = focusID.flatMap { id in rows.firstIndex { $0.id == id } }
        let options = current.map { openOptions(rows[$0]) } ?? []
        let option = focusedOption.flatMap { options.firstIndex(of: $0) }
        switch kind {
        case .open:
            guard let current else { return }
            let item = rows[current]
            if let option {
                answer(item, letter: options[option], alternate: alternate)
                return
            }
            model.releaseAgentFit()
            focusedOption = nil
            openID = openID == item.id ? nil : item.id
        case .up, .down:
            let step = kind == .up ? -1 : 1
            if !options.isEmpty {
                switch WidgetModel.optionMove(focused: option, step: step, count: options.count) {
                case .option(let index):
                    focusedOption = options[index]
                    proxy.scrollTo(rows[current ?? 0].id + "#" + options[index])
                    return
                case .cardRow:
                    focusedOption = nil
                    proxy.scrollTo(rows[current ?? 0].id)
                    return
                case .leave:
                    break
                }
            }
            guard let target = WidgetModel.listTarget(current: current, step: step, count: rows.count),
                  target != current else { return }
            focusedOption = nil
            focusID = rows[target].id
            proxy.scrollTo(rows[target].id)
        }
    }

    /// Return or ⌘-Return on an option the arrows chose. Return never sends by itself; ⌘-Return follows "⌘ does the
    /// other". `model.choose` reads ⌘ from the key event, so a send that must happen without ⌘ seen stages first and
    /// sends that staged pick.
    private func answer(_ item: WidgetInboxItem, letter: String, alternate: Bool) {
        if item.kind == "dialog" {
            if alternate {
                model.choose(item, option: letter)
            } else {
                model.postNote("Return does not send an answer. Press ⌘-Return to send it.")
            }
            return
        }
        // A set: Return ticks or unticks the option, as a click does; ⌘-Return sends the ticked set.
        if item.takesSeveral {
            if alternate {
                model.sendSet(item, orLetter: letter)
            } else {
                model.choose(item, option: letter)
            }
            return
        }
        let preferences = model.preferences
        let stages = DecisionAnswering.clickStages(preferences, command: alternate)
        let swaps = preferences.decisionCommandSwaps
        if stages {
            guard model.clickStagesNow else {
                model.postNote("Hold ⌘ with Return to stage it.")
                return
            }
            model.choose(item, option: letter)
            return
        }
        guard alternate else {
            model.postNote(swaps ? "Return does not send an answer. ⌘-Return sends it."
                                 : "Return does not send an answer. Click the option to send it.")
            return
        }
        guard model.clickStagesNow else {
            model.choose(item, option: letter)
            return
        }
        // A click would stage here, and on the staged letter it would unstage: stage only a new letter, then send.
        if model.stagedOption(item.sourceId, stored: item.draftOption)?.contains(letter) != true {
            model.choose(item, option: letter)
        }
        model.sendStaged([item.sourceId], known: [item])
    }

    private func list(_ items: [WidgetInboxItem], runs: [WidgetFeedRun]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                GenSegmentedTabs(
                    "Inbox items",
                    items: [.init("all", "All"), .init("needs", "Waiting"), .init("unread", "Unread")],
                    selection: Binding(get: { filter }, set: { value in
                        model.holdAgentFit()
                        filterPick = value
                    }), minSegmentWidth: 70, identifier: "widget.overview.filter")
                Spacer(minLength: 4)
                orderMenu
                if model.inboxCount > 0 {
                    Button("Mark all read", action: model.markAllRead)
                        .buttonStyle(.genHover()).font(.system(size: 11, weight: .medium))
                        .instantTooltip("Answers become read; older questions and decisions stop counting. Nothing is deleted.")
                }
            }
            .id("widget.overview.top")
            .onGeometryChange(for: Bool.self, of: { $0.frame(in: .scrollView).minY < -1 }) { scrolled in
                belowTop = scrolled
                readingBoundary = feed && scrolled ? model.inboxFeeds[filter].first?.items.first : nil
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
                Text(Self.summary(items) + (feed ? " · newest first" : "")).font(.system(size: 11)).foregroundStyle(.secondary)
                // Hundreds of entries: lazy, so only the rows on screen exist (swift skill, dense lists).
                LazyVStack(alignment: .leading, spacing: 10) {
                    if feed {
                        ForEach(runs) { run in
                            WidgetFeedSection(run: run, model: model, first: run.id == runs.first?.id) { item, context in
                                row(item, context: context)
                            }
                        }
                    } else if grouped {
                        ForEach(Self.groups(items), id: \.key) { group in
                            Section {
                                ForEach(group.items, id: \.id) { item in row(item, context: .sessionHeader) }
                            } header: {
                                header(group.key, items: group.items)
                            }
                        }
                    } else {
                        ForEach(items, id: \.id) { item in row(item, context: .list) }
                    }
                }
                if model.inbox.truncated {
                    Text("The newest items are shown. Open a session for its whole inbox.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
    }

    private var orderMenu: some View {
        let order = model.preferences.inboxGrouping
        return MenuButton(items: {
            var choices: [MenuButtonItem] = [("feed", "Newest first"), ("session", "By session"), ("list", "One list")]
                .map { value, title in
                    .action(title, checked: value == order) {
                        guard order != value else { return }
                        orderAnchor = visibleOpenID
                        model.holdAgentFit()
                        model.writePreferences { $0.inboxGrouping = value }
                    }
                }
            if feed {
                let perProject = model.preferences.inboxFeedRuns == "project"
                choices += [.divider, .action("Feed headers per project", checked: perProject) {
                    orderAnchor = visibleOpenID
                    model.holdAgentFit()
                    model.writePreferences { $0.inboxFeedRuns = perProject ? "session" : "project" }
                }]
            }
            return choices
        }) {
            Label(feed ? "Newest" : grouped ? "Sessions" : "List", systemImage: "line.3.horizontal.decrease")
                .font(.system(size: 11)).lineLimit(1)
        }
        .instantTooltip("Order of the inbox list")
        .accessibilityLabel(feed ? "Order of the inbox list" : grouped ? "Show one list" : "Group by session")
        .accessibilityHint("Opens the inbox order menu")
        .accessibilityIdentifier("widget.overview.grouping")
    }

    /// The sessions in the order their first entry appears (the waiting ones first), each with its entries.
    static func groups(_ items: [WidgetInboxItem]) -> [(key: String, items: [WidgetInboxItem])] {
        var order: [String] = []
        var byKey: [String: [WidgetInboxItem]] = [:]
        for item in items {
            let key = item.message?.origin.map { "sender/" + $0 } ?? item.key
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(item)
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
            Text(items.first?.message?.origin ?? session?.title ?? "Unknown session")
                .font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
            if items.count > 1 {
                Text([Plural.count(items.count, "item"), waiting > 0 ? WidgetWords.waitingShort(waiting) : nil]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11)).foregroundStyle(waiting > 0 ? Color.orange : .secondary)
            }
            Spacer(minLength: 0)
            if let session {
                IconButton(systemName: "tray", tooltip: "Open the whole inbox of " + session.title, size: 11) {
                    model.openSessionInbox(session)
                }
            }
        }
        .padding(.top, 6).padding(.horizontal, 2)
        .accessibilityElement(children: .contain)
    }

    private static func summary(_ items: [WidgetInboxItem]) -> String {
        let waiting = items.filter(\.needsAnswer).count
        let sessions = Set(items.map(\.key)).count
        return [Plural.count(items.count, "item"), waiting > 0 ? WidgetWords.waiting(waiting) : nil,
                "from " + Plural.count(sessions, "session")].compactMap { $0 }.joined(separator: " · ")
    }

    private func toggle(_ item: WidgetInboxItem) {
        let opening = openID != item.id
        model.releaseAgentFit()
        GenMotion.perform(expanding: opening, reduceMotion: reduceMotion) { openID = opening ? item.id : nil }
    }

    private func row(_ item: WidgetInboxItem, context: WidgetInboxRowContext) -> some View {
        let open = openID == item.id
        let focused = focusID == item.id
        return WidgetInboxEntry(model: model, item: item, open: open, focused: focused, context: context,
                                focusedOption: focusedOption, toggle: { toggle(item) })
            .onGeometryChange(for: Bool.self, of: { geometry in
                guard open, let viewport = geometry.bounds(of: .scrollView) else { return false }
                return CGRect(origin: .zero, size: geometry.size).intersects(viewport)
            }) { visible in
                if visible { visibleOpenID = item.id }
                else if visibleOpenID == item.id { visibleOpenID = nil }
            }
            .onDisappear { if visibleOpenID == item.id { visibleOpenID = nil } }
    }

    static func title(_ item: WidgetInboxItem) -> String {
        if let title = item.title, !title.isEmpty {
            return WidgetWords.numbered(title, number: item.number)
        }
        return kindLabel(item)
    }

    static func kindLabel(_ item: WidgetInboxItem) -> String {
        if item.needsAnswer { return item.kind == "decision" ? "Decision · waiting for your answer" : "Waiting for your answer" }
        switch item.kind {
        case "answer" where item.tag == "message": return "New message"
        case "answer": return "New answer"
        case "result": return "Agent result"
        // Words, never the wire kind: "Todo" and "Form" read as raw data.
        case "todo": return "Task"
        case "form": return "Question"
        default: return LiveWidgetView.sentenceCase(item.kind)
        }
    }
}

/// The head of one overview entry, from values: the dot, kind, title, staged line, kind, session and age, the ×count
/// and the chevron. It is a button (open or fold the entry) and the count has its tooltip only while live (`liveRow`:
/// hovered, open, or the keyboard's row); at rest it draws the same labels with no control, so a model publish
/// re-renders only the entries whose values changed and an accessibility client walks no buttons of the hundreds of
/// entries at rest (swift skill, "Dense lists and accessibility clients"). VoiceOver still presses it (`rowButton`).
struct WidgetInboxOverviewRow: View, Equatable {
    let item: WidgetInboxItem
    let open: Bool
    /// The keyboard's row.
    let focused: Bool
    /// Only the source information that the enclosing group has not already identified.
    let source: String?
    /// The staged pick or note of a waiting decision with where its send is, read from the model by the parent.
    let stagedLine: WidgetStageLine?
    let toggle: () -> Void

    static func == (a: WidgetInboxOverviewRow, b: WidgetInboxOverviewRow) -> Bool {
        a.item == b.item && a.open == b.open && a.focused == b.focused
            && a.source == b.source && a.stagedLine == b.stagedLine
    }

    var body: some View {
        let _ = RenderProbe.hit("widget.overview.row.body")
        labels
            .rowButton(cornerRadius: 11) { toggle() }
            .accessibilityLabel(WidgetInboxOverview.kindLabel(item) + ": " + WidgetInboxOverview.title(item))
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityAddTraits(focused ? .isSelected : [])
            .accessibilityIdentifier("widget.overview.row." + item.id)
            .liveRow(selected: open || focused)
    }

    private var labels: some View {
        // A decision being sent or sent no longer waits for an answer, though the snapshot still says so for a moment.
        let waiting = item.needsAnswer && !(stagedLine?.phase.onItsWay ?? false)
        return HStack(alignment: .top, spacing: 9) {
            Circle().fill(waiting ? Color.orange : SessionPalette.blue)
                .frame(width: 7, height: 7).padding(.top, 5)
            Image(systemName: LiveWidgetView.kindSymbol(item.kind)).font(.system(size: 11))
                .foregroundStyle(.secondary).frame(width: 14).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(WidgetInboxOverview.title(item)).font(.system(size: 12.5, weight: open ? .semibold : .medium))
                    .lineLimit(open ? 6 : 2).fixedSize(horizontal: false, vertical: true)
                if let askedIn = item.askedIn, !askedIn.isEmpty {
                    WidgetAskedInLine(askedIn)
                }
                if let stagedLine {
                    stagedLine
                }
                HStack(spacing: 4) {
                    if let source {
                        Text(source).lineLimit(1).truncationMode(.middle).help(source)
                        Text("·")
                    }
                    // A decision on its way reads "Decision", no longer its waiting label.
                    let kind = waiting || !item.needsAnswer ? WidgetInboxOverview.kindLabel(item) : "Decision"
                    if WidgetInboxOverview.title(item) != kind {
                        Text(kind).lineLimit(1)
                        Text("·")
                    }
                    LiveAgo(date: Date(timeIntervalSince1970: item.at / 1000), style: .spelled).fixedSize()
                }.font(.system(size: 11)).foregroundStyle(waiting ? Color.orange : SessionPalette.secondary)
            }
            Spacer(minLength: 4)
            if let count = item.count, count > 1 {
                Text(verbatim: "×\(count)").font(.system(size: 10, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(.secondary).padding(.top, 3)
                    .instantTooltip("\(count) items like this one in this session")
            }
            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary).rotationEffect(.degrees(open ? 90 : 0)).padding(.top, 4)
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
