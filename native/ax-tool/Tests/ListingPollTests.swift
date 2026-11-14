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
        // The 1 s budget less one 100 ms pause (`listingPause`).
        XCTAssertEqual(asked[1] ?? 0, 0.9, accuracy: 0.0001)
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

    func testARequestedExclusionThatStillExistsButIsNotListedIsUnresolved() {
        let open: Set<UInt32> = [7, 9]
        let unresolved = unresolvedExclusions(requested: [7, 8, 9, 11], listed: [8, 3], exists: { open.contains($0) })
        // 8 is listed, so the filter leaves it out; 11 is gone, so it cannot be filmed.
        XCTAssertEqual(unresolved, [7, 9])
        XCTAssertEqual(unresolvedExclusions(requested: [], listed: [], exists: { _ in true }), [])
    }

    func testAnExclusionMissingFromOneListingIsAskedForAgainBeforeARefusal() async throws {
        let clock = TestClock()
        var answers: [[UInt32]] = [[7], []]
        var asked = 0
        let listed = try await awaitExclusionsListed(
            timeout: 1,
            firstAnswer: 5,
            now: { clock.time },
            sleep: { clock.advance($0) },
            fetch: { () -> [UInt32] in
                asked += 1
                return answers.removeFirst()
            },
            unresolved: { $0 }
        )
        XCTAssertEqual(listed, [])
        XCTAssertEqual(asked, 2)
    }

    func testAnExclusionThatStaysUnlistedIsRefusedAtTheDeadlineWithItsWindows() async {
        let clock = TestClock()
        var asked = 0
        do {
            _ = try await awaitExclusionsListed(
                timeout: 1,
                firstAnswer: 5,
                now: { clock.time },
                sleep: { clock.advance($0) },
                fetch: { () -> [UInt32] in
                    asked += 1
                    return [7, 9]
                },
                unresolved: { $0 }
            )
            XCTFail("an exclusion that is never listed must be refused")
        } catch {
            XCTAssertEqual(error as? UnresolvedExclusions, UnresolvedExclusions(ids: [7, 9]))
            XCTAssertEqual(error.localizedDescription, "windows 7,9 must be left out of the movie but screen capture does not list them yet")
        }
        // A 1 s budget in 0.1 s pauses: the first ask and nine more. After the tenth pause no time is left, and a
        // retry with no budget would end at once, so it is not asked.
        XCTAssertEqual(asked, 10)
    }

    func testTheListingPollWaitsAtLeastAHundredMillisecondsBetweenAsks() throws {
        let clock = TestClock()
        var waits: [TimeInterval] = []
        _ = try pollListing(
            timeout: 1,
            now: { clock.time },
            wait: { waits.append($0); clock.advance($0) },
            fetch: { _ in 1 },
            isListed: { _ in false }
        )
        XCTAssertEqual(waits.first ?? 0, 0.1, accuracy: 1e-9, "the default pause is 100 ms, not 50")
        XCTAssertLessThanOrEqual(waits.count, 11, "a 1 s budget asks again about ten times, not twenty: \(waits)")
    }

    private static func stall() async throws -> [UInt32] {
        try await Task.sleep(nanoseconds: 30_000_000_000)
        return []
    }

    func testAFirstListingThatNeverAnswersEndsAtItsBudget() async {
        let started = Date()
        do {
            _ = try await awaitExclusionsListed(timeout: 1, firstAnswer: 0.2, sleep: { _ in }, fetch: Self.stall,
                                                unresolved: { $0 })
            XCTFail("a listing that never answers must not hold the switch")
        } catch {
            XCTAssertEqual(error as? ListingTimedOut, ListingTimedOut(seconds: 0.2))
        }
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
    }

    func testARetryThatNeverAnswersRefusesWithTheLastAnswersWindowsWithinTheDeadline() async {
        var asked = 0
        let started = Date()
        do {
            _ = try await awaitExclusionsListed(
                timeout: 0.4,
                firstAnswer: 5,
                sleep: { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
                fetch: { () -> [UInt32] in
                    asked += 1
                    return asked == 1 ? [7] : try await Self.stall()
                },
                unresolved: { $0 }
            )
            XCTFail("a stalled retry must end the wait")
        } catch {
            XCTAssertEqual(error as? UnresolvedExclusions, UnresolvedExclusions(ids: [7]))
        }
        XCTAssertEqual(asked, 2)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5, "the stalled retry had only the time left")
    }

    func testABoundedAnswerThatArrivesInTimeIsReturned() async throws {
        let value = try await answer(within: 5) { 42 }
        XCTAssertEqual(value, 42)
        do {
            _ = try await answer(within: 5) { () -> Int in throw Stalled() }
            XCTFail("the operation's own error is thrown")
        } catch {
            XCTAssertTrue(error is Stalled)
        }
    }

    func testAnExpiredSwitchCannotAdoptItsDisplayLate() {
        let owner = LiveSwitchOwner()
        let first = owner.begin()
        XCTAssertTrue(owner.owns(first))
        XCTAssertTrue(owner.end(first), "the deadline ends the switch first")
        XCTAssertFalse(owner.end(first), "its late completion finds it ended and adopts nothing")
        XCTAssertFalse(owner.owns(first))
        XCTAssertTrue(owner.isLatest(first), "no newer switch: the late one undoes its own changes")

        let second = owner.begin()
        XCTAssertFalse(owner.isLatest(first), "a newer switch owns the stream: the late one leaves it alone")
        XCTAssertTrue(owner.end(second))
    }
}
