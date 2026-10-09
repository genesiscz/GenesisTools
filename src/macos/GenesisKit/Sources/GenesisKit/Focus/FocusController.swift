// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/FocusController.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import AppKit
import Combine
import Foundation
import SwiftUI

/// Spec 22 (S6) — the glue that makes the timer, the ledger and the CLI one feature.
///
/// Owns the store, the recorder and the engine; loads settings from `client.json`; arms DND
/// through `FocusOrchestrator` (spec 17) rather than re-solving it; and drains the intents
/// `genesis focus …` queues, so the CLI can drive a running app without a second IPC channel.
@MainActor
public final class FocusController: ObservableObject {
    public static let shared = FocusController()

    @Published public private(set) var available = false
    @Published public private(set) var lastError: String?

    public private(set) var store: ActivityStore?
    public private(set) var recorder: ActivityRecorder?
    public private(set) var engine: PomodoroEngine?
    public private(set) var studioModel: FocusStudioModel?

    private var hud: FocusHUDWindowController?
    private let flash = FocusFlash()
    private var idleWatch: FocusIdleWatch?
    private var statusItem: FocusStatusItem?
    private var studio: FocusStudioWindowController?
    /// One breakdown window per session id, so clicking the same card twice raises the window
    /// that is already open instead of stacking copies of it.
    private var sessionWindows: [Int64: FocusSessionWindowController] = [:]

    private var intentTimer: Timer?
    private var interruptionStartedAt: Date?
    private var settings = FocusSettings()
    private var flowAnchorBundle: String?
    private var cancellables: Set<AnyCancellable> = []

    public init() {}

    var ownsRuntime = false
    var configuration = FlowFocusConfiguration.shared
    var orchestrator = FocusOrchestrator.shared
    var remoteCommand: ((String, Data) -> Void)?
    private var presentsWindows = true

    // MARK: - Lifecycle

    /// Called once at startup. A failure here disables the feature and says why; it never takes
    /// the app down, because a ledger is not worth a launch failure.
    public func start(appConfig: [String: Any], databasePath: String = ActivityStore.defaultPath,
                      liveServices: Bool = true, presentsWindows: Bool = true) {
        guard ownsRuntime, store == nil else { return }
        self.presentsWindows = presentsWindows
        do {
            let store = try PerfLog.span("focus.store.open") { try ActivityStore(path: databasePath) }
            let settings = FocusSettings.from(appConfig: appConfig)
            self.settings = settings
            let plan = PomodoroPlan.from(appConfig: appConfig)
            let recorder = ActivityRecorder(store: store, settings: settings, liveServices: liveServices)
            let engine = PomodoroEngine(store: store, plan: plan)

            engine.onSessionChange = { [weak self, weak recorder] sessionId in
                recorder?.attach(sessionId: sessionId)
                // Starting a phase shows the timer, wherever the start came from: the HUD, the
                // menu bar, a keyboard shortcut or `genesis focus start`.
                if sessionId != nil, self?.presentsWindows == true { self?.hud?.show() }
            }
            // Spec 17 already solved snapshot-and-restore; the pomodoro just has its own
            // reason string and its own gate (plan.dndWhileFlowing), not the voice toggle.
            engine.beginDND = { [weak self] in
                do { _ = try self?.orchestrator.beginSession(reason: "genesis-focus-flow") }
                catch { FlowFocusLog.focus.warning("focus DND begin failed: \(error.localizedDescription)") }
            }
            engine.endDND = { [weak self] in
                do { _ = try self?.orchestrator.endSession(reason: "genesis-focus-flow") }
                catch { FlowFocusLog.focus.warning("focus DND end failed: \(error.localizedDescription)") }
            }

            self.store = store
            self.recorder = recorder
            self.engine = engine
            available = true

            let studioModel = FocusStudioModel(store: store)
            studioModel.onOpenSession = { [weak self] id in self?.openSession(id) }
            self.studioModel = studioModel

            hud = makeHUD(engine: engine, recorder: recorder)
            let statusItem = FocusStatusItem(
                engine: engine, recorder: recorder, store: store,
                onOpenStudio: { [weak self] in self?.openStudio() },
                onToggleHUD: { [weak self] in self?.toggleHUD() })
            statusItem.isHUDVisible = { [weak self] in self?.hud?.isVisible ?? false }
            if presentsWindows { statusItem.install(style: settings.menuBarStyle) }
            self.statusItem = statusItem

            // Every moment worth a look blinks the HUD: a phase boundary, an idle pause, the
            // resume after it, and a nudge while nothing runs. Only the nudge and a banner
            // click bring a hidden HUD back; the rest never pop a window up on their own.
            engine.onBoundary = { [weak self] in self?.callAttention(bringForward: false) }
            let idleWatch = FocusIdleWatch(engine: engine)
            idleWatch.onAutoPause = { [weak self] in self?.callAttention(bringForward: false) }
            idleWatch.onAutoResume = { [weak self] in self?.callAttention(bringForward: false) }
            idleWatch.onNudge = { [weak self] in
                FocusChime.nudge()
                self?.callAttention(bringForward: true)
            }
            if liveServices { idleWatch.start() }
            self.idleWatch = idleWatch

            // Order matters: the downtime gap is measured from what is already on disk, so it
            // must be written before the recorder opens today's first segment.
            recorder.closeDowntime()
            pruneExpiredActivity()
            recorder.installTerminateHook()
            if liveServices && settings.captureEnabled { recorder.start() }
            engine.resumeOpenSessionIfAny()
            observeFocusForInterruptions()
            startIntentTimer()
            // The timer window comes back exactly as it was left: visible if it was visible,
            // and visible anyway while a phase is running, because a running timer you cannot
            // see is the thing this window exists to prevent.
            if presentsWindows && (FocusHUDWindowController.wasVisible || engine.state != .idle) { hud?.show() }
        } catch {
            available = false
            lastError = String(describing: error)
        }
    }

