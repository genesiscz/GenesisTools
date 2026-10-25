import SwiftUI

/// Block-level markdown model for the Knowledge reading view (Spec 06 G10 /
/// live bug: notes rendered as raw markdown text). Pure + testable.
public enum MarkdownBlocks {
    /// GFM column alignment from the `|:---:|` separator row.
    public enum ColumnAlign: Equatable, Sendable {
        case leading, center, trailing
    }

    public enum Block: Equatable, Identifiable, Sendable {
        case heading(level: Int, text: String, slug: String, index: Int)
        case paragraph(text: String, index: Int)
        case code(language: String?, code: String, index: Int)
        case quote(text: String, index: Int)
        case listItem(indent: Int, ordered: Bool, marker: String, text: String, task: Bool?, index: Int)
        case rule(index: Int)
        case frontmatter(keys: [String], index: Int)
        case table(header: [String], aligns: [ColumnAlign], rows: [[String]], index: Int)

        public var id: String {
            switch self {
            case .heading(_, _, let slug, let i): return "h-\(i)-\(slug)"
            case .paragraph(_, let i): return "p-\(i)"
            case .code(_, _, let i): return "c-\(i)"
            case .quote(_, let i): return "q-\(i)"
            case .listItem(_, _, _, _, _, let i): return "li-\(i)"
            case .rule(let i): return "hr-\(i)"
            case .frontmatter(_, let i): return "fm-\(i)"
            case .table(_, _, _, let i): return "tbl-\(i)"
            }
        }
    }

    /// Heading ids the way the web page writes them: the second "Examples" is `examples-1`, the third
    /// `examples-2`, and a suffix already taken moves on. The outline and both renderers use it, so a row
    /// scrolls to the heading it names and only that row shows as current.
    public static func uniqueSlugs(_ slugs: [String]) -> [String] {
        var used = Set<String>()
        return slugs.map { slug in
            var candidate = slug
            var n = 0
            while used.contains(candidate) {
                n += 1
                candidate = "\(slug)-\(n)"
            }
            used.insert(candidate)
            return candidate
        }
    }

