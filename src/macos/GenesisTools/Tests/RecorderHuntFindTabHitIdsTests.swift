import XCTest
@testable import GenesisToolsRecorder

/// A Find row is a moment, not a frame file: find-screen answers two hits of one file when the plan shows that frame
/// twice, so the list keys each hit by its file and its time.
final class RecorderHuntFindTabHitIdsTests: XCTestCase {
    func testEveryHitOfTheFixtureHasItsOwnId() throws {
        let fixture = try RecorderFixtures.object("screen-hit-ops.json")
        let hits = try JSONDecoder().decode([ScreenHit].self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(fixture["hits"])))
        XCTAssertGreaterThan(hits.count, Set(hits.map(\.file)).count, "the fixture shows one frame twice")
        XCTAssertEqual(Set(hits.map(\.id)).count, hits.count, "two moments of one frame are two rows")
    }
}
