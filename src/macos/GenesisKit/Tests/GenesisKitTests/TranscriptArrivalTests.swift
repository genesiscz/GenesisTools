import XCTest
@testable import GenesisKit

final class TranscriptArrivalTests: XCTestCase {
    private func section(_ id: String, _ rows: [String]) -> TranscriptSection {
        TranscriptSection(
            id: id,
            number: 1,
            startedAt: nil,
            duration: nil,
            toolCount: 0,
            errorCount: 0,
            usage: nil,
            rows: rows.map { TranscriptRow(id: $0, kind: .reply(text: $0, usage: nil, model: nil), at: nil, clock: nil, searchText: $0) }
        )
    }

    func testRowsAfterTheLastKnownRowAcrossANewSection() {
        let sections = [section("s1", ["a", "b"]), section("s2", ["c", "d"])]
        XCTAssertEqual(SessionTranscriptList.rows(after: "b", in: sections), ["c", "d"])
        XCTAssertEqual(SessionTranscriptList.rows(after: "d", in: sections), [])
        XCTAssertNil(SessionTranscriptList.rows(after: "gone", in: sections))
    }
}
