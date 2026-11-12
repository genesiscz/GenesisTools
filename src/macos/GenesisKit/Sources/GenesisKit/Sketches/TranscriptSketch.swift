import SwiftUI

/// Hub UX wave 2, area "transcript" (C17, C18, C19, C1-later): what the two redesign options change in the shared
/// session screen. Every question here goes through `HubLayout.option("transcript")`, so a run without
/// `--sketch transcript=a|b` draws every current view unchanged. Option A lives in `TranscriptSketchA.swift`, option B
/// in `TranscriptSketchB.swift`; this file only routes to them.
public enum TranscriptSketch {
    /// "a", "b", or nil for the current views.
    @MainActor public static var option: String? { HubLayout.option("transcript") }

    /// Option A folds every run of tool calls between two messages into one line, at every verbosity (today only
    /// Minimal folds them).
    @MainActor static var foldsToolRuns: Bool { option == "a" }

    /// Option B draws every tool call closed, as one line with its result, at every verbosity; a click opens it.
    /// Option A's calls sit inside folded runs, which start closed anyway.
    @MainActor static var opensToolsByDefault: Bool { option != "b" }

    /// The row an option draws instead of the current one, or nil to keep the current row.
    @MainActor
    static func row(_ base: TranscriptRowView) -> AnyView? {
        switch option {
        case "a": return TranscriptSketchA.row(base)
        case "b": return TranscriptSketchB.row(base)
        default: return nil
        }
    }

    /// A reply's text in both options: 14 pt at full contrast, against the transcript's 13 pt, so the agent's words
    /// outweigh the tool rows around them (C19).
    static let replyStyle: TranscriptMarkdownStyle = {
        var style = TranscriptMarkdownStyle.sessionTranscript
        style.bodySize = 14
        style.textColor = Color.white.opacity(0.96)
        style.lineSpacing = 4
        style.blockSpacing = 10
        style.headingScale = 0.95
        return style
    }()
}

/// A reply's markdown in the sketch style: the host's renderer, else inline markdown in one `Text`.
struct TranscriptSketchReplyText: View {
    let text: String

    var body: some View {
        Group {
            if let rendered = GenesisKit.host?.transcriptMarkdown(text, style: TranscriptSketch.replyStyle) {
                rendered
            } else {
                Text((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text))
                    .font(.system(size: 14))
                    .lineSpacing(4)
                    .foregroundStyle(TranscriptSketch.replyStyle.textColor)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .hoverTextSelection()
    }
}

/// The author line of a reply in both options: the provider's mark, its name, the model, the time, the usage.
struct TranscriptSketchAuthor: View {
    let provider: AIProviderMeta
    let modelName: String?
    let clock: String?
    let usage: String?

    var body: some View {
        HStack(spacing: 8) {
            AIProviderGlyph(meta: provider, size: 18)
            Text(verbatim: provider.displayName)
                .font(.system(size: 13, weight: .semibold))
                .foregroundStyle(SessionPalette.text)
            if let modelName, !modelName.isEmpty {
                SessionPill(text: modelName)
            }
            if let clock {
                Text(verbatim: clock)
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
            }
            Spacer(minLength: 8)
            if let usage {
                Text(verbatim: usage)
                    .font(SessionPalette.mono(10.5))
                    .foregroundStyle(SessionPalette.faint)
                    .lineLimit(1)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The reply's actions (Copy, Fork) as a context menu, as the current reply offers them.
struct TranscriptSketchRowMenu: ViewModifier {
    let actions: [TranscriptRowAction]

    func body(content: Content) -> some View {
        if actions.isEmpty {
            content
        } else {
            content.contextMenu {
                ForEach(actions) { action in
                    Button(action.title, action: action.run)
                }
            }
        }
    }
}

/// A tool call's status as a 10 pt glyph: a green dot, a red cross, an orange ring while it runs.
struct TranscriptSketchToolStatus: View {
    let status: TranscriptToolStatus

    var body: some View {
        switch status {
        case .ok:
            SessionStatusDot(color: SessionPalette.green).frame(width: 10)
        case .failed:
            Image(systemName: "xmark")
                .font(.system(size: 8.5, weight: .heavy))
                .foregroundStyle(SessionPalette.red)
                .frame(width: 10)
                .accessibilityLabel(Text("Failed"))
        case .pending:
            SessionStatusDot(color: SessionPalette.orange)
                .overlay(Circle().strokeBorder(SessionPalette.orange.opacity(0.4), lineWidth: 3).frame(width: 10, height: 10))
                .frame(width: 10)
                .accessibilityLabel(Text("Running"))
        }
    }
}
