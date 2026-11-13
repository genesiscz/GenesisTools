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
}
