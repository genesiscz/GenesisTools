import AppKit
import SwiftUI

/// A drag area that moves its window. It tracks the drag itself from each event's location: `performDrag(with:)`
/// moved a non-activating panel only on the first drag of a show (ux ledger, 2026-10-14), and
/// `isMovableByWindowBackground` never sees a click that SwiftUI content or a gesture takes first.
/// Put it behind the content and turn off hit testing on the content's labels, so the empty parts and the text move
/// the window while the buttons keep their clicks.
struct PanelDragArea: NSViewRepresentable {
    var identifier: String
    var label: String
    var dragged: () -> Void = {}
    /// A double click on the area. SwiftUI's own double-tap gesture never sees a click this view takes.
    var doubleClicked: (() -> Void)?

    func makeNSView(context: Context) -> PanelDragView {
        let view = PanelDragView()
        view.setAccessibilityIdentifier(identifier)
        view.setAccessibilityLabel(label)
        update(view)
        return view
    }

    func updateNSView(_ view: PanelDragView, context: Context) { update(view) }

    private func update(_ view: PanelDragView) {
        view.dragged = dragged
        view.doubleClicked = doubleClicked
    }
}

final class PanelDragView: NSView {
    var dragged: (() -> Void)?
    var doubleClicked: (() -> Void)?
    private var last: CGPoint?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.handle)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: last == nil ? .openHand : .closedHand) }

    /// Global CoreGraphics points (y down), from the event itself, so a drag delivered in the background moves it too.
    private func location(_ event: NSEvent) -> CGPoint {
        event.cgEvent?.location ?? CGPoint(x: NSEvent.mouseLocation.x, y: -NSEvent.mouseLocation.y)
    }

    override func mouseDown(with event: NSEvent) {
        if event.clickCount == 2, let doubleClicked {
            doubleClicked()
            return
        }
        last = location(event)
        window?.invalidateCursorRects(for: self)
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let last else { return }
        let point = location(event)
        window.setFrameOrigin(CGPoint(x: window.frame.minX + point.x - last.x, y: window.frame.minY - (point.y - last.y)))
        self.last = point
        dragged?()
    }

    override func mouseUp(with event: NSEvent) {
        last = nil
        window?.invalidateCursorRects(for: self)
    }
}