    public static func slugify(_ heading: String) -> String {
        heading.lowercased()
            .replacingOccurrences(of: #"[^a-z0-9\s-]"#, with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: #"\s+"#, with: "-", options: .regularExpression)
    }

    // Small LRU memo. parse() is called from SwiftUI view bodies (main thread),
    // which re-run on every unrelated state change — e.g. the search-blink
    // animation toggles `flashOn` ~4× and would otherwise re-parse the whole
    // note each toggle. Pure function, so caching by exact source is safe.
    private static let memoLock = NSLock()
    private static var memo: [(src: String, blocks: [Block])] = []
    private static let memoCapacity = 12

    public static func parse(_ markdown: String) -> [Block] {
        memoLock.lock()
        if let hit = memo.first(where: { $0.src == markdown }) {
            memoLock.unlock()
            return hit.blocks
        }
        memoLock.unlock()
        // A miss while a reply streams re-parses the whole growing text, in a body.
        let result = PerfLog.span("markdown.parse", over: PerfLog.frameMs) { parseUncached(markdown) }
        memoLock.lock()
        memo.removeAll { $0.src == markdown }
        memo.append((markdown, result))
        if memo.count > memoCapacity { memo.removeFirst(memo.count - memoCapacity) }
        memoLock.unlock()
        return result
    }

    public static func parseUncached(_ markdown: String) -> [Block] {
        var blocks: [Block] = []
        // Split on any newline sequence so CRLF vault notes (Windows / cross-platform)
        // do not leave trailing `\r` on every line and break frontmatter/heading parse.
        var lines = markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: .newlines)
        var idx = 0
        var blockIndex = 0

        // Frontmatter
        if lines.first?.trimmingCharacters(in: .whitespaces) == "---" {
            var end = -1
            for i in 1..<lines.count where lines[i].trimmingCharacters(in: .whitespaces) == "---" {
                end = i
                break
            }
            if end > 0 {
                let keys = lines[1..<end].compactMap { line -> String? in
                    let t = line.trimmingCharacters(in: .whitespaces)
                    guard !t.hasPrefix("-"), let colon = t.firstIndex(of: ":") else { return nil }
                    let k = String(t[..<colon]).trimmingCharacters(in: .whitespaces)
                    return k.isEmpty ? nil : k
                }
                blocks.append(.frontmatter(keys: keys, index: blockIndex))
                blockIndex += 1
                lines.removeSubrange(0...end)
            }
        }

        var paragraphBuffer: [String] = []
        func flushParagraph() {
            let text = paragraphBuffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            paragraphBuffer = []
            guard !text.isEmpty else { return }
            blocks.append(.paragraph(text: text, index: blockIndex))
            blockIndex += 1
        }

        while idx < lines.count {
            let line = lines[idx]
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Only a fence of the opener's character, at least as long and with nothing after it,
            // closes the block: ```swift inside a ```` block, or ``` inside ~~~, is code.
            if let open = fenceMarker(line) {
                flushParagraph()
                var code: [String] = []
                idx += 1
                while idx < lines.count {
                    if let close = fenceMarker(lines[idx]), close.mark == open.mark, close.count >= open.count, close.info.isEmpty {
                        break
                    }
                    code.append(lines[idx])
                    idx += 1
                }
                idx += 1 // closing fence
                blocks.append(.code(language: open.info.isEmpty ? nil : open.info, code: code.joined(separator: "\n"), index: blockIndex))
                blockIndex += 1
                continue
            }

            if trimmed.hasPrefix("#"), let space = trimmed.firstIndex(of: " ") {
                let hashes = trimmed[..<space]
                if hashes.allSatisfy({ $0 == "#" }), hashes.count <= 6 {
                    flushParagraph()
                    let text = String(trimmed[trimmed.index(after: space)...]).trimmingCharacters(in: .whitespaces)
                    blocks.append(.heading(level: hashes.count, text: text, slug: slugify(text), index: blockIndex))
                    blockIndex += 1
                    idx += 1
                    continue
                }
            }

            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushParagraph()
                blocks.append(.rule(index: blockIndex))
                blockIndex += 1
                idx += 1
                continue
            }

            if trimmed.hasPrefix(">") {
                flushParagraph()
                var quote: [String] = []
                while idx < lines.count {
                    let t = lines[idx].trimmingCharacters(in: .whitespaces)
                    guard t.hasPrefix(">") else { break }
                    quote.append(String(t.dropFirst(1)).trimmingCharacters(in: .whitespaces))
                    idx += 1
                }
                blocks.append(.quote(text: quote.joined(separator: "\n"), index: blockIndex))
                blockIndex += 1
                continue
            }

            // GFM table: a header row containing `|` immediately followed by a
            // separator row like `|---|:--:|`. Body rows run until a blank/non-pipe line.
            if trimmed.contains("|"), idx + 1 < lines.count, isTableSeparator(lines[idx + 1]) {
                flushParagraph()
                let header = splitTableCells(line)
                let aligns = parseAlignments(lines[idx + 1])
                idx += 2
                var rows: [[String]] = []
                while idx < lines.count {
                    let t = lines[idx].trimmingCharacters(in: .whitespaces)
                    guard !t.isEmpty, t.contains("|") else { break }
                    rows.append(splitTableCells(lines[idx]))
                    idx += 1
                }
                blocks.append(.table(header: header, aligns: aligns, rows: rows, index: blockIndex))
                blockIndex += 1
                continue
            }

            // List items (unordered -, *, + / ordered 1. / task - [ ])
            if let item = parseListItem(line) {
                flushParagraph()
                blocks.append(.listItem(
                    indent: item.indent, ordered: item.ordered, marker: item.marker,
                    text: item.text, task: item.task, index: blockIndex
                ))
                blockIndex += 1
                idx += 1
                continue
            }

            if trimmed.isEmpty {
                flushParagraph()
                idx += 1
                continue
            }

            paragraphBuffer.append(line)
            idx += 1
        }
        flushParagraph()
        return blocks
    }

    private static func parseListItem(_ line: String) -> (indent: Int, ordered: Bool, marker: String, text: String, task: Bool?)? {
        let indent = line.prefix(while: { $0 == " " || $0 == "\t" }).reduce(0) { $0 + ($1 == "\t" ? 4 : 1) }
        let t = line.trimmingCharacters(in: .whitespaces)
        for bullet in ["- ", "* ", "+ "] where t.hasPrefix(bullet) {
            var text = String(t.dropFirst(2))
            var task: Bool?
            if text.hasPrefix("[ ] ") { task = false; text = String(text.dropFirst(4)) }
            else if text.lowercased().hasPrefix("[x] ") { task = true; text = String(text.dropFirst(4)) }
            return (indent / 2, false, "•", text, task)
        }
        if let m = t.range(of: #"^\d{1,3}\. "#, options: .regularExpression) {
            let marker = String(t[m]).trimmingCharacters(in: .whitespaces)
            return (indent / 2, true, marker, String(t[m.upperBound...]), nil)
        }
        return nil
    }

    // MARK: - GFM tables

    /// A delimiter row: only `-`, `:`, `|`, and whitespace, with at least one
    /// pipe and one dash. Requiring a pipe keeps a bare `---` an <hr>, not a table.
    static func isTableSeparator(_ line: String) -> Bool {
        let t = line.trimmingCharacters(in: .whitespaces)
        guard t.contains("|"), t.contains("-") else { return false }
        return t.allSatisfy { "-:| \t".contains($0) }
    }

    /// Split a `| a | b |` row into trimmed cells, honoring `\|` escapes and
    /// dropping the empty cells produced by optional leading/trailing pipes.
    static func splitTableCells(_ line: String) -> [String] {
        var cells: [String] = []
        var cur = ""
        var escaped = false
        for ch in line.trimmingCharacters(in: .whitespaces) {
            if escaped {
                cur.append(ch)
                escaped = false
            } else if ch == "\\" {
                cur.append(ch)
                escaped = true
            } else if ch == "|" {
                cells.append(cur.trimmingCharacters(in: .whitespaces))
                cur = ""
            } else {
                cur.append(ch)
            }
        }
        cells.append(cur.trimmingCharacters(in: .whitespaces))
        if cells.first == "" { cells.removeFirst() }
        if cells.last == "" { cells.removeLast() }
        return cells
    }

    /// Per-column alignment from the delimiter row (`:---` leading, `:--:` center, `--:` trailing).
    static func parseAlignments(_ separatorLine: String) -> [ColumnAlign] {
        splitTableCells(separatorLine).map { raw in
            let c = raw.trimmingCharacters(in: .whitespaces)
            let left = c.hasPrefix(":")
            let right = c.hasSuffix(":")
            if left && right { return .center }
            if right { return .trailing }
            return .leading
        }
    }

    // MARK: - Fences and the HTML bots write

    /// A fence line: three or more backticks or tildes, and what follows them (the info string), trimmed.
    public static func fenceMarker(_ line: String) -> (mark: Character, count: Int, info: String)? {
        let trimmed = line.trimmingCharacters(in: .whitespaces)
        guard let mark = trimmed.first, mark == "`" || mark == "~" else { return nil }
        let count = trimmed.prefix { $0 == mark }.count
        guard count >= 3 else { return nil }
        return (mark, count, trimmed.dropFirst(count).trimmingCharacters(in: .whitespaces))
    }

    /// One line's known tags as markdown, or gone with their text kept. Unknown tags stay, so a
    /// generic type written in prose (`Array<Int>`) is not eaten.
    public static func cleanHTML(_ line: String) -> String {
        guard line.contains("<") else { return line }
        var text = line
        for (pattern, template) in htmlRules {
            text = text.replacingOccurrences(of: pattern, with: template, options: .regularExpression)
        }
        return text
    }

    private static let htmlRules: [(String, String)] = [
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

    /// The HTML GitHub and review bots write, as markdown: comments go (they span lines and hide bot
    /// state), `<details>`, `<summary>`, `<br>`, `<b>`, `<code>` and `<a>` become their markdown, and
    /// the other known tags go with their text kept. A line that held only tags is dropped, not left
    /// blank, so `<details>` between two lines does not split their paragraph. Fenced code is untouched.
    public static func strippingHTML(_ markdown: String) -> String {
        guard markdown.contains("<") else { return markdown }
        var out: [String] = []
        var fence: (mark: Character, count: Int)?
        var inComment = false
        for raw in markdown.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n") {
            if let open = fence {
                if let close = fenceMarker(raw), close.mark == open.mark, close.count >= open.count, close.info.isEmpty {
                    fence = nil
                }
                out.append(raw)
                continue
            }
            if !inComment, let open = fenceMarker(raw) {
                fence = (open.mark, open.count)
                out.append(raw)
                continue
            }
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
            if line.trimmingCharacters(in: .whitespaces).isEmpty, !raw.trimmingCharacters(in: .whitespaces).isEmpty {
                continue
            }
            out.append(line)
        }
        return out.joined(separator: "\n")
    }

    /// Convert Obsidian wikilinks to custom-scheme markdown links so the
    /// inline AttributedString parser renders them as tappable links.
    /// `[[Note#Heading|alias]]` → `[alias](genesiswiki:Note%23Heading)`
    static func wikilinksToMarkdownLinks(_ text: String) -> String {
        guard text.contains("[[") else { return text }
        var out = text
        for link in WikilinkParser.parse(text).reversed() {
            let label = link.alias ?? (link.heading.map { "\(link.target) › \($0)" } ?? link.target)
            var ref = link.target
            if let h = link.heading { ref += "#\(h)" }
            if let b = link.block { ref += "#^\(b)" }
            let encoded = ref.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? ref
            let replacement = "[\(label)](genesiswiki:\(encoded))"
            if let range = Range(link.range, in: out) {
                out.replaceSubrange(range, with: replacement)
            }
        }
        return out
    }
}

