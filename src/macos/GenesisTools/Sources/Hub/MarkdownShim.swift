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
    /// Each text block selectable. Off in the transcript: its rows turn selection on while the pointer is
    /// over them (GenesisKit `hoverTextSelection`), and a selectable block here is a selection overlay
    /// view, a focus ring and a key-view entry per paragraph on every row whether or not it is pointed at.
    var selectable: Bool = true
}

extension MarkdownStyle {
    /// GenesisKit's transcript style (`TranscriptMarkdownStyle.sessionTranscript`) in this renderer's terms.
    init(_ style: TranscriptMarkdownStyle) {
        self.init(
            bodySize: style.bodySize,
            textColor: style.textColor,
            secondaryColor: style.secondaryColor,
            mutedColor: style.mutedColor,
            accentColor: style.accentColor,
            codeColor: style.codeColor,
            codeBackground: style.codeBackground,
            taskDoneColor: style.taskDoneColor,
            lineSpacing: style.lineSpacing,
            blockSpacing: style.blockSpacing,
            headingScale: style.headingScale,
            selectable: ProcessInfo.processInfo.environment["GENESIS_SHIM_SELECT"] == "1"
        )
    }
}

private extension View {
    @ViewBuilder
    func selectable(_ on: Bool) -> some View {
        if on {
            textSelection(.enabled)
        } else {
            self
        }
    }
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

    /// Parsed once per text. A transcript row's body runs again every time the list re-measures its
    /// visible rows (each document resize of a live session), and parsing in the body was in 73 of the
    /// 179 transcript stall stacks of 2026-09-29/30 (`inline`) and 34 (`blocks`).
    private final class Parsed<Value>: NSObject {
        let value: Value
        init(_ value: Value) { self.value = value }
    }

    nonisolated(unsafe) private static let blockCache: NSCache<NSString, Parsed<[Block]>> = {
        let cache = NSCache<NSString, Parsed<[Block]>>()
        cache.countLimit = 2000
        return cache
    }()

    nonisolated(unsafe) private static let inlineCache: NSCache<NSString, Parsed<AttributedString>> = {
        let cache = NSCache<NSString, Parsed<AttributedString>>()
        cache.countLimit = 4000
        return cache
    }()

    nonisolated private static func blocks(_ markdown: String) -> [Block] {
        let key = markdown as NSString
        if let hit = blockCache.object(forKey: key) {
            return hit.value
        }

        let parsed = parseBlocks(markdown)
        blockCache.setObject(Parsed(parsed), forKey: key)
        return parsed
    }

    nonisolated private static func parseBlocks(_ markdown: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var quote: [String] = []
        var table: [String] = []
        var code: [String]?
        // The open fence's character and length: only the same character, at least as many, closes it.
        var fence: (mark: Character, count: Int)?
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
            let marker = fenceMarker(raw)
            if let open = fence {
                // ```swift inside a block, or a shorter fence inside a longer one, is code, not the end.
                if let marker, marker.mark == open.mark, marker.count >= open.count, marker.info.isEmpty {
                    blocks.append(.code((code ?? []).joined(separator: "\n")))
                    code = nil
                    fence = nil
                } else {
                    code?.append(raw)
                }
                continue
            }
            if let marker {
                flush()
                code = []
                fence = (marker.mark, marker.count)
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
    /// A fence line: three or more backticks or tildes, and what follows them (the info string), trimmed.
    nonisolated static func fenceMarker(_ line: String) -> (mark: Character, count: Int, info: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let mark = trimmed.first, mark == "`" || mark == "~" else { return nil }
        let count = trimmed.prefix { $0 == mark }.count
        guard count >= 3 else { return nil }
        return (mark, count, trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces))
    }

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
                        .selectable(style.selectable)
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
                            .selectable(style.selectable)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                    .panelFindAnchor(anchor(block: index))
                case .code(let text), .table(let text):
                    Text(found(AttributedString(text), block: index))
                        .font(.system(size: style.bodySize - 1.5, design: .monospaced))
                        .foregroundColor(style.codeColor)
                        .selectable(style.selectable)
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
        let key = text as NSString
        if let hit = inlineCache.object(forKey: key) {
            return hit.value
        }

        let options = AttributedString.MarkdownParsingOptions(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        let parsed = (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
        inlineCache.setObject(Parsed(parsed), forKey: key)
        return parsed
    }
}
