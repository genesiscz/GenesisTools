// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Pomodoro/PomodoroEngine.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Combine
import Foundation

/// Spec 22 (S6) T4 — the timer.
///
/// The phase table is a value type (`PomodoroPlan`) so the rules can be tested without a store,
/// a clock or a main actor. The engine around it owns persistence, so a crash mid-flow resumes
/// with the right remaining time instead of restarting the phase.
struct PomodoroPlan: Equatable {
    enum Phase: String, Equatable {
        case flow
        case shortBreak = "short_break"
        case longBreak = "long_break"

        var isBreak: Bool { self != .flow }

        var label: String {
            switch self {
            case .flow: return "Flow"
            case .shortBreak: return "Short break"
            case .longBreak: return "Long break"
            }
        }
    }

    var flowSec = 25 * 60
    var shortBreakSec = 5 * 60
    var longBreakSec = 30 * 60
    var cycleLength = 4
    var autoStartBreaks = true
    var autoStartFlows = false
    var allowOverrun = true
    var dndWhileFlowing = true
    /// A name from `FocusChime.available`, or "off". Plays at every phase boundary.
    var sound = FocusChime.defaultName
    /// Seconds without keyboard or mouse input before a running flow pauses itself. 0 turns
    /// it off. Breaks never pause: being away is what a break is for.
    var idlePauseSec = 60
    /// Whether a flow that paused itself for idleness resumes on the first input.
    var resumeOnActivity = true
    /// Shortest gap between two "no flow is running" nudges while you type. 0 turns it off.
    var nudgeEverySec = 10 * 60

    func duration(of phase: Phase) -> Int {
        switch phase {
        case .flow: return flowSec
        case .shortBreak: return shortBreakSec
        case .longBreak: return longBreakSec
        }
    }

    /// What comes after `phase`, given how many flows have completed in this cycle.
    /// A long break lands on every `cycleLength`-th completed flow, which is what the dots show.
    func next(after phase: Phase, completedFlows: Int) -> Phase {
        guard phase == .flow else { return .flow }
        let boundary = max(1, cycleLength)
        return completedFlows % boundary == 0 ? .longBreak : .shortBreak
    }

    /// The phase that came BEFORE this one, so a mis-skip can be walked back.
    /// A break is always preceded by a flow; a flow by the break whose length the cycle
    /// boundary decides.
    func previous(before phase: Phase, completedFlows: Int) -> Phase {
        guard phase == .flow else { return .flow }
        let boundary = max(1, cycleLength)
        return completedFlows > 0 && completedFlows % boundary == 0 ? .longBreak : .shortBreak
    }

    /// Whether the phase that follows starts by itself.
    func autoStarts(_ phase: Phase) -> Bool {
        phase.isBreak ? autoStartBreaks : autoStartFlows
    }

