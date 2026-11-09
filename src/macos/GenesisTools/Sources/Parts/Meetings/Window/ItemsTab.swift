import SwiftUI

// MARK: - Items

/// The items a person decides: open questions and suggestions first (in transcript order), then the decided ones,
/// folded. Each decision leaves a note with Undo for the window's undo time.
struct ItemsTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var showDecided = false
    /// The keyboard's row: Up and Down move it, Return confirms, Delete rejects; its buttons stay live.
    @State private var selected: String?
    @FocusState private var focused: Bool

    var body: some View {
        LoadablePane(state: detail.record, reading: "Reading the items…", retry: detail.reloadRecord) { record in
            let questions = record.items.filter { $0.kind == "question" && $0.status == "suggested" }
            let suggested = record.items.filter { $0.kind != "question" && $0.status == "suggested" }
                .sorted { ($0.seconds ?? 0) < ($1.seconds ?? 0) }
            let decided = record.items.filter { $0.status != "suggested" }
            if record.items.isEmpty {
                let hasTranscript = detail.window?.meeting(record.id)?.hasTranscript ?? true
                EmptyState(symbol: "checklist", text: "No items yet",
                           detail: hasTranscript ? "The rules suggest items from the transcript." : "The rules need a transcript, and this meeting has none.",
                           actionTitle: !hasTranscript ? nil : detail.isBusy("suggest") ? "Suggesting…" : "Suggest items") { detail.suggest() }
            } else {
                let rows = suggested.map(\.id) + (showDecided ? decided.map(\.id) : [])
                // A lazy stack, not a List: for an accessibility client a List built, measured and recycled every row
                // it held, so a walk of 430 suggestions timed out, and of 60 it failed on rows that changed height and
                // identity under it (2026-11-06/07). The stack holds only the rows near the viewport, as the
                // Transcript does; selection and the keys are its own.
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if !questions.isEmpty {
                                ItemsHeader(text: "Questions to answer (\(questions.count))")
                                ForEach(questions) { item in
                                    QuestionRow(item: item, busy: detail.isBusy("answer.\(item.id)"),
                                                play: { detail.play(at: $0) }, answer: { detail.answer(item, with: $0) })
                                        .padding(.horizontal, 16)
                                }
                            }
                            ItemsHeader(text: suggested.isEmpty ? "No suggestion waits" : "Suggested (\(suggested.count))")
                            ForEach(suggested) { item in
                                selectable(item.id, ItemRow(item: item, busy: detail.busyItems.contains(item.id), selected: selected == item.id,
                                                            play: { detail.play(at: $0) },
                                                            decide: { confirm, speaker in detail.decide(item, confirm: confirm, speaker: speaker) },
                                                            reopen: nil).equatable())
                            }
                            if !decided.isEmpty {
                                Button {
                                    showDecided.toggle()
                                } label: {
                                    Label("Decided (\(decided.count))", systemImage: showDecided ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                                        .frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                                }
                                .buttonStyle(.genHoverPlain())
                                .accessibilityValue(showDecided ? "Expanded" : "Collapsed")
                                .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
                                if showDecided {
                                    ForEach(decided) { item in
                                        selectable(item.id, ItemRow(item: item, busy: detail.isBusy("reopen.\(item.id)"), selected: selected == item.id,
                                                                    play: { detail.play(at: $0) },
                                                                    decide: nil, reopen: item.kind == "question" ? nil : { detail.reopen(item, token: nil) })
                                            .equatable())
                                    }
                                }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                    .focusable()
                    .focused($focused)
                    .focusEffectDisabled()
                    .onKeyPress(.upArrow) { step(-1, rows: rows, proxy: proxy) }
                    .onKeyPress(.downArrow) { step(1, rows: rows, proxy: proxy) }
                    .onKeyPress(.return) { act(on: record, confirm: true) }
                    .onKeyPress(.delete) { act(on: record, confirm: false) }
                }
                .safeAreaInset(edge: .top, spacing: 0) {
                    BulkConfirmBar(detail: detail, items: record.items,
                                   applyAbove: detail.window?.overview.value?.applyAbove ?? 0.5)
                }
            }
        }
    }

    /// A suggestion or decided item as a row the keyboard can select: a click selects it (its buttons keep their own
    /// clicks), and the selected row is filled.
    private func selectable(_ id: String, _ row: some View) -> some View {
        row
            .padding(.horizontal, 10)
            .background(RoundedRectangle(cornerRadius: 6).fill(selected == id ? Color.accentColor.opacity(focused ? 0.28 : 0.16) : .clear))
            .contentShape(Rectangle())
            .onTapGesture {
                selected = id
                focused = true
            }
            .id(id)
            .padding(.horizontal, 6)
    }

    /// Up and Down: the next row in list order, kept in view.
    private func step(_ offset: Int, rows: [String], proxy: ScrollViewProxy) -> KeyPress.Result {
        guard let next = Self.step(from: selected, by: offset, in: rows) else { return .ignored }
        selected = next
        proxy.scrollTo(next)
        return .handled
    }

    /// The row Up (-1) or Down (+1) selects: the first row when none is selected, and the ends hold.
    static func step(from selected: String?, by offset: Int, in rows: [String]) -> String? {
        guard !rows.isEmpty else { return nil }
        guard let selected, let index = rows.firstIndex(of: selected) else { return rows[offset < 0 ? rows.count - 1 : 0] }
        return rows[min(max(index + offset, 0), rows.count - 1)]
    }

    /// Return confirms and Delete rejects the selected suggestion (a range with no speaker waits for its menu).
    private func act(on record: MeetingRecordView, confirm: Bool) -> KeyPress.Result {
        guard let id = selected, let item = record.items.first(where: { $0.id == id }), Self.keyActs(on: item, confirm: confirm)
        else { return .ignored }
        detail.decide(item, confirm: confirm)
        return .handled
    }

    /// Whether Return (confirm) or Delete (reject) decides the item: the same rule as its buttons, so Return never
    /// confirms a term with no spelling or a range with no speaker.
    static func keyActs(on item: MeetingItem, confirm: Bool) -> Bool {
        confirm ? item.canConfirm : item.isDecidable
    }
}

