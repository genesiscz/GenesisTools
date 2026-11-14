import Foundation

/// Resumes a continuation exactly once across racing callbacks.
public final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false

    /// True when this call won the race.
    public func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if done { return false }
        done = true
        return true
    }
}
