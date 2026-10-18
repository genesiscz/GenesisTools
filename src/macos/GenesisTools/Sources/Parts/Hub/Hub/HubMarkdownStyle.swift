import SwiftUI

// The hub's panels (the PR description, the review threads, the inbox context) draw markdown with
// GenesisKit's `MarkdownContentView`, the renderer Genesis.app uses too. This is their look. The panel
// find marks its matches inside it through `.findField` (Hub/HubPanelFind.swift).

extension MarkdownStyle {
    /// Light text on the dark panels, compact semibold headings, code that wraps with no language line,
    /// every block selectable, the HTML review bots write cleaned, `[[x]]` left as text.
    package static let hub = MarkdownStyle().with {
        $0.textColor = .white.opacity(0.92)
        $0.secondaryColor = .white.opacity(0.55)
        $0.mutedColor = .white.opacity(0.35)
        $0.accentColor = .orange
        $0.codeColor = .white.opacity(0.88)
        $0.codeBackground = Color.black.opacity(0.35)
        $0.taskDoneColor = .green
        $0.headingSizes = [18.5, 17, 15.5, 14, 12.5, 11]
        $0.headingWeights = Array(repeating: .semibold, count: 6)
        $0.dimsMinorHeadings = false
        $0.codeFontSize = nil
        $0.codeWraps = true
        $0.codeShowsLanguage = false
        $0.codePadding = 8
        $0.codeCornerRadius = 6
        $0.quoteBarColor = .white.opacity(0.35)
        $0.quoteItalic = false
        $0.selection = .all
        $0.wikilinks = false
    }
}
