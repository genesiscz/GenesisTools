import Foundation

/// The health bar: drains while the user slouches and refills while they sit upright, with streaks.
///
/// Default rates drain 1% per second (100 s from full to empty) and refill 3% per second (about 33 s
/// back to full). That keeps Dorso's 3-to-1 up-to-down ramp asymmetry at a slower scale; no public
/// source gives SlouchSniper's numbers (PostureApps research, steal list item 15).
public struct PostureHealth: Equatable, Codable, Sendable {
    /// 0...1.
    public private(set) var value: Double
    public var drainPerSecond: Double
    public var refillPerSecond: Double
    /// Seconds of upright posture since the last slouch ended (or since monitoring began).
    public private(set) var uprightStreak: TimeInterval
    /// The longest upright streak seen.
    public private(set) var bestUprightStreak: TimeInterval
    /// Seconds of the slouch in progress.
    public private(set) var slouchStreak: TimeInterval

    public static let defaultDrainPerSecond = 0.01
    public static let defaultRefillPerSecond = 0.03

    public init(value: Double = 1, drainPerSecond: Double = defaultDrainPerSecond,
                refillPerSecond: Double = defaultRefillPerSecond) {
        self.value = min(max(value, 0), 1)
        self.drainPerSecond = drainPerSecond
        self.refillPerSecond = refillPerSecond
        uprightStreak = 0
        bestUprightStreak = 0
        slouchStreak = 0
    }

    /// What the user did over `seconds`.
    public enum Activity: Sendable {
        case upright, slouching, idle
    }

    /// Advances the bar. `idle` (away, paused) freezes it and keeps the streaks.
    public mutating func advance(_ activity: Activity, seconds: TimeInterval) {
        guard seconds > 0 else { return }
        switch activity {
        case .upright:
            value = min(1, value + refillPerSecond * seconds)
            uprightStreak += seconds
            bestUprightStreak = max(bestUprightStreak, uprightStreak)
            slouchStreak = 0
        case .slouching:
            value = max(0, value - drainPerSecond * seconds)
            slouchStreak += seconds
            uprightStreak = 0
        case .idle:
            break
        }
    }

    /// Whole percent, the only resolution a bar or a menu line shows.
    public var percent: Int { Int((value * 100).rounded()) }

    /// Back to a full bar with no streaks (a new day).
    public mutating func reset() {
        value = 1
        uprightStreak = 0
        bestUprightStreak = 0
        slouchStreak = 0
    }
}
