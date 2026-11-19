import AVFoundation
import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsVoiceLibraryTests: XCTestCase {
    func testPreviewApplyAndUndoUseTheSameIDAndReceiptOutsideAMeeting() async throws {
        let fake = try FakeMeetingsService()
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let entry: [String: Any] = ["version": 1, "protocol": 1, "pid": Int(getpid()), "socket": fake.path,
                                    "startedAt": "2026-01-01T00:00:00Z", "codeStamp": 0]
        try JSONSerialization.data(withJSONObject: entry).write(to: folder.appendingPathComponent("service.json"))
        fake.fixtureMethods = ["voices.list", "voices.jobs", "voices.move", "voices.reject", "voices.remove", "voices.undo"]
        fake.fixtureReply = { method, params in
            switch method {
            case "voices.list": return ["people": []]
            case "voices.jobs": return []
            case "voices.remove": return ["ids": ["vs_one"], "removed": 1, "project": "Orchard", "person": "Aster",
                                          "planToken": "bound-plan", "token": "saved-receipt", "affected": []] as [String: Any]
            default: return ["status": params["preview"] as? Bool == true ? "preview" : "applied",
                             "ids": ["vs_one"], "planToken": "bound-plan", "token": "saved-receipt", "affected": []] as [String: Any]
            }
        }
        try fake.start()
        defer { fake.stop() }
        let service = MeetingsService(folder: folder, startService: { throw CancellationError() })
        defer { service.disconnect() }
        let window = MeetingsWindowModel(service: service, loadDetail: { _ in })
        let library = window.voiceLibrary
        library.show(.person(.init(name: "Aster"), project: nil), doubtfulFirst: true)
        XCTAssertNil(window.detail)
        let actions: [(String, LibraryCorrection)] = [
            ("voices.move", .move(id: "vs_one", person: "Aster", to: .init(name: "Beryl", email: "b@example.test"))),
            ("voices.reject", .reject(id: "vs_one", person: "Aster", reason: "wrong-person")),
            ("voices.remove", .remove(id: "vs_one", person: "Aster", scope: .all)),
        ]
        for (index, pair) in actions.enumerated() {
            let (method, action) = pair
            library.preview(action)
            let previewed = await waitUntil(3) { library.confirmation != nil && !library.busy }
            XCTAssertTrue(previewed, method)
            let choice = try XCTUnwrap(library.confirmation)
            XCTAssertTrue(choice.message.contains("1 sample"))
            library.apply(choice)
            let applied = await waitUntil(3) { !library.busy && window.newestUndo != nil }
            XCTAssertTrue(applied, method)
            let calls = fake.received.filter { $0["method"] as? String == method }.compactMap { $0["params"] as? [String: Any] }
            XCTAssertEqual(calls.count, 2)
            XCTAssertTrue(calls.allSatisfy { $0["id"] as? String == "vs_one" && $0["sample"] == nil })
            XCTAssertEqual(calls.first?["preview"] as? Bool, true)
            XCTAssertEqual(calls.last?["preview"] as? Bool, false)
            XCTAssertEqual(calls.last?["planToken"] as? String, "bound-plan")
            if method == "voices.move" { XCTAssertEqual((calls.last?["to"] as? [String: String])?["email"], "b@example.test") }
            if method == "voices.reject" { XCTAssertEqual(calls.last?["reason"] as? String, "wrong-person") }
            XCTAssertTrue(window.undoNewest())
            let undone = await waitUntil(3) { fake.count("voices.undo") == index + 1 && window.newestUndo == nil }
            XCTAssertTrue(undone, method)
            let undo = fake.received.last { $0["method"] as? String == "voices.undo" }?["params"] as? [String: Any]
            XCTAssertEqual(undo?["token"] as? String, "saved-receipt")
        }
    }

    func testPreparedRowsRankIndependentOutliersAndExplainMissingScores() throws {
        let owner = ["name": "Aster"]
        let samples: [[String: Any]] = ["vs_typical", "vs_doubtful", "vs_small"].enumerated().map { i, id in
            ["id": id, "sample": i + 1, "meeting": "one", "seat": "mic", "track": "source-mic", "fromSec": i,
             "toSec": i + 1, "available": true, "words": "Clip", "confirmedAt": "2026-01-01T00:00:00Z"]
        }
        let person: [String: Any] = ["person": "Aster", "owner": owner, "project": "Orchard", "meetings": ["one"], "samples": samples]
        let group: [String: Any] = ["owner": owner, "seat": "mic", "track": "source-mic", "model": "test-model",
                                    "dimension": 2, "count": 3, "independent": 3, "meanCosine": 0.63, "samples": [
                                        ["id": "vs_typical", "score": 0.82, "outlier": false],
                                        ["id": "vs_doubtful", "score": 0.14, "outlier": true],
                                        ["id": "vs_small", "reason": "too-few-independent", "outlier": false]]]
        let response = try MeetingsService.decode(MeetingsAPI.VoicesList.Result.self, ["learnt": [group], "people": [person]])
        for scope in [VoiceDestination.person(.init(name: "Aster"), project: nil), .project("Orchard"),
                      .inspector(meeting: "one", project: "Orchard", meetingOnly: true)] {
            let prepared = try XCTUnwrap(VoiceLibraryRows(response, destination: scope, doubtfulFirst: true).people.first)
            XCTAssertEqual(prepared.rows.map(\.id), ["vs_doubtful", "vs_typical", "vs_small"])
            XCTAssertTrue(prepared.prints.first?.contains("mean cosine 0.63") == true)
            XCTAssertTrue(prepared.rows.last?.quality?.explanation.contains("independent samples") == true)
        }
        XCTAssertEqual(VoiceLibraryRows(response, destination: .project("Orchard"), doubtfulFirst: false).people.first?.rows.first?.id, "vs_typical")
    }

    func testRecordedChannelAndFileIntervalAreWhatThePlayerOpens() async throws {
        // The two stereo channels and the two halves in file time all sound different.
        let source = FileManager.default.temporaryDirectory.appendingPathComponent("\(UUID().uuidString).caf")
        defer { try? FileManager.default.removeItem(at: source) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 2))
        do {
            let file = try AVAudioFile(forWriting: source, settings: format.settings)
            let data = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 8000))
            data.frameLength = 8000
            let channels = try XCTUnwrap(data.floatChannelData)
            for i in 0..<8000 {
                channels[0][i] = -0.5
                channels[1][i] = i < 4000 ? 0.25 : 0.75
            }
            try file.write(from: data)
        }
        let url = try await MomentPlayer.voiceClip(.init(meeting: "one", track: "source-call", path: source.path,
                                                         channel: 1, fromSec: 43, toSec: 43.25, fileFromSec: 0.5, fileToSec: 0.75))
        defer { try? FileManager.default.removeItem(at: url) }
        let file = try AVAudioFile(forReading: url)
        XCTAssertEqual(file.length, 2000)
        XCTAssertEqual(file.processingFormat.channelCount, 1)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: 2000))
        try file.read(into: buffer)
        let samples = try XCTUnwrap(buffer.floatChannelData)
        XCTAssertEqual(samples[0][0], 0.75, accuracy: 0.001)
        XCTAssertEqual(samples[0][1999], 0.75, accuracy: 0.001)
    }

    func testProjectVoicesOpensWithoutSelectingAMeeting() {
        let request = MeetingsRequest.parse(["--place", "voices:Orchard"])
        XCTAssertNotNil(request.place)
        XCTAssertNil(request.meeting)
        XCTAssertNotEqual(request.place, .project("Orchard"))
    }

    func testSameNamedOwnersAndTheirSampleIDsSurviveListing() throws {
        let json = #"""
        {"people":[
          {"project":"Orchard","person":"Aster","owner":{"name":"Aster","email":"one@example.test"},"meetings":["one"],
           "samples":[{"id":"vs_unchanged","sample":1,"meeting":"one","seat":"mic","track":"source-mic","fromSec":4,"toSec":7,
                       "confirmedAt":"2026-01-01T00:00:00Z","words":"First clip","available":false}]},
          {"project":"Orchard","person":"Aster","owner":{"name":"Aster","email":"two@example.test"},"meetings":["two"],"samples":[]}]}
        """#
        let result = try JSONDecoder().decode(MeetingsAPI.VoicesList.Result.self, from: Data(json.utf8))
        XCTAssertNotEqual(result.people[0].id, result.people[1].id)
        let clip = try XCTUnwrap(result.people[0].samples.first)
        XCTAssertEqual(String(describing: clip.id), "vs_unchanged")
        XCTAssertFalse(clip.available)
    }
}
