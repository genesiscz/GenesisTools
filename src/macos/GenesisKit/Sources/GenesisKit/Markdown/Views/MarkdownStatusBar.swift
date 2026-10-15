//
//  MarkdownStatusBar.swift
//  GenesisKit
//
//  The footer of the standalone markdown window: how long the note is, how long
//  it takes to read, and when it last changed on disk. The window watches the
//  file, so the timestamp doubles as the proof that a re-run of a report landed:
//  it reads "saved 12s ago" and stays current on its own (`LiveTime`, which wakes
//  only when the text changes), with the exact time in its tooltip.
//

import SwiftUI

struct MarkdownStats: Equatable {
    var words: Int
    var characters: Int
    var readingMinutes: Int

    /// Average adult reading speed, rounded up: a one-word note still reads as
    /// "1 min" rather than "0 min".
    static let wordsPerMinute = 200

    static func of(_ text: String) -> MarkdownStats {
        let words = text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
        let minutes = words == 0 ? 0 : max(1, Int((Double(words) / Double(wordsPerMinute)).rounded(.up)))
        return MarkdownStats(words: words, characters: text.count, readingMinutes: minutes)
    }

    var summary: String {
        if words == 0 { return "empty" }
        return "\(words) words · \(readingMinutes) min read"
    }
}

struct MarkdownStatusBar: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel

    var body: some View {
        let stats = doc.stats
        HStack(spacing: 10) {
            Text(stats.summary)
                .accessibilityIdentifier("markdown-stats")

            if doc.hasDiskChange {
                dot
                Text("changed on disk")
                    .foregroundColor(.genWarning)
                    .accessibilityIdentifier("markdown-disk-change")
            } else if doc.isDirty {
                dot
                Text("unsaved")
                    .foregroundColor(model.theme.accent)
                    .accessibilityIdentifier("markdown-unsaved")
            }

            dot
            Text(byteText)

            if let modified = doc.modifiedAt {
                dot
                LiveTime(date: modified, style: .ago) { "saved \($0)" }
                    .instantTooltip("Saved \(Self.stamp.string(from: modified))")
                    .accessibilityIdentifier("markdown-modified")
            }

            Spacer(minLength: 8)

            if model.docs.count > 1 {
                Text("\(model.docs.count) tabs")
                dot
            }

            Button {
                model.cycleTheme()
            } label: {
                HStack(spacing: 4) {
                    Image(systemName: model.theme.icon)
                        .font(.system(size: 8, weight: .semibold))
                    Text(model.theme.label)
                }
                .foregroundColor(model.theme.textSecondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Theme: \(model.theme.label) — click for \(model.theme.next.label)")
            .hoverHighlight(color: model.theme.accent, cornerRadius: 5, fillOpacity: 0.12)
            .accessibilityIdentifier("markdown-theme-toggle")
        }
        .font(GenTypography.mono(9.5))
        // Secondary, not muted: every word here is information (Martin, 2026-10-13: the bar read too gray).
        .foregroundColor(model.theme.textSecondary)
        .lineLimit(1)
        .padding(.horizontal, 12)
        .padding(.vertical, 5)
        .background(model.theme.chrome)
        .overlay(alignment: .top) {
            Rectangle().fill(model.theme.border).frame(height: 1)
        }
    }

    private var dot: some View {
        Text("·").foregroundColor(model.theme.textMuted.opacity(0.6))
    }

    var byteText: String {
        ByteFormat.file(Int64(doc.byteSize))
    }

    private static let stamp: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "d.M.yyyy HH:mm:ss"
        return f
    }()
}
