import Foundation

/// An app that never answers an Apple Event holds a caller for two minutes, the AppleScript default. A
/// `with timeout` block makes the call give up sooner, in-process, so the permission grant stays with the
/// same process.
public enum AppleScriptTimeout {
    public static func wrap(_ source: String, seconds: Int) -> String {
        "with timeout of \(max(1, seconds)) seconds\n\(source)\nend timeout"
    }

    /// Whole seconds from `now` until `deadline`, rounded up and at least 1. Nil when the deadline is not a
    /// real point in time (no budget was set), so the caller keeps the default.
    public static func seconds(until deadline: Date, now: Date = Date()) -> Int? {
        let remaining = deadline.timeIntervalSince(now)
        guard remaining.isFinite else { return nil }
        return max(1, Int(remaining.rounded(.up)))
    }
}
