import AppKit
import Foundation
import XCTest
@testable import GenesisToolsMeetings

/// The second review round of the merged Meetings pull requests: each test names the finding it pins.
@MainActor
final class MeetingsReviewRound2Tests: XCTestCase {
    private var defaults: UserDefaults!
    private var suite = ""

    override func setUp() async throws {
        suite = "meetings.review2.tests.\(UUID().uuidString)"
        defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suite)
    }

    private func record(labels: [String: String]) throws -> MeetingRecordView {
        let names = try String(data: JSONSerialization.data(withJSONObject: labels, options: [.sortedKeys]), encoding: .utf8) ?? "{}"
        return try JSONDecoder().decode(MeetingRecordView.self, from: Data("""
        {"id":"m","title":"Sync","labels":[],"start":"2026-11-03T09:00:00Z","items":[],"context":[],
         "speakers":{"labels":\(names)},"sources":{}}
        """.utf8))
    }

    // MARK: A name two labels share names no label for a stretch (PR 759)

    func testABlockWhoseNameTwoLabelsShareAssignsWithoutALabel() throws {
        let detail = MeetingDetailModel(id: "m", window: nil)
        detail.settleDecisionRecord(try record(labels: ["Speaker 2": "Dana Example", "Speaker 1": "Dana Example", "Speaker 3": "Alex Example"]))
        let shared = detail.blockStretch(speaker: "Dana Example", startSec: 0)
        XCTAssertNil(shared.label, "either label could own the block's lines, so the stretch names no label")
        XCTAssertEqual(detail.speakerLabel(forShown: "Dana Example"), "Speaker 1", "the rename menu names one label on every run")
        XCTAssertEqual(detail.blockStretch(speaker: "Alex Example", startSec: 8).label, "Speaker 3", "a name one label holds keeps it")
        XCTAssertEqual(detail.blockStretch(speaker: "Speaker 3", startSec: 8).label, "Speaker 3")
    }

    // MARK: The `listen --answer` fallback keeps its journal entry (PR 759)

    func testTheListenAnswerFallbackKeepsItsEntryAndAnUnreadableAnswerFails() throws {
        let bare = #"{"token":"t1","at":"2026-11-09T17:32:38.000Z","meeting":"m","actor":{"kind":"listen"},"action":{"kind":"answer","question":"q1","answer":"yes"},"decided":["q1"],"skipped":[]}"#
        let answered = try MeetingDetailModel.decodeDecision(Data(bare.utf8), command: ["listen", "m"])
        XCTAssertEqual(answered.entry?.token, "t1", "the bare entry printed by listen --answer --json carries the Undo token")
        let wrapped = #"{"entry":null,"skipped":[{"id":"i1","reason":"already confirmed"}]}"#
        let confirmed = try MeetingDetailModel.decodeDecision(Data(wrapped.utf8), command: ["confirm", "m"])
        XCTAssertNil(confirmed.entry)
        XCTAssertEqual(confirmed.skipped.map(\.id), ["i1"])
        XCTAssertThrowsError(try MeetingDetailModel.decodeDecision(Data("[1]".utf8), command: ["listen", "m"]),
                             "an answer of neither shape is a failure, not an empty result")
    }

    // MARK: A Contacts row draws again only when what it shows changes (PR 759)

    func testAContactsRowComparesWhatItShowsAndIgnoresItsClosures() {
        let alex = KnownPerson(id: "name:alex example", name: "Alex Example", sources: [.meetings], rank: .meeting)
        func row(_ person: KnownPerson, unmerge: (() -> Void)? = nil) -> ContactsPersonRow {
            ContactsPersonRow(person: person, mergeWith: {}, setHidden: { _ in }, unmerge: unmerge)
        }
        XCTAssertEqual(row(alex), row(alex), "new closures for the same person keep the row as it is")
        var hidden = alex
        hidden.hidden = true
        XCTAssertNotEqual(row(alex), row(hidden))
        XCTAssertNotEqual(row(alex), row(alex, unmerge: {}), "a row that gains Split Merge draws again")
    }

    // MARK: A send reports what the service sent (PR 799)

    func testASendReportsTheCountTheServiceSent() throws {
        func result(sent: Int, listeners: Int) throws -> MeetingsAPI.CommentSend.Result {
            let listener = #"{"pid":42,"at":"2026-11-09T17:32:38.000Z","actor":{"kind":"agent"}}"#
            let comment = #"{"id":"c1","at":"2026-11-09T17:32:38.000Z","target":{"kind":"range","fromSec":1,"toSec":2},"text":"Hi","actor":{"kind":"window"},"state":"sent"}"#
            let json = #"{"sent":[\#(Array(repeating: comment, count: sent).joined(separator: ","))],"listeners":[\#(Array(repeating: listener, count: listeners).joined(separator: ","))]}"#
            return try JSONDecoder().decode(MeetingsAPI.CommentSend.Result.self, from: Data(json.utf8))
        }
        XCTAssertEqual(MeetingDetailModel.delivery(after: try result(sent: 0, listeners: 1), staged: 3), .sent(comments: 0, listeners: 1),
                       "another window sent them first: this send sent nothing")
        XCTAssertEqual(CommentDelivery.sent(comments: 0, listeners: 1).text,
                       "Nothing was sent: another window sent or removed these comments already")
        XCTAssertEqual(MeetingDetailModel.delivery(after: try result(sent: 2, listeners: 1), staged: 3), .sent(comments: 2, listeners: 1))
        XCTAssertEqual(MeetingDetailModel.delivery(after: try result(sent: 0, listeners: 0), staged: 3), .sent(comments: 3, listeners: 0),
                       "nobody listens: the staged comments stay staged")
    }

    // MARK: Both saves of the reach sheet carry the same choices (PR 766, PR 799)

    func testOnlyThisQuestionCarriesTheStruckItemsAndTheSpellingChoices() throws {
        let row = try JSONDecoder().decode(ReviewRows.self, from: MeetingsReviewRowTests.rowsJSON).rows[0]
        let reach = try JSONDecoder().decode(DecisionReach.self, from: MeetingsReviewRowTests.reachJSON)
        let spelling = DecisionAction.SpellingReach(lines: [.init(atSec: 12, line: 3)], dictionary: false)
        let respell = MeetingDetailModel.PendingReach(row: row, action: .respell("t1", to: "Atlas"), reason: nil, reach: reach)
        let only = MeetingDetailModel.reachAction(respell, struck: [], onlyThis: true, spelling: spelling)
        XCTAssertEqual(only.reach, spelling, "the chosen lines and the dictionary switch go with Only this question too")
        XCTAssertEqual(only.lookAlikes, "leave")
        XCTAssertEqual(MeetingDetailModel.reachAction(respell, struck: [], onlyThis: false, spelling: spelling).reach, spelling)
        let answer = MeetingDetailModel.PendingReach(row: row, action: .answer("q1", "Dana Example"), reason: nil, reach: reach)
        let struck = MeetingDetailModel.reachAction(answer, struck: ["i3"], onlyThis: true, spelling: nil)
        XCTAssertEqual(struck.except, ["i3"], "a struck item stays out of Only this question")
        XCTAssertNil(MeetingDetailModel.reachAction(answer, struck: [], onlyThis: false, spelling: nil).lookAlikes)
    }

    // MARK: A failed reach plan saves nothing (PR 799)

    func testAFailedPlanIsNotAnEmptyPlan() throws {
        let failure = MeetingsCLI.Failure(sentence: "The service did not answer.", detail: "decision.plan")
        guard case .failed = MeetingDetailModel.planStep(.failure(failure)) else {
            return XCTFail("a failed plan must not save the replacement unplanned")
        }
        guard case .apply = MeetingDetailModel.planStep(.success(nil)) else { return XCTFail("no plan reaches nothing: save") }
        let reach = try JSONDecoder().decode(DecisionReach.self, from: MeetingsReviewRowTests.reachJSON)
        guard case .review(let planned) = MeetingDetailModel.planStep(.success(.init(entry: nil, skipped: [], reach: reach))) else {
            return XCTFail("a plan that reaches more is reviewed")
        }
        XCTAssertEqual(planned, reach)
    }

    // MARK: An older settings read cannot put the raw config back (PR 759)

    private final class HeldReads {
        var waiting: [CheckedContinuation<ConfigShow, Error>] = []
    }

    private func config(language: String) throws -> ConfigShow {
        try JSONDecoder().decode(ConfigShow.self, from: Data("""
        {"path":"/x/config.json","value":{"version":3,"global":{"dictionary":{"entries":[]},"language":"\(language)",
         "capture":{"backend":"native","displays":2,"activeFps":1,"idleFps":0.1,"threshold":0.02,"jpegQuality":0.75,
         "resolutionCap":2880,"retentionDays":30,"recorders":{}},"assign":{"ask":true,"lookbackHours":48,"maxProposals":5,
         "calendarSlackMin":15,"calendarLookbehindHours":6,"folderWaitDays":30,"retryFailedMin":20},"suggest":{"applyAbove":0.5,"listenBelow":0.6}},
         "projects":{},"sources":{},"languages":{}}}
        """.utf8))
    }

    private func until(_ what: String, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(3)
        while !condition() {
            guard Date() < deadline else { return XCTFail("timed out waiting until \(what)") }
            try await Task.sleep(for: .milliseconds(10))
        }
    }

    func testAnOlderSettingsReadThatLandsLastIsDropped() async throws {
        let window = MeetingsWindowModel(defaults: defaults, service: nil, loadDetail: { _ in })
        let held = HeldReads()
        window.readSettings = { _ in try await withCheckedThrowingContinuation { held.waiting.append($0) } }
        window.loadSettings(quiet: true)
        try await until("the first read waits") { held.waiting.count == 1 }
        window.loadSettings(quiet: true)
        try await until("the second read waits") { held.waiting.count == 2 }
        let newer = try config(language: "en"), older = try config(language: "cs")
        held.waiting[1].resume(returning: newer)
        try await until("the newer read lands") { window.settingsRaw == newer.raw }
        held.waiting[0].resume(returning: older)
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(window.settingsRaw, newer.raw, "the next write names the value the config holds, not an older read")
        XCTAssertEqual(window.settings.value, newer.value)
    }

    // MARK: A project person is found by name and address (PR 809)

    func testTheEditedProjectPersonIsTheOneWithItsAddress() {
        let saved: [[String: Any]] = [["name": "Alex Example", "email": "alex@example.com"],
                                      ["name": "Alex Example", "email": "alex.other@example.com"],
                                      ["name": "Robin Example"]]
        let second = PairedPerson(name: "Alex Example", email: "alex.other@example.com", pairedBy: [])
        XCTAssertEqual(MeetingsSettingsModel.personIndex(of: second, in: saved), 1, "the second Alex keeps the first one's role")
        XCTAssertEqual(MeetingsSettingsModel.personIndex(of: PairedPerson(name: "Robin Example", email: nil, pairedBy: []), in: saved), 2)
        XCTAssertNil(MeetingsSettingsModel.personIndex(of: PairedPerson(name: "Alex Example", email: nil, pairedBy: []), in: saved))
    }

    // MARK: The seats editor keeps typed lists until Save (PR 809)

    func testTheSeatsDraftKeepsATypedCommaAndParsesOnSave() {
        var seats = MeetingSeats()
        seats.room = ["Alice Example"]
        var draft = MeetingSeatsDraft(seats)
        draft.room = "Alice Example, "
        XCTAssertEqual(draft.room, "Alice Example, ", "the comma stays while the next name is typed")
        draft.room = "Alice Example, Bob Example"
        draft.addMicrophone()
        draft.members[0] = "Carol Example,  Dana Example,"
        XCTAssertEqual(draft.parsed.room, ["Alice Example", "Bob Example"])
        XCTAssertEqual(draft.parsed.microphones?.first?.people, ["Carol Example", "Dana Example"])
        draft.removeMicrophone(at: 0)
        XCTAssertEqual(draft.members, [])
        XCTAssertEqual(draft.parsed.microphones, [])
    }
}
