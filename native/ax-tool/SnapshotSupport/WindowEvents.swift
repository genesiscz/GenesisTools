import AppKit
import Darwin

/// What a verification pins before an event is posted.
public enum SnapshotVerifyTarget: Equatable {
    /// The element the snapshot captured, at the frame it was captured with.
    case element
    /// The window only, at its CG bounds. Used once a drag is under way.
    case window
}

public enum WindowEventError: Error, LocalizedError {
    case unavailable(String)
    public var errorDescription: String? {
        switch self {
        case .unavailable(let message): return message
        }
    }
}

/// Builds process-targeted events without posting them or moving the physical pointer.
public final class WindowEventFactory {
    private typealias SetLocation = @convention(c) (CGEvent, CGPoint) -> Void
    private let handle: UnsafeMutableRawPointer
    private let setLocation: SetLocation
    private let windowID: Int
    private let bounds: CGRect

    public init(windowID: Int, bounds: CGRect) throws {
        guard windowID > 0, bounds.width > 0, bounds.height > 0,
              let handle = dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY) else {
            throw WindowEventError.unavailable("window-addressed event support is unavailable")
        }
        guard let symbol = dlsym(handle, "CGEventSetWindowLocation") else {
            dlclose(handle)
            throw WindowEventError.unavailable("CGEventSetWindowLocation is unavailable; no event dispatched")
        }
        self.handle = handle
        self.setLocation = unsafeBitCast(symbol, to: SetLocation.self)
        self.windowID = windowID
        self.bounds = bounds
    }

    deinit { dlclose(handle) }

    /// Which thing a drag step must pin: the dragged element, or only the window.
    ///
    /// A drag verifies the element ONCE, before mouse-down, because from then on the
    /// element is supposed to move — that is what a drag is. Every later step pins the
    /// window instead. `verifyPoint` used to ignore this choice and assert the captured
    /// element frame on every step, so any drag that moved its own target aborted after
    /// the first movement and left a half-completed drag behind.
    public static func dragVerifyTarget(point: CGPoint, start: CGPoint) -> SnapshotVerifyTarget {
        point == start ? .element : .window
    }

    public func drag(start: CGPoint, points: [CGPoint], stepDelay: Double,
                     verify: (CGPoint) throws -> Void, post: (CGEvent) -> Void) throws {
        let down = try mouse(type: .leftMouseDown, point: start, clickCount: 1)
        var release = try mouse(type: .leftMouseUp, point: start, clickCount: 1)
        try verify(start)
        post(down)
        do {
            for point in points {
                Thread.sleep(forTimeInterval: stepDelay)
                try verify(point)
                let move = try mouse(type: .leftMouseDragged, point: point, clickCount: 1)
                let nextRelease = try mouse(type: .leftMouseUp, point: point, clickCount: 1)
                post(move)
                release = nextRelease
            }
        } catch {
            post(release)
            throw WindowEventError.unavailable("drag interrupted after mouse-down: \(error.localizedDescription); inspect the partial outcome")
        }
        post(release)
    }

    public func scroll(point: CGPoint, deltaX: Int32, deltaY: Int32) throws -> CGEvent {
        guard bounds.contains(point), let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
            wheelCount: 2, wheel1: deltaY, wheel2: deltaX, wheel3: 0) else {
            throw WindowEventError.unavailable("could not allocate window-addressed scroll event")
        }
        event.location = point
        setLocation(event, snapshotWindowPoint(point, in: bounds))
        // WebKit's CoreGraphicsSPI.h names this private field kCGSEventWindowIDField.
        event.setIntegerValueField(CGEventField(rawValue: 51)!, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        return event
    }

    public func mouse(type: NSEvent.EventType, point: CGPoint, clickCount: Int) throws -> CGEvent {
        guard point.x.isFinite, point.y.isFinite, bounds.contains(point) else {
            throw WindowEventError.unavailable("mouse point is outside the snapshot window")
        }
        let local = NSPoint(x: point.x - bounds.minX, y: bounds.maxY - point.y)
        guard let event = NSEvent.mouseEvent(with: type, location: local, modifierFlags: [],
            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: windowID, context: nil,
            eventNumber: 0, clickCount: clickCount, pressure: 0)?.cgEvent else {
            throw WindowEventError.unavailable("could not allocate window-addressed mouse event")
        }
        // Setting the global position clears the private window-local field.
        event.location = point
        setLocation(event, snapshotWindowPoint(point, in: bounds))
        event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointer, value: Int64(windowID))
        event.setIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent, value: Int64(windowID))
        return event
    }
}
