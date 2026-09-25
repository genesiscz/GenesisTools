// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionCodeBlock.swift at 2026-09-24T08:22:05+02:00 at commit hash 352701bd4e327a97ee223015319f46223ad3a6e5
//
//  SessionCodeBlock.swift
//  Genesis
//
//  The body under an expanded tool call, drawn the way Claude Code draws it in a terminal:
//  numbered lines, `+` / `-` diff lines on red and green bands, and a `… +N lines` tail.
//
//  - `CodeBlock` is the model: lines with a number, a mark and text.
//  - `CodeBlockBuilder` makes one from plain output, a Read result, an Edit (line diff of
//    old/new), a unified diff, or a Codex patch.
//  - `CodeBlockText` renders it as ONE `Text` per block (a thousand-line body is one view, not a
//    thousand), plain first and syntax-coloured when the off-main highlight pass lands.
//
//  Portable: Foundation and SwiftUI only (plus `SessionSyntaxHighlighter.swift`).
//

import AppKit
import Foundation
import SwiftUI

struct CodeLine: Equatable, Sendable {
    enum Mark: Equatable, Sendable {
        case context, added, removed
        /// `⋯ 12 unchanged lines` between hunks.
        case gap
        // GenesisTools adaptation: the line a `file:line` reference points at, tinted so it stands
        // out of the lines around it (the Inbox excerpt cards).
        case focus
    }

    var number: Int?
    var mark: Mark
    var text: String
}

struct CodeBlock: Equatable, Sendable {
    var lines: [CodeLine]
    var language: SyntaxLanguage
    /// Draw every line red: the output of a failed call.
    var failed = false

    var additions: Int { lines.filter { $0.mark == .added }.count }
    var removals: Int { lines.filter { $0.mark == .removed }.count }
    var isDiff: Bool { lines.contains { $0.mark == .added || $0.mark == .removed } }
}

// GenesisTools adaptation: hashed into `CodeBlockText`'s cache key.
extension CodeLine: Hashable {}
extension CodeBlock: Hashable {}

// MARK: - Builders

enum CodeBlockBuilder {
    /// Output or file content, numbered from `start`. A Read result that already carries
    /// `   12→` or `12\t` prefixes keeps those numbers instead.
    // GenesisTools adaptation: `focus` marks the line with that number (see `CodeLine.Mark.focus`).
    static func numbered(_ text: String, start: Int = 1, language: SyntaxLanguage, failed: Bool = false, focus: Int? = nil) -> CodeBlock {
        var body = text
        if body.hasSuffix("\n") { body.removeLast() }
        let raw = body.split(separator: "\n", omittingEmptySubsequences: false)
        var lines: [CodeLine] = []
        lines.reserveCapacity(raw.count)
        var readNumbers = !raw.isEmpty
        for line in raw.prefix(3) where readPrefix(line) == nil { readNumbers = false }
        for (offset, line) in raw.enumerated() {
            if readNumbers, let (number, rest) = readPrefix(line) {
                lines.append(CodeLine(number: number, mark: number == focus ? .focus : .context, text: rest))
            } else {
                lines.append(CodeLine(number: start + offset, mark: start + offset == focus ? .focus : .context, text: String(line)))
            }
        }
        return CodeBlock(lines: lines, language: language, failed: failed)
    }

    /// `   12→text` (Claude Read) or `12\ttext`.
    private static func readPrefix(_ line: Substring) -> (Int, String)? {
        let trimmed = line.drop { $0 == " " }
        let digits = trimmed.prefix { $0.isNumber }
        guard !digits.isEmpty, let number = Int(digits) else { return nil }
        let rest = trimmed.dropFirst(digits.count)
        if rest.hasPrefix("→") || rest.hasPrefix("\t") { return (number, String(rest.dropFirst())) }
        return nil
    }

