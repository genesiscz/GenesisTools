import Foundation

/// Why the camera cannot watch.
public enum PostureCameraIssue: Equatable, Sendable {
    /// The user has not allowed the camera (or has not been asked yet).
    case unauthorized
    /// The chosen camera is not connected.
    case noDevice
    /// macOS stopped the session (another app took the camera, or the system did) and it did not restart.
    case interrupted
    case failed(String)
}

/// A pause: what holds it and, for a timed pause, when it ends.
public struct PosturePause: Equatable, Sendable {
    public var reasons: Set<ActivityPauseReason>
    public var until: Date?

    public init(reasons: Set<ActivityPauseReason>, until: Date? = nil) {
        self.reasons = reasons
        self.until = until
    }
}

/// What PostureWatcher is doing, in the order the monitor decides it: disabled, then needs calibration,
/// then paused, then camera unavailable, then the posture phases.
public enum PostureState: Equatable, Sendable {
    case disabled
    case needsCalibration
    case paused(PosturePause)
    case cameraUnavailable(PostureCameraIssue)
    /// No person in front of the camera for `awayAfter` seconds.
    case away
    /// Upright (a bad reading may be waiting out the onset delay).
    case monitoring
    /// A confirmed slouch: the effect is on.
    case slouching
    /// Back under the exit threshold, not yet upright for the reset-streak time.
    case recovery

    /// Whether the camera or AirPods should be read in this state.
    public var isWatching: Bool {
        switch self {
        case .away, .monitoring, .slouching, .recovery, .cameraUnavailable: true
        case .disabled, .needsCalibration, .paused: false
        }
    }

    /// Whether readings are being judged: away, monitoring, slouching or recovery.
    public var isPosturePhase: Bool {
        switch self {
        case .away, .monitoring, .slouching, .recovery: true
        default: false
        }
    }

    public var title: String {
        switch self {
        case .disabled: "Off"
        case .needsCalibration: "Needs calibration"
        case .paused: "Paused"
        case .cameraUnavailable: "Camera unavailable"
        case .away: "Away"
        case .monitoring: "Good posture"
        case .slouching: "Slouching"
        case .recovery: "Recovering"
        }
    }
}

/// How often the camera runs. Battery saver turns the camera off between short bursts.
public enum PostureFrameRatePolicy: String, CaseIterable, Codable, Sendable {
    case batterySaver, balanced, responsive

    public static let `default`: PostureFrameRatePolicy = .balanced

    public var title: String {
        switch self {
        case .batterySaver: "Battery saver"
        case .balanced: "Balanced"
        case .responsive: "Responsive"
        }
    }
}

/// The timing rules, all in seconds so they behave the same at every frame rate (Dorso issue #14: frame
/// counts made detection lag when the rate dropped).
public struct PostureTiming: Equatable, Codable, Sendable {
    /// Continuous bad readings before a slouch counts (Dorso: 8 readings at 4 fps).
    public var confirmBad: TimeInterval
    /// Continuous clear readings before a slouch ends or a pending one is dropped (Dorso: 5 at 10 fps).
    public var confirmGood: TimeInterval
    /// Extra wait after `confirmBad` before the slouch state and the effect (steal list: 15 s, range 0-60;
    /// Dorso's 0 s default drew "looking down is a slouch" reports, #84).
    public var onsetDelay: TimeInterval
    /// Upright time in recovery before the episode ends and the next slouch needs the full onset delay
    /// again (proposal, 10 s, range 5-60; no app documents a number).
    public var resetStreak: TimeInterval
    /// No person for this long is "away" (steal list: 4 s; Dorso's 15 readings are 3.75 s at 4 fps).
    public var awayAfter: TimeInterval
    /// After a resume (unlock, wake, unpause, back from away) the first slouch waits this much longer
    /// (Dorso #35: users were blamed right after re-docking).
    public var resumeGrace: TimeInterval
    /// The most time one reading may credit to health and history; longer gaps were not observed.
    public var maxCreditGap: TimeInterval

