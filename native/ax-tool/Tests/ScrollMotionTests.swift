import XCTest
@testable import SnapshotSupport

final class ScrollMotionTests: XCTestCase {
    func testTheDeltasSumToTheDistanceInBothDirections() {
        for ease in ScrollEase.allCases {
            XCTAssertEqual(ScrollMotion.deltas(total: 2000, count: 37, ease: ease).reduce(0, +), 2000)
            XCTAssertEqual(ScrollMotion.deltas(total: -777, count: 12, ease: ease).reduce(0, +), -777)
        }
        XCTAssertEqual(ScrollMotion.deltas(total: 0, count: 10, ease: .flick), [])
    }

    func testAFlickStartsFastAndSlowsDownWhileLinearKeepsItsSpeed() {
        let flick = ScrollMotion.deltas(total: 3000, count: 30, ease: .flick)
        XCTAssertGreaterThan(flick.first!, flick.last! * 10, "the first frame moves far more than the last")
        XCTAssertEqual(flick, flick.sorted(by: >), "never speeds up again")
        let linear = ScrollMotion.deltas(total: 3000, count: 30, ease: .linear)
        XCTAssertEqual(Set(linear), [100])
    }

    func testEventsFollowTheTimeAndCarryTrackpadPhases() {
        XCTAssertEqual(ScrollMotion.eventCount(seconds: nil), 1)
        XCTAssertEqual(ScrollMotion.eventCount(seconds: 0.5), 30)
        XCTAssertEqual(ScrollMotion.eventCount(seconds: 0.01), 2)
        XCTAssertEqual((0..<4).map { ScrollMotion.phase(index: $0, count: 4) }, [1, 2, 2, 4])
        XCTAssertEqual(ScrollMotion.phase(index: 0, count: 1), 0)
    }
}
