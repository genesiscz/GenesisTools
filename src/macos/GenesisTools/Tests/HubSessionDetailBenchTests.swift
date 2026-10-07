import AppKit
import SwiftUI
import XCTest
@testable import GenesisTools

/// Timings of the hub's session detail (`HubSessionDetailHost`) on a real transcript, one open per process,
/// in a window shaped like Genesis' Session Details window. Skipped unless `SESSION_DETAILS_BENCH=<out.jsonl>`
/// and `SESSION_DETAILS_BENCH_ID=<session id>` are set; the driver runs it next to Genesis' bench
/// (GenesisPlayground Tests/GenesisTests/SessionDetailsBenchTests.swift, GenesisKit `SessionOpenBench`).
/// Run with `GENESIS_HUB_SERVER=0` to compare transports equally: the server would stay up after the run.
@MainActor
final class HubSessionDetailBenchTests: XCTestCase {
    func testOpenSessionDetail() throws {
        let env = ProcessInfo.processInfo.environment
        guard let out = env["SESSION_DETAILS_BENCH"], let sessionId = env["SESSION_DETAILS_BENCH_ID"] else {
            throw XCTSkip("set SESSION_DETAILS_BENCH and SESSION_DETAILS_BENCH_ID to time a real open")
        }
        let session = HubSession(
            provider: env["SESSION_DETAILS_BENCH_PROVIDER"] ?? "claude",
            sessionId: sessionId,
            title: "bench",
            cwd: env["SESSION_DETAILS_BENCH_CWD"] ?? "",
            mtime: Date().timeIntervalSince1970 * 1000 - 3_600_000,
            filePath: env["SESSION_DETAILS_BENCH_FILE"] ?? ""
        )
        let bench = SessionOpenBench()
        let result = bench.run {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1180, height: 780),
                styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            SessionDetailScreenChrome.apply(to: window)
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: HubSessionDetailHost(session: session).titlebarZone())
            return (window, window)
        }
        try SessionOpenBench.append(result, label: env["SESSION_DETAILS_BENCH_ARM"] ?? "gt", sessionId: sessionId, to: out)
    }
}
