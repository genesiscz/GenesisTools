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
    @State private var openID: String?
    /// The row Up and Down chose (`WidgetModel.listKey`); Return opens or folds it. The pointer never moves it.
    @State private var focusID: String?
    /// The option letter of the focused row's open decision that the keys chose; nil on the row itself.
    @State private var focusedOption: String?
    @GenReduceMotion private var reduceMotion

    private var filter: String { model.overviewFilterPick ?? model.preferences.overviewFilter }

    private var items: [WidgetInboxItem] {
        let all = model.inboxOverviewItems
        switch filter {
        // A decision a send took no longer waits, though a snapshot from before the send still says so.
        case "needs": return all.filter(model.waitsForAnswer)
        case "unread": return all.filter(\.isUnreadEntry)
        default: return all
        }
    }

    /// The feed's runs for the filter. Waiting leaves out the decisions a send took, as `items` does; the runs are
    /// stored per snapshot, while a send changes between snapshots.
    private var feedRuns: [WidgetFeedRun] {
        let runs = model.inboxFeeds[filter]
        guard filter == "needs" else { return runs }
        return runs.compactMap { run in
            var kept = run
            kept.items = run.items.filter(model.waitsForAnswer)
            return kept.items.isEmpty ? nil : kept
        }
    }

    private var grouped: Bool { model.preferences.inboxGrouping == "session" }
    private var feed: Bool { model.preferences.inboxGrouping == "feed" }

    var body: some View {
        let items = items
        let feedRows = WidgetFeedReadingPlace.split(feedRuns, at: readingBoundary)
        let drawn = feed ? feedRows.runs.flatMap(\.items) : grouped ? Self.groups(items).flatMap(\.items) : items
        let _ = RenderProbe.hit("widget.overview")
        VStack(alignment: .leading, spacing: 8) {
            controls
            scrolledList(items: items, feedRows: feedRows, drawn: drawn)
        }
    }

    private func scrolledList(items: [WidgetInboxItem],
                              feedRows: (runs: [WidgetFeedRun], pending: Int, replacement: WidgetInboxItem?),
                              drawn: [WidgetInboxItem]) -> some View {
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
                    readingBoundary = feed && belowTop ? feedRuns.first?.items.first : nil
                    if let id = orderAnchor ?? visibleOpenID, id == openID { proxy.scrollTo(id, anchor: .top) }
                    orderAnchor = nil
                }
                .onChange(of: model.preferences.inboxFeedRuns) { _, _ in
                    if feed, let id = orderAnchor ?? visibleOpenID, id == openID { proxy.scrollTo(id, anchor: .top) }
                    orderAnchor = nil
                }
                .onChange(of: feedRows.replacement?.id, initial: true) { _, _ in
                    if feed, belowTop, let replacement = feedRows.replacement {
                        readingBoundary = replacement
                    }
                }
                .onChange(of: filter) { _, _ in
                    readingBoundary = nil
                    proxy.scrollTo("widget.overview.top", anchor: .top)
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
            model.postNote(swaps ? "Click the option to send it, or press ⌘-Return to stage it."
                                 : "Press ⌘-Return to send this option.")
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

    private var controls: some View {
        HStack(spacing: 6) {
            GenSegmentedTabs(
                "Inbox items",
                items: [.init("all", "All"), .init("needs", "Waiting"), .init("unread", "Unread")],
                selection: Binding(get: { filter }, set: { value in
                    model.holdAgentFit()
                    model.overviewFilterPick = value
                }), minSegmentWidth: 54, identifier: "widget.overview.filter", fillsWidth: true)
            Spacer(minLength: 4)
            orderMenu
            if model.inboxCount > 0 {
                WidgetMarkAllReadButton(model: model)
            }
        }
    }

    private func list(_ items: [WidgetInboxItem], runs: [WidgetFeedRun]) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 1)
                .accessibilityHidden(true)
                .id("widget.overview.top")
                .onGeometryChange(for: Bool.self, of: { $0.frame(in: .scrollView).minY < -1 }) { scrolled in
                    belowTop = scrolled
                    readingBoundary = feed && scrolled ? feedRuns.first?.items.first : nil
                }
            if items.isEmpty {
                VStack(spacing: 10) {
                    GenesisWidgetMark()
                    Text(!model.inbox.complete ? "Inbox status unavailable." : filter == "needs"
                         ? "Nothing waits for your answer." : filter == "unread" ? "No unread items." : "Nothing new in the inbox.")
                        .font(.headline)
                    if !model.inboxOverviewItems.isEmpty, filter != "all" {
                        Button("Show all items") {
                            model.holdAgentFit()
                            model.overviewFilterPick = "all"
                        }
                            .buttonStyle(.genHover())
                    } else if model.inbox.complete {
                        Text("Questions, screenshots and finished work from every session land here.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }.frame(maxWidth: .infinity).padding(.vertical, 28)
            } else {
                Text(Self.summary(items, waits: model.waitsForAnswer, hidden: model.inboxHiddenItems) + (feed ? " · newest first" : "")).font(.system(size: 11)).foregroundStyle(.secondary)
                    .padding(.bottom, 8)
                // Hundreds of entries: lazy, so only the rows on screen exist (swift skill, dense lists).
                LazyVStack(alignment: .leading, spacing: 10) {
                    if feed {
                        WidgetFeedRows(runs: runs, model: model) { item, context in
                            row(item, context: context)
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
                        .font(.system(size: 11)).foregroundStyle(.secondary).padding(.top, 8)
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
        .accessibilityLabel("Order of the inbox list")
        .accessibilityValue(feed ? "Newest first" : grouped ? "By session" : "One list")
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
        let waiting = items.reduce(0) { $0 + (model.waitsForAnswer($1) ? $1.representedCount : 0) }
        let total = items.reduce(0) { $0 + $1.representedCount }
        return HStack(spacing: 7) {
            if let session {
                AIProviderGlyph(meta: AIProviders.meta(for: session.target.provider), size: 14)
            }
            Text(items.first?.message?.origin ?? session?.title ?? "Unknown session")
                .font(.system(size: 11.5, weight: .semibold)).lineLimit(1)
            if items.count > 1 {
                Text([Plural.count(total, "item"), waiting > 0 ? WidgetWords.waitingShort(waiting) : nil]
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

    /// "12 items · 3 waiting · from 4 sessions". `waits`: whether an entry still waits for an answer
    /// (`WidgetModel.waitsForAnswer`).
    /// `hidden`: entries the sessions' lists leave out for the per-session limit, named so a missing entry has a reason.
    static func summary(_ items: [WidgetInboxItem], waits: (WidgetInboxItem) -> Bool = \.needsAnswer, hidden: Int = 0) -> String {
        let waiting = items.reduce(0) { $0 + (waits($1) ? $1.representedCount : 0) }
        let total = items.reduce(0) { $0 + $1.representedCount }
        let sessions = Set(items.filter { $0.message?.origin == nil }.map(\.key)).count
        let senders = Set(items.compactMap { $0.message?.origin }).count
        let sources = [sessions > 0 ? Plural.count(sessions, "session") : nil,
                       senders > 0 ? Plural.count(senders, "sender") : nil].compactMap { $0 }.joined(separator: " and ")
        return [Plural.count(total, "item"), waiting > 0 ? WidgetWords.waiting(waiting) : nil,
                sources.isEmpty ? nil : "from " + sources,
                hidden > 0 ? Plural.count(hidden, "more item") + " in their sessions" : nil].compactMap { $0 }.joined(separator: " · ")
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
        case "answer" where item.tag == "message": return item.isRead ? "Message" : "New message"
        case "answer": return item.isRead ? "Answer" : "New answer"
        case "result": return "Agent result"
        // Words, never the wire kind: "Todo" and "Form" read as raw data.
        case "todo": return "Task"
        case "form": return "Question"
        default: return LiveWidgetView.sentenceCase(item.kind)
        }
    }
}

/// What one inbox row's head shows, as values: a session's inbox builds it from a card, the inbox of every session and
/// the hover list from an item. Each surface keeps its identifier prefix, its probe, its spoken words and its dot rule.
struct WidgetRowHeadValue: Equatable {
    enum Surface: Equatable { case list, card }

    var surface: Surface
    var id: String
    var identifierPrefix: String
    /// The wire kind, for its symbol.
    var kind: String
    var title: String
    /// A one-question form's title is its prompt, drawn as Markdown.
    var titleIsMarkdown: Bool
    var openLineLimit: Int?
    var askedIn: String?
    var needsAnswer: Bool
    /// The overview's rule: a staged decision waits until a send took it. A session's inbox: staging ends the wait.
    var waitsWhileStaged: Bool
    /// The dot is drawn at all: orange while it waits, else blue.
    var dotLit: Bool
    /// A read item of the Items list: grey, below the unread ones for `previewReadHours`.
    var dimmed: Bool
    var kindLabel: String
    var spokenTitle: String
    /// Only the source information that the enclosing group has not already identified.
    var source: String?
    var count: Int?
    var at: Double
    /// A closed card's first line of text.
    var previewLine: String?
    var blocking: Bool
    var confidence: String?
}

extension WidgetRowHeadValue {
    init(item: WidgetInboxItem, source: String?) {
        let title = WidgetInboxOverview.title(item)
        self.init(surface: .list, id: item.id, identifierPrefix: "widget.overview.row.", kind: item.kind, title: title,
                  titleIsMarkdown: false, openLineLimit: item.reply == nil ? 6 : nil, askedIn: item.askedIn,
                  needsAnswer: item.needsAnswer, waitsWhileStaged: true, dotLit: !item.isRead, dimmed: item.isRead,
                  kindLabel: WidgetInboxOverview.kindLabel(item), spokenTitle: title, source: source, count: item.count,
                  at: item.at, previewLine: nil, blocking: false, confidence: nil)
    }
}

/// The head of one inbox row, from values: the dot, kind, title, the open card's facts, the staged line, the kind,
/// source and age, the ×count and the chevron. It is a button (open or fold the row) and its controls exist only while
/// live (`liveRow`: hovered, open, selected, or the keyboard's row); at rest it draws the same labels with no control,
/// so a model publish re-renders only the rows whose values changed and an accessibility client walks no buttons of
/// the hundreds of rows at rest (swift skill, "Dense lists and accessibility clients"). VoiceOver still presses it
/// (`rowButton`).
struct WidgetInboxRowHead: View, Equatable {
    let value: WidgetRowHeadValue
    let open: Bool
    let selected: Bool
    /// The keyboard's row.
    let focused: Bool
    /// The staged pick or note of a waiting decision with where its send is, read from the model by the parent.
    let stage: WidgetStageLine?
    let toggle: () -> Void

    static func == (a: WidgetInboxRowHead, b: WidgetInboxRowHead) -> Bool {
        a.value == b.value && a.open == b.open && a.selected == b.selected && a.focused == b.focused
            && a.stage == b.stage
    }

    /// A decision being sent or sent no longer waits for an answer, though the snapshot still says so for a moment.
    private var waiting: Bool {
        guard value.needsAnswer else { return false }
        guard let stage else { return true }
        return value.waitsWhileStaged && !stage.phase.onItsWay
    }

    var body: some View {
        let _ = probe()
        labels
            .rowButton(cornerRadius: 11) { toggle() }
            .accessibilityLabel(spokenLabel)
            .accessibilityValue((value.dimmed ? "Read, " : "") + (open ? "Expanded" : "Collapsed"))
            .accessibilityAddTraits(focused ? .isSelected : [])
            .accessibilityIdentifier(value.identifierPrefix + value.id)
            .liveRow(selected: selected)
    }

    private func probe() {
        switch value.surface {
        case .list: RenderProbe.hit("widget.overview.row.body")
        case .card: RenderProbe.hit("widget.inbox.card.body")
        }
    }

    /// A staged decision says where its send is ("Decision · Sent"), as its line does: a snapshot from before the send
    /// still says it waits for your answer. An open card adds the facts its badges show: ", blocking, high confidence".
    private var spokenLabel: String {
        switch value.surface {
        case .list:
            return [stage.map { "Decision · " + $0.phase.label } ?? value.kindLabel, value.spokenTitle, value.source]
                .compactMap { $0 }.joined(separator: ", ")
        case .card:
            var facts: [String] = []
            if open, value.blocking { facts.append("blocking") }
            if open, let confidence = value.confidence { facts.append(confidence + " confidence") }
            return (stage?.phase.label ?? value.kindLabel) + ": " + value.spokenTitle + facts.map { ", " + $0 }.joined()
        }
    }

    private var labels: some View {
        let waiting = self.waiting
        return HStack(alignment: .top, spacing: 9) {
            // An item already read keeps the dot's room but draws none.
            Circle().fill(!value.dotLit ? Color.clear : waiting ? Color.orange : SessionPalette.blue)
                .frame(width: 7, height: 7).padding(.top, 5)
            Image(systemName: LiveWidgetView.kindSymbol(value.kind)).font(.system(size: 11))
                .foregroundStyle(.secondary).frame(width: 14).padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                (value.titleIsMarkdown ? Text(.init(value.title)) : Text(value.title))
                    .font(.system(size: 12.5, weight: open ? .semibold : .medium))
                    .lineLimit(open ? value.openLineLimit : 2)
                    .fixedSize(horizontal: false, vertical: true)
                // A sub-agent's decision names its thread and lead: each session numbers its own (DECISION 46 b).
                if let askedIn = value.askedIn, !askedIn.isEmpty {
                    WidgetAskedInLine(askedIn)
                }
                // Open, the facts the hub's card shows beside its title: blocking, and how sure the agent is.
                if open, value.blocking || value.confidence != nil {
                    HStack(spacing: 6) {
                        if value.blocking {
                            Badge("Blocking", color: KitPalette.removed, look: .filled)
                        }
                        if let confidence = value.confidence {
                            DecisionConfidenceBadge(confidence)
                        }
                    }
                }
                if !open, let preview = value.previewLine {
                    Text(preview).font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1)
                }
                if let stage {
                    stage
                }
                HStack(spacing: 4) {
                    if let source = value.source {
                        Text(source).lineLimit(1).truncationMode(.middle).help(source)
                        Text("·")
                    }
                    // A decision on its way no longer says it waits for your answer.
                    let kind = waiting || !value.needsAnswer ? value.kindLabel : "Decision"
                    if value.title != kind {
                        Text(kind).lineLimit(1)
                        Text("·")
                    }
                    // One age style in a list (.claude/rules/macos-app.md): "12m ago".
                    LiveAgo(date: Date(timeIntervalSince1970: value.at / 1000), style: .brief).fixedSize()
                }.font(.system(size: 11)).foregroundStyle(waiting ? Color.orange : SessionPalette.secondary)
            }
            Spacer(minLength: 4)
            if let count = value.count, count > 1 {
                Text(verbatim: "×\(count)").font(.system(size: 10, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(.secondary).padding(.top, 3)
                    .instantTooltip("\(count) items like this one in this session")
            }
            Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold))
                .foregroundStyle(.secondary).rotationEffect(.degrees(open ? 90 : 0)).padding(.top, 4)
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .opacity(value.dimmed ? (open ? 0.8 : 0.55) : 1)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}