/// Rich reading view for markdown notes (Obsidian-style preview).
public struct MarkdownPreviewView: View {
    var markdown: String
    /// Heading slug or `^block` id to scroll to after render.
    var scrollTarget: String?
    var onWikilink: (String) -> Void
    /// Search: the query to jump-to + blink-highlight in the document.
    var highlightQuery: String?
    /// Bumped each time a search result is clicked, so the jump re-fires even
    /// for a repeated query or the same file.
    var highlightToken: Int = 0
    /// Engine 3: render code/mermaid natively-rich (hljs + BeautifulMermaid)
    /// instead of the flat MarkdownBlockView code renderer.
    var rich: Bool = false
    /// The window's text size, 1 = the style's own sizes (⌘+ and ⌘- reach the native panes too).
    var zoom: Double = 1
    /// The window's palette; nil = the vault look.
    var theme: MarkdownTheme? = nil

    /// The markdown window's pane: its text size and its palette.
    init(
        markdown: String,
        scrollTarget: String?,
        onWikilink: @escaping (String) -> Void,
        highlightQuery: String?,
        highlightToken: Int = 0,
        rich: Bool = false,
        zoom: Double,
        theme: MarkdownTheme?
    ) {
        self.init(markdown: markdown, scrollTarget: scrollTarget, onWikilink: onWikilink, highlightQuery: highlightQuery,
                  highlightToken: highlightToken, rich: rich)
        self.zoom = zoom
        self.theme = theme
    }

