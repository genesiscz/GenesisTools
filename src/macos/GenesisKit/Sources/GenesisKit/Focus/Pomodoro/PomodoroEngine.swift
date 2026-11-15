import Combine
import Foundation

/// Spec 22 (S6) T4 — the timer.
///
/// The phase table is a value type (`PomodoroPlan`) so the rules can be tested without a store,
/// a clock or a main actor. The engine around it owns persistence, so a crash mid-flow resumes
/// with the right remaining time instead of restarting the phase.
public struct PomodoroPlan: Codable, Equatable {
    public init(
        flowSec: Int = 25 * 60, shortBreakSec: Int = 5 * 60, longBreakSec: Int = 30 * 60,
        cycleLength: Int = 4, autoStartBreaks: Bool = true, autoStartFlows: Bool = false,
        allowOverrun: Bool = true, dndWhileFlowing: Bool = true, sound: String = "Glass",
        idlePauseSec: Int = 60, resumeOnActivity: Bool = true, nudgeEverySec: Int = 10 * 60
    ) {
        self.flowSec = flowSec
        self.shortBreakSec = shortBreakSec
        self.longBreakSec = longBreakSec
        self.cycleLength = cycleLength
        self.autoStartBreaks = autoStartBreaks
        self.autoStartFlows = autoStartFlows
        self.allowOverrun = allowOverrun
        self.dndWhileFlowing = dndWhileFlowing
        self.sound = sound
        self.idlePauseSec = idlePauseSec
        self.resumeOnActivity = resumeOnActivity
        self.nudgeEverySec = nudgeEverySec
    }

    public enum Phase: String, Codable, Equatable {
        case flow
        case shortBreak = "short_break"
        case longBreak = "long_break"

        public var isBreak: Bool { self != .flow }

        public var label: String {
            switch self {
            case .flow: return "Flow"
            case .shortBreak: return "Short break"
            case .longBreak: return "Long break"
            }
        }
    }

    public var flowSec = 25 * 60
    public var shortBreakSec = 5 * 60
    public var longBreakSec = 30 * 60
    public var cycleLength = 4
    public var autoStartBreaks = true
    public var autoStartFlows = false
    public var allowOverrun = true
    public var dndWhileFlowing = true
    /// A name from `FocusChime.available`, or "off". Plays at every phase boundary.
    public var sound = FocusChime.defaultName
    /// Seconds without keyboard or mouse input before a running flow pauses itself. 0 turns
    /// it off. Breaks never pause: being away is what a break is for.
    public var idlePauseSec = 60
    /// Whether a flow that paused itself for idleness resumes on the first input.
    public var resumeOnActivity = true
    /// Shortest gap between two "no flow is running" nudges while you type. 0 turns it off.
    public var nudgeEverySec = 10 * 60

    public func duration(of phase: Phase) -> Int {
        switch phase {
        case .flow: return flowSec
        case .shortBreak: return shortBreakSec
        case .longBreak: return longBreakSec
        }
    }

    /// What comes after `phase`, given how many flows have completed in this cycle.
    /// A long break lands on every `cycleLength`-th completed flow, which is what the dots show.
    public func next(after phase: Phase, completedFlows: Int) -> Phase {
        guard phase == .flow else { return .flow }
        let boundary = max(1, cycleLength)
        return completedFlows % boundary == 0 ? .longBreak : .shortBreak
    }

    /// The phase that came BEFORE this one, so a mis-skip can be walked back.
    /// A break is always preceded by a flow; a flow by the break whose length the cycle
    /// boundary decides.
    public func previous(before phase: Phase, completedFlows: Int) -> Phase {
        guard phase == .flow else { return .flow }
        let boundary = max(1, cycleLength)
        return completedFlows > 0 && completedFlows % boundary == 0 ? .longBreak : .shortBreak
    }

    /// Whether the phase that follows starts by itself.
    public func autoStarts(_ phase: Phase) -> Bool {
        phase.isBreak ? autoStartBreaks : autoStartFlows
    }

