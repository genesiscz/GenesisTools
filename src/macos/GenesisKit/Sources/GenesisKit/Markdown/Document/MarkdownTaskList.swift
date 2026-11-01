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

    /// Every task item outside the frontmatter and fenced code, in file order. The frontmatter is found the way
    /// `MarkdownFrontmatter.split` finds it, so the lines agree with the page's.
    static func items(in bytes: [UInt8]) -> [MarkdownTaskLine] {
        let lines = lines(bytes)
        var out: [MarkdownTaskLine] = []
        var fence: (mark: UInt8, count: Int)?
        for n in bodyStart(lines, bytes)..<lines.count {
            let line = bytes[lines[n]]
            if let mark = fenceMark(line) {
                if let opened = fence {
                    if mark.mark == opened.mark, mark.count >= opened.count, mark.bare { fence = nil }
                } else {
                    fence = (mark.mark, mark.count)
                }
                continue
            }
            guard fence == nil, let found = parse(line) else { continue }
            out.append(MarkdownTaskLine(line: n, stateOffset: found.state, checked: found.checked, text: found.text))
        }
        return out
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