    public init(confirmBad: TimeInterval = 2, confirmGood: TimeInterval = 0.5, onsetDelay: TimeInterval = 15,
                resetStreak: TimeInterval = 10, awayAfter: TimeInterval = 4, resumeGrace: TimeInterval = 5,
                maxCreditGap: TimeInterval = 90) {
        self.confirmBad = confirmBad
        self.confirmGood = confirmGood
        self.onsetDelay = onsetDelay
        self.resetStreak = resetStreak
        self.awayAfter = awayAfter
        self.resumeGrace = resumeGrace
        self.maxCreditGap = maxCreditGap
    }

    public static let onsetDelayRange: ClosedRange<TimeInterval> = 0...60
    public static let resetStreakRange: ClosedRange<TimeInterval> = 5...60
}

/// Camera rates per policy. Defaults: 2 fps upright on Balanced (PoseEngines research: 2 and 4 fps cost
/// about the same, 1 fps gains little), 10 fps while a slouch is pending, on or recovering (Dorso's
/// slouch boost), 1 fps while away (steal list 11), and Battery saver bursts of 3 frames every 30 s
/// with 4 fps to confirm a bad burst (steal list 13, PoseEngines research).
public struct PostureCaptureRates: Equatable, Codable, Sendable {
    public var intervalSeconds: TimeInterval
    public var burstFrames: Int
    public var uprightFPS: Double
    public var confirmFPS: Double
    public var activeFPS: Double
    public var awayFPS: Double

    public init(intervalSeconds: TimeInterval = 30, burstFrames: Int = 3, uprightFPS: Double = 2,
                confirmFPS: Double = 4, activeFPS: Double = 10, awayFPS: Double = 1) {
        self.intervalSeconds = intervalSeconds
        self.burstFrames = burstFrames
        self.uprightFPS = uprightFPS
        self.confirmFPS = confirmFPS
        self.activeFPS = activeFPS
        self.awayFPS = awayFPS
    }

    public static let intervalRange: ClosedRange<TimeInterval> = 10...600
}

/// What one reading said, after scoring.
public enum PostureReading: Equatable, Sendable {
    /// Too dark, or nothing comparable with the baseline: changes nothing.
    case unknown
    /// Nobody there.
    case absent
    /// A scored reading: past the enter threshold, and back under the exit threshold.
    case scored(isBad: Bool, isClear: Bool)

    public init(sample: PoseSample, score: PostureScore?) {
        if sample.lowLight {
            self = .unknown
        } else if !sample.hasPerson {
            self = .absent
        } else if let score, !score.isEmpty {
            self = .scored(isBad: score.isBad, isClear: score.isClear)
        } else {
            self = .unknown
        }
    }
}

/// Something that happened, for callbacks and history.
public enum PostureEvent: Equatable, Sendable {
    case stateChanged(from: PostureState, to: PostureState)
    /// A new slouch episode started (one alert per episode).
    case slouchStarted
    /// The slouch ended and recovery began.
    case recoveryStarted
    /// Recovery lasted the reset-streak time; the episode is over.
    case streakReset
}

/// The posture decisions as a pure value: control inputs and readings in, state and events out. Time is
/// the monotonic uptime clock; the caller passes it in, so tests drive it without waiting.
public struct PostureStateMachine: Equatable, Sendable {
    public var timing: PostureTiming

    public private(set) var enabled = false
    public private(set) var hasBaseline = false
    public private(set) var userPause: PosturePause?
    public private(set) var gateReasons: Set<ActivityPauseReason> = []
    public private(set) var cameraIssue: PostureCameraIssue?
    public private(set) var usesCamera = true

    private enum Phase: Equatable, Sendable { case monitoring, slouching, recovery, away }
    private var phase: Phase = .monitoring
    private var badSince: TimeInterval?
    private var goodSince: TimeInterval?
    private var absentSince: TimeInterval?
    private var recoverySince: TimeInterval?
    private var graceUntil: TimeInterval?
    private var lastReading: TimeInterval?

    public init(timing: PostureTiming = PostureTiming()) {
        self.timing = timing
    }

    // MARK: - Output