    public func stop(preservingSession: Bool = false) {
        intentTimer?.invalidate()
        intentTimer = nil
        hud?.hide()
        idleWatch?.stop()
        statusItem?.remove()
        recorder?.stop()
        if preservingSession || remoteCommand != nil { engine?.suspendForHandoff() }
        else { engine?.stop() }
        cancellables.removeAll()
        studio?.close()
        for window in sessionWindows.values { window.close() }
        sessionWindows.removeAll()
        studio = nil
        hud = nil
        statusItem = nil
        idleWatch = nil
        engine = nil
        recorder = nil
        store = nil
        studioModel = nil
        available = false
        ownsRuntime = false
        remoteCommand = nil
    }

    private func makeHUD(engine: PomodoroEngine, recorder: ActivityRecorder) -> FocusHUDWindowController {
        let flash = self.flash
        return FocusHUDWindowController { [weak self] in
            AnyView(FocusHUDView(
                engine: engine,
                recorder: recorder,
                onOpenStudio: { self?.openStudio() },
                onOpenSettings: { FlowFocusHost.shared.openSettings() },
                onToggleStyle: { self?.hud?.toggleStyle() },
                // The panel refuses key status; naming a tag needs it back for as long as
                // the field is open, and not one moment longer.
                onBeginEditing: { self?.hud?.beginTextEditing() },
                onEndEditing: { self?.hud?.endTextEditing() },
                recentTags: self?.recentTags() ?? [],
                style: self?.hud?.style ?? FocusHUDWindowController.savedStyle,
                flash: flash,
                onPlanChange: { self?.updatePlan($0) }))
        }
    }

    func attachClient(databasePath: String, command: @escaping (String, Data) -> Void) throws {
        guard store == nil else { return }
        remoteCommand = command
        let store = try ActivityStore(path: databasePath, readOnly: true)
        let settings = FocusSettings.from(appConfig: configuration.app)
        let engine = PomodoroEngine(store: store, plan: PomodoroPlan.from(appConfig: configuration.app))
        let recorder = ActivityRecorder(store: store, settings: settings)
        engine.remoteCommand = command
        recorder.remoteCommand = command
        self.settings = settings
        self.store = store
        self.engine = engine
        self.recorder = recorder
        let model = FocusStudioModel(store: store)
        model.onOpenSession = { [weak self] in self?.openSession($0) }
        studioModel = model
        hud = makeHUD(engine: engine, recorder: recorder)
        available = true
    }

