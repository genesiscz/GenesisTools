//
//  SourceEditing.swift
//  GenesisKit
//
//  The pure part of the markdown source editor: Tab / Shift+Tab move the
//  selected lines in and out by one indent, and Enter continues a list item.
//  Ranges are UTF-16 (`NSRange`), the same the text view uses, so the view
//  applies the result with one replaceCharacters call.
//

import Foundation

enum SourceEditing {
    /// The document's own indent: a tab if any indented line uses one,
    /// otherwise the narrowest space indent it has. A document with no
    /// indented line gets a tab, Obsidian's default. Fenced code is skipped
    /// so a four-space code block does not decide for the prose.
    static func indentUnit(for text: String) -> String {
        var inFence = false
        var narrowest = Int.max
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") { inFence.toggle(); continue }
            if inFence || trimmed.isEmpty { continue }
            if line.hasPrefix("\t") { return "\t" }
            let spaces = line.prefix(while: { $0 == " " }).count
            if spaces > 0 { narrowest = min(narrowest, spaces) }
        }
        return narrowest == Int.max ? "\t" : String(repeating: " ", count: narrowest)
    }

    /// UTF-16 offsets where each line starts, computed once per text version
    /// so a scroll event is a binary search rather than a walk.
    static func lineStarts(_ text: String) -> [Int] {
        var starts = [0]
        let ns = text as NSString
        for i in 0..<ns.length where ns.character(at: i) == 0x0A {
            starts.append(i + 1)
        }
        return starts
    }

    /// The 0-based line that holds `offset`.
    static func line(at offset: Int, starts: [Int]) -> Int {
        var low = 0
        var high = starts.count - 1
        while low < high {
            let mid = (low + high + 1) / 2
            if starts[mid] <= offset { low = mid } else { high = mid - 1 }
        }
        return low
    }

    struct Edit: Equatable {
        /// The characters to replace, in the text before the edit.
        var range: NSRange
        var replacement: String
        /// The selection after the edit.
        var selection: NSRange
    }

    /// The full lines that touch `selection` (a caret counts as its line).
    static func lineRange(of selection: NSRange, in text: String) -> NSRange {
        let ns = text as NSString
        var r = ns.lineRange(for: selection)
        // A selection that ends right after a newline does not include the next line.
        if selection.length > 0, r.length > 0,
           ns.character(at: r.location + r.length - 1) == 0x0A,
           NSMaxRange(selection) < NSMaxRange(r),
           NSMaxRange(selection) > r.location {
            let last = ns.lineRange(for: NSRange(location: NSMaxRange(selection) - 1, length: 0))
            r = NSRange(location: r.location, length: NSMaxRange(last) - r.location)
        }
        return r
    }

    /// Tab: every selected line moves in by one unit. A caret with no
    /// selection just gets the unit inserted at the caret.
    static func indent(_ text: String, selection: NSRange, unit: String? = nil) -> Edit {
        let indentUnit = unit ?? indentUnit(for: text)
        if selection.length == 0 {
            return Edit(range: selection, replacement: indentUnit,
                        selection: NSRange(location: selection.location + (indentUnit as NSString).length, length: 0))
        }
        let lines = lineRange(of: selection, in: text)
        let block = (text as NSString).substring(with: lines)
        let parts = split(block)
        let out = parts.map { $0.isEmpty ? $0 : indentUnit + $0 }.joined(separator: "\n")
        let added = parts.filter { !$0.isEmpty }.count * (indentUnit as NSString).length
        let firstAdded = parts.first?.isEmpty == false ? (indentUnit as NSString).length : 0
        return Edit(range: lines, replacement: out,
                    selection: NSRange(location: selection.location + firstAdded, length: selection.length + added - firstAdded))
    }

    /// Shift+Tab: every selected line loses one unit (or a tab, or fewer
    /// spaces if that is all it has).
    static func outdent(_ text: String, selection: NSRange, unit: String? = nil) -> Edit {
        let indentUnit = unit ?? indentUnit(for: text)
        let lines = lineRange(of: selection, in: text)
        let block = (text as NSString).substring(with: lines)
        let parts = split(block)
        var removed: [Int] = []
        let out = parts.map { line -> String in
            let n = leadingIndent(line, unit: indentUnit)
            removed.append(n)
            return String(line.dropFirst(n))
        }.joined(separator: "\n")
        let total = removed.reduce(0, +)
        // The caret cannot move above its line start.
        let firstRemoved = min(removed.first ?? 0, selection.location - lines.location)
        let location = selection.location - firstRemoved
        let length = max(0, selection.length - (total - firstRemoved))
        return Edit(range: lines, replacement: out, selection: NSRange(location: location, length: length))
    }

    /// Enter inside a list item starts the next item with the same marker.
    /// Enter on an empty item removes the marker instead (ends the list).
    /// nil = a plain newline, the view does its own thing.
    static func newline(_ text: String, selection: NSRange) -> Edit? {
        guard selection.length == 0 else { return nil }
        let ns = text as NSString
        let line = ns.lineRange(for: selection)
        let head = ns.substring(with: NSRange(location: line.location, length: selection.location - line.location))
        guard let m = listMarker(head) else { return nil }
        let content = String(head.dropFirst(m.utf16.count))
        // The whole item decides, not just the part before the caret: with the
        // caret right after the marker of "- text", the item is not empty.
        let tail = ns.substring(with: NSRange(location: selection.location, length: NSMaxRange(line) - selection.location))
        if content.trimmingCharacters(in: .whitespaces).isEmpty, tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Empty item: strip the marker, leave the indentation.
            let indent = String(m.prefix(while: { $0 == " " || $0 == "\t" }))
            return Edit(range: NSRange(location: line.location, length: selection.location - line.location),
                        replacement: indent, selection: NSRange(location: line.location + (indent as NSString).length, length: 0))
        }
        let next = "\n" + nextMarker(m)
        return Edit(range: selection, replacement: next,
                    selection: NSRange(location: selection.location + (next as NSString).length, length: 0))
    }

    // MARK: formatting

    /// ⌘B / ⌘I: wrap the selection in `marks`, or take them off when they are
    /// already there. With no selection the word under the caret is used, and
    /// on empty space the marks go in with the caret between them.
    static func wrap(_ text: String, selection: NSRange, marks: String) -> Edit {
        let ns = text as NSString
        let m = (marks as NSString).length
        var target = selection
        if selection.length == 0 {
            target = word(at: selection.location, in: text)
        }
        if target.length == 0 {
            return Edit(range: target, replacement: marks + marks,
                        selection: NSRange(location: target.location + m, length: 0))
        }
        let inner = ns.substring(with: target)
        // Marks inside the selection.
        if inner.hasPrefix(marks), inner.hasSuffix(marks), (inner as NSString).length >= 2 * m {
            let bare = (inner as NSString).substring(with: NSRange(location: m, length: (inner as NSString).length - 2 * m))
            return Edit(range: target, replacement: bare,
                        selection: NSRange(location: target.location, length: (bare as NSString).length))
        }
        // Marks just outside it.
        if target.location - m >= 0, NSMaxRange(target) + m <= ns.length,
           ns.substring(with: NSRange(location: target.location - m, length: m)) == marks,
           ns.substring(with: NSRange(location: NSMaxRange(target), length: m)) == marks {
            let outer = NSRange(location: target.location - m, length: target.length + 2 * m)
            return Edit(range: outer, replacement: inner,
                        selection: NSRange(location: outer.location, length: target.length))
        }
        return Edit(range: target, replacement: marks + inner + marks,
                    selection: NSRange(location: target.location + m, length: target.length))
    }

    /// ⌘K, and pasting a URL over a selection. An empty url leaves the caret
    /// between the parentheses, ready for the address.
    static func link(_ text: String, selection: NSRange, url: String = "") -> Edit {
        let ns = text as NSString
        var target = selection
        if selection.length == 0, !url.isEmpty {
            target = word(at: selection.location, in: text)
        }
        let label = target.length > 0 ? ns.substring(with: target) : ""
        let replacement = "[\(label)](\(url))"
        let labelLength = (label as NSString).length
        let caret: NSRange
        if url.isEmpty {
            caret = NSRange(location: target.location + labelLength + 3, length: 0)
        } else if label.isEmpty {
            caret = NSRange(location: target.location + 1, length: 0)
        } else {
            caret = NSRange(location: target.location + (replacement as NSString).length, length: 0)
        }
        return Edit(range: target, replacement: replacement, selection: caret)
    }

    /// ⌘⇧X: every selected line becomes a task, and a task toggles done.
    static func toggleTask(_ text: String, selection: NSRange) -> Edit {
        let lines = lineRange(of: selection, in: text)
        let block = (text as NSString).substring(with: lines)
        var parts = split(block)
        let trailing = parts.last?.isEmpty == true
        if trailing { parts.removeLast() }
        // One open box in the block means the whole block ticks.
        let anyOpen = parts.contains { $0.range(of: #"^[ \t]*[-*+] \[ \]"#, options: .regularExpression) != nil }
        let out = parts.map { line -> String in
            let indent = String(line.prefix(while: { $0 == " " || $0 == "\t" }))
            let rest = String(line.dropFirst(indent.count))
            if let box = rest.range(of: #"^[-*+] \[[ xX]\] "#, options: .regularExpression) {
                let done = !rest[box].contains("[ ]")
                let body = String(rest[box.upperBound...])
                if anyOpen { return indent + "- [x] " + body }
                return indent + (done ? "- [ ] " : "- [x] ") + body
            }
            if let bullet = rest.range(of: #"^[-*+] "#, options: .regularExpression) {
                return indent + "- [ ] " + String(rest[bullet.upperBound...])
            }
            if rest.isEmpty { return line }
            return indent + "- [ ] " + rest
        }.joined(separator: "\n") + (trailing ? "\n" : "")
        return Edit(range: lines, replacement: out,
                    selection: NSRange(location: lines.location, length: (out as NSString).length))
    }

    /// A pasted address, worth turning into a link rather than raw text.
    static func isURL(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t == s, !t.contains(" "), !t.contains("\n") else { return false }
        return t.range(of: #"^(https?|obsidian|genesis|file)://\S+$"#, options: .regularExpression) != nil
            || t.range(of: #"^mailto:\S+@\S+$"#, options: .regularExpression) != nil
    }

    /// The word around `offset`, or an empty range on whitespace.
    static func word(at offset: Int, in text: String) -> NSRange {
        let ns = text as NSString
        func isWord(_ c: unichar) -> Bool {
            guard let scalar = UnicodeScalar(c) else { return false }
            let ch = Character(scalar)
            return ch.isLetter || ch.isNumber || ch == "_" || ch == "-"
        }
        var start = min(max(0, offset), ns.length)
        var end = start
        while start > 0, isWord(ns.character(at: start - 1)) { start -= 1 }
        while end < ns.length, isWord(ns.character(at: end)) { end += 1 }
        return NSRange(location: start, length: end - start)
    }

    // MARK: helpers

    private static func split(_ block: String) -> [String] {
        // Keep a trailing newline as an empty last part so the join restores it.
        block.components(separatedBy: "\n")
    }

    /// One indent's worth of leading whitespace: a tab, or up to one unit of
    /// spaces (a whole unit when the unit is a tab, so a space-indented line
    /// in a tab document still outdents).
    private static func leadingIndent(_ line: String, unit: String) -> Int {
        if line.hasPrefix("\t") { return 1 }
        let limit = unit == "\t" ? 4 : unit.count
        return min(line.prefix(while: { $0 == " " }).count, limit)
    }

    /// `"  - "`, `"- [ ] "`, `"3. "` at the start of a line, with its indentation.
    static func listMarker(_ head: String) -> String? {
        let pattern = #"^[ \t]*(?:[-*+] (?:\[[ xX]\] )?|\d+[.)] )"#
        guard let r = head.range(of: pattern, options: .regularExpression) else { return nil }
        return String(head[r])
    }

    private static func nextMarker(_ marker: String) -> String {
        var m = marker.replacingOccurrences(of: "[x] ", with: "[ ] ").replacingOccurrences(of: "[X] ", with: "[ ] ")
        if let r = m.range(of: #"\d+"#, options: .regularExpression), let n = Int(m[r]), n < Int.max {
            m.replaceSubrange(r, with: String(n + 1))
        }
        return m
    }
}
