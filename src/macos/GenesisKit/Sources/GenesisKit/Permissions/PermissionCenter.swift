import AppKit
import Combine
import Foundation

/// Who noticed that a grant is missing.
public enum PermissionTrigger: Sendable, Equatable {
    /// The user pressed something that needs the grant: the dialog always shows.
    case userAction
    /// The app noticed on its own (a launch, a background start, a side effect of a turn). After the user closes
    /// the dialog with "Not now", this process stops showing it for this kind.
    case automatic
}

/// A feature that needs a grant it does not have.
public struct PermissionNeed {
    public let kind: PermissionKind
    /// One or two sentences: what the feature does with the grant.
    public var reason: String
    public var trigger: PermissionTrigger
    /// The grant is used by a new process (a screenshot taken by `screencapture`), so a grant this process cannot
    /// see yet still counts and no relaunch is needed.
    public var grantWorksInNewProcess: Bool
    /// Runs once when the grant arrives while the dialog is open (a retry of the action that needed it).
    public var onGranted: (@MainActor () -> Void)?

    public init(
        _ kind: PermissionKind, reason: String? = nil, trigger: PermissionTrigger = .userAction,
        grantWorksInNewProcess: Bool = false, onGranted: (@MainActor () -> Void)? = nil
    ) {
        self.kind = kind
        self.reason = reason ?? kind.reason
        self.trigger = trigger
        self.grantWorksInNewProcess = grantWorksInNewProcess
        self.onGranted = onGranted
    }
}

/// Puts a dialog on screen. `PermissionPanelPresenter` is the real one; tests record.
@MainActor
public protocol PermissionPresenting: AnyObject {
    func present(_ dialog: PermissionDialogModel, takesFocus: Bool)
    func bringToFront(_ dialog: PermissionDialogModel)
    func close(_ dialog: PermissionDialogModel)
}

/// Shows nothing and remembers what it was asked. A test process gets this one as the shared presenter.
@MainActor
public final class RecordingPermissionPresenter: PermissionPresenting {
    public private(set) var presented: [PermissionKind] = []
    public private(set) var fronted: [PermissionKind] = []
    public private(set) var closed: [PermissionKind] = []

    public init() {}

    public func present(_ dialog: PermissionDialogModel, takesFocus: Bool) { presented.append(dialog.kind) }
    public func bringToFront(_ dialog: PermissionDialogModel) { fronted.append(dialog.kind) }
    public func close(_ dialog: PermissionDialogModel) { closed.append(dialog.kind) }
}

/// Every grant denied and nothing ever sent to macOS: the shared center of a test process reads this.
struct OfflinePermissionSystem: PermissionSystem {
    func status(_ kind: PermissionKind) -> PermissionStatus { .denied }
    func request(_ kind: PermissionKind) async -> PermissionStatus { .denied }
    @MainActor func openSettings(_ kind: PermissionKind) -> Bool { false }
}

/// The one place a missing grant goes. It shows one dialog per kind at a time (a second need for the same kind joins
/// the open dialog), grants in place where macOS allows it, otherwise explains and opens the exact System Settings
/// pane, and closes the dialog when the grant arrives.
@MainActor
public final class PermissionCenter {
    public static let shared = PermissionCenter.makeShared()

    public let access: PermissionAccess
    let presenter: any PermissionPresenting
    private let freshProbe: (PermissionKind) async -> PermissionStatus?
    private let relauncher: @MainActor () -> Bool
    private let lock: PermissionDialogLock?
    /// How often an open dialog reads the grant again, and for how long.
    let pollInterval: Duration
    let pollDeadline: Duration
    /// How long the "is on" confirmation stays before the dialog closes itself.
    let closeDelay: Duration
    /// Brings the app forward before a macOS prompt, which comes up over the active app.
    let activateForPrompt: @MainActor () -> Void

    public private(set) var dialogs: [PermissionKind: PermissionDialogModel] = [:]
    /// Kinds the user closed with "Not now": automatic needs for them no longer show in this process.
    public private(set) var dismissed: Set<PermissionKind> = []
    /// Runs when the last open dialog closes (`GenesisTools --permission-dialog` quits then).
    public var onAllDialogsClosed: (@MainActor () -> Void)?

