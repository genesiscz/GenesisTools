import SwiftUI
import Vision
import XCTest
@testable import GenesisToolsMeetings

/// The one editor of who was there (audit M5): the stay it reads from a record, one clock format for the join and the
/// leave in every editor, what a save or a removal writes, and the words the editor draws.
@MainActor
final class MeetingsPersonStayTests: XCTestCase {
    private func record() throws -> MeetingRecordView {
        try JSONDecoder().decode(MeetingRecordView.self, from: Data(#"""
        {"id":"m","title":"Practice","labels":[],"start":"2026-01-01T00:00:00Z","items":[],"context":[],"speakers":{"labels":{}},"sources":{},
         "participants":[{"name":"Alice Example","stays":[{"fromSec":5,"toSec":600,"source":"hand"}]},
                         {"name":"Bob Example","stays":[{"fromSec":0,"toSec":60,"source":"roster"},{"fromSec":300,"toSec":900,"source":"roster"}]},
                         {"name":"Dana Example","firstSeenSec":120}],
         "seats":{"room":["Alice Example"],"remote":[{"name":"Dana Example"}],
                  "microphones":[{"id":"self","people":["Alice Example"]},{"id":"desk","deviceId":"carol-laptop","people":["Dana Example"]}]}}
        """#.utf8))
    }

    func testAStayReadsTheRecordsTimesAndSeat() throws {
        let record = try record()
        XCTAssertEqual(PersonStay.of("Alice Example", in: record),
                       PersonStay(name: "Alice Example", fromSec: 5, toSec: 600, atMic: true, via: nil, stays: 1))
        XCTAssertEqual(PersonStay.of("Bob Example", in: record).stays, 2, "a save replaces two stays: the editor says so")
        XCTAssertEqual(PersonStay.of("Bob Example", in: record).toSec, 900, "from the first join to the last leave")
        let dana = PersonStay.of("Dana Example", in: record)
        XCTAssertEqual(dana.fromSec, 120)
        XCTAssertFalse(dana.atMic)
        XCTAssertEqual(dana.via, "carol-laptop")
        XCTAssertTrue(PersonStay.of("Robin Example", in: record).atMic, "a new person starts in the room")
    }

    func testOneClockFormatAndItsChecks() {
        XCTAssertEqual(PersonStay.Clock("12:04"), .seconds(724))
        XCTAssertEqual(PersonStay.Clock("1:05:30"), .seconds(3930))
        XCTAssertEqual(PersonStay.Clock(" "), .empty, "empty: from the start or to the end")
        for text in ["1:90", "nan", "-1", "1::2", "inf", "12 min"] { XCTAssertEqual(PersonStay.Clock(text), .invalid, text) }
        XCTAssertNil(PersonStay.problem(from: .seconds(5), to: .empty, duration: 600))
        XCTAssertEqual(PersonStay.problem(from: .seconds(60), to: .seconds(30), duration: nil), "The leave comes before the join.")
        XCTAssertEqual(PersonStay.problem(from: .invalid, to: .empty, duration: nil), "Write a time as 12:04 or 1:05:30, or leave it empty.")
        XCTAssertEqual(PersonStay.problem(from: .seconds(0), to: .seconds(700), duration: 600),
                       "11:40 is after the meeting's end (10:00).")
        XCTAssertEqual(ListenPresenceStrip.window(from: "01:02", to: "1:02:03", duration: 4000), 62...3723, "the strip reads the same clock")
    }

    func testTheEditorWritesAStoredTimeToATenth() {
        XCTAssertEqual(ListenPresenceStrip.clock(5872.7229999999999563), "1:37:52.7", "never the float's every digit")
        XCTAssertEqual(ListenPresenceStrip.clock(1.5), "00:01.5")
        XCTAssertEqual(ListenPresenceStrip.clock(12), "00:12")
        XCTAssertEqual(ListenPresenceStrip.clock(59.96), "01:00", "a tenth that rounds up carries into the minute")
        XCTAssertEqual(PersonStay.Clock(ListenPresenceStrip.clock(724.25)).value ?? -1, 724.3, accuracy: 0.001,
                       "the editor reads back what it wrote")
    }

    func testASaveAndARemovalWriteOnlyWhatTheyMean() {
        let stay = PersonStay(name: "Dana Example", fromSec: 120, toSec: nil, atMic: false, via: "carol-laptop", stays: 1)
        let save = stay.params(meeting: "m")
        XCTAssertEqual(save, .init(meeting: "m", name: "Dana Example", action: "add", fromSec: 120, toSec: nil, atMic: false, via: "carol-laptop"))
        XCTAssertEqual(stay.windowWords, "02:00 to the end")
        var room = stay
        room.atMic = true
        XCTAssertNil(room.params(meeting: "m").via, "a seat at this Mac's microphone goes through no other device")
        XCTAssertEqual(stay.params(meeting: "m", remove: true),
                       .init(meeting: "m", name: "Dana Example", action: "remove", fromSec: nil, toSec: nil, atMic: nil, via: nil))
    }

    func testTheSeatsSheetTakesTheSameClockTimes() {
        var seats = MeetingSeats()
        seats.remote = [.init(name: "Dana Example", label: nil, fromSec: 75, toSec: nil)]
        var draft = MeetingSeatsDraft(seats)
        XCTAssertEqual(draft.joins, ["01:15"])
        draft.joins[0] = "1:"
        XCTAssertEqual(draft.joins[0], "1:", "a half-typed time stays while it is typed")
        XCTAssertEqual(draft.problem, "Dana Example: Write a time as 12:04 or 1:05:30, or leave it empty.")
        draft.joins[0] = "1:05"
        draft.leaves[0] = "1:00:00"
        XCTAssertNil(draft.problem)
        XCTAssertEqual(draft.parsed.remote.first?.fromSec, 65)
        XCTAssertEqual(draft.parsed.remote.first?.toSec, 3600)
        draft.addRemote()
        draft.removeRemote(at: 0)
        XCTAssertEqual(draft.joins, [""])
    }

    func testTheEditorAsksForClockTimesAndKeepsRemoveApart() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        let editor = PersonStayEditor(detail: detail, original: PersonStay(name: "Alice Example", fromSec: 5, toSec: 600, atMic: true,
                                                                           via: nil, stays: 2), duration: 900, close: {})
            .frame(width: 440).background(Color(white: 0.12)).environment(\.colorScheme, .dark)
        let renderer = ImageRenderer(content: editor)
        renderer.scale = 2
        let image = try XCTUnwrap(renderer.cgImage)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        for word in ["Who was there: Alice Example", "Joined", "Left", "12:04 or 1:05:30", "replaces their 2 stays", "Remove from the meeting", "Save"] {
            XCTAssertTrue(text.contains(word), "drawn: \(word) in\n\(text)")
        }
        XCTAssertFalse(text.contains("transcript seconds"), "no seconds to type")
    }
}
