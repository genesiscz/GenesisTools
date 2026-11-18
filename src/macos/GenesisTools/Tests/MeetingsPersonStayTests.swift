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
        draft.seatRemote("Robin Example")
        draft.removeRemote(at: 0)
        XCTAssertEqual(draft.joins, [""])
        XCTAssertEqual(draft.seats.remote.map(\.name), ["Robin Example"])
    }

    func testSeatSuggestionsPrefillDecidedPeopleAndLeaveUnsurePeopleUnseated() throws {
        let read = MeetingDetailModel.seatsRead("practice")
        XCTAssertEqual(read.method, "meeting.seats.suggest")
        XCTAssertEqual(read.args, ["seats", "practice", "--json"])
        let result = try JSONDecoder().decode(MeetingsAPI.SeatsSuggest.Result.self, from: Data(#"""
        {"meeting":"practice","current":null,"suggestion":{"seats":{"room":["Reed"],"remote":[{"name":"Fern","fromSec":4.25,"toSec":17.75}]},
         "people":[{"name":"Reed","seat":"room","reason":"Recording participant (self).","confidence":1},
                   {"name":"Fern","seat":"remote","reason":"5 of 5 decided lines on the call.","confidence":1},
                   {"name":"Lake","seat":"unsure","reason":"Muted on both reads.","confidence":0}]}}
        """#.utf8))
        var draft = MeetingSeatChoices(result.suggestion)
        XCTAssertEqual(draft.suggestion.people.last?.reason, "Muted on both reads.")
        XCTAssertEqual(draft.choices["Lake"], .unsure)
        XCTAssertEqual(draft.count, 2)
        XCTAssertEqual(draft.seats(record: nil), result.suggestion.seats)
        draft.set(.unsure, for: "Reed")
        draft.set(.room, for: "Lake")
        draft.set(.room, for: "Lake")
        XCTAssertEqual(draft.count, 2)
        XCTAssertEqual(draft.seats(record: nil), MeetingSeats(room: ["Lake"], remote: [.init(name: "Fern", fromSec: 4.25, toSec: 17.75)]))
        draft.set(.unsure, for: "Lake")
        draft.set(.unsure, for: "Fern")
        XCTAssertEqual(draft.count, 0)
        XCTAssertEqual(draft.seats(record: nil), MeetingSeats())
    }

    /// w_sbxfmxen: the seats sheet seats picked people and picks a device; nothing is typed as an id or a comma list,
    /// and Save writes the engine's shape (`self`, `device:<owner>` with the owner, room or remote members only).
    func testTheSeatsSheetSeatsPickedPeopleOnDevicesItOffers() {
        var draft = MeetingSeatsDraft(MeetingSeats())
        draft.seatInRoom("Alice Example")
        draft.seatInRoom("Bob Example")
        draft.seatInRoom("alice example")
        XCTAssertEqual(draft.seats.room, ["Alice Example", "Bob Example"], "names compare as the engine folds them")
        draft.seatRemote("Dana Example")
        XCTAssertEqual(draft.newDevices, [.thisMac, .owner("Dana Example")])

        draft.addMicrophone(.thisMac)
        XCTAssertEqual(draft.seats.microphones?[0], .init(id: "self", label: nil, people: ["Alice Example", "Bob Example"], deviceId: nil),
                       "this Mac's microphone starts with the room")
        draft.addMicrophone(.owner("Dana Example"))
        XCTAssertEqual(draft.seats.microphones?[1],
                       .init(id: "device:Dana Example", label: nil, people: ["Dana Example"], deviceId: "Dana Example"),
                       "a person's own device as the engine writes it")
        XCTAssertEqual(draft.newDevices, [], "every seat has its microphone")
        XCTAssertEqual(draft.device(at: 1).title, "Dana Example's device")

        draft.seatRemote("Bob Example")
        XCTAssertEqual(draft.seats.room, ["Alice Example"], "a person has one seat: Bob moves")
        XCTAssertEqual(draft.seats.microphones?[0].people, ["Alice Example"], "and leaves the room's microphone")
        XCTAssertEqual(draft.eligible(1), ["Dana Example", "Bob Example"], "a device offers the remote people")
        draft.toggle("Bob Example", inMicrophone: 1)
        XCTAssertEqual(draft.seats.microphones?[1].people, ["Dana Example", "Bob Example"])
        XCTAssertEqual(draft.devices(for: 0).map(\.free), [true, false, true], "Dana's device is the other group")

        draft.toggle("Alice Example", inMicrophone: 0)
        XCTAssertEqual(draft.problem, "This Mac's microphone carries nobody. Tick a person, or remove it.")
        draft.removeMicrophone(at: 0)
        XCTAssertNil(draft.problem)
        draft.unseat("Dana Example")
        XCTAssertEqual(draft.seats.microphones?[0].people, ["Bob Example"], "an unseated person leaves every microphone")
        let saved = draft.parsed
        XCTAssertEqual(saved.room, ["Alice Example"])
        XCTAssertEqual(saved.remote.map(\.name), ["Bob Example"])
        draft.removeMicrophone(at: 0)
        XCTAssertNil(draft.parsed.microphones, "no microphones: the key stays out, as before")
    }

    func testTheSeatsSheetKeepsARecordsSeatsAsTheyAreAndShowsAnOlderDevice() throws {
        let seats = try XCTUnwrap(try record().seats)
        let draft = MeetingSeatsDraft(seats)
        XCTAssertEqual(draft.parsed, seats, "opening the sheet and saving changes nothing")
        XCTAssertEqual(draft.device(at: 0), .thisMac)
        XCTAssertEqual(draft.device(at: 1), .other(id: "desk", owner: "carol-laptop"), "a group made another way keeps its id")
        XCTAssertEqual(draft.device(at: 1).title, "carol-laptop's device")
        XCTAssertEqual(draft.members(1), ["Dana Example"])
        XCTAssertTrue(draft.carriesRoom(0))
        XCTAssertFalse(draft.carriesRoom(1))
    }

    func testChangingOneSeatTimePreservesTheOtherStoredSecond() {
        let seats = MeetingSeats(remote: [.init(name: "Dana Example", fromSec: 2.044, toSec: 9.811)])
        var draft = MeetingSeatsDraft(seats)
        XCTAssertEqual(draft.parsed, seats)
        draft.leaves[0] = "2"
        XCTAssertEqual(draft.problem, "Dana Example: The leave comes before the join.")
        draft.leaves[0] = "6"
        XCTAssertNil(draft.problem)
        XCTAssertEqual(draft.parsed.remote.first?.fromSec, 2.044)
        XCTAssertEqual(draft.parsed.remote.first?.toSec, 6)
    }

    func testAnExistingDeviceKeepsItsMembersSeatKindAndReservesItsOwner() {
        let seats = MeetingSeats(room: ["Alex Example"], remote: [.init(name: "Dana Example")],
                                 microphones: [.init(id: "desk", people: ["Alex Example"], deviceId: "Example, Dana")])
        let draft = MeetingSeatsDraft(seats)
        XCTAssertEqual(draft.eligible(0), ["Alex Example"])
        XCTAssertEqual(draft.newDevices, [.thisMac])
        XCTAssertEqual(draft.parsed, seats)
    }

    // MARK: Undo ends its notice (w_o8fbzbq8)

    func testAnUndoThatWorkedEndsItsNoticeAsUndoneAndTheNoticeFades() async throws {
        let clock = ManualNoticeClock()
        let notices = NoticeStackModel(clock: clock, announces: false)
        let id = notices.push(StackedNotice(text: "Removed Dana Example from the meeting", actions: [.undo { _ in }]))
        notices.press(try XCTUnwrap(notices.notice(id)?.actions.first), of: id)
        XCTAssertEqual(notices.waiting[id], "Undoing…")

        await notices.settleUndo(id, done: "Undone: Dana Example is back in the meeting, 02:00 to the end") {}.value
        let notice = try XCTUnwrap(notices.notice(id), "the answer takes the Undo's place")
        XCTAssertEqual(notice.text, "Undone: Dana Example is back in the meeting, 02:00 to the end")
        XCTAssertNil(notices.waiting[id], "no notice stays on Undoing… after the undo finished")
        XCTAssertTrue(notice.actions.isEmpty)
        clock.advance(by: NoticeStackTiming.standard.plainSeconds + 0.1)
        XCTAssertFalse(notices.contains(id), "a plain Undone notice fades")
    }

    func testAnUndoThatFailedSaysSoAndItsRetryWaitsInPlace() async throws {
        let notices = NoticeStackModel(clock: ManualNoticeClock(), announces: false)
        let id = notices.push(StackedNotice(text: "Removed Dana Example from the meeting", actions: [.undo { _ in }]))
        notices.press(try XCTUnwrap(notices.notice(id)?.actions.first), of: id)
        var attempts = 0
        let work: @MainActor () async throws -> Void = {
            attempts += 1
            if attempts == 1 { throw MeetingsCLI.Failure(sentence: "The record is locked.", detail: "attendance m") }
        }

        await notices.settleUndo(id, done: "Undone: Dana Example is back", work).value
        let failed = try XCTUnwrap(notices.notice(id))
        XCTAssertEqual(failed.text, "Not undone: The record is locked.")
        XCTAssertEqual(failed.tone, .error, "an error stays until it is closed")
        XCTAssertNil(notices.waiting[id])
        let retry = try XCTUnwrap(failed.actions.first)
        XCTAssertEqual(retry.label, "Retry")
        XCTAssertEqual(retry.afterPress, .wait("Undoing…"), "Retry waits in the notice's place, as the Undo did")

        notices.press(retry, of: id)
        try await until("the retried undo answers") { notices.notice(id)?.text == "Undone: Dana Example is back" }
        XCTAssertEqual(attempts, 2)
        XCTAssertNil(notices.waiting[id])
    }

    func testDismissingAnUndoInFlightKeepsItsNoticeClosed() async {
        let notices = NoticeStackModel(clock: ManualNoticeClock(), announces: false)
        let id = notices.push(StackedNotice(text: "Removed Dana Example"))
        let undo = notices.settleUndo(id, done: "Undone") { notices.dismiss(id) }
        await undo.value
        XCTAssertTrue(notices.notices.isEmpty)
    }

    func testThePersonEditorsUndoWritesWhatTheNoticeReportsAndSaysSo() throws {
        let dana = PersonStay(name: "Dana Example", fromSec: 120, toSec: nil, atMic: false, via: "carol-laptop", stays: 1)
        var moved = dana
        moved.fromSec = 300
        let removal = try XCTUnwrap(PersonStay.undo(after: nil, before: dana, meeting: "m"))
        XCTAssertEqual(removal.params, dana.params(meeting: "m"), "undoing a removal adds them back as they were")
        XCTAssertEqual(removal.done, "Undone: Dana Example is back in the meeting, 02:00 to the end")
        let addition = try XCTUnwrap(PersonStay.undo(after: dana, before: nil, meeting: "m"))
        XCTAssertEqual(addition.params, dana.params(meeting: "m", remove: true), "undoing an addition removes them")
        XCTAssertEqual(addition.done, "Undone: Dana Example is out of the meeting again")
        let edit = try XCTUnwrap(PersonStay.undo(after: moved, before: dana, meeting: "m"))
        XCTAssertEqual(edit.params, dana.params(meeting: "m"), "undoing an edit writes the stay from before")
        XCTAssertEqual(edit.done, "Undone: Dana Example stays 02:00 to the end again")
        XCTAssertNil(PersonStay.undo(after: nil, before: nil, meeting: "m"))
    }

    /// The kit's Undo leaves its notice on "Undoing…" until something replaces it, so an Undo whose closure drops the
    /// notice's id can never end it. Every Undo in the Meetings part takes the id.
    func testNoMeetingsUndoDropsItsNoticesID() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/Parts/Meetings")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil))
            .compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
        XCTAssertGreaterThan(files.count, 20, "the scan reads the part's sources")
        let dropped = try NSRegularExpression(pattern: #"\.undo \{ (\[[^\]]*\] )?_ in"#)
        var found: [String] = []
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for match in dropped.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
                let line = text[..<(Range(match.range, in: text)?.lowerBound ?? text.startIndex)].filter { $0 == "\n" }.count + 1
                found.append("\(file.lastPathComponent):\(line)")
            }
        }
        XCTAssertEqual(found, [], "an Undo that drops its notice's id leaves the notice on Undoing…")
        let control = ".undo { [weak self] _ in self?.undo() }"
        XCTAssertEqual(dropped.numberOfMatches(in: control, range: NSRange(control.startIndex..., in: control)), 1,
                       "the pattern finds the defect")
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