    public init(
        access: PermissionAccess = .live, presenter: any PermissionPresenting,
        freshProbe: @escaping (PermissionKind) async -> PermissionStatus? = { _ in nil },
        relaunch: @escaping @MainActor () -> Bool = { false }, lock: PermissionDialogLock? = nil,
        pollInterval: Duration = .milliseconds(1500), pollDeadline: Duration = .seconds(600),
        closeDelay: Duration = .milliseconds(900),
        activateForPrompt: @escaping @MainActor () -> Void = { NSApp?.activate(ignoringOtherApps: true) }
    ) {
        self.access = access
        self.presenter = presenter
        self.freshProbe = freshProbe
        relauncher = relaunch
        self.lock = lock
        self.pollInterval = pollInterval
        self.pollDeadline = pollDeadline
        self.closeDelay = closeDelay
        self.activateForPrompt = activateForPrompt
        lock?.onFrontRequest = { [weak self] kind in
            guard let self, let open = self.dialogs[kind] else { return }
            self.presenter.bringToFront(open)
        }
    }

    private static func makeShared() -> PermissionCenter {
        // A test process never puts a panel on the screen of the person running it, and never reaches TCC through
        // the shared center: every grant reads as denied and no request leaves the process.
        if PermissionCenter.isTestProcess {
            return PermissionCenter(access: PermissionAccess(system: OfflinePermissionSystem()),
                                    presenter: RecordingPermissionPresenter(), activateForPrompt: {})
        }

        return PermissionCenter(
            presenter: PermissionPanelPresenter(),
            freshProbe: { kind in await GenesisKit.host?.freshPermissionStatus(kind) },
            relaunch: { PermissionRelaunch.relaunchCurrentProcess() },
            lock: PermissionDialogLock.forThisApp())
    }

    nonisolated static var isTestProcess: Bool {
        NSClassFromString("XCTestCase") != nil || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil
    }

    public func status(_ kind: PermissionKind) -> PermissionStatus {
        access.status(kind)
    }

    public func isGranted(_ kind: PermissionKind) -> Bool {
        access.isGranted(kind)
    }

    /// Shows the dialog for `need` unless the grant is there. True when it is.
    @discardableResult
    public func require(_ need: PermissionNeed) -> Bool {
        let status = access.status(need.kind)
        if status.isGranted { return true }
        present(need, status: status)
        return false
    }

    /// As `require`, but a feature whose grant is used by a new process first asks what a new process reads, since
    /// this one may still hold an old answer. True when the feature can go ahead.
    public func ensure(_ need: PermissionNeed) async -> Bool {
        let status = access.status(need.kind)
        if status.isGranted { return true }
        if need.grantWorksInNewProcess, need.kind.cachedPerProcess {
            let elsewhere = status == .needsRelaunch ? true : await freshStatus(need.kind)?.isGranted == true
            if elsewhere {
                GenesisKit.log("permission \(need.kind.rawValue) granted for a new process; this one reads an old answer")
                return true
            }
        }

        present(need, status: status)
        return false
    }

    /// What a new process of this app reads: the simulation's answer, else the host's probe.
    func freshStatus(_ kind: PermissionKind) async -> PermissionStatus? {
        if let simulated = access.simulatedFreshStatus(kind) { return simulated }
        return await freshProbe(kind)
    }

    func relaunch() -> Bool {
        relauncher()
    }

    private func present(_ need: PermissionNeed, status: PermissionStatus) {
        if let open = dialogs[need.kind] {
            open.merge(need)
            presenter.bringToFront(open)
            GenesisKit.log("permission \(need.kind.rawValue) joined the open dialog")
            return
        }

        if need.trigger == .automatic, dismissed.contains(need.kind) {
            GenesisKit.log("permission \(need.kind.rawValue) missing; dialog not shown again after Not now")
            return
        }

        if let lock, !lock.acquire(need.kind) {
            lock.requestFront(need.kind)
            GenesisKit.log("permission \(need.kind.rawValue) dialog is open in another process")
            return
        }

        let dialog = PermissionDialogModel(need: need, status: status, center: self)
        dialogs[need.kind] = dialog
        GenesisKit.log("permission \(need.kind.rawValue) missing (\(status.wireValue)); dialog shown, trigger \(need.trigger)")
        presenter.present(dialog, takesFocus: need.trigger == .userAction)
        dialog.startWatching()
    }

