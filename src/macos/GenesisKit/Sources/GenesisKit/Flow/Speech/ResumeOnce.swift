// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Companion/CompanionTurnContext.swift at 2026-10-08T05:10:39+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
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
