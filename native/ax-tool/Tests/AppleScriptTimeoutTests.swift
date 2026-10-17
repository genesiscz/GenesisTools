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

    func testSecondsNeverExceedTheRemainingBudget() {
        let now = Date()

        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(2.2), now: now), 2)
        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(5), now: now), 5)
    }

    func testSubsecondAndSpentBudgetsHaveNoWholeSeconds() {
        let now = Date()

        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(0.01), now: now), 0)
        XCTAssertEqual(AppleScriptTimeout.seconds(until: now, now: now), 0)
        XCTAssertEqual(AppleScriptTimeout.seconds(until: now.addingTimeInterval(-3), now: now), 0)
    }

    func testSubsecondBudgetSkipsExecution() {
        let now = Date()
        var called = false
        let result = AppleScriptTimeout.run("return 1", deadline: now.addingTimeInterval(0.2), now: now) { _ in
            called = true
            return "1"
        }

        XCTAssertNil(result)
        XCTAssertFalse(called)
    }

    func testFiniteBudgetExecutesWithOnlyTheWholeSecondsRemaining() {
        let now = Date()
        var executed: String?
        let result = AppleScriptTimeout.run("return 1", deadline: now.addingTimeInterval(2.2), now: now) { source in
            executed = source
            return "1"
        }

        XCTAssertEqual(result, "1")
        XCTAssertEqual(executed, "with timeout of 2 seconds\nreturn 1\nend timeout")
    }

    func testUnboundedExecutionKeepsTheSource() {
        let result = AppleScriptTimeout.run("return 1", deadline: Date().addingTimeInterval(.infinity)) { source in
            XCTAssertEqual(source, "return 1")
            return "1"
        }

        XCTAssertEqual(result, "1")
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
