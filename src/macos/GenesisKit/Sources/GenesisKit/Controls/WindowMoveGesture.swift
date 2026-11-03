import AppKit
import SwiftUI

extension View {
    /// A drag on this view moves its window. A SwiftUI gesture, so a control in front of the view keeps its own clicks:
    /// an AppKit drag view behind the content took a button's double click too (2026-11-03), and
    /// `isMovableByWindowBackground` never sees a click that a SwiftUI gesture takes first. Put it on a card's
    /// background and turn off hit testing on the labels in front, so they drag as well.
    func movesWindowOnDrag() -> some View {
        modifier(WindowMoveGesture())
    }
}

private struct WindowMoveGesture: ViewModifier {
    @State private var window = WeakWindow()
    @State private var start: (pointer: CGPoint, origin: CGPoint)?

    func body(content: Content) -> some View {
        content
            .background(WindowReader(box: window))
            .gesture(DragGesture(minimumDistance: 2)
                .onChanged { _ in
                    guard let panel = window.value else { return }
                    // Screen points from the pointer itself: the gesture's own coordinates move with the window.
                    let pointer = NSEvent.mouseLocation
                    let from = start ?? (pointer, panel.frame.origin)
                    start = from
                    panel.setFrameOrigin(CGPoint(x: from.origin.x + pointer.x - from.pointer.x,
                                                 y: from.origin.y + pointer.y - from.pointer.y))
                }
                .onEnded { _ in start = nil })
    }
}

private final class WeakWindow {
    weak var value: NSWindow?
}

/// Finds the hosting window. It takes no clicks.
private struct WindowReader: NSViewRepresentable {
    let box: WeakWindow

    func makeNSView(context: Context) -> ReaderView {
        let view = ReaderView()
        view.box = box
        return view
    }

    func updateNSView(_ view: ReaderView, context: Context) { view.box = box }

    final class ReaderView: NSView {
        var box: WeakWindow? {
            didSet { box?.value = window }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            box?.value = window
        }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }
    }
}
