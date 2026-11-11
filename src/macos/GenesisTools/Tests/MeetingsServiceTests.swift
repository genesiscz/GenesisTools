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
    /// A method's reply (without its id) in place of the fixture's.
    var answers: [String: [String: Any]] = [:]
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
        } else if let reply = answers[method] {
            send(["jsonrpc": "2.0", "id": id].merging(reply) { $1 })
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
                // The transport answers the events it subscribed the connection to: the request's own list.
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.Subscribe.Result.self, result).events, params["events"] as? [String] ?? []) }
            case MeetingsAPI.MeetingChanged.name:
                let notification = try XCTUnwrap((example["notification"] as? [String: Any])?["params"])
                let changed = try MeetingsService.decode(MeetingsAPI.MeetingChanged.self, notification)
                XCTAssertEqual(changed.meeting, Self.design)
                XCTAssertEqual(changed.parts, ["show", "transcript"])
            case MeetingsAPI.DecisionApplied.name, MeetingsAPI.DecisionReverted.name, MeetingsAPI.CommentSent.name:
                // Every event decodes through the table the connection uses.
                let notification = try XCTUnwrap((example["notification"] as? [String: Any])?["params"])
                let event = try XCTUnwrap(MeetingsAPI.eventDecoders[method], "\(method) is in the event table")(notification)
                XCTAssertEqual(event.meeting, Self.design, label)
                if method != MeetingsAPI.CommentSent.name { XCTAssertNotNil(event.entry, label) }
            case MeetingsAPI.DecisionPlan.name:
                try roundTrip(MeetingsAPI.DecisionPlan.Params.self, params, label)
                if let result { XCTAssertNotNil(try MeetingsService.decode(MeetingsAPI.DecisionPlan.Result.self, result).entry, label) }
            case MeetingsAPI.DecisionApply.name:
                try roundTrip(MeetingsAPI.DecisionApply.Params.self, params, label)
                if let result {
                    let decided = try MeetingsService.decode(MeetingsAPI.DecisionApply.Result.self, result)
                    let entry = try XCTUnwrap(decided.entry, label)
                    XCTAssertEqual(entry.actor.kind, "agent", label)
                    XCTAssertFalse(entry.changes.isEmpty, "\(label): the item before and after decode")
                    let patch = try XCTUnwrap(decided.rows, "\(label): changed rows decode from the additive response")
                    XCTAssertEqual(patch.meeting, entry.meeting)
                    XCTAssertEqual(Set(patch.changes.map(\.id)), Set(entry.changes.map(\.id)))
                }
                if let data = (reply?["error"] as? [String: Any])?["data"] {
                    let refused = try MeetingsService.decode(AlreadyDecided.self, data)
                    XCTAssertEqual(refused.code, "already-decided", label)
                    XCTAssertNotNil(refused.entry, "\(label): the refusal names the entry that decided it")
                }
            case MeetingsAPI.DecisionRevert.name:
                try roundTrip(MeetingsAPI.DecisionRevert.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.DecisionRevert.Result.self, result).entry?.action.kind, "revert") }
            case MeetingsAPI.JournalRead.name:
                try roundTrip(MeetingsAPI.JournalRead.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.JournalRead.Result.self, result).entries.isEmpty, label) }
            case MeetingsAPI.MomentPlan.name:
                try roundTrip(MeetingsAPI.MomentPlan.Params.self, params, label)
                if let result {
                    let plan = try MeetingsService.decode(MeetingsAPI.MomentPlan.Result.self, result)
                    XCTAssertTrue(plan.moment != nil || plan.cannot != nil, label)
                    // Two pads (config version 5): the Moment names the after pad, and the playing row's bar, which
                    // draws to `endSec`, ends that long after the heard stretch.
                    if let after = params["padAfterSec"] as? Double, let moment = plan.moment {
                        XCTAssertEqual(moment.padAfterSec, after, label)
                        XCTAssertEqual(ZoomSpan(moment: moment).endSec, moment.toSec + after, accuracy: 0.001, label)
                    }
                }
            case MeetingsAPI.MomentClipCut.name:
                try roundTrip(MeetingsAPI.MomentClipCut.Params.self, params, label)
                if let result { XCTAssertTrue(try MeetingsService.decode(MeetingsAPI.MomentClipCut.Result.self, result).path.hasSuffix(".wav"), label) }
            case MeetingsAPI.TonePreview.name:
                try roundTrip(MeetingsAPI.TonePreview.Params.self, params, label)
                if let result {
                    // A sine answers its own pitch, a named sine the preset's, a sound file hz 0 and its length.
                    let sound = try MeetingsService.decode(MeetingsAPI.TonePreview.Result.self, result).sound
                    switch try MeetingsService.decode(MeetingsAPI.TonePreview.Params.self, params).sound {
                    case .sine(let hz, _, _)?: XCTAssertEqual(sound.hz, hz, label)
                    case .file?: XCTAssertEqual(sound.hz, 0, label)
                    case .preset?, nil: XCTAssertGreaterThan(sound.sec, 0, label)
                    }
                }
            case MeetingsAPI.MeetingAudio.name:
                try roundTrip(MeetingsAPI.MeetingAudio.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.MeetingAudio.Result.self, result).tracks, 1) }
            case MeetingsAPI.MeetingSpeakers.name:
                try roundTrip(MeetingsAPI.MeetingSpeakers.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.MeetingSpeakers.Result.self, result).speakers.isEmpty, label) }
            case MeetingsAPI.MeetingScreen.name:
                try roundTrip(MeetingsAPI.MeetingScreen.Params.self, params, label)
                if let result { _ = try MeetingsService.decode(MeetingsAPI.MeetingScreen.Result.self, result) }
            case MeetingsAPI.MeetingWaveform.name:
                try roundTrip(MeetingsAPI.MeetingWaveform.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.MeetingWaveform.Result.self, result).peaks.isEmpty, label) }
            case MeetingsAPI.Overview.name:
                try roundTrip(MeetingsAPI.Overview.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.Overview.Result.self, result).meetings.isEmpty, label) }
            case MeetingsAPI.ConfigRead.name:
                try roundTrip(MeetingsAPI.ConfigRead.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ConfigRead.Result.self, result).value, .number(30)) }
            case MeetingsAPI.ConfigSet.name:
                try roundTrip(MeetingsAPI.ConfigSet.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ConfigSet.Result.self, result).path.last, "longestClipSec") }
            case MeetingsAPI.ConfigUnset.name:
                try roundTrip(MeetingsAPI.ConfigUnset.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.ConfigUnset.Result.self, result).value, .number(30)) }
            case MeetingsAPI.MeetingRows.name:
                try roundTrip(MeetingsAPI.MeetingRows.Params.self, params, label)
                if let result {
                    let rows = try MeetingsService.decode(MeetingsAPI.MeetingRows.Result.self, result)
                    let row = try XCTUnwrap(rows.rows.first, label)
                    XCTAssertEqual(row.choices.first?.confidence, 0.82, "\(label): the suggested choice's confidence")
                    XCTAssertNil(row.choices.dropFirst().first?.confidence, "\(label): a speaker candidate shows none")
                    XCTAssertEqual(row.decision?.by, "an agent (Claude Code, session 11111111)", label)
                    XCTAssertEqual(row.choices[1].action.decision(on: row), .confirm(["i1"], speaker: "Dana Example"))
                }
            case MeetingsAPI.CommentStage.name:
                try roundTrip(MeetingsAPI.CommentStage.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.CommentStage.Result.self, result).state, "staged") }
            case MeetingsAPI.CommentList.name:
                try roundTrip(MeetingsAPI.CommentList.Params.self, params, label)
                if let result { XCTAssertFalse(try MeetingsService.decode(MeetingsAPI.CommentList.Result.self, result).listeners.isEmpty, label) }
            case MeetingsAPI.CommentUnstage.name:
                try roundTrip(MeetingsAPI.CommentUnstage.Params.self, params, label)
                if let result { _ = try MeetingsService.decode(MeetingsAPI.CommentUnstage.Result.self, result) }
            case MeetingsAPI.CommentSend.name:
                try roundTrip(MeetingsAPI.CommentSend.Params.self, params, label)
                if let result { XCTAssertEqual(try MeetingsService.decode(MeetingsAPI.CommentSend.Result.self, result).entry?.action.kind, "comment") }
            default:
                // A method the window does not mirror (b-people's people.*): nothing to decode.
                continue
            }
            if let error = reply?["error"] as? [String: Any], (error["code"] as? NSNumber)?.intValue == MeetingsAPI.refusedCode {
                let data = try XCTUnwrap(error["data"], "\(label): a refusal names its code")
                refusals.append(try MeetingsService.decode(MeetingsAPI.ErrorData.self, data).code)
            }
            decoded[method, default: 0] += 1
        }
        for method in [MeetingsAPI.Hello.name, MeetingsAPI.List.name, MeetingsAPI.Show.name, MeetingsAPI.Transcript.name,
                       MeetingsAPI.Revisions.name, MeetingsAPI.Subscribe.name, MeetingsAPI.MeetingChanged.name]
            + Self.wavebMethods + [MeetingsAPI.DecisionApplied.name, MeetingsAPI.DecisionReverted.name, MeetingsAPI.CommentSent.name] {
            XCTAssertGreaterThan(decoded[method] ?? 0, 0, "the fixture has an example of \(method)")
        }
        for code in ["meeting-not-found", "no-transcript-source", "no-hello", "protocol-mismatch", "code-mismatch"] {
            XCTAssertTrue(refusals.contains(code), "the fixture has the refusal \(code): \(refusals)")
        }
    }

    /// G31: a speaker row's candidates carry their typed scores (`ChoiceButton` draws `confidence` for every role), and
    /// a choice without a score decodes as none.
    func testASpeakerRowDecodesTheConfidenceOfEachCandidate() throws {
        let example = try XCTUnwrap(try MeetingsFixture.examples().first {
            $0["method"] as? String == MeetingsAPI.MeetingRows.name && ($0["reply"] as? [String: Any])?["result"] != nil
        })
        var result = try XCTUnwrap((example["reply"] as? [String: Any])?["result"] as? [String: Any])
        var rows = try XCTUnwrap(result["rows"] as? [[String: Any]])
        var row = try XCTUnwrap(rows.first { $0["kind"] as? String == "speaker-range" }, "the fixture has a speaker row")
        row["choices"] = [
            ["value": "Speaker A", "label": "Speaker A", "role": "suggested", "action": ["kind": "confirm"], "confidence": 0.62],
            ["value": "Speaker B", "label": "Speaker B", "role": "candidate", "action": ["kind": "confirm", "speaker": "Speaker B"],
             "confidence": 0.25],
            ["value": "Speaker C", "label": "Speaker C", "role": "candidate", "action": ["kind": "confirm", "speaker": "Speaker C"]],
            ["value": "none of these", "label": "None of these", "role": "none", "action": ["kind": "reject"]],
        ]
        rows = [row]
        result["rows"] = rows
        let decoded = try MeetingsService.decode(MeetingsAPI.MeetingRows.Result.self, result)
        let choices = try XCTUnwrap(decoded.rows.first?.choices)
        XCTAssertEqual(choices.map(\.role), ["suggested", "candidate", "candidate", "none"])
        XCTAssertEqual(choices.map(\.confidence), [0.62, 0.25, nil, nil])
    }

    /// The methods and the event the window uses are the ones the service lists in its hello.
    func testTheServiceListsEveryMethodAndEventTheWindowUses() throws {
        let hello = try MeetingsService.decode(MeetingsAPI.Hello.Result.self, try MeetingsFixture.helloResult())
        for method in [MeetingsAPI.Hello.name, MeetingsAPI.List.name, MeetingsAPI.ListRecords.name, MeetingsAPI.Show.name,
                       MeetingsAPI.Transcript.name, MeetingsAPI.Revisions.name, MeetingsAPI.Subscribe.name] {
            XCTAssertTrue(hello.methods.contains(method), "the service answers \(method): \(hello.methods)")
        }
        for method in Self.wavebMethods {
            XCTAssertTrue(hello.methods.contains(method), "the service answers \(method): \(hello.methods)")
        }
        XCTAssertEqual(Set(hello.events), Set(MeetingsAPI.windowEvents), "the window subscribes to every event the service sends")
        XCTAssertEqual(Set(MeetingsAPI.eventDecoders.keys), Set(MeetingsAPI.windowEvents))
    }

    /// The methods Wave B mirrors.
    private static let wavebMethods = [
        MeetingsAPI.DecisionPlan.name, MeetingsAPI.DecisionApply.name, MeetingsAPI.DecisionRevert.name, MeetingsAPI.JournalRead.name,
        MeetingsAPI.MomentPlan.name, MeetingsAPI.MomentClipCut.name, MeetingsAPI.TonePreview.name, MeetingsAPI.MeetingAudio.name,
        MeetingsAPI.MeetingSpeakers.name, MeetingsAPI.MeetingScreen.name, MeetingsAPI.MeetingWaveform.name, MeetingsAPI.Overview.name,
        MeetingsAPI.ConfigRead.name, MeetingsAPI.ConfigSet.name, MeetingsAPI.ConfigUnset.name, MeetingsAPI.MeetingRows.name,
        MeetingsAPI.CommentStage.name, MeetingsAPI.CommentList.name, MeetingsAPI.CommentUnstage.name, MeetingsAPI.CommentSend.name,
    ]

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

    /// service.json as the TypeScript host writes it, naming the fake's socket and a live pid (and the checkout its code
    /// runs from, when given).
    private func writeServiceEntry(sourceRoot: String? = nil) throws {
        var entry: [String: Any] = ["version": 1, "protocol": 1, "pid": Int(getpid()), "socket": fake.path,
                                    "startedAt": "2026-11-09T19:00:00.000Z", "codeStamp": 0]
        entry["sourceRoot"] = sourceRoot
        try JSONSerialization.data(withJSONObject: entry).write(to: folder.appendingPathComponent("service.json"))
    }

    private func makeService(checkout: MeetingsService.Checkout? = nil) -> MeetingsService {
        let log = commands!
        return MeetingsService(folder: folder, timing: .init(helloTimeout: 2, startThrottle: 30, refusedBackoff: 60, idleClose: 60,
                                                             reconnectDelay: 0.05),
                               pid: 4242, checkout: checkout, startService: {
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
        // The token hashes the record as the fixture's capture wrote it, so it changes when the fixture is captured again.
        let captured = try XCTUnwrap(try MeetingsFixture.examples().first { $0["method"] as? String == "meeting.revisions" })
        let expected = ((captured["reply"] as? [String: Any])?["result"] as? [String: Any])?["show"] as? String
        XCTAssertEqual(revisions.show, try XCTUnwrap(expected))
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

    /// The window's hello names no code, so a service started from another checkout can answer it with shapes this
    /// app cannot read. That answer is not the read's answer: the command answers, as with no service, and the window
    /// does not ask that service again before the backoff.
    func testAnAnswerTheWindowCannotDecodeRunsTheCommand() async throws {
        try writeServiceEntry()
        fake.answers["meeting.show"] = ["result": ["id": 7]]
        let service = makeService()
        for _ in 0..<2 {
            do {
                _ = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
                XCTFail("the fallback fails in this test")
            } catch let failure as MeetingsCLI.Failure {
                XCTAssertEqual(failure.sentence, "The command ran.", "the command answered, not a format error")
            }
        }
        XCTAssertEqual(commands.runs, [["show", Self.design, "--json"], ["show", Self.design, "--json"]])
        XCTAssertEqual(fake.count("meeting.show"), 1, "the service the window cannot read is not asked again before the backoff")
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
        let listening = service.listen { signal in
            guard case .event(.meetingChanged(let changed)) = signal else { return }
            changes.append(changed)
            heard.fulfill()
        }
        defer { listening.cancel() }
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

    /// F6 drops the 5 s timer and lives on these events, so a kept subscription connects again by itself after the
    /// service hung up (a code change, a crash), with no read to open the connection, and tells the subscriber that
    /// events were missed meanwhile; without a subscription nothing connects.
    func testAKeptSubscriptionConnectsAgainWithoutARead() async throws {
        try writeServiceEntry()
        let service = makeService()
        var resumed = 0
        var lost = 0
        let listening = service.listen { signal in
            if signal == .resumed { resumed += 1 }
            if signal == .lost { lost += 1 }
        }
        defer { listening.cancel() }
        _ = try await service.subscribe(meeting: Self.design, events: ["meeting.changed"])
        XCTAssertEqual(fake.count("hello"), 1)
        XCTAssertEqual(resumed, 0, "the first subscription missed nothing")
        XCTAssertTrue(service.isSubscribed)

        fake.hangUp()
        for _ in 0..<150 where fake.count("subscribe") < 2 || resumed == 0 { try await Task.sleep(nanoseconds: 20_000_000) }
        XCTAssertEqual(fake.count("hello"), 2, "the kept subscription opened a new connection")
        XCTAssertEqual(fake.count("subscribe"), 2, "and subscribed on it")
        XCTAssertEqual(lost, 1, "the listener heard the subscription was lost while no connection was open")
        XCTAssertEqual(resumed, 1, "the subscriber hears that events between the connections were missed")
        XCTAssertTrue(service.isSubscribed)
        XCTAssertEqual(commands.runs, [], "no read ran")

        service.unsubscribe()
        try await Task.sleep(nanoseconds: 300_000_000)
        XCTAssertEqual(fake.count("hello"), 2, "without a subscription nothing connects again")
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

    // MARK: Which service (finding 5 of the Wave A review)

    func testTwoCheckoutPathsAreTheSameFolderWithOrWithoutTheTrailingSlash() throws {
        let root = folder.appendingPathComponent("checkout")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let link = folder.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
        XCTAssertTrue(MeetingsService.Checkout.same(root.path + "/", root.path))
        XCTAssertTrue(MeetingsService.Checkout.same(link.path, root.path + "/"), "a symlink resolves")
        XCTAssertFalse(MeetingsService.Checkout.same(root.path, folder.path))
        let checkout = MeetingsService.Checkout(root: { root.path }, acceptsUnnamed: false)
        XCTAssertTrue(checkout.accepts(root.path + "/"))
        XCTAssertFalse(checkout.accepts("/elsewhere/"))
        XCTAssertFalse(checkout.accepts(nil), "under an override, a service that names no checkout is not used")
        XCTAssertTrue(MeetingsService.Checkout(root: { root.path }, acceptsUnnamed: true).accepts(nil))
    }

    func testAServiceOfAnotherCheckoutIsNotAskedAndTheCommandAnswers() async throws {
        try writeServiceEntry(sourceRoot: "/Users/someone/elsewhere/GenesisTools/")
        let service = makeService(checkout: .init(root: { "/tmp/cc/worktree" }, acceptsUnnamed: true))
        XCTAssertEqual(service.discover(), .otherCheckout("/Users/someone/elsewhere/GenesisTools/"))
        do {
            _ = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
            XCTFail("the command fallback throws in this test")
        } catch let failure as MeetingsCLI.Failure {
            XCTAssertEqual(failure.sentence, "The command ran.")
        }
        XCTAssertEqual(fake.count("hello"), 0, "the other checkout's service heard nothing")
        XCTAssertEqual(commands.starts, 0, "no second service is started beside it")
        XCTAssertEqual(commands.runs, [["show", Self.design, "--json"]])
    }

    func testAServiceOfTheSameCheckoutAnswersUnderAnOverride() async throws {
        let root = folder.appendingPathComponent("checkout")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        try writeServiceEntry(sourceRoot: root.path + "/")
        let service = makeService(checkout: .init(root: { root.path }, acceptsUnnamed: false))
        let record = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
        XCTAssertEqual(record.id, Self.design)
        XCTAssertEqual(fake.count("hello"), 1)
        XCTAssertEqual(commands.runs, [])
    }

    func testAGenericFailedRefusalOfAReadRunsTheCommand() async throws {
        try writeServiceEntry()
        fake.answers["meeting.show"] = ["error": ["code": 1100, "message": "boom", "data": ["code": "failed"]]]
        let service = makeService()
        do {
            _ = try await MeetingDetailModel.recordRead(Self.design).run(service: service, command: command())
            XCTFail("the command fallback throws in this test")
        } catch let failure as MeetingsCLI.Failure {
            XCTAssertEqual(failure.sentence, "The command ran.", "the read ran as the command")
        }
        XCTAssertEqual(commands.runs, [["show", Self.design, "--json"]])
        // A write shows the refusal: `call` throws it as the command's failure with the code.
        do {
            _ = try await service.call(MeetingsAPI.Show.self, .init(ref: Self.design))
            XCTFail("the refusal answered")
        } catch let failure as MeetingsCLI.Failure {
            XCTAssertEqual(failure.code, "failed")
        }
    }

    func testADecisionEventReachesEveryListener() async throws {
        try writeServiceEntry()
        fake.answers["subscribe"] = ["result": ["events": MeetingsAPI.windowEvents]]
        let service = makeService()
        var first: [MeetingsEvent] = []
        var second: [MeetingsEvent] = []
        let heard = expectation(description: "both listeners heard it")
        heard.expectedFulfillmentCount = 2
        let one = service.listen { if case .event(let event) = $0 { first.append(event); heard.fulfill() } }
        let two = service.listen { if case .event(let event) = $0 { second.append(event); heard.fulfill() } }
        defer { one.cancel(); two.cancel() }
        _ = try await service.subscribe(events: MeetingsAPI.windowEvents)
        let notification = try XCTUnwrap(try MeetingsFixture.examples().first { $0["method"] as? String == "decision.applied" }?["notification"] as? [String: Any])
        fake.send(notification)
        await fulfillment(of: [heard], timeout: 3)
        XCTAssertEqual(first.first?.entry?.action, .confirm(["i1"]))
        XCTAssertEqual(first, second)
    }
}
