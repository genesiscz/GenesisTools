//
//  RenderProbe.swift
//
//  Counts body evaluations and other per-frame work for the render tests
//  (`SessionTranscriptScrollTests`, `LiveTimeTests`), and in the app with `GENESIS_RENDER_PROBE=1`:
//  then each `main busy` line of the hub names the bodies a render evaluated, which is how to tell a
//  change that re-rendered one row from one that re-rendered them all. Off, a hit is one Bool read.
//  Portable: Foundation only.
//

import Foundation

/// Named counters: `hit("row.body")` in a body, `take()` in the test.
public enum RenderProbe {
    public nonisolated(unsafe) static var enabled = ProcessInfo.processInfo.environment["GENESIS_RENDER_PROBE"] == "1"
    nonisolated(unsafe) private static var counts: [String: Int] = [:]
    private static let lock = NSLock()

    public static func hit(_ name: String) {
        guard enabled else { return }
        lock.lock()
        counts[name, default: 0] += 1
        lock.unlock()
    }

    /// ` bodies[row.body=3 codeBlock.body=1]`, then zero; empty when off or nothing ran.
    public static func summary() -> String {
        guard enabled else { return "" }
        let taken = take()
        guard !taken.isEmpty else { return " bodies[none]" }
        return " bodies[" + taken.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value)" }.joined(separator: " ") + "]"
    }

    /// The counts so far, left in place: the start of one measurement's window (`summary(since:)`).
    /// Another measurement open at the same time keeps its own counts, where `take()` would zero them.
    public static func snapshot() -> [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        return counts
    }

    /// ` bodies[row.body=3 codeBlock.body=1]`: what ran since `start` (a `snapshot()`); empty when off.
    public static func summary(since start: [String: Int]) -> String {
        guard enabled else { return "" }
        let ran = snapshot().filter { $0.value > (start[$0.key] ?? 0) }
        guard !ran.isEmpty else { return " bodies[none]" }
        return " bodies[" + ran.sorted { $0.key < $1.key }.map { "\($0.key)=\($0.value - (start[$0.key] ?? 0))" }.joined(separator: " ") + "]"
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
