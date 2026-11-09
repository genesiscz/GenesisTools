import SwiftUI

// MARK: - Items

/// The review rows of one meeting (`meeting.rows`, F6): questions and suggestions in the order `tools meetings listen`
/// asks, one `ReviewRowView` each. A decided row folds in place (R16) or leaves the list (`meetings.rows.decided`).
/// The keyboard reaches every row (G11): Up and Down select, Return edits or confirms (`meetings.rows.returnKey`), a
/// second Return in the editor saves (R11), 1 to 9 pick a choice (`meetings.rows.choiceKeys`, G23), Delete picks
/// "none of these", Esc closes the editor.
struct ItemsTab: View {
    @Bindable var detail: MeetingDetailModel
    @FocusState private var focused: Bool
    @AppStorage(MeetingsPreferences.Rows.order.key) private var order = MeetingsPreferences.Rows.order.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.decided.key) private var decided = MeetingsPreferences.Rows.decided.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.choiceKeys.key) private var choiceKeys = MeetingsPreferences.Rows.choiceKeys.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.returnKey.key) private var returnKey = MeetingsPreferences.Rows.returnKey.defaultValue.rawValue
    @AppStorage(MeetingsPreferences.Rows.lowPriority.key) private var lowPriority = MeetingsPreferences.Rows.lowPriority.defaultValue.rawValue

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
                                                   decided: MeetingsPreferences.Rows.Decided(rawValue: decided) ?? .inPlace)
        let ids = shown.map(\.id)
        let open = rows.rows.filter(\.isOpen).count
        return ScrollViewReader { proxy in
            ScrollView {
                // A lazy stack, not a List: for an accessibility client a List built, measured and recycled every row
                // it held (2026-11-06/07). The stack holds only the rows near the viewport.
                LazyVStack(alignment: .leading, spacing: 2) {
                    ItemsHeader(text: open == 0 ? "Nothing waits for you in this meeting"
                                    : "\(Plural.count(open, "row")) \(open == 1 ? "waits" : "wait") for you")
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
                        ReviewRowView(row: row, detail: detail, player: detail.window?.player, selected: detail.selectedRow == row.id,
                                      editing: detail.editingRow == row.id, busy: detail.busyItems.contains(row.id),
                                      meanwhile: detail.decidedMeanwhile[row.id], choiceKeys: choiceKeys == "on")
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
                    }
                    if open == 0, !rows.rows.isEmpty {
                        Text("Every question is answered and every suggestion decided. Revert and edit reopens one.")
                            .font(.system(size: 12)).foregroundStyle(.secondary)
                            .padding(.horizontal, 16).padding(.top, 8)
                    }
                }
                .padding(.vertical, 6)
            }
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.upArrow) { step(-1, rows: ids, proxy: proxy) }
            .onKeyPress(.downArrow) { step(1, rows: ids, proxy: proxy) }
            .onKeyPress(.return) { returnPressed(shown) }
            .onKeyPress(.delete) { pickRole("none", in: shown) }
            .onKeyPress(.escape) {
                guard detail.editingRow != nil else { return .ignored }
                detail.closeEditor()
                return .handled
            }
            .onKeyPress(characters: .decimalDigits) { press in pickNumber(press.characters, in: shown) }
            .onChange(of: detail.selectedRow) { _, id in
                guard let id else { return }
                proxy.scrollTo(id)
                if let row = shown.first(where: { $0.id == id }), row.isOpen { detail.window?.player.precut(row.target, in: detail.id) }
            }
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            BulkConfirmBar(detail: detail, items: detail.record.value?.items ?? [],
                           applyAbove: detail.window?.overview.value?.applyAbove ?? 0.5)
        }
    }

    /// Up and Down: the next row in list order, kept in view.
    private func step(_ offset: Int, rows: [String], proxy: ScrollViewProxy) -> KeyPress.Result {
        guard let next = Self.step(from: detail.selectedRow, by: offset, in: rows) else { return .ignored }
        detail.selectedRow = next
        proxy.scrollTo(next)
        return .handled
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
    /// The config's apply line (`assign.applyAbove`), the default threshold.
    let applyAbove: Double

    var body: some View {
        let waiting = items.filter { $0.status == "suggested" && $0.kind != "question" }
        if !waiting.isEmpty {
            let atLine = MeetingDetailModel.confirmable(items, atOrAbove: applyAbove).count
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text(atLine > 0
                         ? "\(Plural.count(atLine, "suggestion")) at \(pct(applyAbove)) or more"
                         : "No suggestion at \(pct(applyAbove)) or more")
                        .font(.system(size: 12)).foregroundStyle(.secondary).lineLimit(1)
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
