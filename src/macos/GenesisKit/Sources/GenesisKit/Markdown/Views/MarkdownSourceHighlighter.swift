//
//  MarkdownSourceHighlighter.swift
//  GenesisKit
//
//  Colours the source editor's markdown the way a code editor does: muted syntax marks, bold headings, links,
//  wikilinks, embeds, callouts, tags, inline code, and fenced code in its language's colours. The colours are
//  attributes of the text storage, set while the storage processes an edit, so the text, the selection and the
//  undo stack never change. Fonts change weight and slant only: every SF Mono face has the same line height and
//  advance, so no line moves when it gains a colour.
//
//  Incremental: each line keeps the block it starts in (front matter, a fence, an HTML comment, a callout). An
//  edit colours its own lines and the line above them (a table's header row depends on the row under it), then
//  goes on only while the block the next line starts in differs from what it was. Typing in a paragraph colours
//  two lines; opening a fence colours everything below it, and closing it again does the same once more.
//

import AppKit

/// How a stretch of markdown source looks: a colour role, plus weight, slant and a strike line.
struct MarkdownSourceStyle: Hashable {
    var role: MarkdownTheme.SourceRole
    var bold = false
    var italic = false
    var strike = false

    static let text = MarkdownSourceStyle(role: .text)
    static let marker = MarkdownSourceStyle(role: .marker)
    static let comment = MarkdownSourceStyle(role: .comment, italic: true)
    static let codeText = MarkdownSourceStyle(role: .codeText)

    /// Another role in this style's weight and slant, so a link inside bold text stays bold.
    func with(_ role: MarkdownTheme.SourceRole) -> MarkdownSourceStyle {
        MarkdownSourceStyle(role: role, bold: bold, italic: italic)
    }
}

/// Splits one line of markdown into styled runs. Pure (no AppKit, no text storage), so the tests read it directly.
enum MarkdownSourceScanner {
    /// The block a line starts in. The lines above decide it; nothing on the line itself does.
    enum Block: Equatable {
        case text
        case frontmatter
        /// Inside a fence opened by `count` × `mark`. `inComment`: the language's block comment is still open.
        case fence(mark: unichar, count: Int, language: SyntaxLanguage, inComment: Bool)
        /// Inside an HTML comment that has not closed yet.
        case comment
        /// Inside a callout, whose `>` lines take its colour.
        case callout(MarkdownTheme.SourceRole)
    }

    struct Run: Equatable {
        var length: Int
        var style: MarkdownSourceStyle
    }

    /// Lines longer than this keep their inline marks plain: the search for a closing mark is quadratic at worst.
    static let longLine = 4_000

    /// The runs of one line (`chars`, without its line break) and the block the next line starts in.
    /// `nextIsDelimiterRow` is asked only for a line with a `|`, so a table's header row can be bold.
    static func scan(
        _ chars: UnsafeBufferPointer<unichar>,
        entry: Block,
        isFirstLine: Bool,
        nextIsDelimiterRow: () -> Bool
    ) -> (runs: [Run], exit: Block) {
        var line = Line(chars)
        let exit = line.scan(entry: entry, isFirstLine: isFirstLine, nextIsDelimiterRow: nextIsDelimiterRow)
        return (line.runs, exit)
    }

    /// A table's delimiter row (`|---|:--:|`): pipes, dashes, colons and spaces only, with a pipe and a dash.
    static func isDelimiterRow(_ chars: UnsafeBufferPointer<unichar>) -> Bool {
        var pipe = false
        var dash = false
        for u in chars {
            switch u {
            case U.pipe: pipe = true
            case U.dash: dash = true
            case U.colon, U.space, U.tab: continue
            default: return false
            }
        }
        return pipe && dash
    }

    /// A callout type's colour, grouped as the rendered page groups the types (`GN_ALIAS` in the web renderer).
    static func calloutRole(_ type: String) -> MarkdownTheme.SourceRole {
        switch type.lowercased() {
        case "abstract", "summary", "tldr": .calloutAbstract
        case "tip", "hint", "important", "idea": .calloutTip
        case "success", "check", "done": .calloutSuccess
        case "question", "help", "faq", "warning", "caution", "attention": .calloutWarning
        case "failure", "fail", "missing", "danger", "error", "bug": .calloutDanger
        case "example": .calloutExample
        case "quote", "cite": .calloutQuote
        default: .calloutNote
        }
    }

    /// A highlighter for a fence's language, inside its block comment or not. `SyntaxHighlighter` keeps that state
    /// private; feeding it both comment openers sets it for every language that has a block comment.
    static func codeHighlighter(_ language: SyntaxLanguage, inComment: Bool) -> SyntaxHighlighter {
        var highlighter = SyntaxHighlighter(language: language)
        if inComment { _ = highlighter.runs("/*<!--") }
        return highlighter
    }

    /// Whether the highlighter's block comment is open: inside one, the next character is a comment.
    static func isInComment(_ highlighter: SyntaxHighlighter) -> Bool {
        var probe = highlighter
        return probe.runs("x").first?.0 == .comment
    }

    static func role(_ token: SyntaxToken) -> MarkdownTheme.SourceRole {
        switch token {
        case .plain: .codeText
        case .comment: .codeComment
        case .string: .codeString
        case .number: .codeNumber
        case .keyword: .codeKeyword
        case .type: .codeType
        case .call: .codeCall
        case .key: .propertyKey
        case .flag: .codeFlag
        case .heading: .heading
        }
    }
}

