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
    var pointer: () -> CGPoint = { NSEvent.mouseLocation }
    private var origin: CGPoint?

    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(true)
        setAccessibilityRole(.handle)
        setAccessibilityLabel("Drag widgets vertically")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }
    override var mouseDownCanMoveWindow: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .resizeUpDown) }

    override func mouseDown(with event: NSEvent) {
        origin = pointer()
        moved?(0, false)
    }

    override func mouseDragged(with event: NSEvent) { report(finished: false) }
    override func mouseUp(with event: NSEvent) { report(finished: true) }

    private func report(finished: Bool) {
        guard let origin else { return }
        moved?(origin.y - pointer().y, finished)
        if finished { self.origin = nil }
    }
}
