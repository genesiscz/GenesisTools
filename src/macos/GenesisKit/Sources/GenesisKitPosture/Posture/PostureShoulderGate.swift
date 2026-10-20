import Foundation
import GenesisKit

/// Lets a shoulder fault from the throttled 3D body request turn bad only when two fresh 3D readings in a row are
/// bad, each scored on its own. The engine reuses one 3D reading for several seconds, so without this a single
/// wrong reading, or one taken before the user moved, held a fault for its whole lifetime: a level shoulder line
/// was judged tilted for 6.8 s (debug recording 2026-10-19 22:28:57, Home).
///
/// While a fault waits, its signal is held (neither bad nor clear) and `apply` asks for a fresh reading on the
/// next frame (`VisionBodyPoseEngine.readShouldersOnNextFrame()`), so the wait is one frame, not one interval.
/// A fault leaves at once when a fresh reading is no longer bad. Readings with 2D shoulders pass unchanged: the
/// 2D request runs on every frame.
struct PostureShoulderGate: Equatable, Sendable {
    /// Faults the last two fresh readings both found bad.
    private(set) var confirmed: Set<PostureMetricKind> = []
    /// Faults only the last fresh reading found bad.
    private(set) var pending: Set<PostureMetricKind> = []

    /// Judges one reading. `score` is the smoothed score the monitor acts on; `fresh` is this frame's unsmoothed
    /// score, given only when the 3D request ran on this frame. Returns the score to act on and whether the
    /// engine should read the shoulders again on the next frame.
    mutating func apply(_ score: PostureScore, fresh: PostureScore?, source: PoseShoulderSource?,
                        scorer: PostureScorer) -> (score: PostureScore, readAgain: Bool) {
        guard source == .body3D else { return (score, false) }
        if let fresh {
            let bad = Self.badShoulderKinds(fresh)
            let agreed = bad.intersection(confirmed.union(pending))
            pending = bad.subtracting(agreed)
            confirmed = agreed
        }
        let waiting = Self.badShoulderKinds(score).subtracting(confirmed)
        let held = waiting.isEmpty ? score : scorer.holding(waiting, in: score)
        return (held, fresh != nil && !pending.isEmpty)
    }

    mutating func reset() {
        confirmed = []
        pending = []
    }

    static func badShoulderKinds(_ score: PostureScore) -> Set<PostureMetricKind> {
        Set(score.signals.filter { $0.isBad && $0.measure.usesShoulders }.map(\.kind))
    }
}
