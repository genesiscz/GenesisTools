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

    /// Appended to a target the pane already has, so a second click on the same row is a new value and the
    /// pane jumps again (the reader may have scrolled away). `slugify` drops it, so it names the same heading.
    static let repeatMark = "\u{2060}"

    /// The scroll target for a click on `item`: its slug, marked when the pane was already sent there.
    static func target(for item: Item, current: String?) -> String {
        current == item.slug ? item.slug + repeatMark : item.slug
    }

    /// Headings of a document, in file order. Levels are normalised so a note
    /// that starts at `##` still indents from the left edge. Slugs are unique
    /// (`examples`, `examples-1`), the ids the page gives its headings.
    static func items(of markdown: String) -> [Item] {
        var raw: [Item] = []
        for (i, block) in MarkdownBlocks.parse(markdown).enumerated() {
            if case .heading(let level, let text, let slug, _) = block {
                raw.append(Item(level: level, text: text, slug: slug, index: i))
            }
        }
        let unique = MarkdownBlocks.uniqueSlugs(raw.map(\.slug))
        raw = zip(raw, unique).map { Item(level: $0.level, text: $0.text, slug: $1, index: $0.index) }
        guard let top = raw.map(\.level).min(), top > 1 else { return raw }
        return raw.map { Item(level: $0.level - top + 1, text: $0.text, slug: $0.slug, index: $0.index) }
    }
}

/// The heading the reading pane shows, apart from the window's model, so a heading change while scrolling redraws the
/// outline and nothing else.
@MainActor
final class MarkdownSectionSpy: ObservableObject {
    /// The heading currently visible in the reading pane.
    @Published var slug: String?
}

/// The outline of the text it last saw. The outline observes the window's model, so its body runs on every publish;
/// the headings are parsed again only when the text changed (a 164 KB note was parsed whole each time).
final class MarkdownOutlineCache {
    private var text: String?
    private var cached: [MarkdownOutline.Item] = []
    /// Number of distinct text versions parsed, exposed to the cache regression test.
    private(set) var parses = 0

    /// Returns cached headings, reparsing only when the note text changes.
    func items(for text: String) -> [MarkdownOutline.Item] {
        if text != self.text {
            cached = MarkdownOutline.items(of: text)
            self.text = text
            parses += 1
        }
        return cached
    }
}

struct MarkdownOutlineView: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    /// The model's heading on screen, observed here and nowhere else in the window.
    @ObservedObject var section: MarkdownSectionSpy
    @Namespace private var barNS
    @GenReduceMotion private var reduceMotion
    @State private var outline = MarkdownOutlineCache()

    init(doc: MarkdownDocument, model: MarkdownDocumentsModel) {
        _doc = ObservedObject(wrappedValue: doc)
        _model = ObservedObject(wrappedValue: model)
        _section = ObservedObject(wrappedValue: model.section)
    }

    var items: [MarkdownOutline.Item] { outline.items(for: doc.displayText) }

    var body: some View {
        let _ = RenderProbe.hit("md.outline")
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
                        .font(GenTypography.mono(11))
                        .foregroundColor(model.theme.textMuted)
                        .padding(.horizontal, 14)
                } else {
                    ForEach(items) { item in
                        row(item)
                    }
                }
            }
            .padding(.bottom, 10)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: section.slug)
        }
        .background(model.theme.chrome)
        .accessibilityIdentifier("markdown-outline")
    }

    private func row(_ item: MarkdownOutline.Item) -> some View {
        let active = section.slug == item.slug
        return Button {
            model.activeSectionSlug = item.slug
            model.scrollTarget = MarkdownOutline.target(for: item, current: model.scrollTarget)
        } label: {
            HStack(spacing: 0) {
                Text(item.text)
                    .font(GenTypography.mono(11,
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
        .accessibilityAddTraits(active ? .isSelected : [])
        .accessibilityIdentifier("markdown-outline-\(item.slug)")
    }
}
