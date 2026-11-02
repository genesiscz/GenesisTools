//
//  MarkdownTaskList.swift
//  GenesisKit
//
//  GFM task items (`- [ ]`, `* [x]`, `1. [X]`, nested and quoted ones) found in a note's bytes, and the one-byte
//  change that checks or unchecks one. Bytes, not a String, so a save keeps every other byte as it was: CRLF line
//  endings, a BOM, trailing spaces.
//

import Foundation

/// One task item: the line it is on and where its box is.
struct MarkdownTaskLine: Equatable, Sendable {
    /// 0-based line of the file.
    let line: Int
    /// Byte offset of the box's state character (` `, `x` or `X`) in the whole text.
    let stateOffset: Int
    let checked: Bool
    /// The item's own text after the box, with spaces and tabs trimmed.
    let text: String
}

/// The item the reader clicked, as the page drew it.
struct MarkdownTaskTarget: Equatable, Sendable {
    /// 0-based line of the item in the text the page drew.
    let line: Int
    /// That line's bytes, without its line ending.
    let lineBytes: [UInt8]
    /// The item's text after the box.
    let text: String
    /// The state the reader asked for.
    let checked: Bool
}

enum MarkdownTaskList {
    /// Where the clicked item is in a text that may have changed since the page drew it.
    enum Located: Equatable {
        /// The same bytes on the same line.
        case atLine(MarkdownTaskLine)
        /// Lines came or went above it (an agent appended or inserted): the one item with its text.
        case moved(MarkdownTaskLine)
        case notFound
        /// This many items have its text, so none of them is changed.
        case ambiguous(Int)
    }

    private static let space: UInt8 = 0x20, tab: UInt8 = 0x09, newline: UInt8 = 0x0A, carriageReturn: UInt8 = 0x0D
    private static let quote: UInt8 = 0x3E, dash: UInt8 = 0x2D, star: UInt8 = 0x2A, plus: UInt8 = 0x2B
    private static let dot: UInt8 = 0x2E, paren: UInt8 = 0x29, open: UInt8 = 0x5B, close: UInt8 = 0x5D
    private static let lowerX: UInt8 = 0x78, upperX: UInt8 = 0x58, backtick: UInt8 = 0x60, tilde: UInt8 = 0x7E
    private static let hash: UInt8 = 0x23, underscore: UInt8 = 0x5F
    private static let bom: [UInt8] = [0xEF, 0xBB, 0xBF]

    // MARK: Lines

    /// The byte range of every line. A line ends at `\n`; the range leaves out the `\n` and a `\r` before it, so a
    /// CRLF file and an LF file have the same lines. A file that ends with a newline has an empty last line, as
    /// `components(separatedBy: "\n")` does, so the numbers match the page's.
    static func lines(_ bytes: [UInt8]) -> [Range<Int>] {
        var out: [Range<Int>] = []
        var start = 0
        for index in bytes.indices where bytes[index] == newline {
            var end = index
            if end > start, bytes[end - 1] == carriageReturn { end -= 1 }
            out.append(start..<end)
            start = index + 1
        }
        out.append(start..<bytes.count)
        return out
    }

    // MARK: One line