/// UTF-16 code units the scanner looks for.
private enum U {
    static let tab: unichar = 0x09
    static let newline: unichar = 0x0a
    static let carriageReturn: unichar = 0x0d
    static let space: unichar = 0x20
    static let bang: unichar = 0x21
    static let quote: unichar = 0x22
    static let hash: unichar = 0x23
    static let apostrophe: unichar = 0x27
    static let lparen: unichar = 0x28
    static let rparen: unichar = 0x29
    static let star: unichar = 0x2a
    static let plus: unichar = 0x2b
    static let comma: unichar = 0x2c
    static let dash: unichar = 0x2d
    static let dot: unichar = 0x2e
    static let slash: unichar = 0x2f
    static let colon: unichar = 0x3a
    static let semicolon: unichar = 0x3b
    static let lt: unichar = 0x3c
    static let equals: unichar = 0x3d
    static let gt: unichar = 0x3e
    static let question: unichar = 0x3f
    static let upperX: unichar = 0x58
    static let lbracket: unichar = 0x5b
    static let backslash: unichar = 0x5c
    static let rbracket: unichar = 0x5d
    static let caret: unichar = 0x5e
    static let underscore: unichar = 0x5f
    static let backtick: unichar = 0x60
    static let h: unichar = 0x68
    static let x: unichar = 0x78
    static let pipe: unichar = 0x7c
    static let tilde: unichar = 0x7e

    /// The characters an inline mark can start with, as bits: `! # * < =` and `[ \ _ \` h | ~`.
    static let special0: UInt64 = 1 << 0x21 | 1 << 0x23 | 1 << 0x2a | 1 << 0x3c | 1 << 0x3d
    static let special1: UInt64 = 1 << (0x5b - 64) | 1 << (0x5c - 64) | 1 << (0x5f - 64) | 1 << (0x60 - 64)
        | 1 << (0x68 - 64) | 1 << (0x7c - 64) | 1 << (0x7e - 64)

    static let commentClose: [unichar] = Array("-->".utf16)
    static let schemeSeparator: [unichar] = Array("://".utf16)
    static let http: [unichar] = Array("http://".utf16)
    static let https: [unichar] = Array("https://".utf16)
}

/// One line's scan: walks the characters and appends runs that cover every one of them, in order.
private struct Line {
    let c: UnsafeBufferPointer<unichar>
    let n: Int
    var runs: [MarkdownSourceScanner.Run] = []
    /// Everything before this is in `runs`.
    var cursor = 0
    /// An HTML comment opened on this line and runs past its end.
    var openComment = false

    typealias Block = MarkdownSourceScanner.Block
    typealias Style = MarkdownSourceStyle

    init(_ chars: UnsafeBufferPointer<unichar>) {
        c = chars
        n = chars.count
    }

    /// Covers `cursor..<end` with `style`, merged into the last run when it looks the same.
    mutating func emit(_ end: Int, _ style: Style) {
        guard end > cursor else { return }
        if let last = runs.last, last.style == style {
            runs[runs.count - 1].length += end - cursor
        } else {
            runs.append(.init(length: end - cursor, style: style))
        }
        cursor = end
    }

    // MARK: Blocks

    mutating func scan(entry: Block, isFirstLine: Bool, nextIsDelimiterRow: () -> Bool) -> Block {
        switch entry {
        case .frontmatter:
            if isBare(U.dash) || isBare(U.dot) {
                emit(n, .marker)
                return .text
            }
            frontmatter()
            return .frontmatter
        case let .fence(mark, count, language, inComment):
            if closesFence(mark, count) {
                emit(n, .marker)
                return .text
            }
            return code(mark: mark, count: count, language: language, inComment: inComment)
        case .comment:
            guard let close = find(U.commentClose, from: 0, to: n) else {
                emit(n, .comment)
                return .comment
            }
            emit(close + 3, .comment)
            inline(close + 3, n, .text)
            return openComment ? .comment : .text
        case .text, .callout:
            if isFirstLine, isBare(U.dash) {
                emit(n, .marker)
                return .frontmatter
            }
            if let fence = opensFence() { return fence }
            var callout: MarkdownTheme.SourceRole?
            if case let .callout(role) = entry { callout = role }
            let exit = block(from: 0, base: .text, callout: callout, quotes: true, nextIsDelimiterRow: nextIsDelimiterRow)
            return openComment ? .comment : exit
        }
    }

    /// The line is three of `u` (`---`, `...`) and nothing else but spaces.
    func isBare(_ u: unichar) -> Bool {
        guard n >= 3, c[0] == u, c[1] == u, c[2] == u else { return false }
        return (3..<n).allSatisfy { isSpace(c[$0]) }
    }

    func indent(from start: Int) -> Int {
        var i = start
        while i < n, isSpace(c[i]) { i += 1 }
        return i
    }

    func string(_ from: Int, _ to: Int) -> String {
        guard to > from, let base = c.baseAddress else { return "" }
        return String(utf16CodeUnits: base + from, count: to - from)
    }

