import AppKit
import Carbon.HIToolbox
import Combine
import CoreGraphics
import Foundation
import UserNotifications
import os

@MainActor
public final class ClickyModel: ObservableObject {
    @Published public var preferences: ClickyPreferences { didSet { savePreferences() } }
    @Published public private(set) var enabled = false
    @Published public private(set) var status = "Clicky is off"
    @Published public private(set) var statistics: ClickyStatistics
    @Published public private(set) var sleepingUntil: Date?
    @Published public private(set) var pulse = 0
    @Published public private(set) var lastPan: Float = 0
    @Published public private(set) var notificationStatus = "Not requested"
    @Published public private(set) var error: String?
    public var stateDidChange: (() -> Void)?
    private let defaults: UserDefaults
    private let log = Logger(subsystem: "dev.genesis.tools", category: "Clicky")
    private var audio: ClickyAudio?
    private var previewGeneration = 0
    private var eventTap: CFMachPort?
    private var eventSource: CFRunLoopSource?
    private var observers: [NSObjectProtocol] = []
    private var boundaryTimer: Timer?
    private var inputState = ClickyInputState()
    private var systemSleeping = false
    private var excluded = false
    private var pendingStats = false
    private var persistenceWork: DispatchWorkItem?
    private let previewOnly: Bool

