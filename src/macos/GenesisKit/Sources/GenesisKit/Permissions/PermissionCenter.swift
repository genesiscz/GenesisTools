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

    /// The same feature asking again automatically (a check that repeats while a dialog is open, here or in another
    /// process) is already waiting. Keeping every copy grows without end and runs its retry once per copy when the
    /// grant arrives; a user's request and a different feature are always kept.
    func repeatsAutomatically(in waiting: [PermissionNeed]) -> Bool {
        trigger == .automatic && waiting.contains { $0.trigger == .automatic && $0.reason == reason }
    }
}

/// Puts a dialog on screen. `PermissionPanelPresenter` is the real one; tests record.
@MainActor
public protocol PermissionPresenting: AnyObject {
    func present(_ dialog: PermissionDialogModel, takesFocus: Bool)
    /// A need that joins an open dialog: a user's request makes it key, an automatic one only orders it front.
    func bringToFront(_ dialog: PermissionDialogModel, takesFocus: Bool)
    func close(_ dialog: PermissionDialogModel)
}

/// Shows nothing and remembers what it was asked. A test process gets this one as the shared presenter.
@MainActor
public final class RecordingPermissionPresenter: PermissionPresenting {
    public private(set) var presented: [PermissionKind] = []
    public private(set) var fronted: [PermissionKind] = []
    /// The kinds shown or brought forward with keyboard focus.
    public private(set) var focused: [PermissionKind] = []
    public private(set) var closed: [PermissionKind] = []

    public init() {}

    public func present(_ dialog: PermissionDialogModel, takesFocus: Bool) {
        presented.append(dialog.kind)
        if takesFocus { focused.append(dialog.kind) }
    }

