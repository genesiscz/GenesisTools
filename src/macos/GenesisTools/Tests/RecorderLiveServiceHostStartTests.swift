import XCTest
@testable import GenesisToolsRecorder

/// 2026-11-09 12:45 to 12:47: `tools recorder serve` failed three times on a source file another agent had half
/// edited, the host stopped starting the service for the rest of the face's life, and a camera recording at 12:50
/// found no service and failed. A failed start is retried slowly, and a caller that needs the host gets it at once.
@MainActor
final class RecorderLiveServiceHostStartTests: XCTestCase {
    private var folder: URL!
    private var host: RecorderServiceHost?

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-live-host-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        host?.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    private func failingHost(timing: RecorderServiceHost.Timing, starts: @escaping () -> Void) -> RecorderServiceHost {
        let host = RecorderServiceHost(folder: folder, methods: [:], timing: timing, pid: 4242) { failed in
            starts()
            DispatchQueue.main.async { failed(1, "SyntaxError: Export named 'x' not found") }
        }
        self.host = host
        return host
    }

    private func waitUntil(_ timeout: TimeInterval, _ what: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { throw NSError(domain: "recorder live host test: \(what)", code: 1) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    func testStartsThatKeepFailingAreTriedAgainSlowlyNeverGivenUp() async throws {
        var starts = 0
        let timing = RecorderServiceHost.Timing(retry: 0.1, maxRetry: 0.2, socketWait: 1, socketSteps: [0.05],
                                                startThrottle: 0, maxFailedStarts: 2, failedStartRetry: 0.8, helloTimeout: 1)
        let host = failingHost(timing: timing) { starts += 1 }
        host.start()
        try await waitUntil(3, "two failed starts") { starts == 2 }
        let limit = Date()
        try await waitUntil(5, "a third start after failedStartRetry") { starts == 3 }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(limit), 0.6, "past the limit, starts wait failedStartRetry")
    }

    func testAttachNowStartsTheServiceAtOncePastTheLimit() async throws {
        var starts = 0
        let timing = RecorderServiceHost.Timing(retry: 0.1, maxRetry: 0.2, socketWait: 1, socketSteps: [0.05],
                                                startThrottle: 0, maxFailedStarts: 2, failedStartRetry: 600, helloTimeout: 1)
        let host = failingHost(timing: timing) { starts += 1 }
        host.start()
        try await waitUntil(3, "two failed starts") { starts == 2 }
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(starts, 2, "no third start inside failedStartRetry")
        host.attachNow()
        XCTAssertEqual(starts, 3, "attachNow starts the service at once")
        XCTAssertEqual(host.state, .waitingForService)
    }
}
