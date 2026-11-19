import SwiftUI

// MARK: - Items

/// The review rows of one meeting (`meeting.rows`, F6): questions and suggestions in the order `tools meetings listen`
/// asks, one `ReviewRowView` each. A decided row folds (R16) and moves below the open rows, folds in place, or leaves
/// the list (`meetings.rows.decided`); a click unfolds it with its whole reason (U14).
/// The keyboard reaches every row (G11): Up and Down select, Return edits or confirms (`meetings.rows.returnKey`), a
/// second Return in the editor saves (R11), 1 to 9 pick a choice (`meetings.rows.choiceKeys`, G23), Delete picks
/// "none of these", Esc closes the editor, else clears the selection.
/// Which review rows the Items list shows: all of them, or one kind.
enum ItemsFilter: String, CaseIterable {
    case all, questions, suggestions

    /// `atLine`: the open suggestions (`MeetingDetailModel.confirmable` at `applyAbove`). Questions are the open ones,
    /// the tab's count (U15: it counted 9 and listed 41, 32 of them rejected); one this window just answered
    /// (`keeping`, G33) keeps its place until the reader scrolls. All keeps the decided history.
    func rows(_ rows: [ReviewRow], atLine: Set<String>, applyAbove: Double, keeping: Set<String> = []) -> [ReviewRow] {
        switch self {
        case .all: rows
        case .questions: rows.filter { $0.isQuestion && ($0.isOpen || keeping.contains($0.id)) }
        case .suggestions: rows.filter { Self.isSuggestion($0, atLine: atLine, applyAbove: applyAbove) }
        }
    }

    /// A suggestion, on every surface of the window: an item that is no question, at or above the apply line, that
    /// Confirm all takes. The meeting list counts the same (`suggestedAboveApply` in src/meetings/lib/overview.ts); the
    /// rest are "below 50 %" and show under All. A row decided in this window keeps its place while its confidence is
    /// at the line, so a confirm does not pull it out of the list under the pointer.
    static func isSuggestion(_ row: ReviewRow, atLine: Set<String>, applyAbove: Double) -> Bool {
        guard !row.isQuestion else { return false }
        return row.isOpen ? atLine.contains(row.id) : (row.confidence ?? 0) >= applyAbove
    }

    /// The filter that applies. It holds only while both kinds wait, which is also when its control shows: with one
    /// kind left every row shows, so the list is never empty with no way back.
    static func effective(_ filter: ItemsFilter, questions: Int, suggestions: Int) -> ItemsFilter {
        offered(questions: questions, suggestions: suggestions) ? filter : .all
    }

    static func offered(questions: Int, suggestions: Int) -> Bool {
        questions > 0 && suggestions > 0
    }

    /// The shape of the filter's strip in the Items bar.
    enum Bar: Equatable {
        /// Each kind with its count, at the strip's own width.
        case counts
        /// The titles alone, at the strip's own width.
        case titles
        /// The titles sharing the whole room (the narrowest column).
        case shared

        /// The first shape whose strip fits the room; `counts` before the room is known. The order a `ViewThatFits`
        /// of the three tried them in.
        static func pick(room: CGFloat?, counts: CGFloat, titles: CGFloat) -> Bar {
            guard let room else { return .counts }
            if counts <= room {
                return .counts
            }

            return titles <= room ? .titles : .shared
        }
    }
}