    public func bringToFront(_ dialog: PermissionDialogModel, takesFocus: Bool) {
        fronted.append(dialog.kind)
        if takesFocus { focused.append(dialog.kind) }
    }

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
            // Another process asked: it is not this process's user action, so the dialog takes no focus here.
            self.presenter.bringToFront(open, takesFocus: false)
        }
        lock?.onGrantAnnounced = { [weak self] kind in self?.verifyGrantElsewhere(kind) }
        // Coming back to this app (from System Settings, say) is when a revoked probe grant is worth a look.
        activationObserver = ObservationToken(NotificationCenter.default.addObserver(
            forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main
        ) { [weak self] _ in
            MainActor.assumeIsolated { self?.recheckGrantedProbesOnActivation() }
        })
    }

    /// Removes the observer when this center is released (tests create many centers).
    private var activationObserver: ObservationToken?
    private var lastGrantRecheck: Date?

    /// At most every 10 s: activating the app is frequent, and an Automation probe runs AppleScript.
    private func recheckGrantedProbesOnActivation() {
        if let lastGrantRecheck, Date().timeIntervalSince(lastGrantRecheck) < 10 { return }
        lastGrantRecheck = Date()
        Task { await recheckGrantedProbes() }
    }

    /// Probes the remembered grants of Automation and the folders again (`PermissionAccess.recheckGrantedProbes`),
    /// so a grant revoked in System Settings stops reading as granted and the next `require` asks again.
    public func recheckGrantedProbes() async {
        await access.recheckGrantedProbes()
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
            guard open.phase == .granted else {
                open.merge(need)
                // Only the user's request brings the open dialog forward (and makes it key): an automatic need asks
                // again on its own schedule, and lifting the dialog each time would cover whatever the user is doing.
                if need.trigger == .userAction { presenter.bringToFront(open, takesFocus: true) }
                GenesisKit.log("permission \(need.kind.rawValue) joined the open dialog")
                return
            }

            // The "is on" confirmation is showing and its callbacks already ran, so joining it would drop this need.
            if open.joinGranted(need) { return }
            if need.trigger == .automatic, dismissed.contains(need.kind) {
                GenesisKit.log("permission \(need.kind.rawValue) missing; dialog not shown again after Not now")
                return
            }

            replace(open, with: need, status: status)
            return
        }

        if need.trigger == .automatic, dismissed.contains(need.kind) {
            GenesisKit.log("permission \(need.kind.rawValue) missing; dialog not shown again after Not now")
            return
        }

        if let lock, !lock.acquire(need.kind) {
            // As for a dialog here: only the user's request lifts the other process's dialog over their work.
            if need.trigger == .userAction { lock.requestFront(need.kind) }
            GenesisKit.log("permission \(need.kind.rawValue) dialog is open in another process")
            waitForGrantElsewhere(need)
            return
        }

        let dialog = PermissionDialogModel(need: need, status: status, center: self)
        dialogs[need.kind] = dialog
        if let waiting = waitingElsewhere.removeValue(forKey: need.kind) {
            waiting.poll.cancel()
            waiting.needs.forEach(dialog.merge)
        }
        GenesisKit.log("permission \(need.kind.rawValue) missing (\(status.wireValue)); dialog shown, trigger \(need.trigger)")
        presenter.present(dialog, takesFocus: need.trigger == .userAction)
        dialog.startWatching()
        // A refusal remembered from an earlier probe may have been lifted in System Settings since.
        if need.kind.requestStyle == .probe, status == .denied { dialog.checkAgainQuietly() }
    }

    /// Needs whose dialog another process of this app shows. That process cannot run their `onGranted`, so this one
    /// reads the grant on the dialog's own interval, until its deadline, and runs them when it arrives. A grant this
    /// process reads only at launch never arrives here; the other dialog offers the relaunch, and the wait ends with
    /// the deadline. A probe kind (Automation, the three folders) has no silent read, so its grant is seen when the
    /// other dialog announces it (`verifyGrantElsewhere`).
    private var waitingElsewhere: [PermissionKind: (needs: [PermissionNeed], poll: Task<Void, Never>)] = [:]
    private var verifyingElsewhere: Set<PermissionKind> = []

    /// The dialog in another process saw the grant: its lock file says so. A probe kind has no silent read here, but
    /// macOS holds the answer now, so touching the resource once does not prompt; it confirms the grant reaches this
    /// process too, whatever an earlier probe here answered. Nothing is probed before that, so a waiting process never
    /// puts up a second macOS prompt.
    private func verifyGrantElsewhere(_ kind: PermissionKind) {
        guard waitingElsewhere[kind] != nil, !verifyingElsewhere.contains(kind),
              lock?.holderSawGrant(kind) == true else { return }
        verifyingElsewhere.insert(kind)
        Task { [weak self] in
            guard let self else { return }
            defer { self.verifyingElsewhere.remove(kind) }
            var current = self.access.status(kind)
            if kind.requestStyle == .probe, !current.isGranted, self.access.simulatedMode(kind) == nil {
                current = await self.access.request(kind)
            }
            guard current.isGranted else {
                GenesisKit.log("permission \(kind.rawValue) granted in another process, not here (\(current.wireValue)); still waiting")
                return
            }

            self.grantedElsewhere(kind)
        }
    }

    /// The dialog reached "granted": another process waiting on it can stop.
    func dialogGranted(_ kind: PermissionKind) {
        lock?.announceGranted(kind)
    }

    private func waitForGrantElsewhere(_ need: PermissionNeed) {
        guard need.onGranted != nil else { return }
        if let waiting = waitingElsewhere[need.kind] {
            if !need.repeatsAutomatically(in: waiting.needs) { waitingElsewhere[need.kind]?.needs.append(need) }
            return
        }

        let kind = need.kind
        let interval = pollInterval
        let deadline = ContinuousClock.now.advanced(by: pollDeadline)
        let poll = Task { [weak self] in
            while ContinuousClock.now < deadline {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                if self.access.status(kind).isGranted {
                    self.grantedElsewhere(kind)
                    return
                }
            }
            self?.waitingElsewhere[kind] = nil
        }
        waitingElsewhere[kind] = ([need], poll)
        // The other dialog may already show "is on": its announcement went out before this wait began.
        verifyGrantElsewhere(kind)
    }

    private func grantedElsewhere(_ kind: PermissionKind) {
        guard let waiting = waitingElsewhere.removeValue(forKey: kind) else { return }
        // Seen by the announcement, the poll is still running; at its deadline it would clear a later wait.
        waiting.poll.cancel()
        GenesisKit.log("permission \(kind.rawValue) granted through another process's dialog; \(waiting.needs.count) retries run here")
        for callback in waiting.needs.compactMap(\.onGranted) {
            callback()
        }
    }

    /// A need the granted dialog's grant does not reach (this process reads it only at launch, or it went away) gets a
    /// dialog of its own in place of the closing one. The kind's lock stays held and no "last dialog closed" fires,
    /// since a dialog stays open throughout.
    private func replace(_ open: PermissionDialogModel, with need: PermissionNeed, status: PermissionStatus) {
        open.didClose()
        presenter.close(open)
        let dialog = PermissionDialogModel(need: need, status: status, center: self)
        dialogs[need.kind] = dialog
        GenesisKit.log("permission \(need.kind.rawValue) still missing here after its dialog saw the grant; dialog shown again")
        presenter.present(dialog, takesFocus: need.trigger == .userAction)
        dialog.startWatching()
        // The grant usually exists for a new process, so the new dialog offers the relaunch without a click.
        dialog.checkAgainQuietly()
    }

    func close(_ dialog: PermissionDialogModel, dismissedByUser: Bool) {
        guard dialogs[dialog.kind] === dialog else { return }
        dialogs[dialog.kind] = nil
        dialog.didClose()
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
        /// The dialog stopped reading the grant after the center's `pollDeadline`; "Check again" reads it and waits
        /// again.
        case expired
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
    /// The dialog left its center ("Not now", ⌘W, or after a grant). A request or probe still awaiting macOS then
    /// finishes into nothing: no state change, no System Settings, and above all no `onGranted` the user opted out of.
    private(set) var closed = false
    private var runningCallbacks = false

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
        case .systemPrompt where kind.systemPromptAsks(from: status) && !declinedUpgrade: return .allow
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

        if status == .addOnly {
            return "\(appName) can add calendar events but not read them. In System Settings, open Privacy & Security, "
                + "then Calendars, and choose Full Access for \(appName). This window closes when the grant arrives."
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
        if need.repeatsAutomatically(in: needs) { return }
        needs.append(need)
        if need.trigger == .userAction { reason = need.reason }
    }

    /// A need that arrives during the "is on" confirmation. The grant this dialog saw covers a feature that runs in
    /// a new process, so its retry runs now and this returns true. A need raised by one of this dialog's own retries
    /// while they run is that retry again: it is dropped, so a retry that asks again cannot recurse. False means
    /// this process must read the grant itself and does not: the center gives the need a dialog of its own.
    func joinGranted(_ need: PermissionNeed) -> Bool {
        guard need.grantWorksInNewProcess, kind.cachedPerProcess else { return false }
        if runningCallbacks {
            GenesisKit.log("permission \(kind.rawValue) asked again by its own retry; not run twice")
            return true
        }

        GenesisKit.log("permission \(kind.rawValue) need joined after the grant; its retry runs now")
        run(need.onGranted.map { [$0] } ?? [])
        return true
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
            guard let self, !self.closed else { return }
            self.status = result
            if result.isGranted {
                self.grant()
                return
            }

            // An Add Only grant still Add Only after the full-access prompt: the user kept it, and only System
            // Settings changes it now.
            if result == .addOnly { self.declinedUpgrade = true }
            self.phase = .asking
            self.note = result == .notDetermined ? "macOS did not answer. Try again." : nil
        }
    }

    /// The full-access prompt for an Add Only grant was answered without upgrading it.
    private var declinedUpgrade = false

    public func openSettings() {
        guard let center, phase != .working else { return }
        note = nil
        Task { [weak self] in
            guard let self else { return }
            // Asking first puts the app in System Settings' list, so turning it on is one switch.
            if self.kind.requestStyle == .promptThenSettings {
                self.phase = .working
                let result = await center.access.request(self.kind)
                guard !self.closed else { return }
                self.status = result
                if result.isGranted {
                    self.grant()
                    return
                }
            }

            let opened = center.access.openSettings(self.kind)
            self.phase = .waiting
            // The wait that began with the dialog may have run out while it sat open.
            self.startPolling()
            if !opened {
                self.note = "System Settings did not open. Open it from the Apple menu, then Privacy & Security."
            }
        }
    }

    public func checkAgain() {
        if phase == .expired {
            phase = .waiting
            note = nil
            startPolling()
        }
        Task { await refresh(explicit: true) }
    }

    public func relaunch() {
        guard let center else { return }
        if !center.relaunch() {
            note = "\(appName) could not relaunch itself. Quit it and open it again."
        }
    }

    public func dismiss() {
        closed = true
        stopWatching()
        center?.close(self, dismissedByUser: true)
    }

    /// The center took this dialog off the screen; nothing awaiting macOS may act for it afterwards.
    func didClose() {
        closed = true
        stopWatching()
    }

    // MARK: - Watching for the grant

    func startWatching() {
        guard poll == nil, observers.isEmpty else { return }
        startPolling()
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

    /// Reads the grant on the center's interval until its deadline. At the deadline the task ends and is let go, so a
    /// later "Check again" or "Open System Settings" starts a new one; a dialog still waiting shows that it stopped.
    private func startPolling() {
        guard poll == nil, !closed, let center else { return }
        let interval = center.pollInterval
        let deadline = ContinuousClock.now.advanced(by: center.pollDeadline)
        poll = Task { [weak self] in
            while ContinuousClock.now < deadline {
                try? await Task.sleep(for: interval)
                guard !Task.isCancelled, let self else { return }
                await self.refresh(explicit: false)
            }
            guard !Task.isCancelled else { return }
            self?.pollExpired()
        }
    }

    private func pollExpired() {
        poll = nil
        guard !closed, phase == .waiting else { return }
        phase = .expired
        note = "Stopped waiting after \(PermissionDialogModel.minutes(center?.pollDeadline)). Turn on \(appName), then check again."
    }

    private static func minutes(_ duration: Duration?) -> String {
        let minutes = max(1, Int((duration?.components.seconds ?? 0) / 60))
        return minutes == 1 ? "a minute" : "\(minutes) minutes"
    }

    func checkAgainQuietly() {
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
        guard let center, !closed, phase != .granted, phase != .working else { return }
        var current = center.access.status(kind)
        if kind.requestStyle == .probe, !current.isGranted {
            // A probe kind has no silent read: `.unknown` says nothing new, so the dialog keeps what its last probe
            // answered. Once a probe was refused, macOS has the answer, so touching the resource again never
            // prompts: `recheck` tells a grant made in System Settings from a refusal. It runs on "Check again" and
            // when the user comes back from another app (System Settings), at most every few seconds, never on the
            // plain poll: each probe runs AppleScript or lists a folder.
            if case .unknown = current { current = status }
            if current == .denied {
                if status != current { status = current }
                let due = lastFreshCheck.map { Date().timeIntervalSince($0) > 3 } ?? true
                guard explicit || (fresh && due) else { return }
                lastFreshCheck = Date()
                if explicit { checking = true }
                current = await center.access.recheck(kind)
                checking = false
                guard !closed, phase != .granted, phase != .working else { return }
            }
        }
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
                guard !closed else { return }
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
        guard !closed, phase != .granted else { return }
        phase = .granted
        status = .granted
        note = nil
        stopWatching()
        center?.dialogGranted(kind)
        let callbacks = needs.compactMap(\.onGranted)
        needs.removeAll()
        run(callbacks)
        let delay = center?.closeDelay ?? .zero
        closing = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard let self, !Task.isCancelled else { return }
            self.center?.close(self, dismissedByUser: false)
        }
    }

    private func run(_ callbacks: [@MainActor () -> Void]) {
        runningCallbacks = true
        defer { runningCallbacks = false }
        for callback in callbacks { callback() }
    }
}

