import SwiftUI

/// Option B of the "transcript" sketch (`--sketch transcript=b`): "two voices, one timeline".
/// Every tool call keeps its own row, so the order and each call's status stay visible, but the row is one line in a
/// quiet work lane (a thin rail on the left): the tool, its argument and its result in a few words ("27 lines",
/// "exit 1 · 4 lines"). Output opens only on a click, at every verbosity. A reply is set apart from the lane by a
/// rule on its left and 14 pt text (C18, C19). The session's title stays with its pane but gets a row of its own
/// that may wrap to two lines, with the facts under it (C17).
enum TranscriptSketchB {
    @MainActor
    static func row(_ base: TranscriptRowView) -> AnyView? {
        switch base.row.kind {
        case .reply(let text, let usage, let model):
            return AnyView(TranscriptSketchBReply(
                text: text, usage: usage, clock: base.row.clock, provider: base.provider,
                modelName: model ?? base.modelName, showsAuthor: base.row.showsAuthor,
                actions: base.services.rowActions?(base.row) ?? []
            ))
        case .tool(let line) where !base.expanded:
            // An opened call is the current tool row, output and fold included.
            return AnyView(TranscriptSketchBToolLine(rowId: base.row.id, line: line, cwd: base.services.cwd, onToggle: base.onToggle))
        default:
            return nil
        }
    }
}

/// A reply: a neutral rule on its left marks the agent's words, the author line, then 14 pt text.
private struct TranscriptSketchBReply: View {
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
        }
        .padding(.leading, 12)
        .padding(.vertical, 4)
        // The rule spans the whole reply; neutral, because colour in this app means state, not who wrote it.
        .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: 1)
                .fill(Color.white.opacity(0.30))
                .frame(width: 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.leading, 20)
        .padding(.trailing, 16)
        .padding(.top, showsAuthor ? 12 : 2)
        .padding(.bottom, 6)
        .contentShape(Rectangle())
        .modifier(TranscriptSketchRowMenu(actions: actions))
    }
}

/// A closed tool call: one 21 pt line in the work lane. The rail of consecutive calls joins into one line.
private struct TranscriptSketchBToolLine: View {
    let rowId: String
    let line: TranscriptToolLine
    let cwd: String?
    let onToggle: (String) -> Void

    var body: some View {
        // A closed presentation builds no body blocks: only the header words and the result's line count.
        let presentation = ToolPresentation.make(line: line, loaded: nil, context: 0, cwd: cwd, body: false)
        let failed = line.status == .failed
        Button { onToggle(rowId) } label: {
            HStack(spacing: 7) {
                TranscriptSketchToolStatus(status: line.status)
                Text(verbatim: presentation.name)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(failed ? SessionPalette.red : SessionPalette.secondary)
                    .fixedSize()
                Text(verbatim: presentation.argument)
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer(minLength: 8)
                if !presentation.summary.isEmpty {
                    Text(verbatim: presentation.summary)
                        .font(SessionPalette.mono(10.5))
                        .foregroundStyle(failed ? SessionPalette.red : SessionPalette.faint)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: 260, alignment: .trailing)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(SessionPalette.faint)
                    .frame(width: 12)
            }
            .padding(.horizontal, 8)
            .frame(height: 21)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 6))
        .padding(.leading, 36)
        .padding(.trailing, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(alignment: .leading) {
            Rectangle()
                .fill(Color.white.opacity(0.12))
                .frame(width: 1)
                .padding(.leading, 27)
        }
        .accessibilityLabel(Text("\(presentation.name) \(presentation.argument), \(presentation.summary)"))
        .accessibilityValue(Text("Collapsed"))
        .accessibilityIdentifier("transcript-sketch-tool-line")
    }
}