    /// `key: value`, `- item` and `# comment` between the front matter's `---` lines.
    mutating func frontmatter() {
        var i = indent(from: 0)
        if i < n, c[i] == U.hash {
            emit(i, .text)
            emit(n, .comment)
            return
        }
        if i < n, c[i] == U.dash, i + 1 == n || isSpace(c[i + 1]) {
            emit(i, .text)
            emit(i + 1, .marker)
            i += 1
        } else {
            var colon = i
            while colon < n, c[colon] != U.colon { colon += 1 }
            if colon < n, colon > i, colon + 1 == n || isSpace(c[colon + 1]) {
                emit(i, .text)
                emit(colon, Style(role: .propertyKey))
                emit(colon + 1, .marker)
                i = colon + 1
            }
        }
        inline(i, n, Style(role: .propertyValue), rich: false)
    }

    /// ```` ```lang ```` or `~~~`, up to three spaces in. A backtick fence's info string has no backtick.
    mutating func opensFence() -> Block? {
        let i = indent(from: 0)
        guard i <= 3, i < n, c[i] == U.backtick || c[i] == U.tilde else { return nil }
        let mark = c[i]
        let j = runEnd(i, n)
        guard j - i >= 3 else { return nil }
        let info = indent(from: j)
        if mark == U.backtick, (info..<n).contains(where: { c[$0] == U.backtick }) { return nil }
        emit(i, .text)
        emit(j, .marker)
        emit(info, .text)
        emit(n, Style(role: .fenceInfo))
        let language = MarkdownRenderCache.fenceLanguage(string(info, n))
        return .fence(mark: mark, count: j - i, language: language, inComment: false)
    }

    func closesFence(_ mark: unichar, _ count: Int) -> Bool {
        let i = indent(from: 0)
        guard i <= 3, i < n, c[i] == mark else { return false }
        let j = runEnd(i, n)
        return j - i >= count && indent(from: j) == n
    }

    /// A line inside a fence, in its language's colours when GenesisKit's token highlighter knows the language.
    mutating func code(mark: unichar, count: Int, language: SyntaxLanguage, inComment: Bool) -> Block {
        guard language != .plain, n > 0 else {
            emit(n, .codeText)
            return .fence(mark: mark, count: count, language: language, inComment: inComment)
        }
        var highlighter = MarkdownSourceScanner.codeHighlighter(language, inComment: inComment)
        let text = string(0, n)
        var scalars = text.unicodeScalars.makeIterator()
        var position = 0
        // The highlighter counts unicode scalars; the runs count UTF-16 units.
        for (token, length) in highlighter.runs(text) {
            for _ in 0..<length {
                guard let scalar = scalars.next() else { break }
                position += UTF16.width(scalar)
            }
            emit(position, Style(role: MarkdownSourceScanner.role(token)))
        }
        emit(n, .codeText)
        return .fence(mark: mark, count: count, language: language, inComment: MarkdownSourceScanner.isInComment(highlighter))
    }

    /// A line outside fences and front matter, from `p`: a quote, a heading, a rule, a table row, a list item or
    /// prose. Inside a quote it runs again on what follows the `>` marks, with `quotes` off.
    mutating func block(
        from p: Int,
        base: Style,
        callout: MarkdownTheme.SourceRole?,
        quotes: Bool,
        nextIsDelimiterRow: () -> Bool
    ) -> Block {
        let i = indent(from: p)
        guard i < n else {
            emit(n, base)
            return .text
        }
        let shallow = i - p <= 3
        let u = c[i]
        if quotes, shallow, u == U.gt { return quote(at: i, callout: callout, nextIsDelimiterRow: nextIsDelimiterRow) }
        if shallow, u == U.hash, heading(at: i) { return .text }
        if shallow, isThematicBreak(from: i) || isDelimiterRow(from: i) {
            emit(i, base)
            emit(n, .marker)
            return .text
        }
        if let end = listMarker(at: i) {
            list(at: i, markerEnd: end, base: base)
            return .text
        }
        var rowBase = base
        var pipes = false
        if (i..<n).contains(where: { c[$0] == U.pipe }) {
            pipes = u == U.pipe
            if nextIsDelimiterRow() {
                pipes = true
                rowBase = Style(role: .strong, bold: true)
            }
        }
        inline(p, n, rowBase, pipes: pipes)
        return .text
    }

    /// `>` marks, then a callout's `[!type] Title`, a callout's body line, or a plain quote.
    mutating func quote(at i: Int, callout: MarkdownTheme.SourceRole?, nextIsDelimiterRow: () -> Bool) -> Block {
        var j = i
        while j < n, c[j] == U.gt {
            j += 1
            while j < n, isSpace(c[j]) { j += 1 }
        }
        emit(i, .text)
        let header = calloutHeader(at: j)
        emit(j, (header?.role ?? callout).map { Style(role: $0) } ?? .marker)
        if let header {
            emit(header.end, Style(role: header.role, bold: true))
            inline(header.end, n, Style(role: header.role))
            return .callout(header.role)
        }
        if let callout {
            _ = block(from: j, base: .text, callout: nil, quotes: false, nextIsDelimiterRow: nextIsDelimiterRow)
            return .callout(callout)
        }
        _ = block(from: j, base: Style(role: .quote), callout: nil, quotes: false, nextIsDelimiterRow: nextIsDelimiterRow)
        return .text
    }

