import CoreGraphics
import Foundation

public enum ClickyInputStartResult: Equatable {
    case started, permissionRequired, unavailable
}

@MainActor
public protocol ClickyInputMonitoring: AnyObject {
    var hasPermission: Bool { get }
    func requestPermission() -> Bool
    func start(handler: @escaping @MainActor (CGEventType, CGEvent) -> Void) -> ClickyInputStartResult
    func stop()
}

@MainActor
final class SystemClickyInputMonitor: ClickyInputMonitoring {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var handler: (@MainActor (CGEventType, CGEvent) -> Void)?
    var hasPermission: Bool { CGPreflightListenEventAccess() }
    func requestPermission() -> Bool { CGRequestListenEventAccess() }

    func start(handler: @escaping @MainActor (CGEventType, CGEvent) -> Void) -> ClickyInputStartResult {
        guard hasPermission else { return .permissionRequired }
        if tap != nil { return .started }
        self.handler = handler
        let events: [CGEventType] = [.keyDown, .keyUp, .flagsChanged]
        let mask = events.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<SystemClickyInputMonitor>.fromOpaque(context).takeUnretainedValue()
            if ClickyInputDiagnostics.enabled {
                let source = event.getIntegerValueField(.eventSourceUnixProcessID) == 0 ? "device" : "posted"
                PerfLog.mark("clicky.tap.\(source).\(type.rawValue)")
            }
            MainActor.assumeIsolated { monitor.handler?(type, event) }
            return Unmanaged.passUnretained(event)
        }
        guard
            let created = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                eventsOfInterest: mask, callback: callback,
                userInfo: Unmanaged.passUnretained(self).toOpaque())
        else {
            self.handler = nil
            return .unavailable
        }
        guard let runLoopSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) else {
            CFMachPortInvalidate(created)
            self.handler = nil
            return .unavailable
        }
        tap = created
        source = runLoopSource
        CFRunLoopAddSource(CFRunLoopGetMain(), runLoopSource, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        return .started
    }

    func stop() {
        handler = nil
        if let tap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        tap = nil
        source = nil
    }

    deinit {
        if let tap { CFMachPortInvalidate(tap) }
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
    }
}

/// Explicit profiling records event phases and duration, never key codes or text.
enum ClickyInputDiagnostics {
    static let enabled = CommandLine.arguments.contains("--input-diagnostics")
}
