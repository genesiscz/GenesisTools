import Darwin
import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The fixture TypeScript writes for this side: src/meetings/lib/service/__fixtures__/meetings-protocol.json, one real
/// request and reply per Meetings service method and event.
private enum MeetingsFixture {
    static var url: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("meetings/lib/service/__fixtures__/meetings-protocol.json")
    }

    static func examples() throws -> [[String: Any]] {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertEqual((root["protocol"] as? NSNumber)?.intValue, MeetingsAPI.protocolVersion, "the fixture's protocol")
        return try XCTUnwrap(root["examples"] as? [[String: Any]])
    }

    /// The window's hello answer as the service gave it.
    static func helloResult() throws -> [String: Any] {
        let hello = try examples().first { $0["method"] as? String == "hello" && ($0["reply"] as? [String: Any])?["result"] != nil }
        return try XCTUnwrap((hello?["reply"] as? [String: Any])?["result"] as? [String: Any])
    }

    /// The first example of `method` whose request params equal `params`: its reply, without the id.
    static func reply(_ method: String, params: [String: Any]) -> [String: Any]? {
        guard let examples = try? examples() else { return nil }
        for example in examples where example["method"] as? String == method {
            guard let request = example["request"] as? [String: Any],
                  NSDictionary(dictionary: request["params"] as? [String: Any] ?? [:]).isEqual(to: params),
                  var reply = example["reply"] as? [String: Any] else { continue }
            reply["id"] = nil
            return reply
        }
        return nil
    }
}

/// A Meetings service in the test: a Unix socket server that answers `hello` (with `helloAnswer`), answers every other
/// call with the fixture's reply for the same method and params, answers `$/cancel` with 1013, leaves the methods in
/// `silent` unanswered, and keeps every line the window wrote. It accepts again after a hang-up.
private final class FakeMeetingsService: @unchecked Sendable {
    let path = "/tmp/ms-\(UUID().uuidString.prefix(8)).sock"
    var helloAnswer: [String: Any]
    var silent: Set<String> = []
    private var listener: Int32 = -1
    private var connection: Int32 = -1
    private let condition = NSCondition()
    private var lines: [[String: Any]] = []
    private(set) var accepted = 0
    private var stopped = false

    init() throws {
        helloAnswer = ["result": try MeetingsFixture.helloResult()]
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

    /// Ends the current connection from the service's side, as a service that exits does.
    func hangUp() {
        condition.lock()
        let open = connection
        condition.unlock()
        if open >= 0 { shutdown(open, SHUT_RDWR) }
    }

    func send(_ object: [String: Any]) {
        condition.lock()
        let open = connection
        condition.unlock()
        guard open >= 0, let data = try? JSONSerialization.data(withJSONObject: object) else { return }
        let bytes = Array(data) + [10]
        _ = bytes.withUnsafeBytes { write(open, $0.baseAddress, $0.count) }
    }

    /// The first line that matches, waiting up to `timeout`.
    func line(timeout: TimeInterval = 3, where match: ([String: Any]) -> Bool) throws -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while true {
            if let found = lines.first(where: match) { return found }
            guard condition.wait(until: deadline) else { throw NSError(domain: "fake meetings service: no matching line", code: 1) }
        }
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
                answer(object)
            }
        }
    }

    private func answer(_ request: [String: Any]) {
        guard let method = request["method"] as? String else { return }
        let params = request["params"] as? [String: Any] ?? [:]
        if method == "$/cancel", let id = params["id"] {
            send(["jsonrpc": "2.0", "id": id, "error": ["code": 1013, "message": "cancelled"]])
            return
        }
        guard let id = request["id"], !silent.contains(method) else { return }
        if method == "hello" {
            send(["jsonrpc": "2.0", "id": id].merging(helloAnswer) { $1 })
        } else if let reply = MeetingsFixture.reply(method, params: params) {
            send(reply.merging(["id": id]) { $1 })
        } else {
            send(["jsonrpc": "2.0", "id": id, "error": ["code": -32601, "message": "no fixture for \(method) \(params)"]])
        }
    }
}