    /// `[!type]`, and a fold mark (`+` or `-`) right after it.
    func calloutHeader(at j: Int) -> (end: Int, role: MarkdownTheme.SourceRole)? {
        guard j + 3 < n, c[j] == U.lbracket, c[j + 1] == U.bang else { return nil }
        var k = j + 2
        while k < n, isWordChar(c[k]) || c[k] == U.dash { k += 1 }
        guard k < n, k > j + 2, c[k] == U.rbracket else { return nil }
        var end = k + 1
        if end < n, c[end] == U.plus || c[end] == U.dash { end += 1 }
        return (end, MarkdownSourceScanner.calloutRole(string(j + 2, k)))
    }

    /// `#` to `######`, a space, the title, and an optional closing run of `#` after a space.
    mutating func heading(at i: Int) -> Bool {
        let j = runEnd(i, n)
        guard j - i <= 6, j == n || isSpace(c[j]) else { return false }
        emit(i, .text)
        emit(j, .marker)
        var end = n
        while end > j, isSpace(c[end - 1]) { end -= 1 }
        var close = end
        while close > j, c[close - 1] == U.hash { close -= 1 }
        let closed = close < end && (close == j || isSpace(c[close - 1]))
        let style = Style(role: .heading, bold: true)
        inline(j, closed ? close : end, style)
        emit(n, closed ? .marker : style)
        return true
    }

    /// `---`, `***` or `___`: three or more of one of them and nothing but spaces.
    func isThematicBreak(from i: Int) -> Bool {
        let u = c[i]
        guard u == U.dash || u == U.star || u == U.underscore else { return false }
        var count = 0
        for k in i..<n {
            if c[k] == u {
                count += 1
            } else if !isSpace(c[k]) {
                return false
            }
        }
        return count >= 3
    }

    func isDelimiterRow(from i: Int) -> Bool {
        MarkdownSourceScanner.isDelimiterRow(UnsafeBufferPointer(rebasing: c[i..<n]))
    }

    /// `-`, `*`, `+`, `1.` or `1)`, then a space or the end of the line: where the item's text starts.
    func listMarker(at i: Int) -> Int? {
        var j = i
        if c[i] == U.dash || c[i] == U.star || c[i] == U.plus {
            j += 1
        } else if isDigit(c[i]) {
            while j < n, j - i < 9, isDigit(c[j]) { j += 1 }
            guard j < n, c[j] == U.dot || c[j] == U.rparen else { return nil }
            j += 1
        } else {
            return nil
        }
        if j == n { return j }
        return isSpace(c[j]) ? j + 1 : nil
    }

    /// The marker, a task's box (`[ ]`, `[x]`, Obsidian's `[/]` and friends), then the item's text. A finished
    /// task's text steps back.
    mutating func list(at i: Int, markerEnd: Int, base: Style) {
        emit(i, base)
        emit(markerEnd, .marker)
        var k = markerEnd
        var content = base
        if k + 2 < n, c[k] == U.lbracket, c[k + 2] == U.rbracket, c[k + 1] != U.lbracket, k + 3 == n || isSpace(c[k + 3]) {
            emit(k + 3, Style(role: .task))
            if c[k + 1] == U.x || c[k + 1] == U.upperX { content = base.with(.strike) }
            k += 3
        }
        inline(k, n, content)
    }

    // MARK: Inline

    /// `from..<to` in `base`, with every inline mark in its own colour. `rich` off (front matter values) keeps
    /// only wikilinks and bare URLs; `pipes` marks a table row's `|`.
    mutating func inline(_ from: Int, _ to: Int, _ base: Style, pipes: Bool = false, rich: Bool = true) {
        guard to - from <= MarkdownSourceScanner.longLine else {
            emit(to, base)
            return
        }
        var i = from
        while i < to {
            let u = c[i]
            let special = u < 64 ? (U.special0 >> u) & 1 : u < 128 ? (U.special1 >> (u - 64)) & 1 : 0
            guard special != 0 else {
                i += 1
                continue
            }
            let end: Int?
            switch u {
            case U.backslash:
                end = rich && i + 1 < to && isPunctuation(c[i + 1]) ? escape(i, base) : nil
            case U.backtick:
                end = rich ? codeSpan(i, to, base) ?? runEnd(i, to) : nil
            case U.lt:
                end = rich ? comment(i, to, base) ?? htmlTag(i, to, base) : nil
            case U.bang:
                end = wikilink(i, to, base, open: 3, role: .embed) ?? (rich ? link(i, to, base) : nil)
            case U.lbracket:
                end = wikilink(i, to, base, open: 2, role: .link) ?? (rich ? link(i, to, base) : nil)
            case U.star, U.underscore:
                end = rich ? emphasis(i, to, base) ?? runEnd(i, to) : nil
            case U.tilde, U.equals:
                end = rich ? pair(i, to, base) ?? runEnd(i, to) : nil
            case U.hash:
                end = rich ? hashtag(i, to, base) : nil
            case U.h:
                end = url(i, to, base)
            case U.pipe:
                end = pipes ? mark(i, base) : nil
            default:
                end = nil
            }
            i = end ?? i + 1
        }
        emit(to, base)
    }

