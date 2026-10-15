import Foundation
import XCTest
@testable import SnapshotSupport

final class AppleScriptTimeoutTests: XCTestCase {
    func testWrapPutsTheSourceInsideATimeoutBlock() {
        XCTAssertEqual(
            AppleScriptTimeout.wrap("return 1", seconds: 3),
            "with timeout of 3 seconds\nreturn 1\nend timeout"
        )
    }

    func testWrapNeverAsksForLessThanOneSecond() {
        XCTAssertTrue(AppleScriptTimeout.wrap("return 1", seconds: 0).hasPrefix("with timeout of 1 seconds"))
        XCTAssertTrue(AppleScriptTimeout.wrap("return 1", seconds: -4).hasPrefix("with timeout of 1 seconds"))
    }

    func testSecondsRoundUpToWholeSeconds() {
        let now = Date()

        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(2.2), now: now), 3)
        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(5), now: now), 5)
    }

    func testSecondsStayAtOneWhenTheDeadlineIsAlmostHere() {
        let now = Date()

        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(0.01), now: now), 1)
        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(-3), now: now), 1)
    }

    func testNoFiniteDeadlineMeansNoTimeout() {
        XCTAssertNil(AppleScriptTimeout.seconds(until: Date().addingTimeInterval(.infinity)))
    }

    func testAWrappedScriptStillRuns() {
        var error: NSDictionary?
        let script = NSAppleScript(source: AppleScriptTimeout.wrap("return \"ok\"", seconds: 2))
        let result = script?.executeAndReturnError(&error)

        XCTAssertNil(error)
        XCTAssertEqual(result?.stringValue, "ok")
    }
}
