import SwiftUI

/// Inline in the existing panel: source details never open a separate sheet or move the notch anchor.
struct WidgetReceiptContextView: View {
    let card: WidgetCard
    let model: WidgetModel
    @State private var expanded = false
    @State private var context: WidgetReceiptContext?
    @State private var failure: String?
    @State private var loading = false
    @State private var hasPrewarmed = false
    @State private var loadingID: UUID?

    private var source: WidgetSourceContext? { context?.sourceContext ?? card.sourceContext }
    private var summary: String {
        [source?.agentLabel ?? source?.agent, source?.project, source?.branch]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            VStack(alignment: .leading, spacing: 10) {
                if let source {
                    sourceRow("Source", source.agent)
                    sourceRow("Agent", source.agentLabel)
                    sourceRow("Model", source.aiAgent)
                    sourceRow("Session", source.sessionId)
                    sourceRow("Project", source.project)
                    sourceRow("Working directory", source.cwd)
                    sourceRow("Repository", source.repoRoot)
                    sourceRow("Branch", source.branch)
                    sourceRow("Commit", source.commitSha)
                    sourceRow("Worktree", source.worktreePath ?? (source.isWorktree == true ? "Yes" : nil))
                }
                if let anchor = context?.transcriptAnchor ?? card.transcriptAnchor {
                    sourceRow("Message", anchor.messageId)
                    sourceRow("Turn", anchor.turnId)
                    sourceRow("Tool call", anchor.toolCallId)
                }
                if let window = context?.transcript {
                    Text(window.detail).font(.caption).foregroundStyle(.secondary)
                    transcriptSection("Before", turns: window.before)
                    transcriptSection(window.status == "native" ? "Around source record" : "Around receipt", turns: window.around)
                    transcriptSection("After", turns: window.after)
                    if window.before.isEmpty && window.around.isEmpty && window.after.isEmpty {
                        Text("No readable messages in this bounded window.").font(.caption).foregroundStyle(.secondary)
                    }
                    if window.truncated {
                        Text("Showing a bounded excerpt. Open Conversation for the full session.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                    if let failure {
                        Text("Could not refresh: " + failure).font(.caption).foregroundStyle(.secondary)
                    }
                } else if let message = context?.error ?? failure {
                    Text(message).font(.caption).foregroundStyle(.secondary)
                } else if loading {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.mini)
                        Text("Loading nearby messages…").font(.caption)
                    }
                } else if card.sourceContext == nil {
                    Text("This older receipt has no stored source details.")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
            .padding(.top, 8)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "text.bubble")
                Text(summary.isEmpty ? "Source and context" : summary).lineLimit(1)
            }
            .font(.system(size: 11, weight: .medium)).foregroundStyle(.secondary)
        }
        .padding(10)
        .background(.primary.opacity(0.045), in: RoundedRectangle(cornerRadius: 11))
        .task(id: expanded) {
            guard ["answer", "decision", "todo", "form"].contains(card.kind), expanded || !hasPrewarmed else { return }
            hasPrewarmed = true
            let requestID = UUID()
            loadingID = requestID
            loading = context == nil
            failure = nil
            defer {
                if loadingID == requestID { loading = false }
            }
            do {
                // Opening again consults the model cache; only an expired or missing entry runs the command.
                let value = try await model.receiptContext(for: card)
                try Task.checkCancellation()
                if loadingID == requestID, context != value { context = value }
            } catch {
                if !Task.isCancelled, loadingID == requestID { failure = error.localizedDescription }
            }
        }
    }

    @ViewBuilder private func sourceRow(_ title: String, _ value: String?) -> some View {
        if let value, !value.isEmpty {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.caption2).foregroundStyle(.secondary)
                Text(value).font(.system(size: 11)).textSelection(.enabled)
            }
        }
    }

    @ViewBuilder private func transcriptSection(_ title: String, turns: [TranscriptTurn]) -> some View {
        if !turns.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                Text(title).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                ForEach(turns) { turn in
                    VStack(alignment: .leading, spacing: 4) {
                        Text(turn.role.capitalized).font(.caption2).foregroundStyle(.secondary)
                        if !turn.text.isEmpty {
                            Text(turn.text).font(.system(size: 11)).textSelection(.enabled)
                        }
                        ForEach(turn.tools) { tool in
                            Text(tool.name + (tool.inputPreview.isEmpty ? "" : " · " + tool.inputPreview))
                                .font(.system(size: 10, design: .monospaced)).textSelection(.enabled)
                            if let result = tool.result, !result.isEmpty {
                                Text(result).font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.secondary).textSelection(.enabled)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8).background(.primary.opacity(0.035), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
    }
}
