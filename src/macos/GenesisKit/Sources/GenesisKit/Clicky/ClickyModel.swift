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
    let soundLibrary: ClickySoundLibrary
    private var librarySubscription: AnyCancellable?
    public var selectedSoundName: String { soundLibrary.active?.entry.name ?? preferences.selectedSwitch.name }
    public var selectedSoundDetail: String {
        soundLibrary.active.map { "\($0.entry.author) · \($0.entry.licence)" } ?? preferences.selectedSwitch.detail
    }
    @Published public private(set) var enabled = false
    @Published public private(set) var status = "Clicky is off"
    public private(set) var statistics: ClickyStatistics
    public let analytics = ClickyAnalyticsStore()
    @Published public private(set) var sleepingUntil: Date?
    @Published public private(set) var pulse = 0
    @Published public private(set) var lastPan: Float = 0
    @Published public private(set) var notificationAuthorization: UNAuthorizationStatus = .notDetermined
    @Published public private(set) var notificationBusy = false
    /// Bumped by each permission request, so a status read that started before it cannot overwrite its answer.
    private var notificationGeneration = 0
    public var notificationStatus: String {
        switch notificationAuthorization {
        case .authorized, .provisional, .ephemeral: return "Allowed"
        case .denied: return "Blocked in System Settings"
        case .notDetermined: return "Not requested"
        @unknown default: return "Unknown"
        }
    }
    public var notificationActionTitle: String {
        notificationAuthorization == .notDetermined ? "Allow notifications" : "Open Notification Settings"
    }
    public var notificationHelp: String {
        if notificationAuthorization == .denied {
            return "macOS is blocking notifications for \(applicationName). Open Notification Settings and turn on Allow notifications. Your activation preference is saved separately."
        }
        return "Activation notifications are sent when you enable Clicky. Banner style and sound are controlled in System Settings."
    }
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
    private let notificationClient: NativeNotificationClient

    public init(
        defaults: UserDefaults = .standard, previewOnly: Bool = false, appearance: NativeSettingsAppearance? = nil,
        inputMonitor: (any ClickyInputMonitoring)? = nil, observeSystemEvents: Bool = true,
        notificationClient: NativeNotificationClient? = nil
    ) {
        self.defaults = defaults
        soundLibrary = ClickySoundLibrary(defaults: defaults)
        self.previewOnly = previewOnly
        self.notificationClient = notificationClient ?? .system
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
        analytics.flush(statistics)
        if defaults.data(forKey: "clicky.preferences.v1") != nil {
            self.appearance.migrateIfNeeded(
                reduceMotion: preferences.reduceMotion,
                reduceTransparency: preferences.reduceTransparency)
        }
        syncAppearance()
        appearanceSubscription = self.appearance.objectWillChange.sink { [weak self] _ in
            Task { @MainActor in self?.syncAppearance() }
        }
        soundLibrary.install = { [weak self] reference, pack in
            guard let self else { throw ClickyPackError.invalid("Clicky is no longer available.") }
            if self.audio == nil { self.audio = ClickyAudio() }
            try self.audio?.install(reference: reference, pack: pack)
            self.previewGeneration &+= 1
            self.inputState.clear()
            self.preferences.selectedPack = reference
        }
        librarySubscription = soundLibrary.objectWillChange.sink { [weak self] _ in
            self?.objectWillChange.send()
        }
        soundLibrary.restore(preferences.selectedPack)
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
        observers.append(NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in await self?.refreshNotificationPermission() }
        })
        Task { [weak self] in await self?.refreshNotificationPermission() }
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
            analytics.flush(statistics)
            pendingStats = true
        }
        refreshContext()
        notify("Clicky enabled", body: "Your selected switch is \(selectedSoundName).")
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
        statistics.breakTypingBurst()
        enabled = false
        audio?.stop()
        flushStatistics()
        refreshContext()
        log.notice("Input feedback deactivated")
    }

    public func shutdown() {
        soundLibrary.stop()
        deactivate()
        boundaryTimer?.invalidate()
        persistenceWork?.cancel()
        for observer in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            NotificationCenter.default.removeObserver(observer)
        }
        observers.removeAll()
    }

    public func selectBuiltIn(_ profile: ClickySwitch) {
        soundLibrary.useBuiltIn()
        audio?.useBuiltIn()
        previewGeneration &+= 1
        inputState.clear()
        statistics.breakTypingBurst()
        preferences.selectedPack = nil
        preferences.selectedSwitch = profile
    }

    func removeSoundLibrary(_ id: String) {
        if preferences.selectedPack?.libraryID == id { selectBuiltIn(preferences.selectedSwitch) }
        soundLibrary.remove(id)
    }

    public func preview(_ profile: ClickySwitch? = nil, release: Bool = false, position: Float = 0) {
        if let profile {
            play(profile: profile, release: release, pan: position)
        } else {
            playSelected(keyCode: 0, release: release, preview: true, pan: position)
        }
    }

    public func previewStroke(_ profile: ClickySwitch? = nil, position: Float = 0) {
        preview(profile, position: position)
        let generation = previewGeneration
        Task { @MainActor [weak self] in
            do { try await Task.sleep(for: .milliseconds(85)) } catch { return }
            guard let self, self.previewGeneration == generation else { return }
            if profile == nil || self.preferences.releaseSounds {
                self.preview(profile, release: true, position: position)
            }
        }
    }

    public func snooze(minutes: Int) {
        sleepingUntil = Date().addingTimeInterval(Double(minutes) * 60)
        audio?.stop()
        inputState.clear()
        statistics.breakTypingBurst()
        refreshContext()
    }

    public func resume() {
        sleepingUntil = nil
        refreshContext()
    }

    public func dismissError() { error = nil }

    public func resetStatistics() {
        statistics = ClickyStatistics()
        analytics.flush(statistics)
        pendingStats = true
        flushStatistics()
    }

    public func refreshNotificationPermission() async {
        guard !previewOnly, !notificationBusy else { return }
        let generation = notificationGeneration
        let status = await notificationClient.status()
        // A request that started and finished while this read was suspended has the newer answer.
        guard generation == notificationGeneration, !notificationBusy else { return }
        notificationAuthorization = status
    }

    public func setActivationNotifications(_ enabled: Bool) {
        preferences.notifications = enabled
        if enabled && notificationAuthorization == .notDetermined { requestNotifications() }
    }

    public func requestNotifications() {
        Task { await performNotificationAction() }
    }

    public func performNotificationAction() async {
        guard !previewOnly, !notificationBusy else { return }
        notificationGeneration &+= 1
        notificationBusy = true
        defer { notificationBusy = false }
        error = nil
        notificationAuthorization = await notificationClient.status()
        if notificationAuthorization == .notDetermined {
            do {
                let granted = try await notificationClient.request()
                notificationAuthorization = granted ? .authorized : .denied
                if !granted { error = "Notifications are blocked. You can enable them in Notification Settings." }
            } catch {
                self.error = "Could not request notifications: \(error.localizedDescription)"
                log.error("Notification permission failed: \(error.localizedDescription, privacy: .public)")
            }
        } else if !notificationClient.openSettings() {
            error = "Could not open Notification Settings. Open System Settings → Notifications → \(applicationName)."
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
        if previous.collectStats != preferences.collectStats { statistics.breakTypingBurst() }
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
        analytics.flush(statistics)
        guard pendingStats else { return }
        if let data = try? JSONEncoder().encode(statistics) { defaults.set(data, forKey: "clicky.statistics.v1") }
        pendingStats = false
    }

    private func workspaceChanged(_ note: Notification) {
        if note.name == NSWorkspace.willSleepNotification || note.name == NSWorkspace.screensDidSleepNotification {
            systemSleeping = true
            inputState.clear()
            statistics.breakTypingBurst()
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
            statistics.breakTypingBurst()
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
        if type == .tapDisabledByTimeout {
            inputState.clear()
            inputMonitor.reenable()
            return
        }
        if type == .tapDisabledByUserInput {
            deactivate()
            error = "macOS paused input monitoring. Click Enable Clicky to restart it."
            return
        }
        guard !IsSecureEventInputEnabled() else {
            inputState.clear()
            statistics.breakTypingBurst()
            audio?.clearHeldKeys()
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
            statistics.breakTypingBurst()
            audio?.clearHeldKeys()
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
            statistics.record(keyCode: code, release: transition.release,
                at: ClickyInputTime.date(timestampNanoseconds: event.timestamp),
                shortcut: event.flags.contains(.maskCommand) || event.flags.contains(.maskControl))
            analytics.stage { [weak self] in self?.statistics }
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
        playSelected(keyCode: code, release: release, preview: false, pan: ClickyEventPolicy.pan(keyCode: code))
    }

    private func playSelected(keyCode: UInt16, release: Bool, preview: Bool, pan: Float) {
        if audio == nil { audio = ClickyAudio() }
        do {
            let imported = try audio?.playSelected(keyCode: keyCode, release: release, preview: preview,
                                                   preferences: preferences, pan: pan) ?? false
            if !imported && (!release || preferences.releaseSounds) {
                try audio?.play(profile: preferences.selectedSwitch, release: release, preferences: preferences, pan: pan)
            }
            if preferences.visualizer && (!release || preferences.releaseSounds) {
                lastPan = pan
                pulse &+= 1
            }
        } catch {
            self.error = "Audio could not start: \(error.localizedDescription)"
            log.error("Audio output failed: \(error.localizedDescription, privacy: .public)")
        }
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
