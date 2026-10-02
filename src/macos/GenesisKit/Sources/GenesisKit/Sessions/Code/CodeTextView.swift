//
//  CodeTextView.swift
//
//  A code block's text drawn by AppKit instead of a SwiftUI `Text`. SwiftUI typeset and drew a whole
//  block's `Text` again on each layout pass of the transcript list; the hang samples of 2026-10-01 were
//  that (CTLineCreateWithAttributedString under ResolvedStyledText.StringDrawing.draw), and blanking the
//  code blocks took a Verbose first page from ~665 to ~410 ms of main thread. An `NSTextView` keeps its
//  layout between passes, lays out lazily and draws only what is on screen. Its size comes from the line
//  and column counts (`CodeBlockMetrics`), so nothing asks it to measure itself. Selection stays.
//

import AppKit
import SwiftUI

public enum CodeTextConversion {
    private static let font = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)

    private static let paragraph: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = CodeBlockMetrics.lineSpacing
        style.lineBreakMode = .byClipping
        return style
    }()

    /// Wrap mode: by word, as a SwiftUI `Text` wraps; a word longer than the row breaks inside.
    private static let wrappingParagraph: NSParagraphStyle = {
        let style = NSMutableParagraphStyle()
        style.lineSpacing = CodeBlockMetrics.lineSpacing
        style.lineBreakMode = .byWordWrapping
        return style
    }()

    /// The SwiftUI colours the renderer sets (foreground, background) as AppKit attributes.
    public static func appKit(_ text: AttributedString, wrapping: Bool = false) -> NSAttributedString {
        let out = NSMutableAttributedString(string: String(text.characters), attributes: [
            .font: font,
            .paragraphStyle: wrapping ? wrappingParagraph : paragraph,
            .foregroundColor: NSColor(SessionPalette.text),
        ])
        var offset = 0
        for run in text.runs {
            let length = String(text[run.range].characters).utf16.count
            let range = NSRange(location: offset, length: length)
            if let color = run.foregroundColor {
                out.addAttribute(.foregroundColor, value: NSColor(color), range: range)
            }
            if let color = run.backgroundColor {
                out.addAttribute(.backgroundColor, value: NSColor(color), range: range)
            }
            offset += length
        }
        return out
    }
}

/// One block's code (or gutter) as a selectable, non-editable, non-wrapping `NSTextView`. `key` names the
/// content: the text storage is replaced only when it changes, never on a plain re-render.
struct CodeTextView: NSViewRepresentable {
    let key: String
    let text: () -> NSAttributedString
    var selectable = true

    final class Coordinator {
        var key = ""
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView(usingTextLayoutManager: false)
        view.isEditable = false
        view.isSelectable = selectable
        view.drawsBackground = false
        view.isRichText = true
        view.textContainerInset = .zero
        view.isHorizontallyResizable = false
        view.isVerticallyResizable = false
        if let container = view.textContainer {
            container.lineFragmentPadding = 0
            container.widthTracksTextView = false
            container.heightTracksTextView = false
            container.containerSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        }
        view.layoutManager?.allowsNonContiguousLayout = true
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        guard context.coordinator.key != key else { return }
        context.coordinator.key = key
        RenderProbe.hit("codeText.store")
        view.textStorage?.setAttributedString(text())
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: NSTextView, context: Context) -> CGSize? {
        // The caller sizes it from `CodeBlockMetrics`; never ask TextKit for a size.
        CGSize(width: proposal.width ?? 0, height: proposal.height ?? 0)
    }
}

// MARK: - Wrap mode

/// Wrap mode's code: ONE AppKit text view that wraps at the row's width, and a gutter that draws each line
/// number beside the first row of its line. The SwiftUI version was a `Text` per line (up to
/// `CodeBlockRenderer.firstDrawLimit`) in an `HStack` beside its number, laid out again on every pass of
/// the transcript list: with both wraps on, opening four sessions cost 370 to 485 ms more than without
/// wrapping (hub bench `open`, 2026-10-02). The height for a width is measured once by TextKit and
/// remembered until the width or the text changes. `GENESIS_CODE_WRAP_SWIFTUI=1` brings the SwiftUI
/// version back, for A/B runs.
struct WrappedCodeTextView: NSViewRepresentable {
    let key: String
    /// One line per line of `body`; nil without a gutter.
    let gutter: () -> NSAttributedString?
    let body: () -> NSAttributedString
    let gutterWidth: CGFloat
    /// The block unwrapped (`CodeBlockMetrics`): the answer to an open-ended width, with no text layout.
    let ideal: CGSize

    static let usesSwiftUI = ProcessInfo.processInfo.environment["GENESIS_CODE_WRAP_SWIFTUI"] == "1"

    final class Coordinator {
        var key = ""
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WrappedCodeContainer {
        WrappedCodeContainer()
    }

