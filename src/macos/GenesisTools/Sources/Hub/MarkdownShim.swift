import SwiftUI

// A small stand-in for Genesis's MarkdownContentView (UI/MarkdownContentView.swift + the
// Knowledge/MarkdownPreview.swift block parser), which pulls in the companion theme, wikilinks and
// a web view. Same API as the stolen transcript list uses: `MarkdownContentView(markdown:style:)`
// with a `MarkdownStyle`. It renders inline markdown per paragraph, fenced code, headings, quotes,
// tables (monospaced), rules and list bullets, and turns the HTML that GitHub and review bots write
// (`<details><summary>`, `<!-- -->`, `<br>`) into markdown instead of printing the tags.

struct MarkdownStyle {
    var bodySize: CGFloat = 13
    var textColor: Color = .white.opacity(0.92)
    var secondaryColor: Color = .white.opacity(0.55)
    var mutedColor: Color = .white.opacity(0.35)
    var accentColor: Color = .orange
    var codeColor: Color = .white.opacity(0.88)
    var codeBackground: Color = Color.black.opacity(0.35)
    var taskDoneColor: Color = .green
    var lineSpacing: CGFloat = 3
    var blockSpacing: CGFloat = 10
    var headingScale: CGFloat = 1
    var monoBody: Bool = false
}

struct MarkdownContentView: View {
    let markdown: String
    var style = MarkdownStyle()
    // Inside a panel find row (Hub/HubPanelFind.swift) the matches are marked, block by block.
    @Environment(\.panelFindHighlight) private var findHighlight
    @Environment(\.panelFindRow) private var findRow
    @Environment(\.panelFindField) private var findField

    private enum Block: Hashable {
        case text(String)
        case code(String)
        case heading(String, level: Int)
        case quote(String)
        case table(String)
        case rule
    }

    nonisolated private static func blocks(_ markdown: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var table: [String] = []
        var code: [String]?
        var inComment = false

        func flushQuote() {
            if !quote.isEmpty {
                blocks.append(.quote(quote.joined(separator: "\n")))
                quote = []
            }
        }
        func flushTable() {
            if !table.isEmpty {
                blocks.append(.table(table.joined(separator: "\n")))
                table = []
            }
        }
        func flush() {
            let text = paragraph.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                blocks.append(.text(text))
            }
            paragraph = []
            flushQuote()
            flushTable()
        }

        for raw in markdown.components(separatedBy: "\n") {
            if raw.trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                if let open = code {
                    blocks.append(.code(open.joined(separator: "\n")))
                    code = nil
                } else {
                    flush()
                    code = []
                }
                continue
            }

            if code != nil {
                code?.append(raw)
                continue
            }

            // HTML comments (bots hide state in them) can span lines.
            var line = raw
            if inComment {
                guard let end = line.range(of: "-->") else { continue }
                line = String(line[end.upperBound...])
                inComment = false
            }
            line = line.replacingOccurrences(of: "<!--.*?-->", with: "", options: .regularExpression)
            if let open = line.range(of: "<!--") {
                line = String(line[..<open.lowerBound])
                inComment = true
            }
            line = cleanHTML(line)

            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty {
                // A line that held only tags (`<details>`) is not a paragraph break in the source.
                if raw.trimmingCharacters(in: .whitespaces).isEmpty {
                    flush()
                }
                continue
            }

            if let match = line.range(of: "^#{1,6} ", options: .regularExpression) {
                flush()
                blocks.append(.heading(String(line[match.upperBound...]), level: line.distance(from: line.startIndex, to: match.upperBound) - 1))
            } else if trimmed.range(of: "^(-{3,}|\\*{3,}|_{3,})$", options: .regularExpression) != nil {
                flush()
                blocks.append(.rule)
            } else if trimmed.hasPrefix(">") {
                if quote.isEmpty { flush() }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else if trimmed.hasPrefix("|") {
                if table.isEmpty { flush() }
                // The `|---|:--:|` row only tells the alignment.
                if trimmed.range(of: "^\\|?[\\s:|-]+$", options: .regularExpression) == nil {
                    table.append(trimmed)
                }
            } else {
                flushQuote()
                flushTable()
                paragraph.append(listLine(line))
            }
        }

