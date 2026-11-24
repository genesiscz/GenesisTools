import SnapshotSupport
import XCTest

final class ScreenshotPaceTests: XCTestCase {
    func testAFastScreenshotKeepsTheAskedInterval() {
        XCTAssertEqual(ScreenshotPace.interval(asked: 1, took: 0.05), 1)
        XCTAssertEqual(ScreenshotPace.interval(asked: 0.5, took: nil), 0.5)
        XCTAssertEqual(ScreenshotPace.interval(asked: 1, took: 0), 1)
        XCTAssertEqual(ScreenshotPace.interval(asked: 1, took: .infinity), 1)
    }

    func testASlowScreenshotStretchesTheIntervalToTenTimesItsLength() {
        // 0.8 s screenshots at 1 a second would keep the capture service busy 80% of the time; at 8 s it is 10%.
        XCTAssertEqual(ScreenshotPace.interval(asked: 1, took: 0.8), 8, accuracy: 1e-9)
        XCTAssertEqual(ScreenshotPace.interval(asked: 0.5, took: 0.25), 2.5, accuracy: 1e-9)
    }

    func testTheStretchStopsAtThirtySecondsButAnAskedLongerIntervalStays() {
        XCTAssertEqual(ScreenshotPace.interval(asked: 1, took: 12), 30)
        XCTAssertEqual(ScreenshotPace.interval(asked: 10, took: 0.8), 10)
        XCTAssertEqual(ScreenshotPace.interval(asked: 60, took: 12), 60)
    }

    func testTheReportNamesTheStretchInWholeSecondsAndNothingBelowHalfASecond() {
        XCTAssertEqual(ScreenshotPace.report(interval: 8.2, asked: 1, took: 0.82),
                       ScreenshotPaceReport(everySec: 8, screenshotSec: 0.82))
        XCTAssertNil(ScreenshotPace.report(interval: 1.3, asked: 1, took: 0.13).everySec)
        XCTAssertEqual(ScreenshotPace.report(interval: 1, asked: 0.5, took: 0.1).everySec, 1)
        XCTAssertNil(ScreenshotPace.report(interval: 10, asked: 10, took: 0.8).everySec)
    }

    func testTheRowCarriesTheStretchOnlyWhileThereIsOne() {
        let slow = ScreenshotPaceReport(everySec: 8, screenshotSec: 0.81234).row
        XCTAssertEqual(slow["everySec"] as? Int, 8)
        XCTAssertEqual(slow["screenshotSec"] as? Double, 0.812)
        XCTAssertNil(ScreenshotPaceReport(everySec: nil, screenshotSec: 0.1).row["everySec"])
    }
}