struct RepeatedWordRow: View {
    let row: ReviewRow
    let item: MeetingItem
    /// The dictionary question attached to this word (`ItemsProjection.dictionaries`), found once per rows change.
    var dictionary: ReviewRow? = nil
    let detail: MeetingDetailModel
    @State private var places: DecisionReach.Spelling?
    @State private var readingPlaces = false
    @FocusState private var typing: Bool
    @State private var earlierText = ""
    @State private var advanceAfterSave = false
    private var answer: String { detail.drafts[row.id] ?? item.wordSuggestion ?? "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(verbatim: "“\(item.heard ?? row.what)”").font(.headline)
                Button { openPlaces() } label: {
                    Text(verbatim: "\(row.occurrences ?? 1)×").monospacedDigit()
                }.buttonStyle(.genHoverPlain()).disabled(readingPlaces)
                    .instantTooltip("Show every place this word is heard")
                    .accessibilityLabel("\(row.occurrences ?? 1) occurrences")
                Spacer(minLength: 0)
            }
            if row.isOpen, item.about == "term" {
                if let suggestion = item.wordSuggestion, answer == suggestion {
                    Label("Suggested spelling", systemImage: "sparkles").font(.caption).foregroundStyle(KitHue.play.ink)
                }
                TextField("Spelling", text: Binding(get: { answer }, set: { detail.drafts[row.id] = $0 }))
                    .textFieldStyle(.roundedBorder).focused($typing)
                    .accessibilityIdentifier("meetings.row.\(row.id).answer")
                    .onSubmit { save(answer) }
                    .onExitCommand { detail.drafts[row.id] = earlierText; typing = false; detail.closeEditor() }
                Text("Fixes \(Plural.count(row.occurrences ?? 1, "place"))").font(.caption).foregroundStyle(.secondary)
                WrapLayout(spacing: 8) {
                    Button("Save") { save(answer) }.buttonStyle(.genHoverPlain()).disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    Button("Right as heard") { save(item.heard ?? "") }.buttonStyle(.genHoverPlain())
                }
            } else if item.about == "term", row.status == "confirmed" {
                Label("“\(item.heard ?? "")” → “\(row.answer ?? item.answer ?? "")” · \(Plural.count(row.occurrences ?? 1, "place"))",
                      systemImage: "checkmark.circle.fill").foregroundStyle(KitPalette.added).fixedSize(horizontal: false, vertical: true)
            }
            if let dictionary {
                if dictionary.isOpen {
                    VStack(alignment: .leading, spacing: 4) {
                        Button("Add to the \(detail.record.value?.project ?? "project") dictionary") {
                            detail.decide(dictionary, .answer(dictionary.id, "add"), askReach: false)
                        }.buttonStyle(.genHoverPlain())
                        Button("Not now") { detail.decide(dictionary, .answer(dictionary.id, "do not add"), askReach: false) }
                            .buttonStyle(.genHoverPlain())
                    }.disabled(detail.busyItems.contains(dictionary.id))
                } else if dictionary.answer == "add" {
                    Label("In the dictionary", systemImage: "character.book.closed.fill").font(.caption).foregroundStyle(KitPalette.added)
                }
            }
        }
        .disabled(detail.busyItems.contains(row.id))
        .padding(.vertical, 8).liveRow(selected: detail.selectedRow == row.id)
        .onChange(of: typing) { _, focused in
            if focused { earlierText = answer; detail.selectedRow = row.id; detail.editingRow = row.id }
            else if detail.editingRow == row.id { detail.closeEditor() }
        }
        .onChange(of: detail.editingRow) { _, id in typing = id == row.id && row.isOpen }
        .onChange(of: row.isOpen) { wasOpen, open in
            guard wasOpen, !open, advanceAfterSave else { return }
            advanceAfterSave = false
            let rows = ItemsTab.wordRows(detail.rows.value?.rows ?? [], items: detail.record.value?.items ?? [])
            if let next = MeetingDetailModel.nextOpenRow(after: row.id, in: rows), next.group == "words" { detail.edit(next) }
        }
        .sheet(isPresented: Binding(get: { places != nil }, set: { if !$0 { places = nil } })) {
            if let places { WordOccurrencesSheet(spelling: places, detail: detail) { self.places = nil } }
        }
    }
    private func save(_ text: String) {
        guard let text = MeetingsWords.typedAnswer(text) else { return }
        advanceAfterSave = typing
        detail.decide(row, .answer(row.id, text), askReach: false)
    }

    private func openPlaces() {
        guard let term = item.decides?.first ?? item.dictionaryTarget else { return }
        readingPlaces = true
        Task {
            defer { readingPlaces = false }
            do {
                let plan = try await MeetingDetailModel.planDecision(meeting: detail.id,
                    action: .respell(term, to: item.heard ?? row.answer ?? ""), reason: nil, service: detail.service)
                places = plan?.reach.spelling
            } catch { detail.notices.push(.meetingsFailure(error) { openPlaces() }) }
        }
    }
}

