// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/FocusOrchestrator.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import Foundation

/// Spec 17 S1 — Focus / DND session orchestration.
///
/// **Integration (research/s1-focus-dnd.md):** app-local mute of Genesis system
/// notifications is the production path. Optional best-effort Shortcuts URL if
/// the user names a shortcut in Settings. No private Focus SPI.
///
/// Snapshot file: `~/.genesis/focus-snapshot.json` (crash-safe restore).
@MainActor
public final class FocusOrchestrator: ObservableObject {
    public static var shared = FocusOrchestrator()

    /// Wired into status chrome + recovery banner.
    @Published public private(set) var isActive = false
    @Published public private(set) var activeReason: String?
    @Published public private(set) var suppressesSystemNotifications = false
    /// One-shot message after crash recovery (UI clears after display).
    @Published public var recoveryNotice: String?

    public struct Snapshot: Codable, Equatable {
        public var previousMode: String
        public var setAt: Int
        public var reason: String
        /// `appLocal` (default) or `shortcuts`.
        public var integration: String
        public var suppressSystemNotifications: Bool
        /// Shortcut name at begin time — recovery must not use a later-renamed config.
        public var shortcutName: String?

        public init(
            previousMode: String,
            setAt: Int,
            reason: String,
            integration: String = Integration.appLocal.rawValue,
            suppressSystemNotifications: Bool = true,
            shortcutName: String? = nil
        ) {
            self.previousMode = previousMode
            self.setAt = setAt
            self.reason = reason
            self.integration = integration
            self.suppressSystemNotifications = suppressSystemNotifications
            self.shortcutName = shortcutName
        }
    }

    public enum Integration: String, Codable {
        case appLocal
        case shortcuts
    }

    public enum ModeLabel {
        public static let off = "off"
        public static let genesisListening = "genesis-listening"
    }

    /// Config keys under `app` in `~/.genesis/client.json`.
    public enum ConfigKey {
        public static let focusWhileListening = "focusWhileListening"
        public static let focusShortcutName = "focusShortcutName"
    }