    func close(_ dialog: PermissionDialogModel, dismissedByUser: Bool) {
        guard dialogs[dialog.kind] === dialog else { return }
        dialogs[dialog.kind] = nil
        if dismissedByUser { dismissed.insert(dialog.kind) }
        lock?.release(dialog.kind)
        presenter.close(dialog)
        GenesisKit.log("permission \(dialog.kind.rawValue) dialog closed (\(dismissedByUser ? "not now" : "granted"))")
        if dialogs.isEmpty { onAllDialogsClosed?() }
    }
}

/// One open dialog: the kind, why it is needed, what macOS reports, and the actions.
@MainActor
public final class PermissionDialogModel: ObservableObject, Identifiable {
    public enum Phase: Equatable {
        /// The grant is missing; the primary action asks macOS or opens System Settings.
        case asking
        /// A macOS request is open.
        case working
        /// System Settings is open; the dialog reads the grant until it arrives.
        case waiting
        /// System Settings shows the grant, but this process reads it only at launch.
        case relaunch
        /// The grant arrived; the dialog closes itself.
        case granted
    }

    public enum Action: Equatable {
        case allow, openSettings, relaunch
    }

    public nonisolated let kind: PermissionKind
    public let appName: String
    @Published public private(set) var reason: String
    @Published public private(set) var status: PermissionStatus
    @Published public private(set) var phase: Phase = .asking
    /// Feedback for the last action ("Still off…"), nil when there is none.
    @Published public private(set) var note: String?
    @Published public private(set) var checking = false

    private var needs: [PermissionNeed]
    private weak var center: PermissionCenter?
    private var poll: Task<Void, Never>?
    private var closing: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var lastFreshCheck: Date?

    init(need: PermissionNeed, status: PermissionStatus, center: PermissionCenter) {
        kind = need.kind
        reason = need.reason
        needs = [need]
        self.status = status
        self.center = center
        appName = Bundle.main.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String
            ?? Bundle.main.object(forInfoDictionaryKey: "CFBundleName") as? String
            ?? ProcessInfo.processInfo.processName
        if status == .needsRelaunch, !worksInNewProcess { phase = .relaunch }
    }

    public nonisolated var id: PermissionKind { kind }

    public var title: String {
        phase == .granted ? "\(kind.title) is on" : "Allow \(kind.title)"
    }

    public var primaryAction: Action {
        if phase == .relaunch { return .relaunch }
        switch kind.requestStyle {
        case .systemPrompt where status == .notDetermined: return .allow
        case .probe where status != .denied: return .allow
        default: return .openSettings
        }
    }

    public var primaryTitle: String {
        switch primaryAction {
        case .allow: return "Continue"
        case .openSettings: return "Open System Settings"
        case .relaunch: return "Relaunch \(appName)"
        }
    }

    /// What to do, in one or two sentences.
    public var instructions: String {
        if phase == .granted { return "\(appName) can use it now." }
        if phase == .relaunch {
            return "System Settings shows the grant, but \(appName) reads it only when it starts. Relaunch to use it."
        }

        if status == .restricted {
            return "This Mac's administrator or a profile blocks \(kind.title). Ask them to allow \(appName)."
        }

        if primaryAction == .allow {
            return kind.requestStyle == .probe
                ? "macOS asks the first time \(appName) uses it. Choose OK."
                : "macOS asks next. Choose Allow."
        }

        let location = kind.requestStyle == .probe && kind != .automation
            ? "Privacy & Security, then Files & Folders"
            : "Privacy & Security, then \(kind.title)"
        return "In System Settings, open \(location) and turn on \(appName). This window closes when the grant arrives."
    }

    /// Whether "Check again" makes sense (there is something to wait for).
    public var offersCheckAgain: Bool {
        phase != .granted && phase != .working && primaryAction != .allow
    }