    public static func from(appConfig: [String: Any]) -> PomodoroPlan {
        var plan = PomodoroPlan()
        guard let focus = appConfig["focus"] as? [String: Any],
              let timer = focus["timer"] as? [String: Any] else { return plan }
        if let value = timer["flowSec"] as? Int, value > 0 { plan.flowSec = value }
        if let value = timer["shortBreakSec"] as? Int, value > 0 { plan.shortBreakSec = value }
        if let value = timer["longBreakSec"] as? Int, value > 0 { plan.longBreakSec = value }
        if let value = timer["cycleLength"] as? Int, value > 0 { plan.cycleLength = value }
        if let value = timer["autoStartBreaks"] as? Bool { plan.autoStartBreaks = value }
        if let value = timer["autoStartFlows"] as? Bool { plan.autoStartFlows = value }
        if let value = timer["allowOverrun"] as? Bool { plan.allowOverrun = value }
        if let value = timer["dndWhileFlowing"] as? Bool { plan.dndWhileFlowing = value }
        if let value = timer["sound"] as? String,
           value == "off" || FocusChime.available.contains(value) { plan.sound = value }
        if let value = timer["idlePauseSec"] as? Int, value >= 0 { plan.idlePauseSec = value }
        if let value = timer["resumeOnActivity"] as? Bool { plan.resumeOnActivity = value }
        if let value = timer["nudgeEverySec"] as? Int, value >= 0 { plan.nudgeEverySec = value }
        return plan
    }
}

@MainActor
public final class PomodoroEngine: ObservableObject {
    public enum State: String, Codable, Equatable { case idle, running, paused, overrun }

    @Published public private(set) var state: State = .idle
    @Published public private(set) var phase: PomodoroPlan.Phase = .flow
    /// Seconds left; negative while overrunning, which the HUD shows counting up.
    @Published public private(set) var remainingSec: Int = 0
    @Published public private(set) var completedFlows: Int = 0
    @Published public private(set) var tag: String?
    @Published public private(set) var interruptions: Int = 0
    /// Why the current pause began; nil while not paused. The idle watch resumes only its own.
    @Published public private(set) var pauseReason: ActivityStore.PauseReason?
    @Published public var plan = PomodoroPlan()

    /// Set by the host so the engine can split segments and arm DND without importing the app.
    public var onSessionChange: ((Int64?) -> Void)?
    /// The intent drain awaits recorder persistence before applying its next command.
    public var onSessionChangeSuspending: ((Int64?) async -> Void)?
    public var onPhaseEnd: ((PomodoroPlan.Phase, Int64) -> Void)?
    /// Fires once per announced boundary, after the chime and the notification.
    public var onBoundary: (() -> Void)?
    public var beginDND: (() -> Void)?
    public var endDND: (() -> Void)?
    var remoteCommand: ((String, Data) -> Void)?

    private let store: ActivityStore
    private var sessionId: Int64?
    private var pauseId: Int64?
    private var startedMs: Int64 = 0
    private var plannedSec: Int = 0
    private var accruedPauseMs: Int64 = 0
    private var ticker: Timer?
    /// A runtime owner routes clock work through the same ordered drain as its queued commands.
    var requestTick: (() -> Void)?
    private var dndActive = false
    /// Set when a flow announced itself at zero, so the skip that ends its overrun is silent.
    private var overrunAnnounced = false

    public init(store: ActivityStore, plan: PomodoroPlan = PomodoroPlan()) {
        self.store = store
        self.plan = plan
    }

    // MARK: - Commands

    private enum DeferredCommand {
        case start(PomodoroPlan.Phase, Int?, String?, String?)
        case pause(ActivityStore.PauseReason, Date?)
        case resume, stop, skip, back, interruption, restore
        case tag(String?), note(String)
    }
    private var applyingIntent = false
    private var deferredCommands: [DeferredCommand] = []
    private var pendingSessionChanges: [Int64?] = []
    private var restartTickerAfterIntents = false

    func beginIntentBatch() {
        guard !applyingIntent else { return }
        applyingIntent = true
        restartTickerAfterIntents = isTicking
        stopTicker()
    }

    func flushDeferredCommandsInBatch() async {
        while !deferredCommands.isEmpty {
            let next = deferredCommands.removeFirst()
            await applySuspending(next)
        }
    }

