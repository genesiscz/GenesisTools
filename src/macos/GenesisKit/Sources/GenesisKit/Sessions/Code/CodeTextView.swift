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

    /// The SwiftUI colours the renderer sets (foreground, background) as AppKit attributes.
    public static func appKit(_ text: AttributedString) -> NSAttributedString {
        let out = NSMutableAttributedString(string: String(text.characters), attributes: [
            .font: font,
            .paragraphStyle: paragraph,
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