    var worksInNewProcess: Bool {
        needs.allSatisfy(\.grantWorksInNewProcess)
    }

    func merge(_ need: PermissionNeed) {
        needs.append(need)
        if need.trigger == .userAction { reason = need.reason }
    }

    // MARK: - Actions

    public func primary() {
        switch primaryAction {
        case .allow: allow()
        case .openSettings: openSettings()
        case .relaunch: relaunch()
        }
    }

    public func allow() {
        guard let center, phase != .working else { return }
        phase = .working
        note = nil
        // The macOS prompt comes up over the active app; an accessory face asking from a panel activates first.
        center.activateForPrompt()
        let kind = self.kind
        Task { [weak self] in
            let result = await center.access.request(kind)
            guard let self else { return }
            self.status = result
            if result.isGranted {
                self.grant()
                return
            }

            self.phase = .asking
            self.note = result == .notDetermined ? "macOS did not answer. Try again." : nil
        }
    }

    public func openSettings() {
        guard let center, phase != .working else { return }
        note = nil
        Task { [weak self] in
            guard let self else { return }
            // Asking first puts the app in System Settings' list, so turning it on is one switch.
            if self.kind.requestStyle == .promptThenSettings {
                self.phase = .working
                self.status = await center.access.request(self.kind)
                if self.status.isGranted {
                    self.grant()
                    return
                }
            }

            let opened = center.access.openSettings(self.kind)
            self.phase = .waiting
            if !opened {
                self.note = "System Settings did not open. Open it from the Apple menu, then Privacy & Security."
            }
        }
    }

    public func checkAgain() {
        Task { await refresh(explicit: true) }
    }

    public func relaunch() {
        guard let center else { return }
        if !center.relaunch() {
            note = "\(appName) could not relaunch itself. Quit it and open it again."
        }
    }

    public func dismiss() {
        stopWatching()
        center?.close(self, dismissedByUser: true)
    }

    // MARK: - Watching for the grant

    func startWatching() {
        guard poll == nil, let center else { return }
        let interval = center.pollInterval
        let deadline = ContinuousClock.now.advanced(by: center.pollDeadline)
        poll = Task { [weak self] in
            while ContinuousClock.now < deadline {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                await self.refresh(explicit: false)
            }
        }
        // Coming back from System Settings activates another app; that is the moment a new grant is worth a look.
        observers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.checkAgainQuietly() }
        })
        if kind == .accessibility {
            // macOS posts this when an Accessibility grant changes; the trust database is written a moment later.
            observers.append(DistributedNotificationCenter.default().addObserver(
                forName: Notification.Name("com.apple.accessibility.api"), object: nil, queue: .main
            ) { [weak self] _ in
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                    MainActor.assumeIsolated { self?.checkAgainQuietly() }
                }
            })
        }
    }

    private func checkAgainQuietly() {
        Task { await refresh(explicit: false, fresh: true) }
    }

    private func stopWatching() {
        poll?.cancel()
        poll = nil
        for observer in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
            DistributedNotificationCenter.default().removeObserver(observer)
        }
        observers.removeAll()
    }

    /// Reads the grant again. A cached kind also asks a new process: on "Check again" always, otherwise at most
    /// every few seconds (each ask starts a process).
    func refresh(explicit: Bool, fresh: Bool = false) async {
        guard let center, phase != .granted, phase != .working else { return }
        let current = center.access.status(kind)
        if current != status { status = current }
        if current.isGranted {
            grant()
            return
        }

        if kind.cachedPerProcess, phase != .relaunch {
            var grantedElsewhere = current == .needsRelaunch
            let due = lastFreshCheck.map { Date().timeIntervalSince($0) > 3 } ?? true
            if !grantedElsewhere, explicit || (fresh && due) {
                lastFreshCheck = Date()
                if explicit { checking = true }
                grantedElsewhere = await center.freshStatus(kind)?.isGranted == true
                checking = false
            }

            if grantedElsewhere {
                if worksInNewProcess { grant() } else { phase = .relaunch }
                return
            }
        }

        if explicit {
            note = phase == .relaunch ? nil : "Still off. Turn on \(appName) in the list, then check again."
        }
    }

    private func grant() {
        guard phase != .granted else { return }
        phase = .granted
        status = .granted
        note = nil
        stopWatching()
        let callbacks = needs.compactMap(\.onGranted)
        needs.removeAll()
        for callback in callbacks { callback() }
        let delay = center?.closeDelay ?? .zero
        closing = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.center?.close(self, dismissedByUser: false)
        }
    }
}

