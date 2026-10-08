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
final class FocusController: ObservableObject {
    static let shared = FocusController()

    @Published private(set) var available = false
    @Published private(set) var lastError: String?

    private(set) var store: ActivityStore?
    private(set) var recorder: ActivityRecorder?
    private(set) var engine: PomodoroEngine?
    private(set) var studioModel: FocusStudioModel?

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

    private init() {}

    // MARK: - Lifecycle

    /// Called once at startup. A failure here disables the feature and says why; it never takes
    /// the app down, because a ledger is not worth a launch failure.
    func start(appConfig: [String: Any]) {
        guard store == nil else { return }
        do {
            let store = try ActivityStore()
            let settings = FocusSettings.from(appConfig: appConfig)
            self.settings = settings
            let plan = PomodoroPlan.from(appConfig: appConfig)
            let recorder = ActivityRecorder(store: store, settings: settings)
            let engine = PomodoroEngine(store: store, plan: plan)

            engine.onSessionChange = { [weak self, weak recorder] sessionId in
                recorder?.attach(sessionId: sessionId)
                // Starting a phase shows the timer, wherever the start came from: the HUD, the
                // menu bar, a keyboard shortcut or `genesis focus start`.
                if sessionId != nil { self?.hud?.show() }
            }
            // Spec 17 already solved snapshot-and-restore; the pomodoro just has its own
            // reason string and its own gate (plan.dndWhileFlowing), not the voice toggle.
            engine.beginDND = {
                do { _ = try FocusOrchestrator.shared.beginSession(reason: "genesis-focus-flow") }
                catch { Log.app.warning("focus DND begin failed: \(error.localizedDescription)") }
            }
            engine.endDND = {
                do { _ = try FocusOrchestrator.shared.endSession() }
                catch { Log.app.warning("focus DND end failed: \(error.localizedDescription)") }
            }

            self.store = store
            self.recorder = recorder
            self.engine = engine
            available = true

            let studioModel = FocusStudioModel(store: store)
            studioModel.onOpenSession = { [weak self] id in self?.openSession(id) }
            self.studioModel = studioModel

            let flash = self.flash
            hud = FocusHUDWindowController { [weak self] in
                AnyView(FocusHUDView(
                    engine: engine,
                    recorder: recorder,
                    onOpenStudio: { self?.openStudio() },
                    onOpenSettings: { SettingsWindowController.shared.show() },
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
            let statusItem = FocusStatusItem(
                engine: engine, recorder: recorder, store: store,
                onOpenStudio: { [weak self] in self?.openStudio() },
                onToggleHUD: { [weak self] in self?.toggleHUD() })
            statusItem.isHUDVisible = { [weak self] in self?.hud?.isVisible ?? false }
            statusItem.install(style: settings.menuBarStyle)
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
            idleWatch.start()
            self.idleWatch = idleWatch

            // Order matters: the downtime gap is measured from what is already on disk, so it
            // must be written before the recorder opens today's first segment.
            recorder.closeDowntime()
            recorder.installTerminateHook()
            if settings.captureEnabled { recorder.start() }
            engine.resumeOpenSessionIfAny()
            observeFocusForInterruptions()
            startIntentTimer()
            // The timer window comes back exactly as it was left: visible if it was visible,
            // and visible anyway while a phase is running, because a running timer you cannot
            // see is the thing this window exists to prevent.
            if FocusHUDWindowController.wasVisible || engine.state != .idle { hud?.show() }
        } catch {
            available = false
            lastError = String(describing: error)
        }
    }

    func stop() {
        intentTimer?.invalidate()
        intentTimer = nil
        hud?.hide()
        idleWatch?.stop()
        statusItem?.remove()
        recorder?.stop()
        engine?.stop()
    }

    // MARK: - Surfaces

    func toggleHUD() { hud?.toggle() }

    func showHUD() { hud?.show(followPointer: true) }

    /// Brings the timer in front of you and blinks it. A banner click uses `bringForward`:
    /// the window comes to the screen under the pointer, shown if it was hidden. An automatic
    /// event only blinks a window that is already up.
    func callAttention(bringForward: Bool) {
        guard let hud else { return }
        if bringForward {
            hud.show(followPointer: true)
        } else if !hud.isVisible {
            Log.app.notice("focus attention: HUD hidden, no blink")
            return
        }
        Log.app.notice("focus attention: blink (bringForward \(bringForward))")
        // A beat later, so a window that was just ordered in is on screen for the whole blink,
        // and a rebuilt root view has subscribed before the count changes.
        let flash = self.flash
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { flash.pulse() }
    }

    /// Saves a plan edited from the HUD menu and applies it: the same path Settings uses.
    func updatePlan(_ plan: PomodoroPlan) {
        ConfigStore.shared.updateFocus(settings: settings, plan: plan)
        apply(appConfig: ConfigStore.shared.app)
    }

    func openStudio() {
        guard let studioModel else { return }
        if studio == nil { studio = FocusStudioWindowController(model: studioModel) }
        studio?.present()
    }

    func setHUDStyle(_ style: FocusHUDStyle) {
        hud?.setStyle(style)
        // A shape chosen in Settings is a request to see it, so the window comes up if it was
        // hidden. Nothing about the HUD is worth a preference you cannot observe.
        hud?.show()
    }

    /// Opens (or raises) the granular breakdown of one session.
    func openSession(_ id: Int64) {
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

    func apply(appConfig: [String: Any]) {
        settings = FocusSettings.from(appConfig: appConfig)
        recorder?.apply(settings: settings)
        engine?.plan = PomodoroPlan.from(appConfig: appConfig)
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

    func drainIntents() {
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
    func apply(intent: ActivityStore.Intent) {
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