    static func from(appConfig: [String: Any]) -> PomodoroPlan {
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
final class PomodoroEngine: ObservableObject {
    enum State: String, Equatable { case idle, running, paused, overrun }

    @Published private(set) var state: State = .idle
    @Published private(set) var phase: PomodoroPlan.Phase = .flow
    /// Seconds left; negative while overrunning, which the HUD shows counting up.
    @Published private(set) var remainingSec: Int = 0
    @Published private(set) var completedFlows: Int = 0
    @Published private(set) var tag: String?
    @Published private(set) var interruptions: Int = 0
    /// Why the current pause began; nil while not paused. The idle watch resumes only its own.
    @Published private(set) var pauseReason: ActivityStore.PauseReason?
    @Published var plan = PomodoroPlan()

    /// Set by the host so the engine can split segments and arm DND without importing the app.
    var onSessionChange: ((Int64?) -> Void)?
    var onPhaseEnd: ((PomodoroPlan.Phase, Int64) -> Void)?
    /// Fires once per announced boundary, after the chime and the notification.
    var onBoundary: (() -> Void)?
    var beginDND: (() -> Void)?
    var endDND: (() -> Void)?

    private let store: ActivityStore
    private var sessionId: Int64?
    private var pauseId: Int64?
    private var startedMs: Int64 = 0
    private var plannedSec: Int = 0
    private var accruedPauseMs: Int64 = 0
    private var ticker: Timer?
    private var dndActive = false
    /// Set when a flow announced itself at zero, so the skip that ends its overrun is silent.
    private var overrunAnnounced = false

    init(store: ActivityStore, plan: PomodoroPlan = PomodoroPlan()) {
        self.store = store
        self.plan = plan
    }

    // MARK: - Commands

    func start(_ phase: PomodoroPlan.Phase = .flow, seconds: Int? = nil, tag: String? = nil) {
        endCurrent(state: .abandoned)
        let duration = seconds ?? plan.duration(of: phase)
        let now = nowMs()
        self.phase = phase
        self.tag = tag ?? self.tag
        plannedSec = duration
        startedMs = now
        accruedPauseMs = 0
        interruptions = 0
        pauseReason = nil
        overrunAnnounced = false
        remainingSec = duration
        state = .running
        sessionId = try? store.startSession(.init(kind: phase.rawValue,
                                                  plannedSec: duration,
                                                  startedMs: now,
                                                  state: ActivityStore.SessionState.running.rawValue,
                                                  cycleIndex: completedFlows,
                                                  tag: self.tag))
        onSessionChange?(sessionId)
        armDNDIfNeeded()
        startTicker()
    }

    /// `since` backdates the pause: an idle pause starts when the input stopped, not when the
    /// threshold noticed it, so the minute you were away is not charged to the flow.
    func pause(reason: ActivityStore.PauseReason = .manual, since: Date? = nil) {
        guard state == .running || state == .overrun, let sessionId else { return }
        let now = nowMs()
        // A row this engine forgot (a restart, a double press) must be closed before a new one
        // opens, or two overlapping pauses describe the same minute.
        try? store.closeOrphanedPauses(sessionId: sessionId, keeping: nil, now: now)
        // Nor may the backdate reach into the last pause: after a resume nobody was there for
        // (the CLI), it did, and the frozen clock subtracted those minutes twice.
        let lastPauseEnd = ((try? store.pauses(sessionId: sessionId)) ?? []).compactMap(\.endedMs).max() ?? startedMs
        let pausedAt = since.map { min(now, max(startedMs, lastPauseEnd, Int64($0.timeIntervalSince1970 * 1000))) } ?? now
        // The frozen clock shows what a backdated pause hands back on resume.
        let elapsed = max(0, Int((pausedAt - startedMs - accruedPauseMs) / 1000))
        remainingSec = state == .overrun ? min(plannedSec - elapsed, 0) : plannedSec - elapsed
        state = .paused
        pauseReason = reason
        pauseId = try? store.recordPause(sessionId: sessionId, startedMs: pausedAt, endedMs: nil, reason: reason)
        try? store.setSessionState(id: sessionId, state: .paused)
        releaseDND()
    }

    func resume() {
        guard state == .paused else { return }
        pauseReason = nil
        let now = nowMs()
        if let pauseId {
            try? store.closePause(id: pauseId, at: now)
            self.pauseId = nil
        }
        if let sessionId {
            // Anything still open here belongs to a process that is gone.
            try? store.closeOrphanedPauses(sessionId: sessionId, keeping: nil, now: now)
        }
        let wasOverrunning = remainingSec <= 0
        accruedPauseMs = clampedPause((try? store.pausedMs(sessionId: sessionId ?? -1, now: now)) ?? accruedPauseMs,
                                      now: now)
        // A phase that had already run out stays run out. Without this, a bad accrued value can
        // hand back positive time and the HUD shows a fresh hour on a flow that ended long ago.
        state = wasOverrunning || remainingSec <= 0 ? .overrun : .running
        if wasOverrunning { remainingSec = min(remainingSec, 0) }
        if let sessionId { try? store.setSessionState(id: sessionId, state: .running) }
        armDNDIfNeeded()
        // A phase restored paused after a relaunch never had a ticker: without this the HUD
        // showed the pause button over a clock that did not move (observed 2026-09-24 12:47).
        startTicker()
        tick()
    }

    /// Paused time can never exceed the wall clock since the phase started. A larger number is a
    /// ledger defect (an orphaned pause row, two processes), and believing it makes the timer
    /// count backwards.
    private func clampedPause(_ value: Int64, now: Int64) -> Int64 {
        max(0, min(value, max(0, now - startedMs)))
    }

    /// Ends the phase early and moves on. The session is still recorded — a skipped flow is data,
    /// not an absence.
    func skip() {
        let finished = phase
        endCurrent(state: .done)
        advance(after: finished, auto: plan.autoStarts(plan.next(after: finished, completedFlows: completedFlows)))
    }

    /// Steps back one phase and starts it. Skipping is easy to do by accident and was, until
    /// now, one-way: the only route back was to wait out a phase you did not want.
    ///
    /// The phase you return to starts fresh rather than resuming, because the session you
    /// skipped is already closed in the ledger and inventing time back into it would be a lie.
    func goBack() {
        let current = phase
        let target = plan.previous(before: current, completedFlows: completedFlows)
        endCurrent(state: .abandoned)
        // Coming back from a break undoes the flow completion that advancing counted.
        if current.isBreak { completedFlows = max(0, completedFlows - 1) }
        start(target, tag: tag)
    }

    func stop() {
        endCurrent(state: .abandoned)
        state = .idle
        remainingSec = 0
        stopTicker()
    }

    func setTag(_ value: String?) {
        tag = value
        guard let sessionId else { return }
        try? store.updateSession(id: sessionId, tag: value, note: nil, interruptions: nil)
    }

    func setNote(_ value: String) {
        guard let sessionId else { return }
        try? store.updateSession(id: sessionId, tag: nil, note: value, interruptions: nil)
    }

    /// Called by the recorder when focus left the tagged work for longer than the threshold.
    func recordInterruption() {
        guard state == .running || state == .overrun, phase == .flow else { return }
        interruptions += 1
        guard let sessionId else { return }
        try? store.updateSession(id: sessionId, tag: nil, note: nil, interruptions: interruptions)
    }

    // MARK: - Crash resume

    /// Picks up a session the app died inside. Remaining time comes from the wall clock, so a
    /// five-minute crash costs five minutes of the phase, exactly as it would have if the app
    /// had stayed up.
    func resumeOpenSessionIfAny() {
        guard let open = try? store.openSession(), let phase = PomodoroPlan.Phase(rawValue: open.kind) else { return }
        sessionId = open.id
        self.phase = phase
        tag = open.tag
        interruptions = open.interruptions
        plannedSec = open.plannedSec
        startedMs = open.startedMs
        // A process killed while paused leaves its pause row open. Adopt the newest one so this
        // engine can close it, and close the rest at the last moment anything was recorded —
        // an open row counts up to now forever, and three of them made a 25-minute flow report
        // an hour of remaining time (observed 2026-09-21 21:56).
        let now = nowMs()
        let lastSeen = (try? store.lastRecordedMs()) ?? now
        let openPause = (try? store.openPauses(sessionId: open.id))?.first
        let adopt = open.state == ActivityStore.SessionState.paused.rawValue ? openPause?.id : nil
        pauseId = adopt
        try? store.closeOrphanedPauses(sessionId: open.id, keeping: adopt, now: now)
        // A paused session with no row to adopt (an older ledger) gets one before the clock is
        // derived; after it, the whole downtime counted as work and the flow came back overrun.
        if open.state == ActivityStore.SessionState.paused.rawValue, pauseId == nil {
            pauseId = try? store.recordPause(sessionId: open.id, startedMs: min(now, max(open.startedMs, lastSeen)),
                                             endedMs: nil, reason: .auto)
        }
        accruedPauseMs = clampedPause((try? store.pausedMs(sessionId: open.id, now: now)) ?? 0, now: now)
        let elapsed = max(0, Int((now - open.startedMs - accruedPauseMs) / 1000))
        remainingSec = open.plannedSec - elapsed

        if open.state == ActivityStore.SessionState.paused.rawValue {
            // A paused phase stays paused however long the app was closed: the clock was not
            // running, so neither is it now.
            state = .paused
            pauseReason = openPause.flatMap { ActivityStore.PauseReason(rawValue: $0.reason) } ?? .auto
            onSessionChange?(sessionId)
            return
        }

        // The phase expired while the app was closed. A flow is left overrunning, because
        // finishing it is still the user's call; anything else is completed at the moment it
        // actually ended and the next phase is queued but NOT auto-started — nobody was here
        // to start it, and pretending otherwise would invent focus time that never happened.
        if remainingSec <= 0, !(phase == .flow && plan.allowOverrun) {
            let endedAt = open.startedMs + Int64(open.plannedSec) * 1000 + accruedPauseMs
            try? store.endSession(id: open.id, at: endedAt, state: .done)
            sessionId = nil
            onSessionChange?(nil)
            if phase == .flow { completedFlows += 1 }
            let next = plan.next(after: phase, completedFlows: completedFlows)
            self.phase = next
            remainingSec = plan.duration(of: next)
            state = .idle
            return
        }

        state = remainingSec <= 0 ? .overrun : .running
        onSessionChange?(sessionId)
        armDNDIfNeeded()
        startTicker()
    }

    // MARK: - Ticking

    private func startTicker() {
        stopTicker()
        let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.tick() }
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
    func tick() {
        guard state == .running || state == .overrun else { return }
        // Remaining is derived from the clock, never decremented, so a missed tick or a sleeping
        // machine cannot drift the timer.
        let now = nowMs()
        accruedPauseMs = clampedPause(accruedPauseMs, now: now)
        let elapsed = max(0, Int((now - startedMs - accruedPauseMs) / 1000))
        let derived = plannedSec - elapsed
        // Overrun is one-way: the clock counts up from zero and never returns to positive
        // remaining, whatever the ledger says about pauses.
        remainingSec = state == .overrun ? min(derived, 0) : derived

        guard remainingSec <= 0 else { return }
        if state == .running {
            let finished = phase
            let endedAt = nowMs()
            if plan.allowOverrun, phase == .flow {
                state = .overrun
                onPhaseEnd?(finished, endedAt)
                // Zero is the moment to ding, not the later skip. Without this a 25-minute flow
                // ended in silence and only breaks ever announced themselves.
                overrunAnnounced = true
                announce(finished: .flow,
                         next: plan.next(after: .flow, completedFlows: completedFlows + 1),
                         autoStarted: false)
                return
            }
            endCurrent(state: .done)
            onPhaseEnd?(finished, endedAt)
            advance(after: finished, auto: true)
        }
    }

    private func advance(after finished: PomodoroPlan.Phase, auto: Bool) {
        if finished == .flow { completedFlows += 1 }
        let next = plan.next(after: finished, completedFlows: completedFlows)
        phase = next
        remainingSec = plan.duration(of: next)
        let willAutoStart = auto && plan.autoStarts(next)
        // One announcement per boundary, from the single place every transition passes through,
        // so a skip, an expiry and an auto-start all sound the same.
        // A flow that already announced itself at zero does not ring again on the skip.
        if !(finished == .flow && overrunAnnounced) {
            announce(finished: finished, next: next, autoStarted: willAutoStart)
        }
        overrunAnnounced = false
        if willAutoStart {
            start(next, tag: tag)
        } else {
            state = .idle
            stopTicker()
        }
    }

    /// Overridable for tests: they assert the boundary was announced without making noise.
    var announcePhaseChange: ((PomodoroPlan.Phase, PomodoroPlan.Phase, Bool) -> Void)?

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
        guard let sessionId else { return }
        if let pauseId {
            try? store.closePause(id: pauseId, at: nowMs())
            self.pauseId = nil
        }
        try? store.endSession(id: sessionId, at: nowMs(), state: newState)
        self.sessionId = nil
        onSessionChange?(nil)
        releaseDND()
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

    /// The engine's only clock. Tests move it instead of sleeping.
    var clock: () -> Date = Date.init
    /// Whether the one-second ticker exists. A running phase without it shows a frozen clock.
    var isTicking: Bool { ticker != nil }

    private func nowMs() -> Int64 { Int64(clock().timeIntervalSince1970 * 1000) }
}
