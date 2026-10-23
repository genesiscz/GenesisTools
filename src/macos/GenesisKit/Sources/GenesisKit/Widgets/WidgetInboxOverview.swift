import SwiftUI

/// The inbox button's view: inbox entries from every session in one list, the waiting ones first. A row opens in place
/// to show its session and the way to that session's whole inbox (with the entry open) and its cmux pane.
struct WidgetInboxOverview: View {
    @ObservedObject var model: WidgetModel
    @State private var filter = "all"
    @State private var openID: String?
    @GenReduceMotion private var reduceMotion

    private var items: [WidgetInboxItem] {
        let all = model.inboxOverviewItems
        switch filter {
        case "needs": return all.filter(\.needsAnswer)
        case "unread": return all.filter { !$0.needsAnswer }
        default: return all
        }
    }

    var body: some View {
        let items = items
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 8) {
                GenSegmentedTabs(
                    "Inbox entries",
                    items: [.init("all", "All"), .init("needs", "Needs you"), .init("unread", "Unread")],
                    selection: Binding(get: { filter }, set: { value in
                        model.holdAgentFit()
                        filter = value
                    }), minSegmentWidth: 70, identifier: "widget.overview.filter")
                Spacer(minLength: 4)
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
                    ForEach(items, id: \.id) { item in row(item) }
                }
                if model.inbox.truncated {
                    Text("The newest entries are shown. Open a session for its whole inbox.")
                        .font(.caption2).foregroundStyle(.tertiary)
                }
            }
        }
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
                        HStack(spacing: 4) {
                            Text(Self.kindLabel(item))
                            Text("·")
                            Text(session?.title ?? "Unknown session").lineLimit(1)
                            Text("·")
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
    }

    private func detail(_ item: WidgetInboxItem, session: WidgetSession?) -> some View {
        VStack(alignment: .leading, spacing: 10) {
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
        if let title = item.title, !title.isEmpty {
            return item.number.map { "DECISION \($0): " + title } ?? title
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