struct ItemsTab: View {
    static let questionGroups = [(id: "rules", title: "Rules"), (id: "spot-check", title: "Spot check"),
                                 (id: "long-stretch", title: "Long stretches"), (id: "words", title: "Repeated words")]

    static func wordRows(_ rows: [ReviewRow], items: [MeetingItem]) -> [ReviewRow] {
        let terms = Set(items.filter { $0.group == "words" && $0.about == "term" }.flatMap { $0.decides ?? [] })
        let attached = Set(items.filter { terms.contains($0.dictionaryTarget ?? "") }.map(\.id))
        return rows.filter { !attached.contains($0.id) }
    }

    @Bindable var detail: MeetingDetailModel
    var projectPicker: AnyView? = nil
    @State private var projectRefused = false
    @FocusState private var focused: Bool

    @AppStorage(MeetingsPreferences.Rows.order.key) private var order = MeetingsPreferences.Rows.order.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.decided.key) private var decided = MeetingsPreferences.Rows.decided.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.choiceKeys.key) private var choiceKeys = MeetingsPreferences.Rows.choiceKeys.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.returnKey.key) private var returnKey = MeetingsPreferences.Rows.returnKey.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.lowPriority.key) private var lowPriority = MeetingsPreferences.Rows.lowPriority.defaultValue.rawValue
    /// Each row's last height and the list's scroll position, outside observation: a scroll writes them every frame.
    @State private var layout = RowLayout()
    /// The list's width in whole points, for the shape of the folded rows (`ReviewRowView.foldedFit`); nil until the
    /// first layout.
    @State private var listWidth: CGFloat?
    @AppStorage("meetings.rows.questionGroup") private var questionGroup = "all"
    /// What the list and its bar show, computed once per change of its inputs (`ItemsProjection.make`).
    @State private var projection = ItemsProjection()

    var body: some View {
        VStack(spacing: 0) {
        if needsProject {
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(KitHue.care.ink)
                VStack(alignment: .leading, spacing: 10) {
                    Text("This meeting has no project. Suggestions use the project's dictionary.")
                        .fixedSize(horizontal: false, vertical: true)
                    projectPicker
                }
                Spacer(minLength: 0)
            }.padding(16).frame(maxWidth: .infinity, alignment: .leading)
        }
        LoadablePane(state: detail.rowsForReopen, reading: "Reading the items…", retry: detail.loadRows) { rows in
            if Self.showsEmptyState(rows) {
                if needsProject { Color.clear } else {
                let hasTranscript = detail.window?.meeting(detail.id)?.hasTranscript ?? true
                if detail.isBusy("suggest") {
                    SuggestRunView(progress: detail.suggestProgress) { detail.cancelSuggest() }
                } else {
                    ItemsEmptyState(hasTranscript: hasTranscript) { suggest() }
                }
                }
            } else if projection.ready {
                list(rows)
            } else {
                // The first frame, before the projection: nothing, not an empty list that says nothing waits.
                Color.clear
            }
        }
        }
        .onChange(of: detail.record.value?.project) { _, _ in projectRefused = false }
        .onAppear { detail.restoreRowsForReopen() }
        .onChange(of: lowPriority) { _, _ in detail.readRows(quiet: true) }
        .onChange(of: projectionInput, initial: true) { _, input in
            let span = HubPerf.begin("meetings.items.projection", "\(input.rows.count) rows")
            projection = ItemsProjection.make(input)
            span.end()
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                ItemsBar(detail: detail, projection: projection, group: $questionGroup, applyAbove: applyAbove)
                // A run on a meeting that has items ("Run the rules again…") shows its steps above the list.
                // The same predicate as the empty state: a meeting whose rows are all hidden low-priority questions
                // shows the list's banner, so its run shows here.
                if detail.isBusy("suggest"), let rows = detail.rowsForReopen.value, !Self.showsEmptyState(rows) {
                    SuggestRunStrip(progress: detail.suggestProgress) { detail.cancelSuggest() }
                    Divider()
                }
            }
        }
    }

    /// No row to list and none hidden: the tab shows its empty state, which carries a running suggestion's steps
    /// (`SuggestRunView`); anything else shows the list, whose run shows in the strip above it (`SuggestRunStrip`).
    static func showsEmptyState(_ rows: ReviewRows) -> Bool {
        rows.rows.isEmpty && rows.hidden.lowPriority == 0
    }

    /// The config's apply line (`assign.applyAbove`).
    private var applyAbove: Double { detail.window?.overview.value?.applyAbove ?? 0.5 }

    /// The projection's inputs. Building it is cheap: the arrays are shared, and an unchanged array compares equal by
    /// its storage before any element is read.
    private var projectionInput: ItemsProjection.Input {
        .init(rows: detail.rowsForReopen.value?.rows ?? [], items: detail.record.value?.items,
              order: MeetingsPreferences.Rows.Order(rawValue: order) ?? .priority,
              decided: MeetingsPreferences.Rows.Decided(rawValue: decided) ?? MeetingsPreferences.Rows.decided.defaultValue,
              held: detail.heldFolds, filter: detail.itemsFilter, group: questionGroup, applyAbove: applyAbove)
    }

    private var needsProject: Bool { projectRefused || detail.record.value.map { $0.project?.isEmpty != false } == true }

    private func suggest() {
        guard !needsProject else { return }
        detail.suggest { projectRefused = true }
    }

    private func list(_ rows: ReviewRows) -> some View {
        let open = projection.open
        // The row whose Moment is on top of the player: it carries the play hue on its leading edge.
        let player = detail.window?.player
        let top = player?.top
        let playing = top?.meeting == detail.id ? top?.target : nil
        let shown = projection.shown
        let ids = projection.ids
        return ScrollViewReader { proxy in
            ScrollView {
                // A lazy stack, not a List: for an accessibility client a List built, measured and recycled every row
                // it held (2026-11-06/07). The stack holds only the rows near the viewport.
                LazyVStack(alignment: .leading, spacing: 2) {
                    if rows.hidden.lowPriority > 0 {
                        HStack(spacing: 8) {
                            Text(verbatim: "\(Plural.count(rows.hidden.lowPriority, "low-priority question")) hidden, as the terminal hides them")
                                .font(.system(size: 11.5)).foregroundStyle(.secondary)
                            Button("Show") { lowPriority = MeetingsPreferences.Rows.LowPriority.show.rawValue }
                                .buttonStyle(.link).font(.system(size: 11.5))
                        }
                        .padding(.horizontal, 16)
                    }
                    ForEach(shown) { row in
                        let ruled = Self.ruleAbove(row, first: shown.first?.id, held: detail.heldFolds.contains(row.id))
                        // A value row (lag report cause 6): what it shows comes in as values, so a click, a hover or
                        // a play re-runs only the rows whose values changed. The draft is read only for a row decided
                        // meanwhile (its one use), so typing in an editor does not re-run this list.
                        let busy = detail.busyItems.contains(row.id)
                        let meanwhile = detail.decidedMeanwhile[row.id]
                        Group {
                        if row.group == "words", let item = projection.wordItems[row.id] {
                            RepeatedWordRow(row: row, item: item, dictionary: projection.dictionaries[row.id], detail: detail)
                        } else {
                        ReviewRowView(row: row, detail: detail, player: player,
                                      play: player.map { MomentPlay.of($0, meeting: detail.id, targets: ReviewRowView.targets(row)) } ?? .none,
                                      selected: detail.selectedRow == row.id, editing: detail.editingRow == row.id, busy: busy,
                                      meanwhile: meanwhile, choiceKeys: choiceKeys == "on",
                                      draft: meanwhile == nil ? nil : detail.drafts[row.id],
                                      changingAnswer: detail.changingRows.contains(row.id),
                                      foldedFit: ReviewRowView.foldedFit(row, busy: busy, room: listWidth.map { $0 - Self.rowInset }),
                                      held: detail.heldFolds.contains(row.id),
                                      unfolded: detail.unfoldedRows.contains(row.id),
                                      asksSpeaker: projection.speakerQuestions.contains(row.id),
                                      voicePeople: projection.voicePeople[row.id] ?? [],
                                      references: projection.references[row.id] ?? [],
                                      selectRow: {
                                          detail.selectedRow = row.id
                                          focused = true
                                      })
                            .equatable()
                        }
                        }
                            // G33: a row this window just answered keeps its open height until the reader scrolls, so
                            // the next row does not move up under the eye.
                            .frame(minHeight: detail.heldFolds.contains(row.id) ? layout.heights[row.id] : nil, alignment: .top)
                            .onGeometryChange(for: CGFloat.self, of: \.size.height) { height in
                                guard layout.heights[row.id] != height else { return }
                                layout.heights[row.id] = height
                                if detail.selectedRow == row.id, layout.anchor(for: row.id) != nil {
                                    keepInView(row.id, proxy: proxy)
                                }
                            }
                            .padding(.horizontal, 10)
                            .background(RoundedRectangle(cornerRadius: 6)
                                .fill(detail.selectedRow == row.id ? Color.accentColor.opacity(focused ? 0.22 : 0.12) : .clear))
                            .overlay(alignment: .leading) {
                                if playing == row.target {
                                    Capsule().fill(KitHue.play.ink).frame(width: 3).padding(.vertical, 6)
                                        .accessibilityHidden(true)
                                }
                            }
                            .contentShape(Rectangle())
                            .onTapGesture {
                                detail.selectedRow = row.id
                                focused = true
                            }
                            .id(row.id)
                            .padding(.horizontal, 6)
                            // A hairline above each open row: 430 rows of four to six lines each ran into one another,
                            // and the eye could not find where a row starts. It is drawn on the row, not as a view of
                            // its own before it: a second view of the same list element took the row's id, and a jump
                            // to the row stopped at its hairline, with the row below the fold.
                            .padding(.top, ruled ? 7 : 0)
                            .overlay(alignment: .top) {
                                if ruled { Divider().opacity(0.6).padding(.horizontal, 16).padding(.top, 3) }
                            }
                            .frameProbe("meetings.row.\(row.id)")
                    }
                    if open == 0, !rows.rows.isEmpty {
                        Text("Every question is answered and every suggestion decided. Revert and edit reopens one.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                            .padding(.horizontal, 16).padding(.top, 8)
                    }
                }
                .padding(.vertical, 6)
                .onGeometryChange(for: CGFloat.self, of: { $0.frame(in: .named(Self.scrollSpace)).minY }) { scrolled(to: $0) }
                .onGeometryChange(for: CGFloat.self, of: { $0.size.width.rounded(.down) }) { listWidth = $0 }
            }
            .onGeometryChange(for: CGFloat.self, of: \.size.height) { height in
                layout.viewportHeight = height
                if let id = detail.selectedRow, layout.anchor(for: id) != nil {
                    keepInView(id, proxy: proxy)
                }
            }
            .coordinateSpace(.named(Self.scrollSpace))
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.upArrow) { cardShows ? .ignored : step(-1, rows: ids, proxy: proxy) }
            .onKeyPress(.downArrow) { cardShows ? .ignored : step(1, rows: ids, proxy: proxy) }
            .onKeyPress(.return) { cardShows ? .ignored : returnPressed(shown) }
            .onKeyPress(.delete) { cardShows ? .ignored : pickRole("none", in: shown) }
            .onKeyPress(.escape) {
                guard !cardShows else { return .ignored }
                // G-STACK-2: the editor closes first; the player's stack pops before this view hears Esc
                // (MeetingsPlaybackKeys); the selection clears last.
                if detail.editingRow != nil {
                    detail.closeEditor()
                    return .handled
                }
                guard detail.selectedRow != nil else { return .ignored }
                detail.selectedRow = nil
                return .handled
            }
            .onKeyPress(characters: .decimalDigits) { press in cardShows ? .ignored : pickNumber(press.characters, in: shown) }
            // A pin's click on a meeting that was not open selects its row before the rows land (G-PLAY-6).
            .onAppear { if let id = detail.selectedRow { keepInView(id, proxy: proxy) } }
            .onChange(of: ids) { _, visible in
                guard let id = detail.selectedRow, visible.contains(id) else { return }
                keepInView(id, proxy: proxy)
            }
            .onChange(of: detail.editingRow) { previous, current in
                guard let previous, current == nil, detail.selectedRow == previous else { return }
                DispatchQueue.main.async {
                    guard detail.editingRow == nil, detail.selectedRow == previous else { return }
                    focused = true
                }
            }
            .onChange(of: detail.selectedRow) { _, id in
                guard let id else { return }
                keepInView(id, proxy: proxy)
                if let row = shown.first(where: { $0.id == id }), row.isOpen { detail.window?.player.precut(row.target, in: detail.id) }
            }
        }
        // Keep room below the list for bottom notices. Top notices overlay it: changing a top safe-area inset would
        // shift every row when a notice appears, expires or is dismissed.
        .safeAreaInset(edge: .bottom, spacing: 0) { Color.clear.frame(height: noticeEdge == .bottom ? noticeRoom : 0) }
    }

    /// A row's horizontal padding inside the list (10 pt in its background, 6 pt outside it, on both sides).
    static let rowInset: CGFloat = 32

    /// The "This also affects" card shows over the column: its keys are its own (Return saves, Esc cancels).
    private var cardShows: Bool { detail.pendingReach != nil }

    /// The edge the window's notices float at.
    private var noticeEdge: VerticalEdge {
        detail.window?.noticePlace.alignment.vertical == .top ? .top : .bottom
    }

    /// The room the notices take at their edge, so a row kept in view stays clear of them. The stack does not tell its
    /// height, so this counts its pills.
    private var noticeRoom: CGFloat {
        Self.noticeRoom(count: detail.notices.notices.count, limit: detail.notices.visibleLimit)
    }

    /// A pill with an Undo is about 60 pt (its words, then the Undo under them; 59 pt in a 900 pt window); the stack adds
    /// 6 pt between pills and about 18 pt to the edge (its own padding and the overlay's). Folded notices add one
    /// "+N more" chip.
    static func noticeRoom(count: Int, limit: Int?) -> CGFloat {
        guard count > 0 else { return 0 }
        let shown = min(count, limit ?? count)
        let chip: CGFloat = shown < count ? 28 : 0
        return min(378, 18 + CGFloat(shown) * 60 + CGFloat(shown - 1) * 6 + chip)
    }

    /// "430 rows wait for you", "1 row waits for you", or that nothing waits.
    static func waitingWords(open: Int) -> String {
        open == 0 ? "Nothing waits for you in this meeting" : "\(Plural.count(open, "row")) \(open == 1 ? "waits" : "wait") for you"
    }

    /// The bar's one line: the rows that wait, then the suggestions at the apply line. `compact` is the form a narrow
    /// column takes. One line, because the count as a title under the bar cost a second line at every size.
    static func barWords(open: Int, atLine: Int, line: String, compact: Bool) -> String {
        let suggestions = atLine > 0 ? (compact ? "\(atLine) at \(line) or more" : "\(Plural.count(atLine, "suggestion")) at \(line) or more")
                                     : "none at \(line) or more"
        guard open > 0 else { return atLine > 0 ? suggestions : "No suggestion at \(line) or more" }
        return compact ? "\(open) wait · \(suggestions)" : "\(waitingWords(open: open)) · \(suggestions)"
    }

    /// The filter strip's tooltip: what Suggestions counts (the meeting list's count) and where the other items are.
    static func kindsTooltip(suggestions: Int, belowLine: Int, line: String) -> String {
        let counted = "Suggestions: the \(Plural.count(suggestions, "item")) at \(line) or more, which Confirm all takes and the meeting list counts."
        guard belowLine > 0 else { return counted }
        return counted + " \(belowLine) more \(belowLine == 1 ? "waits" : "wait") below \(line); All shows them."
    }

    /// A hairline stands above an open row, except the list's first row and a row that keeps its place after an answer.
    static func ruleAbove(_ row: ReviewRow, first: String?, held: Bool) -> Bool {
        row.isOpen && !held && row.id != first
    }

    /// Up and Down: the next row in list order, kept in view.
    private func step(_ offset: Int, rows: [String], proxy: ScrollViewProxy) -> KeyPress.Result {
        guard let next = Self.step(from: detail.selectedRow, by: offset, in: rows) else { return .ignored }
        detail.selectedRow = next
        keepInView(next, proxy: proxy)
        return .handled
    }

    /// Scrolls a row into view. A lazy stack places a far row by an estimate of the rows before it, so the row is
    /// asked for once more when the rows around it are laid out: a row a pin or a reference jumped to stopped below
    /// the fold.
    private func keepInView(_ id: String, proxy: ScrollViewProxy) {
        layout.expectScroll()
        proxy.scrollTo(id, anchor: layout.anchor(for: id))
        DispatchQueue.main.async {
            layout.expectScroll()
            proxy.scrollTo(id, anchor: layout.anchor(for: id))
        }
    }

    private static let scrollSpace = "meetings.items.scroll"

    /// The list moved in its scroll view. A move the window made (a selection kept in view) is not the reader's; any
    /// other move is, and gives the held rows their room back (G33).
    private func scrolled(to top: CGFloat) {
        guard layout.moved(to: top) else { return }
        detail.releaseHeldFolds()
    }

    /// The row Up (-1) or Down (+1) selects: the first row when none is selected, and the ends hold.
    static func step(from selected: String?, by offset: Int, in rows: [String]) -> String? {
        guard !rows.isEmpty else { return nil }
        guard let selected, let index = rows.firstIndex(of: selected) else { return rows[offset < 0 ? rows.count - 1 : 0] }
        return rows[min(max(index + offset, 0), rows.count - 1)]
    }

    /// Return (G7): `edit` opens the row's editor (its second Return saves), `confirm` takes the suggested choice. A
    /// row with no editor takes its suggested choice either way.
    private func returnPressed(_ rows: [ReviewRow]) -> KeyPress.Result {
        guard let row = selected(rows), row.isOpen else { return .ignored }
        let key = MeetingsPreferences.Rows.ReturnKey(rawValue: returnKey) ?? .edit
        switch Self.returnAction(for: row, key: key, editing: detail.editingRow == row.id) {
        case .submit: detail.submitDraft(on: row)
        case .edit: detail.edit(row)
        case .choose(let choice): detail.choose(choice, on: row)
        case .none: return .ignored
        }
        return .handled
    }

    enum ReturnAction: Equatable {
        case edit
        case submit
        case choose(RowChoice)
        case none
    }

    /// What Return does on an open row.
    static func returnAction(for row: ReviewRow, key: MeetingsPreferences.Rows.ReturnKey, editing: Bool = false) -> ReturnAction {
        if editing { return .submit }
        if key == .edit, row.edit != "none" { return .edit }
        guard let choice = row.choices.first(where: { $0.role == "suggested" }) ?? row.choices.first(where: { $0.role != "skip" })
        else { return row.edit != "none" ? .edit : .none }
        return .choose(choice)
    }

    private func pickNumber(_ characters: String, in rows: [ReviewRow]) -> KeyPress.Result {
        guard choiceKeys == "on", detail.editingRow == nil, let digit = Int(characters), digit >= 1,
              let row = selected(rows), row.isOpen, digit <= row.choices.count else { return .ignored }
        detail.choose(row.choices[digit - 1], on: row)
        return .handled
    }

    private func pickRole(_ role: String, in rows: [ReviewRow]) -> KeyPress.Result {
        guard detail.editingRow == nil, let row = selected(rows), row.isOpen,
              let choice = row.choices.first(where: { $0.role == role }) else { return .ignored }
        detail.choose(choice, on: row)
        return .handled
    }

    private func selected(_ rows: [ReviewRow]) -> ReviewRow? {
        detail.selectedRow.flatMap { id in rows.first { $0.id == id } }
    }

    /// Whether Return (confirm) or Delete (reject) decides an item by the rule of its buttons: Return never confirms a
    /// term with no spelling or a range with no speaker. Kept for the item-level keys of the bulk bar's items.
    static func keyActs(on item: MeetingItem, confirm: Bool) -> Bool {
        confirm ? item.canConfirm : item.isDecidable
    }
}

