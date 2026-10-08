import SwiftUI

/// The agent's proposal drafts above the PR threads. Before this list existed the panel read only the
/// PR's own threads, so a pushed review said "No open threads" while its drafts sat in another file of
/// the diff with nothing pointing at them (2026-10-08, !7528). A row opens the draft's file and marks
/// its card, the same way a PR thread row does.
struct AgentDraftsList: View {
    @ObservedObject var model: ReviewModel
    @AppStorage("review.agentDrafts.folded", store: HubDefaults.store) private var folded = false

    var body: some View {
        if let proposal = model.proposal {
            let drafts = proposal.drafts
            if !drafts.isEmpty {
                let open = drafts.filter { $0.status == "proposed" }.count
                VStack(alignment: .leading, spacing: 6) {
                    Button {
                        folded.toggle()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: folded ? "chevron.right" : "chevron.down")
                                .font(.system(size: 9, weight: .semibold))
                                .frame(width: 10)
                            Text(verbatim: "\(proposal.agent) drafts")
                                .font(.system(size: 11.5, weight: .semibold))
                            Text(verbatim: "\(open) of \(drafts.count) open")
                                .font(.system(size: 11))
                                .foregroundColor(open > 0 ? ReviewPalette.modified : ReviewPalette.dim)
                            Spacer(minLength: 0)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    if !folded {
                        ForEach(drafts, id: \.id) { draft in
                            AgentDraftRow(draft: draft, focused: model.focusedCard == "draft:\(draft.id)")
                                .rowButton(cornerRadius: 6) { model.revealDraft(draft.id) }
                        }
                    }
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                Divider()
            }
        }
    }
}

private struct AgentDraftRow: View {
    let draft: ProposalDocument.Draft
    let focused: Bool

    private var statusColor: Color {
        switch draft.status {
        case "accepted", "edited": return ReviewPalette.added
        case "rejected": return ReviewPalette.dim
        default: return ReviewPalette.modified
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
                Text(verbatim: draft.severity)
                    .font(.system(size: 10, weight: .semibold))
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(Capsule().stroke(statusColor.opacity(0.6)))
                    .foregroundColor(statusColor)
                Text(verbatim: "\((draft.path as NSString).lastPathComponent):\(draft.line)")
                    .font(.system(size: 11, design: .monospaced))
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 0)
                Text(verbatim: draft.status)
                    .font(.system(size: 10.5))
                    .foregroundColor(statusColor)
            }
            Text(verbatim: (draft.editedBody ?? draft.body).split(separator: "\n").first.map(String.init) ?? "")
                .font(.system(size: 11.5))
                .foregroundColor(Color.white.opacity(0.8))
                .lineLimit(2)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .fill(focused ? ReviewPalette.renamed.opacity(0.16) : Color.clear)
        )
        .contentShape(Rectangle())
        .instantTooltip("\(draft.path):\(draft.line) · click to open it in the diff")
    }
}
