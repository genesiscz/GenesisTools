import Foundation
import XCTest
@testable import SnapshotSupport

private struct Stalled: LocalizedError {
    var errorDescription: String? { "screen capture did not answer within 0s" }
}

/// A clock the test moves: `wait` and a stalled retry advance it, nothing sleeps.
private final class TestClock {
    var time = Date(timeIntervalSince1970: 0)
    func advance(_ seconds: TimeInterval) { time = time.addingTimeInterval(seconds) }
}

final class ListingPollTests: XCTestCase {
    func testARetryThatStallsKeepsTheLastAnswerAndHasOnlyTheTimeLeft() throws {
        let clock = TestClock()
        var asked: [TimeInterval?] = []
        let polled = try pollListing(
            timeout: 1,
            now: { clock.time },
            wait: { clock.advance($0) },
            fetch: { remaining -> Int in
                asked.append(remaining)
                if remaining == nil { return 1 }
                clock.advance(remaining ?? 0)
                throw Stalled()
            },
            isListed: { $0 == 2 }
        )
        XCTAssertEqual(polled.value, 1)
        XCTAssertEqual(polled.end, .retryFailed("screen capture did not answer within 0s"))
        XCTAssertNil(asked[0])
        XCTAssertEqual(asked[1] ?? 0, 0.95, accuracy: 0.0001)
    }

    func testTheFirstAskStillThrowsWhenThereIsNoAnswerYet() {
        XCTAssertThrowsError(
            try pollListing(timeout: 1, wait: { _ in }, fetch: { _ -> Int in throw Stalled() }, isListed: { _ in true })
        )
    }

    func testAListedAnswerEndsThePollAndTheDeadlineKeepsAnUnlistedOne() throws {
        let clock = TestClock()
        var answers = [1, 2]
        let listed = try pollListing(
            timeout: 1,
            now: { clock.time },
            wait: { clock.advance($0) },
            fetch: { _ in answers.removeFirst() },
            isListed: { $0 == 2 }
        )
        XCTAssertEqual(listed.value, 2)
        XCTAssertEqual(listed.end, .listed)

        let unlisted = try pollListing(
            timeout: 0.2,
            now: { clock.time },
            wait: { clock.advance($0) },
            fetch: { _ in 1 },
            isListed: { _ in false }
        )
        XCTAssertEqual(unlisted.value, 1)
        XCTAssertEqual(unlisted.end, .deadline)
    }
}