    func endIntentBatch() async {
        await flushDeferredCommandsInBatch()
        applyingIntent = false
        if state == .running || state == .overrun || (state == .paused && restartTickerAfterIntents) { startTicker() }
    }

    private func notifySessionChange(_ id: Int64?) {
        if applyingIntent { pendingSessionChanges.append(id) }
        else { onSessionChange?(id) }
    }

    private func deferDuringIntent(_ command: DeferredCommand) -> Bool {
        guard applyingIntent else { return false }
        deferredCommands.append(command)
        return true
    }

    private typealias LedgerTransition = (ActivityStore) -> (@MainActor () -> Void)

    private func perform(_ transition: LedgerTransition) { transition(store)() }

    private func performSuspending(_ transition: @escaping LedgerTransition) async {
        do {
            let finish = try await store.perform(transition)
            finish()
            // A transition may arm its normal ticker; the ordered batch owns it until all commands settle.
            stopTicker()
            while !pendingSessionChanges.isEmpty {
                let id = pendingSessionChanges.removeFirst()
                if let onSessionChangeSuspending { await onSessionChangeSuspending(id) }
                else { onSessionChange?(id) }
            }
        } catch {
            FlowFocusLog.focus.error("focus intent persistence failed: \(error.localizedDescription)")
        }
    }

    public func start(_ phase: PomodoroPlan.Phase = .flow, seconds: Int? = nil, tag: String? = nil) {
        if forward("focus.start", FocusStartCommand(phase: phase, seconds: seconds, tag: tag)) { return }
        if deferDuringIntent(.start(phase, seconds, tag, nil)) { return }
        endCurrent(state: .abandoned)
        perform(startTransition(phase, seconds: seconds, tag: tag))
    }

    private func startTransition(_ phase: PomodoroPlan.Phase, seconds: Int?, tag: String?) -> LedgerTransition {
        let duration = seconds ?? plan.duration(of: phase)
        let now = nowMs(), cycle = completedFlows
        let tag = tag ?? self.tag
        return { store in
            let id = try? store.startSession(.init(kind: phase.rawValue, plannedSec: duration, startedMs: now,
                                                   state: ActivityStore.SessionState.running.rawValue,
                                                   cycleIndex: cycle, tag: tag))
            return { [self] in
                self.phase = phase
                self.tag = tag
                plannedSec = duration
                startedMs = now
                accruedPauseMs = 0
                interruptions = 0
                pauseReason = nil
                overrunAnnounced = false
                remainingSec = duration
                state = .running
                sessionId = id
                notifySessionChange(id)
                armDNDIfNeeded()
                startTicker()
            }
        }
    }

    /// `since` backdates the pause: an idle pause starts when the input stopped, not when the
    /// threshold noticed it, so the minute you were away is not charged to the flow.
    public func pause(reason: ActivityStore.PauseReason = .manual, since: Date? = nil) {
        if forward("focus.pause", FocusPauseCommand(reason: reason, since: since)) { return }
        if deferDuringIntent(.pause(reason, since)) { return }
        if let transition = pauseTransition(reason: reason, since: since) { perform(transition) }
    }

    private func pauseTransition(reason: ActivityStore.PauseReason, since: Date?) -> LedgerTransition? {
        guard state == .running || state == .overrun, let sessionId else { return nil }
        let now = nowMs(), started = startedMs, accrued = accruedPauseMs, planned = plannedSec
        let overrunning = state == .overrun
        return { store in
            try? store.closeOrphanedPauses(sessionId: sessionId, keeping: nil, now: now)
            // Backdating must not overlap the previous pause, including one closed by another process.
            let lastEnd = ((try? store.pauses(sessionId: sessionId)) ?? []).compactMap(\.endedMs).max() ?? started
            let pausedAt = since.map { min(now, max(started, lastEnd, Int64($0.timeIntervalSince1970 * 1000))) } ?? now
            let elapsed = max(0, Int((pausedAt - started - accrued) / 1000))
            let remaining = overrunning ? min(planned - elapsed, 0) : planned - elapsed
            let id = try? store.recordPause(sessionId: sessionId, startedMs: pausedAt, endedMs: nil, reason: reason)
            try? store.setSessionState(id: sessionId, state: .paused)
            return { [self] in
                remainingSec = remaining
                state = .paused
                pauseReason = reason
                pauseId = id
                releaseDND()
            }
        }
    }

