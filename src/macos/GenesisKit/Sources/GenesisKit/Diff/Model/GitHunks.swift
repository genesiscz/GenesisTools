//
//  GitHunks.swift
//  GenesisKit
//
//  The changed regions of a text against an older copy of it (HEAD), as a gutter shows them: added lines, changed
//  lines with the text they replaced, and the place where lines were removed. A hunk can be reverted in the text.
//

import Foundation

public struct GitHunk: Equatable, Sendable, Identifiable {
    public enum Kind: String, Sendable {
        case added, modified, deleted
    }

    public var kind: Kind
    /// 0-based first line in the new text. For a deletion, the line the removed text stood before (it may be the
    /// line count: removed at the end).
    public var newStart: Int
    /// Lines in the new text; 0 for a deletion.
    public var newCount: Int
    /// 0-based first line in the old text.
    public var oldStart: Int
    /// The old text's lines this hunk replaced; empty for an addition.
    public var oldLines: [String]

    public init(kind: Kind, newStart: Int, newCount: Int, oldStart: Int, oldLines: [String]) {
        self.kind = kind
        self.newStart = newStart
        self.newCount = newCount
        self.oldStart = oldStart
        self.oldLines = oldLines
    }

    public var id: String { "\(newStart):\(newCount):\(oldStart):\(oldLines.count)" }

    /// The new text's lines this hunk covers, as a closed range (a deletion covers the line it stands before).
    public var newLines: ClosedRange<Int> { newStart ... max(newStart, newStart + newCount - 1) }

    /// "Lines 12–14 changed", "Line 3 added", "2 lines removed before line 8", 1-based for a reader.
    public var title: String {
        let first = newStart + 1
        let last = newStart + newCount
        let span = newCount == 1 ? "Line \(first)" : "Lines \(first)–\(last)"
        switch kind {
        case .added: return "\(span) added"
        case .modified: return "\(span) changed"
        case .deleted: return "\(Plural.count(oldLines.count, "line")) removed before line \(first)"
        }
    }
}

public enum GitHunks {
    /// The hunks that turn `old` into `new`, in order.
    public static func between(old: String, new: String) -> [GitHunk] {
        var hunks: [GitHunk] = []
        var oldLine = 0, newLine = 0
        var removed: [String] = []
        var inserted = 0
        var startOld = 0, startNew = 0

        func flush() {
            guard !removed.isEmpty || inserted > 0 else { return }
            let kind: GitHunk.Kind = removed.isEmpty ? .added : (inserted == 0 ? .deleted : .modified)
            hunks.append(GitHunk(kind: kind, newStart: startNew, newCount: inserted, oldStart: startOld, oldLines: removed))
            removed = []
            inserted = 0
        }

        for line in TextMerge.diff(old: old, new: new) {
            switch line {
            case .equal:
                flush()
                oldLine += 1
                newLine += 1
            case .removed(let text):
                if removed.isEmpty && inserted == 0 {
                    startOld = oldLine
                    startNew = newLine
                }
                removed.append(String(text))
                oldLine += 1
            case .inserted:
                if removed.isEmpty && inserted == 0 {
                    startOld = oldLine
                    startNew = newLine
                }
                inserted += 1
                newLine += 1
            }
        }
        flush()
        return hunks
    }

    /// `text` with `hunk` put back as it was: its new lines replaced by its old ones.
    public static func revert(_ hunk: GitHunk, in text: String) -> String {
        var lines = TextMerge.Lines(text)
        let start = min(hunk.newStart, lines.lines.count)
        let end = min(start + hunk.newCount, lines.lines.count)
        lines.lines.replaceSubrange(start ..< end, with: hunk.oldLines.map { Substring($0) })
        // A revert that brings back lines into an empty file restores its last newline with them.
        let trailing = lines.trailingNewline || (text.isEmpty && !hunk.oldLines.isEmpty)
        return TextMerge.Lines.join(lines.lines, trailingNewline: trailing)
    }
}
