import AppKit
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

    func notifyDisplays() {
        send(["jsonrpc": "2.0", "method": "displays", "params": ["connected": [], "removed": [4]]])
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
    @MainActor
    func testOpenMenuRefreshesControlsAndWarningsInPlace() throws {
        let controller = LiveRecordingsStatusItem()
        let menu = NSMenu()
        var entry = LiveRecording(id: "menu", kind: "screen", title: "Test", pid: 1, startedAt: Date(), state: "recording", frames: 0, socket: "/tmp/menu.sock")
        entry.controls = ["pause", "resume", "stop"]
        controller.build(menu, list: [entry])
        let toggle = try XCTUnwrap(menu.items.first { $0.title == "Pause" })
        let stop = try XCTUnwrap(menu.items.first { $0.title == "Stop" })
        entry.state = "paused"
        entry.warning = "low disk"
        entry.lastError = "save refused"
        controller.refreshDetails([entry])
        XCTAssertTrue(menu.items.contains { $0 === toggle })
        XCTAssertEqual(toggle.title, "Resume")
        XCTAssertTrue(menu.items.contains { !$0.isHidden && $0.attributedTitle?.string == "low disk" })
        XCTAssertTrue(menu.items.contains { !$0.isHidden && $0.attributedTitle?.string == "save refused" })
        entry.state = "stopping"
        controller.refreshDetails([entry])
        XCTAssertFalse(toggle.isEnabled)
        XCTAssertFalse(stop.isEnabled)
    }

    @MainActor
    func testSessionStopDoesNotWaitAndHotplugReloadsDisplays() async throws {
        let entry = LiveRecording(id: "test", kind: "screen", title: "Test", pid: 1, startedAt: Date(), state: "recording", frames: 0, socket: server.path)
        let session = LiveRecordingSession(entry: entry)
        session.connectIfNeeded()
        defer { session.close() }
        session.call("stop", label: "Stop")
        try await waitUntil {
            self.server.requests.contains { $0["method"] as? String == "stop" }
                && self.server.requests.contains { $0["method"] as? String == "displays.list" }
        }
        let stop = try XCTUnwrap(server.requests.first { $0["method"] as? String == "stop" })
        XCTAssertEqual((stop["params"] as? [String: Any])?["wait"] as? Bool, false)
        let before = server.requests.filter { $0["method"] as? String == "displays.list" }.count
        server.notifyDisplays()
        try await waitUntil {
            self.server.requests.filter { $0["method"] as? String == "displays.list" }.count > before
        }
        XCTAssertEqual(server.requests.filter { $0["method"] as? String == "displays.list" }.count, before + 1)
        var single = entry
        single.controls = ["displays.list", "displays.switch"]
        single.connectedDisplays = [.init(id: 1, name: "Display", recorded: true)]
        let menu = LiveRecordingsStatusItem().displaysMenu(single)
        XCTAssertTrue(menu.items.contains { $0.identifier?.rawValue == "live-recording.only.1" })
        XCTAssertFalse(menu.items.contains { $0.identifier?.rawValue.hasPrefix("live-recording.mode.") == true })
        XCTAssertFalse(menu.items.contains { $0.identifier?.rawValue == "live-recording.display.1" })
    }

    /// Waits for the fake server to see the requests, with a deadline, instead of guessing a delay.
    @MainActor
    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(5)
        while !condition() {
            guard Date() < deadline else { throw NSError(domain: "recorder test deadline", code: 1) }
            try await Task.sleep(for: .milliseconds(100))
        }
    }

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

    func testAWriteToAPeerThatStoppedReadingGivesUpAndFailsTheCall() async throws {
        let path = "/tmp/lr-\(UUID().uuidString.prefix(8)).sock"
        unlink(path)
        let listener = socket(AF_UNIX, SOCK_STREAM, 0)
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        withUnsafeMutableBytes(of: &address.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(listener, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        XCTAssertEqual(bound, 0)
        XCTAssertEqual(Darwin.listen(listener, 1), 0)
        defer {
            Darwin.close(listener)
            unlink(path)
        }

        let client = LiveRecordingRPCClient(path: path, callbackQueue: DispatchQueue(label: "test.callbacks"), sendTimeout: 0.3)
        try client.connect()
        // Accepted and never read: the socket buffer fills and the write would wait for ever.
        let accepted = Darwin.accept(listener, nil, nil)
        defer { Darwin.close(accepted) }

        let started = Date()
        do {
            _ = try await client.call("render.export", params: ["blob": String(repeating: "x", count: 8 * 1024 * 1024)], timeout: 30)
            XCTFail("the call should fail when the write gives up")
        } catch {
            XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        }
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
        var warned = entry
        warned.warning = "stale file warning"
        XCTAssertNil(overlay.merged(into: warned).warning)
        overlay.applyWarning(["warning": "fresh"])
        XCTAssertEqual(overlay.merged(into: entry).warning, "fresh")
        overlay.applyWarning(["warning": NSNull()])
        XCTAssertNil(overlay.merged(into: warned).warning)
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

/// The other end of a connection that SENDS requests to the client and reads its answers: what the recorder service
/// does to the recorder host. Every line the client wrote is kept; `line(where:)` waits for one with a deadline.
final class FakeRPCPeer: @unchecked Sendable {
    let path = "/tmp/lp-\(UUID().uuidString.prefix(8)).sock"
    private var listener: Int32 = -1
    private var connection: Int32 = -1
    private let condition = NSCondition()
    private var lines: [[String: Any]] = []
    private var accepted = false

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

    func send(_ object: [String: Any]) {
        let deadline = Date().addingTimeInterval(3)
        condition.lock()
        while !accepted, condition.wait(until: deadline) {}
        condition.unlock()
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let bytes = Array(data) + [10]
        _ = bytes.withUnsafeBytes { write(connection, $0.baseAddress, $0.count) }
    }

    func request(_ id: Any, _ method: String, _ params: [String: Any]? = nil) {
        var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
        if let params { message["params"] = params }
        send(message)
    }

    /// The first line the client wrote that matches, waiting up to `timeout` for it.
    func line(timeout: TimeInterval = 3, where match: ([String: Any]) -> Bool) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while true {
            if let found = lines.first(where: match) { return found }
            guard condition.wait(until: deadline) else { throw NSError(domain: "fake peer: no matching line", code: 1) }
        }
    }

    var received: [[String: Any]] {
        condition.lock()
        defer { condition.unlock() }
        return lines
    }

    private func serve() {
        let accepted = accept(listener, nil, nil)
        condition.lock()
        connection = accepted
        self.accepted = accepted >= 0
        condition.broadcast()
        condition.unlock()
        guard accepted >= 0 else { return }
        var buffer: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = read(accepted, &chunk, chunk.count)
            guard count > 0 else { return }
            buffer.append(contentsOf: chunk[0..<count])
            while let newline = buffer.firstIndex(of: 10) {
                let line = Array(buffer[..<newline])
                buffer.removeSubrange(...newline)
                guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                condition.lock()
                lines.append(object)
                condition.broadcast()
                condition.unlock()
            }
        }
    }
}

/// The client as the side that answers: the peer's requests reach registered handlers, and both directions carry
/// `$/progress` and `$/cancel`.
final class LiveRecordingRPCAnswerTests: XCTestCase {
    private var peer: FakeRPCPeer!
    private var client: LiveRecordingRPCClient!

    override func setUpWithError() throws {
        peer = FakeRPCPeer()
        try peer.start()
        client = LiveRecordingRPCClient(path: peer.path, callbackQueue: DispatchQueue(label: "test.answers"))
    }

    override func tearDown() {
        client.close()
        peer.stop()
    }

    private func reply(to id: Int) -> ([String: Any]) -> Bool {
        { ($0["id"] as? NSNumber)?.intValue == id && $0["method"] == nil }
    }

    func testARegisteredHandlerAnswersOnTheSameConnectionWithTheRequestsId() throws {
        client.answer("window.list") { request, reply in
            reply(.success(["open": [["path": "/r/a", "title": "A"]], "asked": request.object["detail"] as? Bool ?? false]))
        }
        try client.connect()
        XCTAssertEqual(client.answers, ["window.list"])
        peer.request(7, "window.list", ["detail": true])
        let answer = try peer.line(where: reply(to: 7))
        XCTAssertEqual(answer["jsonrpc"] as? String, "2.0")
        let result = try XCTUnwrap(answer["result"] as? [String: Any])
        XCTAssertEqual(result["asked"] as? Bool, true)
        XCTAssertEqual((result["open"] as? [[String: Any]])?.first?["title"] as? String, "A")
        peer.request("s-1", "window.list")
        let byString = try peer.line { $0["id"] as? String == "s-1" }
        XCTAssertNotNil(byString["result"], "a string id is answered with the same string")
    }

    func testAnUnknownMethodAnswersMethodNotFound() throws {
        try client.connect()
        peer.request(3, "render.nothing")
        let error = try XCTUnwrap(peer.line(where: reply(to: 3))["error"] as? [String: Any])
        XCTAssertEqual((error["code"] as? NSNumber)?.intValue, -32601)
        XCTAssertTrue((error["message"] as? String ?? "").contains("render.nothing"))
    }

    func testAThrownErrorGoesOutWithItsCodeAndAPlainErrorAsInternal() throws {
        client.answer("camera.start") { _, reply in reply(.failure(LiveRecordingRPCClient.Failure.remote(code: 1014, message: "camera denied"))) }
        client.answer("render.still") { _, reply in reply(.failure(NSError(domain: "x", code: 2, userInfo: [NSLocalizedDescriptionKey: "no movie"]))) }
        client.answer("odd") { _, reply in reply(.success(["when": Date()])) }
        try client.connect()
        peer.request(1, "camera.start")
        peer.request(2, "render.still")
        peer.request(3, "odd")
        let denied = try XCTUnwrap(peer.line(where: reply(to: 1))["error"] as? [String: Any])
        XCTAssertEqual((denied["code"] as? NSNumber)?.intValue, 1014)
        XCTAssertEqual(denied["message"] as? String, "camera denied")
        let plain = try XCTUnwrap(peer.line(where: reply(to: 2))["error"] as? [String: Any])
        XCTAssertEqual((plain["code"] as? NSNumber)?.intValue, -32603)
        XCTAssertEqual(plain["message"] as? String, "no movie")
        let unencodable = try XCTUnwrap(peer.line(where: reply(to: 3))["error"] as? [String: Any])
        XCTAssertEqual((unencodable["code"] as? NSNumber)?.intValue, -32603, "an answer that is not JSON is refused, not dropped")
    }

    func testProgressGoesOutBeforeTheAnswerAndNamesTheRequest() throws {
        client.answer("render.export") { request, reply in
            request.progress(fraction: 0.5, label: "export")
            request.progress(label: "finishing")
            reply(.success(["ok": true]))
        }
        try client.connect()
        peer.request(9, "render.export")
        _ = try peer.line(where: reply(to: 9))
        let lines = peer.received
        let steps = lines.filter { $0["method"] as? String == "$/progress" }
        XCTAssertEqual(steps.count, 2)
        let first = try XCTUnwrap(steps.first?["params"] as? [String: Any])
        XCTAssertEqual((first["id"] as? NSNumber)?.intValue, 9)
        XCTAssertEqual((first["fraction"] as? NSNumber)?.doubleValue, 0.5)
        XCTAssertEqual(first["label"] as? String, "export")
        XCTAssertNil((steps.last?["params"] as? [String: Any])?["fraction"])
        XCTAssertNil(steps.first?["id"], "progress is a notification")
        let answerIndex = try XCTUnwrap(lines.firstIndex(where: reply(to: 9)))
        XCTAssertTrue(lines.indices.filter { lines[$0]["method"] as? String == "$/progress" }.allSatisfy { $0 < answerIndex })
    }

    func testACancelAnswers1013AtOnceRunsOnCancelAndDropsTheLateAnswer() throws {
        let cancelled = expectation(description: "onCancel ran")
        var held: ((Result<Any?, Error>) -> Void)?
        var request: LiveRecordingRPCClient.Incoming?
        client.answer("render.export") { incoming, reply in
            request = incoming
            held = reply
            incoming.onCancel { cancelled.fulfill() }
        }
        try client.connect()
        peer.request(4, "render.export")
        Thread.sleep(forTimeInterval: 0.2)
        peer.send(["jsonrpc": "2.0", "method": "$/cancel", "params": ["id": 4]])
        let error = try XCTUnwrap(peer.line(where: reply(to: 4))["error"] as? [String: Any])
        XCTAssertEqual((error["code"] as? NSNumber)?.intValue, 1013)
        wait(for: [cancelled], timeout: 2)
        XCTAssertEqual(request?.isCancelled, true)
        held?(.success(["ok": true]))
        request?.progress(fraction: 0.9)
        // A request after the cancel proves the late answer and progress would have been written before it.
        client.answer("ping") { _, reply in reply(.success("pong")) }
        peer.request(5, "ping")
        _ = try peer.line(where: reply(to: 5))
        XCTAssertEqual(peer.received.filter { ($0["id"] as? NSNumber)?.intValue == 4 }.count, 1, "one answer for the cancelled request")
        XCTAssertFalse(peer.received.contains { $0["method"] as? String == "$/progress" }, "no progress after a cancel")
    }

    func testOwnCallsTakeTheirProgressAndSendCancel() throws {
        try client.connect()
        let stepped = expectation(description: "progress arrived")
        let ended = expectation(description: "call ended")
        var notified: [String] = []
        client.onNotification = { method, _ in notified.append(method) }
        var step: LiveRecordingRPCClient.CallProgress?
        var outcome: Result<Any?, Error>?
        let id = client.request("edit.apply", timeout: 5, onProgress: { step = $0; stepped.fulfill() }) { result in
            outcome = result
            ended.fulfill()
        }
        let sent = try peer.line { $0["method"] as? String == "edit.apply" }
        XCTAssertEqual((sent["id"] as? NSNumber)?.intValue, id, "the returned id is the one on the wire")
        peer.send(["jsonrpc": "2.0", "method": "$/progress", "params": ["id": id, "fraction": 0.25, "label": "apply"]])
        wait(for: [stepped], timeout: 2)
        XCTAssertEqual(step, .init(fraction: 0.25, label: "apply"))
        client.cancel(id)
        let cancel = try peer.line { $0["method"] as? String == "$/cancel" }
        XCTAssertEqual(((cancel["params"] as? [String: Any])?["id"] as? NSNumber)?.intValue, id)
        XCTAssertNil(cancel["id"], "a cancel is a notification")
        peer.send(["jsonrpc": "2.0", "id": id, "error": ["code": 1013, "message": "cancelled"]])
        wait(for: [ended], timeout: 2)
        guard case let .failure(error)? = outcome else { return XCTFail("the cancelled call succeeded") }
        XCTAssertEqual(error as? LiveRecordingRPCClient.Failure, .remote(code: 1013, message: "cancelled"))
        XCTAssertTrue(notified.isEmpty, "$/progress never reaches onNotification")
    }

    // Regression test: 2026-11-05 recorder service review, finding 11 — progress did not extend the call's deadline
    func testEachProgressStartsTheDeadlineAgainSoALongCallGetsItsAnswer() throws {
        try client.connect()
        let ended = expectation(description: "call ended")
        var outcome: Result<Any?, Error>?
        // No progress handler: the deadline follows the peer's steps all the same.
        let id = client.request("render.export", timeout: 0.5) { result in
            outcome = result
            ended.fulfill()
        }
        _ = try peer.line { $0["method"] as? String == "render.export" }
        for _ in 0..<3 {
            Thread.sleep(forTimeInterval: 0.3)
            peer.send(["jsonrpc": "2.0", "method": "$/progress", "params": ["id": id, "fraction": 0.5]])
        }
        Thread.sleep(forTimeInterval: 0.3)
        peer.send(["jsonrpc": "2.0", "id": id, "result": ["ok": true]])
        wait(for: [ended], timeout: 2)
        guard case let .success(value)? = outcome else {
            return XCTFail("the call failed although each step came within its deadline: \(String(describing: outcome))")
        }
        XCTAssertEqual((value as? [String: Any])?["ok"] as? Bool, true)
    }

    func testNotifySendsAMessageWithNoID() throws {
        try client.connect()
        client.notify("window.changed", params: ["open": []])
        let line = try peer.line { $0["method"] as? String == "window.changed" }
        XCTAssertNil(line["id"])
        XCTAssertNotNil((line["params"] as? [String: Any])?["open"])
    }

    func testAHangUpCancelsTheOpenRequests() throws {
        let cancelled = expectation(description: "the open request was cancelled")
        client.answer("render.export") { incoming, _ in incoming.onCancel { cancelled.fulfill() } }
        try client.connect()
        peer.request(1, "render.export")
        Thread.sleep(forTimeInterval: 0.2)
        peer.stop()
        wait(for: [cancelled], timeout: 2)
    }
}
