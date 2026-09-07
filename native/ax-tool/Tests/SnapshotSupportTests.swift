import XCTest
@testable import SnapshotSupport

final class SnapshotSupportTests: XCTestCase {
    struct Refusal {
        let label: String
        let pid: Int32
        let launch: Double
        let window: Int
        let digest: String
        let element: Int
        let now: Double
        let expectedMessage: String
    }

    static let instance = "snapshot belongs to a different app instance; run see again"
    static let otherWindow = "snapshot belongs to a different window; run see again"
    static let expired = "snapshot expired; run see again"
    static let outside = "element index outside snapshot"
    static let changed = "UI changed; run see again"

    /// Each refusal names the guard that must fire, so a wrong guard rejecting the input, or every
    /// case collapsing onto one guard after a refactor, fails with the offending label.
    func testEachRefusalComesFromTheGuardItTargets() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        let refusals = [
            Refusal(label: "other pid", pid: 43, launch: 123, window: 1, digest: "original", element: 2, now: 1001, expectedMessage: Self.instance),
            Refusal(label: "other launch time", pid: 42, launch: 124, window: 1, digest: "original", element: 2, now: 1001, expectedMessage: Self.instance),
            Refusal(label: "other window", pid: 42, launch: 123, window: 2, digest: "original", element: 2, now: 1001, expectedMessage: Self.otherWindow),
            Refusal(label: "121 s old", pid: 42, launch: 123, window: 1, digest: "original", element: 2, now: 1121, expectedMessage: Self.expired),
            Refusal(label: "created in the future", pid: 42, launch: 123, window: 1, digest: "original", element: 2, now: 999, expectedMessage: Self.expired),
            Refusal(label: "negative index", pid: 42, launch: 123, window: 1, digest: "original", element: -1, now: 1001, expectedMessage: Self.outside),
            Refusal(label: "index == count", pid: 42, launch: 123, window: 1, digest: "original", element: 4, now: 1001, expectedMessage: Self.outside),
            Refusal(label: "changed tree", pid: 42, launch: 123, window: 1, digest: "replaced", element: 2, now: 1001, expectedMessage: Self.changed),
        ]

        for refusal in refusals {
            XCTAssertThrowsError(
                try token.validate(pid: refusal.pid, launch: refusal.launch, window: refusal.window, digest: refusal.digest,
                                   element: refusal.element, count: 4, now: refusal.now),
                refusal.label
            ) { error in
                XCTAssertEqual((error as? SnapshotError)?.errorDescription, refusal.expectedMessage, refusal.label)
            }
        }
    }

    /// The guards are ordered, and the order is part of the contract: an input that would trip
    /// several of them must be refused by the earliest, so the caller learns the root cause first.
    func testGuardOrderIsInstanceThenWindowThenExpiryThenIndexThenDigest() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        let cases: [(label: String, pid: Int32, window: Int, now: Double, element: Int, digest: String, expected: String)] = [
            ("wrong instance beats window, expiry, index and digest", 43, 2, 1121, 9, "replaced", Self.instance),
            ("wrong window beats expiry, index and digest", 42, 2, 1121, 9, "replaced", Self.otherWindow),
            ("expiry beats index and digest", 42, 1, 1121, 9, "replaced", Self.expired),
            ("index beats digest", 42, 1, 1001, 9, "replaced", Self.outside),
        ]

        for item in cases {
            XCTAssertThrowsError(
                try token.validate(pid: item.pid, launch: 123, window: item.window, digest: item.digest,
                                   element: item.element, count: 4, now: item.now),
                item.label
            ) { error in
                XCTAssertEqual((error as? SnapshotError)?.errorDescription, item.expected, item.label)
            }
        }
    }

    /// A token whose own metadata is invalid (window 0 here) authorizes nothing, whatever the caller
    /// supplies: the metadata guard runs before every other guard.
    func testInvalidWindowIdentityCannotAuthorizeAnAction() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 0, depth: 20,
                                  digest: "original", created: 1000)
        let metadata = "invalid snapshot metadata; run see again"
        XCTAssertThrowsError(try token.validate(pid: 42, launch: 123, window: 1, digest: "original",
                                                element: 2, count: 4, now: 1001)) { error in
            XCTAssertEqual((error as? SnapshotError)?.errorDescription, metadata)
        }
        XCTAssertThrowsError(try token.validate(pid: 43, launch: 124, window: 0, digest: "replaced",
                                                element: 9, count: 4, now: 1121), "metadata beats every later guard") { error in
            XCTAssertEqual((error as? SnapshotError)?.errorDescription, metadata)
        }
    }

    func testWindowEventCoordinatesUseTopLeftOnNegativeOriginDisplays() {
        let bounds = CGRect(x: -200, y: -400, width: 500, height: 452)
        XCTAssertEqual(snapshotWindowPoint(CGPoint(x: -115, y: -279), in: bounds), CGPoint(x: 85, y: 121))
    }

    func testAChangedControlValueInvalidatesTheObservation() throws {
        let before: [[String: Any]] = [["index": 1, "AXValue": "seed"]]
        let after: [[String: Any]] = [["index": 1, "AXValue": "changed"]]
        XCTAssertNotEqual(try snapshotDigest(before), try snapshotDigest(after))
    }

    func testOpaqueAXObjectsDoNotLeakAddressesIntoTheDigest() {
        XCTAssertNil(snapshotValue(NSObject()))
        XCTAssertEqual(snapshotValue("Příliš žluťoučký 🐈"), "Příliš žluťoučký 🐈")
        XCTAssertEqual(snapshotValue(NSNumber(value: true)), "1")
        XCTAssertEqual(snapshotValue(NSAttributedString(string: "visible text")), "visible text")
        XCTAssertNil(snapshotValue(NSNumber(value: Double.nan)))
    }

    func testClientLocalHashesDoNotInvalidateTheSameObservedControl() throws {
        let first: [[String: Any]] = [["index": 0, "role": "AXButton", "AXTitle": "Increment", "identity": 123]]
        let second: [[String: Any]] = [["index": 0, "role": "AXButton", "AXTitle": "Increment", "identity": 987]]
        XCTAssertEqual(try snapshotDigest(first), try snapshotDigest(second))
    }
    func testUnchangedSnapshotResolvesAnonymousElement() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        XCTAssertEqual(try token.validate(pid: 42, launch: 123, window: 1, digest: "original",
                                          element: 2, count: 4, now: 1001), 2)
    }

    func testSnapshotRejectsReplacedWindowBeforeReturningElementIndex() throws {
        let token = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20,
                                  digest: "original", created: 1000)
        XCTAssertThrowsError(try token.validate(pid: 42, launch: 123, window: 1, digest: "replaced",
                                                element: 2, count: 4, now: 1001))
    }
}
