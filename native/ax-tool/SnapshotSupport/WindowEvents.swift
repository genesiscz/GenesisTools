import AppKit
import Darwin

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
