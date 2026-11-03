import Darwin
import XCTest

@testable import GenesisKit

/// A one-connection JSON-RPC server on a Unix socket: answers `status`, refuses `pause`, never answers `slow`, and
/// sends a `frame` notification after `subscribe`. Every request line it read is kept for the assertions.
private final class FakeRecorderServer: @unchecked Sendable {
    let path = "/tmp/lr-\(UUID().uuidString.prefix(8)).sock"
    private var listener: Int32 = -1
    private var connection: Int32 = -1
    private let lock = NSLock()
    private var lines: [[String: Any]] = []

    var requests: [[String: Any]] {
        lock.lock()
        defer { lock.unlock() }
        return lines
    }

    func start() throws {
        unlink(path)
        listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard bound == 0, listen(listener, 4) == 0 else { throw POSIXError(.EADDRINUSE) }
        Thread.detachNewThread { [self] in serve() }
    }

    func stop() {
        if connection >= 0 { shutdown(connection, SHUT_RDWR) }
        close(listener)
        unlink(path)
    }

    /// Ends the connection from the server's side, as a recorder that quits does.
    func hangUp() {
        if connection >= 0 { shutdown(connection, SHUT_RDWR) }
    }

    private func send(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let bytes = Array(data) + [10]
        _ = bytes.withUnsafeBytes { write(connection, $0.baseAddress, $0.count) }
    }

    private func serve() {
        connection = accept(listener, nil, nil)
        guard connection >= 0 else { return }
        var buffer: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(connection, &chunk, chunk.count)
            guard count > 0 else { return }
            buffer.append(contentsOf: chunk[0..<count])
            while let newline = buffer.firstIndex(of: 10) {
                let line = Array(buffer[..<newline])
                buffer.removeSubrange(...newline)
                guard let request = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                lock.lock()
                lines.append(request)
                lock.unlock()
                answer(request)
            }
        }
    }

    private func answer(_ request: [String: Any]) {
        let id = request["id"] ?? NSNull()
        switch request["method"] as? String {
        case "status":
            send(["jsonrpc": "2.0", "id": id, "result": ["state": "recording", "frames": 12, "mode": "all"]])
        case "pause":
            send(["jsonrpc": "2.0", "id": id, "error": ["code": -32000, "message": "already paused"]])
        case "subscribe":
            send(["jsonrpc": "2.0", "id": id, "result": true])
            send(["jsonrpc": "2.0", "method": "frame", "params": ["displayId": 2, "at": "2026-11-03T18:40:00Z", "file": "/x.jpg"]])
        case "displays.list":
            send(["jsonrpc": "2.0", "id": id, "result": [
                "mode": "follow-focus",
                "displays": [["id": 1, "name": "Built-in", "recorded": true], ["id": 2, "name": "DELL", "recorded": false]],
            ]])
        default:
            break
        }
    }
}

final class LiveRecordingRPCClientTests: XCTestCase {
    private var server: FakeRecorderServer!

    override func setUpWithError() throws {
        server = FakeRecorderServer()
        try server.start()
    }

    override func tearDown() {
        server.stop()
    }

    private func connected() throws -> LiveRecordingRPCClient {
        let client = LiveRecordingRPCClient(path: server.path, callbackQueue: DispatchQueue(label: "test.callbacks"))
        try client.connect()
        return client
    }

