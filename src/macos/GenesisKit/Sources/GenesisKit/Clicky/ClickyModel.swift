import AppKit
import Carbon.HIToolbox
import Combine
import CoreGraphics
import Foundation
import UserNotifications
import os

@MainActor
public final class ClickyModel: ObservableObject {
    @Published public var preferences: ClickyPreferences { didSet { savePreferences(previous: oldValue) } }
    public let appearance: NativeSettingsAppearance
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
    var settingsDefaults: UserDefaults { defaults }
    private var appearanceSubscription: AnyCancellable?
    private var syncingAppearance = false
    private let log = Logger(subsystem: "dev.genesis.tools", category: "Clicky")
    private var audio: ClickyAudio?
    private var previewGeneration = 0
    private let inputMonitor: any ClickyInputMonitoring
    private var observers: [NSObjectProtocol] = []
    private var boundaryTimer: Timer?
    private var inputState = ClickyInputState()
    private var systemSleeping = false
    private var excluded = false
    private var pendingStats = false
    private var persistenceWork: DispatchWorkItem?
    private let previewOnly: Bool

    public init(
        defaults: UserDefaults = .standard, previewOnly: Bool = false, appearance: NativeSettingsAppearance? = nil,
        inputMonitor: (any ClickyInputMonitoring)? = nil, observeSystemEvents: Bool = true
    ) {
        self.defaults = defaults
        self.previewOnly = previewOnly
        self.inputMonitor = inputMonitor ?? SystemClickyInputMonitor()
        self.appearance =
            appearance ?? NativeSettingsAppearance(defaults: defaults, observeExternalChanges: !previewOnly)
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
        if defaults.data(forKey: "clicky.preferences.v1") != nil {
            self.appearance.migrateIfNeeded(
                reduceMotion: preferences.reduceMotion,
                reduceTransparency: preferences.reduceTransparency)
        }
        syncAppearance()
        appearanceSubscription = self.appearance.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in self?.syncAppearance() }
        }
        guard !previewOnly && observeSystemEvents else { return }
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

    public var applicationName: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? ProcessInfo.processInfo.processName
    }

    public var hasInputPermission: Bool { inputMonitor.hasPermission }
    public var isPaused: Bool {
        systemSleeping || preferences.isQuiet(at: Date()) || excluded || (sleepingUntil.map { $0 > Date() } ?? false)
    }
    public var version: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.0"
    }

    public func activate() {
        guard !previewOnly else {
            error = "Live input is disabled during snapshot capture. Sound previews still work."
            return
        }
        guard !enabled else { return }
        error = nil
        guard inputMonitor.hasPermission || inputMonitor.requestPermission() else {
            permissionNeeded()
            return
        }
        switch inputMonitor.start(handler: { [weak self] type, event in self?.receive(type: type, event: event) }) {
        case .permissionRequired:
            permissionNeeded()
            return
        case .unavailable:
            status = "Input Monitoring could not start"
            error = "macOS could not start Input Monitoring for \(applicationName). Check the permission and try again."
            stateDidChange?()
            log.error("Listen-only event tap creation failed")
            return
        case .started: break
        }
        if audio == nil { audio = ClickyAudio() }
        enabled = true
        if preferences.collectStats {
            statistics.sessions += 1
            pendingStats = true
        }
        refreshContext()
        notify("Clicky enabled", body: "Your selected switch is \(preferences.selectedSwitch.name).")
        log.notice("Input feedback activated; no input content is retained")
    }

    private func permissionNeeded() {
        status = "Input Monitoring permission needed"
        error = "Allow Input Monitoring for \(applicationName) in System Settings, then enable Clicky again."
        stateDidChange?()
        log.notice("Activation needs Input Monitoring permission")
    }

    public func deactivate() {
        previewGeneration &+= 1
        inputMonitor.stop()
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
                guard response == .OK, let url = panel.url, let bundleID = Bundle(url: url)?.bundleIdentifier,
                    let self, !self.preferences.excludedApplications.contains(bundleID)
                else {
                    return
                }
                self.preferences.excludedApplications.append(bundleID)
            }
        }
    }

    private func syncAppearance() {
        var updated = preferences
        updated.reduceMotion = appearance.reduceMotion
        updated.reduceTransparency = appearance.reduceTransparency
        guard updated != preferences else { return }
        syncingAppearance = true
        preferences = updated
        syncingAppearance = false
    }

    private func savePreferences(previous: ClickyPreferences) {
        if !syncingAppearance {
            if previous.reduceMotion != preferences.reduceMotion { appearance.reduceMotion = preferences.reduceMotion }
            if previous.reduceTransparency != preferences.reduceTransparency {
                appearance.reduceTransparency = preferences.reduceTransparency
            }
        }
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
        let diagnosticStart = ClickyInputDiagnostics.enabled ? PerfLog.now() : nil
        let diagnosticSource = event.getIntegerValueField(.eventSourceUnixProcessID) == 0 ? "device" : "posted"
        defer { PerfLog.since("clicky.receive.\(diagnosticSource).\(type.rawValue)", diagnosticStart) }
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
        else {
            if ClickyInputDiagnostics.enabled {
                PerfLog.mark("clicky.transition.\(diagnosticSource).\(type.rawValue).ignored")
            }
            return
        }
        if ClickyInputDiagnostics.enabled {
            PerfLog.mark("clicky.transition.\(diagnosticSource).\(type.rawValue).accepted")
        }
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
