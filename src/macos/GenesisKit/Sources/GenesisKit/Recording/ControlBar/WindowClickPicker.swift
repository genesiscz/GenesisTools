import AppKit
import ApplicationServices

extension RecordingWindow {
    var quartzFrame: CGRect { CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height) }
}

/// Reads regular windows in WindowServer stacking order. Hit testing and list bounds both use Quartz points.
@MainActor
enum WindowClickPicker {
    static func window(at point: CGPoint, in windows: [RecordingWindow], excluding ids: Set<UInt32>) -> RecordingWindow? {
        windows.first { !ids.contains($0.id) && $0.quartzFrame.contains(point) }
    }

    static func windowToRaise(for target: RecordingTarget, in windows: [RecordingWindow], excluding: Set<UInt32>,
                              enabled: Bool) -> RecordingWindow? {
        guard enabled, case let .window(ids, _, _, _) = target,
              let window = windows.first(where: { ids.contains($0.id) && !excluding.contains($0.id) }),
              windows.first(where: { !excluding.contains($0.id) })?.id != window.id else { return nil }
        return window
    }

    static func windows() -> [RecordingWindow] {
        let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
        let rows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] ?? []
        return rows.compactMap { row in
            guard row[kCGWindowLayer as String] as? Int == 0, (row[kCGWindowAlpha as String] as? Double ?? 1) > 0,
                  let id = row[kCGWindowNumber as String] as? UInt32, let pid = row[kCGWindowOwnerPID as String] as? Int32,
                  let raw = row[kCGWindowBounds as String] as? NSDictionary,
                  let frame = CGRect(dictionaryRepresentation: raw), !frame.isEmpty else { return nil }
            return RecordingWindow(id: id, pid: pid, app: row[kCGWindowOwnerName as String] as? String ?? "App",
                                   title: row[kCGWindowName as String] as? String ?? "",
                                   bounds: .init(x: frame.minX, y: frame.minY, width: frame.width, height: frame.height))
        }
    }

    static func begin(overlays: RecordingPickerOverlays, parent: NSWindow?, hover: @escaping (RecordingWindow?) -> Void,
                      completion: @escaping (RecordingTarget?) -> Void) {
        let hostIDs = parent.map { [$0.windowNumber] } ?? []
        let excluded = Set((overlays.windowIDs + hostIDs + NSApp.windows.filter { $0.sharingType == .none }.map(\.windowNumber))
            .compactMap(UInt32.init(exactly:)))
        var listed = windows()
        var refreshed = ContinuousClock.now
        overlays.present(title: "Pick a window", parent: parent, makeView: { _, frame in
            let view = WindowClickView(frame: frame)
            view.setAccessibilityLabel("Pick a window by clicking it")
            view.onCancel = { [weak overlays] in overlays?.finish(nil) }
            view.atPoint = { point, clicked in
                if clicked || refreshed.duration(to: .now) >= .milliseconds(120) {
                    listed = windows()
                    refreshed = .now
                }
                return window(at: point, in: listed, excluding: excluded)
            }
            view.onHover = hover
            view.onSelect = { [weak overlays] in overlays?.finish($0.target) }
            return view
        }, completion: completion)
    }
}

