//
//  MarkdownLayout.swift
//  GenesisKit
//
//  The window's layout pieces: panes, view modes, the split and its divider, the sidebar width, the zoom.
//

import AppKit
import Combine
import SwiftUI
import UniformTypeIdentifiers

/// The two scrollers a document has: the rendered page and the editor.
enum MarkdownPane: String {
    case preview, source
}

/// What the pane shows: the rendered document, the raw source, or both side by
/// side with the editor on the left.
enum MarkdownViewMode: String, CaseIterable {
    case preview, split, source

    var showsEditor: Bool { self != .preview }
    var showsPreview: Bool { self != .source }

    var icon: String {
        switch self {
        case .preview: return "doc.richtext"
        case .split: return "rectangle.split.2x1"
        case .source: return "chevron.left.forwardslash.chevron.right"
        }
    }

    var label: String {
        switch self {
        case .preview: return "Reading view (⌘E)"
        case .split: return "Edit and preview side by side (⇧⌘E)"
        case .source: return "Source (⌘E)"
        }
    }
}

/// Where the divider sits in split view. Both panes keep a usable width, so
/// dragging to the edge parks the divider rather than collapsing a pane.
enum MarkdownSplit {
    static let minPane: Double = 300
    static let defaultRatio: Double = 0.5
    /// The grab strip between the panes. A hairline is impossible to hit, so
    /// the divider takes real width and draws the line down its middle.
    static let dividerWidth: Double = 10

    /// The editor's width for a pane of `total` points.
    static func editorWidth(total: Double, ratio: Double) -> Double {
        guard total > 2 * minPane else { return (total / 2).rounded() }
        return (min(max(total * ratio, minPane), total - minPane)).rounded()
    }

    /// What the preview gets: everything the editor and the divider leave.
    /// Derived rather than `maxWidth: .infinity` so the preview's own content
    /// never takes part in deciding the width.
    static func previewWidth(total: Double, ratio: Double) -> Double {
        max(0, total - editorWidth(total: total, ratio: ratio) - dividerWidth)
    }

    /// The ratio a divider dropped at `x` means, clamped to the same limits.
    static func ratio(x: Double, total: Double) -> Double {
        guard draggable(total: total) else { return defaultRatio }
        return min(max(x, minPane), total - minPane) / total
    }

    /// The ratio after moving the divider `dx` points from where it was drawn
    /// at `start`. It starts from the displayed (clamped) width, not from the
    /// remembered ratio: after the window narrows, those differ, and a drag
    /// computed from the ratio would not move until the pointer caught up.
    static func ratio(afterMoving dx: Double, from start: Double, total: Double) -> Double {
        ratio(x: editorWidth(total: total, ratio: start) + dx, total: total)
    }

    /// One arrow-key or VoiceOver step of the divider.
    static let keyboardStep: Double = 40

    /// Whether a pane of this width has room for two. A narrower one shows an
    /// even split, and a drag inside it must NOT be written back: it would
    /// replace the reader's remembered ratio with that forced 0.5.
    static func draggable(total: Double) -> Bool { total > 2 * minPane }
}

/// How wide the file sidebar may be. A stored 0 (never dragged) or a hand-edited value lands on the standard width.
enum MarkdownSidebarWidth {
    static let standard: Double = 230
    static let minimum: Double = 160
    static let maximum: Double = 560
    /// One arrow-key or VoiceOver step.
    static let keyboardStep: Double = 20

    static func clamped(_ width: Double) -> Double {
        guard width > 0 else { return standard }
        return min(max(width, minimum), maximum)
    }
}

/// The draggable boundary between the editor and the preview.
///
/// AppKit rather than SwiftUI on purpose. A SwiftUI `onHover` + `NSCursor.push`
/// misses the cursor change often, and an overlay strip over a hairline loses
/// its clicks to the neighbouring `NSTextView`, which is a real AppKit view and
/// wins hit testing. A view with its own tracking area, `cursorUpdate` and
/// mouse handling behaves the way a split divider is supposed to.
struct MarkdownSplitDivider: NSViewRepresentable {
    var line: NSColor
    var accent: NSColor
    /// Mouse went down: remember where the divider was.
    var onBegin: () -> Void
    /// Points moved since that mouse-down, in window coordinates (stable while
    /// the divider itself moves under the pointer).
    var onDrag: (Double) -> Void
    var onEnd: () -> Void
    /// Double click: back to an even split.
    var onReset: () -> Void
    /// Arrow keys and VoiceOver increment/decrement: -1 left, +1 right.
    var onStep: (Int) -> Void = { _ in }
    /// The editor's share, spoken as the divider's value.
    var ratio: Double = MarkdownSplit.defaultRatio
    var label = "Editor and preview divider"
    /// Replaces the spoken "Editor N percent" when the divider is not the editor/preview one.
    var valueText: String?

    func makeNSView(context: Context) -> DividerView {
        let view = DividerView()
        apply(view)
        return view
    }

    func updateNSView(_ view: DividerView, context: Context) {
        apply(view)
        view.needsDisplay = true
    }

