import AVFoundation
import Darwin
import XCTest
@testable import GenesisToolsRecorder

/// A recorder service in the test: a Unix socket server that answers the host's `hello`, sends the host requests and
/// keeps every line the host wrote. It accepts again after a hang-up, as a restarted service would.
private final class FakeRecorderService: @unchecked Sendable {
    let path = "/tmp/rs-\(UUID().uuidString.prefix(8)).sock"
    /// The `hello` answer: `["result": …]` or `["error": …]`.
    var helloAnswer: [String: Any] = ["result": ["protocol": 1, "methods": ["session.open", "edit.apply"], "version": "test"]]
    private var listener: Int32 = -1
    private var connection: Int32 = -1
    private let condition = NSCondition()
    private var lines: [[String: Any]] = []
    private(set) var accepted = 0
    private var stopped = false

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
        Thread.detachNewThread { [self] in acceptLoop() }
    }

    func stop() {
        condition.lock()
        stopped = true
        let open = connection
        condition.unlock()
        if open >= 0 { shutdown(open, SHUT_RDWR) }
        shutdown(listener, SHUT_RDWR)
        close(listener)
        unlink(path)
    }

    /// Ends the current connection from the service's side.
    func hangUp() {
        condition.lock()
        let open = connection
        condition.unlock()
        if open >= 0 { shutdown(open, SHUT_RDWR) }
    }

    func request(_ id: Int, _ method: String, _ params: [String: Any]? = nil) {
        var message: [String: Any] = ["jsonrpc": "2.0", "id": id, "method": method]
        if let params { message["params"] = params }
        send(message)
    }

    func send(_ object: [String: Any]) {
        condition.lock()
        let open = connection
        condition.unlock()
        guard open >= 0, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let bytes = Array(data) + [10]
        _ = bytes.withUnsafeBytes { write(open, $0.baseAddress, $0.count) }
    }

    /// The first line (of any connection) that matches, waiting up to `timeout`.
    func line(timeout: TimeInterval = 5, where match: ([String: Any]) -> Bool) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while true {
            if let found = lines.first(where: match) { return found }
            guard condition.wait(until: deadline) else { throw NSError(domain: "fake service: no matching line", code: 1) }
        }
    }

    func reply(to id: Int, timeout: TimeInterval = 10) throws -> [String: Any] {
        try line(timeout: timeout) { ($0["id"] as? NSNumber)?.intValue == id && $0["method"] == nil }
    }

    var received: [[String: Any]] {
        condition.lock()
        defer { condition.unlock() }
        return lines
    }

    func count(_ method: String) -> Int { received.filter { $0["method"] as? String == method }.count }

    private func acceptLoop() {
        while true {
            let next = accept(listener, nil, nil)
            condition.lock()
            if stopped || next < 0 {
                condition.unlock()
                if next >= 0 { close(next) }
                return
            }
            connection = next
            accepted += 1
            condition.unlock()
            read(next)
        }
    }

    private func read(_ descriptor: Int32) {
        var buffer: [UInt8] = []
        var chunk = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = Darwin.read(descriptor, &chunk, chunk.count)
            guard count > 0 else {
                close(descriptor)
                return
            }
            buffer.append(contentsOf: chunk[0..<count])
            while let newline = buffer.firstIndex(of: 10) {
                let line = Array(buffer[..<newline])
                buffer.removeSubrange(...newline)
                guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any] else { continue }
                condition.lock()
                lines.append(object)
                condition.broadcast()
                condition.unlock()
                if object["method"] as? String == "hello", let id = object["id"] {
                    send(["jsonrpc": "2.0", "id": id].merging(helloAnswer) { $1 })
                }
            }
        }
    }
}

/// The face's windows and camera, recorded instead of opened.
@MainActor
private final class FakeFace: RecorderHostFace {
    var opened: [(path: String, focus: Bool, atSeconds: Double?, tab: InspectorTab?)] = []
    var shown: [String] = []
    var camera: CameraBubble.StartAnswer = .started
    var cameraFolders: [String] = []
    var windows: [String: Any] = ["open": [["path": "/r/demo", "title": "Demo", "window": 41]], "front": ["path": "/r/demo", "title": "Demo", "window": 41]]

    func openEditor(path: String, focus: Bool, atSeconds: Double?, tab: InspectorTab?) async throws -> Int {
        opened.append((path, focus, atSeconds, tab))
        return 41
    }

    func showLibrary(focus: Bool) { shown.append("library:\(focus)") }
    func showPicker() { shown.append("picker") }
    func openWindows() -> [String: Any] { windows }