    func updateNSView(_ view: WrappedCodeContainer, context: Context) {
        guard context.coordinator.key != key else { return }
        context.coordinator.key = key
        RenderProbe.hit("codeText.wrapStore")
        view.set(gutter: gutter(), body: body(), gutterWidth: gutterWidth)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: WrappedCodeContainer, context: Context) -> CGSize? {
        // Before the first update the view holds no text: the row asks again once it does.
        if context.coordinator.key != key {
            updateNSView(nsView, context: context)
        }
        // SwiftUI also asks for the ideal size (a nil or infinite width) and the minimum (0): those are
        // answered from the line and column counts. Laying the text out for each of them is what made the
        // first version of this view slower than the SwiftUI rows.
        guard let width = proposal.width, width.isFinite, width > 1 else {
            return ideal
        }
        return CGSize(width: width, height: nsView.height(forWidth: width))
    }
}

final class WrappedCodeContainer: NSView {
    private let storage = NSTextStorage()
    private let layoutManager = NSLayoutManager()
    private let container = NSTextContainer(size: NSSize(width: 100, height: CGFloat.greatestFiniteMagnitude))
    private let textView: NSTextView
    private let gutterView = CodeGutterView()
    private var gutterWidth: CGFloat = 0
    private static let gutterGap: CGFloat = 7
    /// Heights by width (rounded), so a layout pass that asks again at the same widths lays nothing out.
    private var heights: [Int: CGFloat] = [:]
    /// The width TextKit's layout is for now: the line starts belong to it.
    private var laidOut: CGFloat = -1

    override var isFlipped: Bool { true }

    init() {
        storage.addLayoutManager(layoutManager)
        container.lineFragmentPadding = 0
        container.widthTracksTextView = false
        container.heightTracksTextView = false
        layoutManager.addTextContainer(container)
        textView = NSTextView(frame: .zero, textContainer: container)
        textView.isEditable = false
        textView.isSelectable = true
        textView.drawsBackground = false
        textView.isRichText = true
        textView.textContainerInset = .zero
        textView.isHorizontallyResizable = false
        textView.isVerticallyResizable = false
        super.init(frame: .zero)
        addSubview(gutterView)
        addSubview(textView)
    }

    required init?(coder: NSCoder) { fatalError("not supported") }

    func set(gutter: NSAttributedString?, body: NSAttributedString, gutterWidth: CGFloat) {
        storage.setAttributedString(body)
        gutterView.lines = gutter.map(Self.split) ?? []
        self.gutterWidth = gutter == nil ? 0 : gutterWidth
        heights = [:]
        laidOut = -1
        needsLayout = true
        gutterView.needsDisplay = true
    }

    private var textX: CGFloat { gutterWidth > 0 ? gutterWidth + Self.gutterGap : 0 }

    /// TextKit's height at this width, once per width and text.
    func height(forWidth width: CGFloat) -> CGFloat {
        let key = Int(width.rounded())
        if let known = heights[key] {
            return known
        }
        let height = layOut(width)
        heights[key] = height
        return height
    }

    private func layOut(_ width: CGFloat) -> CGFloat {
        let textWidth = max(20, width - textX)
        container.size = NSSize(width: textWidth, height: CGFloat.greatestFiniteMagnitude)
        layoutManager.ensureLayout(for: container)
        laidOut = width
        gutterView.starts = lineStarts()
        gutterView.needsDisplay = true
        return ceil(layoutManager.usedRect(for: container).height)
    }

    override func layout() {
        super.layout()
        if abs(laidOut - bounds.width) > 0.5 {
            heights[Int(bounds.width.rounded())] = layOut(bounds.width)
        }
        gutterView.frame = NSRect(x: 0, y: 0, width: gutterWidth, height: bounds.height)
        textView.frame = NSRect(x: textX, y: 0, width: max(20, bounds.width - textX), height: bounds.height)
    }

    /// The top of each line's first row, in order: where its number goes.
    private func lineStarts() -> [CGFloat] {
        let text = storage.string as NSString
        var starts: [CGFloat] = []
        starts.reserveCapacity(gutterView.lines.count)
        var location = 0
        while starts.count < gutterView.lines.count, location <= text.length {
            if location == text.length {
                // An empty last line (after a final newline, or an empty text) is the extra line fragment.
                let extra = layoutManager.extraLineFragmentRect
                starts.append(extra.isEmpty ? (starts.last ?? 0) : extra.minY)
                break
            }
            let glyph = layoutManager.glyphIndexForCharacter(at: location)
            starts.append(layoutManager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY)
            let newline = text.range(of: "\n", options: [], range: NSRange(location: location, length: text.length - location))
            guard newline.location != NSNotFound else { break }
            location = newline.location + 1
        }
        return starts
    }

    private static func split(_ text: NSAttributedString) -> [NSAttributedString] {
        let string = text.string as NSString
        var lines: [NSAttributedString] = []
        var start = 0
        while start <= string.length {
            let range = string.range(of: "\n", options: [], range: NSRange(location: start, length: string.length - start))
            let end = range.location == NSNotFound ? string.length : range.location
            lines.append(text.attributedSubstring(from: NSRange(location: start, length: end - start)))
            if range.location == NSNotFound { break }
            start = end + 1
        }
        return lines
    }
}

/// The line numbers of a wrapped block, each at the top of its line's first row. Draws only the numbers
/// in the dirty rect; never selectable.
final class CodeGutterView: NSView {
    var lines: [NSAttributedString] = []
    var starts: [CGFloat] = []

    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        let count = min(lines.count, starts.count)
        guard count > 0 else { return }
        // The first line whose top is at or past the dirty rect, less one (a line that starts above it can reach in).
        var low = 0
        var high = count
        while low < high {
            let mid = (low + high) / 2
            if starts[mid] < dirtyRect.minY { low = mid + 1 } else { high = mid }
        }
        var index = max(0, low - 1)
        while index < count, starts[index] <= dirtyRect.maxY {
            lines[index].draw(at: NSPoint(x: 0, y: starts[index]))
            index += 1
        }
    }
}
