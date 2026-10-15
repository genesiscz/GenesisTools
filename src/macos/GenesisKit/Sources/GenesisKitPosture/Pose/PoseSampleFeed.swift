import Combine
import Foundation
import GenesisKit

/// The live pose for a preview, kept apart from the monitor's state so only the skeleton leaf observes
/// it: a new sample re-renders the overlay and nothing else in the window.
///
/// The monitor publishes into it only while `isWatched` is true (the preview is on screen), so a hidden
/// window costs no main-thread hop per frame. Its members are main-actor; the monitor reads the watched
/// flag from its own thread through a lock.
@MainActor
public final class PoseSampleFeed: ObservableObject {
    @Published public private(set) var sample: PoseSample?
    /// The last sample taken while posture was upright and clear: the overlay's "last good pose" target.
    @Published public private(set) var lastGood: PoseSample?
    /// The score of `sample` against the baseline (each fault's drift and thresholds), for a debug view.
    @Published public private(set) var score: PostureScore?

    private let watched = WatchFlag()
    private var watchers = 0

    public init() {}

    /// True while a view shows the feed. Setting it by hand overrides the count kept by
    /// `beginWatching()` and `endWatching()`.
    public var isWatched: Bool {
        get { watched.value }
        set {
            watchers = newValue ? max(watchers, 1) : 0
            watched.value = newValue
            if !newValue {
                sample = nil
                score = nil
            }
        }
    }

    /// A view that shows the feed came on screen (`PoseSkeletonLiveOverlay` calls this).
    public func beginWatching() {
        watchers += 1
        watched.value = true
    }

    /// That view went off screen; the feed stops when the last one has.
    public func endWatching() {
        watchers = max(0, watchers - 1)
        guard watchers == 0 else { return }
        watched.value = false
        sample = nil
        score = nil
    }

    nonisolated var wantsSamples: Bool { watched.value }

    func publish(_ sample: PoseSample, score: PostureScore?, good: Bool) {
        guard watched.value else { return }
        self.sample = sample
        if self.score != score { self.score = score }
        if good { lastGood = sample }
    }

    /// Sets the target by hand (a calibration's reference pose).
    public func setLastGood(_ sample: PoseSample?) {
        lastGood = sample
    }
}

/// A Bool any thread may read and write.
final class WatchFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = false

    var value: Bool {
        get { lock.withLock { stored } }
        set { lock.withLock { stored = newValue } }
    }
}
