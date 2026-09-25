import AppKit

/// Keeps the instant tooltip (Hub/Stolen/UI/InstantTooltip.swift) off an opened menu or popover.
///
/// The bubble is a `.popUpMenu`-level panel that hid only on mouse exit or when the pointer left
/// the anchor. A click that opens a popover or menu leaves the pointer on the button, so the
/// bubble stayed, drawn over the popover's first rows; and a click inside the 0.18 s delay showed
/// it after the popover had opened. Now a mouse-down hides the bubble and mutes the controls
/// under the pointer until the pointer leaves them, an open menu mutes every bubble, and no
/// bubble shows for an anchor that another window (a popover) covers at the pointer.
@MainActor
enum TooltipGuard {
    /// Sensors the pointer is inside now, by token: the candidates a click mutes.
    private static var hovered: [UUID: WeakView] = [:]
    private static var muted = Set<UUID>()
    private static var openMenus = Set<ObjectIdentifier>()
    private static var installed = false

    private final class WeakView {
        weak var view: NSView?
        init(_ view: NSView) { self.view = view }
    }

    static func entered(_ owner: UUID, view: NSView) {
        install()
        hovered[owner] = WeakView(view)
    }

    static func exited(_ owner: UUID) {
        hovered[owner] = nil
        muted.remove(owner)
    }

    /// Whether `owner` may show its bubble for an anchor in `window` now.
    static func allows(_ owner: UUID, in window: NSWindow) -> Bool {
        guard openMenus.isEmpty, !muted.contains(owner) else { return false }
        let top = NSWindow.windowNumber(at: NSEvent.mouseLocation, belowWindowWithWindowNumber: 0)
        // 0: no window of ours answers there (a snapshot run, a test). The bubble's own panel may
        // sit under the pointer at a screen edge; it never covers the anchor's content.
        return top == 0 || top == window.windowNumber || top == TooltipPresenter.shared.panel?.windowNumber
    }

    /// A mouse-down at `location` (window coordinates) in `window`: hide the bubble, mute every
    /// hovered sensor under the click until the pointer leaves it. Internal for the tests.
    static func mouseDown(at location: NSPoint, in window: NSWindow?) {
        hideBubble()
        for (owner, box) in hovered {
            guard let view = box.view, view.window != nil else {
                hovered[owner] = nil
                continue
            }
            if view.window === window, view.convert(view.bounds, to: nil).contains(location) {
                muted.insert(owner)
            }
        }
    }

    static func isMuted(_ owner: UUID) -> Bool { muted.contains(owner) }

    private static func hideBubble() {
        if let owner = TooltipPresenter.shared.currentOwner {
            TooltipPresenter.shared.hide(owner: owner)
        }
    }

    private static func install() {
        guard !installed else { return }
        installed = true
        NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { event in
            TooltipGuard.mouseDown(at: event.locationInWindow, in: event.window)
            return event
        }
        let center = NotificationCenter.default
        center.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: .main) { note in
            let menu = note.object.map { ObjectIdentifier($0 as AnyObject) }
            MainActor.assumeIsolated {
                if let menu { openMenus.insert(menu) }
                hideBubble()
            }
        }
        center.addObserver(forName: NSMenu.didEndTrackingNotification, object: nil, queue: .main) { note in
            let menu = note.object.map { ObjectIdentifier($0 as AnyObject) }
            MainActor.assumeIsolated {
                if let menu { openMenus.remove(menu) }
            }
        }
        // A popover opened without a click (the palette's "review") still takes the bubble down.
        center.addObserver(forName: NSPopover.willShowNotification, object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { hideBubble() }
        }
    }
}
