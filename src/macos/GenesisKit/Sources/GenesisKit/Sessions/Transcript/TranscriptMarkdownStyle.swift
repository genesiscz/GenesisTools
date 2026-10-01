import SwiftUI

/// How a host draws the transcript's markdown (replies, prompt parts). Both apps render markdown their
/// own way (Genesis: its native engine with mermaid and highlighting; GenesisTools: a lighter
/// AttributedString renderer), so the transcript passes the text and this style to
/// `GenesisKitHost.transcriptMarkdown`, which maps it onto the app's own style.
public struct TranscriptMarkdownStyle: Sendable {
    public var bodySize: CGFloat
    public var textColor: Color
    public var secondaryColor: Color
    public var mutedColor: Color
    /// Bullets, ordered markers, quote bar.
    public var accentColor: Color
    public var codeColor: Color
    public var codeBackground: Color
    public var taskDoneColor: Color
    public var lineSpacing: CGFloat
    public var blockSpacing: CGFloat
    /// Multiplies heading sizes.
    public var headingScale: CGFloat

    /// The transcript's look: the session palette, compact headings.
    public static let sessionTranscript = TranscriptMarkdownStyle(
        bodySize: 13,
        textColor: SessionPalette.text,
        secondaryColor: SessionPalette.secondary,
        mutedColor: SessionPalette.dim,
        accentColor: SessionPalette.blue,
        codeColor: Color.white.opacity(0.88),
        codeBackground: Color.white.opacity(0.06),
        taskDoneColor: SessionPalette.green,
        lineSpacing: 3,
        blockSpacing: 8,
        headingScale: 0.86
    )
}