    private func apply(_ view: DividerView) {
        view.line = line
        view.accent = accent
        view.onBegin = onBegin
        view.onDrag = onDrag
        view.onEnd = onEnd
        view.onReset = onReset
        view.onStep = onStep
        view.ratio = ratio
        view.label = label
        view.valueText = valueText
    }

    final class DividerView: NSView {
        var line: NSColor = .separatorColor
        var accent: NSColor = .controlAccentColor
        var onBegin: (() -> Void)?
        var onDrag: ((Double) -> Void)?
        var onEnd: (() -> Void)?
        var onReset: (() -> Void)?
        var onStep: ((Int) -> Void)?
        var ratio: Double = MarkdownSplit.defaultRatio
        var label = "Editor and preview divider"
        var valueText: String?

        private var hot = false { didSet { if hot != oldValue { needsDisplay = true } } }
        private var startX: CGFloat = 0
        private var area: NSTrackingArea?

        /// The window is `isMovableByWindowBackground`, so a view that does not
        /// claim its own mouse-down drags the whole window instead of resizing.
        override var mouseDownCanMoveWindow: Bool { false }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area { removeTrackingArea(area) }
            let new = NSTrackingArea(
                rect: .zero,
                options: [.mouseEnteredAndExited, .cursorUpdate, .activeInActiveApp, .inVisibleRect],
                owner: self
            )
            addTrackingArea(new)
            area = new
        }

        // Both routes to the same cursor: the tracking area answers while the
        // pointer moves, the cursor rect answers after a scroll or a resize.
        override func cursorUpdate(with event: NSEvent) { NSCursor.resizeLeftRight.set() }
        override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeLeftRight) }

        override func mouseEntered(with event: NSEvent) {
            hot = true
            NSCursor.resizeLeftRight.set()
        }

        override func mouseExited(with event: NSEvent) {
            hot = false
            NSCursor.arrow.set()
        }

        /// A mode switch can remove the divider while the pointer sits on it,
        /// and then `mouseExited` never comes. Put the arrow back by hand.
        override func viewWillMove(toWindow newWindow: NSWindow?) {
            super.viewWillMove(toWindow: newWindow)
            if newWindow == nil, hot {
                hot = false
                NSCursor.arrow.set()
            }
        }

        override func draw(_ dirtyRect: NSRect) {
            let width: CGFloat = hot ? 3 : 1
            (hot ? accent : line).setFill()
            NSRect(x: (bounds.width - width) / 2, y: 0, width: width, height: bounds.height).fill()
        }

        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                onReset?()
                return
            }
            startX = event.locationInWindow.x
            hot = true
            onBegin?()
        }

        override func mouseDragged(with event: NSEvent) {
            NSCursor.resizeLeftRight.set()
            onDrag?(Double(event.locationInWindow.x - startX))
        }

        override func mouseUp(with event: NSEvent) {
            hot = bounds.contains(convert(event.locationInWindow, from: nil))
            onEnd?()
        }

        // MARK: keyboard and VoiceOver
        // A splitter the pointer alone can move is out of reach for anyone
        // on the keyboard: Tab focuses it (with keyboard navigation on), the
        // arrows move it, Return puts it back to even.

        // Tab focus only. A click that starts a drag must leave the editor
        // focused, or the next keystrokes reach the divider and are lost.
        override var acceptsFirstResponder: Bool {
            window?.currentEvent?.type != .leftMouseDown
        }
        override var canBecomeKeyView: Bool { true }
        override var focusRingMaskBounds: NSRect { bounds }
        override func drawFocusRingMask() { bounds.fill() }

        override func keyDown(with event: NSEvent) {
            switch event.keyCode {
            case 123: onStep?(-1)                 // left arrow
            case 124: onStep?(1)                  // right arrow
            case 36, 76: onReset?()               // return, enter
            default: super.keyDown(with: event)
            }
        }

        override func isAccessibilityElement() -> Bool { true }
        override func accessibilityRole() -> NSAccessibility.Role? { .splitter }
        override func accessibilityLabel() -> String? { label }
        override func accessibilityValue() -> Any? { valueText ?? "Editor \(Int((ratio * 100).rounded())) percent" }
        override func accessibilityHelp() -> String? {
            "Left and right arrows move the divider, Return resets it to an even split."
        }
        override func accessibilityPerformIncrement() -> Bool {
            onStep?(1)
            return true
        }
        override func accessibilityPerformDecrement() -> Bool {
            onStep?(-1)
            return true
        }
    }
}

/// Reading size, as a fixed ladder rather than a multiplier, so ⌘+ and ⌘- always
/// land on a size that was designed to be readable.
enum MarkdownZoom {
    static let steps: [Double] = [0.7, 0.8, 0.9, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0]
    static let base: Double = 1.0

    /// The next rung in `direction` (+1 bigger, -1 smaller), clamped at the ends.
    /// An off-ladder value (an older build, a hand-edited default) snaps to the
    /// nearest rung first.
    static func step(from zoom: Double, direction: Int) -> Double {
        let nearest = steps.enumerated().min { abs($0.element - zoom) < abs($1.element - zoom) }?.offset ?? 3
        let index = min(max(nearest + direction, 0), steps.count - 1)
        return steps[index]
    }

    static func percent(_ zoom: Double) -> String {
        "\(Int((zoom * 100).rounded()))%"
    }
}