    func startCamera(folder: URL) async -> CameraBubble.StartAnswer {
        cameraFolders.append(folder.path)
        return camera
    }

    func stopCamera(folder: URL) -> Bool { cameraFolders.last == folder.path }
}

@MainActor
final class RecorderServiceHostTests: XCTestCase {
    private var service: FakeRecorderService!
    private var folder: URL!
    private var host: RecorderServiceHost?
    private var face: FakeFace!

    override func setUp() async throws {
        service = FakeRecorderService()
        try service.start()
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("recorder-host-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        face = FakeFace()
    }

    override func tearDown() async throws {
        host?.stop()
        service.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    private static let fast = RecorderServiceHost.Timing(retry: 0.2, maxRetry: 1, socketWait: 3, socketSteps: [0.05, 0.1],
                                                         startThrottle: 0, maxFailedStarts: 2, helloTimeout: 2)

    private func writeDiscovery(socket: String? = nil, pid: Int32 = getpid()) throws {
        let object: [String: Any] = ["version": 1, "protocol": 1, "pid": Int(pid), "socket": socket ?? service.path,
                                     "startedAt": "2026-11-05T04:00:00.000Z", "codeStamp": "test"]
        try JSONSerialization.data(withJSONObject: object).write(to: folder.appendingPathComponent("service.json"))
    }

    private func makeHost(timing: RecorderServiceHost.Timing = fast,
                          start: @escaping RecorderServiceHost.ServiceStarter = { _ in XCTFail("the service was started") }) -> RecorderServiceHost {
        let host = RecorderServiceHost(folder: folder, methods: RecorderHostMethods.table(face: face), timing: timing, pid: 4242,
                                       startService: start)
        self.host = host
        return host
    }

    private func waitUntil(_ timeout: TimeInterval = 5, _ what: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else { throw NSError(domain: "recorder host test: \(what)", code: 1) }
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    private func isConnected(_ host: RecorderServiceHost) -> Bool {
        if case .connected = host.state { return true }
        return false
    }

    private func connectedHost() async throws -> RecorderServiceHost {
        try writeDiscovery()
        let host = makeHost()
        host.start()
        try await waitUntil(5, "connected") { isConnected(host) }
        return host
    }

    /// The service's request, answered off the main thread so the host's main-actor handlers can run meanwhile.
    private func ask(_ id: Int, _ method: String, _ params: [String: Any]? = nil, timeout: TimeInterval = 10) async throws -> [String: Any] {
        service.request(id, method, params)
        let service = service!
        return try await Task.detached { try service.reply(to: id, timeout: timeout) }.value
    }

    private func errorCode(_ answer: [String: Any]) -> Int? {
        ((answer["error"] as? [String: Any])?["code"] as? NSNumber)?.intValue
    }

    /// The answer's `result` object; fails the test when the host answered an error.
    private func result(_ id: Int, _ method: String, _ params: [String: Any]? = nil, timeout: TimeInterval = 10) async throws -> [String: Any] {
        let answer = try await ask(id, method, params, timeout: timeout)
        return try XCTUnwrap(answer["result"] as? [String: Any], "\(method) answered \(answer)")
    }

    private func refusal(_ id: Int, _ method: String, _ params: [String: Any]? = nil) async throws -> Int? {
        errorCode(try await ask(id, method, params))
    }

    // MARK: The connection

    func testTheHostSaysHelloAsTheHostWithEveryMethodItAnswersThenSendsTheWindows() async throws {
        var connectedCalls = 0
        try writeDiscovery()
        let host = makeHost()
        host.onConnected = { connectedCalls += 1; $0.notify("window.changed", params: ["open": []]) }
        host.start()
        try await waitUntil(5, "connected") { isConnected(host) }
        XCTAssertEqual(host.state, .connected(methods: ["session.open", "edit.apply"]))
        let hello = try XCTUnwrap(service.received.first { $0["method"] as? String == "hello" }?["params"] as? [String: Any])
        XCTAssertEqual(hello["role"] as? String, "host")
        XCTAssertEqual((hello["protocol"] as? NSNumber)?.intValue, 1)
        XCTAssertEqual((hello["pid"] as? NSNumber)?.intValue, 4242)
        XCTAssertEqual(hello["answers"] as? [String], ["camera.start", "camera.stop", "render.export", "render.sheet", "render.snapshot",
                                                        "render.still", "window.list", "window.open", "window.show"])
        _ = try service.line { $0["method"] as? String == "window.changed" }
        XCTAssertEqual(connectedCalls, 1)
    }

    func testWithNoLiveServiceItStartsOneOnceAndWaitsForItsSocket() async throws {
        var starts = 0
        let host = makeHost { [folder, service] _ in
            starts += 1
            // The service opens its socket a moment after it starts.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                let object: [String: Any] = ["version": 1, "protocol": 1, "pid": Int(getpid()), "socket": service!.path]
                try? JSONSerialization.data(withJSONObject: object).write(to: folder!.appendingPathComponent("service.json"))
            }
        }
        host.start()
        XCTAssertEqual(host.state, .waitingForService)
        try await waitUntil(5, "connected after the start") { isConnected(host) }
        XCTAssertEqual(starts, 1)
    }

    func testAServiceJSONOfAProcessThatIsGoneIsNoService() async throws {
        let gone = Process()
        gone.executableURL = URL(fileURLWithPath: "/usr/bin/true")
        try gone.run()
        gone.waitUntilExit()
        try writeDiscovery(pid: gone.processIdentifier)
        XCTAssertNil(makeHost().discoveredSocket())
        try writeDiscovery()
        XCTAssertEqual(makeHost().discoveredSocket(), service.path)
    }

    func testADroppedConnectionIsTriedAgainAfterTheThrottle() async throws {
        let host = try await connectedHost()
        service.hangUp()
        try await waitUntil(5, "retrying") { if case .retrying = host.state { return true } else { return false } }
        let dropped = Date()
        try await waitUntil(5, "the second hello") { self.service.count("hello") == 2 }
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(dropped), 0.15, "the reconnect waits for the throttle")
        try await waitUntil(5, "connected again") { isConnected(host) }
        XCTAssertEqual(service.accepted, 2)
    }

    func testAStartThatKeepsFailingIsNotRepeatedPastTheLimit() async throws {
        var starts = 0
        let host = makeHost { failed in
            starts += 1
            DispatchQueue.main.async { failed(1, "error: unknown command 'serve'") }
        }
        host.start()
        try await waitUntil(5, "two failed starts") { starts == 2 }
        try await Task.sleep(for: .milliseconds(1500))
        XCTAssertEqual(starts, 2, "no third start after maxFailedStarts")
        // A service that shows up later is still found.
        try writeDiscovery()
        try await waitUntil(5, "connected to the late service") { isConnected(host) }
    }

    func testAHostTakenAnswerWaitsTheLongDelayAndAProtocolMismatchToo() async throws {
        service.helloAnswer = ["error": ["code": 1012, "message": "another host is connected"]]
        try writeDiscovery()
        let host = makeHost()
        host.start()
        try await waitUntil(5, "refused") { host.state == .retrying(after: 1) }
        service.helloAnswer = ["result": ["protocol": 2, "methods": [], "version": "next"]]
        try await waitUntil(5, "the second hello") { self.service.count("hello") == 2 }
        try await waitUntil(5, "refused again") { host.state == .retrying(after: 1) }
        XCTAssertFalse(isConnected(host), "a service of another protocol is not used")
    }

    // MARK: The methods

    func testWindowOpenCallsTheFaceAndAnswersTheWindow() async throws {
        _ = try await connectedHost()
        let answer = try await ask(10, "window.open", ["path": "/tmp/../tmp/rec", "atSeconds": 4.5, "tab": "zoom", "focus": false])
        let opened = try XCTUnwrap(answer["result"] as? [String: Any])
        XCTAssertEqual(opened["opened"] as? Bool, true)
        XCTAssertEqual((opened["window"] as? NSNumber)?.intValue, 41)
        XCTAssertEqual(face.opened.first?.path, "/tmp/rec")
        XCTAssertEqual(face.opened.first?.focus, false)
        XCTAssertEqual(face.opened.first?.atSeconds, 4.5)
        XCTAssertEqual(face.opened.first?.tab, .zoom)
        let badTab = try await ask(11, "window.open", ["path": "/tmp/rec", "tab": "colour"])
        XCTAssertEqual(errorCode(badTab), -32602)
        let relative = try await ask(12, "window.open", ["path": "rec"])
        XCTAssertEqual(errorCode(relative), -32602)
        let none = try await ask(13, "window.open")
        XCTAssertEqual(errorCode(none), -32602)
        XCTAssertEqual(face.opened.count, 1, "a refused open reaches no window")
    }

    func testWindowShowAndListAnswerFromTheFace() async throws {
        _ = try await connectedHost()
        _ = try await ask(20, "window.show", ["which": "library", "focus": false])
        _ = try await ask(21, "window.show", ["which": "picker"])
        XCTAssertEqual(face.shown, ["library:false", "picker"])
        let wrong = try await ask(22, "window.show", ["which": "hub"])
        XCTAssertEqual(errorCode(wrong), -32602)
        let list = try await result(23, "window.list")
        XCTAssertEqual(((list["open"] as? [[String: Any]])?.first?["window"] as? NSNumber)?.intValue, 41)
        XCTAssertEqual((list["front"] as? [String: Any])?["path"] as? String, "/r/demo")
    }

    func testTheEditorsOpenStateCarriesNoWindowsWhenNoneIsOpen() {
        XCTAssertEqual((EditorWindows.shared.openState()["open"] as? [Any])?.count, 0)
        XCTAssertNil(EditorWindows.shared.openState()["front"])
    }

    func testCameraStartAnswersStartedOrTheCodedRefusal() async throws {
        _ = try await connectedHost()
        let started = try await ask(30, "camera.start", ["folder": folder.path])
        XCTAssertEqual(started["result"] as? [String: Bool], ["started": true])
        face.camera = .denied
        let denied = try await refusal(31, "camera.start", ["folder": folder.path])
        XCTAssertEqual(denied, 1014)
        face.camera = .busy("/r/other")
        let busy = try await ask(32, "camera.start", ["folder": folder.path])
        XCTAssertEqual(errorCode(busy), 1015)
        XCTAssertTrue(((busy["error"] as? [String: Any])?["message"] as? String ?? "").contains("/r/other"))
        let missing = try await refusal(33, "camera.start", ["folder": folder.appendingPathComponent("missing").path])
        XCTAssertEqual(missing, -32602)
        let stopped = try await ask(34, "camera.stop", ["folder": folder.path])
        XCTAssertEqual(stopped["result"] as? [String: Bool], ["stopped": true])
    }

    func testRenderStillAndSheetAnswerTheHeadlessFields() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie, frames: 60)
        _ = try await connectedHost()
        let stillOut = folder.appendingPathComponent("still.png").path
        let still = try await result(40, "render.still", ["path": movie.path, "atSeconds": 1, "out": stillOut])
        XCTAssertEqual(Set(still.keys), ["ok", "path", "width", "height", "atSeconds"])
        XCTAssertEqual(still["ok"] as? Bool, true)
        XCTAssertEqual(still["path"] as? String, stillOut)
        XCTAssertEqual((still["width"] as? NSNumber)?.intValue, 320)
        XCTAssertEqual((still["height"] as? NSNumber)?.intValue, 200)
        XCTAssertNotNil(NSImage(contentsOfFile: stillOut), "the still is a picture")
        let sheetOut = folder.appendingPathComponent("sheet.png").path
        let sheet = try await result(41, "render.sheet", ["path": movie.path, "times": [0.5, 1, 1.5], "out": sheetOut])
        XCTAssertEqual(Set(sheet.keys), ["ok", "path", "width", "height", "times"])
        XCTAssertEqual((sheet["width"] as? NSNumber)?.intValue, ContactSheet.columns * ContactSheet.tileWidth + (ContactSheet.columns + 1) * ContactSheet.gap)
        XCTAssertEqual(sheet["times"] as? [Double], [0.5, 1, 1.5])
        let noTimes = try await refusal(42, "render.sheet", ["path": movie.path, "times": []])
        XCTAssertEqual(noTimes, -32602)
        let missing = try await refusal(43, "render.still", ["path": folder.appendingPathComponent("none.mp4").path])
        XCTAssertEqual(missing, -32603, "a render that fails answers its error")
    }

    /// The three renders the host answers run off the main thread. A still and a sheet finish while the test holds the
    /// main thread; an export opens the edit, builds its composition and writes its movie while the main thread is held,
    /// and its progress reaches the main thread once it is free.
    func testTheRendersRunWhileTheMainThreadIsHeld() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie, frames: 90)
        let stillOut = folder.appendingPathComponent("held-still.png").path
        let sheetOut = folder.appendingPathComponent("held-sheet.png").path
        let rendered = DispatchSemaphore(value: 0)
        let renders = Task.detached { () throws -> [Bool] in
            defer { rendered.signal() }
            let still = try await RecorderRenders.still(source: movie.path, atSeconds: 1, out: stillOut, full: false)
            let sheet = try await RecorderRenders.sheet(source: movie.path, times: [0.5, 1, 1.5], out: sheetOut)
            return [still["ok"] as? Bool == true, sheet["ok"] as? Bool == true]
        }
        // This holds the main thread until the renders end, or 15 s.
        XCTAssertEqual(rendered.wait(timeout: .now() + 15), .success, "a still and a sheet finish while the main thread is held")
        let answered = try await renders.value
        XCTAssertEqual(answered, [true, true])

        let out = folder.appendingPathComponent("held.mp4")
        let partial = folder.appendingPathComponent("held.partial.mp4")
        let progress = ProgressCalls()
        let export = Task.detached {
            try await RecorderRenders.export(source: movie.path, out: out.path) { fraction in progress.append(fraction) }
        }
        let deadline = Date().addingTimeInterval(15)
        // Held again: the export must get to its movie file without the main thread.
        while !FileManager.default.fileExists(atPath: partial.path), !FileManager.default.fileExists(atPath: out.path), Date() < deadline {
            usleep(5_000)
        }
        XCTAssertTrue(FileManager.default.fileExists(atPath: partial.path) || FileManager.default.fileExists(atPath: out.path),
                      "the export writes its movie while the main thread is held")
        let result = try await export.value
        XCTAssertGreaterThan(result.bytes, 0)
        XCTAssertEqual(progress.fractions.last, 1, "the progress ends at 1")
        XCTAssertTrue(progress.allOnMain, "every progress call runs on the main thread, as the host's notifications need")
    }

    func testRenderExportSendsProgressThenTheHeadlessFields() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie, frames: 180)
        _ = try await connectedHost()
        let out = folder.appendingPathComponent("out.mp4").path
        let answer = try await result(50, "render.export", ["path": movie.path, "out": out], timeout: 60)
        XCTAssertEqual(Set(answer.keys), ["ok", "path", "bytes", "seconds"])
        XCTAssertEqual(answer["path"] as? String, out)
        XCTAssertGreaterThan((answer["bytes"] as? NSNumber)?.intValue ?? 0, 0)
        XCTAssertTrue(FileManager.default.fileExists(atPath: out))
        let steps = service.received.filter { $0["method"] as? String == "$/progress" }.compactMap { $0["params"] as? [String: Any] }
        XCTAssertFalse(steps.isEmpty, "the export reports progress")
        XCTAssertTrue(steps.allSatisfy { ($0["id"] as? NSNumber)?.intValue == 50 && $0["label"] as? String == "export" })
        XCTAssertEqual((steps.last?["fraction"] as? NSNumber)?.doubleValue, 1)
    }

    func testACancelledExportAnswers1013AndWritesNoFile() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie, frames: 180)
        _ = try await connectedHost()
        let out = folder.appendingPathComponent("cancelled.mp4")
        service.request(60, "render.export", ["path": movie.path, "out": out.path])
        service.send(["jsonrpc": "2.0", "method": "$/cancel", "params": ["id": 60]])
        let service = service!
        let answer = try await Task.detached { try service.reply(to: 60) }.value
        XCTAssertEqual(errorCode(answer), 1013)
        // The exporter looks at the cancel every 0.25 s; give it a few looks, then the files must be gone.
        let partial = folder.appendingPathComponent("cancelled.partial.mp4")
        try await waitUntil(5, "the cancelled export ended") {
            !FileManager.default.fileExists(atPath: partial.path) && !FileManager.default.fileExists(atPath: out.path)
        }
        try await Task.sleep(for: .milliseconds(800))
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "a cancelled export writes no movie")
        XCTAssertEqual(service.received.filter { ($0["id"] as? NSNumber)?.intValue == 60 }.count, 1, "one answer")
    }

    func testRenderSnapshotParamsBecomeTheSnapshotOptions() throws {
        let request = LiveRecordingRPCClientIncomingStub.params([
            "path": "/r/demo", "width": 1200, "atSeconds": 3, "tab": "export", "selectZoom": 1,
            "part": ["from": 1.5, "to": 4], "range": [2, 3], "comment": 0,
        ])
        let options = try request.snapshotRequest()
        XCTAssertEqual(options.edit, "/r/demo")
        XCTAssertEqual(options.width, 1200)
        XCTAssertEqual(options.height, 920, "unset options keep the --snapshot defaults")
        XCTAssertEqual(options.atSeconds, 3)
        XCTAssertEqual(options.tab, .export)
        XCTAssertEqual(options.selectZoom, 1)
        XCTAssertEqual(options.part?.from, 1.5)
        XCTAssertEqual(options.part?.to, 4)
        XCTAssertEqual(options.range?.from, 2)
        XCTAssertEqual(options.comment, 0)
        XCTAssertEqual(try LiveRecordingRPCClientIncomingStub.params(["library": true, "filter": "demo"]).snapshotRequest().filter, "demo")
        XCTAssertEqual(try LiveRecordingRPCClientIncomingStub.params(["picker": true, "range": "1-2"]).snapshotRequest().range?.to, 2)
        XCTAssertThrowsError(try LiveRecordingRPCClientIncomingStub.params(["width": 10]).snapshotRequest())
        XCTAssertThrowsError(try LiveRecordingRPCClientIncomingStub.params(["path": "/r/demo", "part": "soon"]).snapshotRequest())
    }

    /// Each request the fixture says the service sends the host gets a result the zod result schema accepts, or the
    /// error code the fixture names; what the host sends of its own (hello, progress, the window state) fits too.
    /// render.snapshot is left out: it opens snapshot windows (its params are covered by the test above).
    func testTheHostAnswersEveryFixtureRequestAsTheTypeScriptSchemasSay() async throws {
        let schemas = try RecorderFixtures.Schemas()
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie, frames: 90)
        _ = try await connectedHost()
        var id = 900
        var answered: [String] = []
        for example in try RecorderFixtures.examples() where example["direction"] as? String == "service→host" {
            let method = try XCTUnwrap(example["method"] as? String)
            guard method != "render.snapshot" else { continue }
            id += 1
            var params = (example["request"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
            // The same fields, on local files: the renders read a real movie, the camera a real folder.
            if method.hasPrefix("render."), params["path"] != nil { params["path"] = movie.path }
            if let out = params["out"] as? String {
                params["out"] = folder.appendingPathComponent("out-\(id).\(URL(fileURLWithPath: out).pathExtension)").path
            }
            if params["folder"] != nil { params["folder"] = folder.path }
            let refusal = ((example["reply"] as? [String: Any])?["error"] as? [String: Any])?["code"] as? Int
            face.camera = refusal == 1014 ? .denied : refusal == 1015 ? .busy("FaceTime") : .started
            let answer = try await ask(id, method, params, timeout: 60)
            if let refusal {
                XCTAssertEqual(errorCode(answer), refusal, method)
            } else {
                XCTAssertEqual(try schemas.check(try XCTUnwrap(answer["result"], "\(method): \(answer)"), "results", method), [], method)
            }
            answered.append(method)
        }
        XCTAssertEqual(Set(answered), Set(RecorderHostMethods.table(face: face).keys).subtracting(["render.snapshot"]))
        let hello = try XCTUnwrap(service.received.first { $0["method"] as? String == "hello" }?["params"])
        XCTAssertEqual(try schemas.check(hello, "params", "hello"), [])
        let progress = service.received.filter { $0["method"] as? String == "$/progress" }
        XCTAssertFalse(progress.isEmpty, "the export reported progress")
        for step in progress {
            XCTAssertEqual(try schemas.check(step["params"], "notifications", "$/progress"), [])
        }
        XCTAssertEqual(try schemas.check(EditorWindows.shared.openState(), "notifications", "window.changed"), [])
        XCTAssertEqual(try schemas.check(face.windows, "results", "window.list"), [])
    }

    /// A movie of grey frames at 30 fps, 320 × 200.
    private func makeMovie(at url: URL, frames: Int) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                          AVVideoWidthKey: 320, AVVideoHeightKey: 200])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<frames {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 320, 200, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), Int32(60 + frame % 120), CVPixelBufferGetDataSize(buffer))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }
}

/// `RecorderHostMethods.Params` over a bare params object, for the parsing tests.
private enum LiveRecordingRPCClientIncomingStub {
    static func params(_ object: [String: Any]) -> RecorderHostMethods.Params {
        RecorderHostMethods.Params(method: "render.snapshot", object: object)
    }
}

/// An export's progress calls, with whether each one ran on the main thread.
private final class ProgressCalls: @unchecked Sendable {
    private let lock = NSLock()
    private var calls: [(fraction: Double, onMain: Bool)] = []

    func append(_ fraction: Double) {
        let onMain = Thread.isMainThread
        lock.withLock { calls.append((fraction, onMain)) }
    }

    var fractions: [Double] { lock.withLock { calls.map(\.fraction) } }
    var allOnMain: Bool { lock.withLock { calls.allSatisfy(\.onMain) } }
}
