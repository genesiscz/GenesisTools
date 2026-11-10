import SwiftUI

// MARK: - Items

/// The review rows of one meeting (`meeting.rows`, F6): questions and suggestions in the order `tools meetings listen`
/// asks, one `ReviewRowView` each. A decided row folds in place (R16) or leaves the list (`meetings.rows.decided`).
/// The keyboard reaches every row (G11): Up and Down select, Return edits or confirms (`meetings.rows.returnKey`), a
/// second Return in the editor saves (R11), 1 to 9 pick a choice (`meetings.rows.choiceKeys`, G23), Delete picks
/// "none of these", Esc closes the editor, else clears the selection.
struct ItemsTab: View {
    @Bindable var detail: MeetingDetailModel
    @FocusState private var focused: Bool
    @AppStorage(MeetingsPreferences.Rows.order.key) private var order = MeetingsPreferences.Rows.order.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.decided.key) private var decided = MeetingsPreferences.Rows.decided.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.choiceKeys.key) private var choiceKeys = MeetingsPreferences.Rows.choiceKeys.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.returnKey.key) private var returnKey = MeetingsPreferences.Rows.returnKey.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.lowPriority.key) private var lowPriority = MeetingsPreferences.Rows.lowPriority.defaultValue.rawValue
    /// Each row's last height and the list's scroll position, outside observation: a scroll writes them every frame.
    @State private var layout = RowLayout()

    var body: some View {
        LoadablePane(state: detail.rows, reading: "Reading the items…", retry: detail.loadRows) { rows in
            if rows.rows.isEmpty, rows.hidden.lowPriority == 0 {
                let hasTranscript = detail.window?.meeting(detail.id)?.hasTranscript ?? true
                EmptyState(symbol: "checklist", text: "No items yet",
                           detail: hasTranscript ? "The rules suggest items from the transcript." : "The rules need a transcript, and this meeting has none.",
                           actionTitle: !hasTranscript ? nil : detail.isBusy("suggest") ? "Suggesting…" : "Suggest items") { detail.suggest() }
            } else {
                list(rows)
            }
        }
        .onChange(of: lowPriority) { _, _ in detail.readRows(quiet: true) }
    }

    private func list(_ rows: ReviewRows) -> some View {
        let shown = MeetingDetailModel.visibleRows(rows.rows, order: MeetingsPreferences.Rows.Order(rawValue: order) ?? .priority,
                                                   decided: MeetingsPreferences.Rows.Decided(rawValue: decided) ?? .inPlace,
                                                   keeping: detail.heldFolds)
        let ids = shown.map(\.id)
        let open = rows.rows.filter(\.isOpen).count
        let items = detail.record.value?.items ?? []
        // The bar above the list says how many rows wait when it shows; the list's own title says it when it does not.
        let barShows = BulkConfirmBar.shows(items)
        return ScrollViewReader { proxy in
            ScrollView {
                // A lazy stack, not a List: for an accessibility client a List built, measured and recycled every row
                // it held (2026-11-06/07). The stack holds only the rows near the viewport.
                LazyVStack(alignment: .leading, spacing: 2) {
                    if !barShows {
                        ItemsHeader(text: Self.waitingWords(open: open))
                    }
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
                        ReviewRowView(row: row, detail: detail, player: detail.window?.player, selected: detail.selectedRow == row.id,
                                      editing: detail.editingRow == row.id, busy: detail.busyItems.contains(row.id),
                                      meanwhile: detail.decidedMeanwhile[row.id], choiceKeys: choiceKeys == "on",
                                      held: detail.heldFolds.contains(row.id))
                            // G33: a row this window just answered keeps its open height until the reader scrolls, so
                            // the next row does not move up under the eye.
                            .frame(minHeight: detail.heldFolds.contains(row.id) ? layout.heights[row.id] : nil, alignment: .top)
                            .onGeometryChange(for: CGFloat.self, of: \.size.height) { layout.heights[row.id] = $0 }
                            .padding(.horizontal, 10)
                            .background(RoundedRectangle(cornerRadius: 6)
                                .fill(detail.selectedRow == row.id ? Color.accentColor.opacity(focused ? 0.22 : 0.12) : .clear))
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
            }
            .coordinateSpace(.named(Self.scrollSpace))
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.upArrow) { step(-1, rows: ids, proxy: proxy) }
            .onKeyPress(.downArrow) { step(1, rows: ids, proxy: proxy) }
            .onKeyPress(.return) { returnPressed(shown) }
            .onKeyPress(.delete) { pickRole("none", in: shown) }
            .onKeyPress(.escape) {
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
            .onKeyPress(characters: .decimalDigits) { press in pickNumber(press.characters, in: shown) }
            // A pin's click on a meeting that was not open selects its row before the rows land (G-PLAY-6).
            .onAppear { if let id = detail.selectedRow { keepInView(id, proxy: proxy) } }
            .onChange(of: detail.selectedRow) { _, id in
                guard let id else { return }
                keepInView(id, proxy: proxy)
                if let row = shown.first(where: { $0.id == id }), row.isOpen { detail.window?.player.precut(row.target, in: detail.id) }
            }
        }
        // The notices float over the list's bottom (or top) edge. That edge's room is kept clear while they show, so a
        // row the list keeps in view after a Skip or an answer stands above them, not under "Skipped Q2 · Undo". The
        // rows do not move when a notice comes or goes: only how far the list scrolls to show a row changes.
        .safeAreaInset(edge: noticeEdge, spacing: 0) { Color.clear.frame(height: noticeRoom) }
        .safeAreaInset(edge: .top, spacing: 0) {
            BulkConfirmBar(detail: detail, items: items, open: open,
                           applyAbove: detail.window?.overview.value?.applyAbove ?? 0.5)
        }
    }

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
        return 18 + CGFloat(shown) * 60 + CGFloat(shown - 1) * 6 + chip
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
        proxy.scrollTo(id)
        DispatchQueue.main.async {
            layout.expectScroll()
            proxy.scrollTo(id)
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
        switch Self.returnAction(for: row, key: key) {
        case .edit: detail.edit(row)
        case .choose(let choice): detail.choose(choice, on: row)
        case .none: return .ignored
        }
        return .handled
    }

    enum ReturnAction: Equatable {
        case edit
        case choose(RowChoice)
        case none
    }

    /// What Return does on an open row.
    static func returnAction(for row: ReviewRow, key: MeetingsPreferences.Rows.ReturnKey) -> ReturnAction {
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

/// A section title of the Items list.
private struct ItemsHeader: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Above the rows: how many suggestions are at the apply line, and one menu that confirms all of them at or above a
/// line, with one Undo. Before it every suggestion took its own click, 40 of them in a long meeting.
private struct BulkConfirmBar: View {
    let detail: MeetingDetailModel
    let items: [MeetingItem]
    /// The review rows that wait (questions and suggestions).
    let open: Int
    /// The config's apply line (`assign.applyAbove`), the default threshold.
    let applyAbove: Double

    /// The bar shows while a suggestion waits (a question is answered by ear, not confirmed in bulk).
    static func shows(_ items: [MeetingItem]) -> Bool {
        items.contains { $0.status == "suggested" && $0.kind != "question" }
    }

    var body: some View {
        if Self.shows(items) {
            let atLine = MeetingDetailModel.confirmable(items, atOrAbove: applyAbove).count
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    ViewThatFits(in: .horizontal) {
                        words(compact: false, atLine: atLine)
                        words(compact: true, atLine: atLine)
                    }
                    .accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 8)
                    MenuButton(items: { menu() }) {
                        Label("Confirm all…", systemImage: "checkmark.circle").font(.system(size: 12))
                    }
                    .disabled(detail.isBusy("confirm.all"))
                    .instantTooltip("Confirm every suggestion at or above a confidence, with one Undo")
                    .accessibilityIdentifier("meetings.items.confirmAll")
                }
                .padding(.horizontal, 14).padding(.vertical, 6)
                Divider()
            }
            .background(.background)
        }
    }

    private func pct(_ value: Double) -> String { MeetingsWords.confidence(value) ?? "" }

    private func words(compact: Bool, atLine: Int) -> some View {
        Text(verbatim: ItemsTab.barWords(open: open, atLine: atLine, line: pct(applyAbove), compact: compact))
            .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
    }

    private func menu() -> [MenuButtonItem] {
        var lines = [0.9, 0.8]
        if !lines.contains(applyAbove), applyAbove > 0 { lines.append(applyAbove) }
        var menu: [MenuButtonItem] = [.note("Confirm every suggestion at or above")]
        for line in lines.sorted(by: >) {
            let count = MeetingDetailModel.confirmable(items, atOrAbove: line).count
            let mark = line == applyAbove ? " (the apply line)" : ""
            menu.append(.action("\(pct(line))\(mark): \(Plural.count(count, "item"))", enabled: count > 0) {
                detail.confirmAll(atOrAbove: line)
            })
        }
        let every = MeetingDetailModel.confirmable(items, atOrAbove: 0).count
        menu.append(.action("Any confidence: \(Plural.count(every, "item"))", enabled: every > 0) { detail.confirmAll(atOrAbove: 0) })
        menu.append(.divider)
        menu.append(.note("Questions, ranges with no speaker and terms with no spelling stay for you."))
        return menu
    }
}

/// The Items list's layout facts that change every frame (G33): each row's last height, which a held row keeps, and the
/// list's top in its scroll view, whose change tells a reader's scroll. A plain class, so a write redraws nothing.
final class RowLayout {
    var heights: [String: CGFloat] = [:]
    private var top: CGFloat?
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