private final class WindowClickView: RecordingSelectorView {
    var atPoint: ((CGPoint, Bool) -> RecordingWindow?)?
    var onHover: ((RecordingWindow?) -> Void)?
    var onSelect: ((RecordingWindow) -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: .zero, options: [.inVisibleRect, .activeAlways, .mouseMoved, .mouseEnteredAndExited],
                                  owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    override func draw(_ dirtyRect: NSRect) {
        // Completely clear pixels in a borderless window let clicks fall through to the app.
        NSColor.black.withAlphaComponent(0.01).setFill()
        dirtyRect.fill()
        drawHint("Click a window · Esc to return", at: CGPoint(x: bounds.midX, y: bounds.maxY - 60))
    }

    private func hit(_ event: NSEvent, clicked: Bool) -> RecordingWindow? {
        guard let screenPoint = window?.convertPoint(toScreen: event.locationInWindow),
              let primary = NSScreen.screens.first else { return nil }
        return atPoint?(CGPoint(x: screenPoint.x, y: primary.frame.maxY - screenPoint.y), clicked)
    }

    override func mouseEntered(with event: NSEvent) { onHover?(hit(event, clicked: false)) }
    override func mouseMoved(with event: NSEvent) { onHover?(hit(event, clicked: false)) }
    override func mouseExited(with event: NSEvent) { onHover?(nil) }
    override func mouseDown(with event: NSEvent) { window?.makeKey() }
    override func mouseUp(with event: NSEvent) {
        if let window = hit(event, clicked: true) { onSelect?(window) }
    }
}

/// Wait for the selected window to come forward. An AX focus change covers two windows of the same app;
/// app activation covers switching apps. The deadline also covers an app without Accessibility permission.
@MainActor
final class RecordingWindowFront {
    let window: RecordingWindow
    let excluded: Set<UInt32>
    let done: () -> Void
    private var observer: AXObserver?
    private var activation: NSObjectProtocol?
    private var deadline: Task<Void, Never>?
    private var raiseReturned = false

    init(_ window: RecordingWindow, excluding: Set<UInt32>, done: @escaping () -> Void) {
        self.window = window
        self.excluded = excluding
        self.done = done
    }

    func start() {
        let limit = ContinuousClock.now.advanced(by: .milliseconds(350))
        let app = AXUIElementCreateApplication(window.pid)
        var observer: AXObserver?
        let callback: AXObserverCallback = { _, _, _, ref in
            guard let ref else { return }
            MainActor.assumeIsolated { Unmanaged<RecordingWindowFront>.fromOpaque(ref).takeUnretainedValue().changed() }
        }
        if AXObserverCreate(window.pid, callback, &observer) == .success, let observer {
            self.observer = observer
            AXUIElementSetMessagingTimeout(app, 0.15)
            AXObserverAddNotification(observer, app, kAXFocusedWindowChangedNotification as CFString,
                                      Unmanaged.passUnretained(self).toOpaque())
            CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
        }
        activation = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                                       object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.changed() }
        }
        deadline = Task {
            do { try await Task.sleep(until: limit, clock: .continuous) } catch { return }
            finish()
        }
        NSRunningApplication(processIdentifier: window.pid)?.activate(options: [])
        let target = window
        Task {
            await Task.detached { Self.raise(target) }.value
            raiseReturned = true
            changed()
        }
    }

    static func bringForward(_ window: RecordingWindow, excluding: Set<UInt32>, done: @escaping () -> Void) {
        RecordingWindowFront(window, excluding: excluding, done: done).start()
    }

    private func changed() {
        guard deadline != nil, raiseReturned else { return }
        if WindowClickPicker.windows().first(where: { !excluded.contains($0.id) })?.id == window.id { finish() }
    }

    private func finish() {
        guard let deadline else { return }
        self.deadline = nil
        deadline.cancel()
        if let observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes) }
        observer = nil
        if let activation { NSWorkspace.shared.notificationCenter.removeObserver(activation) }
        activation = nil
        done()
    }

    /// Match the WindowServer ID, even when two windows have the same title. ax-tool uses the same AX bridge.
    nonisolated private static func raise(_ window: RecordingWindow) {
        guard AXIsProcessTrusted(),
              let handle = dlopen("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices", RTLD_LAZY)
        else { return }
        defer { dlclose(handle) }
        typealias GetID = @convention(c) (AXUIElement, UnsafeMutablePointer<CGWindowID>) -> AXError
        guard let symbol = dlsym(handle, "_AXUIElementGetWindow") else { return }
        let getID = unsafeBitCast(symbol, to: GetID.self)
        let app = AXUIElementCreateApplication(window.pid)
        AXUIElementSetMessagingTimeout(app, 0.2)
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value) == .success,
              let windows = value as? [AXUIElement] else { return }
        for candidate in windows {
            var id: CGWindowID = 0
            guard getID(candidate, &id) == .success, id == window.id else { continue }
            AXUIElementSetMessagingTimeout(candidate, 0.2)
            AXUIElementPerformAction(candidate, kAXRaiseAction as CFString)
            return
        }
    }
}
