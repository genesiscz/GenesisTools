import XCTest
@testable import SnapshotSupport

final class SnapshotSupportTests: XCTestCase {
    struct Refusal {
        let label: String
        let pid: Int32
        let launch: Double
        let digest: String
        let element: Int
        let now: Double
        let expectedMessage: String
    }

    /// Each refusal names the guard that must fire, so a wrong guard rejecting the input, or every
    /// case collapsing onto one guard after a refactor, fails with the offending label.
    func testEachRefusalComesFromTheGuardItTargets() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        let instance = "snapshot belongs to a different app instance; run see again"
        let expired = "snapshot expired; run see again"
        let outside = "element index outside snapshot"
        let changed = "UI changed; run see again"
        let refusals = [
            Refusal(label: "other pid", pid: 43, launch: 123, digest: "original", element: 2, now: 1001, expectedMessage: instance),
            Refusal(label: "other launch time", pid: 42, launch: 124, digest: "original", element: 2, now: 1001, expectedMessage: instance),
            Refusal(label: "121 s old", pid: 42, launch: 123, digest: "original", element: 2, now: 1121, expectedMessage: expired),
            Refusal(label: "created in the future", pid: 42, launch: 123, digest: "original", element: 2, now: 999, expectedMessage: expired),
            Refusal(label: "negative index", pid: 42, launch: 123, digest: "original", element: -1, now: 1001, expectedMessage: outside),
            Refusal(label: "index == count", pid: 42, launch: 123, digest: "original", element: 4, now: 1001, expectedMessage: outside),
            Refusal(label: "replaced window", pid: 42, launch: 123, digest: "replaced", element: 2, now: 1001, expectedMessage: changed),
        ]

        for refusal in refusals {
            XCTAssertThrowsError(
                try token.validate(pid: refusal.pid, launch: refusal.launch, digest: refusal.digest,
                                   element: refusal.element, count: 4, now: refusal.now),
                refusal.label
            ) { error in
                XCTAssertEqual((error as? SnapshotError)?.errorDescription, refusal.expectedMessage, refusal.label)
            }
        }
    }

    /// The guards are ordered, and the order is part of the contract: an input that would trip
    /// several of them must be refused by the earliest, so the caller learns the root cause first.
    func testGuardOrderIsInstanceThenExpiryThenIndexThenDigest() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        let cases: [(label: String, pid: Int32, now: Double, element: Int, digest: String, expected: String)] = [
            ("wrong instance beats expiry, index and digest", 43, 1121, 9, "replaced", "snapshot belongs to a different app instance; run see again"),
            ("expiry beats index and digest", 42, 1121, 9, "replaced", "snapshot expired; run see again"),
            ("index beats digest", 42, 1001, 9, "replaced", "element index outside snapshot"),
        ]

        for item in cases {
            XCTAssertThrowsError(
                try token.validate(pid: item.pid, launch: 123, digest: item.digest,
                                   element: item.element, count: 4, now: item.now),
                item.label
            ) { error in
                XCTAssertEqual((error as? SnapshotError)?.errorDescription, item.expected, item.label)
            }
        }
    }

    func testUnchangedSnapshotResolvesAnonymousElement() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        XCTAssertEqual(try token.validate(pid: 42, launch: 123, digest: "original",
                                          element: 2, count: 4, now: 1001), 2)
    }

    func testSnapshotRejectsReplacedWindowBeforeReturningElementIndex() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        XCTAssertThrowsError(try token.validate(pid: 42, launch: 123, digest: "replaced",
                                                element: 2, count: 4, now: 1001))
    }
}
