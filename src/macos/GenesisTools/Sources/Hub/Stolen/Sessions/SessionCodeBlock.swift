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
        // Once per block: `isDiff` walks every line, and it used to run for every line drawn.
        let isDiff = block.isDiff
        var highlighter = SyntaxHighlighter(language: highlight ? block.language : .plain)
        var gutter = AttributedString()
        var out = AttributedString()

        for (index, line) in lines.enumerated() {
            if index > 0 {
                gutter.append(AttributedString("\n"))
                out.append(AttributedString("\n"))
            }

            if line.mark == .gap {
                var dots = AttributedString(String(repeating: " ", count: max(width - 1, 0)) + "⋯" + (isDiff ? "  " : ""))
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
            if isDiff {
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
        return CodeBlockAttributed(gutter: gutter, body: out, hasGutter: width > 0 || isDiff)
    }
}

/// A rendered block: the non-selectable gutter column and the selectable code, line for line.
struct CodeBlockAttributed: Equatable, Sendable {
    var gutter: AttributedString
    var body: AttributedString
    var hasGutter: Bool
}

/// Memoised highlighted bodies, so a recycled row redraws without re-highlighting. Sized for a long
/// session at "Inputs + output": 300 entries was fewer than the outputs and inputs of 150 turns, so
/// scrolling back evicted what the way down had just highlighted.
final class CodeBlockCache: @unchecked Sendable {
    static let shared = CodeBlockCache()

    private final class Box {
        let value: CodeBlockAttributed
        init(_ value: CodeBlockAttributed) { self.value = value }
    }

    private let cache: NSCache<NSString, Box> = {
        let cache = NSCache<NSString, Box>()
        cache.countLimit = 1500
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
///
/// Sideways scrolling is an offset that `SidewaysWheel` moves, not a nested horizontal `ScrollView`.
/// On macOS that scroll view took every wheel event over it, vertical ones included, so the
/// transcript stopped scrolling under the pointer (2026-09-25), and each row that came into view had
/// to build a scroll view, a clip view and a document view for it.
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
    /// How far the code is scrolled sideways.
    @State private var sideways: CGFloat = 0
    /// How wide the code is. A box, not a value: measuring it must not draw the block again.
    @State private var codeWidth = SidewaysWheel.Width()

    // GenesisTools adaptation: the key hashes the content (see `highlighted`): the shown lines only,
    // because nothing past `limit` is drawn, and hashing a whole long output on every body was the
    // bigger part of it.
    private var key: String {
        var hasher = Hasher()
        hasher.combine(block.language)
        hasher.combine(block.failed)
        hasher.combine(block.isDiff)
        for line in limit.map({ block.lines.prefix($0) }) ?? block.lines[...] {
            hasher.combine(line)
        }
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
            Text(rendered.body)
                .font(CodeBlockRenderer.font)
                .lineSpacing(1.5)
                .textSelection(.enabled)
                .fixedSize()
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { codeWidth.value = $0 }
                .offset(x: -sideways)
                // `minWidth: 0` makes the frame as wide as the row gives, not as wide as the code.
                .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
                .clipped()
                .overlay(SidewaysWheel(offset: $sideways, contentWidth: codeWidth))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
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

/// Takes the scroll wheel over a code block, and only the wheel. A mostly sideways gesture moves the
/// code (`offset`); anything else goes up the responder chain to the transcript's own scroll view,
/// which scrolls exactly as it does over any other row (momentum, responsive scrolling). No event
/// monitor: the previous fix watched every wheel event of the app from every code block on screen
/// and re-sent them to the list by hand, which split each gesture between two scroll views.
///
/// Clicks, drags and hovers fall through to the text, because `hitTest` answers only while a wheel
/// event is being delivered. The axis is chosen once per gesture, from its first event that moves.
struct SidewaysWheel: NSViewRepresentable {
    /// The width of the code, written by its layout and read on each wheel event.
    final class Width {
        var value: CGFloat = 0
    }

    @Binding var offset: CGFloat
    let contentWidth: Width

    func makeNSView(context: Context) -> WheelView {
        let view = WheelView()
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: WheelView, context: Context) {
        view.width = contentWidth
        view.offset = offset
        let binding = $offset
        view.onScroll = { binding.wrappedValue = $0 }
    }

    final class WheelView: NSView {
        var width: Width?
        var offset: CGFloat = 0
        var onScroll: ((CGFloat) -> Void)?
        /// The current gesture's axis; nil until one of its events moves.
        private var sideways: Bool?

        var contentWidth: CGFloat { width?.value ?? 0 }

        override func hitTest(_ point: NSPoint) -> NSView? {
            guard NSApp.currentEvent?.type == .scrollWheel else { return nil }
            return super.hitTest(point)
        }

        override func scrollWheel(with event: NSEvent) {
            if event.phase.contains(.began) || event.phase.contains(.mayBegin) {
                sideways = nil
            }
            // A mouse wheel has no gestures: each notch decides for itself.
            let notch = event.phase.isEmpty && event.momentumPhase.isEmpty
            if notch || sideways == nil, event.scrollingDeltaX != 0 || event.scrollingDeltaY != 0 {
                sideways = abs(event.scrollingDeltaX) > abs(event.scrollingDeltaY) && contentWidth > bounds.width
            }
            guard sideways == true else {
                super.scrollWheel(with: event)
                return
            }
            let delta = event.hasPreciseScrollingDeltas ? event.scrollingDeltaX : event.scrollingDeltaX * 12
            let next = min(max(offset - delta, 0), max(contentWidth - bounds.width, 0))
            guard next != offset else { return }
            offset = next
            onScroll?(next)
        }
    }
}
