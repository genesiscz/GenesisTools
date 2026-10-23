import AppKit

/// The click count of the event that ran an action. `NSEvent.clickCount` raises (an Objective-C exception, not an
/// optional) on any event that is not a mouse event, and a SwiftUI button action can run while the current event is a
/// key, a system-defined or an app-defined event. The exception broke the window's event handling: a group chip of the
/// markdown tab bar read it, and from then on no click in the window did anything (Genesis Markdown, 2026-10-23 16:36).
/// Read a click count only through this.
public enum MouseClick {
    static let mouseTypes: Set<NSEvent.EventType> = [
        .leftMouseDown, .leftMouseUp, .rightMouseDown, .rightMouseUp, .otherMouseDown, .otherMouseUp,
    ]

    /// 1 unless `event` is a mouse event; then its own click count.
    public static func count(of event: NSEvent?) -> Int {
        guard let event, mouseTypes.contains(event.type) else { return 1 }
        return event.clickCount
    }

    /// The click count of the event AppKit is handling now.
    @MainActor public static var current: Int { count(of: NSApp.currentEvent) }
}
