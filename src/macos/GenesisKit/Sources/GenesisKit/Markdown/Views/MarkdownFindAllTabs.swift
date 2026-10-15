//
//  MarkdownFindAllTabs.swift
//  GenesisKit
//
//  "Find in all open tabs", the popover under the find panel's stack button:
//  every open tab with a match for the query, with how many and the first
//  matching line. A click selects that tab and runs the find there. The counts
//  come from each tab's text (`MarkdownDocumentsModel.findAllTabsHits`), so a
//  tab that is not on screen counts too. They are worked out when the popover
//  opens and again when the query or an option changes while it is open,
//  never on a timer.
//

import SwiftUI

struct MarkdownFindAllTabs: View {
    @ObservedObject var model: MarkdownDocumentsModel
    var dismiss: () -> Void
    @State private var hits: [MarkdownFindTabHit] = []

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            header
            Rectangle().fill(model.theme.border).frame(height: 1)
            content
        }
        .frame(width: 360)
        .background(model.theme.chrome)
        .onAppear { recount() }
        .onChange(of: model.findQuery) { _, _ in recount() }
        .onChange(of: model.findOptions) { _, _ in recount() }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Find in all open tabs")
        .accessibilityIdentifier("markdown-find-all-tabs-list")
    }

    private var header: some View {
        HStack(spacing: 6) {
            Text("Find in all open tabs")
                .font(.system(size: 12, weight: .semibold))
                .foregroundColor(model.theme.text)
            Spacer(minLength: 8)
            if !hits.isEmpty {
                Text(summary)
                    .font(GenTypography.mono(10))
                    .foregroundColor(model.theme.textMuted)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
    }

    @ViewBuilder
    private var content: some View {
        if model.findQuery.isEmpty {
            note("Type a query in the find field to search every open tab.")
        } else if let error = model.findPatternError {
            note("The query is an \(error).")
        } else if hits.isEmpty {
            note("No open tab has a match for \u{201C}\(model.findQuery)\u{201D}.")
        } else {
            FittedScroll(maxHeight: 360) {
                VStack(spacing: 2) {
                    ForEach(hits) { hit in
                        row(hit)
                    }
                }
                .padding(6)
            }
        }
    }

    private var summary: String {
        let total = hits.reduce(0) { $0 + $1.count }
        let matches = total == 1 ? "1 match" : "\(total) matches"
        let tabs = hits.count == 1 ? "1 tab" : "\(hits.count) tabs"
        return "\(matches) in \(tabs)"
    }

    private func row(_ hit: MarkdownFindTabHit) -> some View {
        Button {
            model.openFindHit(hit)
            dismiss()
        } label: {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(systemName: "doc.text")
                        .font(.system(size: 10))
                        .foregroundColor(model.theme.textMuted)
                    Text(hit.title)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(model.theme.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if hit.isSelected {
                        Text("this tab")
                            .font(.system(size: 10))
                            .foregroundColor(model.theme.textMuted)
                    }
                    Spacer(minLength: 6)
                    Text("\(hit.count)")
                        .font(GenTypography.mono(10))
                        .foregroundColor(model.theme.accent)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(model.theme.accent.opacity(0.14)))
                }
                Text(snippet(hit))
                    .font(GenTypography.mono(10.5))
                    .foregroundColor(model.theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .hoverHighlight(color: model.theme.accent, cornerRadius: 6, fillOpacity: 0.1, borderOpacity: 0)
        .instantTooltip(hit.path)
        .accessibilityLabel("\(hit.title), \(hit.count == 1 ? "1 match" : "\(hit.count) matches"): \(hit.snippet)")
        .accessibilityHint("Shows this tab and its matches")
        .accessibilityIdentifier("markdown-find-all-tabs-row")
    }

    /// The first matching line with the match itself in the accent colour.
    private func snippet(_ hit: MarkdownFindTabHit) -> AttributedString {
        let text = hit.snippet as NSString
        guard hit.snippetMatch.length > 0, NSMaxRange(hit.snippetMatch) <= text.length else {
            return AttributedString(hit.snippet)
        }
        var out = AttributedString(text.substring(to: hit.snippetMatch.location))
        var match = AttributedString(text.substring(with: hit.snippetMatch))
        match.foregroundColor = model.theme.accent
        match.inlinePresentationIntent = .stronglyEmphasized
        out.append(match)
        out.append(AttributedString(text.substring(from: NSMaxRange(hit.snippetMatch))))
        return out
    }

    private func note(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11.5))
            .foregroundColor(model.theme.textSecondary)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func recount() {
        hits = model.findAllTabsHits()
    }
}