    /// Default product path for production installs (nonisolated for default args).
    public nonisolated static var defaultStateURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".genesis/focus-snapshot.json")
    }

    /// Injectable for tests (temp dir) — default is real home path.
    public private(set) var stateURL: URL
    private let fileManager: FileManager
    /// Opens Shortcuts URLs; injectable no-op in tests.
    public var openURL: (URL) -> Void
    private var terminateObserver: NSObjectProtocol?
    var remoteCommand: ((String, Data) -> Void)?
    var configuration = FlowFocusConfiguration.shared

    func configure(stateURL: URL) { self.stateURL = stateURL }

    var liveSnapshot: FocusDNDSnapshot {
        FocusDNDSnapshot(isActive: isActive, activeReason: activeReason,
                         suppressesSystemNotifications: suppressesSystemNotifications, recoveryNotice: recoveryNotice)
    }

    func applyRemote(_ snapshot: FocusDNDSnapshot) {
        guard remoteCommand != nil else { return }
        if isActive != snapshot.isActive { isActive = snapshot.isActive }
        if activeReason != snapshot.activeReason { activeReason = snapshot.activeReason }
        if suppressesSystemNotifications != snapshot.suppressesSystemNotifications {
            suppressesSystemNotifications = snapshot.suppressesSystemNotifications
        }
        if recoveryNotice != snapshot.recoveryNotice { recoveryNotice = snapshot.recoveryNotice }
    }

    func uninstallTerminateHook() {
        if let terminateObserver { NotificationCenter.default.removeObserver(terminateObserver) }
        terminateObserver = nil
    }

    public init(
        stateURL: URL? = nil,
        fileManager: FileManager = .default,
        openURL: ((URL) -> Void)? = nil
    ) {
        self.stateURL = stateURL ?? FocusOrchestrator.defaultStateURL
        self.fileManager = fileManager
        self.openURL = openURL ?? { NSWorkspace.shared.open($0) }
    }

    deinit {
        if let terminateObserver {
            NotificationCenter.default.removeObserver(terminateObserver)
        }
    }

    // MARK: - Config

    /// Default **on** — feature is useful daily; toggle still available.
    public var focusWhileListeningEnabled: Bool {
        get {
            if let v = configuration.app[ConfigKey.focusWhileListening] as? Bool { return v }
            return true
        }
        set { configuration.setAppValue(newValue, forKey: ConfigKey.focusWhileListening) }
    }

    public var focusShortcutName: String {
        get { (configuration.app[ConfigKey.focusShortcutName] as? String) ?? "" }
        set { configuration.setAppValue(newValue, forKey: ConfigKey.focusShortcutName) }
    }

    // MARK: - Mode label (file-backed probe; not OS Focus id)

    public func currentModeLabel() -> String {
        UserDefaults.standard.string(forKey: "genesis.focus.mode") ?? ModeLabel.off
    }

    public func setModeLabel(_ mode: String) {
        UserDefaults.standard.set(mode, forKey: "genesis.focus.mode")
    }

    // MARK: - Lifecycle

    /// Snapshot prior mode, enable suppression, optional Shortcuts begin.
    /// Idempotent while a session is already active (returns existing snapshot).
    /// If a dangling snapshot exists after crash (`!isActive` but file present),
    /// recover first so `previousMode` cannot chain-corrupt to `genesis-listening`.
    @discardableResult
    public func beginSession(reason: String = "genesis-voice") throws -> Snapshot {
        guard remoteCommand == nil else {
            throw FlowFocusMailbox.Failure.unavailable("Use the active Flow and Focus owner to begin a mute session.")
        }
        if isActive, let existing = try? loadSnapshot() {
            return existing
        }
        // Defense-in-depth: launch recover should have run, but manual/Workspace
        // begin or a missed launch path must not nest previousMode.
        // Skip Shortcuts end + recovery notice — we immediately begin mute again.
        if !isActive, fileManager.fileExists(atPath: stateURL.path) {
            _ = recoverIfNeeded(skipShortcut: true)
            clearRecoveryNotice()
        }

        let shortcut = focusShortcutName.trimmingCharacters(in: .whitespacesAndNewlines)
        let integration: Integration = shortcut.isEmpty ? .appLocal : .shortcuts

        let snap = Snapshot(
            previousMode: currentModeLabel(),
            setAt: Int(Date().timeIntervalSince1970 * 1000),
            reason: reason,
            integration: integration.rawValue,
            suppressSystemNotifications: true,
            shortcutName: shortcut.isEmpty ? nil : shortcut
        )
        try writeSnapshot(snap)
        setModeLabel(ModeLabel.genesisListening)
        applyLiveState(from: snap)
        invokeShortcutIfNeeded(name: shortcut, phase: "begin")
        FlowFocusLog.focus.info("focus session begin reason=\(reason) integration=\(integration.rawValue)")
        return snap
    }

    /// Restore prior mode, clear suppression, delete snapshot.
    @discardableResult
    public func endSession() throws -> Snapshot? {
        guard remoteCommand == nil else {
            throw FlowFocusMailbox.Failure.unavailable("Use the active Flow and Focus owner to end a mute session.")
        }
        guard fileManager.fileExists(atPath: stateURL.path) else {
            clearLiveState()
            return nil
        }
        let snap = try loadSnapshot()
        setModeLabel(snap.previousMode)
        try? fileManager.removeItem(at: stateURL)
        clearLiveState()
        let shortcut = shortcutName(for: snap)
        if snap.integration == Integration.shortcuts.rawValue || !shortcut.isEmpty {
            invokeShortcutIfNeeded(name: shortcut, phase: "end")
        }
        FlowFocusLog.focus.info("focus session end restored previousMode=\(snap.previousMode)")
        return snap
    }

    /// Call on app launch. If a snapshot remains (crash / force-quit), restore
    /// and surface a one-shot notice. Never leave suppression stuck on.
    /// When the prior session used Shortcuts integration, invoke the end phase
    /// so a user-authored macOS Focus shortcut is not left engaged.
    /// - Parameter skipShortcut: when true (implicit recover inside `beginSession`),
    ///   do not fire Shortcuts "end" (avoids end→begin race) and skip recovery notice.
    @discardableResult
    public func recoverIfNeeded(skipShortcut: Bool = false) -> Snapshot? {
        guard remoteCommand == nil else { return nil }
        guard fileManager.fileExists(atPath: stateURL.path) else {
            clearLiveState()
            return nil
        }
        do {
            let snap = try loadSnapshot()
            setModeLabel(snap.previousMode)
            try? fileManager.removeItem(at: stateURL)
            clearLiveState()
            // Best-effort Shortcuts end — Spec §7 never leave user stuck in DND
            // when they opted into a real Focus shortcut. Prefer snapshot name.
            if !skipShortcut {
                let shortcut = shortcutName(for: snap)
                if snap.integration == Integration.shortcuts.rawValue || !shortcut.isEmpty {
                    invokeShortcutIfNeeded(name: shortcut, phase: "end")
                }
                recoveryNotice =
                    "Restored notification-mute session after interrupt (\(snap.reason)). Genesis system notifications are active again."
            }
            FlowFocusLog.focus.notice("focus crash recovery cleared snapshot reason=\(snap.reason) skipShortcut=\(skipShortcut)")
            return snap
        } catch {
            try? fileManager.removeItem(at: stateURL)
            clearLiveState()
            if !skipShortcut {
                recoveryNotice = "Cleared a corrupt notification-mute snapshot. Notifications are active."
            }
            FlowFocusLog.focus.warning("focus recovery failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Voice path: begin only when Settings toggle is on. Failures are logged;
    /// voice must not block on Focus.
    public func beginForVoiceIfEnabled() {
        if let remoteCommand {
            if focusWhileListeningEnabled { remoteCommand("focus.dnd.begin", Data("genesis-voice".utf8)) }
            return
        }
        guard focusWhileListeningEnabled else { return }
        do {
            try beginSession(reason: "genesis-voice")
        } catch {
            FlowFocusLog.focus.warning("focus beginForVoice failed: \(error.localizedDescription)")
        }
    }

    public func endForVoiceIfNeeded() {
        if let remoteCommand { remoteCommand("focus.dnd.end", Data()); return }
        guard isActive || fileManager.fileExists(atPath: stateURL.path) else { return }
        do {
            _ = try endSession()
        } catch {
            FlowFocusLog.focus.warning("focus endForVoice failed: \(error.localizedDescription)")
            clearLiveState()
            try? fileManager.removeItem(at: stateURL)
        }
    }

    /// Observe quit so we never leave a dangling session if the process exits cleanly.
    /// Ends **synchronously** on the main queue — a nested `Task` may not complete
    /// before process exit (P1 G4.2).
    public func installTerminateHook() {
        guard remoteCommand == nil else { return }
        guard terminateObserver == nil else { return }
        terminateObserver = NotificationCenter.default.addObserver(
            forName: NSApplication.willTerminateNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            // queue: .main → same-runloop; do not hop Task before exit.
            guard let self else { return }
            MainActor.assumeIsolated {
                self.endForVoiceIfNeeded()
            }
        }
    }

    public func clearRecoveryNotice() {
        recoveryNotice = nil
    }

    // MARK: - File I/O

    public func loadSnapshot() throws -> Snapshot {
        let data = try Data(contentsOf: stateURL)
        return try JSONDecoder().decode(Snapshot.self, from: data)
    }

    private func writeSnapshot(_ snap: Snapshot) throws {
        let data = try JSONEncoder().encode(snap)
        try fileManager.createDirectory(
            at: stateURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try data.write(to: stateURL, options: .atomic)
    }

    private func applyLiveState(from snap: Snapshot) {
        isActive = true
        activeReason = snap.reason
        suppressesSystemNotifications = snap.suppressSystemNotifications
    }

    private func clearLiveState() {
        isActive = false
        activeReason = nil
        suppressesSystemNotifications = false
    }

    /// Prefer snapshot-captured name; fall back to live config only for legacy snapshots.
    private func shortcutName(for snap: Snapshot) -> String {
        if let s = snap.shortcutName?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty {
            return s
        }
        return focusShortcutName.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func invokeShortcutIfNeeded(name: String, phase: String) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Best-effort public URL scheme. User must author the shortcut.
        var components = URLComponents(string: "shortcuts://run-shortcut")
        components?.queryItems = [
            URLQueryItem(name: "name", value: trimmed),
            URLQueryItem(name: "input", value: "text"),
            URLQueryItem(name: "text", value: phase),
        ]
        guard let url = components?.url else {
            FlowFocusLog.focus.warning("focus shortcut URL build failed name=\(trimmed)")
            return
        }
        openURL(url)
        FlowFocusLog.focus.info("focus shortcut invoked phase=\(phase) name=\(trimmed)")
    }
}

// MARK: - Static facades (tests + call sites that prefer type-level API)

extension FocusOrchestrator {
    /// Production path used by unit tests that target the default shared URL.
    public static var stateURL: URL { shared.stateURL }

    @discardableResult
    public static func beginSession(reason: String = "genesis-voice") throws -> Snapshot {
        try shared.beginSession(reason: reason)
    }

    @discardableResult
    public static func endSession() throws -> Snapshot? {
        try shared.endSession()
    }

    public static func currentModeLabel() -> String {
        shared.currentModeLabel()
    }

    public static func setModeLabel(_ mode: String) {
        shared.setModeLabel(mode)
    }
}
