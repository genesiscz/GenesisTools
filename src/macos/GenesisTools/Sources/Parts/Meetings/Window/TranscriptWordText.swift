import AppKit
import SwiftUI

/// Reports the selected UTF-16 range when a native text drag finishes.
struct TranscriptWordText: NSViewRepresentable {
    let text: String
    let color: NSColor
    let corrected: Bool
    var heardRange: NSRange? = nil
    let click: () -> Void
    let selected: (NSRange) -> Void

    func makeNSView(context: Context) -> TextView {
        let view = TextView()
        view.isEditable = false
        view.isSelectable = true
        view.delegate = view
        view.drawsBackground = false
        view.textContainerInset = .zero
        view.textContainer?.lineFragmentPadding = 0
        view.textContainer?.widthTracksTextView = true
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        updateNSView(view, context: context)
        return view
    }

    func updateNSView(_ view: TextView, context: Context) {
        view.click = click
        view.selected = selected
        if view.string != text { view.string = text }
        let range = NSRange(location: 0, length: (text as NSString).length)
        var attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13), .foregroundColor: color
        ]
        if corrected { attributes[.underlineStyle] = NSUnderlineStyle.patternDot.rawValue | NSUnderlineStyle.single.rawValue }
        view.textStorage?.addAttributes(attributes, range: range)
        if !corrected { view.textStorage?.removeAttribute(.underlineStyle, range: range) }
        view.highlightHeardRange(heardRange)
    }

    func sizeThatFits(_ proposal: ProposedViewSize, nsView: TextView, context: Context) -> CGSize? {
        guard let width = proposal.width, let container = nsView.textContainer, let layout = nsView.layoutManager else { return nil }
        container.containerSize = NSSize(width: max(1, width), height: .greatestFiniteMagnitude)
        layout.ensureLayout(for: container)
        return CGSize(width: width, height: max(16, ceil(layout.usedRect(for: container).height)))
    }

    final class TextView: NSTextView, NSTextViewDelegate {
        var click: (() -> Void)?
        var selected: ((NSRange) -> Void)?
        private var reportedRange: NSRange?

        func highlightHeardRange(_ heardRange: NSRange?) {
            let count = (string as NSString).length
            textStorage?.removeAttribute(.backgroundColor, range: NSRange(location: 0, length: count))
            setAccessibilityHelp(nil)
            guard let heardRange, heardRange.location >= 0, heardRange.length > 0,
                  heardRange.length <= count, heardRange.location <= count - heardRange.length else { return }
            textStorage?.addAttribute(.backgroundColor, value: NSColor.controlAccentColor.withAlphaComponent(0.3),
                                      range: heardRange)
            setAccessibilityHelp("Timed word: \((string as NSString).substring(with: heardRange))")
        }

        func textViewDidChangeSelection(_ notification: Notification) {
            if NSEvent.pressedMouseButtons == 0 { reportSelection() }
        }

        private func reportSelection() {
            let range = selectedRange()
            guard range.length > 0 else { reportedRange = nil; return }
            guard range != reportedRange else { return }
            reportedRange = range
            DispatchQueue.main.async { [weak self] in
                self?.selected?(range)
                self?.reportedRange = nil
            }
        }

        override func setSelectedRanges(_ ranges: [NSValue], affinity: NSSelectionAffinity, stillSelecting: Bool) {
            super.setSelectedRanges(ranges, affinity: affinity, stillSelecting: stillSelecting)
            if !stillSelecting { reportSelection() }
        }

        override func setSelectedRange(_ charRange: NSRange) {
            super.setSelectedRange(charRange)
            reportSelection()
        }

        override func mouseDown(with event: NSEvent) {
            reportedRange = nil
            if !event.modifierFlags.intersection([.command, .shift]).isEmpty {
                click?()
                return
            }
            super.mouseDown(with: event)
            let range = selectedRange()
            if range.length > 0 { reportSelection() } else { click?() }
        }

        override func keyDown(with event: NSEvent) {
            super.keyDown(with: event)
            reportSelection()
        }
    }
}
