import AppKit
import SwiftUI

/// Tracks in screen coordinates because the receiving window moves during the gesture.
struct ScreenVerticalDragArea: NSViewRepresentable {
    var moved: (CGFloat, Bool) -> Void

    func makeNSView(context: Context) -> ScreenVerticalDragView {
        let view = ScreenVerticalDragView()
        view.moved = moved
        return view
    }

    func updateNSView(_ view: ScreenVerticalDragView, context: Context) { view.moved = moved }
}

final class ScreenVerticalDragView: NSView {
    var moved: ((CGFloat, Bool) -> Void)?
    var pointer: (NSEvent) -> CGPoint = { event in
        guard let point = event.cgEvent?.location else { return NSEvent.mouseLocation }
        return CGPoint(x: point.x, y: -point.y)
    }
    private var origin: CGPoint?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.handle)
        setAccessibilityIdentifier("widget.drag")
        setAccessibilityLabel("Drag widgets vertically")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeUpDown) }

    override func mouseDown(with event: NSEvent) {
        origin = pointer(event)
        moved?(0, false)
    }

    override func mouseDragged(with event: NSEvent) { report(event, finished: false) }
    override func mouseUp(with event: NSEvent) { report(event, finished: true) }

    private func report(_ event: NSEvent, finished: Bool) {
        guard let origin else { return }
        moved?(origin.y - pointer(event).y, finished)
        if finished { self.origin = nil }
    }
}
