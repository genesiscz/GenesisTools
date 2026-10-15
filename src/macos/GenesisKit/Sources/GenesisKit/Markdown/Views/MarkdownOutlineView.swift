//
//  MarkdownOutlineView.swift
//  GenesisKit
//
//  Heading outline for the standalone `genesis open` window — the Sections tab
//  of the vault pane, as a sidebar. Clicking a heading scrolls the reading pane;
//  the web renderer's scroll spy pushes back which heading is on screen, so the
//  marker follows the scroll without a click.
//

import SwiftUI

struct MarkdownOutline {
    struct Item: Identifiable, Equatable {
        let level: Int
        let text: String
        let slug: String
        let index: Int
        var id: Int { index }
    }

    /// Headings of a document, in file order. Levels are normalised so a note
    /// that starts at `##` still indents from the left edge.
    static func items(of markdown: String) -> [Item] {
        var raw: [Item] = []
        for (i, block) in MarkdownBlocks.parse(markdown).enumerated() {
            if case .heading(let level, let text, let slug, _) = block {
                raw.append(Item(level: level, text: text, slug: slug, index: i))
            }
        }
        guard let top = raw.map(\.level).min(), top > 1 else { return raw }
        return raw.map { Item(level: $0.level - top + 1, text: $0.text, slug: $0.slug, index: $0.index) }
    }
}

struct MarkdownOutlineView: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    @Namespace private var barNS

    var items: [MarkdownOutline.Item] { MarkdownOutline.items(of: doc.displayText) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                Text("OUTLINE")
                    .font(GenTypography.mono(9, weight: .semibold))
                    .foregroundColor(model.theme.textMuted)
                    .padding(.horizontal, 14)
                    .padding(.top, 10)
                    .padding(.bottom, 6)

                if items.isEmpty {
                    Text("No headings")
                        .font(GenTypography.mono(9.5))
                        .foregroundColor(model.theme.textMuted)
                        .padding(.horizontal, 14)
                } else {
                    ForEach(items) { item in
                        row(item)
                    }
                }
            }
            .padding(.bottom, 10)
            .animation(.easeOut(duration: 0.22), value: model.activeSectionSlug)
        }
        .background(model.theme.chrome)
        .accessibilityIdentifier("markdown-outline")
    }

    private func row(_ item: MarkdownOutline.Item) -> some View {
        let active = model.activeSectionSlug == item.slug
        return Button {
            model.activeSectionSlug = item.slug
            model.scrollTarget = item.text
        } label: {
            HStack(spacing: 0) {
                Text(item.text)
                    .font(GenTypography.mono(item.level <= 2 ? 10.5 : 10,
                                             weight: item.level <= 2 ? .semibold : .regular))
                    .foregroundColor(active ? model.theme.accent : model.theme.textSecondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .padding(.leading, CGFloat(max(0, item.level - 1)) * 12 + 14)
            .padding(.trailing, 10)
            .padding(.vertical, 5)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
            .overlay(alignment: .leading) {
                if active {
                    RoundedRectangle(cornerRadius: 1.5)
                        .fill(model.theme.accent)
                        .frame(width: 3)
                        .padding(.vertical, 2)
                        .matchedGeometryEffect(id: "outlinebar", in: barNS)
                }
            }
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(item.text)
        .accessibilityIdentifier("markdown-outline-\(item.slug)")
    }
}
