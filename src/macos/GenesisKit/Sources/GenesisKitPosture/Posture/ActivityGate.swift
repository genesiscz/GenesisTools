import AppKit
import AVFoundation
import CoreGraphics
import IOKit.ps
import GenesisKit

/// Why watching posture should stop for now.
public enum ActivityPauseReason: String, CaseIterable, Codable, Sendable {
    /// The user pressed Pause (a timed pause carries its end in `PosturePause.until`).
    case user
    case systemSleep
    case screensAsleep
    case screenLocked
    case screenSaver
    /// Another login session is in front (fast user switching).
    case sessionInactive
    case onBattery
    case lowPowerMode
    /// The only screen is the built-in one: the Mac is away from its desk (Dorso's "pause on the go").
    case laptopOnlyDisplay
    /// Another app uses the chosen camera (a call).
    case cameraInUse
    /// No keyboard or mouse input for the idle threshold.
    case idle
    /// AirPods left the ears while they were the posture source.
    case headphonesRemoved
    /// The frontmost app shows a full-screen window (a film, a game, a presentation). Reported only while
    /// `ActivityGate.watchesFullScreenApps` is on.
    case fullScreenApp

    public var title: String {
        switch self {
        case .user: "Paused"
        case .systemSleep: "Mac asleep"
        case .screensAsleep: "Screens asleep"
        case .screenLocked: "Screen locked"
        case .screenSaver: "Screen saver"
        case .sessionInactive: "Another user is active"
        case .onBattery: "On battery"
        case .lowPowerMode: "Low Power Mode"
        case .laptopOnlyDisplay: "Laptop screen only"
        case .cameraInUse: "Camera in use by another app"
        case .idle: "Idle"
        case .headphonesRemoved: "AirPods removed"
        case .fullScreenApp: "Full-screen app"
        }
    }
}

/// Watches the system for reasons to pause, by events only: NSWorkspace sleep, wake, screen sleep and
/// session changes, the distributed screen lock and screen saver notifications, an IOKit power-source
/// run-loop source, Low Power Mode, the screen list, and key-value observation of the chosen camera's
/// `isInUseByAnotherApplication`. No polling timer runs.
///
/// Idle is the one input macOS does not post: the gate arms a single one-shot timer for the moment the
/// idle threshold would pass and, once idle, waits for the next mouse or key event with a global event
/// monitor, so nothing runs while the user is away. Mouse events reach a global monitor without any
/// privacy grant; keys reach it only with Accessibility, so mouse movement is what ends idle for certain.
///
/// `reasons` holds every raw reason that applies now; the host intersects it with the pauses the user
/// turned on. It publishes only when the set changes.
@MainActor
public final class ActivityGate: ObservableObject {
    @Published public private(set) var reasons: Set<ActivityPauseReason> = []
    /// Called after each change of `reasons`.
    public var onChange: ((Set<ActivityPauseReason>) -> Void)?

    /// Seconds without input that count as idle; nil turns the idle check off.
    public var idleThreshold: TimeInterval? {
        didSet { if oldValue != idleThreshold, started { armIdle() } }
    }

    /// Reports `.fullScreenApp` while the frontmost app (not this one) has a full-screen window. It checks
    /// when the frontmost app or the Space changes, 0.6 s later (the Space animation), never on a timer.
    /// Off by default: each check lists the on-screen windows.
    public var watchesFullScreenApps = false {
        didSet {
            guard oldValue != watchesFullScreenApps else { return }
            if watchesFullScreenApps { scheduleFullScreenCheck() } else { set(.fullScreenApp, false) }
        }
    }

    private var started = false
    nonisolated(unsafe) private var workspaceObservers: [NSObjectProtocol] = []
    nonisolated(unsafe) private var centerObservers: [NSObjectProtocol] = []
    nonisolated(unsafe) private var distributedObservers: [NSObjectProtocol] = []
    nonisolated(unsafe) private var powerSource: CFRunLoopSource?
    nonisolated(unsafe) private var idleTimer: DispatchSourceTimer?
    nonisolated(unsafe) private var idleMonitors: [Any] = []
    private var cameraObservation: NSKeyValueObservation?
    private var cameraID: String?
    private let readEventReasons: (Set<ActivityPauseReason>) -> Set<ActivityPauseReason>
    private static let eventReasons: Set<ActivityPauseReason> = [.systemSleep, .screensAsleep, .screenSaver, .sessionInactive]
    private var screenDebounce: DispatchWorkItem?
    private var fullScreenDebounce: DispatchWorkItem?

