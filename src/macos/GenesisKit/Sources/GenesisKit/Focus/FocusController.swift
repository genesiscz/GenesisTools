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
    private var retiredRecorders: [ActivityRecorder] = []
    private var interruptionStartedAt: Date?
    private(set) var settings = FocusSettings()
    private var flowAnchorBundle: String?
    private var cancellables: Set<AnyCancellable> = []

    public init() {}

    var ownsRuntime = false
    var configuration = FlowFocusConfiguration.shared
    var orchestrator = FocusOrchestrator.shared
    var remoteCommand: ((String, Data) -> Void)?
    /// A client's request to the runtime owner that waits for its answer (set by the runtime for a client host).
    var remoteRequest: ((String, Data) async throws -> Data)?
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
            engine.requestTick = { [weak self] in self?.drainIntents() }

            engine.onSessionChange = { [weak self, weak recorder] sessionId in
                recorder?.attach(sessionId: sessionId)
                // Starting a phase shows the timer, wherever the start came from: the HUD, the
                // menu bar, a keyboard shortcut or `genesis focus start`.
                if sessionId != nil, self?.presentsWindows == true, self?.settings.timerWindow == .automatic {
                    self?.hud?.show()
                }
            }
            engine.onSessionChangeSuspending = { [weak self, weak recorder] sessionId in
                await recorder?.attachAsync(sessionId: sessionId)
                if sessionId != nil, let self, self.ownsRuntime, self.presentsWindows {
                    await self.refreshIntentTags()
                    self.hud?.show()
                }
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
            statusItem.canShowHUD = { [weak self] in self?.settings.timerWindow != .off }
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
                self?.callAttention(bringForward: self?.settings.timerWindow == .automatic)
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
            // "When opened" restores a window that was left up but never opens one; "Off" never shows it.
            if presentsWindows && Self.showsTimerAtStart(settings.timerWindow, wasVisible: FocusHUDWindowController.wasVisible,
                                                         running: engine.state != .idle) {
                hud?.show()
            }
        } catch {
            available = false
            lastError = String(describing: error)
        }
    }

    public func stop(preservingSession: Bool = false) {
        intentTimer?.invalidate()
        intentTimer = nil
        if intentDrain != nil || recorder?.hasPendingPersistence == true {
            guard intentShutdown == nil else { return }
            ownsRuntime = false
            let drain = intentDrain, recorder = self.recorder
            intentShutdown = Task { @MainActor [self] in
                if let drain { await drain.value }
                recorder?.stop()
                await recorder?.waitForPersistence()
                completeStop(preservingSession: preservingSession)
                await recorder?.waitForPersistence()
                intentShutdown = nil
            }
            return
        }
        completeStop(preservingSession: preservingSession)
    }

    private func completeStop(preservingSession: Bool) {
        hud?.hide()
        idleWatch?.stop()
        statusItem?.remove()
        if let recorder {
            recorder.stop()
            retiredRecorders.append(recorder)
        }
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
        remoteRequest = nil
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

    /// Set by the Flow and Focus runtime: stop and start again, which opens the activity ledger once more.
    var reopenLedger: (() -> Void)?
    /// Set by the runtime: what it does now, in words.
    var runtimeStatus: (() -> String)?

    /// Settings, Focus, Retry is offered only when a runtime can reopen the ledger.
    public var canRetryLedger: Bool { reopenLedger != nil }

    public func retryLedger() {
        FlowFocusLog.focus.info("focus: retry opening the activity ledger")
        reopenLedger?()
    }

    /// Settings, Focus, Details: the error as it was raised, then what the runtime does now.
    public var ledgerFailureDetails: String {
        [lastError, runtimeStatus?()]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: "\n")
    }

    // MARK: - Surfaces

    /// Whether the timer window shows when Focus starts, under the Timer window setting.
    nonisolated static func showsTimerAtStart(_ mode: FocusSettings.TimerWindow, wasVisible: Bool, running: Bool) -> Bool {
        switch mode {
        case .automatic: return wasVisible || running
        case .onRequest: return wasVisible
        case .off: return false
        }
    }

    public func toggleHUD() {
        guard settings.timerWindow != .off || hud?.isVisible == true else { return }
        hud?.toggle()
    }

    public func showHUD() {
        guard settings.timerWindow != .off else { return }
        hud?.show(followPointer: true)
    }

    /// Brings the timer in front of you and blinks it. A banner click uses `bringForward`:
    /// the window comes to the screen under the pointer, shown if it was hidden. An automatic
    /// event only blinks a window that is already up.
    public func callAttention(bringForward: Bool) {
        guard let hud else { return }
        if bringForward && settings.timerWindow != .off {
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

    private func openStudioSuspending() async {
        guard let studioModel else { return }
        await studioModel.reloadSuspending()
        guard presentsWindows, ownsRuntime else { return }
        if studio == nil { studio = FocusStudioWindowController(model: studioModel) }
        studio?.presentPrepared()
    }

    public func setHUDStyle(_ style: FocusHUDStyle) {
        hud?.setStyle(style)
        // A shape chosen in Settings is a request to see it, so the window comes up if it was
        // hidden. Nothing about the HUD is worth a preference you cannot observe.
        if settings.timerWindow != .off { hud?.show() }
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

    /// The recent tags the intent drain read last (`refreshIntentTags`), for a HUD built while the drain may not
    /// read the ledger on the main thread.
    private var intentTags: [String] = []

    private func refreshIntentTags() async {
        guard let store else { return }
        let window = Self.tagWindow()
        let sessions = (try? await store.perform { try $0.sessions(from: window.from, to: window.to) }) ?? []
        intentTags = Self.tagNames(in: sessions, limit: 8)
    }

    /// Tags used in the last month, newest first. Read when the HUD is built rather than in a
    /// body: this is a query, and a body is not allowed to run one.
    private func recentTags(limit: Int = 8) -> [String] {
        if ActivityStore.suspendingAccessRequired { return Array(intentTags.prefix(limit)) }
        guard let store else { return [] }
        let window = Self.tagWindow()
        guard let sessions = try? store.sessions(from: window.from, to: window.to) else { return [] }
        return Self.tagNames(in: sessions, limit: limit)
    }

    /// The last 30 days up to and including now, in ledger milliseconds: the sessions whose tags the HUD offers.
    private static func tagWindow(now: Date = Date()) -> (from: Int64, to: Int64) {
        (Int64(now.addingTimeInterval(-30 * 86_400).timeIntervalSince1970 * 1000), Int64(now.timeIntervalSince1970 * 1000) + 1)
    }

    private static func tagNames(in sessions: [ActivityStore.FocusSession], limit: Int) -> [String] {
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
        applyPresentation(appConfig: appConfig)
        recorder?.apply(settings: settings)
        engine?.plan = PomodoroPlan.from(appConfig: appConfig)
        if settings.retentionDays != previousRetention { pruneExpiredActivity() }
    }

    /// The part of a settings change that every host applies, a runtime client too: each host has its own timer
    /// window, so each one reads Show timer window from its own copy of the settings. Off hides a window that is up.
    /// The recorder, the clock and the ledger stay the owner's (`apply(appConfig:)`).
    func applyPresentation(appConfig: [String: Any]) {
        settings = FocusSettings.from(appConfig: appConfig)
        if settings.timerWindow == .off { hud?.hide() }
    }

    /// When the next retention prune is due: a day after one that succeeded, a few minutes after one that failed.
    private(set) var nextPrune: Date?
    private var pendingPrune: Date?
    static let pruneInterval: TimeInterval = 86_400
    static let pruneRetryInterval: TimeInterval = 300

    /// Retention is a privacy setting, so it is enforced: the owner deletes activity older than
    /// `retentionDays` (titles, sites, projects, input, sessions, gaps) at start, when the setting changes and
    /// once a day while it runs. A prune the ledger refused (busy) is retried soon. Clients never write the ledger.
    func pruneExpiredActivity(now: Date = Date()) {
        if intentDrain != nil {
            pendingPrune = now
            return
        }
        guard let store, let cutoff = pruneCutoff(now: now) else { return }
        let days = settings.retentionDays
        applyPrune(Result { try store.prune(before: cutoff) }, days: days, now: now)
    }

    /// The ledger time a prune at `now` deletes before, or nil when this host does not prune or the retention
    /// reaches past the epoch (then the next try is a day away).
    private func pruneCutoff(now: Date) -> Int64? {
        guard ownsRuntime, remoteCommand == nil else { return nil }
        let (span, overflow) = Int64(settings.retentionDays).multipliedReportingOverflow(by: 86_400_000)
        let cutoff = Int64(now.timeIntervalSince1970 * 1000) - span
        guard !overflow, cutoff > 0 else {
            nextPrune = now.addingTimeInterval(Self.pruneInterval)
            return nil
        }
        return cutoff
    }

    /// Runs a prune at `now` off the main thread (`ActivityStore.perform`) and applies its outcome.
    private func pruneSuspending(store: ActivityStore, now: Date) async {
        guard let cutoff = pruneCutoff(now: now) else { return }
        let days = settings.retentionDays
        do {
            let removed = try await store.perform { try $0.prune(before: cutoff) }
            applyPrune(.success(removed), days: days, now: now)
        } catch {
            applyPrune(.failure(error), days: days, now: now)
        }
    }

    /// Schedules the next prune from how this one ended: a day after one that succeeded, a few minutes after one
    /// that failed.
    private func applyPrune(_ outcome: Result<(segments: Int, sessions: Int), Error>, days: Int, now: Date) {
        switch outcome {
        case .success(let removed):
            nextPrune = now.addingTimeInterval(Self.pruneInterval)
            FlowFocusLog.focus.info("retention \(days)d removed segments=\(removed.segments) sessions=\(removed.sessions)")
        case .failure(let error):
            nextPrune = now.addingTimeInterval(Self.pruneRetryInterval)
            FlowFocusLog.focus.error("retention prune failed, retrying in \(Int(Self.pruneRetryInterval)) s: \(error.localizedDescription)")
        }
    }

    func pruneIfDue(now: Date = Date()) {
        if let nextPrune, now >= nextPrune { pruneExpiredActivity(now: now) }
    }

    func pruneIfDueSuspending(store: ActivityStore, now: Date = Date()) async {
        guard let nextPrune, now >= nextPrune else { return }
        await pruneSuspending(store: store, now: now)
    }

    // MARK: - Forgetting activity

    /// Deletes everything the ledger recorded between `from` and `to`: segments, input counts, sessions and gaps
    /// (`ActivityStore.forget`). The owner runs the deletion off the main thread; a client asks the owner, because
    /// a client's ledger connection is read-only.
    public func forgetActivity(from: Date, to: Date) async throws -> FocusForgetResult {
        let range = FocusForgetCommand(from: Int64(from.timeIntervalSince1970 * 1000), to: Int64(to.timeIntervalSince1970 * 1000))
        guard range.from < range.to else { return FocusForgetResult(segments: 0, sessions: 0) }
        guard let remoteRequest else { return try await forgetOwned(range) }
        let reply = try await remoteRequest("focus.forget", JSONEncoder().encode(range))
        let result = try JSONDecoder().decode(FocusForgetResult.self, from: reply)
        FlowFocusLog.focus.info("owner forgot activity \(range.from)..<\(range.to): segments=\(result.segments) sessions=\(result.sessions)")
        didForget(range)
        return result
    }

    /// The owner's deletion, for its own Settings and for a client's `focus.forget`. The range can cover the whole
    /// ledger, so it runs off the main actor; the recorder and the views catch up after.
    func forgetOwned(_ range: FocusForgetCommand) async throws -> FocusForgetResult {
        guard ownsRuntime, let store else {
            throw FlowFocusMailbox.Failure.unavailable(lastError ?? "The Focus ledger is unavailable.")
        }

        // Fenced before the deletion starts: a flush already on its way to the recorder lands while it runs. The hold
        // ends with the deletion, after `didForget` fenced the range for good, or at once when the ledger refused it
        // and nothing was deleted.
        let recorder = self.recorder
        let fence = recorder?.ledgerForgetting(from: range.from, to: range.to)
        defer { if let fence { recorder?.ledgerForgetEnded(fence) } }
        let deletion = Task.detached(priority: .userInitiated) {
            try FocusForgetResult.forget(range, in: store)
        }
        let id = UUID()
        deletions[id] = deletion
        defer { deletions[id] = nil }
        let result = try await deletion.value
        FlowFocusLog.focus.info("forgot activity \(range.from)..<\(range.to): segments=\(result.segments) sessions=\(result.sessions)")
        didForget(range)
        return result
    }

    /// Deletions still running off the main actor. They hold the store, so they go on after `stop()`.
    private var deletions: [UUID: Task<FocusForgetResult, Error>] = [:]

    /// Waits for every ledger deletion still running, so the owner gives up the ledger (its lease) only after its
    /// last write. Each deletion's own caller gets its result or error.
    func finishLedgerWrites() async {
        if let shutdown = intentShutdown { await shutdown.value }
        else if let drain = intentDrain { await drain.value }
        await recorder?.waitForPersistence()
        for recorder in retiredRecorders { await recorder.waitForPersistence() }
        retiredRecorders.removeAll()
        for deletion in deletions.values { _ = await deletion.result }
    }

    /// After the owner's ledger forgot a range (here or for a client's `focus.forget`): the live recorder lets go of
    /// a segment the deletion removed, and the views read the ledger again.
    func didForget(_ range: FocusForgetCommand) {
        recorder?.ledgerForgot(from: range.from, to: range.to)
        // The live phase's row and pauses were rewritten with its remaining time kept: the engine reads its clock
        // back from them, so a resume and a later restart agree with the countdown.
        if let engine, engine.state != .idle { engine.resumeOpenSessionIfAny() }
        studioModel?.reload()
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

    private var intentDrain: Task<Void, Never>?
    private var intentShutdown: Task<Void, Never>?
    /// A deterministic scheduling point for queue-contention tests, before a drain starts its ledger claim.
    var intentDrainWillTake: (() -> Void)?

    /// Timer ticks share one drain, including its awaited persistence and application of the whole accepted batch.
    public func drainIntents() {
        guard ownsRuntime, intentDrain == nil, intentShutdown == nil, let store, let engine else { return }
        engine.beginIntentBatch()
        intentDrain = Task { @MainActor [self] in
            defer { intentDrain = nil }
            await ActivityStore.$suspendingAccessRequired.withValue(true) {
                await pruneIfDueSuspending(store: store)
                intentDrainWillTake?()
                let intents: [ActivityStore.Intent]
                do { intents = try await store.perform { try $0.takeIntents() } }
                catch {
                    FlowFocusLog.focus.error("focus intents not read: \(error.localizedDescription)")
                    await engine.endIntentBatch()
                    return
                }
                for intent in intents {
                    switch intent.kind {
                    case "studio": await openStudioSuspending()
                    case "hud":
                        await refreshIntentTags()
                        if ownsRuntime, presentsWindows { toggleHUD() }
                    case "capture-pause":
                        let minutes = intent.payload["minutes"] as? Int ?? 60
                        await recorder?.pauseCaptureAsync(until: Date().addingTimeInterval(TimeInterval(minutes * 60)))
                    case "capture-resume": await recorder?.resumeCaptureAsync()
                    default: await engine.applySuspending(intent: intent)
                    }
                }
                await engine.flushDeferredCommandsInBatch()
                await engine.tickSuspendingInBatch()
                if let pending = pendingPrune {
                    pendingPrune = nil
                    await pruneSuspending(store: store, now: pending)
                }
                await engine.endIntentBatch()
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

/// The range a "delete activity" request covers, in milliseconds since 1970, end exclusive.
struct FocusForgetCommand: Codable, Equatable {
    let from: Int64
    let to: Int64
}

/// What a "delete activity" request removed.
public struct FocusForgetResult: Codable, Equatable, Sendable {
    public let segments: Int
    public let sessions: Int

    static func forget(_ range: FocusForgetCommand, in store: ActivityStore) throws -> FocusForgetResult {
        let removed = try PerfLog.span("focus.forget") { try store.forget(from: range.from, to: range.to) }
        return FocusForgetResult(segments: removed.segments, sessions: removed.sessions)
    }
}