/// The pane's header in option B: the title on a row of its own, as wide as the pane and up to two lines, so it
/// never loses its ending in a 716 pt column; the status, model, account, folder, branch, counters and actions on
/// the row under it.
struct TranscriptSketchBTitle: View {
    let info: SessionDetailInfo
    let actions: SessionDetailActions
    var leadingInset: CGFloat
    @Binding var showSidebar: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .top, spacing: 10) {
                AIProviderGlyph(meta: info.provider, size: 18)
                    .padding(.top, 1)
                Text(verbatim: info.title)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(SessionPalette.text)
                    .lineLimit(2)
                    .truncationMode(.middle)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contextMenu {
                        Button("Copy title") { actions.copy(info.title) }
                        Button("Copy session id") { actions.copy(info.sessionId) }
                    }
            }
            HStack(spacing: 12) {
                Button { (actions.openTerminal ?? actions.focus)?() } label: {
                    HStack(spacing: 5) {
                        SessionStatusDot(color: info.livenessColor, size: 7)
                        Text(verbatim: info.statusLabel)
                            .font(.system(size: 11.5, weight: .medium))
                            .foregroundStyle(info.liveness == .ended ? SessionPalette.dim : info.livenessColor)
                    }
                }
                .buttonStyle(.genHoverPlain())
                .disabled(actions.openTerminal == nil && actions.focus == nil)
                .fixedSize()
                .instantTooltip(info.livenessNote)
                // A narrow pane keeps the status, reload and sidebar buttons: the facts drop first, then the counters.
                ViewThatFits(in: .horizontal) {
                    facts(full: true)
                    facts(full: false)
                    Spacer(minLength: 0)
                }
                HStack(spacing: 4) {
                    IconButton(systemName: "arrow.clockwise", tooltip: actions.refreshTooltip ?? "Reload the session and its transcript", action: actions.refresh)
                        .disabled(actions.refreshing)
                    IconButton(systemName: "sidebar.right", tooltip: showSidebar ? "Hide the details sidebar" : "Show the details sidebar") {
                        showSidebar.toggle()
                    }
                }
                .foregroundStyle(SessionPalette.secondary)
            }
            .frame(height: 22)
        }
        .padding(.leading, min(leadingInset, 16))
        .padding(.trailing, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
        .overlay(alignment: .bottom) {
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
        }
        .accessibilityIdentifier("session-details-header")
    }

    /// The header's middle: the model and the counters, plus the account, folder, branch and last activity when `full`.
    @ViewBuilder
    private func facts(full: Bool) -> some View {
        HStack(spacing: 12) {
            if let model = info.model, !model.isEmpty {
                SessionPill(text: model).fixedSize()
            }
            if full, let account = info.account, !account.isEmpty {
                Text(verbatim: "@\(account)")
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .fixedSize()
            }
            if full, let cwd = info.cwd, !cwd.isEmpty {
                fact("folder", (cwd as NSString).lastPathComponent, tip: cwd)
            }
            if full, let branch = info.branch {
                fact("arrow.triangle.branch", branch, tip: "Git branch of the session folder")
            }
            if full, let last = info.lastActivityAt {
                LiveTime(date: last) { "active \($0)" }
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .fixedSize()
            }
            Spacer(minLength: 8)
            if let context = info.contextTokens {
                Text(verbatim: "ctx \(SessionFormat.tokens(context))")
                    .font(SessionPalette.mono(11, weight: .semibold))
                    .foregroundStyle(SessionPalette.secondary)
                    .fixedSize()
            }
            if info.errorCount > 0 {
                Text(verbatim: "\(info.errorCount) failed")
                    .font(SessionPalette.mono(11, weight: .semibold))
                    .foregroundStyle(SessionPalette.red)
                    .fixedSize()
            }
        }
    }

    private func fact(_ symbol: String, _ text: String, tip: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: symbol).font(.system(size: 10))
            Text(verbatim: text).lineLimit(1).truncationMode(.middle)
        }
        .font(.system(size: 11.5))
        .foregroundStyle(SessionPalette.dim)
        .layoutPriority(-1)
        .instantTooltip(tip)
    }
}