    public init(
        markdown: String,
        scrollTarget: String?,
        onWikilink: @escaping (String) -> Void,
        highlightQuery: String?,
        highlightToken: Int = 0,
        rich: Bool = false
    ) {
        self.markdown = markdown
        self.scrollTarget = scrollTarget
        self.onWikilink = onWikilink
        self.highlightQuery = highlightQuery
        self.highlightToken = highlightToken
        self.rich = rich
    }

    /// The code block bar setting reaches the native panes too: a Copy button on every fenced block.
    @ObservedObject private var config = GenesisKitMarkdownConfiguration.shared
    @State private var flashBlockId: String?
    @State private var flashOn = false
    @GenReduceMotion private var reduceMotion
    @State private var lastHandledToken = -1

    public var body: some View {
        let blocks = MarkdownBlocks.parse(markdown)
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if blocks.isEmpty {
                        Text("This note is empty.")
                            .font(.system(size: 13 * CGFloat(zoom)).italic())
                            .foregroundColor(blockStyle.mutedColor)
                    }
                    ForEach(blocks) { block in
                        Group {
                            if rich {
                                RichBlockView(block: block, style: blockStyle)
                            } else {
                                MarkdownBlockView(block: block, style: blockStyle)
                            }
                        }
                            .id(block.id)
                            .background(
                                RoundedRectangle(cornerRadius: 6)
                                    .fill(Color.searchHighlight.opacity(
                                        flashOn && flashBlockId == block.id ? 0.22 : 0))
                            )
                    }
                }
                .padding(20)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .onAppear { scrollIfNeeded(proxy: proxy, blocks: blocks) }
            .onChange(of: scrollTarget) { _, _ in scrollIfNeeded(proxy: proxy, blocks: blocks) }
            .onChange(of: highlightToken) { _, _ in tryHighlightJump(proxy: proxy, blocks: blocks) }
            .onChange(of: markdown) { _, _ in tryHighlightJump(proxy: proxy, blocks: blocks) }
        }
        .background(theme?.nativePage ?? Color.vaultReadingBg)
        .environment(\.openURL, linkAction)
        .axMarker("knowledge-preview")
    }

    var linkAction: OpenURLAction {
        OpenURLAction { url in
            if url.scheme == "genesiswiki" {
                let raw = url.absoluteString.replacingOccurrences(of: "genesiswiki:", with: "")
                onWikilink(raw.removingPercentEncoding ?? raw)
                return .handled
            }
            // The note is untrusted: the system gets only the web view's allowed
            // schemes, and a `file:` link goes to the caller's link handler,
            // which opens documents only. Anything else (`ssh:`, app handlers) is dropped.
            if MarkdownWebView.externalURL(url.absoluteString) != nil { return .systemAction }
            if url.isFileURL || url.scheme == nil {
                onWikilink(url.absoluteString)
                return .handled
            }
            return .discarded
        }
    }

    private var blockStyle: MarkdownStyle {
        let base = theme?.native(.vault) ?? .vault
        return base.with {
            $0.codeCopyButton = config.codeBlockBar
            // A reading pane is where people copy from: every block selects, not only code.
            $0.selection = .all
            let scale = CGFloat(zoom)
            if abs(scale - 1) > 0.001 {
                $0.bodySize *= scale
                $0.headingScale *= scale
                $0.codeFontSize = ($0.codeFontSize ?? $0.bodySize / scale - 1.5) * scale
            }
        }
    }

    private func scrollIfNeeded(proxy: ScrollViewProxy, blocks: [MarkdownBlocks.Block]) {
        guard let target = scrollTarget, !target.isEmpty else { return }
        let slug = MarkdownBlocks.slugify(target)
        // Unique like the page's ids: `examples-1` is the second "Examples"; plain text finds the first.
        let headings = blocks.filter { if case .heading = $0 { return true } else { return false } }
        let unique = MarkdownBlocks.uniqueSlugs(headings.map { block in
            if case .heading(_, _, let s, _) = block { return s } else { return "" }
        })
        if let at = unique.firstIndex(of: slug) {
            let block = headings[at]
            GenMotion.perform(expanding: true, reduceMotion: reduceMotion) { proxy.scrollTo(block.id, anchor: .top) }
            return
        }
        for block in blocks {
            // Block refs: find the paragraph containing "^block"
            if target.hasPrefix("^"), case .paragraph(let text, _) = block, text.contains(target) {
                GenMotion.perform(expanding: true, reduceMotion: reduceMotion) { proxy.scrollTo(block.id, anchor: .top) }
                return
            }
        }
    }

    /// Jump to + blink the first block containing the search query. Fires from
    /// BOTH the token change and the markdown (file) change, so it lands once
    /// the clicked document is actually loaded — whichever arrives second.
    private func tryHighlightJump(proxy: ScrollViewProxy, blocks: [MarkdownBlocks.Block]) {
        guard highlightToken != lastHandledToken,
              let q = highlightQuery?.lowercased(), !q.isEmpty
        else { return }
        let terms = q.split(whereSeparator: { " \t\n".contains($0) }).map(String.init)
        let target = blocks.first { blockText($0).lowercased().contains(q) }
            ?? blocks.first { b in terms.contains { blockText(b).lowercased().contains($0) } }
        guard let target else { return } // doc not loaded yet — wait for markdown change
        lastHandledToken = highlightToken
        GenMotion.perform(expanding: true, reduceMotion: reduceMotion) {
            proxy.scrollTo(target.id, anchor: .center)
        }
        flashBlockId = target.id
        blink(2)
    }

    /// Two flash pulses on the matched block.
    private func blink(_ remaining: Int) {
        guard remaining > 0 else { flashBlockId = nil; return }
        withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) { flashOn = true }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.24) {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.22)) { flashOn = false }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.26) { blink(remaining - 1) }
        }
    }

    private func blockText(_ block: MarkdownBlocks.Block) -> String {
        switch block {
        case .heading(_, let t, _, _): return t
        case .paragraph(let t, _): return t
        case .code(_, let c, _): return c
        case .quote(let t, _): return t
        case .listItem(_, _, _, let t, _, _): return t
        case .table(let h, _, let rows, _): return (h + rows.flatMap { $0 }).joined(separator: " ")
        case .frontmatter(let keys, _): return keys.joined(separator: " ")
        case .rule: return ""
        }
    }
}

