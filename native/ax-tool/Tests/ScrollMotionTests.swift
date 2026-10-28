import XCTest
@testable import SnapshotSupport

final class ScrollMotionTests: XCTestCase {
    func testTimedDispatchHonorsDurationAndDeadline() throws {
        let interval = ScrollMotion.interval(seconds: 1, count: 5)
        XCTAssertEqual(interval, 0.25)
        var now = 0.0
        var posted: [Int] = []
        var cancellations = 0
        try ScrollMotion.dispatch(count: 5, interval: interval, remaining: { 2 - now }, sleep: { now += $0 }, cancel: { cancellations += 1 }) { posted.append($0) }
        XCTAssertEqual(now, 1, accuracy: 0.0001)
        XCTAssertEqual(posted, [0, 1, 2, 3, 4])
        XCTAssertEqual(cancellations, 0)
        now = 0
        posted = []
        XCTAssertThrowsError(try ScrollMotion.dispatch(count: 5, interval: interval, remaining: { 0.5 - now }, sleep: { now += $0 }, cancel: { cancellations += 1 }) { posted.append($0) }) { error in
            XCTAssertTrue((error as? ScrollMotion.DeadlineExceeded)?.dispatched == true)
        }
        XCTAssertEqual(posted, [0, 1])
        XCTAssertEqual(cancellations, 1)
        XCTAssertEqual(now, 0.5, accuracy: 0.0001)
        posted = []
        XCTAssertThrowsError(try ScrollMotion.dispatch(count: 1, interval: 0, remaining: { 0 }, sleep: { _ in }, cancel: { cancellations += 1 }) { posted.append($0) }) { error in
            XCTAssertTrue((error as? ScrollMotion.DeadlineExceeded)?.dispatched == false)
        }
        XCTAssertTrue(posted.isEmpty)
        XCTAssertEqual(cancellations, 1)
    }
    func testAnInterruptedScrollClosesItsGesture() {
        var now = 0.0
        var phases: [Int64] = []
        XCTAssertThrowsError(try ScrollMotion.dispatch(count: 5, interval: 0.25,
            remaining: { 0.5 - now }, sleep: { now += $0 }, cancel: { phases.append(8) }) { index in
            phases.append(ScrollMotion.phase(index: index, count: 5))
        })
        XCTAssertEqual(phases, [1, 2, 8], "a partially sent gesture ends with cancellation")
    }

    func testTakeoverStillClosesTheScrollGesture() {
        var taken = false
        var phases: [Int64] = []
        let gate = SyntheticInputGate(tookOver: { taken })
        XCTAssertThrowsError(try ScrollMotion.dispatch(count: 3, interval: 0.1,
            remaining: { nil }, sleep: { _ in }, cancel: {
                gate.deliver { phases.append(8) }
            }) { index in
                try gate.post {
                    phases.append(ScrollMotion.phase(index: index, count: 3))
                    taken = true
                }
            }) { error in
                XCTAssertTrue((error as? UserTakeoverError)?.dispatched == true)
            }
        XCTAssertEqual(phases, [1, 8])
        XCTAssertEqual(gate.posted, 2)
    }

    func testNumericDefaultsApplyOnlyWhenOptionsAreAbsent() throws {
        let defaults = try ScrollNumericOptions([:])
        XCTAssertEqual(defaults.pixels, 120)
        XCTAssertEqual(defaults.amount, 3)
        // Animated by default: 120 px over the shortest default time; `--time 0` is the old single event.
        XCTAssertEqual(defaults.seconds, 0.25)
        XCTAssertEqual(try ScrollNumericOptions(["--pixels": "1500"]).seconds, 0.5)
        XCTAssertEqual(try ScrollNumericOptions(["--pixels": "20000"]).seconds, 1)
        XCTAssertNil(try ScrollNumericOptions(["--time": "0"]).seconds)
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
                       ["--amount": String(Int.max)], ["--amount": "0", "--pixels": "200"]] {
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