    public var state: PostureState {
        if !enabled { return .disabled }
        if !hasBaseline { return .needsCalibration }
        if userPause != nil || !gateReasons.isEmpty {
            var reasons = gateReasons
            if userPause != nil { reasons.insert(.user) }
            return .paused(PosturePause(reasons: reasons, until: userPause?.until))
        }
        if usesCamera, let cameraIssue { return .cameraUnavailable(cameraIssue) }
        switch phase {
        case .monitoring: return .monitoring
        case .slouching: return .slouching
        case .recovery: return .recovery
        case .away: return .away
        }
    }

    /// A bad reading is waiting out the confirmation and onset delay.
    public var isConfirming: Bool { phase == .monitoring && badSince != nil }

    /// How the health bar and history should count time in the current phase.
    public var activity: PostureHealth.Activity {
        guard state.isWatching else { return .idle }
        switch phase {
        case .slouching: return .slouching
        case .recovery: return .upright
        case .monitoring: return badSince == nil ? .upright : .idle
        case .away: return .idle
        }
    }

    // MARK: - Control

    /// Applies control inputs. Returns the state change when there was one. Coming back to a posture
    /// phase from any other state (resume, unlock, camera back) starts afresh: upright, with the grace.
    @discardableResult
    public mutating func setControl(enabled: Bool? = nil, hasBaseline: Bool? = nil,
                                    userPause: PosturePause?? = nil, gateReasons: Set<ActivityPauseReason>? = nil,
                                    cameraIssue: PostureCameraIssue?? = nil, usesCamera: Bool? = nil,
                                    at time: TimeInterval) -> [PostureEvent] {
        let before = state
        if let enabled { self.enabled = enabled }
        if let hasBaseline { self.hasBaseline = hasBaseline }
        if let userPause { self.userPause = userPause }
        if let gateReasons { self.gateReasons = gateReasons }
        if let cameraIssue { self.cameraIssue = cameraIssue }
        if let usesCamera { self.usesCamera = usesCamera }
        let after = state
        if isPhaseState(after) && !isPhaseState(before) {
            restart(at: time)
        }
        if !isPhaseState(after) {
            lastReading = nil
        }
        let final = state
        return final == before ? [] : [.stateChanged(from: before, to: final)]
    }

    private func isPhaseState(_ state: PostureState) -> Bool { state.isPosturePhase }

    /// Starts the posture phase afresh, upright and with the resume grace, as a resume does. A new
    /// baseline or a calibration makes the old slouch and the pending bad time meaningless. Outside a
    /// posture phase nothing happens: coming back to one restarts anyway.
    @discardableResult
    public mutating func restartPosture(at time: TimeInterval) -> [PostureEvent] {
        let before = state
        guard isPhaseState(before) else { return [] }
        restart(at: time)
        let after = state
        return after == before ? [] : [.stateChanged(from: before, to: after)]
    }

    private mutating func restart(at time: TimeInterval) {
        phase = .monitoring
        badSince = nil
        goodSince = nil
        absentSince = nil
        recoverySince = nil
        lastReading = nil
        graceUntil = time + timing.resumeGrace
    }

    // MARK: - Readings

    /// The result of one reading: events, and how much time it credits to which activity.
    public struct Step: Equatable, Sendable {
        public var events: [PostureEvent]
        /// Time since the previous reading, credited to what the user was doing before this one.
        public var credited: TimeInterval
        /// How the health bar counts that time (a pending slouch is frozen).
        public var creditedActivity: PostureHealth.Activity
        /// The state the credited time was spent in.
        public var creditedState: PostureState
        /// Whether that time was a pending slouch (bad posture inside the onset delay); history counts
        /// it as slouching even though the health bar does not drain yet.
        public var creditedConfirming: Bool

        /// How history counts the credited time; nil when it counts nowhere.
        public var historyActivity: PostureHistoryActivity? {
            switch creditedState {
            case .away: .away
            case .slouching: .slouching
            case .monitoring: creditedConfirming ? .slouching : .upright
            case .recovery: .upright
            default: nil
            }
        }
    }