    mutating func mark(_ i: Int, _ base: Style) -> Int {
        emit(i, base)
        emit(i + 1, .marker)
        return i + 1
    }

    /// `\*`: the backslash steps back, the character it escapes stays text.
    mutating func escape(_ i: Int, _ base: Style) -> Int {
        emit(i, base)
        emit(i + 1, .marker)
        return i + 2
    }

    /// `` `code` ``: a run of backticks closed by a run of the same length.
    mutating func codeSpan(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        guard let close = codeSpanClose(i, to) else { return nil }
        let ticks = runEnd(i, to) - i
        emit(i, base)
        emit(i + ticks, .marker)
        emit(close, base.with(.code))
        emit(close + ticks, .marker)
        return close + ticks
    }

    /// Where the backtick run at `i` closes, or nil.
    func codeSpanClose(_ i: Int, _ to: Int) -> Int? {
        let ticks = runEnd(i, to) - i
        var k = i + ticks
        while k < to {
            guard c[k] == U.backtick else {
                k += 1
                continue
            }
            let end = runEnd(k, to)
            if end - k == ticks { return k }
            k = end
        }
        return nil
    }

    /// `<!-- … -->`; one that does not close runs to the end of the line and on into the next lines.
    mutating func comment(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        guard i + 3 < to, c[i + 1] == U.bang, c[i + 2] == U.dash, c[i + 3] == U.dash else { return nil }
        emit(i, base)
        if let close = find(U.commentClose, from: i + 4, to: to) {
            emit(close + 3, .comment)
            return close + 3
        }
        emit(to, .comment)
        if to == n { openComment = true }
        return to
    }

    /// `<tag …>` and `</tag>` step back as syntax; `<https://…>` is a link.
    mutating func htmlTag(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        var k = i + 1
        if k < to, c[k] == U.slash { k += 1 }
        guard k < to, isASCIILetter(c[k]) else { return nil }
        while k < to, c[k] != U.gt, c[k] != U.lt { k += 1 }
        guard k < to, c[k] == U.gt else { return nil }
        emit(i, base)
        if find(U.schemeSeparator, from: i + 1, to: k) != nil, !(i + 1..<k).contains(where: { isSpace(c[$0]) }) {
            emit(i + 1, .marker)
            emit(k, base.with(.link))
        }
        emit(k + 1, .marker)
        return k + 1
    }

    /// `[[target|alias]]` (`open` 2) and `![[embed]]` (`open` 3).
    mutating func wikilink(_ i: Int, _ to: Int, _ base: Style, open: Int, role: MarkdownTheme.SourceRole) -> Int? {
        guard i + open < to, c[i + open - 1] == U.lbracket, c[i + open - 2] == U.lbracket,
              let close = find2(U.rbracket, from: i + open, to: to), close > i + open else { return nil }
        let style = base.with(role)
        emit(i, base)
        emit(i + open, .marker)
        if let bar = (i + open..<close).first(where: { c[$0] == U.pipe }) {
            emit(bar, style)
            emit(bar + 1, .marker)
        }
        emit(close, style)
        emit(close + 2, .marker)
        return close + 2
    }

    /// `[text](url)`, `![alt](src)`, `[text][ref]`, `[^note]`, and at a line's start `[label]: url` and `[^note]:`.
    mutating func link(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        let image = c[i] == U.bang
        let open = image ? i + 1 : i
        guard open < to, c[open] == U.lbracket, let close = matching(open, U.lbracket, U.rbracket, to) else { return nil }
        let label = open + 1
        let after = close + 1
        let atStart = indent(from: 0) == i
        if !image, label < close, c[label] == U.caret {
            emit(i, base)
            emit(label, .marker)
            emit(close, base.with(.link))
            emit(after, .marker)
            if atStart, after < to, c[after] == U.colon {
                emit(after + 1, .marker)
                return after + 1
            }
            return after
        }
        if after < to, c[after] == U.lparen, let paren = matching(after, U.lparen, U.rparen, to) {
            emit(i, base)
            emit(label, .marker)
            emit(close, base.with(image ? .embed : .link))
            emit(after + 1, .marker)
            emit(paren, base.with(.url))
            emit(paren + 1, .marker)
            return paren + 1
        }
        guard !image, close > label else { return nil }
        if after < to, c[after] == U.lbracket, let ref = matching(after, U.lbracket, U.rbracket, to) {
            emit(i, base)
            emit(label, .marker)
            emit(close, base.with(.link))
            emit(after + 1, .marker)
            emit(ref, base.with(.url))
            emit(ref + 1, .marker)
            return ref + 1
        }
        if atStart, after < to, c[after] == U.colon {
            emit(i, base)
            emit(label, .marker)
            emit(close, base.with(.link))
            emit(after + 1, .marker)
            emit(to, base.with(.url))
            return to
        }
        return nil
    }