/// The Items list's layout facts that change every frame (G33): each row's last height, which a held row keeps, and the
/// list's top in its scroll view, whose change tells a reader's scroll. A plain class, so a write redraws nothing.
final class RowLayout {
    var heights: [String: CGFloat] = [:]
    var viewportHeight: CGFloat = 0
    private var top: CGFloat?

    /// A row taller than the viewport cannot fit. Start at its heading instead of revealing its bottom.
    func anchor(for id: String) -> UnitPoint? {
        guard viewportHeight > 0, let height = heights[id], height > viewportHeight else { return nil }
        return .top
    }
    private var windowScrolls = false

    /// The window is about to keep a row in view: the move that follows, in this pass, is not the reader's.
    @MainActor func expectScroll() {
        windowScrolls = true
        DispatchQueue.main.async { [weak self] in self?.windowScrolls = false }
    }

    /// Whether the list's top moved by the reader: true for a move of more than half a point that the window did not make.
    func moved(to newTop: CGFloat) -> Bool {
        defer { top = newTop }
        guard let top, abs(newTop - top) > 0.5 else { return false }
        return !windowScrolls
    }
}

/// The Items tab with nothing to list: "No items yet" and, with a transcript, the button that runs the rules. Its own
/// view, so a test draws the call the tab makes (w_xow4oigk: the button vanished while the words stayed).
struct ItemsEmptyState: View {
    let hasTranscript: Bool
    let suggest: () -> Void