/// One dialog per kind across this app's processes: a process holds `<kind>.lock` while its dialog is open, and a
/// second process asks it to come forward instead of opening another.
public final class PermissionDialogLock {
    private let directory: URL
    private let namespace: String
    private var descriptors: [PermissionKind: Int32] = [:]
    private var observer: NSObjectProtocol?
    var onFrontRequest: (@MainActor (PermissionKind) -> Void)? {
        didSet { observeFrontRequests() }
    }

    public init(directory: URL, namespace: String) {
        self.directory = directory
        self.namespace = namespace
    }

    /// `~/Library/Application Support/<bundle id>/permission-dialogs`; nil without a bundle id.
    public static func forThisApp() -> PermissionDialogLock? {
        guard let bundleID = Bundle.main.bundleIdentifier,
              let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        else { return nil }

        let directory = support.appendingPathComponent(bundleID, isDirectory: true)
            .appendingPathComponent("permission-dialogs", isDirectory: true)
        return PermissionDialogLock(directory: directory, namespace: bundleID)
    }

    func acquire(_ kind: PermissionKind) -> Bool {
        if descriptors[kind] != nil { return true }
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        } catch {
            GenesisKit.log("permission lock folder failed: \(error.localizedDescription); showing the dialog anyway")
            return true
        }

        let path = directory.appendingPathComponent("\(kind.rawValue).lock").path
        let descriptor = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else {
            GenesisKit.log("permission lock \(path) did not open (errno \(errno)); showing the dialog anyway")
            return true
        }

        guard flock(descriptor, LOCK_EX | LOCK_NB) == 0 else {
            close(descriptor)
            return false
        }

        descriptors[kind] = descriptor
        return true
    }

    func release(_ kind: PermissionKind) {
        guard let descriptor = descriptors.removeValue(forKey: kind) else { return }
        flock(descriptor, LOCK_UN)
        close(descriptor)
    }

    func requestFront(_ kind: PermissionKind) {
        DistributedNotificationCenter.default().postNotificationName(
            frontNotification, object: kind.rawValue, userInfo: nil, deliverImmediately: true)
    }

    private var frontNotification: Notification.Name {
        Notification.Name("\(namespace).permission-dialog.front")
    }

    private func observeFrontRequests() {
        guard observer == nil else { return }
        observer = DistributedNotificationCenter.default().addObserver(
            forName: frontNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let id = note.object as? String, let kind = PermissionKind(rawValue: id) else { return }
            MainActor.assumeIsolated { self?.onFrontRequest?(kind) }
        }
    }
}

/// Starts this face again with the same arguments once this process has exited, then quits. Faces hold a
/// single-instance lock until they exit, so the new one waits for the old pid (at most 15 s) before it starts.
public enum PermissionRelaunch {
    @MainActor
    public static func relaunchCurrentProcess() -> Bool {
        guard let executable = Bundle.main.executablePath else { return false }
        let pid = ProcessInfo.processInfo.processIdentifier
        let script = #"i=0; while kill -0 "$0" 2>/dev/null && [ "$i" -lt 75 ]; do i=$((i+1)); sleep 0.2; done; exec "$@""#
        let child = Process()
        child.executableURL = URL(fileURLWithPath: "/bin/sh")
        child.arguments = ["-c", script, String(pid), executable] + Array(CommandLine.arguments.dropFirst())
        child.standardInput = FileHandle.nullDevice
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        do {
            try child.run()
        } catch {
            GenesisKit.log("permission relaunch failed: \(error.localizedDescription)")
            return false
        }

        GenesisKit.log("permission relaunch: pid \(pid) quits, \(executable) starts again")
        if let app = NSApp {
            app.terminate(nil)
        } else {
            exit(0)
        }
        return true
    }
}