    /// `*em*`, `_em_`, `**strong**`, `__strong__`, `***both***`: a run closed by a run of the same length. An
    /// underscore inside a word (`snake_case`) is a letter.
    mutating func emphasis(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        let u = c[i]
        let width = runEnd(i, to) - i
        guard width <= 3, i + width < to, !isSpace(c[i + width]) else { return nil }
        if u == U.underscore, i > 0, isWordChar(c[i - 1]) { return nil }
        var k = i + width
        while k < to {
            let v = c[k]
            if v == U.backslash {
                k += 2
                continue
            }
            if v == U.backtick, let close = codeSpanClose(k, to) {
                k = close + (runEnd(close, to) - close)
                continue
            }
            guard v == u else {
                k += 1
                continue
            }
            let end = runEnd(k, to)
            if end - k == width, !isSpace(c[k - 1]), u != U.underscore || end == to || !isWordChar(c[end]) {
                var style = base
                if base.role == .text || base.role == .quote { style.role = width == 1 ? .emphasis : .strong }
                if width >= 2 { style.bold = true }
                if width != 2 { style.italic = true }
                emit(i, base)
                emit(i + width, .marker)
                inline(i + width, k, style)
                emit(end, .marker)
                return end
            }
            k = end
        }
        return nil
    }

    /// `~~struck~~` and `==highlighted==`.
    mutating func pair(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        let u = c[i]
        guard runEnd(i, to) - i == 2, i + 2 < to, !isSpace(c[i + 2]) else { return nil }
        var k = i + 2
        while k < to {
            guard c[k] == u else {
                k += 1
                continue
            }
            let end = runEnd(k, to)
            if end - k == 2, !isSpace(c[k - 1]) {
                var style = base
                if u == U.tilde {
                    style.role = .strike
                    style.strike = true
                } else {
                    style.role = .highlight
                }
                emit(i, base)
                emit(i + 2, .marker)
                inline(i + 2, k, style)
                emit(end, .marker)
                return end
            }
            k = end
        }
        return nil
    }

    /// `#tag` and `#nested/tag` after a space, at the start, or after `(`; at least one character is not a digit.
    mutating func hashtag(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        guard i == 0 || isSpace(c[i - 1]) || c[i - 1] == U.lparen else { return nil }
        var k = i + 1
        var word = false
        while k < to, isWordChar(c[k]) || c[k] == U.dash || c[k] == U.slash {
            if !isDigit(c[k]) { word = true }
            k += 1
        }
        guard word else { return nil }
        emit(i, base)
        emit(k, base.with(.tag))
        return k
    }

    /// A bare `http://` or `https://` URL, without the sentence's closing punctuation.
    mutating func url(_ i: Int, _ to: Int, _ base: Style) -> Int? {
        guard i == 0 || isSpace(c[i - 1]) || c[i - 1] == U.lparen || c[i - 1] == U.quote || c[i - 1] == U.apostrophe,
              let scheme = startsWith(U.https, at: i, to: to) ?? startsWith(U.http, at: i, to: to) else { return nil }
        var k = scheme
        while k < to, !isSpace(c[k]), c[k] != U.lt, c[k] != U.gt, c[k] != U.quote { k += 1 }
        let opens = (scheme..<k).contains { c[$0] == U.lparen }
        while k > scheme {
            let last = c[k - 1]
            let trailing = last == U.dot || last == U.comma || last == U.colon || last == U.semicolon
                || last == U.bang || last == U.question || last == U.apostrophe || (last == U.rparen && !opens)
            guard trailing else { break }
            k -= 1
        }
        guard k > scheme else { return nil }
        emit(i, base)
        emit(k, base.with(.link))
        return k
    }

    // MARK: Character helpers

    /// The index after the run of `c[i]` that starts at `i`.
    func runEnd(_ i: Int, _ to: Int) -> Int {
        let u = c[i]
        var k = i + 1
        while k < to, c[k] == u { k += 1 }
        return k
    }

    func find(_ pattern: [unichar], from: Int, to: Int) -> Int? {
        guard to - from >= pattern.count else { return nil }
        var k = from
        while k + pattern.count <= to {
            if c[k] == pattern[0], (1..<pattern.count).allSatisfy({ c[k + $0] == pattern[$0] }) { return k }
            k += 1
        }
        return nil
    }

    /// The first `u u` pair at or after `from`.
    func find2(_ u: unichar, from: Int, to: Int) -> Int? {
        var k = from
        while k + 1 < to {
            if c[k] == u, c[k + 1] == u { return k }
            k += 1
        }
        return nil
    }

    func startsWith(_ pattern: [unichar], at i: Int, to: Int) -> Int? {
        guard i + pattern.count <= to else { return nil }
        for (offset, u) in pattern.enumerated() where c[i + offset] != u { return nil }
        return i + pattern.count
    }

    /// The bracket that closes the one at `open`, counting nested pairs and skipping escaped characters.
    func matching(_ open: Int, _ opener: unichar, _ closer: unichar, _ to: Int) -> Int? {
        var depth = 0
        var k = open
        while k < to {
            let u = c[k]
            if u == U.backslash {
                k += 2
                continue
            }
            if u == opener {
                depth += 1
            } else if u == closer {
                depth -= 1
                if depth == 0 { return k }
            }
            k += 1
        }
        return nil
    }
}

private func isSpace(_ u: unichar) -> Bool { u == U.space || u == U.tab }

private func isDigit(_ u: unichar) -> Bool { u >= 0x30 && u <= 0x39 }

private func isASCIILetter(_ u: unichar) -> Bool {
    let lower = u | 0x20
    return lower >= 0x61 && lower <= 0x7a
}

