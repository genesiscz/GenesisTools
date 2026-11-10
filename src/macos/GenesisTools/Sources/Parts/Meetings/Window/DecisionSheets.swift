import SwiftUI

/// "This also affects" (R22, G9, G26, G28): what a decision reaches beyond its row, from `decision.plan`, before it is
/// saved. The look-alikes it settles are playable, so each can be checked at once; "Do not ask again" turns
/// `meetings.rows.askReach` to never.
struct ReachSheet: View {
    let pending: MeetingDetailModel.PendingReach
    let detail: MeetingDetailModel
    @State private var askAgain = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("This also affects").font(.system(size: 15, weight: .semibold))
            Text(verbatim: "Besides \(pending.row.label), this decision also changes:")
                .font(.system(size: 12.5)).foregroundStyle(.secondary)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    if !pending.reach.items.isEmpty {
                        Text(verbatim: "\(Plural.count(pending.reach.items.count, "look-alike item")) it settles the same way")
                            .font(.system(size: 12, weight: .semibold))
                        ForEach(pending.reach.items, id: \.id) { item in
                            HStack(spacing: 8) {
                                if let player = detail.window?.player {
                                    MomentButton(player: player, meeting: detail.id, target: .item(item.id), label: item.id, source: .speakerChip)
                                }
                                Text(verbatim: detail.rows.value?.rows.first { $0.id == item.id }?.what ?? item.id)
                                    .font(.system(size: 12.5)).lineLimit(2)
                            }
                        }
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
            .frame(maxHeight: 320)
            Toggle("Do not ask again", isOn: Binding(get: { !askAgain }, set: { askAgain = !$0 }))
                .toggleStyle(.checkbox).font(.system(size: 12))
            HStack {
                Spacer()
                Button("Cancel") { detail.cancelReach() }.keyboardShortcut(.cancelAction)
                Button("Save") { detail.applyReach(pending, askAgain: askAgain) }.keyboardShortcut(.defaultAction)
            }
        }
        .padding(18)
        .frame(width: 460)
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
                Text(history.item.map { "History of \($0)" } ?? "History of this meeting").font(.system(size: 15, weight: .semibold))
                Spacer()
                Button("Done") { detail.history = nil }.keyboardShortcut(.defaultAction)
            }
            switch history.entries {
            case .idle, .loading:
                ProgressView().controlSize(.small).frame(maxWidth: .infinity, minHeight: 120)
            case .failed(let failure, _):
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                           fixes: [.button("Retry", symbol: "arrow.clockwise") { detail.openHistory(item: history.item) }])
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
        return who.prefix(1).uppercased() + who.dropFirst() + " " + MeetingsWords.entryAction(entry)
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
