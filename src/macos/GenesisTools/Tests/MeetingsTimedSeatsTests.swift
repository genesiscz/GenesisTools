import Foundation
import XCTest
@testable import GenesisToolsMeetings

@MainActor
final class MeetingsTimedSeatsTests: XCTestCase {
    func testSeatOfferKeepsTheQuestionAndEvidenceForEitherAnswer() throws {
        let json = #"""
        {"meeting":"review","current":null,"suggestion":{"seats":{},"people":[],"deviceOffers":[{
          "account":"Boardroom PC","group":"self","meetings":["planning","review"],"question":"Is this the shared microphone?"
        }]}}
        """#
        let result = try JSONDecoder().decode(MeetingsAPI.SeatsSuggest.Result.self, from: Data(json.utf8))
        let offer = try XCTUnwrap(result.suggestion.deviceOffers?.first)
        XCTAssertEqual(offer.question, "Is this the shared microphone?")
        for yes in [true, false] {
            let params = RoomDeviceChange.answer(offer, meeting: result.meeting, yes: yes).params
            XCTAssertEqual(try MeetingsService.paramsObject(params) as NSDictionary, [
                "action": "answer", "account": "Boardroom PC", "group": "self",
                "meetings": ["planning", "review"], "meeting": "review", "yes": yes,
            ] as NSDictionary)
        }
    }

    func testSeatSuggestionFromBeforeDeviceOffersStillDecodes() throws {
        let json = #"{"meeting":"planning","current":null,"suggestion":{"seats":{"room":["Boardroom PC"]},"people":[]}}"#
        let result = try JSONDecoder().decode(MeetingsAPI.SeatsSuggest.Result.self, from: Data(json.utf8))
        XCTAssertEqual(result.suggestion.seats.room, ["Boardroom PC"])
        XCTAssertTrue(result.suggestion.people.isEmpty)
    }

    func testRefreshedSeatsKeepAnEditedGuestAndDropTheConfirmedDevice() {
        typealias Suggestion = MeetingsAPI.SeatsSuggest.Suggestion
        let guest = MeetingsAPI.SeatsSuggest.Person(name: "Ash Example", seat: .unsure, reason: "Roster", confidence: 0.4)
        let device = MeetingsAPI.SeatsSuggest.Person(name: "Boardroom PC", seat: .remote, reason: "Roster", confidence: 0.5)
        var choices = MeetingSeatChoices(Suggestion(seats: .init(), people: [guest, device]))
        choices.set(.room, for: guest.name)
        let fresh = choices.refreshed(with: Suggestion(seats: .init(), people: [guest]))
        XCTAssertEqual(fresh.choices, [guest.name: .room])
        XCTAssertEqual(fresh.count, 1)
    }

    func testEditingAnotherSeatPreservesLegacyRoomGroupAndDisjointStays() throws {
        let data = Data(#"""
        {"room":["Reed Example",{"name":"Fern Example","fromSec":60,"toSec":120}],
         "remote":[{"name":"Fern Example","toSec":60},{"name":"Fern Example","fromSec":150,"label":"Guest"},"Ash Example"],
         "microphones":[{"id":"self","people":["Reed Example","Fern Example"]}]}
        """#.utf8)
        var draft = MeetingSeatsDraft(try JSONDecoder().decode(MeetingSeats.self, from: data))
        draft.joins[2] = "0:05"
        XCTAssertEqual(draft.roomJoins, ["", "01:00"])
        XCTAssertEqual(draft.roomLeaves, ["", "02:00"])
        XCTAssertNil(draft.problem)
        let saved = try JSONEncoder().encode(draft.parsed)
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: saved) as? [String: Any])
        let room = try XCTUnwrap(rows["room"] as? [Any])
        XCTAssertEqual(room[0] as? String, "Reed Example")
        let interval = try XCTUnwrap(room[1] as? [String: Any])
        XCTAssertEqual(interval["name"] as? String, "Fern Example")
        XCTAssertEqual(interval["fromSec"] as? Double, 60)
        XCTAssertEqual(interval["toSec"] as? Double, 120)
        let reopened = try JSONDecoder().decode(MeetingSeats.self, from: saved)
        XCTAssertEqual(reopened.remote.map(\.fromSec), [nil, 150, 5])
        XCTAssertEqual(reopened.remote.map(\.toSec), [60, nil, nil])
        XCTAssertEqual(reopened.remote[1].label, "Guest")
        XCTAssertEqual(reopened.microphones, [.init(id: "self", people: ["Reed Example", "Fern Example"])])
        draft.roomLeaves[1] = "2:05"
        XCTAssertEqual(draft.parsed.roomRows[1].toSec, 125)
        draft.roomJoins[1] = "0:59"
        XCTAssertNotNil(draft.problem)
        draft.roomJoins[1] = "1:00"
        draft.leaves[0] = "1:01"
        XCTAssertNotNil(draft.problem)
        draft.leaves[0] = "1:00"
        draft.removeRemote(at: 0)
        XCTAssertEqual(draft.parsed.remote.map(\.name), ["Fern Example", "Ash Example"])
        XCTAssertEqual(draft.parsed.microphones, reopened.microphones)
        draft.seatRemote("Fern Example", additionalInterval: true)
        draft.joins[2] = "0:05"
        draft.leaves[2] = "0:55"
        XCTAssertNil(draft.problem)
        XCTAssertEqual(draft.parsed.remote[2].fromSec, 5)
        XCTAssertEqual(draft.parsed.roomRows[1].toSec, 125)
    }

    func testNewEmptyRemoteIntervalCannotBeSaved() throws {
        let old = try JSONDecoder().decode(MeetingSeats.self, from: Data(#"{"remote":[{"name":"Ash Example","fromSec":20,"toSec":20}]}"#.utf8))
        XCTAssertNil(old.intervalProblem(allowEmptyRemote: true))
        var draft = MeetingSeatsDraft(MeetingSeats(remote: [.init(name: "Ash Example", fromSec: 20)]))
        draft.leaves[0] = "0:20"
        XCTAssertNotNil(draft.problem)
    }

    // MARK: The owner's round on a real meeting (U3 to U6, 2026-11-18)

    /// A record as the engine writes it after a call: the roster's first reads as stays, and channels that do not
    /// separate the voices.
    private func rosterRecord() throws -> MeetingRecordView {
        try JSONDecoder().decode(MeetingRecordView.self, from: Data(#"""
        {"id":"m","title":"Seats","labels":[],"start":"2026-11-18T10:00:00Z","items":[],"context":[],
         "speakers":{"labels":{}},"sources":{},
         "participants":[
           {"name":"Ash Example","from":["platform-roster"],"firstSeenSec":20.373,
            "stays":[{"fromSec":20.373,"source":"platform-roster","confidence":1}]},
           {"name":"Fern Example","from":["wisprflow","platform-roster"],"firstSeenSec":1.387,
            "stays":[{"fromSec":1.387,"source":"platform-roster","confidence":1}]}],
         "attendance":{"from":"teams","people":[{"name":"Reed Example","fromSec":90,"toSec":600}]},
         "evidence":{"channels":{"layout":"unknown","micMedian":0.552,"systemMedian":0.103,
                                 "reason":"the channels do not separate the voices"}}}
        """#.utf8))
    }

    /// U6: a time says where it came from, in the words of the "Who was there" strip, and a roster read says that the
    /// exact join is not known.
    func testSeatTimeNamesItsSourceInWords() throws {
        let record = try rosterRecord()
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Ash Example", from: 20.373, to: nil, record: record),
                       "From the call's attendee list: first seen 00:20.4, the exact join time is unknown.")
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Fern Example", from: 1.387, to: nil, record: record),
                       "From the call's attendee list: there when the recording started, the exact join time is unknown.")
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Reed Example", from: 90, to: 600, record: record),
                       "From the call's attendee list: joined at 01:30, left at 10:00.")
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Ash Example", from: 724, to: 1800, record: record),
                       "Set by hand: joined at 12:04, left at 30:00.")
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Ash Example", from: nil, to: nil, record: record), "Whole meeting.")
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Ash Example", from: nil, to: nil, record: nil), "Whole meeting.")
        XCTAssertEqual(MeetingSeatsDraft.timeWords(name: "Ash Example", from: 20.373, to: 1800, record: record),
                       "From the call's attendee list: first seen 00:20.4, the exact join time is unknown. Set by hand: left at 30:00.")
    }

    /// U6: a join within 2 s of the start is the start. The field stays empty, so it shows "At the start", and an
    /// untouched field keeps the stored seconds.
    func testJoinWithinTwoSecondsOfTheStartReadsAtTheStart() throws {
        var draft = MeetingSeatsDraft(MeetingSeats(remote: [.init(name: "Fern Example", fromSec: 1.387),
                                                            .init(name: "Ash Example", fromSec: 2.5)]))
        XCTAssertEqual(draft.joins, ["", "00:02.5"])
        XCTAssertNil(draft.problem)
        XCTAssertEqual(draft.parsed.remote.map(\.fromSec), [1.387, 2.5])
        XCTAssertEqual(draft.times(.remote, at: 0).from, 1.387)
        draft.joins[0] = "0:30"
        XCTAssertEqual(draft.parsed.remote[0].fromSec, 30)
        let room = MeetingSeatsDraft(try JSONDecoder().decode(MeetingSeats.self,
                                                              from: Data(#"{"room":[{"name":"Reed Example","fromSec":0.4,"toSec":120}]}"#.utf8)))
        XCTAssertEqual(room.roomJoins, [""])
        XCTAssertEqual(room.roomLeaves, ["02:00"])
        XCTAssertEqual(room.parsed.roomRows[0].fromSec, 0.4)
        XCTAssertEqual(room.times(.room, at: 0).to, 120)
        XCTAssertEqual(MeetingSeatsEditor.startPrompt, "At the start")
        XCTAssertEqual(MeetingSeatsEditor.endPrompt, "At the end")
    }

    /// U6: a channel label means something only when the recording keeps the voices on their own channels.
    func testLabelPickerHidesWhenTheChannelsDoNotSeparateVoices() throws {
        let layout = try rosterRecord().evidence?.channels?.layout
        XCTAssertEqual(layout, "unknown")
        XCTAssertFalse(MeetingSeatsEditor.showsLabel(layout: layout, current: nil))
        XCTAssertTrue(MeetingSeatsEditor.showsLabel(layout: layout, current: "Speaker 2"))
        XCTAssertTrue(MeetingSeatsEditor.showsLabel(layout: "left-mic", current: nil))
        XCTAssertFalse(MeetingSeatsEditor.showsLabel(layout: nil, current: nil))
    }

    /// U3: the people pill's tooltip is one sentence and where to act; the log with its commands is under Details.
    func testPeoplePillTooltipIsOneSentenceAndTheLogMovesToDetails() {
        let log = "attendance not collected: tools ms-teams meetings attendance \"Fixture\" failed: Could not resolve a single meeting chat.\n  tools ms-teams meetings list"
        let sentence = "Teams did not say who joined, so the people come from the transcript."
        XCTAssertEqual(MeetingPeopleChip.tooltip(attendance: sentence, notes: [log]),
                       "Teams did not say who joined, so the people come from the transcript. Add or edit the people here.")
        XCTAssertEqual(MeetingPeopleChip.tooltip(attendance: "Attendance not found", notes: []),
                       "Attendance not found. Add or edit the people here.")
        let notesOnly = MeetingPeopleChip.tooltip(attendance: nil, notes: [log])
        XCTAssertFalse(notesOnly.contains("tools "), notesOnly)
        XCTAssertTrue(notesOnly.contains("Details"), notesOnly)
        XCTAssertEqual(MeetingPeopleChip.tooltip(attendance: nil, notes: []),
                       "Who took part: edit someone's join and leave, or add a person")
        XCTAssertEqual(MeetingPeopleChip.detailsText(attendance: log, notes: [log, "Speaking indicator gap 10s to 20s"]),
                       log + "\n\nSpeaking indicator gap 10s to 20s")
        XCTAssertEqual(MeetingPeopleChip.detailsText(attendance: nil, notes: []), "")
    }

    /// U4: the pill names what is missing and its tooltip says what was kept.
    func testTranscriptOnlyPillSaysNoScreenRecording() {
        XCTAssertEqual(MeetingBadgesView.noScreenRecording(hasSound: true).title, "No screen recording")
        XCTAssertEqual(MeetingBadgesView.noScreenRecording(hasSound: true).tooltip,
                       "Only the transcript and the sound were saved. No screen recording exists for this meeting.")
        XCTAssertEqual(MeetingBadgesView.noScreenRecording(hasSound: false).tooltip,
                       "Only the transcript was saved. No screen recording exists for this meeting.")
    }
}
