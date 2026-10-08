// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Focus/Pomodoro/FocusIdleWatch.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import CoreGraphics
import Foundation

/// Watches keyboard and mouse idleness for the pomodoro and acts on it:
///
/// - a running flow pauses itself after `plan.idlePauseSec` without input, backdated to the
///   last input so the time away is not charged to the flow;
/// - a flow it paused resumes on the first input when `plan.resumeOnActivity` is on;
/// - while nothing runs (stopped, or paused by hand), about five seconds of typing earns one
///   soft nudge, at most every `plan.nudgeEverySec`.
///
/// It reads the same system idle clock the recorder uses, so it needs no event tap and no
/// extra permission. `step` is the whole policy and takes its inputs as values, so tests can
/// drive it without a clock or a keyboard.
@MainActor
final class FocusIdleWatch {
    var onAutoPause: (() -> Void)?
    var onAutoResume: (() -> Void)?
    var onNudge: (() -> Void)?

    /// Polls with a key press in them, needed before a nudge. One key that wakes the screen is
    /// not "starting to work".
    static let typingPollsForNudge = 5
    /// No nudge in the first minute after the timer stopped: you just stopped it on purpose.
    static let graceAfterStopSec: TimeInterval = 60
    /// Input this recent counts as "back" for an automatic resume.
    static let activeWithinSec: Double = 2
    /// A gap in input this long resets the typing count.
    static let typingResetIdleSec: Double = 30

    private let engine: PomodoroEngine
    private var timer: Timer?
    private var typingPolls = 0
    private var notRunningSince: Date
    private var lastNudge: Date?
    private var wasRunning = false

    init(engine: PomodoroEngine, now: Date = Date()) {
        self.engine = engine
        notRunningSince = now
    }

    func start() {
        stop()
        let timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.poll() }
        }
        timer.tolerance = 0.2
        RunLoop.main.add(timer, forMode: .common)
        self.timer = timer
    }

    func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func poll() {
        step(now: Date(),
             idleSec: ActivityRecorder.idleSeconds(),
             sinceKeySec: CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown))
    }

    /// One decision. `idleSec` is seconds since any input, `sinceKeySec` since the last key.
    func step(now: Date, idleSec: Double, sinceKeySec: Double) {
        let plan = engine.plan
        if engine.state == .running || engine.state == .overrun {
            wasRunning = true
            typingPolls = 0
            if plan.idlePauseSec > 0, engine.phase == .flow, idleSec >= Double(plan.idlePauseSec) {
                engine.pause(reason: .idle, since: now.addingTimeInterval(-idleSec))
                if engine.state == .paused {
                    Log.app.notice("focus idle: auto-paused after \(Int(idleSec)) s without input")
                    onAutoPause?()
                }
            }
            return
        }
        if wasRunning {
            wasRunning = false
            notRunningSince = now
        }
        if engine.state == .paused, engine.pauseReason == .idle, plan.resumeOnActivity {
            if idleSec < Self.activeWithinSec {
                engine.resume()
                if engine.state != .paused {
                    Log.app.notice("focus idle: auto-resumed on input (ticking \(engine.isTicking))")
                    onAutoResume?()
                }
            }
            return
        }
        considerNudge(now: now, idleSec: idleSec, sinceKeySec: sinceKeySec, plan: plan)
    }

    private func considerNudge(now: Date, idleSec: Double, sinceKeySec: Double, plan: PomodoroPlan) {
        guard plan.nudgeEverySec > 0, idleSec < Self.typingResetIdleSec else {
            typingPolls = 0
            return
        }
        if sinceKeySec < 1.5 { typingPolls += 1 }
        guard typingPolls >= Self.typingPollsForNudge,
              now.timeIntervalSince(notRunningSince) >= Self.graceAfterStopSec else { return }
        if let lastNudge, now.timeIntervalSince(lastNudge) < TimeInterval(plan.nudgeEverySec) { return }
        lastNudge = now
        typingPolls = 0
        onNudge?()
    }
}
