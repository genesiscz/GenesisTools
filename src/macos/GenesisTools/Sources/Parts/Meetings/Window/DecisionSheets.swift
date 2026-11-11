import SwiftUI

/// "This also affects" (R22, G9, G26, G28): what a decision reaches beyond its row, from `decision.plan`, before it is
/// saved (genesiscz.md 6 and 9). The question's own targets outside the span it asks about ("This answer also sets")
/// and the look-alikes it settles are listed apart, each with its own quote, time and play control; the same question
/// over the same span is never asked again. Each item can be struck (it stays as it is and leaves the decision) and put
/// back by one more click; Save applies only the rest. "Do not ask again" turns `meetings.rows.askReach` to never.
struct ReachSheet: View {
    let pending: MeetingDetailModel.PendingReach
    let detail: MeetingDetailModel
    @State private var askAgain = true

    var body: some View {
        let struck = detail.pendingStruck.intersection(pending.reach.judged.map(\.id))
        VStack(alignment: .leading, spacing: 12) {
            Text("This also affects").font(.system(size: 15, weight: .semibold))
            Text(verbatim: Self.lead(pending))
                .font(.system(size: 12.5)).foregroundStyle(.secondary)
            ScrollView {
                ReachList(pending: pending, detail: detail)
            }
            .frame(maxHeight: 360)
            if !struck.isEmpty {
                Text(verbatim: "\(Plural.count(struck.count, "struck item")) \(struck.count == 1 ? "stays" : "stay") as \(struck.count == 1 ? "it is" : "they are") and \(struck.count == 1 ? "is" : "are") not part of this decision.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
            }
            Toggle("Do not ask again", isOn: Binding(get: { !askAgain }, set: { askAgain = !$0 }))
                .toggleStyle(.checkbox).font(.system(size: 12))
            HStack {
                Spacer()
                Button("Cancel") { detail.cancelReach() }.keyboardShortcut(.cancelAction)
                if !detail.lookAlikes(of: pending).isEmpty {
                    Button("Only this question") { detail.applyOnlyThis(pending) }
                        .instantTooltip("Answer \(pending.row.label) and what it decides. The questions that look alike stay open.")
                }
                Button(struck.isEmpty ? "Save" : "Save the rest") { detail.applyReach(pending, askAgain: askAgain) }
                    .keyboardShortcut(.defaultAction)
                    .instantTooltip(struck.isEmpty ? "Save the answer and everything listed" : "Save the answer and every item that is not struck")
            }
        }
        .padding(18)
        .frame(width: 520)
    }

    /// "Besides Q11 (→ Ussov Stanislav), this decision also changes:" — a changed answer says so.
    static func lead(_ pending: MeetingDetailModel.PendingReach) -> String {
        let answer = pending.action.answer.map { " (→ \($0))" } ?? ""
        let verb = pending.action.replaces == nil ? "this decision also changes" : "the changed answer also changes"
        return "Besides \(pending.row.label)\(answer), \(verb):"
    }
}

/// The sheet's list: what the answer also sets, the look-alikes, and the same question as one line. Apart from the
/// sheet's scroll view, so a test can render it (`ImageRenderer` draws no scroll view's content).
struct ReachList: View {
    let pending: MeetingDetailModel.PendingReach
    let detail: MeetingDetailModel

    var body: some View {
        let judged = pending.reach.judged
        let sets = judged.filter { $0.role == .sets }
        let alike = judged.filter { $0.role == .lookAlike }
        let same = pending.reach.items.filter { $0.role == .same }
        VStack(alignment: .leading, spacing: 12) {
            if !sets.isEmpty {
                section("This answer also sets", items: sets)
            }
            if !alike.isEmpty {
                section("\(Plural.count(alike.count, "look-alike")) it settles the same way", items: alike)
            }
            if !same.isEmpty {
                Text(verbatim: Self.sameLine(same, detail: detail))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            if let lines = pending.reach.lines, lines > 1 {
                Label("\(Plural.count(lines, "line")) of the transcript", systemImage: "text.alignleft").font(.system(size: 12.5))
            }
            ForEach(pending.reach.dictionary.filter(\.teaches), id: \.self) { entry in
                Label("The \(entry.project ?? "meeting") dictionary learns “\(entry.heard)” → “\(entry.fixed)”"
                      + (entry.seenBefore > 0 ? ", seen \(Plural.count(entry.seenBefore, "time")) before" : ""),
                      systemImage: "character.book.closed")
                    .font(.system(size: 12.5))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// "It also closes Q12, about the same span: …"; a question no row names is counted, never shown by its id.
    static func sameLine(_ same: [DecisionReach.Item], detail: MeetingDetailModel) -> String {
        let labels = same.compactMap { item in item.row?.label ?? (detail.rowLabel(item.id) == item.id ? nil : detail.rowLabel(item.id)) }
        let named = labels.count == same.count ? labels.joined(separator: ", ") : Plural.count(same.count, "question")
        return "It also closes \(named), about the same span: the same question, not asked again."
    }

    private func section(_ title: String, items: [DecisionReach.Item]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: title).font(.system(size: 12, weight: .semibold))
            ForEach(items) { item in
                ReachItemRow(item: item, struck: detail.pendingStruck.contains(item.id), detail: detail)
            }
        }
    }
}

/// One reached item, judged as its own row is: the strike toggle, its time as a play control, what it is, its value
/// before and after (each in its state's look), and the words of its own speaker. Never a bare item id.
private struct ReachItemRow: View {
    let item: DecisionReach.Item
    let struck: Bool
    let detail: MeetingDetailModel

    var body: some View {
        let name = Self.name(item, detail: detail)
        HStack(alignment: .top, spacing: 8) {
            // lint-rules-ignore: short list (a sheet's few reached items; each strike toggle must answer at once)
            IconButton(systemName: struck ? "arrow.uturn.backward.circle" : "xmark.circle",
                       tooltip: struck ? "Put \(name) back into this decision" : "Strike \(name): it stays as it is and leaves this decision") {
                detail.toggleStruck(item.id)
            }
            .accessibilityLabel(struck ? "Put back \(name)" : "Strike \(name)")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let player = detail.window?.player {
                        MomentButton(player: player, meeting: detail.id, target: item.row?.target ?? .item(item.id),
                                     label: item.row?.whenText, source: .speakerChip)
                    }
                    Text(verbatim: name).font(.system(size: 12.5, weight: .medium)).lineLimit(2)
                        .strikethrough(struck)
                }
                if let after = item.after {
                    HStack(spacing: 5) {
                        if let before = item.before, before != after {
                            DecisionStateValue(text: before, state: DecisionState.of(status: item.row?.status ?? "suggested"))
                            Image(systemName: "arrow.right").font(.system(size: 9.5)).foregroundStyle(.secondary).accessibilityLabel("becomes")
                        }
                        DecisionStateValue(text: after, state: struck ? .rejected : .confirmed)
                    }
                }
                if let quote = Self.quote(item.row) {
                    Text(verbatim: quote).font(.system(size: 11.5)).foregroundStyle(.secondary)
                        .lineLimit(3).fixedSize(horizontal: false, vertical: true)
                }
            }
            .opacity(struck ? 0.55 : 1)
        }
        .animation(.easeOut(duration: 0.15), value: struck)
    }

