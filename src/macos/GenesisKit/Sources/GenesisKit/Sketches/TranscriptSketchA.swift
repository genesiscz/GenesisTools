import SwiftUI

/// Option A of the "transcript" sketch (`--sketch transcript=a`): "the conversation reads first".
/// Every run of tool calls between two messages is one quiet line ("Ran 3 commands · Read 2 files"), at every
/// verbosity; a reply is a message with its author line and 14 pt text on a reading measure (C18, C19). The
/// session's title leaves the pane for the hub's one subject header in the title bar (C17); the pane keeps one
/// slim row with the folder, the branch, the counters and the actions.
enum TranscriptSketchA {
    /// The widest a reply's text runs: about 100 characters at 14 pt, so a wide pane does not make 300-character lines.
    static let readingMeasure: CGFloat = 760

    @MainActor
    static func row(_ base: TranscriptRowView) -> AnyView? {
        switch base.row.kind {
        case .reply(let text, let usage, let model):
            return AnyView(TranscriptSketchAReply(
                text: text, usage: usage, clock: base.row.clock, provider: base.provider,
                modelName: model ?? base.modelName, showsAuthor: base.row.showsAuthor,
                actions: base.services.rowActions?(base.row) ?? []
            ))
        case .toolGroup(let group):
            return AnyView(TranscriptSketchAToolRun(
                id: base.row.id, group: group, open: base.expanded, openMembers: base.openMembers,
                fullMembers: base.fullMembers, wrap: base.wrap, services: base.services, onToggle: base.onToggle
            ))
        default:
            return nil
        }
    }
}

/// A reply as a message: the author line, then the text at 14 pt, no wider than the reading measure.
private struct TranscriptSketchAReply: View {
    let text: String
    let usage: String?
    let clock: String?
    let provider: AIProviderMeta
    let modelName: String?
    let showsAuthor: Bool
    let actions: [TranscriptRowAction]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsAuthor {
                TranscriptSketchAuthor(provider: provider, modelName: modelName, clock: clock, usage: usage)
            }
            TranscriptSketchReplyText(text: text)
                .frame(maxWidth: TranscriptSketchA.readingMeasure, alignment: .leading)
                // Under the author's name, past the mark.
                .padding(.leading, 26)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.top, showsAuthor ? 14 : 4)
        .padding(.bottom, 6)
        .contentShape(Rectangle())
        .modifier(TranscriptSketchRowMenu(actions: actions))
    }
}

/// A run of tool calls as one line under the message it belongs to; a click lists the calls, each one line that
/// opens to its output (the current tool row, with its fold).
private struct TranscriptSketchAToolRun: View {
    let id: String
    let group: TranscriptToolGroup
    let open: Bool
    let openMembers: Set<String>
    let fullMembers: Set<String>
    let wrap: TranscriptWrap
    let services: TranscriptServices
    let onToggle: (String) -> Void

    private var lines: [(row: TranscriptRow, line: TranscriptToolLine)] {
        group.members.compactMap { member in
            if case .tool(let line) = member.kind { return (member, line) }
            return nil
        }
    }

    /// One call names itself ("Bash vitrinka board dump --help"); several say what kinds ran.
    private var title: String {
        if lines.count == 1, let only = lines.first?.line {
            return only.displayName
        }
        return group.summary
    }

    /// The single call's argument, or the last call of the run: what the agent did just before it spoke again.
    private var detail: String? {
        guard let last = lines.last?.line, !last.keyArgument.isEmpty else { return nil }
        return lines.count == 1 ? last.keyArgument : "last: \(last.displayName) \(last.keyArgument)"
    }

    private var running: Bool { lines.contains { $0.line.status == .pending } }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Button { onToggle(id) } label: {
                HStack(spacing: 8) {
                    Group {
                        if running {
                            TranscriptSketchToolStatus(status: .pending)
                        } else {
                            Image(systemName: group.failed > 0 ? "exclamationmark.triangle" : "wrench.and.screwdriver")
                                .font(.system(size: 10))
                                .foregroundStyle(group.failed > 0 ? SessionPalette.red : SessionPalette.faint)
                        }
                    }
                    .frame(width: 14)
                    Text(verbatim: title)
                        .font(.system(size: 11.5, weight: .medium))
                        .foregroundStyle(SessionPalette.dim)
                        .lineLimit(1)
                        .fixedSize()
                    if let detail {
                        Text(verbatim: detail)
                            .font(SessionPalette.mono(10.5))
                            .foregroundStyle(SessionPalette.faint)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                    if group.failed > 0 {
                        Text(verbatim: "\(group.failed) failed")
                            .font(SessionPalette.mono(10.5, weight: .semibold))
                            .foregroundStyle(SessionPalette.red)
                            .fixedSize()
                    }
                    Spacer(minLength: 8)
                    if let duration = group.duration {
                        Text(verbatim: "~" + SessionFormat.duration(duration))
                            .font(SessionPalette.mono(10.5))
                            .foregroundStyle(SessionPalette.faint)
                            .fixedSize()
                    }
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(SessionPalette.faint)
                        .rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 12)
                }
                .padding(.horizontal, 8)
                .frame(height: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 6))
            .padding(.leading, 34)
            .padding(.trailing, 12)
            .accessibilityLabel(Text([title, detail].compactMap { $0 }.joined(separator: ", ")))
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            .accessibilityIdentifier("transcript-sketch-tool-run")