    /// Feeds one reading taken at `time`. Ignored unless the state is a posture phase.
    @discardableResult
    public mutating func observe(_ reading: PostureReading, at time: TimeInterval) -> Step {
        let before = state
        guard isPhaseState(before) else {
            return Step(events: [], credited: 0, creditedActivity: .idle, creditedState: before, creditedConfirming: false)
        }
        let creditedActivity = activity
        let creditedConfirming = isConfirming
        let credited = lastReading.map { min(max(time - $0, 0), timing.maxCreditGap) } ?? 0
        lastReading = time
        var events: [PostureEvent] = []

        switch reading {
        case .unknown:
            break
        case .absent:
            if absentSince == nil { absentSince = time }
            if let since = absentSince, time - since >= timing.awayAfter, phase != .away {
                phase = .away
                badSince = nil
                goodSince = nil
                recoverySince = nil
            }
        case let .scored(isBad, isClear):
            absentSince = nil
            if phase == .away {
                phase = .monitoring
                graceUntil = time + timing.resumeGrace
            }
            step(isBad: isBad, isClear: isClear, at: time, events: &events)
        }

        let after = state
        if after != before { events.insert(.stateChanged(from: before, to: after), at: 0) }
        return Step(events: events, credited: credited, creditedActivity: creditedActivity, creditedState: before,
                    creditedConfirming: creditedConfirming)
    }

    private mutating func step(isBad: Bool, isClear: Bool, at time: TimeInterval, events: inout [PostureEvent]) {
        switch phase {
        case .monitoring:
            if isBad {
                goodSince = nil
                if badSince == nil, time >= (graceUntil ?? -.infinity) { badSince = time }
                if let since = badSince, time - since >= timing.confirmBad + timing.onsetDelay {
                    phase = .slouching
                    badSince = nil
                    graceUntil = nil
                    events.append(.slouchStarted)
                }
            } else if badSince != nil {
                // Only a clear reading cancels a pending slouch; one inside the hysteresis band holds it.
                guard isClear else {
                    goodSince = nil
                    break
                }
                if goodSince == nil { goodSince = time }
                if let since = goodSince, time - since >= timing.confirmGood {
                    badSince = nil
                    goodSince = nil
                }
            }
        case .slouching:
            if isClear {
                if goodSince == nil { goodSince = time }
                if let since = goodSince, time - since >= timing.confirmGood {
                    phase = .recovery
                    goodSince = nil
                    badSince = nil
                    recoverySince = time
                    events.append(.recoveryStarted)
                }
            } else {
                goodSince = nil
            }
        case .recovery:
            if isBad {
                recoverySince = time
                if badSince == nil { badSince = time }
                if let since = badSince, time - since >= timing.confirmBad {
                    phase = .slouching
                    badSince = nil
                    recoverySince = nil
                }
            } else {
                badSince = nil
                if let since = recoverySince, time - since >= timing.resetStreak {
                    phase = .monitoring
                    recoverySince = nil
                    events.append(.streakReset)
                }
            }
        case .away:
            break
        }
    }
}

extension PostureStateMachine {
    /// The camera mode a state asks for under a policy. Off whenever nothing is watched, so the camera
    /// light goes dark while paused or disabled.
    public static func captureMode(state: PostureState, confirming: Bool, policy: PostureFrameRatePolicy,
                                   rates: PostureCaptureRates) -> CameraCaptureMode {
        let burst = CameraCaptureMode.interval(every: rates.intervalSeconds, frames: rates.burstFrames)
        switch state {
        case .disabled, .needsCalibration, .paused:
            return .off
        case .away:
            switch policy {
            case .batterySaver: return burst
            case .balanced: return .continuous(fps: rates.awayFPS)
            case .responsive: return .continuous(fps: max(rates.awayFPS, rates.uprightFPS))
            }
        case .monitoring, .cameraUnavailable:
            if confirming {
                return .continuous(fps: policy == .batterySaver ? rates.confirmFPS : rates.activeFPS)
            }
            switch policy {
            case .batterySaver: return burst
            case .balanced: return .continuous(fps: rates.uprightFPS)
            case .responsive: return .continuous(fps: rates.activeFPS)
            }
        case .slouching, .recovery:
            return .continuous(fps: policy == .batterySaver ? rates.confirmFPS : rates.activeFPS)
        }
    }
}