    func testCallSendsJSONRPCAndReturnsTheResult() async throws {
        let client = try connected()
        let result = try await client.call("status") as? [String: Any]
        XCTAssertEqual(result?["state"] as? String, "recording")
        XCTAssertEqual((result?["frames"] as? NSNumber)?.intValue, 12)
        let request = try XCTUnwrap(server.requests.first)
        XCTAssertEqual(request["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(request["method"] as? String, "status")
        XCTAssertNotNil(request["id"] as? NSNumber)
        client.close()
    }

    func testParamsAreSentAndIdsDiffer() async throws {
        let client = try connected()
        _ = try await client.call("displays.list")
        _ = try? await client.call("pause", params: ["displayId": 2])
        let requests = server.requests
        XCTAssertEqual(requests.count, 2)
        XCTAssertNotEqual(requests[0]["id"] as? NSNumber, requests[1]["id"] as? NSNumber)
        XCTAssertEqual(((requests[1]["params"] as? [String: Any])?["displayId"] as? NSNumber)?.intValue, 2)
        client.close()
    }

    func testRemoteErrorCarriesTheRecordersMessage() async throws {
        let client = try connected()
        do {
            _ = try await client.call("pause")
            XCTFail("pause should fail")
        } catch let failure as LiveRecordingRPCClient.Failure {
            XCTAssertEqual(failure, .remote(code: -32000, message: "already paused"))
            XCTAssertEqual(failure.localizedDescription, "already paused")
        }
        client.close()
    }

    func testUnansweredCallTimesOut() async throws {
        let client = try connected()
        let started = Date()
        do {
            _ = try await client.call("slow", timeout: 0.3)
            XCTFail("slow should time out")
        } catch let failure as LiveRecordingRPCClient.Failure {
            XCTAssertEqual(failure, .timeout(method: "slow"))
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 2)
        client.close()
    }

    func testNotificationsArriveAfterSubscribe() throws {
        let client = try connected()
        let arrived = expectation(description: "frame notification")
        client.onNotification = { method, params in
            XCTAssertEqual(method, "frame")
            XCTAssertEqual(((params as? [String: Any])?["displayId"] as? NSNumber)?.intValue, 2)
            arrived.fulfill()
        }
        client.call("subscribe") { _ in }
        wait(for: [arrived], timeout: 2)
        client.close()
    }

    func testServerHangUpClosesAndFailsPendingCalls() throws {
        let client = try connected()
        let closed = expectation(description: "closed")
        let failed = expectation(description: "pending call failed")
        client.onClose = { closed.fulfill() }
        client.call("slow", timeout: 5) { result in
            if case let .failure(error) = result, error as? LiveRecordingRPCClient.Failure == .closed { failed.fulfill() }
        }
        Thread.sleep(forTimeInterval: 0.2)
        server.hangUp()
        wait(for: [closed, failed], timeout: 2)
    }

    func testRefusedSocketThrowsConnect() {
        let client = LiveRecordingRPCClient(path: "/tmp/lr-none-\(UUID().uuidString.prefix(6)).sock")
        XCTAssertThrowsError(try client.connect()) { error in
            guard case .connect = error as? LiveRecordingRPCClient.Failure else {
                return XCTFail("expected a connect failure, got \(error)")
            }
        }
    }
}

final class LiveRecordingOverlayTests: XCTestCase {
    private let entry = LiveRecording(id: "m", kind: "meeting", title: "M", pid: 1, startedAt: Date(timeIntervalSince1970: 0),
                                      state: "recording", frames: 5)

    func testStatusFramesAndDisplaysLayOverTheFile() {
        var overlay = LiveRecordingOverlay()
        overlay.applyStatus(["state": "paused", "frames": 7, "warning": "display 2 went away"])
        overlay.applyFrame(["displayId": 2, "at": "2026-11-03T18:40:00Z", "file": "/x.jpg"])
        overlay.applyDisplays(["mode": "follow-focus", "displays": [
            ["id": 1, "name": "Built-in", "recorded": true], ["displayId": 2, "name": "DELL"],
        ]])
        let merged = overlay.merged(into: entry)
        XCTAssertEqual(merged.state, "paused")
        XCTAssertEqual(merged.frames, 8)
        XCTAssertNotNil(merged.lastFrameAt)
        XCTAssertEqual(merged.warning, "display 2 went away")
        XCTAssertEqual(merged.mode, "follow-focus")
        XCTAssertEqual(merged.connectedDisplays, [.init(id: 1, name: "Built-in", recorded: true),
                                                  .init(id: 2, name: "DELL", recorded: false)])
    }

    func testDisplaysAsBareListAndWarningShapes() {
        var overlay = LiveRecordingOverlay()
        overlay.applyDisplays([["id": 3, "name": "LG", "recorded": true]])
        XCTAssertEqual(overlay.displays?.map(\.id), [3])
        overlay.applyWarning("low disk")
        XCTAssertEqual(overlay.warning, "low disk")
        overlay.applyWarning(["message": "stream error"])
        XCTAssertEqual(overlay.warning, "stream error")
        overlay.applyStatus(["warning": NSNull()])
        XCTAssertNil(overlay.warning)
    }

    func testFileFramesWinWhenTheyAreAhead() {
        var overlay = LiveRecordingOverlay()
        overlay.applyFrame(nil)
        XCTAssertEqual(overlay.merged(into: entry).frames, 5)
    }

    func testControlNeedsASocket() {
        var recording = entry
        XCTAssertTrue(recording.allows(.stop))
        recording.canControl = false
        XCTAssertFalse(recording.allows(.stop))
        XCTAssertNil(recording.toggleCommand)
    }
}