            if open {
                ForEach(lines, id: \.row.id) { member in
                    ToolCallRowView(
                        rowId: member.row.id,
                        toolId: member.line.toolId,
                        line: member.line,
                        verbosity: .inputs,
                        open: openMembers.contains(member.row.id),
                        showAll: fullMembers.contains(member.row.id),
                        wrap: wrap,
                        services: services,
                        onToggle: onToggle
                    )
                    .padding(.leading, 24)
                }
            }
        }
    }
}

/// The pane's only header row in option A: the title, status, model and account went up into the hub's subject
/// header (GenesisTools `TranscriptSketchSubjectHeader`), so the pane starts with where the session works and what it
/// cost, then its actions. One row of 30 pt instead of two rows of 66 pt.
struct TranscriptSketchAPaneBar: View {
    let info: SessionDetailInfo
    let actions: SessionDetailActions
    var leadingInset: CGFloat
    @Binding var showSidebar: Bool

    var body: some View {
        HStack(spacing: 14) {
            if let cwd = info.cwd, !cwd.isEmpty {
                item("folder", (cwd as NSString).abbreviatingWithTildeInPath, tip: "\(cwd) · click to show it in Finder",
                     action: info.cwdExists ? actions.openInFinder : nil)
                    .layoutPriority(1)
            }
            if let branch = info.branch {
                item("arrow.triangle.branch", branch, tip: "Git branch of the session folder", action: actions.openBranch ?? { actions.copy(branch) })
                    .layoutPriority(1)
            }
            if let last = info.lastActivityAt {
                LiveTime(date: last) { "active \($0)" }
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            ViewThatFits(in: .horizontal) {
                counters(full: true).fixedSize()
                counters(full: false).fixedSize()
                Color.clear.frame(width: 0, height: 0)
            }
            buttons
        }
        .padding(.leading, min(leadingInset, 16))
        .padding(.trailing, 12)
        .frame(height: 30)
        .overlay(alignment: .bottom) {
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
        }
        .accessibilityIdentifier("session-details-header")
    }

    private func counters(full: Bool) -> some View {
        HStack(spacing: 10) {
            if let context = info.contextTokens {
                counter("ctx", SessionFormat.tokens(context), color: SessionPalette.secondary, tip: "Context size of the last turn")
            }
            if full, let cost = info.usage?.costUsd, cost > 0 {
                counter(nil, SessionFormat.usd(cost), color: SessionPalette.orange, tip: info.usage?.costNote ?? "Cost the session file reports")
            }
            if info.errorCount > 0 {
                counter(nil, "\(info.errorCount) failed", color: SessionPalette.red, tip: "Failed tool calls in the loaded turns")
            }
        }
    }

    private func counter(_ label: String?, _ value: String, color: Color, tip: String) -> some View {
        Button { actions.copy(value) } label: {
            HStack(spacing: 4) {
                if let label {
                    Text(verbatim: label).foregroundStyle(SessionPalette.faint)
                }
                Text(verbatim: value).foregroundStyle(color)
            }
            .font(SessionPalette.mono(11.5, weight: .semibold))
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tip + "\nClick to copy")
    }

    private var buttons: some View {
        HStack(spacing: 4) {
            if !actions.resumeCommand.isEmpty {
                IconButton(systemName: "terminal", tooltip: "Copy the command that resumes this session in a terminal") {
                    actions.copy(actions.resumeCommand)
                }
            }
            IconButton(systemName: "arrow.clockwise", tooltip: actions.refreshTooltip ?? "Reload the session and its transcript", action: actions.refresh)
                .disabled(actions.refreshing)
            IconButton(systemName: "sidebar.right", tooltip: showSidebar ? "Hide the details sidebar" : "Show the details sidebar") {
                showSidebar.toggle()
            }
        }
        .foregroundStyle(SessionPalette.secondary)
    }

    private func item(_ symbol: String, _ text: String, tip: String, action: (() -> Void)?) -> some View {
        Button { action?() } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol).font(.system(size: 10))
                Text(verbatim: text).lineLimit(1).truncationMode(.middle)
            }
            .font(.system(size: 11.5))
            .foregroundStyle(SessionPalette.dim)
        }
        .buttonStyle(.genHoverPlain())
        .disabled(action == nil)
        .instantTooltip(tip)
    }
}