    /// An Edit's replacement as a line diff. `start` is the line of `old` in the file when known.
    /// Unchanged runs longer than 6 lines fold into a gap line.
    static func edit(old: String, new: String, start: Int?, language: SyntaxLanguage) -> CodeBlock {
        let a = old.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        let b = new.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var lines: [CodeLine] = []
        var oldNumber = start ?? 1
        var newNumber = start ?? 1
        let numbered = start != nil
        for step in lineDiff(a, b) {
            switch step {
            case .same(let text):
                lines.append(CodeLine(number: numbered ? newNumber : nil, mark: .context, text: text))
                oldNumber += 1
                newNumber += 1
            case .removed(let text):
                lines.append(CodeLine(number: numbered ? oldNumber : nil, mark: .removed, text: text))
                oldNumber += 1
            case .added(let text):
                lines.append(CodeLine(number: numbered ? newNumber : nil, mark: .added, text: text))
                newNumber += 1
            }
        }
        return CodeBlock(lines: foldContext(lines, keep: 3), language: language)
    }

    /// Hunks of a unified diff (`git diff` output, one file or several). File headers are dropped;
    /// hunk headers become gap lines.
    static func unifiedDiff(_ text: String, language: SyntaxLanguage) -> CodeBlock {
        var lines: [CodeLine] = []
        var oldNumber = 0
        var newNumber = 0
        var inHunk = false
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if raw.hasPrefix("@@") {
                let numbers = hunkStarts(raw)
                oldNumber = numbers.old
                newNumber = numbers.new
                if !lines.isEmpty {
                    lines.append(CodeLine(number: nil, mark: .gap, text: String(raw.split(separator: "@", omittingEmptySubsequences: true).last ?? "").trimmingCharacters(in: .whitespaces)))
                }
                inHunk = true
                continue
            }
            guard inHunk else { continue }
            if raw.hasPrefix("diff --git") { inHunk = false; continue }
            if raw.hasPrefix("\\") { continue }
            if raw.hasPrefix("+") {
                lines.append(CodeLine(number: newNumber, mark: .added, text: String(raw.dropFirst())))
                newNumber += 1
            } else if raw.hasPrefix("-") {
                lines.append(CodeLine(number: oldNumber, mark: .removed, text: String(raw.dropFirst())))
                oldNumber += 1
            } else {
                lines.append(CodeLine(number: newNumber, mark: .context, text: String(raw.dropFirst())))
                oldNumber += 1
                newNumber += 1
            }
        }
        if lines.last?.mark == .context, lines.last?.text.isEmpty == true { lines.removeLast() }
        return CodeBlock(lines: lines, language: language)
    }

    /// `@@ -12,7 +12,9 @@` → (12, 12).
    private static func hunkStarts(_ header: Substring) -> (old: Int, new: Int) {
        let parts = header.split(separator: " ")
        func start(_ prefix: Character) -> Int {
            guard let part = parts.first(where: { $0.first == prefix }) else { return 1 }
            return Int(part.dropFirst().split(separator: ",").first ?? "") ?? 1
        }
        return (start("-"), start("+"))
    }

    /// A Codex `apply_patch` body: `*** Update File:` sections of `+` / `-` / ` ` lines.
    static func patch(_ text: String, language: SyntaxLanguage) -> CodeBlock {
        var lines: [CodeLine] = []
        for raw in text.split(separator: "\n", omittingEmptySubsequences: false) {
            if raw.hasPrefix("*** Begin Patch") || raw.hasPrefix("*** End Patch") { continue }
            if raw.hasPrefix("*** ") {
                lines.append(CodeLine(number: nil, mark: .gap, text: String(raw.dropFirst(4))))
            } else if raw.hasPrefix("@@") {
                lines.append(CodeLine(number: nil, mark: .gap, text: String(raw.dropFirst(2)).trimmingCharacters(in: .whitespaces)))
            } else if raw.hasPrefix("+") {
                lines.append(CodeLine(number: nil, mark: .added, text: String(raw.dropFirst())))
            } else if raw.hasPrefix("-") {
                lines.append(CodeLine(number: nil, mark: .removed, text: String(raw.dropFirst())))
            } else if !raw.isEmpty {
                lines.append(CodeLine(number: nil, mark: .context, text: String(raw.dropFirst())))
            }
        }
        return CodeBlock(lines: lines, language: language)
    }

    // MARK: Line diff

    enum Step: Equatable {
        case same(String), removed(String), added(String)
    }

    /// Longest-common-subsequence line diff. Past 400 × 400 lines it gives up on alignment and
    /// shows all removals, then all additions: still correct, only less tidy.
    static func lineDiff(_ a: [String], _ b: [String]) -> [Step] {
        guard a.count * b.count <= 160_000 else {
            return a.map(Step.removed) + b.map(Step.added)
        }
        let n = a.count
        let m = b.count
        var table = [[Int]](repeating: [Int](repeating: 0, count: m + 1), count: n + 1)
        for i in stride(from: n - 1, through: 0, by: -1) {
            for j in stride(from: m - 1, through: 0, by: -1) {
                table[i][j] = a[i] == b[j] ? table[i + 1][j + 1] + 1 : max(table[i + 1][j], table[i][j + 1])
            }
        }
        var steps: [Step] = []
        var i = 0
        var j = 0
        while i < n, j < m {
            if a[i] == b[j] {
                steps.append(.same(a[i]))
                i += 1
                j += 1
            } else if table[i + 1][j] >= table[i][j + 1] {
                steps.append(.removed(a[i]))
                i += 1
            } else {
                steps.append(.added(b[j]))
                j += 1
            }
        }
        steps += a[i...].map(Step.removed)
        steps += b[j...].map(Step.added)
        return steps
    }

    /// Keeps `keep` context lines around each change and folds the rest into gap lines.
    static func foldContext(_ lines: [CodeLine], keep: Int) -> [CodeLine] {
        let changed = lines.indices.filter { lines[$0].mark == .added || lines[$0].mark == .removed }
        guard !changed.isEmpty else { return lines }
        var visible = Set<Int>()
        for index in changed {
            for near in max(0, index - keep)...min(lines.count - 1, index + keep) { visible.insert(near) }
        }
        var out: [CodeLine] = []
        var hidden = 0
        for index in lines.indices {
            if visible.contains(index) {
                if hidden > 0 {
                    out.append(CodeLine(number: nil, mark: .gap, text: "\(hidden) unchanged line\(hidden == 1 ? "" : "s")"))
                    hidden = 0
                }
                out.append(lines[index])
            } else {
                hidden += 1
            }
        }
        if hidden > 0 { out.append(CodeLine(number: nil, mark: .gap, text: "\(hidden) unchanged line\(hidden == 1 ? "" : "s")")) }
        return out
    }
}