    /// What a person sees the item as: a question by its label and text, anything else by its kind and time.
    static func name(_ item: DecisionReach.Item, detail: MeetingDetailModel) -> String {
        guard let row = item.row else { return MeetingDetailModel.sentenceStart(detail.rowName(item.id)) }
        return row.isQuestion ? "\(row.label) \(ReviewRowView.title(row))" : ReviewRowView.reference(row)
    }

    /// The words of the item's own speaker, as its row quotes them: "Speaker 2: “…”".
    static func quote(_ row: ReviewRow?) -> String? {
        guard let row else { return nil }
        for part in row.parts {
            if case .said(let text, let speaker, _) = part, !text.isEmpty {
                return speaker.map { "\($0): “\(text)”" } ?? "“\(text)”"
            }
        }
        return nil
    }
}

/// The meeting's decision journal, or one row's (G43): who decided what, when and why, newest first, each with an Undo
/// while nothing changed it since (R35).
struct HistorySheetView: View {
    let detail: MeetingDetailModel
    let history: MeetingDetailModel.HistorySheet

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(history.item.map { "History of \(detail.rowName($0))" } ?? "History of this meeting").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button("Done") { detail.history = nil }.keyboardShortcut(.defaultAction)
            }
            switch history.entries {
            case .idle, .loading:
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 120)
            case .failed(let failure, _):
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { detail.openHistory(item: history.item) },
                                   failure.detailsFix { detail.openHistory(item: history.item) }])
            case .loaded(let entries):
                if entries.isEmpty {
                    EmptyState(symbol: "clock", text: "Nothing decided yet", detail: "Each confirm, answer and Undo is kept here with who made it.")
                } else {
                    List(entries) { entry in
                        HistoryRow(entry: entry, detail: detail)
                    }
                    .listStyle(.inset)
                }
            }
        }
        .padding(18)
        .frame(width: 560, height: 460)
        .closesOnEscape { detail.history = nil }
    }
}

private struct HistoryRow: View {
    let entry: JournalEntry
    let detail: MeetingDetailModel

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: sentence).font(.system(size: 12.5)).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: [MeetingsFormat.dayTime(entry.at), entry.reason.map { "Why: \($0)" }].compactMap { $0 }.joined(separator: " · "))
                    .font(.system(size: 11.5)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 8)
            if entry.revertedBy != nil {
                Badge("Undone", color: KitPalette.faint)
            } else if entry.action.kind != "comment" && entry.action.kind != "revert" {
                GhostButton("Undo", symbol: "arrow.uturn.backward", tooltip: "Take this decision back") {
                    detail.revert(token: entry.token, items: entry.touched.isEmpty ? nil : Array(entry.touched).sorted()) {
                        detail.openHistory(item: detail.history?.item)
                    }
                }
            }
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
    }

    private var sentence: String {
        let who = MeetingsWords.actor(entry.actor)
        return who.prefix(1).uppercased() + who.dropFirst() + " " + MeetingsWords.entryAction(entry, label: detail.rowName)
    }
}

/// Esc closes a sheet whose only button is a default-action Done: a SwiftUI sheet hears Esc only through a
/// `.cancelAction` key equivalent (which works with no focused view), and the exit command covers a focused one. The hub's
/// sheets use the same pair (`HubInbox.swift`, F16).
private struct ClosesOnEscape: ViewModifier {
    let close: () -> Void

    func body(content: Content) -> some View {
        content
            .background {
                Button("Close", action: close)
                    .keyboardShortcut(.cancelAction)
                    .opacity(0)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            .onExitCommand(perform: close)
    }
}

extension View {
    /// Esc runs `close` (see `ClosesOnEscape`).
    func closesOnEscape(_ close: @escaping () -> Void) -> some View {
        modifier(ClosesOnEscape(close: close))
    }
}
