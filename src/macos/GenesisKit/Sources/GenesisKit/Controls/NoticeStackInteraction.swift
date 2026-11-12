import AppKit
import SwiftUI

/// Tracks the actual bounds after layout as well as mouse and key-window changes. A view shrinking under
/// a stationary pointer must release its pause even when SwiftUI sends no hover-exit callback.
struct NoticeStackInteractionProbe: NSViewRepresentable {
    let model: NoticeStackModel
    let passScroll: Bool

    func makeNSView(context: Context) -> NoticeStackInteractionView {
        let view = NoticeStackInteractionView()
        view.model = model
        view.passScroll = passScroll
        return view
    }

    func updateNSView(_ view: NoticeStackInteractionView, context: Context) {
        view.model = model
        view.passScroll = passScroll
        view.scheduleRefresh()
    }
}

final class NoticeStackInteractionView: NSView {
    weak var model: NoticeStackModel?
    var passScroll = false
    var pointerLocation: () -> NSPoint = { NSEvent.mouseLocation }
    private var wheelMonitor: Any?
    private var observers: [NSObjectProtocol] = []
    private var refreshQueued = false

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observers.forEach(NotificationCenter.default.removeObserver)
        observers.removeAll()
        if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor); self.wheelMonitor = nil }
        guard let window else { model?.setPaused(false); return }
        wheelMonitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
            guard let self, self.forwardWheel(event) else { return event }
            return nil
        }
        for name in [NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification, NSWindow.didResizeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) { [weak self] _ in
                Task { @MainActor [weak self] in self?.scheduleRefresh() }
            })
        }
        scheduleRefresh()
    }

    override func layout() {
        super.layout()
        scheduleRefresh()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.filter { $0.owner === self }.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil))
        scheduleRefresh()
    }

    override func mouseEntered(with event: NSEvent) { scheduleRefresh() }
    override func mouseExited(with event: NSEvent) { scheduleRefresh() }

    private func forwardWheel(_ event: NSEvent) -> Bool {
        guard passScroll, model?.interactionPolicy.passScrollWhenFits == true,
              let window, event.window === window,
              bounds.contains(convert(event.locationInWindow, from: nil)),
              let root = window.contentView,
              let scroll = Self.scrollTarget(at: event.locationInWindow, in: root) else { return false }
        scroll.scrollWheel(with: event)
        return true
    }

    /// A stack can float in the playback inset just below its page. Prefer the scroll view beneath the
    /// point, then the closest vertical viewport in the same column; never route into an adjacent pane.
    static func scrollTarget(at point: NSPoint, in root: NSView) -> NSScrollView? {
        var best: (view: NSScrollView, distance: CGFloat)?
        func visit(_ view: NSView) {
            guard !view.isHiddenOrHasHiddenAncestor else { return }
            if let scroll = view as? NSScrollView, let document = scroll.documentView,
               document.frame.height > scroll.contentView.bounds.height {
                let rect = scroll.convert(scroll.bounds, to: nil)
                if point.x >= rect.minX, point.x <= rect.maxX {
                    let distance = max(rect.minY - point.y, point.y - rect.maxY, 0)
                    if distance <= 100, distance <= (best?.distance ?? .greatestFiniteMagnitude) {
                        best = (scroll, distance)
                    }
                }
            }
            view.subviews.forEach(visit)
        }
        visit(root)
        return best?.view
    }

    func scheduleRefresh() {
        guard !refreshQueued else { return }
        refreshQueued = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.refreshQueued = false
            self.refreshInteraction()
        }
    }

    func refreshInteraction() {
        guard let window else { model?.setPaused(false); return }
        let point = convert(window.convertPoint(fromScreen: pointerLocation()), from: nil)
        // AppKit can retain the previous visibleRect until its next clip pass after a shrink.
        let inside = window.isVisible && bounds.contains(point) && visibleRect.contains(point)
        model?.updateInteraction(pointerInside: inside, windowIsKey: window.isKeyWindow)
    }

    deinit {
        observers.forEach(NotificationCenter.default.removeObserver)
        if let wheelMonitor { NSEvent.removeMonitor(wheelMonitor) }
    }
}