    var body: some View {
        EmptyState(symbol: "checklist", text: "No items yet",
                   detail: hasTranscript ? "The rules suggest items from the transcript." : "The rules need a transcript, and this meeting has none.",
                   actionTitle: hasTranscript ? "Suggest items" : nil, action: suggest)
    }
}

/// What the Items tab shows while the rules run, in the place of the empty state that started them: the service's newest
/// step as a bar with its words ("Voices: 120 of 300 lines (40 %)"), or a spinner before the first step. The bar and the
/// spinner hold one height, so the words do not move when the first step arrives.
struct SuggestRunView: View {
    let progress: MeetingsCallProgress?
    /// Stops the run (`$/cancel`: the service kills the voice workers and saves nothing); nil draws no Cancel.
    var cancel: (() -> Void)? = nil

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checklist")
                .font(.system(size: 24))
                .foregroundColor(KitPalette.faint)
            Text("Suggesting items")
                .font(.system(size: 12.5, weight: .medium))
                .foregroundColor(KitPalette.dim)
            Group {
                if let fraction = progress?.fraction {
                    ProgressView(value: min(1, max(0, fraction)))
                        .progressViewStyle(.linear)
                        .frame(width: 260)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(height: 16)
            Text(verbatim: Self.label(progress))
                .font(.system(size: 11.5).monospacedDigit())
                .foregroundColor(KitPalette.dim)
                .multilineTextAlignment(.center)
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Suggesting items")
                .accessibilityValue(Self.label(progress))
            if let cancel {
                GhostButton("Cancel", symbol: "xmark", tooltip: "Stop the rules; nothing is saved", identifier: "meetings.items.suggestCancel",
                            action: cancel)
                    .padding(.top, 2)
            }
        }
        .padding(16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The step in words: the service's label with the share done, either alone, or a waiting line before any step.
    static func label(_ progress: MeetingsCallProgress?) -> String {
        guard let progress else { return "Starting the rules…" }
        let percent = progress.fraction.map { "\(Int((min(1, max(0, $0)) * 100).rounded())) %" }
        switch (progress.label, percent) {
        case let (label?, percent?): return "\(label) (\(percent))"
        case let (label?, nil): return label
        case let (nil, percent?): return "\(percent) done"
        case (nil, nil): return "Running the rules…"
        }
    }
}

/// A run of the rules on a meeting that has items: one line above the list with the bar, the step in words and Cancel.
struct SuggestRunStrip: View {
    let progress: MeetingsCallProgress?
    let cancel: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Group {
                if let fraction = progress?.fraction {
                    ProgressView(value: min(1, max(0, fraction))).progressViewStyle(.linear).frame(width: 140)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(height: 14)
            Text(verbatim: progress == nil ? "Running the rules again…" : SuggestRunView.label(progress))
                .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.secondary).lineLimit(1)
                .accessibilityLabel("Running the rules")
            Spacer(minLength: 6)
            GhostButton("Cancel", symbol: "xmark", tooltip: "Stop the rules; nothing is saved", height: 22,
                        identifier: "meetings.items.suggestCancel", action: cancel)
        }
        .padding(.horizontal, 14).padding(.vertical, 6)
    }
}