    public func resume() {
        if forward("focus.resume") { return }
        if deferDuringIntent(.resume) { return }
        guard let transition = resumeTransition() else { return }
        perform(transition)
        tick()
    }

    private func resumeTransition() -> LedgerTransition? {
        guard state == .paused else { return nil }
        let now = nowMs(), pause = pauseId, session = sessionId, accrued = accruedPauseMs
        let canOverrun = phase == .flow && plan.allowOverrun
        let wasOverrunning = canOverrun && remainingSec <= 0
        return { store in
            if let pause { try? store.closePause(id: pause, at: now) }
            if let session { try? store.closeOrphanedPauses(sessionId: session, keeping: nil, now: now) }
            let paused = (try? store.pausedMs(sessionId: session ?? -1, now: now)) ?? accrued
            if let session { try? store.setSessionState(id: session, state: .running) }
            return { [self] in
                pauseReason = nil
                pauseId = nil
                accruedPauseMs = clampedPause(paused, now: now)
                state = wasOverrunning || (canOverrun && remainingSec <= 0) ? .overrun : .running
                if wasOverrunning { remainingSec = min(remainingSec, 0) }
                armDNDIfNeeded()
                startTicker()
            }
        }
    }

    /// Paused time can never exceed the wall clock since the phase started. A larger number is a
    /// ledger defect (an orphaned pause row, two processes), and believing it makes the timer
    /// count backwards.
    private func clampedPause(_ value: Int64, now: Int64) -> Int64 {
        max(0, min(value, max(0, now - startedMs)))
    }

    /// Ends the phase early and moves on. The session is still recorded — a skipped flow is data,
    /// not an absence.
    public func skip() {
        if forward("focus.skip") { return }
        if deferDuringIntent(.skip) { return }
        let finished = phase
        endCurrent(state: .done)
        advance(after: finished, auto: plan.autoStarts(plan.next(after: finished, completedFlows: completedFlows)))
    }

    /// Steps back one phase and starts it. Skipping is easy to do by accident and was, until
    /// now, one-way: the only route back was to wait out a phase you did not want.
    ///
    /// The phase you return to starts fresh rather than resuming, because the session you
    /// skipped is already closed in the ledger and inventing time back into it would be a lie.
    public func goBack() {
        if forward("focus.back") { return }
        if deferDuringIntent(.back) { return }
        let current = phase
        let target = plan.previous(before: current, completedFlows: completedFlows)
        endCurrent(state: .abandoned)
        // Coming back from a break undoes the flow completion that advancing counted.
        if current.isBreak { completedFlows = max(0, completedFlows - 1) }
        start(target, tag: tag)
    }

    public func stop() {
        if forward("focus.stop") { return }
        if deferDuringIntent(.stop) { return }
        endCurrent(state: .abandoned)
        state = .idle
        remainingSec = 0
        stopTicker()
    }

    public func setTag(_ value: String?) {
        if forward("focus.tag", value) { return }
        if deferDuringIntent(.tag(value)) { return }
        perform(tagTransition(value))
    }

    private func tagTransition(_ value: String?) -> LedgerTransition {
        let session = sessionId
        return { store in
            do {
                if let session {
                    if let value { try store.updateSession(id: session, tag: value, note: nil, interruptions: nil) }
                    else { try store.clearSessionTag(id: session) }
                }
            } catch { FlowFocusLog.focus.error("focus tag not saved: \(error.localizedDescription)") }
            return { [self] in tag = value }
        }
    }

    public func setNote(_ value: String) {
        if forward("focus.note", value) { return }
        if deferDuringIntent(.note(value)) { return }
        if let transition = noteTransition(value) { perform(transition) }
    }

    private func noteTransition(_ value: String) -> LedgerTransition? {
        guard let sessionId else { return nil }
        return { store in
            try? store.updateSession(id: sessionId, tag: nil, note: value, interruptions: nil)
            return {}
        }
    }

