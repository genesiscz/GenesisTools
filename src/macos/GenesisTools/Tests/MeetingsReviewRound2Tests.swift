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
}