/// A letter, a digit or `_`, in any script.
private func isWordChar(_ u: unichar) -> Bool {
    if u < 0x80 { return isDigit(u) || isASCIILetter(u) || u == U.underscore }
    guard let scalar = Unicode.Scalar(u) else { return false }
    return scalar.properties.isAlphabetic || scalar.properties.numericType != nil
}

/// ASCII punctuation, which a backslash escapes.
private func isPunctuation(_ u: unichar) -> Bool {
    (0x21...0x2f).contains(u) || (0x3a...0x40).contains(u) || (0x5b...0x60).contains(u) || (0x7b...0x7e).contains(u)
}

// MARK: - Text storage

/// Keeps an NSTextStorage's markdown coloured as it is edited. It is the storage's delegate and colours inside
/// `willProcessEditing`, so the storage still fixes the font of characters SF Mono lacks (emoji) afterwards.
///
/// Runs are written with `setAttributes`, neighbours that look the same as one run, and the storage is never read
/// back. A plain text storage holds only the font and the colour (an input method's marked text is not stored in
/// it), so nothing else is lost. For a 3,000-line note in an optimised build (2026-10-13) that is 8 ms, against
/// 30 ms for `addAttributes` per run and 13 ms more for reading each run's attributes first.
final class MarkdownSourceHighlighter: NSObject, NSTextStorageDelegate {
    /// What the colours come from. A change colours every line again.
    struct Look: Equatable {
        var font: NSFont
        var textColor: NSColor
        var theme: MarkdownTheme
    }

    private(set) var look: Look?
    private weak var storage: NSTextStorage?
    /// The UTF-16 offset each line starts at, and the block it starts in.
    private(set) var starts: [Int] = [0]
    private var entries: [MarkdownSourceScanner.Block] = [.text]
    private var styles: [MarkdownSourceStyle: [NSAttributedString.Key: Any]] = [:]
    private var fonts: [Int: NSFont] = [:]
    private var buffer: [unichar] = []
    /// The run waiting to be written, so the next one can join it.
    private var pending: (range: NSRange, style: MarkdownSourceStyle)?

    /// The lines the last pass coloured, the characters it wrote, and its cost in seconds.
    private(set) var lastLines: Range<Int> = 0..<0
    private(set) var lastWritten: NSRange?
    private(set) var lastSeconds: Double = 0

    func attach(to storage: NSTextStorage) {
        self.storage = storage
        storage.delegate = self
    }

    func setLook(_ look: Look) {
        guard look != self.look else { return }
        self.look = look
        styles = [:]
        fonts = [:]
        guard let storage else { return }
        storage.beginEditing()
        colorAll(storage)
        storage.endEditing()
    }

    func textStorage(
        _ textStorage: NSTextStorage,
        willProcessEditing editedMask: NSTextStorageEditActions,
        range editedRange: NSRange,
        changeInLength delta: Int
    ) {
        guard editedMask.contains(.editedCharacters), look != nil else { return }
        update(textStorage, edited: editedRange, delta: delta)
    }

    /// Splices the line index around the edit, then colours from the line above it.
    private func update(_ storage: NSTextStorage, edited: NSRange, delta: Int) {
        let text = storage.mutableString
        let length = text.length
        let oldLength = length - delta
        let oldEnd = NSMaxRange(edited) - delta
        guard edited.location > 0 || NSMaxRange(edited) < length,
              starts.count == entries.count, let last = starts.last, last <= oldLength,
              edited.location <= oldLength, oldEnd >= edited.location, oldEnd <= oldLength else {
            colorAll(storage)
            return
        }
        let first = SourceEditing.line(at: edited.location, starts: starts)
        let lastOld = SourceEditing.line(at: oldEnd, starts: starts)
        let hasTail = lastOld + 1 < starts.count
        let segmentStart = starts[first]
        let segmentEnd = hasTail ? starts[lastOld + 1] + delta : length
        var fresh = [segmentStart]
        let count = fetch(text, NSRange(location: segmentStart, length: segmentEnd - segmentStart))
        for offset in 0..<count where buffer[offset] == U.newline {
            let start = segmentStart + offset + 1
            if start < segmentEnd || !hasTail { fresh.append(start) }
        }
        if hasTail, delta != 0 {
            for line in (lastOld + 1)..<starts.count { starts[line] += delta }
        }
        starts.replaceSubrange(first...lastOld, with: fresh)
        // The first line still starts in the block it did; the lines after it are found again by the pass.
        entries.replaceSubrange(first...lastOld, with: [entries[first]] + repeatElement(MarkdownSourceScanner.Block.text, count: fresh.count - 1))
        color(storage, from: max(0, first - 1), through: first + fresh.count - 1)
    }

    private func colorAll(_ storage: NSTextStorage) {
        let text = storage.mutableString
        let count = fetch(text, NSRange(location: 0, length: text.length))
        starts = [0]
        for offset in 0..<count where buffer[offset] == U.newline { starts.append(offset + 1) }
        entries = Array(repeating: .text, count: starts.count)
        color(storage, from: 0, through: starts.count - 1)
    }