/// The commands a read ran instead of the service.
@MainActor
private final class CommandLog {
    var runs: [[String]] = []
    var starts = 0
    /// What the start throws; nil: it works.
    var startFailure: Error?
}

/// The two halves agree: every example the TypeScript service wrote decodes with this side's types (and its params
/// encode back to the same JSON), and the window's client talks to a service that replays those examples: one hello,
/// typed reads, refusals as the command's failures, the command when no service answers, and the events.
@MainActor
final class MeetingsServiceTests: XCTestCase {
    private static let design = "2026-11-03-1000-design-review"
    private static let retro = "2026-11-03-1400-retro"

    // MARK: The fixture

    /// The params decode as the Swift type and encode back to the same object.
    private func roundTrip<P: Codable>(_ type: P.Type, _ params: [String: Any], _ label: String) throws {
        let typed = try MeetingsService.decode(P.self, params)
        let encoded = try MeetingsService.paramsObject(typed)
        XCTAssertTrue(NSDictionary(dictionary: encoded).isEqual(to: params), "\(label): \(encoded) is not \(params)")
    }

    func testEveryFixtureExampleDecodesWithTheSwiftTypes() throws {
        var decoded: [String: Int] = [:]
        var refusals: [String] = []
        for example in try MeetingsFixture.examples() {
            let method = try XCTUnwrap(example["method"] as? String)
            let params = (example["request"] as? [String: Any])?["params"] as? [String: Any] ?? [:]
            let reply = example["reply"] as? [String: Any]
            let result = reply?["result"]
            let label = "\(method) (\(example["note"] as? String ?? "plain"))"
            switch method {
            case MeetingsAPI.Hello.name:
                try roundTrip(MeetingsAPI.Hello.Params.self, params, label)
                if let result {
                    let hello = try MeetingsService.decode(MeetingsAPI.Hello.Result.self, result)
                    XCTAssertEqual(hello.protocol, MeetingsAPI.protocolVersion)
                }
            case MeetingsAPI.List.name where params["full"] as? Bool == true:
                try roundTrip(MeetingsAPI.ListRecords.Params.self, params, label)
                if let result {
                    XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.ListRecords.Result.self, result).isEmpty, label)
                }
            case MeetingsAPI.List.name:
                try roundTrip(MeetingsAPI.List.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.List.Result.self, result).isEmpty, label) }
            case MeetingsAPI.Show.name:
                try roundTrip(MeetingsAPI.Show.Params.self, params, label)
                if let result {
                    let record = try MeetingsService.decode(MeetingsAPI.Show.Result.self, result)
                    XCTAssertEqual(record.id, params["ref"] as? String)
                    XCTAssertFalse(record.items.isEmpty, "the record's items decode")
                }
            case MeetingsAPI.Transcript.name:
                try roundTrip(MeetingsAPI.Transcript.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.Transcript.Result.self, result).entries.isEmpty) }
            case MeetingsAPI.Revisions.name:
                try roundTrip(MeetingsAPI.Revisions.Params.self, params, label)
                if let result { XCTAssertNotNil(try MeetingsService.decode(MeetingsAPI.Revisions.Result.self, result).show) }
            case MeetingsAPI.Subscribe.name:
                try roundTrip(MeetingsAPI.Subscribe.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.Subscribe.Result.self, result).events, ["meeting.changed"]) }
            case MeetingsAPI.MeetingChanged.name:
                let notification = try XCTUnwrap((example["notification"] as? [String: Any])?["params"])
                let changed = try MeetingsService.decode(MeetingsAPI.MeetingChanged.self, notification)
                XCTAssertEqual(changed.meeting, Self.design)
                XCTAssertEqual(changed.parts, ["show", "transcript"])
            default:
                // A method the window does not call yet (Wave B adds the decisions and the moments): nothing to decode.
                continue
            }
            if let error = reply?["error"] as? [String: Any], (error["code"] as? NSNumber)?.intValue == MeetingsAPI.refusedCode {
                let data = try XCTUnwrap(error["data"], "\(label): a refusal names its code")
                refusals.append(try MeetingsService.decode(MeetingsAPI.ErrorData.self, data).code)
            }
            decoded[method, default: 0] += 1
        }
        for method in [MeetingsAPI.Hello.name, MeetingsAPI.List.name, MeetingsAPI.Show.name, MeetingsAPI.Transcript.name,
                       MeetingsAPI.Revisions.name, MeetingsAPI.Subscribe.name, MeetingsAPI.MeetingChanged.name] {
            XCTAssertGreaterThan(decoded[method] ?? 0, 0, "the fixture has an example of \(method)")
        }
        for code in ["meeting-not-found", "no-transcript-source", "no-hello", "protocol-mismatch", "code-mismatch"] {
            XCTAssertTrue(refusals.contains(code), "the fixture has the refusal \(code): \(refusals)")
        }
    }

    /// The methods and the event the window uses are the ones the service lists in its hello.
    func testTheServiceListsEveryMethodAndEventTheWindowUses() throws {
        let hello = try MeetingsService.decode(MeetingsAPI.Hello.Result.self, try MeetingsFixture.helloResult())
        for method in [MeetingsAPI.Hello.name, MeetingsAPI.List.name, MeetingsAPI.ListRecords.name, MeetingsAPI.Show.name,
                       MeetingsAPI.Transcript.name, MeetingsAPI.Revisions.name, MeetingsAPI.Subscribe.name] {
            XCTAssertTrue(hello.methods.contains(method), "the service answers \(method): \(hello.methods)")
        }
        XCTAssertTrue(hello.events.contains(MeetingsAPI.MeetingChanged.name))
    }

    func testTheWindowsReadsNameTheServiceMethodAndTheSameCommand() {
        let record = MeetingDetailModel.recordRead("m1")
        XCTAssertEqual(record.method, "meeting.show")
        XCTAssertEqual(record.args, ["show", "m1", "--json"])
        let transcript = MeetingDetailModel.transcriptRead("m1")
        XCTAssertEqual(transcript.method, "meeting.transcript")
        XCTAssertEqual(transcript.args, ["transcript", "m1", "--format", "json"])
        XCTAssertEqual(transcript.timeoutSeconds, 120)
        let revisions = MeetingDetailModel.revisionsRead("m1")
        XCTAssertEqual(revisions.method, "meeting.revisions")
        XCTAssertEqual(revisions.args, ["revisions", "m1", "--json"])
    }

    // MARK: The client against a service that replays the fixture

    private var fake: FakeMeetingsService!
    private var folder: URL!
    private var commands: CommandLog!

    override func setUp() async throws {
        fake = try FakeMeetingsService()
        try fake.start()
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("meetings-service-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        commands = CommandLog()
    }

    override func tearDown() async throws {
        fake.stop()
        try? FileManager.default.removeItem(at: folder)
    }

    /// service.json as the TypeScript host writes it, naming the fake's socket and a live pid.
    private func writeServiceEntry() throws {
        let entry: [String: Any] = ["version": 1, "protocol": 1, "pid": Int(getpid()), "socket": fake.path,
                                    "startedAt": "2026-11-09T19:00:00.000Z", "codeStamp": 0]
        try JSONSerialization.data(withJSONObject: entry).write(to: folder.appendingPathComponent("service.json"))
    }

    private func makeService() -> MeetingsService {
        let log = commands!
        return MeetingsService(folder: folder, timing: .init(helloTimeout: 2, startThrottle: 30, refusedBackoff: 60, idleClose: 60),
                               pid: 4242, startService: {
                                   log.starts += 1
                                   if let failure = log.startFailure { throw failure }
                               })
    }

    /// What a read's command fallback does here: it records the argv and fails, so a test sees whether it ran.
    private func command<Value>() -> ([String], Int) async throws -> Value {
        let log = commands!
        return { args, _ in
            log.runs.append(args)
            throw MeetingsCLI.Failure(sentence: "The command ran.", detail: args.joined(separator: " "))
        }
    }

    func testAReadGoesThroughTheServiceAfterOneHello() async throws {
        try writeServiceEntry()
        let service = makeService()
        let record = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
        XCTAssertEqual(record.id, Self.design)
        XCTAssertEqual(record.project, "Atlas")
        let revisions = try await MeetingDetailModel.revisionsRead(Self.design).run(service: service, command: command())
        XCTAssertEqual(revisions.show, "32y96zb50zq92")
        let transcript = try await MeetingDetailModel.transcriptRead(Self.design).run(service: service, command: command())
        XCTAssertEqual(transcript.entries.map(\.speaker), ["Dana Example", "Alex Example"])

        XCTAssertEqual(commands.runs, [], "no command ran while the service answered")
        XCTAssertEqual(commands.starts, 0, "a live service is not started again")
        XCTAssertEqual(fake.count("hello"), 1, "one hello per connection")
        let hello = try XCTUnwrap(fake.received.first)
        XCTAssertEqual(hello["method"] as? String, "hello", "the hello comes first")
        let params = try XCTUnwrap(hello["params"] as? [String: Any])
        XCTAssertTrue(NSDictionary(dictionary: params).isEqual(to: ["role": "window", "protocol": 1, "pid": 4242]), "\(params)")
        if case .connected(let methods, _) = service.state {
            XCTAssertTrue(methods.contains("meeting.show"))
        } else {
            XCTFail("the service is connected: \(service.state)")
        }
    }

    func testARefusalIsTheCommandsFailureWithItsCode() async throws {
        try writeServiceEntry()
        let service = makeService()
        do {
            _ = try await MeetingDetailModel.transcriptRead(Self.retro).run(service: service, command: command())
            XCTFail("a meeting without a transcript source read a transcript")
        } catch let failure as MeetingsCLI.Failure {
            XCTAssertEqual(failure.code, NoTranscriptSource.code, "the pane shows its empty state by this code")
            XCTAssertTrue(failure.sentence.hasPrefix("2026-11-03-1400-retro has no source with a transcript."), failure.sentence)
            XCTAssertTrue(failure.sentence.hasSuffix("."))
        }
        do {
            _ = try await MeetingDetailModel.recordRead("nope").run(service: service, command: command())
            XCTFail("an unknown meeting read")
        } catch let failure as MeetingsCLI.Failure {
            XCTAssertEqual(failure.code, "meeting-not-found")
            XCTAssertEqual(failure.sentence, "No meeting \"nope\". List them: tools meetings list.")
        }
        XCTAssertEqual(commands.runs, [], "a refusal is the answer: the command does not run it again")
    }

    func testNoServiceRunsTheCommandAndStartsOneInTheBackground() async throws {
        let service = makeService()
        for _ in 0..<2 {
            do {
                _ = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
                XCTFail("the fallback fails in this test")
            } catch let failure as MeetingsCLI.Failure {
                XCTAssertEqual(failure.sentence, "The command ran.")
            }
        }
        XCTAssertEqual(commands.runs, [["show", Self.design, "--json"], ["show", Self.design, "--json"]])
        // The start runs in the background; give it the main queue once.
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(commands.starts, 1, "one start within the throttle, though two reads found no service")
        XCTAssertEqual(fake.accepted, 0)
    }

    /// A start that keeps failing (a `tools` without `serve`) is tried again only after the longer wait, never per read.
    func testStartsThatKeepFailingWaitTheLongerRetry() async throws {
        commands.startFailure = MeetingsCLI.Failure(sentence: "Unknown command serve.", detail: "")
        let log = commands!
        let service = MeetingsService(folder: folder, timing: .init(startThrottle: 0, maxFailedStarts: 2, failedStartRetry: 60),
                                      pid: 4242, startService: {
                                          log.starts += 1
                                          if let failure = log.startFailure { throw failure }
                                      })
        for _ in 0..<4 {
            _ = try? await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
            try await Task.sleep(nanoseconds: 30_000_000)
        }
        XCTAssertEqual(commands.runs.count, 4, "every read ran as the command")
        XCTAssertEqual(commands.starts, 2, "two failed starts, then none within the longer retry")
    }

    /// A service whose code is changing refuses the hello and exits within a minute: the window reads through the
    /// command and does not knock again before the backoff.
    func testACodeMismatchRunsTheCommandAndDoesNotKnockAgainBeforeTheBackoff() async throws {
        try writeServiceEntry()
        fake.helloAnswer = ["error": ["code": 1100, "message": "the meetings service's code changed since it started",
                                      "data": ["code": "code-mismatch"]]]
        let service = makeService()
        for _ in 0..<2 {
            _ = try? await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
        }
        XCTAssertEqual(commands.runs.count, 2, "both reads ran as the command")
        XCTAssertEqual(fake.count("hello"), 1, "the second read did not knock again")
        XCTAssertEqual(commands.starts, 0, "a refusing service is not started over")
        XCTAssertEqual(service.state, .idle)
    }

    func testADroppedConnectionIsOpenedAgainWithANewHello() async throws {
        try writeServiceEntry()
        let service = makeService()
        _ = try await MeetingDetailModel.revisionsRead(Self.design).run(service: service, command: command())
        fake.hangUp()
        // The close reaches the service on the main queue.
        for _ in 0..<50 where service.state != .idle { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(service.state, .idle, "the dropped connection was noticed")
        let record = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
        XCTAssertEqual(record.id, Self.design)
        XCTAssertEqual(fake.count("hello"), 2, "the new connection said hello")
        XCTAssertEqual(commands.runs, [])
    }

    func testAMeetingChangedReachesTheSubscriberAndASubscriptionOutlivesAReconnect() async throws {
        try writeServiceEntry()
        let service = makeService()
        let heard = expectation(description: "meeting.changed arrived")
        var changes: [MeetingsAPI.MeetingChanged] = []
        service.onMeetingChanged = { changed in
            changes.append(changed)
            heard.fulfill()
        }
        let events = try await service.subscribe(meeting: Self.design, events: ["meeting.changed"])
        XCTAssertEqual(events, ["meeting.changed"])
        try await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(fake.count("subscribe"), 1, "the first connection subscribes once")
        let notification = try XCTUnwrap(try MeetingsFixture.examples().first { $0["method"] as? String == "meeting.changed" }?["notification"] as? [String: Any])
        fake.send(notification)
        await fulfillment(of: [heard], timeout: 3)
        XCTAssertEqual(changes, [MeetingsAPI.MeetingChanged(meeting: Self.design, parts: ["show", "transcript"])])

        fake.hangUp()
        for _ in 0..<50 where service.state != .idle { try await Task.sleep(nanoseconds: 20_000_000) }
        _ = try await MeetingDetailModel.revisionsRead(Self.design).run(service: service, command: command())
        // The new connection sends the kept subscription on its own, after its hello.
        for _ in 0..<150 where fake.count("subscribe") < 2 { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(fake.count("subscribe"), 2, "the new connection subscribed again")
    }

    func testACancelledReadIsCancelledOnTheWireAndRunsNoCommand() async throws {
        try writeServiceEntry()
        fake.silent = ["meeting.transcript"]
        let service = makeService()
        let read = Task { @MainActor in
            try await MeetingDetailModel.transcriptRead(Self.design).run(service: service, command: self.command())
        }
        // The fake's waits block their thread: they run off the main actor, which the client's callbacks need.
        let fake = self.fake!
        let sent = try await Task.detached { try fake.line { $0["method"] as? String == "meeting.transcript" } }.value
        read.cancel()
        let cancel = try await Task.detached { try fake.line { $0["method"] as? String == "$/cancel" } }.value
        XCTAssertEqual((cancel["params"] as? [String: Any])?["id"] as? NSNumber, sent["id"] as? NSNumber)
        do {
            _ = try await read.value
            XCTFail("a cancelled read answered")
        } catch {
            XCTAssertTrue(error is CancellationError, "\(error)")
        }
        XCTAssertEqual(commands.runs, [], "a cancelled read does not fall back to the command")
    }
}
