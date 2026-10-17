import Foundation

/// An app that never answers an Apple Event holds a caller for two minutes, the AppleScript default. A
/// `with timeout` block makes the call give up sooner, in-process, so the permission grant stays with the
/// same process.
public enum AppleScriptTimeout {
    public static func wrap(_ source: String, seconds: Int) -> String {
        "with timeout of \(max(1, seconds)) seconds\n\(source)\nend timeout"
    }

    /// Applies the caller's deadline before handing the script to its in-process executor.
    public static func run(
        _ source: String, deadline: Date? = nil, now: Date = Date(), execute: (String) -> String?
    ) -> String? {
        var runnable = source
        if let deadline, let seconds = seconds(until: deadline, now: now) {
            guard seconds > 0 else { return nil }
            runnable = wrap(source, seconds: seconds)
        }
        return execute(runnable)
    }

    /// Whole seconds that fit before `deadline`, or zero when less than a second remains. Nil means no
    /// finite deadline was set, so the caller keeps the default timeout.
    public static func seconds(until deadline: Date, now: Date = Date()) -> Int? {
        let remaining = deadline.timeIntervalSince(now)
        guard remaining.isFinite else { return nil }
        return max(0, Int(remaining.rounded(.down)))
    }
}
