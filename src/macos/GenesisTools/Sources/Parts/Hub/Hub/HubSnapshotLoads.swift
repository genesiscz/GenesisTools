import Foundation

/// What a hub `--snapshot` waits for besides the diff: an overlay that loads its content after it appears. The Today
/// digest reads the day through `tools hub digest`, and two captures on 2026-10-11 still showed "Reading the day…".
/// Each such load says when it starts and when it ends (`begin` returns the end). The capture waits until every part
/// the request opened has finished once and no tracked load is still running, or until its deadline; then it captures
/// anyway and names what was still loading (`hub snapshot: still loading: digest`).
///
/// Parts: `digest` (HubDigest.swift), `forecast` (HubForecast.swift, also the digest's usage section), `prompts`
/// (HubPrompts.swift), `handoff` (HubHandoffComposer.swift), `rules` (HubRules.swift). The live hub pays one
/// dictionary write per load and never waits.
@MainActor
enum HubSnapshotLoads {
    /// How long a capture waits for its overlays; the whole run still ends at the hub's 60 s settle limit.
    static let deadline: TimeInterval = 20
    private static var running: [String: Int] = [:]
    private static var finished: Set<String> = []
    private static var waiters: [() -> Void] = []

    /// Marks `part` as loading. Call the returned closure when the load ends, failed or not; a second call is ignored.
    static func begin(_ part: String) -> () -> Void {
        running[part, default: 0] += 1
        var ended = false
        return {
            guard !ended else { return }
            ended = true
            let left = (running[part] ?? 1) - 1
            running[part] = left > 0 ? left : nil
            finished.insert(part)
            let ready = waiters
            waiters = []
            ready.forEach { $0() }
        }
    }

    /// The parts in `expected` that have not finished once yet, and every part still running, sorted.
    static func pending(expected: Set<String>) -> [String] {
        Set(running.keys).union(expected.subtracting(finished)).sorted()
    }

    /// Calls `done` once: with an empty list as soon as nothing is pending, or with the parts still loading when
    /// `deadline` seconds have passed. It wakes on each load's end, never on a timer.
    static func whenIdle(expected: Set<String>, deadline: TimeInterval, then done: @escaping @MainActor ([String]) -> Void) {
        var fired = false
        func check() {
            guard !fired else { return }
            if pending(expected: expected).isEmpty {
                fired = true
                done([])
                return
            }
            waiters.append { check() }
        }
        check()
        guard !fired else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + deadline) {
            MainActor.assumeIsolated {
                guard !fired else { return }
                fired = true
                done(pending(expected: expected))
            }
        }
    }

    /// Runs `capture` once the parts in `expected` have loaded and nothing tracked is running. On expiry it prints
    /// `hub snapshot: still loading: <parts>` and captures anyway; content that arrived during a wait gets 0.4 s to draw.
    static func afterLoads(_ expected: Set<String>, then capture: @escaping @MainActor () -> Void) {
        let started = Date()
        whenIdle(expected: expected, deadline: deadline) { stillLoading in
            if !stillLoading.isEmpty {
                let line = "still loading: \(stillLoading.joined(separator: ", ")) (captured as is after \(Int(deadline)) s)"
                PerfLog.mark("hub.snapshot \(line)")
                FileHandle.standardError.write(Data("hub snapshot: \(line)\n".utf8))
            }
            let settle = Date().timeIntervalSince(started) > 0.05 ? 0.4 : 0
            guard settle > 0 else {
                capture()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + settle) { MainActor.assumeIsolated { capture() } }
        }
    }

    /// Test seam: forgets every load.
    static func reset() {
        running = [:]
        finished = []
        waiters = []
    }
}