/// One dialog per kind across this app's processes: a process holds `<kind>.lock` while its dialog is open, and a
/// second process asks it to come forward instead of opening another.
public final class PermissionDialogLock {
    private let directory: URL
    private let namespace: String
    private var descriptors: [PermissionKind: Int32] = [:]
    private var observer: NSObjectProtocol?
    private var grantObserver: NSObjectProtocol?
    var onFrontRequest: (@MainActor (PermissionKind) -> Void)? {
        didSet { observeFrontRequests() }
    }
    /// Another process's dialog for this kind saw the grant. Only a wake-up: the lock file is what is read.
    var onGrantAnnounced: (@MainActor (PermissionKind) -> Void)? {
        didSet { observeGrants() }
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

        // A new dialog has seen no grant yet; the last holder's marker goes.
        if ftruncate(descriptor, 0) != 0 {
            GenesisKit.log("permission lock \(path) did not clear its grant marker (errno \(errno))")
        }
        descriptors[kind] = descriptor
        return true
    }

    /// The dialog holding this kind's lock saw the grant. The lock file says so for a process that starts waiting
    /// during the "is on" confirmation, and the processes already waiting are woken.
    func announceGranted(_ kind: PermissionKind) {
        guard let descriptor = descriptors[kind] else { return }
        let marker = Array(Self.grantedMarker.utf8)
        if pwrite(descriptor, marker, marker.count, 0) != marker.count {
            GenesisKit.log("permission lock \(kind.rawValue) did not record its grant (errno \(errno))")
        }
        DistributedNotificationCenter.default().postNotificationName(
            grantedNotification, object: kind.rawValue, userInfo: nil, deliverImmediately: true)
    }

    /// Whether the dialog that holds this kind's lock saw the grant (read after `acquire` failed).
    func holderSawGrant(_ kind: PermissionKind) -> Bool {
        let path = directory.appendingPathComponent("\(kind.rawValue).lock").path
        return FileManager.default.contents(atPath: path) == Data(Self.grantedMarker.utf8)
    }

    private static let grantedMarker = "granted"

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

    private var grantedNotification: Notification.Name {
        Notification.Name("\(namespace).permission-dialog.granted")
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

    private func observeGrants() {
        guard grantObserver == nil else { return }
        grantObserver = DistributedNotificationCenter.default().addObserver(
            forName: grantedNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let id = note.object as? String, let kind = PermissionKind(rawValue: id) else { return }
            MainActor.assumeIsolated { self?.onGrantAnnounced?(kind) }
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

/// A `NotificationCenter` observation that ends when its holder is released, so an owner needs no `deinit` (which a
/// `@MainActor` class cannot use to read its observer token).
final class ObservationToken {
    private let token: NSObjectProtocol
    private let center: NotificationCenter

    init(_ token: NSObjectProtocol, center: NotificationCenter = .default) {
        self.token = token
        self.center = center
    }

    deinit {
        center.removeObserver(token)
    }
}
