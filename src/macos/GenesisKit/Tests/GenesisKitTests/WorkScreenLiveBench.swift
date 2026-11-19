import Foundation
import XCTest
@testable import GenesisKit

/// Counts what the screen asks of the live service.
@MainActor
private final class CountingSource: WorkSource {
    let inner: WorkSource
    var reads = 0
    init(_ inner: WorkSource) { self.inner = inner }
    func projects() async throws -> [String] { try await inner.projects() }
    func snapshot(project: String) async throws -> WorkSnapshotValue { reads += 1; return try await inner.snapshot(project: project) }
    func notify(project: String) async throws -> [WorkNotifyRow] { try await inner.notify(project: project) }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        try await inner.perform(action, project: project)
    }
    func changes() -> AsyncStream<Void> { inner.changes() }
}

/// The open Work screen against a real service for 60 s while another process writes. Runs only with
/// `WORK_LIVE_BENCH=1` and a `GENESIS_TOOLS_HOME` whose service is up; the arm comes from `WORK_LIVE_ARM`
/// (`new`: the shipped rules; `old`: a reload 0.3 s after each change; `hidden`: the shipped rules, window hidden).
/// It prints one `work-live-bench` line with the reloads and this process's CPU.
@MainActor
final class WorkScreenLiveBench: XCTestCase {
    func testTheOpenScreenWhileAnotherProcessWrites() async throws {
        let env = ProcessInfo.processInfo.environment
        try XCTSkipUnless(env["WORK_LIVE_BENCH"] == "1", "a bench of the live service; WORK_LIVE_BENCH=1 runs it")
        let arm = env["WORK_LIVE_ARM"] ?? "new"
        let seconds = Double(env["WORK_LIVE_SECONDS"] ?? "60") ?? 60
        let source = CountingSource(LiveWorkSource())
        let model = arm == "old"
            ? WorkScreenModel(source: source, reloadInterval: 0.3, settle: 0)
            : WorkScreenModel(source: source)
        model.project = env["WORK_LIVE_PROJECT"] ?? "GenesisTools"
        model.activate()
        let deadline = Date().addingTimeInterval(20)
        while model.snapshot == nil && Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
        XCTAssertNotNil(model.snapshot, model.failure ?? "no snapshot")
        if arm == "hidden" { model.setVisible(false) }

        let readsBefore = source.reads
        let cpuBefore = Self.cpuSeconds()
        let markerPath = try XCTUnwrap(env["WORK_LIVE_MARKER"], "The live writer needs a marker path.")
        let marker = URL(fileURLWithPath: markerPath)
        try "start".write(to: marker, atomically: true, encoding: .utf8)
        try await Task.sleep(for: .seconds(seconds))
        let cpu = Self.cpuSeconds() - cpuBefore
        print(String(format: "work-live-bench arm=%@ seconds=%.0f reloads=%d changeReloads=%d appCPU=%.2f",
                     arm, seconds, source.reads - readsBefore, model.changeReloads, cpu))
        model.deactivate()
    }

    private static func cpuSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        let user = Double(usage.ru_utime.tv_sec) + Double(usage.ru_utime.tv_usec) / 1_000_000
        let system = Double(usage.ru_stime.tv_sec) + Double(usage.ru_stime.tv_usec) / 1_000_000
        return user + system
    }
}