// MARK: - Rendering

enum CodeBlockRenderer {
    /// Lines past this many are never syntax-coloured, only drawn.
    static let highlightLimit = 1500
    /// Diff bands are padded to this many columns so a changed line reads as a full-width band.
    static let bandWidth = 96

    static let font = Font.system(size: 11.5, design: .monospaced)

    /// The first `limit` lines (all when nil): line numbers and diff marks in `gutter`, the code in
    /// `body`, line for line. Two strings, so selecting and copying the code never takes the numbers.
    static func attributed(_ block: CodeBlock, limit: Int?, highlight: Bool) -> CodeBlockAttributed {
        let lines = limit.map { Array(block.lines.prefix($0)) } ?? block.lines
        let width = String(lines.compactMap(\.number).max() ?? 0).count
        // GenesisTools adaptation: a focus line is banded like a diff line.
        let band = min(bandWidth, lines.filter { $0.mark == .added || $0.mark == .removed || $0.mark == .focus }.map { $0.text.count }.max() ?? 0)
        var highlighter = SyntaxHighlighter(language: highlight ? block.language : .plain)
        var gutter = AttributedString()
        var out = AttributedString()

        for (index, line) in lines.enumerated() {
            if index > 0 {
                gutter.append(AttributedString("\n"))
                out.append(AttributedString("\n"))
            }

            if line.mark == .gap {
                var dots = AttributedString(String(repeating: " ", count: max(width - 1, 0)) + "⋯" + (block.isDiff ? "  " : ""))
                dots.foregroundColor = SessionPalette.faint
                gutter.append(dots)
                var gap = AttributedString(line.text)
                gap.foregroundColor = SessionPalette.faint
                out.append(gap)
                continue
            }

            if width > 0 {
                let label = line.number.map(String.init) ?? ""
                var number = AttributedString(String(repeating: " ", count: width - label.count) + label)
                // GenesisTools adaptation: the focus line's number is drawn in the tint.
                number.foregroundColor = line.mark == .focus ? SessionPalette.blue : SessionPalette.faint
                gutter.append(number)
            }

            let background: Color?
            switch line.mark {
            case .added: background = SessionPalette.green.opacity(0.16)
            case .removed: background = SessionPalette.red.opacity(0.16)
            // GenesisTools adaptation: see `CodeLine.Mark.focus`.
            case .focus: background = SessionPalette.blue.opacity(0.16)
            default: background = nil
            }
            if block.isDiff {
                var mark = AttributedString(line.mark == .added ? " +" : line.mark == .removed ? " -" : "  ")
                mark.foregroundColor = line.mark == .added ? SessionPalette.green : line.mark == .removed ? SessionPalette.red : SessionPalette.faint
                gutter.append(mark)
            }

            var body = AttributedString()
            if block.failed {
                body = AttributedString(line.text)
                body.foregroundColor = SessionPalette.red.opacity(0.92)
            } else if highlight && index < highlightLimit {
                var cursor = line.text.unicodeScalars.startIndex
                for (token, length) in highlighter.runs(line.text) {
                    let end = line.text.unicodeScalars.index(cursor, offsetBy: length)
                    var piece = AttributedString(String(line.text.unicodeScalars[cursor..<end]))
                    piece.foregroundColor = token.color
                    body.append(piece)
                    cursor = end
                }
            } else {
                body = AttributedString(line.text)
                body.foregroundColor = SyntaxToken.plain.color
            }
            if let background {
                let pad = band - line.text.count
                if pad > 0 { body.append(AttributedString(String(repeating: " ", count: pad))) }
                body.backgroundColor = background
            }
            out.append(body)
        }
        return CodeBlockAttributed(gutter: gutter, body: out, hasGutter: width > 0 || block.isDiff)
    }
}