    /// Called by the recorder when focus left the tagged work for longer than the threshold.
    public func recordInterruption() {
        guard remoteCommand == nil else { return }
        if deferDuringIntent(.interruption) { return }
        if let transition = interruptionTransition() { perform(transition) }
    }

    private func interruptionTransition() -> LedgerTransition? {
        guard state == .running || state == .overrun, phase == .flow else { return nil }
        let session = sessionId, count = interruptions + 1
        return { store in
            if let session { try? store.updateSession(id: session, tag: nil, note: nil, interruptions: count) }
            return { [self] in interruptions = count }
        }
    }

    // MARK: - Crash resume

    /// Picks up a session the app died inside. Remaining time comes from the wall clock, so a
    /// five-minute crash costs five minutes of the phase, exactly as it would have if the app
    /// had stayed up.
    public func resumeOpenSessionIfAny() {
        guard remoteCommand == nil else { return }
        if deferDuringIntent(.restore) { return }
        perform(restoreTransition())
    }

    private func restoreTransition() -> LedgerTransition {
        let now = nowMs(), plan = self.plan, completed = completedFlows
        return { store in
            guard let open = try? store.openSession(), let phase = PomodoroPlan.Phase(rawValue: open.kind) else { return {} }
            let lastSeen = (try? store.lastRecordedMs()) ?? now
            let openPause = (try? store.openPauses(sessionId: open.id))?.first
            let paused = open.state == ActivityStore.SessionState.paused.rawValue
            var pause = paused ? openPause?.id : nil
            try? store.closeOrphanedPauses(sessionId: open.id, keeping: pause, now: now)
            if paused, pause == nil {
                pause = try? store.recordPause(sessionId: open.id, startedMs: min(now, max(open.startedMs, lastSeen)),
                                               endedMs: nil, reason: .auto)
            }
            let accrued = max(0, min((try? store.pausedMs(sessionId: open.id, now: now)) ?? 0, max(0, now - open.startedMs)))
            let remaining = open.plannedSec - max(0, Int((now - open.startedMs - accrued) / 1000))
            let expired = !paused && remaining <= 0 && !(phase == .flow && plan.allowOverrun)
            if expired {
                try? store.endSession(id: open.id, at: open.startedMs + Int64(open.plannedSec) * 1000 + accrued, state: .done)
            }
            let adoptedPause = pause
            return { [self] in
                sessionId = open.id
                self.phase = phase
                tag = open.tag
                interruptions = open.interruptions
                plannedSec = open.plannedSec
                startedMs = open.startedMs
                pauseId = adoptedPause
                accruedPauseMs = accrued
                remainingSec = remaining
                if paused {
                    state = .paused
                    pauseReason = openPause.flatMap { ActivityStore.PauseReason(rawValue: $0.reason) } ?? .auto
                    notifySessionChange(sessionId)
                } else if expired {
                    sessionId = nil
                    notifySessionChange(nil)
                    completedFlows = completed + (phase == .flow ? 1 : 0)
                    let next = plan.next(after: phase, completedFlows: completedFlows)
                    self.phase = next
                    remainingSec = plan.duration(of: next)
                    state = .idle
                } else {
                    state = remainingSec <= 0 ? .overrun : .running
                    notifySessionChange(sessionId)
                    armDNDIfNeeded()
                    startTicker()
                }
            }
        }
    }

    // MARK: - Ticking

