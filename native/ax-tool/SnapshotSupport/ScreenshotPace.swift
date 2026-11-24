import Foundation

/// How often a screenshot feed may take a screenshot. Every ScreenCaptureKit screenshot passes through replayd, which
/// waits twice on systemstatusd (the privacy-indicator daemon). Measured 2026-11-23 on one Mac where that daemon was
/// CPU-bound: 0.5 to 0.8 s per screenshot, 22 to 25 s for a burst of 28, and while its queue was full another app could
/// not start a screen share (its request waited 15 to 20 s). So a feed spends at most `busyShare` of the time taking
/// screenshots, and still takes one at least every `longestInterval`.
public enum ScreenshotPace {
    public static let busyShare = 0.1
    public static let longestInterval: TimeInterval = 30
    /// A stretch shorter than this is not reported: the feed runs at about the asked rate.
    public static let reportedStretch: TimeInterval = 0.5

    /// The interval between two screenshots: `asked`, stretched to `took / busyShare` when the newest screenshot took
    /// `took` seconds, but not past `longestInterval` (an asked interval longer than that stays).
    public static func interval(asked: TimeInterval, took: TimeInterval?) -> TimeInterval {
        guard let took, took.isFinite, took > 0 else { return asked }
        return max(asked, min(took / busyShare, longestInterval))
    }

    /// What a feed reports about the interval it runs at.
    public static func report(interval: TimeInterval, asked: TimeInterval, took: TimeInterval) -> ScreenshotPaceReport {
        let stretched = interval - asked >= reportedStretch
        return ScreenshotPaceReport(everySec: stretched ? max(1, Int(interval.rounded())) : nil, screenshotSec: took)
    }
}

/// A screenshot feed's pace: the stretched interval, and how long the newest screenshot took.
public struct ScreenshotPaceReport: Equatable {
    /// One screenshot every this many seconds (rounded); nil while the feed runs at the asked interval.
    public let everySec: Int?
    public let screenshotSec: TimeInterval

    public init(everySec: Int?, screenshotSec: TimeInterval) {
        self.everySec = everySec
        self.screenshotSec = screenshotSec
    }

    /// The `screenshot-pace` event and the `status` field.
    public var row: [String: Any] {
        var row: [String: Any] = ["screenshotSec": (screenshotSec * 1000).rounded() / 1000]
        if let everySec { row["everySec"] = everySec }
        return row
    }
}