    /// The box of a task item on one line: the list marker (`-`, `*`, `+`, `1.`, `1)`) after any indent and `>`
    /// quote marks, at least one space or tab, then `[ ]`, `[x]` or `[X]` followed by a space, a tab or the end of
    /// the line. `state` is the index of the state character in the slice's base array.
    static func parse(_ line: ArraySlice<UInt8>) -> (state: Int, checked: Bool, text: String)? {
        var i = line.startIndex
        let end = line.endIndex
        if line.starts(with: bom) { i += bom.count }
        func skipBlanks() {
            while i < end, line[i] == space || line[i] == tab { i += 1 }
        }
        skipBlanks()
        while i < end, line[i] == quote {
            i += 1
            skipBlanks()
        }
        guard i < end else { return nil }
        if line[i] == dash || line[i] == star || line[i] == plus {
            i += 1
        } else {
            let digits = i
            while i < end, i - digits < 9, (0x30...0x39).contains(line[i]) { i += 1 }
            guard i > digits, i < end, line[i] == dot || line[i] == paren else { return nil }
            i += 1
        }
        guard i < end, line[i] == space || line[i] == tab else { return nil }
        skipBlanks()
        guard end - i >= 3, line[i] == open, line[i + 2] == close else { return nil }
        let state = line[i + 1]
        guard state == space || state == lowerX || state == upperX else { return nil }
        let after = i + 3
        guard after == end || line[after] == space || line[after] == tab else { return nil }
        var from = after
        var to = end
        while from < to, line[from] == space || line[from] == tab { from += 1 }
        while to > from, line[to - 1] == space || line[to - 1] == tab { to -= 1 }
        return (i + 1, state != space, String(decoding: line[from..<to], as: UTF8.self))
    }

    // MARK: Every item

    /// Every task item the page draws as a box, in file order: outside the frontmatter, fenced code and indented code.
    /// The frontmatter is found the way `MarkdownFrontmatter.split` finds it, so the lines agree with the page's.
    ///
    /// A line starts a list item only when its indent, counted from the content of the list item it sits in (or from
    /// the margin), is under four columns, as CommonMark reads it. Four or more is indented code or the next line of a
    /// paragraph: text either way, never a box. So `    - [ ] alpha` under a heading is a code example, while the same
    /// line under `- [ ] parent` is its nested task. A fence ends with the quote or list item it opened in, so a box
    /// after a quoted code block that was never closed is still a box.
    static func items(in bytes: [UInt8]) -> [MarkdownTaskLine] {
        let lines = lines(bytes)
        var out: [MarkdownTaskLine] = []
        // An open fence, the quote marks it sits in and the content column of the list item it sits in (0: none).
        var fence: (mark: UInt8, count: Int, depth: Int, column: Int)?
        // The content columns of the open list items, innermost last, inside `depth` quote marks.
        var open: [Int] = []
        var depth = 0
        // A paragraph is open: a less indented line that starts no block continues it, and closes no list item.
        var paragraph = false
        for n in bodyStart(lines, bytes)..<lines.count {
            let line = bytes[lines[n]]
            if let opened = fence {
                // A fence ends with the quote or list item it opened in, and the line is then read as a block of its
                // own (`> ```` then a line without `>`: the quote, and its code, are over).
                if belongs(line, toQuotes: opened.depth, column: opened.column) {
                    if let mark = fenceMark(line), mark.mark == opened.mark, mark.count >= opened.count, mark.bare,
                       lead(line).depth == opened.depth {
                        fence = nil
                    }
                    continue
                }
                fence = nil
            }
            let lead = lead(line)
            guard lead.first < line.endIndex else {
                paragraph = false
                continue
            }
            if lead.depth != depth {
                open = []
                depth = lead.depth
            }
            let marker = listMarker(line, at: lead.first, column: lead.column)
            let opening = fenceMark(line)
            let interrupting = interrupts(line, at: lead.first)
            // The list items this line is not indented into end here, unless it is a paragraph's lazy next line.
            if marker != nil || opening != nil || interrupting || !paragraph {
                while let last = open.last, lead.column < last { open.removeLast() }
            }
            if lead.column - (open.last ?? 0) >= 4 { continue }
            if let opening {
                fence = (opening.mark, opening.count, lead.depth, open.last ?? 0)
                paragraph = false
                continue
            }
            if interrupting {
                paragraph = false
                continue
            }
            guard let marker else {
                paragraph = true
                continue
            }
            open.append(marker.content)
            paragraph = !marker.empty
            guard !marker.code, let found = parse(line) else { continue }
            out.append(MarkdownTaskLine(line: n, stateOffset: found.state, checked: found.checked, text: found.text))
        }
        return out
    }