/// A section title of the Items list, in the List's section style.
private struct ItemsHeader: View {
    let text: String

    var body: some View {
        Text(verbatim: text)
            .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

/// Above the items: how many suggestions are at the apply line, and one menu that confirms all of them at or above a
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

private struct ItemRow: View, Equatable {
    let item: MeetingItem
    let busy: Bool
    var selected = false
    let play: (Double) -> Void
    let decide: ((Bool, String?) -> Void)?
    let reopen: (() -> Void)?

    /// The item, the spinner, the selection and which buttons it has; the closures never compare equal, so only their
    /// presence counts.
    nonisolated static func == (a: ItemRow, b: ItemRow) -> Bool {
        MainActor.assumeIsolated {
            a.item == b.item && a.busy == b.busy && a.selected == b.selected
                && (a.decide == nil) == (b.decide == nil) && (a.reopen == nil) == (b.reopen == nil)
        }
    }

    /// "Type a name…" in the speaker menu: the popover and what was typed in it.
    @State private var naming = false
    @State private var typedName = ""

    private var needsSpeaker: Bool { item.kind == "speaker-range" && item.speaker == nil }
    private var needsSpelling: Bool { item.needsSpelling }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(MeetingsWords.itemKind(item)).font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    if let seconds = item.seconds {
                        LiveButton(tooltip: "Play from \(MeetingsFormat.clock(seconds))", action: { play(seconds) }) {
                            Text(verbatim: MeetingsFormat.clock(seconds)).font(.system(size: 11, design: .monospaced))
                                .foregroundStyle(KitPalette.renamed)
                        }
                    }
                    if let confidence = MeetingsWords.confidence(item.confidence) {
                        Text(verbatim: confidence).font(.system(size: 11).monospacedDigit()).foregroundStyle(.tertiary)
                    }
                    if item.status != "suggested" {
                        Badge(MeetingsWords.status(item.status), color: item.status == "confirmed" ? KitPalette.added : KitPalette.faint)
                    }
                }
                Text(verbatim: MeetingsWords.itemTitle(item)).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
                if let reason = item.reason {
                    Text(verbatim: reason).font(.system(size: 11.5)).foregroundStyle(.secondary).lineLimit(3)
                }
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView().controlSize(.small)
            } else if let decide {
                HStack(spacing: 6) {
                    if needsSpeaker {
                        MenuButton(items: {
                            let candidates = item.candidates ?? []
                            var items: [MenuButtonItem] = candidates.map { name in .action(name) { decide(true, name) } }
                            if !candidates.isEmpty { items.append(.divider) }
                            items.append(.action("Type a name…") { naming = true })
                            return items
                        }) {
                            Text("Confirm as…").font(.system(size: 12))
                        }
                        .instantTooltip("Whose voice this range is; confirming needs a name")
                        .popover(isPresented: $naming, arrowEdge: .bottom) {
                            SpeakerNamePopover(name: $typedName) { name in
                                naming = false
                                decide(true, name)
                            }
                        }
                    } else {
                        LiveButton(tooltip: needsSpelling ? "It has no spelling yet: answer it by ear" : "Confirm: transcripts apply it",
                                   enabled: item.canConfirm, action: { decide(true, nil) }) {
                            Text("Confirm").font(.system(size: 12))
                        }
                    }
                    LiveButton(tooltip: "Reject: it is never suggested again", action: { decide(false, nil) }) {
                        Text("Reject").font(.system(size: 12)).foregroundStyle(.secondary)
                    }
                }
            } else if let reopen {
                LiveButton(tooltip: "Put it back to suggested", action: reopen) {
                    Text("Reopen").font(.system(size: 12)).foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .liveRow(selected: selected)
        // One element per item with its actions, instead of a node per text, badge and button: with 425 suggestions a
        // walk ran out of its budget after 887 nodes (2026-11-06).
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Confirm") { if let decide, item.canConfirm { decide(true, nil) } }
        .accessibilityAction(named: "Reject") { decide?(false, nil) }
        .accessibilityAction(named: "Reopen") { reopen?() }
        .accessibilityAction(named: "Play") { if let seconds = item.seconds { play(seconds) } }
        .accessibilityActions {
            if needsSpeaker, let decide {
                ForEach(item.candidates ?? [], id: \.self) { name in
                    Button("Confirm as \(name)") { decide(true, name) }
                }
                Button("Confirm as a typed name…") { naming = true }
            }
        }
    }
}


private struct QuestionRow: View {
    let item: MeetingItem
    let busy: Bool
    let play: (Double) -> Void
    let answer: (String) -> Void
    @State private var typed = ""
    @AppStorage(MeetingsPreferences.typedAnswerKey) private var typedAnswer = MeetingsPreferences.TypedAnswer.always.rawValue

