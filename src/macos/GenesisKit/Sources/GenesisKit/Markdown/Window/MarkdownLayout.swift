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
    /// `changes` is the file's git diff (MarkdownChangesPane); the toolbar offers it only for a file in a repository.
    case preview, split, source, changes

    var showsEditor: Bool { self == .split || self == .source }
    var showsPreview: Bool { self == .preview || self == .split }

    var icon: String {
        switch self {
        case .preview: return "doc.richtext"
        case .split: return "rectangle.split.2x1"
        case .source: return "chevron.left.forwardslash.chevron.right"
        case .changes: return "plusminus"
        }
    }

    /// The mode's tooltip, with the key in force. The toolbar passes the keymap it observes, so a change redraws it.
    @MainActor func label(in keymap: Keymap) -> String {
        switch self {
        case .preview: return keymap.hint("Reading view", "markdown.view.source")
        case .split: return keymap.hint("Edit and preview side by side", "markdown.view.split")
        case .source: return keymap.hint("Source", "markdown.view.source")
        case .changes: return "The file's git changes: unstaged, staged, a commit, the branch"
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
    /// The git sidebar starts wider: a file row carries its folder and its age.
    static let gitStandard: Double = 280
    static let minimum: Double = 160
    static let maximum: Double = 560
    /// One arrow-key or VoiceOver step.
    static let keyboardStep: Double = 20

    static func clamped(_ width: Double, fallback: Double = standard) -> Double {
        guard width > 0 else { return fallback }
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
        /// The drag log (`logDrag`): where the divider was drawn when the drag began, the last pointer offset, the
        /// number of moves and the largest gap between the drawn divider and the pointer.
        private var drawnStartX: CGFloat = 0
        private var lastPointerDX: CGFloat = 0
        private var moves = 0
        private var largestGap: CGFloat = 0

        /// A window that is `isMovableByWindowBackground` (the viewer's was until 2026-10-14) drags itself from a
        /// view that does not claim its own mouse-down, instead of resizing.
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
            let lit = hot || focused
            let width: CGFloat = lit ? 3 : 1
            (lit ? accent : line).setFill()
            NSRect(x: (bounds.width - width) / 2, y: 0, width: width, height: bounds.height).fill()
        }

        override func mouseDown(with event: NSEvent) {
            if event.clickCount == 2 {
                onReset?()
                return
            }
            startX = event.locationInWindow.x
            drawnStartX = drawnX
            lastPointerDX = 0
            moves = 0
            largestGap = 0
            hot = true
            onBegin?()
        }

        override func mouseDragged(with event: NSEvent) {
            NSCursor.resizeLeftRight.set()
            // How far the divider drawn now is from where the previous move asked it to be.
            largestGap = max(largestGap, abs((drawnX - drawnStartX) - lastPointerDX))
            moves += 1
            lastPointerDX = event.locationInWindow.x - startX
            onDrag?(Double(lastPointerDX))
        }

        override func mouseUp(with event: NSEvent) {
            hot = bounds.contains(convert(event.locationInWindow, from: nil))
            onEnd?()
            logDrag(pointerDX: event.locationInWindow.x - startX)
        }

        /// The divider's middle in window coordinates.
        private var drawnX: CGFloat { convert(NSPoint(x: bounds.midX, y: 0), to: nil).x }

        /// One line per drag in the host's log, so a resize that felt "not 1:1" can be read afterwards (Martin,
        /// 2026-10-15: "pls just keep the logger for the resize so you can debug it later if i catch that again").
        /// The divider's travel is read after the window has laid out the last move; `overlays` is how far any
        /// AppKit overlay (the file tree's table) sits from its slot.
        private func logDrag(pointerDX: CGFloat) {
            guard moves > 0 else { return }
            window?.contentView?.layoutSubtreeIfNeeded()
            let dividerDX = drawnX - drawnStartX
            let overlays = (window?.contentView as? MarkdownWindowContentView)?.overlayDrift() ?? 0
            let line = String(format: "markdown: divider drag \"%@\": %d moves, pointer %+.0f pt, divider %+.0f pt, largest gap %.0f pt, overlay drift %.0f pt",
                              label, moves, Double(pointerDX), Double(dividerDX), Double(largestGap), Double(overlays))
            GenesisKit.log(line)
        }

        // MARK: keyboard and VoiceOver
        // A splitter the pointer alone can move is out of reach for anyone
        // on the keyboard: Tab focuses it (with keyboard navigation on), the
        // arrows move it, Return puts it back to even.

        /// Whether the keyboard moves focus between controls (System Settings › Keyboard › Keyboard navigation).
        /// A seam for tests.
        nonisolated(unsafe) static var keyboardNavigation: () -> Bool = { NSApp.isFullKeyboardAccessEnabled }

        // Tab focus only, and only with keyboard navigation on. A click that starts a drag must leave the editor
        // focused, or the next keystrokes reach the divider and are lost. Without keyboard navigation AppKit still
        // handed it focus when a tab switch removed the focused page, and its focus ring drew a 6 pt blue bar the
        // height of the window (2026-10-14).
        override var acceptsFirstResponder: Bool {
            Self.keyboardNavigation() && window?.currentEvent?.type != .leftMouseDown
        }
        override var canBecomeKeyView: Bool { Self.keyboardNavigation() }

        /// Focus shows as the accent line the pointer lights, not as a ring around the whole strip.
        private var focused = false { didSet { if focused != oldValue { needsDisplay = true } } }
        override var focusRingType: NSFocusRingType { get { .none } set {} }
        override func becomeFirstResponder() -> Bool {
            focused = true
            return true
        }
        override func resignFirstResponder() -> Bool {
            focused = false
            return true
        }

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