    public init(defaults: UserDefaults = .standard, previewOnly: Bool = false) {
        self.defaults = defaults
        self.previewOnly = previewOnly
        if let data = defaults.data(forKey: "clicky.preferences.v1"),
            var saved = try? JSONDecoder().decode(ClickyPreferences.self, from: data)
        {
            saved.normalize()
            preferences = saved
        } else {
            preferences = ClickyPreferences()
        }
        if let data = defaults.data(forKey: "clicky.statistics.v1"),
            let saved = try? JSONDecoder().decode(ClickyStatistics.self, from: data)
        {
            statistics = saved
        } else {
            statistics = ClickyStatistics()
        }
        guard !previewOnly else { return }
        let workspace = NSWorkspace.shared.notificationCenter
        for name in [
            NSWorkspace.didActivateApplicationNotification, NSWorkspace.willSleepNotification,
            NSWorkspace.didWakeNotification, NSWorkspace.screensDidSleepNotification,
            NSWorkspace.screensDidWakeNotification,
        ] {
            observers.append(
                workspace.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                    MainActor.assumeIsolated { self?.workspaceChanged(note) }
                })
        }
        observers.append(
            NotificationCenter.default.addObserver(
                forName: NSApplication.willTerminateNotification,
                object: nil, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.shutdown() }
            })
        UNUserNotificationCenter.current().getNotificationSettings { [weak self] settings in
            Task { @MainActor in
                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral: self?.notificationStatus = "Allowed"
                case .denied: self?.notificationStatus = "Not allowed"
                case .notDetermined: self?.notificationStatus = "Not requested"
                @unknown default: self?.notificationStatus = "Unknown"
                }
            }
        }
        refreshContext()
    }

    public var hasInputPermission: Bool { CGPreflightListenEventAccess() }
    public var isPaused: Bool {
        systemSleeping || preferences.isQuiet(at: Date()) || excluded || (sleepingUntil.map { $0 > Date() } ?? false)
    }
    public var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }

    public func activate() {
        guard !previewOnly else {
            error = "Live input is disabled in the preview. Sound previews still work."
            return
        }
        guard !enabled else { return }
        error = nil
        guard CGPreflightListenEventAccess() || CGRequestListenEventAccess() else {
            error = "Allow Input Monitoring for this app in System Settings, then click Enable Clicky again."
            log.notice("Activation needs Input Monitoring permission")
            return
        }
        if audio == nil { audio = ClickyAudio() }
        let mask =
            (1 << CGEventType.keyDown.rawValue) | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)
        guard
            let tap = CGEvent.tapCreate(
                tap: .cgSessionEventTap, place: .headInsertEventTap, options: .listenOnly,
                eventsOfInterest: CGEventMask(mask),
                callback: { _, type, event, context in
                    guard let context else { return Unmanaged.passUnretained(event) }
                    let model = Unmanaged<ClickyModel>.fromOpaque(context).takeUnretainedValue()
                    MainActor.assumeIsolated { model.receive(type: type, event: event) }
                    return Unmanaged.passUnretained(event)
                }, userInfo: Unmanaged.passUnretained(self).toOpaque())
        else {
            error = "macOS could not start Input Monitoring. Check the permission and try again."
            log.error("Listen-only event tap creation failed")
            return
        }
        eventTap = tap
        eventSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), eventSource, .commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        enabled = true
        if preferences.collectStats {
            statistics.sessions += 1
            pendingStats = true
        }
        refreshContext()
        notify("Clicky enabled", body: "Your selected switch is \(preferences.selectedSwitch.name).")
        log.notice("Input feedback activated; no input content is retained")
    }

    public func deactivate() {
        previewGeneration &+= 1
        if let tap = eventTap {
            CGEvent.tapEnable(tap: tap, enable: false)
            CFMachPortInvalidate(tap)
        }
        if let source = eventSource { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        eventTap = nil
        eventSource = nil
        inputState.clear()
        enabled = false
        audio?.stop()
        flushStatistics()
        refreshContext()
        log.notice("Input feedback deactivated")
    }

    public func shutdown() {
        deactivate()
        boundaryTimer?.invalidate()
        persistenceWork?.cancel()
        for observer in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    public func preview(_ profile: ClickySwitch? = nil, release: Bool = false, position: Float = 0) {
        play(profile: profile ?? preferences.selectedSwitch, release: release, pan: position)
    }

    public func previewStroke(_ profile: ClickySwitch? = nil, position: Float = 0) {
        let chosen = profile ?? preferences.selectedSwitch
        preview(chosen, position: position)
        guard preferences.releaseSounds else { return }
        let generation = previewGeneration
        Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(85)) } catch { return }
            guard let self, self.previewGeneration == generation, self.preferences.releaseSounds else { return }
            self.preview(chosen, release: true, position: position)
        }
    }

    public func snooze(minutes: Int) {
        sleepingUntil = Date().addingTimeInterval(Double(minutes) * 60)
        audio?.stop()
        inputState.clear()
        refreshContext()
    }

    public func resume() {
        sleepingUntil = nil
        refreshContext()
    }

    public func dismissError() { error = nil }

    public func resetStatistics() {
        statistics = ClickyStatistics()
        pendingStats = true
        flushStatistics()
    }

    public func requestNotifications() {
        guard !previewOnly else {
            notificationStatus = "Unavailable in preview"
            return
        }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) {
            [weak self] granted, error in
            Task { @MainActor in
                self?.notificationStatus = granted ? "Allowed" : "Not allowed"
                self?.preferences.notifications = granted
                if let error { self?.error = error.localizedDescription }
            }
        }
    }

    public func openInputSettings() {
        if let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent") {
            NSWorkspace.shared.open(url)
        }
    }

    public func excludeApplication() {
        let panel = NSOpenPanel()
        panel.title = "Mute Clicky in an application"
        panel.directoryURL = URL(fileURLWithPath: "/Applications", isDirectory: true)
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.applicationBundle]
        panel.begin { [weak self] response in
            MainActor.assumeIsolated {
                guard response == .OK, let url = panel.url, let bundleID = Bundle(url: url)?.bundleIdentifier else {
                    return
                }
                self?.preferences.excludedApplications.append(bundleID)
            }
        }
    }

    private func savePreferences() {
        if let data = try? JSONEncoder().encode(preferences) { defaults.set(data, forKey: "clicky.preferences.v1") }
        refreshContext()
    }

    private func flushStatistics() {
        guard pendingStats else { return }
        if let data = try? JSONEncoder().encode(statistics) { defaults.set(data, forKey: "clicky.statistics.v1") }
        pendingStats = false
    }

    private func workspaceChanged(_ note: Notification) {
        if note.name == NSWorkspace.willSleepNotification || note.name == NSWorkspace.screensDidSleepNotification {
            systemSleeping = true
            inputState.clear()
            audio?.stop()
            flushStatistics()
        } else if note.name == NSWorkspace.didWakeNotification || note.name == NSWorkspace.screensDidWakeNotification {
            systemSleeping = false
        }
        refreshContext()
    }

    private func refreshContext() {
        let frontmost = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? ""
        excluded = preferences.excludedApplications.contains(frontmost)
        if let until = sleepingUntil, until <= Date() { sleepingUntil = nil }
        if !enabled {
            status = "Clicky is off"
        } else if systemSleeping {
            status = "Paused while your Mac sleeps"
        } else if sleepingUntil != nil {
            status = "Taking a break"
        } else if preferences.isQuiet(at: Date()) {
            status = "Quiet hours"
        } else if excluded {
            status = "Muted for this application"
        } else {
            status = "Listening for key presses"
        }
        if isPaused {
            inputState.clear()
            audio?.stop()
        }
        boundaryTimer?.invalidate()
        let dates = [preferences.nextQuietBoundary(after: Date()), sleepingUntil].compactMap { $0 }
        if let next = dates.min() {
            boundaryTimer = Timer(fire: next, interval: 0, repeats: false) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshContext() }
            }
            RunLoop.main.add(boundaryTimer!, forMode: .common)
        }
        stateDidChange?()
    }

    private func receive(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            deactivate()
            error = "macOS paused input monitoring. Click Enable Clicky to restart it."
            return
        }
        guard !IsSecureEventInputEnabled() else {
            inputState.clear()
            return
        }
        let repeated = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        guard
            ClickyEventPolicy.accepts(
                enabled: enabled, secureInput: false, sleeping: isPaused,
                quiet: false, excluded: excluded, repeated: false,
                repeatSounds: preferences.repeatSounds)
        else {
            inputState.clear()
            return
        }
        let code = UInt16(clamping: event.getIntegerValueField(.keyboardEventKeycode))
        let release: Bool
        if type == .flagsChanged {
            release = !CGEventSource.keyState(.combinedSessionState, key: CGKeyCode(code))
        } else {
            release = type == .keyUp
        }
        guard
            let transition = inputState.transition(
                keyCode: code, release: release, repeated: repeated,
                repeatSounds: preferences.repeatSounds)
        else { return }
        if preferences.collectStats && (transition.countsPress || transition.release) {
            if transition.release { statistics.releases += 1 } else { statistics.presses += 1 }
            pendingStats = true
            if persistenceWork == nil {
                let work = DispatchWorkItem { [weak self] in
                    MainActor.assumeIsolated {
                        self?.flushStatistics()
                        self?.persistenceWork = nil
                    }
                }
                persistenceWork = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 30, execute: work)
            }
        }
        guard !release || preferences.releaseSounds else { return }
        play(profile: preferences.selectedSwitch, release: release, pan: ClickyEventPolicy.pan(keyCode: code))
    }

    private func play(profile: ClickySwitch, release: Bool, pan: Float) {
        if audio == nil { audio = ClickyAudio() }
        do {
            try audio?.play(profile: profile, release: release, preferences: preferences, pan: pan)
            if preferences.visualizer {
                lastPan = pan
                pulse &+= 1
            }
        } catch {
            self.error = "Audio could not start: \(error.localizedDescription)"
            log.error("Audio output failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func notify(_ title: String, body: String) {
        guard preferences.notifications, !previewOnly else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        UNUserNotificationCenter.current().add(
            UNNotificationRequest(
                identifier: "clicky.status", content: content,
                trigger: nil)
        ) { [weak self] error in
            if let error {
                Task { @MainActor in
                    self?.log.error("Notification failed: \(error.localizedDescription, privacy: .public)")
                }
            }
        }
    }
}
