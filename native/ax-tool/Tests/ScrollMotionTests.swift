import XCTest
@testable import SnapshotSupport

final class ScrollMotionTests: XCTestCase {
    func testNumericDefaultsApplyOnlyWhenOptionsAreAbsent() throws {
        let defaults = try ScrollNumericOptions([:])
        XCTAssertEqual(defaults.pixels, 120)
        XCTAssertEqual(defaults.amount, 3)
        XCTAssertNil(defaults.seconds)
        XCTAssertEqual(defaults.repeats, 1)
        XCTAssertEqual(defaults.pause, 0.3)
        let explicit = try ScrollNumericOptions(["--pixels": "200", "--time": "0.5", "--repeat": "2", "--pause": "0"])
        XCTAssertEqual(explicit.pixels, 200)
        XCTAssertEqual(explicit.seconds, 0.5)
        XCTAssertEqual(explicit.repeats, 2)
        XCTAssertEqual(explicit.pause, 0)
        XCTAssertEqual(try ScrollNumericOptions(["--amount": "5"]).pixels, 200)
    }

    func testSuppliedInvalidNumbersNeverBecomeDefaultScrolls() {
        for (flag, raw) in [("--time", "1sec"), ("--pixels", "many"), ("--repeat", "2x"), ("--pause", "soon"),
                            ("--repeat", "1.5"), ("--time", "nan"), ("--pause", "inf")] {
            XCTAssertThrowsError(try ScrollNumericOptions([flag: raw])) { error in
                XCTAssertEqual(error as? ScrollNumericError, .invalidValue(flag))
            }
        }
        for values in [["--pixels": "0"], ["--time": "31"], ["--repeat": "201"], ["--pause": "-1"],
                       ["--amount": String(Int.max)]] {
            XCTAssertThrowsError(try ScrollNumericOptions(values))
        }
    }

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
