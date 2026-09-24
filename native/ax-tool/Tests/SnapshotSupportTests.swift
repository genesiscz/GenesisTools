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

    /// The remaining metadata guards, each with a caller that would otherwise be authorized.
    /// They protect against a future relaxation rather than a reachable bypass today.
    func testMalformedTokenMetadataIsRefusedBeforeEveryOtherGuard() throws {
        let metadata = "invalid snapshot metadata; run see again"
        let cases: [(label: String, token: SnapshotToken)] = [
            ("depth 0", SnapshotToken(pid: 42, launch: 123, window: 1, depth: 0, digest: "original", created: 1000)),
            ("depth 51", SnapshotToken(pid: 42, launch: 123, window: 1, depth: 51, digest: "original", created: 1000)),
            ("empty digest", SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20, digest: "", created: 1000)),
            ("unsupported scope", SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20, digest: "original",
                                                created: 1000, scope: "web")),
        ]

        for item in cases {
            XCTAssertThrowsError(
                try item.token.validate(pid: 42, launch: 123, window: 1, digest: "original",
                                        element: 2, count: 4, now: 1001),
                item.label
            ) { error in
                XCTAssertEqual((error as? SnapshotError)?.errorDescription, metadata, item.label)
            }
        }

        // The negative control: the same caller against a well-formed token is authorized,
        // so the guard above cannot pass by refusing everything.
        let valid = SnapshotToken(pid: 42, launch: 123, window: 1, depth: 20, digest: "original", created: 1000)
        XCTAssertEqual(try valid.validate(pid: 42, launch: 123, window: 1, digest: "original",
                                          element: 2, count: 4, now: 1001), 2)
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