    var liveSnapshot: FocusLiveSnapshot {
        FocusLiveSnapshot(available: available, lastError: lastError,
                          engine: engine?.liveSnapshot, recorder: recorder?.liveSnapshot)
    }

    func applyRemote(_ snapshot: FocusLiveSnapshot) {
        guard remoteCommand != nil else { return }
        if available != snapshot.available { available = snapshot.available }
        if lastError != snapshot.lastError { lastError = snapshot.lastError }
        if let state = snapshot.engine { engine?.applyRemote(state) }
        if let state = snapshot.recorder { recorder?.applyRemote(state) }
    }

    func reportFailure(_ message: String) { lastError = message }

    // MARK: - Surfaces

    public func toggleHUD() { hud?.toggle() }

    public func showHUD() { hud?.show(followPointer: true) }

    /// Brings the timer in front of you and blinks it. A banner click uses `bringForward`:
    /// the window comes to the screen under the pointer, shown if it was hidden. An automatic
    /// event only blinks a window that is already up.
    public func callAttention(bringForward: Bool) {
        guard let hud else { return }
        if bringForward {
            hud.show(followPointer: true)
        } else if !hud.isVisible {
            FlowFocusLog.focus.notice("focus attention: HUD hidden, no blink")
            return
        }
        FlowFocusLog.focus.notice("focus attention: blink (bringForward \(bringForward))")
        // A beat later, so a window that was just ordered in is on screen for the whole blink,
        // and a rebuilt root view has subscribed before the count changes.
        let flash = self.flash
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { flash.pulse() }
    }

    /// Saves a plan edited from the HUD menu and applies it: the same path Settings uses.
    public func updatePlan(_ plan: PomodoroPlan) {
        // The settings written with the plan come from the configuration as it is now, not from the copy this
        // controller took at start: a client's copy is stale once the owner changes them, and writing it back
        // would undo that change (capture turned back on by a timer edit).
        configuration.updateFocus(settings: FocusSettings.from(appConfig: configuration.app), plan: plan)
        apply(appConfig: configuration.app)
    }

    public func openStudio() {
        guard let studioModel else { return }
        if studio == nil { studio = FocusStudioWindowController(model: studioModel) }
        studio?.present()
    }

    public func setHUDStyle(_ style: FocusHUDStyle) {
        hud?.setStyle(style)
        // A shape chosen in Settings is a request to see it, so the window comes up if it was
        // hidden. Nothing about the HUD is worth a preference you cannot observe.
        hud?.show()
    }

    /// Opens (or raises) the granular breakdown of one session.
    public func openSession(_ id: Int64) {
        guard let store else { return }
        if let existing = sessionWindows[id] {
            existing.present()
            return
        }
        let controller = FocusSessionWindowController(
            model: FocusSessionDetailModel(store: store, sessionId: id))
        controller.onClose = { [weak self] closedId in self?.sessionWindows[closedId] = nil }
        sessionWindows[id] = controller
        controller.present()
    }

    /// Tags used in the last month, newest first. Read when the HUD is built rather than in a
    /// body: this is a query, and a body is not allowed to run one.
    private func recentTags(limit: Int = 8) -> [String] {
        guard let store else { return [] }
        let now = Date()
        let from = Int64(now.addingTimeInterval(-30 * 86_400).timeIntervalSince1970 * 1000)
        let to = Int64(now.timeIntervalSince1970 * 1000) + 1
        guard let sessions = try? store.sessions(from: from, to: to) else { return [] }
        var seen = Set<String>()
        var tags: [String] = []
        for session in sessions.reversed() {
            guard let tag = session.tag, !tag.isEmpty, seen.insert(tag).inserted else { continue }
            tags.append(tag)
            if tags.count >= limit { break }
        }
        return tags
    }

