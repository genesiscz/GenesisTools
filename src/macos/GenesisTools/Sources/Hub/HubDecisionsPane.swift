import SwiftUI

// The session's Decisions pane: every decision of the selected session, in every state, drawn with
// the Inbox's card (`InboxDecisionCard`) and sent with the Inbox's Send bar. One card design, one
// pick-then-send behavior, one store (R2): a pick made here shows in the Inbox and in /qa, and the
// other way round. ⌘F: the shared panel find (Hub/HubPanelFind.swift).

struct DecisionsView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel
    @AppStorage("hub.decisions.filter") private var filter = "open"
    @State private var find = PanelFindModel(scope: "decisions", title: "the decisions")

    private var shown: [InboxItem] {
        model.decisions
            .filter { item in
                switch filter {
                case "open": return item.isOpen
                case "answered": return !item.isOpen
                default: return true
                }
            }
            .sorted { lhs, rhs in
                if (lhs.blocking ?? false) != (rhs.blocking ?? false) { return lhs.blocking ?? false }
                return (lhs.number ?? 0) < (rhs.number ?? 0)
            }
    }

    /// The selected session as the Inbox sees it, so the card and the Send bar work unchanged.
    private var session: InboxSession? {
        guard let row = model.selected else { return nil }
        return InboxSession(
            sessionId: row.sessionId,
            provider: row.provider,
            title: row.title,
            project: row.project,
            cwd: row.cwd,
            branch: row.gitBranch,
            account: row.account,
            lastAt: "",
            waiting: model.decisions.filter(\.isOpen).count,
            drafted: nil,
            queued: model.decisions.filter { $0.status == "answered" }.count,
            reply: nil,
            items: model.decisions
        )
    }

    var body: some View {
        // The find bar is its own row, not a top inset over the scroll view: selectable text drew
        // through the inset's background.
        VStack(spacing: 0) {
            PanelFindBar(find: find)
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    toolbar
                    if shown.isEmpty {
                        Text(model.decisions.isEmpty ? "No decisions recorded for this session." : filter == "open" ? "No open decisions." : "Nothing here.")
                            .font(.system(size: 12.5))
                            .foregroundColor(ReviewPalette.dim)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 30)
                    }
                    if let session {
                        ForEach(shown) { item in
                            InboxDecisionCard(model: model, inbox: inbox, session: session, item: item)
                        }
                        InboxSendBar(model: model, inbox: inbox, session: session)
                    }
                }
                .padding(18)
            }
        }
        .panelFind(find, revision: [filter] + model.decisions.map { "\($0.id) \($0.status) \($0.draftOption ?? "")" }) {
            shown.map { PanelFindRow(id: $0.id, fields: $0.findFields) }
        }
        // A pick, a Dismiss or a Send changed the store: read the pane's list again.
        .onChange(of: inbox.writeGeneration) { _, _ in
            if let sessionId = model.selected?.sessionId {
                model.loadDecisions(for: sessionId)
            }
        }
        .sheet(item: $inbox.resumeFor) { session in
            InboxResumeSheet(model: model, inbox: inbox, session: session)
        }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Picker("", selection: Binding(get: { filter }, set: { next in
                HubMainBusy.measure("decisions.filter")
                filter = next
            })) {
                Text("Open").tag("open")
                Text("Answered").tag("answered")
                Text("All").tag("all")
            }
            .pickerStyle(.segmented)
            .frame(width: 210)
            .instantTooltip("Which decisions to show")
            Text("Posted and harvested decisions, and the ones the last reply asks. A click marks; Send delivers.")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            if model.loadingDecisions {
                ProgressView().controlSize(.small)
            }
            Spacer()
        }
    }
}