    private func startTicker() {
        stopTicker()
        let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if let requestTick = self.requestTick { requestTick() }
                else { self.tick() }
            }
        }
        timer.tolerance = 0.1
        RunLoop.main.add(timer, forMode: .common)
        ticker = timer
    }

    private func stopTicker() {
        ticker?.invalidate()
        ticker = nil
    }

    /// Internal rather than private so a test can step the clock without waiting a second.
    public func tick() {
        guard !applyingIntent else { return }
        guard let (finished, endedAt) = expiredPhase() else { return }
        endCurrent(state: .done)
        onPhaseEnd?(finished, endedAt)
        advance(after: finished, auto: true)
    }

    /// Derives the clock and announces an overrun without doing ledger I/O.
    private func expiredPhase() -> (PomodoroPlan.Phase, Int64)? {
        guard remoteCommand == nil else { return nil }
        guard state == .running || state == .overrun else { return nil }
        let now = nowMs()
        accruedPauseMs = clampedPause(accruedPauseMs, now: now)
        let elapsed = max(0, Int((now - startedMs - accruedPauseMs) / 1000))
        let derived = plannedSec - elapsed
        remainingSec = state == .overrun ? min(derived, 0) : derived
        guard remainingSec <= 0, state == .running else { return nil }
        let finished = phase, endedAt = nowMs()
        if plan.allowOverrun, phase == .flow {
            state = .overrun
            onPhaseEnd?(finished, endedAt)
            overrunAnnounced = true
            announce(finished: .flow, next: plan.next(after: .flow, completedFlows: completedFlows + 1), autoStarted: false)
            return nil
        }
        return (finished, endedAt)
    }

    private func advance(after finished: PomodoroPlan.Phase, auto: Bool) {
        if let next = prepareAdvance(after: finished, auto: auto) { start(next, tag: tag) }
    }

    private func prepareAdvance(after finished: PomodoroPlan.Phase, auto: Bool) -> PomodoroPlan.Phase? {
        if finished == .flow { completedFlows += 1 }
        let next = plan.next(after: finished, completedFlows: completedFlows)
        phase = next
        remainingSec = plan.duration(of: next)
        let willAutoStart = auto && plan.autoStarts(next)
        if !(finished == .flow && overrunAnnounced) { announce(finished: finished, next: next, autoStarted: willAutoStart) }
        overrunAnnounced = false
        if willAutoStart { return next }
        state = .idle
        stopTicker()
        return nil
    }

    /// Overridable for tests: they assert the boundary was announced without making noise.
    public var announcePhaseChange: ((PomodoroPlan.Phase, PomodoroPlan.Phase, Bool) -> Void)?

    private func announce(finished: PomodoroPlan.Phase, next: PomodoroPlan.Phase, autoStarted: Bool) {
        defer { onBoundary?() }
        if let announcePhaseChange {
            announcePhaseChange(finished, next, autoStarted)
            return
        }
        FocusChime.play(plan.sound)
        FocusChime.notify(finished: finished, next: next, autoStarted: autoStarted)
    }

    private func endCurrent(state newState: ActivityStore.SessionState) {
        pauseReason = nil
        guard sessionId != nil else { return }
        perform(endTransition(state: newState))
    }

    private func endCurrentSuspending(state newState: ActivityStore.SessionState) async {
        pauseReason = nil
        guard sessionId != nil else { return }
        await performSuspending(endTransition(state: newState))
    }

    private func endTransition(state newState: ActivityStore.SessionState) -> LedgerTransition {
        let session = sessionId, pause = pauseId, now = nowMs()
        return { store in
            if let session {
                if let pause { try? store.closePause(id: pause, at: now) }
                try? store.endSession(id: session, at: now, state: newState)
            }
            return { [self] in
                pauseReason = nil
                if session != nil {
                    pauseId = nil
                    sessionId = nil
                    notifySessionChange(nil)
                    releaseDND()
                }
            }
        }
    }

    /// The mailbox and UI commands share an ordered application path while persistence is suspended.
    func applySuspending(intent: ActivityStore.Intent) async {
        guard remoteCommand == nil else { return }
        let command: DeferredCommand
        switch intent.kind {
        case "start": command = .start(.flow, (intent.payload["minutes"] as? Int).map { $0 * 60 }, intent.payload["tag"] as? String, intent.payload["note"] as? String)
        case "pause": command = .pause(.manual, nil)
        case "resume": command = .resume
        case "stop": command = .stop
        case "skip": command = .skip
        default: return
        }
        let ownsBatch = !applyingIntent
        if ownsBatch { beginIntentBatch() }
        await applySuspending(command)
        if ownsBatch { await endIntentBatch() }
    }

    private func applySuspending(_ command: DeferredCommand) async {
        switch command {
        case let .start(phase, seconds, tag, note):
            await endCurrentSuspending(state: .abandoned)
            await performSuspending(startTransition(phase, seconds: seconds, tag: tag))
            if let note, let transition = noteTransition(note) { await performSuspending(transition) }
        case let .pause(reason, since):
            if let transition = pauseTransition(reason: reason, since: since) { await performSuspending(transition) }
        case .resume:
            if let transition = resumeTransition() {
                await performSuspending(transition)
                await tickSuspendingInBatch()
            }
        case .stop:
            await endCurrentSuspending(state: .abandoned)
            state = .idle
            remainingSec = 0
            stopTicker()
        case .skip:
            let finished = phase
            await endCurrentSuspending(state: .done)
            await advanceSuspending(after: finished, auto: plan.autoStarts(plan.next(after: finished, completedFlows: completedFlows)))
        case .back:
            let current = phase, target = plan.previous(before: phase, completedFlows: completedFlows)
            await endCurrentSuspending(state: .abandoned)
            if current.isBreak { completedFlows = max(0, completedFlows - 1) }
            await performSuspending(startTransition(target, seconds: nil, tag: tag))
        case .tag(let value): await performSuspending(tagTransition(value))
        case .note(let value):
            if let transition = noteTransition(value) { await performSuspending(transition) }
        case .interruption:
            if let transition = interruptionTransition() { await performSuspending(transition) }
        case .restore: await performSuspending(restoreTransition())
        }
    }

    func tickSuspendingInBatch() async {
        guard let (finished, endedAt) = expiredPhase() else { return }
        await endCurrentSuspending(state: .done)
        onPhaseEnd?(finished, endedAt)
        await advanceSuspending(after: finished, auto: true)
    }

    private func advanceSuspending(after finished: PomodoroPlan.Phase, auto: Bool) async {
        if let next = prepareAdvance(after: finished, auto: auto) {
            await performSuspending(startTransition(next, seconds: nil, tag: tag))
        }
    }

    // MARK: - DND

    private func armDNDIfNeeded() {
        guard plan.dndWhileFlowing, phase == .flow, !dndActive else { return }
        dndActive = true
        beginDND?()
    }

    private func releaseDND() {
        guard dndActive else { return }
        dndActive = false
        endDND?()
    }

    var liveSnapshot: FocusEngineSnapshot {
        FocusEngineSnapshot(state: state, phase: phase, remainingSec: remainingSec,
                            completedFlows: completedFlows, tag: tag, interruptions: interruptions,
                            pauseReason: pauseReason, plan: plan, plannedSec: plannedSec, sessionId: sessionId)
    }

    func applyRemote(_ snapshot: FocusEngineSnapshot) {
        guard remoteCommand != nil else { return }
        if state != snapshot.state { state = snapshot.state }
        if phase != snapshot.phase { phase = snapshot.phase }
        if remainingSec != snapshot.remainingSec { remainingSec = snapshot.remainingSec }
        if completedFlows != snapshot.completedFlows { completedFlows = snapshot.completedFlows }
        if tag != snapshot.tag { tag = snapshot.tag }
        if interruptions != snapshot.interruptions { interruptions = snapshot.interruptions }
        if pauseReason != snapshot.pauseReason { pauseReason = snapshot.pauseReason }
        if plan != snapshot.plan { plan = snapshot.plan }
        plannedSec = snapshot.plannedSec
        sessionId = snapshot.sessionId
    }

    /// Relinquishes the clock and DND without abandoning the durable session. The next owner
    /// resumes from its stored wall-clock anchor rather than starting another independent timer.
    func suspendForHandoff() {
        stopTicker()
        releaseDND()
    }

    private func forward<T: Encodable>(_ action: String, _ payload: T) -> Bool {
        guard let remoteCommand else { return false }
        do { remoteCommand(action, try JSONEncoder().encode(payload)) }
        catch { FlowFocusLog.focus.error("focus command encoding failed: \(error.localizedDescription)") }
        return true
    }

    private func forward(_ action: String) -> Bool {
        guard let remoteCommand else { return false }
        remoteCommand(action, Data())
        return true
    }

    /// The engine's only clock. Tests move it instead of sleeping.
    public var clock: () -> Date = Date.init
    /// Whether the one-second ticker exists. A running phase without it shows a frozen clock.
    public var isTicking: Bool { ticker != nil }

    private func nowMs() -> Int64 { Int64(clock().timeIntervalSince1970 * 1000) }
}