    public func apply(appConfig: [String: Any]) {
        let previousRetention = settings.retentionDays
        settings = FocusSettings.from(appConfig: appConfig)
        recorder?.apply(settings: settings)
        engine?.plan = PomodoroPlan.from(appConfig: appConfig)
        if settings.retentionDays != previousRetention { pruneExpiredActivity() }
    }

    private var lastPrune: Date?

    /// Retention is a privacy setting, so it is enforced: the owner deletes activity older than
    /// `retentionDays` (titles, sites, projects, input, sessions, gaps) at start, when the setting changes and
    /// once a day while it runs. Clients never write the ledger.
    func pruneExpiredActivity(now: Date = Date()) {
        guard ownsRuntime, remoteCommand == nil, let store else { return }
        lastPrune = now
        let cutoff = Int64(now.timeIntervalSince1970 * 1000) - Int64(settings.retentionDays) * 86_400_000
        guard cutoff > 0 else { return }
        do {
            let removed = try store.forget(from: 0, to: cutoff)
            FlowFocusLog.focus.info("retention \(self.settings.retentionDays)d removed segments=\(removed.segments) sessions=\(removed.sessions)")
        } catch {
            FlowFocusLog.focus.error("retention prune failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Interruptions

    /// A flow is interrupted when focus leaves the app it started in for longer than the
    /// threshold. Anchoring on the app rather than the window means scrolling your own editor
    /// is not an interruption, and answering Teams for a minute is.
    private func observeFocusForInterruptions() {
        guard let recorder, let engine else { return }
        recorder.$current
            .receive(on: RunLoop.main)
            .sink { [weak self] snapshot in
                guard let self, let snapshot else { return }
                guard engine.state == .running || engine.state == .overrun, engine.phase == .flow else {
                    self.flowAnchorBundle = nil
                    self.interruptionStartedAt = nil
                    return
                }
                if self.flowAnchorBundle == nil { self.flowAnchorBundle = snapshot.appBundle }
                guard let anchor = self.flowAnchorBundle else { return }

                if snapshot.appBundle == anchor {
                    self.interruptionStartedAt = nil
                    return
                }
                let threshold = TimeInterval(self.settings.interruptionThresholdSec)
                if let started = self.interruptionStartedAt {
                    if Date().timeIntervalSince(started) >= threshold {
                        engine.recordInterruption()
                        self.interruptionStartedAt = Date()
                    }
                } else {
                    self.interruptionStartedAt = Date()
                }
            }
            .store(in: &cancellables)
    }

    // MARK: - CLI intents

    private func startIntentTimer() {
        let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.drainIntents() }
        }
        timer.tolerance = 0.25
        RunLoop.main.add(timer, forMode: .common)
        intentTimer = timer
    }

    public func drainIntents() {
        guard ownsRuntime else { return }
        if let lastPrune, Date().timeIntervalSince(lastPrune) >= 86_400 { pruneExpiredActivity() }
        guard let store, let engine else { return }
        guard let intents = try? store.takeIntents(), !intents.isEmpty else { return }
        for intent in intents {
            switch intent.kind {
            case "studio": openStudio()
            case "hud": toggleHUD()
            case "capture-pause":
                let minutes = intent.payload["minutes"] as? Int ?? 60
                recorder?.pauseCapture(until: Date().addingTimeInterval(TimeInterval(minutes * 60)))
            case "capture-resume":
                recorder?.resumeCapture()
            default: engine.apply(intent: intent)
            }
        }
    }
}

extension PomodoroEngine {
    /// Applies one queued CLI command. Unknown kinds are ignored on purpose: a newer CLI must
    /// not be able to wedge an older app.
    public func apply(intent: ActivityStore.Intent) {
        switch intent.kind {
        case "start":
            let minutes = intent.payload["minutes"] as? Int
            let tag = intent.payload["tag"] as? String
            start(.flow, seconds: minutes.map { $0 * 60 }, tag: tag)
            if let note = intent.payload["note"] as? String { setNote(note) }
        case "pause":
            pause()
        case "resume":
            resume()
        case "stop":
            stop()
        case "skip":
            skip()
        default:
            break
        }
    }
}
