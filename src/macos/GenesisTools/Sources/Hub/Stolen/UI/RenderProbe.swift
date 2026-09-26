// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/UI/RenderProbe.swift at 2026-09-25T22:22:02+02:00 at commit hash 09d2ee1252400c65d735e279aecd931735f57e5f
//
//  RenderProbe.swift
//  Genesis
//
//  Counts body evaluations and other per-frame work for the render tests
//  (`SessionTranscriptScrollTests`, `LiveTimeTests`). Off unless a test turns it on, and compiled
//  out of release builds. Portable: Foundation only.
//

import Foundation

/// Named counters: `hit("row.body")` in a body, `take()` in the test.
enum RenderProbe {
    nonisolated(unsafe) static var enabled = false
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    private static let lock = NSLock()

    static func hit(_ name: String) {
        #if DEBUG
        guard enabled else { return }
        lock.lock()
        counts[name, default: 0] += 1
        lock.unlock()
        #endif
    }

    /// The counts so far, then zero.
    static func take() -> [String: Int] {
        lock.lock()
        defer {
            counts = [:]
            lock.unlock()
        }
        return counts
    }
}