extension SnapshotSupportTests {
    func testMenuTokensRefuseForeignExpiredDisabledAndUnfocusedDispatchBeforeThePrimitive() throws {
        let token = MenuSnapshotToken(pid:42,launch:123,depth:40,digest:"menu-tree",created:1000)
        var calls = 0
        func attempt(pid: Int32 = 42, launch: Double = 123, digest: String = "menu-tree",
                     index: Int = 1, now: Double = 1001, frontmost: Bool = true, enabled: Bool = true) throws {
            try dispatchMenuAction(token:token,pid:pid,launch:launch,digest:digest,element:index,count:3,now:now,
                frontmost:frontmost,enabled:enabled) { calls += 1 }
        }
        XCTAssertThrowsError(try attempt(pid:43))
        XCTAssertThrowsError(try attempt(launch:124))
        XCTAssertThrowsError(try attempt(digest:"changed"))
        XCTAssertThrowsError(try attempt(index:3))
        XCTAssertThrowsError(try attempt(now:1031))
        XCTAssertThrowsError(try attempt(now:999))
        XCTAssertThrowsError(try attempt(frontmost:false))
        XCTAssertThrowsError(try attempt(enabled:false))
        XCTAssertEqual(calls,0)
        try attempt()
        XCTAssertEqual(calls,1)
        let window = SnapshotToken(pid:42,launch:123,window:7,depth:40,digest:"menu-tree",created:1000)
        XCTAssertThrowsError(try JSONDecoder().decode(MenuSnapshotToken.self,from:JSONEncoder().encode(window)))
        let foreign = try JSONDecoder().decode(MenuSnapshotToken.self,from:Data(#"{"version":1,"surface":"window","pid":42,"launch":123,"depth":40,"digest":"menu-tree","created":1000}"#.utf8))
        XCTAssertThrowsError(try foreign.validate(pid:42,launch:123,digest:"menu-tree",element:1,count:3,now:1001))
    }
}

final class CursorFeedbackGateTests: XCTestCase {
    func testNoActivateSwitchesTheOverlayOff() {
        // 🛑 This is the regression test for the no-focus-steal requirement. Showing the overlay
        // activates this process, so feedback during a --no-activate act took the focus the caller
        // explicitly asked to keep. Measured: cmux -> ax-tool with feedback, cmux -> cmux without.
        XCTAssertFalse(cursorFeedbackEnabled(arguments: ["ax-tool", "act", "--no-activate"], environment: [:]))
    }

    func testNoCursorAndTheEnvironmentSwitchStillWork() {
        XCTAssertFalse(cursorFeedbackEnabled(arguments: ["ax-tool", "act", "--no-cursor"], environment: [:]))
        XCTAssertFalse(cursorFeedbackEnabled(arguments: ["ax-tool", "act"],
                                             environment: ["GENESIS_CONTROL_CURSOR": "off"]))
    }

    // The other half: an ordinary act must still show feedback, or a guard that disabled
    // everything would pass the cases above while silently removing the visible proof of input.
    func testAnOrdinaryActStillShowsFeedback() {
        XCTAssertTrue(cursorFeedbackEnabled(arguments: ["ax-tool", "act", "--action", "press"], environment: [:]))
        XCTAssertTrue(cursorFeedbackEnabled(arguments: ["ax-tool", "act"],
                                            environment: ["GENESIS_CONTROL_CURSOR": "on"]))
    }
}

final class StableKeyTests: XCTestCase {
    private func row(_ identifier: String?, role: String = "AXStaticText", value: String = "") -> [String: Any] {
        var row: [String: Any] = ["role": role, "AXValue": value]
        if let identifier { row["AXIdentifier"] = identifier }
        return row
    }

    func testTwoIdentifiersNeverShareAKey() throws {
        // The bug this caught: 14 rows with distinct identifiers hashed to ONE value.
        let phase = try snapshotStableKey(row("focus-hud-phase"))
        let timer = try snapshotStableKey(row("focus-hud-timer"))

        XCTAssertNotNil(phase)
        XCTAssertNotEqual(phase, timer)
    }

    func testAPayloadNamedIdentityWouldBeStripped() throws {
        // 🛑 The cause, pinned so it cannot come back: snapshotDigest DELETES a key called
        // "identity", because an AX wrapper hash belongs to a client connection rather than to the
        // observed UI. Anything hashed under that name silently vanishes.
        let kept = try snapshotDigest([["target": ["a": "1"]]])
        let kept2 = try snapshotDigest([["target": ["a": "2"]]])
        let stripped = try snapshotDigest([["identity": ["a": "1"]]])
        let stripped2 = try snapshotDigest([["identity": ["a": "2"]]])

        XCTAssertNotEqual(kept, kept2, "a payload under any other name must affect the digest")
        XCTAssertEqual(stripped, stripped2, "a payload named identity is dropped — do not hash under it")
    }

    func testTheValueIsIgnoredSoAClockCannotMoveTheKey() throws {
        // The whole point: the element's own changing text must not rewrite its identity.
        let before = try snapshotStableKey(row("focus-hud-timer", value: "13:29"))
        let after = try snapshotStableKey(row("focus-hud-timer", value: "13:28"))

        XCTAssertEqual(before, after)
    }

    func testAnElementWithoutAnIdentifierGetsNoStableKey() throws {
        XCTAssertNil(try snapshotStableKey(row(nil)))
        XCTAssertNil(try snapshotStableKey(row("")))
    }

    func testASharedIdentifierIsDemotedBackToTheRicherKey() {
        // An identifier four rows share cannot identify any of them, and keeping it would turn a
        // previously actionable row into a permanent "ambiguous" refusal.
        var rows: [[String: Any]] = [
            ["AXIdentifier": "mix", "stableKey": "shared", "targetKey": "rich-a"],
            ["AXIdentifier": "mix", "stableKey": "shared", "targetKey": "rich-b"],
            ["AXIdentifier": "primary", "stableKey": "unique", "targetKey": "rich-c"],
        ]
        demoteSharedStableKeys(&rows)

        XCTAssertEqual(rows[0]["stableKey"] as? String, "rich-a")
        XCTAssertEqual(rows[1]["stableKey"] as? String, "rich-b")
        XCTAssertEqual(rows[2]["stableKey"] as? String, "unique", "a unique identifier keeps its key")
    }

    func testAStableKeyStillSharedAfterBindingFallsBackToTheFinalTargetKey() {
        // Two unlabeled "Delete" buttons with no identifier: the same pre-binding key, and
        // targetKeys the sibling-text binder has already told apart.
        var rows: [[String: Any]] = [
            ["role": "AXButton", "stableKey": "delete", "targetKey": "delete-in-row-1"],
            ["role": "AXButton", "stableKey": "delete", "targetKey": "delete-in-row-2"],
            ["role": "AXButton", "stableKey": "save", "targetKey": "save-bound"],
        ]
        promoteSharedStableKeys(&rows)

        XCTAssertEqual(rows[0]["stableKey"] as? String, "delete-in-row-1")
        XCTAssertEqual(rows[1]["stableKey"] as? String, "delete-in-row-2")
        XCTAssertEqual(rows[2]["stableKey"] as? String, "save", "a unique stable key is kept")
    }
}
