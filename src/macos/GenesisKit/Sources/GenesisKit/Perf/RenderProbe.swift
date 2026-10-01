//
//  RenderProbe.swift
//
//  Counts body evaluations and other per-frame work for the render tests
//  (`SessionTranscriptScrollTests`, `LiveTimeTests`). Off unless a test turns it on, and compiled
//  out of release builds. Portable: Foundation only.
//

import Foundation

/// Named counters: `hit("row.body")` in a body, `take()` in the test.
public enum RenderProbe {
    public nonisolated(unsafe) static var enabled = false
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    private static let lock = NSLock()

    public static func hit(_ name: String) {
        #if DEBUG
        guard enabled else { return }
        lock.lock()
        counts[name, default: 0] += 1
        lock.unlock()
        #endif
    }

    /// The counts so far, then zero.
    public static func take() -> [String: Int] {
        lock.lock()
        defer {
            counts = [:]
            lock.unlock()
        }
        return counts
    }
}