    public convenience init(idleThreshold: TimeInterval? = nil) {
        self.init(idleThreshold: idleThreshold, readEventReasons: Self.currentEventReasons)
    }

    init(idleThreshold: TimeInterval? = nil,
         readEventReasons: @escaping (Set<ActivityPauseReason>) -> Set<ActivityPauseReason>) {
        self.idleThreshold = idleThreshold
        self.readEventReasons = readEventReasons
    }

    deinit {
        let workspace = NSWorkspace.shared.notificationCenter
        workspaceObservers.forEach { workspace.removeObserver($0) }
        centerObservers.forEach { NotificationCenter.default.removeObserver($0) }
        distributedObservers.forEach { DistributedNotificationCenter.default().removeObserver($0) }
        if let powerSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), powerSource, .commonModes) }
        idleTimer?.cancel()
        idleMonitors.forEach { NSEvent.removeMonitor($0) }
    }

    /// Installs the observers and reads the current state once.
    public func start() {
        guard !started else { return }
        started = true
        let workspace = NSWorkspace.shared.notificationCenter
        let workspaceEvents: [(Notification.Name, ActivityPauseReason, Bool)] = [
            (NSWorkspace.willSleepNotification, .systemSleep, true),
            (NSWorkspace.didWakeNotification, .systemSleep, false),
            (NSWorkspace.screensDidSleepNotification, .screensAsleep, true),
            (NSWorkspace.screensDidWakeNotification, .screensAsleep, false),
            (NSWorkspace.sessionDidResignActiveNotification, .sessionInactive, true),
            (NSWorkspace.sessionDidBecomeActiveNotification, .sessionInactive, false),
        ]
        for (name, reason, on) in workspaceEvents {
            workspaceObservers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.set(reason, on)
                    if name == NSWorkspace.didWakeNotification || name == NSWorkspace.screensDidWakeNotification {
                        self?.refreshAfterWake()
                    }
                }
            })
        }
        let distributed: [(String, ActivityPauseReason, Bool)] = [
            ("com.apple.screenIsLocked", .screenLocked, true),
            ("com.apple.screenIsUnlocked", .screenLocked, false),
            ("com.apple.screensaver.didstart", .screenSaver, true),
            ("com.apple.screensaver.didstop", .screenSaver, false),
        ]
        for (name, reason, on) in distributed {
            distributedObservers.append(DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name(name), object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.set(reason, on)
                    if !on { self?.refreshAfterWake() }
                }
            })
        }
        for name in [NSWorkspace.didActivateApplicationNotification, NSWorkspace.activeSpaceDidChangeNotification] {
            workspaceObservers.append(workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.scheduleFullScreenCheck() }
            })
        }
        centerObservers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleScreenCheck() }
        })
        centerObservers.append(NotificationCenter.default.addObserver(
            forName: Notification.Name.NSProcessInfoPowerStateDidChange, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.set(.lowPowerMode, ProcessInfo.processInfo.isLowPowerModeEnabled) }
        })
        installPowerSource()
        let current = readEventReasons(reasons)
        for reason in Self.eventReasons { set(reason, current.contains(reason)) }
        refreshAll()
        observeCamera(uniqueID: cameraID)
        armIdle()
        if watchesFullScreenApps { scheduleFullScreenCheck() }
    }

    /// Removes every observer and the idle timer. `reasons` keeps its last value.
    public func stop() {
        guard started else { return }
        started = false
        let workspace = NSWorkspace.shared.notificationCenter
        workspaceObservers.forEach { workspace.removeObserver($0) }
        centerObservers.forEach { NotificationCenter.default.removeObserver($0) }
        distributedObservers.forEach { DistributedNotificationCenter.default().removeObserver($0) }
        workspaceObservers = []
        centerObservers = []
        distributedObservers = []
        if let powerSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), powerSource, .commonModes) }
        powerSource = nil
        idleTimer?.cancel()
        idleTimer = nil
        removeIdleMonitors()
        screenDebounce?.cancel()
        fullScreenDebounce?.cancel()
        cameraObservation = nil
    }

    /// Watches the camera with this unique id for use by another app (nil stops watching). Apple says to
    /// observe `isInUseByAnotherApplication` for this; whether it fires for a shareable built-in camera
    /// was not verified (PoseEngines research), so treat the reason as best effort.
    public func observeCamera(uniqueID: String?) {
        guard uniqueID != cameraID || cameraObservation == nil else { return }
        cameraID = uniqueID
        cameraObservation = nil
        guard let uniqueID, let device = AVCaptureDevice(uniqueID: uniqueID) else {
            set(.cameraInUse, false)
            return
        }
        cameraObservation = device.observe(\.isInUseByAnotherApplication, options: [.initial, .new]) { [weak self] device, _ in
            let inUse = device.isInUseByAnotherApplication
            DispatchQueue.main.async { self?.set(.cameraInUse, inUse) }
        }
    }

    // MARK: - Reading the system

    /// Reconcile notifications missed while stopped. Preserve a previous reason if its query fails.
    private static func currentEventReasons(_ previous: Set<ActivityPauseReason>) -> Set<ActivityPauseReason> {
        var current = previous.intersection(eventReasons)
        current.remove(.systemSleep) // This process is executing again.
        if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
           let onConsole = session[kCGSessionOnConsoleKey as String] as? Bool {
            if onConsole { current.remove(.sessionInactive) } else { current.insert(.sessionInactive) }
        }
        var count: UInt32 = 0
        if CGGetOnlineDisplayList(0, nil, &count) == .success, count > 0 {
            var displays = [CGDirectDisplayID](repeating: 0, count: Int(count))
            if CGGetOnlineDisplayList(count, &displays, &count) == .success {
                if displays.prefix(Int(count)).allSatisfy({ CGDisplayIsAsleep($0) != 0 }) {
                    current.insert(.screensAsleep)
                } else {
                    current.remove(.screensAsleep)
                }
            }
        }
        let engines = Set(NSWorkspace.shared.runningApplications.filter {
            $0.bundleIdentifier == "com.apple.ScreenSaver.Engine"
                || $0.bundleIdentifier == "com.apple.ScreenSaver.Engine.legacyScreenSaver"
        }.map(\.processIdentifier))
        if engines.isEmpty {
            current.remove(.screenSaver)
        } else if let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] {
            let visible = windows.contains { info in
                (info[kCGWindowOwnerPID as String] as? pid_t).map { engines.contains($0) } ?? false
            }
            if visible { current.insert(.screenSaver) } else { current.remove(.screenSaver) }
        }
        return current
    }

    /// Whether the Mac runs on battery right now (IOKit power sources).
    public nonisolated static func isOnBattery() -> Bool {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let type = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
        else { return false }
        return type == kIOPMBatteryPowerKey
    }

    /// Whether the login session's screen is locked now (`CGSessionCopyCurrentDictionary`).
    public nonisolated static func isScreenLocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return false }
        return (session["CGSSessionScreenIsLocked"] as? Bool) ?? false
    }

    /// Whether the frontmost app, other than this process, has a normal-level window that covers a whole
    /// screen, menu bar included. The window list gives bounds and owners without the Screen Recording
    /// grant.
    public static func frontmostAppIsFullScreen() -> Bool {
        guard let app = NSWorkspace.shared.frontmostApplication,
              app.processIdentifier != ProcessInfo.processInfo.processIdentifier,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
                as? [[String: Any]]
        else { return false }
        let screens = NSScreen.screens.map(\.frame.size)
        let windows: [(pid: pid_t, layer: Int, bounds: CGRect)] = list.compactMap { info in
            guard let pid = info[kCGWindowOwnerPID as String] as? pid_t,
                  let layer = info[kCGWindowLayer as String] as? Int,
                  let dictionary = info[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: dictionary) else { return nil }
            return (pid, layer, bounds)
        }
        return coversScreen(windows: windows, pid: app.processIdentifier, screens: screens)
    }

    /// Whether one of `pid`'s layer-0 windows has the size of a screen. Pure, for tests.
    public nonisolated static func coversScreen(windows: [(pid: pid_t, layer: Int, bounds: CGRect)], pid: pid_t,
                                                screens: [CGSize]) -> Bool {
        windows.contains { window in
            window.pid == pid && window.layer == 0
                && screens.contains { abs($0.width - window.bounds.width) < 1 && abs($0.height - window.bounds.height) < 1 }
        }
    }

    /// Whether the only active display is built in. Pure over its input, for tests.
    public nonisolated static func isLaptopOnly(builtIn: [Bool]) -> Bool {
        builtIn.count == 1 && builtIn[0]
    }

    /// The active displays and whether each is built in.
    public nonisolated static func activeDisplaysBuiltIn() -> [Bool] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        return ids.prefix(Int(count)).map { CGDisplayIsBuiltin($0) != 0 }
    }

    // MARK: - Internals

    func set(_ reason: ActivityPauseReason, _ on: Bool) {
        var next = reasons
        if on { next.insert(reason) } else { next.remove(reason) }
        guard next != reasons else { return }
        reasons = next
        onChange?(next)
    }

    private func refreshAll() {
        set(.onBattery, Self.isOnBattery())
        set(.screenLocked, Self.isScreenLocked())
        set(.lowPowerMode, ProcessInfo.processInfo.isLowPowerModeEnabled)
        set(.laptopOnlyDisplay, Self.isLaptopOnly(builtIn: Self.activeDisplaysBuiltIn()))
    }

    /// After a wake or an unlock the power source and screens may have changed without a notification
    /// reaching a sleeping app (Dorso re-reads the battery on unlock for this reason).
    private func refreshAfterWake() {
        set(.onBattery, Self.isOnBattery())
        set(.screenLocked, Self.isScreenLocked())
        scheduleScreenCheck()
        markActive()
    }

    /// Screen changes arrive in bursts while displays attach; one check 0.5 s after the last (Dorso).
    private func scheduleScreenCheck() {
        screenDebounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                self?.set(.laptopOnlyDisplay, Self.isLaptopOnly(builtIn: Self.activeDisplaysBuiltIn()))
            }
        }
        screenDebounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: work)
    }

    private func scheduleFullScreenCheck() {
        guard watchesFullScreenApps else { return }
        fullScreenDebounce?.cancel()
        let work = DispatchWorkItem { [weak self] in
            MainActor.assumeIsolated {
                guard let self, self.watchesFullScreenApps else { return }
                self.set(.fullScreenApp, Self.frontmostAppIsFullScreen())
            }
        }
        fullScreenDebounce = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6, execute: work)
    }

    private func installPowerSource() {
        let context = Unmanaged.passUnretained(self).toOpaque()
        guard let source = IOPSNotificationCreateRunLoopSource({ context in
            guard let context else { return }
            let gate = Unmanaged<ActivityGate>.fromOpaque(context).takeUnretainedValue()
            MainActor.assumeIsolated { gate.set(.onBattery, ActivityGate.isOnBattery()) }
        }, context)?.takeRetainedValue() else { return }
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        powerSource = source
    }

    // MARK: Idle

    private func armIdle() {
        idleTimer?.cancel()
        idleTimer = nil
        guard let threshold = idleThreshold, threshold > 0 else {
            removeIdleMonitors()
            set(.idle, false)
            return
        }
        let idle = ActivityRecorder.idleSeconds()
        if idle >= threshold {
            enterIdle()
            return
        }
        set(.idle, false)
        removeIdleMonitors()
        let timer = DispatchSource.makeTimerSource(queue: .main)
        let wait = max(threshold - idle, 1)
        timer.schedule(deadline: .now() + wait, leeway: .milliseconds(Int(max(1000, wait * 100))))
        timer.setEventHandler { [weak self] in
            MainActor.assumeIsolated { self?.armIdle() }
        }
        timer.resume()
        idleTimer = timer
    }

    private func enterIdle() {
        set(.idle, true)
        guard idleMonitors.isEmpty else { return }
        let mask: NSEvent.EventTypeMask = [.mouseMoved, .leftMouseDown, .rightMouseDown, .otherMouseDown,
                                           .scrollWheel, .keyDown, .flagsChanged]
        if let global = NSEvent.addGlobalMonitorForEvents(matching: mask, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.markActive() }
        }) {
            idleMonitors.append(global)
        }
        if let local = NSEvent.addLocalMonitorForEvents(matching: mask, handler: { [weak self] event in
            MainActor.assumeIsolated { self?.markActive() }
            return event
        }) {
            idleMonitors.append(local)
        }
    }

    private func markActive() {
        guard reasons.contains(.idle) || !idleMonitors.isEmpty else { return }
        removeIdleMonitors()
        if started { armIdle() }
    }

    private func removeIdleMonitors() {
        idleMonitors.forEach { NSEvent.removeMonitor($0) }
        idleMonitors = []
    }
}