/// A rendered block: the non-selectable gutter column and the selectable code, line for line.
struct CodeBlockAttributed: Equatable, Sendable {
    var gutter: AttributedString
    var body: AttributedString
    var hasGutter: Bool
}

/// Memoised highlighted bodies, so a recycled row redraws without re-highlighting.
final class CodeBlockCache: @unchecked Sendable {
    static let shared = CodeBlockCache()

    private final class Box {
        let value: CodeBlockAttributed
        init(_ value: CodeBlockAttributed) { self.value = value }
    }

    private let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 300
        return cache
    }()

    func get(_ key: String) -> CodeBlockAttributed? { cache.object(forKey: key as NSString)?.value }
    func set(_ key: String, _ value: CodeBlockAttributed) { cache.setObject(Box(value), forKey: key as NSString) }
}

/// One code block: the gutter (line numbers, diff marks) in its own column, the code beside it as
/// one selectable `Text`, so a copy never carries the numbers. Lines do not wrap (a wrapped line
/// would start under the gutter and push every later number off its line); long lines scroll
/// sideways. Drawn plain at once, then replaced by the highlighted version computed off the main
/// thread.
struct CodeBlockText: View {
    let block: CodeBlock
    /// Lines to show; nil shows all.
    let limit: Int?
    /// Stable identity of the block's content (row id plus variant), for the cache.
    let cacheKey: String