    private var showsField: Bool {
        (MeetingsPreferences.TypedAnswer(rawValue: typedAnswer) ?? .always).shows(choices: item.choices ?? [])
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "ear").foregroundStyle(KitPalette.renamed).font(.system(size: 11))
                    .accessibilityHidden(true)
                Text(verbatim: item.question ?? "").font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
            }
            WrapLayout(spacing: 6, lineSpacing: 6) {
                if let from = item.fromSec {
                    GhostButton("Play \(MeetingsFormat.clock(from))", symbol: "play.fill", tooltip: "Play the asked range in the meetings player") {
                        play(from)
                    }
                }
                ForEach(item.choices ?? [], id: \.self) { choice in
                    GhostButton(choice, symbol: "checkmark", tooltip: "Answer “\(choice)”; it decides the items this question settles") {
                        answer(choice)
                    }
                    .disabled(busy)
                }
                GhostButton("None of these", symbol: "xmark", tooltip: "None of the choices is right; what it decides is rejected") {
                    answer("none of these")
                }
                .disabled(busy)
                if busy { ProgressView().controlSize(.small) }
            }
            if showsField {
                HStack(spacing: 6) {
                    TextField(item.choices?.isEmpty == false ? "Or type what you heard" : "Type what you heard", text: $typed)
                        .textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                        .onSubmit(submit)
                        .accessibilityLabel("Answer to: \(item.question ?? "the question")")
                    GhostButton("Answer", symbol: "return", tooltip: "Answer with the typed text; it decides the items this question settles") {
                        submit()
                    }
                    .disabled(busy || MeetingsWords.typedAnswer(typed) == nil)
                }
            }
        }
        .padding(.vertical, 4)
        .onChange(of: item.status) { typed = "" }
    }

    /// The typed answer stays in the field until the answer is saved: the question then leaves the list, or its
    /// status changes (`.onChange` above), so a refused answer keeps what was typed.
    private func submit() {
        guard !busy, let text = MeetingsWords.typedAnswer(typed) else { return }
        answer(text)
    }
}