    /// Where a line's content starts: past a BOM, the `>` quote marks (each with the one blank after it) and the
    /// indent. `column` is that indent in columns after the last quote mark; a tab runs to the next multiple of four.
    private static func lead(_ line: ArraySlice<UInt8>) -> (depth: Int, column: Int, first: Int) {
        var i = line.startIndex
        let end = line.endIndex
        if line.starts(with: bom) { i += bom.count }
        var depth = 0
        var column = 0
        while true {
            column = 0
            while i < end, line[i] == space || line[i] == tab {
                column = line[i] == tab ? column + 4 - column % 4 : column + 1
                i += 1
            }
            guard i < end, line[i] == quote else { break }
            depth += 1
            i += 1
            if i < end, line[i] == space || line[i] == tab { i += 1 }
        }
        return (depth, column, i)
    }

    /// Whether a line inside a fence still belongs to the quote and list item the fence opened in, as CommonMark (and
    /// the page) reads it: `depth` quote marks, then an indent of at least `column` unless nothing follows them. A
    /// line with fewer quote marks ends the quote, a blank one too; a line with text that is not indented into the
    /// item ends the item; a blank line inside a list item does not. More quote marks are the code's own text.
    private static func belongs(_ line: ArraySlice<UInt8>, toQuotes depth: Int, column: Int) -> Bool {
        var i = line.startIndex
        let end = line.endIndex
        if line.starts(with: bom) { i += bom.count }
        var marks = 0
        while true {
            var indent = 0
            while i < end, line[i] == space || line[i] == tab {
                indent = line[i] == tab ? indent + 4 - indent % 4 : indent + 1
                i += 1
            }
            if marks == depth { return i == end || indent >= column }
            guard i < end, line[i] == quote else { return false }
            marks += 1
            i += 1
            if i < end, line[i] == space || line[i] == tab { i += 1 }
        }
    }

    /// The list marker at `first` (`-`, `*`, `+`, `1.`, `1)`, then a blank or the end of the line) as the column its
    /// item's content starts at. `code`: five or more blank columns follow the marker, so the content is indented
    /// code. `empty`: nothing follows it.
    private static func listMarker(_ line: ArraySlice<UInt8>, at first: Int, column: Int)
        -> (content: Int, code: Bool, empty: Bool)? {
        var i = first
        let end = line.endIndex
        if line[i] == dash || line[i] == star || line[i] == plus {
            i += 1
        } else {
            let digits = i
            while i < end, i - digits < 9, (0x30...0x39).contains(line[i]) { i += 1 }
            guard i > digits, i < end, line[i] == dot || line[i] == paren else { return nil }
            i += 1
        }
        let marked = column + (i - first)
        guard i < end else { return (marked + 1, false, true) }
        guard line[i] == space || line[i] == tab else { return nil }
        var after = marked
        while i < end, line[i] == space || line[i] == tab {
            after = line[i] == tab ? after + 4 - after % 4 : after + 1
            i += 1
        }
        if i == end { return (marked + 1, false, true) }
        if after - marked >= 5 { return (marked + 1, true, false) }
        return (after, false, false)
    }

    /// An ATX heading or a thematic break at `first`: blocks that end a paragraph, and with it every list item the
    /// line is not indented into. A thematic break wins over a list marker (`- - -`).
    private static func interrupts(_ line: ArraySlice<UInt8>, at first: Int) -> Bool {
        let end = line.endIndex
        var i = first
        if line[i] == hash {
            while i < end, line[i] == hash { i += 1 }
            return i - first <= 6 && (i == end || line[i] == space || line[i] == tab)
        }
        let mark = line[first]
        guard mark == dash || mark == star || mark == underscore else { return false }
        var count = 0
        while i < end {
            if line[i] == mark {
                count += 1
            } else if line[i] != space, line[i] != tab {
                return false
            }
            i += 1
        }
        return count >= 3
    }