    // GenesisTools adaptation: the key hashes the content and `highlighted` remembers its key. A row
    // keeps its id when the clipped result is replaced by the full one, often with the same line
    // count, and the old highlighted body used to stay on screen.
    @State private var highlighted: (key: String, value: CodeBlockAttributed)?

    // GenesisTools adaptation: the key hashes the content (see `highlighted`).
    private var key: String {
        var hasher = Hasher()
        hasher.combine(block)
        return "\(cacheKey)|\(limit.map(String.init) ?? "all")|\(block.lines.count)|\(hasher.finalize())"
    }

    var body: some View {
        // GenesisTools adaptation: a highlighted body counts only for its own key (see `highlighted`).
        let key = key
        let current = highlighted?.key == key ? highlighted?.value : nil
        let rendered = current ?? CodeBlockCache.shared.get(key) ?? CodeBlockRenderer.attributed(block, limit: limit, highlight: false)
        HStack(alignment: .top, spacing: 0) {
            if rendered.hasGutter {
                Text(rendered.gutter)
                    .font(CodeBlockRenderer.font)
                    .lineSpacing(1.5)
                    .fixedSize()
                    .padding(.trailing, 7)
                    .accessibilityHidden(true)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(rendered.body)
                    .font(CodeBlockRenderer.font)
                    .lineSpacing(1.5)
                    .textSelection(.enabled)
                    .fixedSize()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // GenesisTools adaptation: vertical wheel events over the block go to the list (upstream 9b6a354a).
        .background(VerticalWheelToEnclosingScroll())
            .task(id: key) {
                if let cached = CodeBlockCache.shared.get(key) {
                    // GenesisTools adaptation: `highlighted` remembers its key (see its declaration).
                    highlighted = (key, cached)
                    return
                }
                let block = block
                let limit = limit
                let result = await Task.detached(priority: .utility) {
                    CodeBlockRenderer.attributed(block, limit: limit, highlight: true)
                }.value
                guard !Task.isCancelled else { return }
                CodeBlockCache.shared.set(key, result)
                // GenesisTools adaptation: `highlighted` remembers its key (see its declaration).
                highlighted = (key, result)
            }
    }
}

// GenesisTools adaptation: taken from upstream 9b6a354a (Genesis), where the scroll bug was reported.
/// Hands vertical wheel scrolls over a code block to the list around it.
///
/// Each code block scrolls its long lines sideways in a horizontal `ScrollView`. On macOS that nested
/// scroll view takes EVERY wheel event while the pointer is over it, vertical ones included, so the
/// transcript stopped scrolling whenever the pointer rested on a tool output (Martin, 2026-09-25). This
/// view sits behind the block, watches the app's wheel events (a local monitor that returns the others
/// unchanged), and sends a mostly vertical one that lands inside its bounds to the nearest enclosing
/// scroll view, which is the transcript list: the horizontal scroller is a sibling, not an ancestor.
/// A mostly horizontal scroll still reaches the block.
struct VerticalWheelToEnclosingScroll: NSViewRepresentable {
    func makeNSView(context: Context) -> RouterView {
        RouterView()
    }

    func updateNSView(_ view: RouterView, context: Context) {}

    final class RouterView: NSView {
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                guard let self else { return event }
                return self.route(event) ? nil : event
            }
        }

        deinit {
            if let monitor {
                NSEvent.removeMonitor(monitor)
            }
        }

        /// True when the event went to the enclosing scroll view instead.
        private func route(_ event: NSEvent) -> Bool {
            guard event.window === window, !isHiddenOrHasHiddenAncestor,
                  abs(event.scrollingDeltaY) > abs(event.scrollingDeltaX),
                  bounds.contains(convert(event.locationInWindow, from: nil)),
                  let outer = enclosingScrollView
            else { return false }
            outer.scrollWheel(with: event)
            return true
        }

        /// Never takes a click or a hover meant for the text above it.
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
