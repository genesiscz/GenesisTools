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
final class FocusOrchestrator: ObservableObject {
    static let shared = FocusOrchestrator()

    /// Wired into status chrome + recovery banner.
    @Published private(set) var isActive = false
    @Published private(set) var activeReason: String?
    @Published private(set) var suppressesSystemNotifications = false
    /// One-shot message after crash recovery (UI clears after display).
    @Published var recoveryNotice: String?

    struct Snapshot: Codable, Equatable {
        var previousMode: String
        var setAt: Int
        var reason: String
        /// `appLocal` (default) or `shortcuts`.
        var integration: String
        var suppressSystemNotifications: Bool
        /// Shortcut name at begin time — recovery must not use a later-renamed config.
        var shortcutName: String?

        init(
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

    enum Integration: String, Codable {
        case appLocal
        case shortcuts
    }

    enum ModeLabel {
        static let off = "off"
        static let genesisListening = "genesis-listening"
    }

    /// Config keys under `app` in `~/.genesis/client.json`.
    enum ConfigKey {
        static let focusWhileListening = "focusWhileListening"
        static let focusShortcutName = "focusShortcutName"
    }

    /// Default product path for production installs (nonisolated for default args).
    nonisolated static var defaultStateURL: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".genesis/focus-snapshot.json")
    }

    /// Injectable for tests (temp dir) — default is real home path.
    private(set) var stateURL: URL
    private let fileManager: FileManager
    /// Opens Shortcuts URLs; injectable no-op in tests.
    var openURL: (URL) -> Void
    private var terminateObserver: NSObjectProtocol?

    init(
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
    var focusWhileListeningEnabled: Bool {
        get {
            if let v = ConfigStore.shared.app[ConfigKey.focusWhileListening] as? Bool { return v }
            return true
        }
        set { ConfigStore.shared.setAppValue(newValue, forKey: ConfigKey.focusWhileListening) }
    }

    var focusShortcutName: String {
        get { (ConfigStore.shared.app[ConfigKey.focusShortcutName] as? String) ?? "" }
        set { ConfigStore.shared.setAppValue(newValue, forKey: ConfigKey.focusShortcutName) }
    }

    // MARK: - Mode label (file-backed probe; not OS Focus id)

    func currentModeLabel() -> String {
        UserDefaults.standard.string(forKey: "genesis.focus.mode") ?? ModeLabel.off
    }

    func setModeLabel(_ mode: String) {
        UserDefaults.standard.set(mode, forKey: "genesis.focus.mode")
    }

    // MARK: - Lifecycle

    /// Snapshot prior mode, enable suppression, optional Shortcuts begin.
    /// Idempotent while a session is already active (returns existing snapshot).
    /// If a dangling snapshot exists after crash (`!isActive` but file present),
    /// recover first so `previousMode` cannot chain-corrupt to `genesis-listening`.
    @discardableResult
    func beginSession(reason: String = "genesis-voice") throws -> Snapshot {
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
        Log.app.info("focus session begin reason=\(reason) integration=\(integration.rawValue)")
        return snap
    }

    /// Restore prior mode, clear suppression, delete snapshot.
    @discardableResult
    func endSession() throws -> Snapshot? {
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
        Log.app.info("focus session end restored previousMode=\(snap.previousMode)")
        return snap
    }

    /// Call on app launch. If a snapshot remains (crash / force-quit), restore
    /// and surface a one-shot notice. Never leave suppression stuck on.
    /// When the prior session used Shortcuts integration, invoke the end phase
    /// so a user-authored macOS Focus shortcut is not left engaged.
    /// - Parameter skipShortcut: when true (implicit recover inside `beginSession`),
    ///   do not fire Shortcuts "end" (avoids end→begin race) and skip recovery notice.
    @discardableResult
    func recoverIfNeeded(skipShortcut: Bool = false) -> Snapshot? {
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
            Log.app.notice("focus crash recovery cleared snapshot reason=\(snap.reason) skipShortcut=\(skipShortcut)")
            return snap
        } catch {
            try? fileManager.removeItem(at: stateURL)
            clearLiveState()
            if !skipShortcut {
                recoveryNotice = "Cleared a corrupt notification-mute snapshot. Notifications are active."
            }
            Log.app.warning("focus recovery failed: \(error.localizedDescription)")
            return nil
        }
    }

    /// Voice path: begin only when Settings toggle is on. Failures are logged;
    /// voice must not block on Focus.
    func beginForVoiceIfEnabled() {
        guard focusWhileListeningEnabled else { return }
        do {
            try beginSession(reason: "genesis-voice")
        } catch {
            Log.app.warning("focus beginForVoice failed: \(error.localizedDescription)")
        }
    }

    func endForVoiceIfNeeded() {
        guard isActive || fileManager.fileExists(atPath: stateURL.path) else { return }
        do {
            _ = try endSession()
        } catch {
            Log.app.warning("focus endForVoice failed: \(error.localizedDescription)")
            clearLiveState()
            try? fileManager.removeItem(at: stateURL)
        }
    }

    /// Observe quit so we never leave a dangling session if the process exits cleanly.
    /// Ends **synchronously** on the main queue — a nested `Task` may not complete
    /// before process exit (P1 G4.2).
    func installTerminateHook() {
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

    func clearRecoveryNotice() {
        recoveryNotice = nil
    }

    // MARK: - File I/O

    func loadSnapshot() throws -> Snapshot {
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
            Log.app.warning("focus shortcut URL build failed name=\(trimmed)")
            return
        }
        openURL(url)
        Log.app.info("focus shortcut invoked phase=\(phase) name=\(trimmed)")
    }
}

// MARK: - Static facades (tests + call sites that prefer type-level API)

extension FocusOrchestrator {
    /// Production path used by unit tests that target the default shared URL.
    static var stateURL: URL { shared.stateURL }

    @discardableResult
    static func beginSession(reason: String = "genesis-voice") throws -> Snapshot {
        try shared.beginSession(reason: reason)
    }

    @discardableResult
    static func endSession() throws -> Snapshot? {
        try shared.endSession()
    }

    static func currentModeLabel() -> String {
        shared.currentModeLabel()
    }

    static func setModeLabel(_ mode: String) {
        shared.setModeLabel(mode)
    }
}