    /// Colours `start` through `lastFresh`, then every following line whose block differs from what it was.
    private func color(_ storage: NSTextStorage, from start: Int, through lastFresh: Int) {
        let began = DispatchTime.now().uptimeNanoseconds
        lastWritten = nil
        let text = storage.mutableString
        let length = text.length
        var line = start
        var entry = entries[start]
        PerfLog.span("markdown.source.colour", over: PerfLog.frameMs) {
            while line < starts.count {
                let exit = colorLine(line, entry: entry, storage, text, length)
                line += 1
                guard line < starts.count else { break }
                if line > lastFresh, entries[line] == exit { break }
                entries[line] = exit
                entry = exit
            }
            flush(storage)
        }
        lastLines = start..<line
        lastSeconds = Double(DispatchTime.now().uptimeNanoseconds - began) / 1e9
    }

    private func colorLine(
        _ line: Int,
        entry: MarkdownSourceScanner.Block,
        _ storage: NSTextStorage,
        _ text: NSMutableString,
        _ length: Int
    ) -> MarkdownSourceScanner.Block {
        let start = starts[line]
        let end = line + 1 < starts.count ? starts[line + 1] : length
        var contentEnd = end
        if contentEnd > start, text.character(at: contentEnd - 1) == U.newline { contentEnd -= 1 }
        if contentEnd > start, text.character(at: contentEnd - 1) == U.carriageReturn { contentEnd -= 1 }
        let count = fetch(text, NSRange(location: start, length: contentEnd - start))
        let (runs, exit) = buffer.withUnsafeBufferPointer { all in
            MarkdownSourceScanner.scan(UnsafeBufferPointer(rebasing: all[0..<count]), entry: entry, isFirstLine: line == 0) {
                isDelimiterRow(line + 1, text, length)
            }
        }
        var location = start
        for run in runs {
            write(run.style, NSRange(location: location, length: run.length), storage)
            location += run.length
        }
        write(.text, NSRange(location: contentEnd, length: end - contentEnd), storage)
        return exit
    }

    private func isDelimiterRow(_ line: Int, _ text: NSMutableString, _ length: Int) -> Bool {
        guard line < starts.count else { return false }
        let start = starts[line]
        var end = line + 1 < starts.count ? starts[line + 1] : length
        while end > start, text.character(at: end - 1) == U.newline || text.character(at: end - 1) == U.carriageReturn {
            end -= 1
        }
        guard end > start, end - start <= 1_000 else { return false }
        var chars = [unichar](repeating: 0, count: end - start)
        chars.withUnsafeMutableBufferPointer { text.getCharacters($0.baseAddress!, range: NSRange(location: start, length: end - start)) }
        return chars.withUnsafeBufferPointer { MarkdownSourceScanner.isDelimiterRow($0) }
    }

    /// Copies `range` into `buffer` and returns its length.
    private func fetch(_ text: NSMutableString, _ range: NSRange) -> Int {
        guard range.length > 0 else { return 0 }
        if buffer.count < range.length {
            buffer = [unichar](repeating: 0, count: max(range.length, buffer.count * 2))
        }
        buffer.withUnsafeMutableBufferPointer { text.getCharacters($0.baseAddress!, range: range) }
        return range.length
    }

    /// Queues a run; one that touches the queued run and looks the same joins it.
    private func write(_ style: MarkdownSourceStyle, _ range: NSRange, _ storage: NSTextStorage) {
        guard range.length > 0 else { return }
        if let queued = pending, queued.style == style, NSMaxRange(queued.range) == range.location {
            pending = (NSRange(location: queued.range.location, length: queued.range.length + range.length), style)
            return
        }
        flush(storage)
        pending = (range, style)
    }

    private func flush(_ storage: NSTextStorage) {
        guard let queued = pending else { return }
        pending = nil
        storage.setAttributes(attributes(queued.style), range: queued.range)
        lastWritten = lastWritten.map { NSUnionRange($0, queued.range) } ?? queued.range
    }

    private func attributes(_ style: MarkdownSourceStyle) -> [NSAttributedString.Key: Any] {
        if let known = styles[style] { return known }
        guard let look else { preconditionFailure("colouring before a look was set") }
        let color = style.role == .text ? look.textColor : Self.color(look.theme.sourceHex(style.role))
        let key = (style.bold ? 1 : 0) | (style.italic ? 2 : 0)
        let font = fonts[key] ?? Self.font(look.font, bold: style.bold, italic: style.italic)
        fonts[key] = font
        var made: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
        if style.strike { made[.strikethroughStyle] = NSUnderlineStyle.single.rawValue }
        styles[style] = made
        return made
    }

    static func color(_ hex: UInt32) -> NSColor {
        NSColor(
            srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1
        )
    }

    /// `base` in bold and/or italic, but only a face with the same line height and advance: anything else would
    /// move the lines. SF Mono has all four at one size.
    static func font(_ base: NSFont, bold: Bool, italic: Bool) -> NSFont {
        var traits: NSFontTraitMask = []
        if bold { traits.insert(.boldFontMask) }
        if italic { traits.insert(.italicFontMask) }
        guard !traits.isEmpty else { return base }
        let variant = NSFontManager.shared.convert(base, toHaveTrait: traits)
        func advance(_ font: NSFont) -> CGFloat { ("M" as NSString).size(withAttributes: [.font: font]).width }
        guard variant.ascender == base.ascender, variant.descender == base.descender, variant.leading == base.leading,
              abs(advance(variant) - advance(base)) < 0.01 else { return base }
        return variant
    }
}
