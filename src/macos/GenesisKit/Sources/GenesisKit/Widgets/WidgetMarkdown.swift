import SwiftUI

extension TranscriptMarkdownStyle {
    /// Inbox cards in the widget: the transcript's palette at the widget's 12 pt body, roomier blocks.
    static let widgetCard = TranscriptMarkdownStyle(
        bodySize: 12,
        textColor: .white.opacity(0.92),
        secondaryColor: .white.opacity(0.6),
        mutedColor: .white.opacity(0.4),
        accentColor: SessionPalette.blue,
        codeColor: .white.opacity(0.88),
        codeBackground: .white.opacity(0.06),
        taskDoneColor: SessionPalette.green,
        lineSpacing: 2,
        blockSpacing: 8,
        headingScale: 0.82
    )
}

/// Block Markdown for an inbox card: headings, lists, quotes, code, tables and links, as answers written with
/// `question_answer` use them. The app's own renderer when the host has one (GenesisTools.app), else the
/// kit's block renderer below (the preview app, tests). `Text(.init(…))` drew only inline Markdown, so a
/// heading or a fenced block arrived as raw `#` and backticks.
struct WidgetMarkdown: View {
    let text: String

    var body: some View {
        Group {
            if let rendered = GenesisKit.host?.transcriptMarkdown(text, style: .widgetCard) {
                rendered
            } else {
                KitMarkdownBlocksView(blocks: KitMarkdown.blocks(text))
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .hoverTextSelection()
    }
}

/// A small block parser: enough Markdown to read an agent's answer, not a CommonMark implementation.
enum KitMarkdown {
    enum Block: Equatable {
        case paragraph(String)
        case heading(level: Int, text: String)
        /// `marker` is "•" or the item's number with its dot; `depth` counts indent steps of two spaces.
        case item(marker: String, depth: Int, text: String)
        case quote(String)
        case code(language: String, text: String)
        case table(String)
        case rule
    }

    private final class Parsed: NSObject {
        let blocks: [Block]
        init(_ blocks: [Block]) { self.blocks = blocks }
    }

    nonisolated(unsafe) private static let cache: NSCache<NSString, Parsed> = {
        let cache = NSCache<NSString, Parsed>()
        cache.countLimit = 256
        return cache
    }()

    /// Parsed once per text; a card body re-renders on every snapshot.
    static func blocks(_ text: String) -> [Block] {
        if let hit = cache.object(forKey: text as NSString) { return hit.blocks }
        let parsed = parse(text)
        cache.setObject(Parsed(parsed), forKey: text as NSString)
        return parsed
    }

    static func parse(_ text: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var table: [String] = []
        var code: [String]?
        var fence = ""
        var language = ""

        func flush() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
            if !table.isEmpty {
                blocks.append(.table(table.joined(separator: "\n")))
                table = []
            }
        }

        for raw in text.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            let trimmed = raw.trimmingCharacters(in: .whitespaces)
            if var lines = code {
                if trimmed.hasPrefix(fence) && trimmed.allSatisfy({ $0 == fence.first }) {
                    blocks.append(.code(language: language, text: lines.joined(separator: "\n")))
                    code = nil
                } else {
                    lines.append(raw)
                    code = lines
                }
                continue
            }
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                flush()
                let mark = trimmed.first ?? "`"
                fence = String(trimmed.prefix { $0 == mark })
                language = trimmed.dropFirst(fence.count).trimmingCharacters(in: .whitespaces)
                code = []
                continue
            }
            if trimmed.isEmpty {
                flush()
                continue
            }
            if let heading = heading(trimmed) {
                flush()
                blocks.append(heading)
                continue
            }
            if ["---", "***", "___"].contains(trimmed.replacingOccurrences(of: " ", with: "")) && paragraph.isEmpty {
                flush()
                blocks.append(.rule)
                continue
            }
            if trimmed.hasPrefix(">") {
                if !paragraph.isEmpty || !table.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }
            if trimmed.hasPrefix("|") {
                if !paragraph.isEmpty || !quote.isEmpty { flush() }
                table.append(trimmed)
                continue
            }
            if let item = item(raw) {
                flush()
                blocks.append(item)
                continue
            }
            if !quote.isEmpty || !table.isEmpty { flush() }
            paragraph.append(trimmed)
        }
        if let lines = code {
            blocks.append(.code(language: language, text: lines.joined(separator: "\n")))
        }
        flush()
        return blocks
    }

    private static func heading(_ line: String) -> Block? {
        let hashes = line.prefix { $0 == "#" }.count
        guard (1...6).contains(hashes), line.dropFirst(hashes).first == " " else { return nil }
        return .heading(level: hashes, text: line.dropFirst(hashes + 1).trimmingCharacters(in: .whitespaces))
    }

    private static func item(_ raw: String) -> Block? {
        let indent = raw.prefix { $0 == " " || $0 == "\t" }
        let depth = min(4, indent.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) } / 2)
        let line = raw.dropFirst(indent.count)
        if let first = line.first, "-*+".contains(first), line.dropFirst().first == " " {
            var text = String(line.dropFirst(2))
            var marker = "•"
            if text.hasPrefix("[ ] ") { marker = "☐"; text.removeFirst(4) }
            else if text.lowercased().hasPrefix("[x] ") { marker = "☑"; text.removeFirst(4) }
            return .item(marker: marker, depth: depth, text: text)
        }
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty, digits.count <= 3 else { return nil }
        let rest = line.dropFirst(digits.count)
        guard let dot = rest.first, dot == "." || dot == ")", rest.dropFirst().first == " " else { return nil }
        return .item(marker: digits + ".", depth: depth, text: String(rest.dropFirst(2)))
    }

    static func inline(_ text: String) -> AttributedString {
        do {
            return try AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        } catch {
            return AttributedString(text)
        }
    }
}

struct KitMarkdownBlocksView: View {
    let blocks: [KitMarkdown.Block]

    var body: some View {
        VStack(alignment: .leading, spacing: 7) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                view(block)
            }
        }
    }

    @ViewBuilder private func view(_ block: KitMarkdown.Block) -> some View {
        switch block {
        case .paragraph(let text):
            Text(KitMarkdown.inline(text)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
        case .heading(let level, let text):
            Text(KitMarkdown.inline(text))
                .font(.system(size: level == 1 ? 15 : level == 2 ? 13.5 : 12.5, weight: .semibold))
                .padding(.top, level <= 2 ? 3 : 1)
                .fixedSize(horizontal: false, vertical: true)
        case .item(let marker, let depth, let text):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: marker).font(.system(size: 11, design: .rounded)).monospacedDigit()
                    .foregroundStyle(.secondary).frame(minWidth: 12, alignment: .trailing)
                Text(KitMarkdown.inline(text)).font(.system(size: 12)).fixedSize(horizontal: false, vertical: true)
            }.padding(.leading, CGFloat(depth) * 14)
        case .quote(let text):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1).fill(SessionPalette.blue.opacity(0.6)).frame(width: 2)
                Text(KitMarkdown.inline(text)).font(.system(size: 12)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .code(_, let text), .table(let text):
            Text(verbatim: text).font(.system(size: 11, design: .monospaced)).foregroundStyle(.white.opacity(0.88))
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 9).padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(.white.opacity(0.06), in: RoundedRectangle(cornerRadius: 7))
        case .rule:
            Divider().opacity(0.6)
        }
    }
}