        if let open = code {
            blocks.append(.code(open.joined(separator: "\n")))
        }
        flush()
        return blocks
    }

    /// The known tags become markdown or go; their text stays. Unknown tags are left alone, so a generic
    /// type written in prose (`Array<Int>`) is not eaten.
    nonisolated static func cleanHTML(_ line: String) -> String {
        guard line.contains("<") else { return line }
        let rules: [(String, String)] = [
            ("(?i)<br\\s*/?>", " "),
            ("(?i)<summary>(.*?)</summary>", "▸ **$1**"),
            ("(?i)</?summary>", ""),
            ("(?i)<(b|strong)>(.*?)</(b|strong)>", "**$2**"),
            ("(?i)<(i|em)>(.*?)</(i|em)>", "*$2*"),
            ("(?i)<code>(.*?)</code>", "`$1`"),
            ("(?i)<a\\s[^>]*href=\"([^\"]+)\"[^>]*>(.*?)</a>", "[$2]($1)"),
            ("(?i)</?(details|p|div|span|sub|sup|picture|source|img|kbd|b|strong|i|em|a|code|table|thead|tbody|tr|td|th|blockquote|ul|ol|li|h[1-6])\\b[^>]*>", ""),
            // A badge link whose image was just removed.
            ("\\[\\]\\([^)]*\\)", ""),
        ]
        var text = line
        for (pattern, template) in rules {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return text
    }

    /// `- x`, `* x`, `+ x` as a bullet, `- [ ] x` / `- [x] x` as a box; the indentation stays.
    nonisolated static func listLine(_ line: String) -> String {
        guard let match = line.range(of: "^[ \\t]*[-*+] ", options: .regularExpression) else { return line }
        let indent = line[line.startIndex..<match.upperBound].prefix { $0 == " " || $0 == "\t" }
        var rest = String(line[match.upperBound...])
        var marker = "•"
        if rest.hasPrefix("[ ] ") {
            marker = "☐"
            rest.removeFirst(4)
        } else if rest.lowercased().hasPrefix("[x] ") {
            marker = "☑"
            rest.removeFirst(4)
        }
        return "\(indent)\(marker) \(rest)"
    }

    /// The text each block shows, in order: what a panel find matches (a match names its block).
    nonisolated static func searchBlocks(_ markdown: String) -> [String] {
        blocks(markdown).map { block in
            switch block {
            case .text(let text), .heading(let text, _), .quote(let text): return String(inline(text).characters)
            case .code(let text), .table(let text): return text
            case .rule: return ""
            }
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: style.blockSpacing) {
            ForEach(Array(Self.blocks(markdown).enumerated()), id: \.offset) { index, block in
                switch block {
                case .text(let text):
                    Text(found(Self.inline(text), block: index))
                        .font(style.monoBody ? .system(size: style.bodySize, design: .monospaced) : .system(size: style.bodySize))
                        .foregroundColor(style.textColor)
                        .lineSpacing(style.lineSpacing)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .panelFindAnchor(anchor(block: index))
                case .heading(let text, let level):
                    Text(found(Self.inline(text), block: index))
                        .font(.system(size: (20 - CGFloat(level) * 1.5) * style.headingScale, weight: .semibold))
                        .foregroundColor(style.textColor)
                        .panelFindAnchor(anchor(block: index))
                case .quote(let text):
                    HStack(alignment: .top, spacing: 8) {
                        RoundedRectangle(cornerRadius: 1).fill(style.mutedColor).frame(width: 2)
                        Text(found(Self.inline(text), block: index))
                            .font(.system(size: style.bodySize))
                            .foregroundColor(style.secondaryColor)
                            .lineSpacing(style.lineSpacing)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .panelFindAnchor(anchor(block: index))
                case .code(let text), .table(let text):
                    Text(found(AttributedString(text), block: index))
                        .font(.system(size: style.bodySize - 1.5, design: .monospaced))
                        .foregroundColor(style.codeColor)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 6).fill(style.codeBackground))
                        .panelFindAnchor(anchor(block: index))
                case .rule:
                    Rectangle().fill(style.mutedColor.opacity(0.5)).frame(height: 1)
                }
            }
        }
    }

    private func found(_ text: AttributedString, block: Int) -> AttributedString {
        guard let findHighlight else { return text }
        var marked = text
        findHighlight.mark(&marked, row: findRow, field: findField, block: block)
        return marked
    }

    private func anchor(block: Int) -> String? {
        guard findHighlight != nil, let findRow, let findField else { return nil }
        return PanelFind.anchorID(row: findRow, field: findField, block: block)
    }

    nonisolated private static func inline(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }
}