    /// The first line after a leading `---` block, or 0.
    private static func bodyStart(_ lines: [Range<Int>], _ bytes: [UInt8]) -> Int {
        func isFence(_ n: Int) -> Bool {
            let line = bytes[lines[n]]
            var from = line.startIndex
            var to = line.endIndex
            while from < to, line[from] == space || line[from] == tab { from += 1 }
            while to > from, line[to - 1] == space || line[to - 1] == tab { to -= 1 }
            return line[from..<to].elementsEqual([dash, dash, dash])
        }
        guard lines.count > 1, isFence(0), let end = (1..<lines.count).first(where: isFence) else { return 0 }
        return end + 1
    }

    /// A code fence (three or more backticks or tildes after any indent and `>` marks), its length, and whether
    /// nothing but blanks follows it (only such a fence closes one).
    private static func fenceMark(_ line: ArraySlice<UInt8>) -> (mark: UInt8, count: Int, bare: Bool)? {
        var i = line.startIndex
        let end = line.endIndex
        while i < end, line[i] == space || line[i] == tab || line[i] == quote { i += 1 }
        guard i < end, line[i] == backtick || line[i] == tilde else { return nil }
        let mark = line[i]
        let start = i
        while i < end, line[i] == mark { i += 1 }
        guard i - start >= 3 else { return nil }
        let bare = line[i..<end].allSatisfy { $0 == space || $0 == tab }
        return (mark, i - start, bare)
    }

    // MARK: The clicked item

    /// The item the page drew at `bodyLine` (a 0-based line of the body, as the page numbers it) with `text`, in the
    /// text the page drew. nil when no item there or anywhere else has that text once: the page and this scanner
    /// disagree, and nothing is changed.
    static func target(bodyLine: Int, text: String, checked: Bool, in drawn: String) -> MarkdownTaskTarget? {
        let bytes = Array(drawn.utf8)
        let line = bodyLine + MarkdownFrontmatter.bodyLineOffset(in: drawn)
        let wanted = text.trimmingCharacters(in: .init(charactersIn: " \t"))
        let all = items(in: bytes)
        let sameText = all.filter { $0.text == wanted }
        guard let item = sameText.first(where: { $0.line == line }) ?? (sameText.count == 1 ? sameText[0] : nil) else {
            return nil
        }
        return MarkdownTaskTarget(line: item.line, lineBytes: Array(bytes[lines(bytes)[item.line]]), text: item.text,
                                  checked: checked)
    }

    /// The target in `bytes`: on its own line when that line still has the same bytes, else the one item with its text.
    static func locate(_ target: MarkdownTaskTarget, in bytes: [UInt8]) -> Located {
        let lines = lines(bytes)
        let all = items(in: bytes)
        if target.line < lines.count, bytes[lines[target.line]].elementsEqual(target.lineBytes),
           let item = all.first(where: { $0.line == target.line }) {
            return .atLine(item)
        }
        let sameText = all.filter { $0.text == target.text }
        switch sameText.count {
        case 0: return .notFound
        case 1: return .moved(sameText[0])
        default: return .ambiguous(sameText.count)
        }
    }

    /// `bytes` with the item's box set: `x` to check it, a space to uncheck it. nil when the box already shows that.
    static func setting(_ item: MarkdownTaskLine, checked: Bool, in bytes: [UInt8]) -> [UInt8]? {
        guard item.checked != checked, item.stateOffset < bytes.count else { return nil }
        var out = bytes
        out[item.stateOffset] = checked ? lowerX : space
        return out
    }

    /// `text` with the target's box set, for a draft or for the page's own copy. nil when it is not found once, or
    /// already set.
    static func applying(_ target: MarkdownTaskTarget, to text: String) -> String? {
        let bytes = Array(text.utf8)
        switch locate(target, in: bytes) {
        case .atLine(let item), .moved(let item):
            return setting(item, checked: target.checked, in: bytes).map { String(decoding: $0, as: UTF8.self) }
        case .notFound, .ambiguous:
            return nil
        }
    }
}
