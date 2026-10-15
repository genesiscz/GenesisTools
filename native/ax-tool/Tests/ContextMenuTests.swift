import ApplicationServices
import CoreGraphics
import Foundation
import XCTest
@testable import SnapshotSupport

/// Elements keyed by a fake pid: `AXUIElementCreateApplication` builds a real, hashable handle
/// without touching the AX server.
private final class MenuTreeSource: HierarchySource {
    var roles: [pid_t: String] = [:]
    var children: [pid_t: [pid_t]] = [:]
    var failing: Set<pid_t> = []

    func element(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

    func pid(_ element: AXUIElement) -> pid_t {
        var value: pid_t = 0
        AXUIElementGetPid(element, &value)
        return value
    }

    func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        name == "AXRole" ? roles[pid(element)] : nil
    }

    func children(of element: AXUIElement) throws -> [AXUIElement] {
        if failing.contains(pid(element)) {
            throw ObservedTreeError("read failed")
        }

        return (children[pid(element)] ?? []).map { AXUIElementCreateApplication($0) }
    }

    func actionNames(of element: AXUIElement) -> [String] { [] }
    func isValueSettable(_ element: AXUIElement) -> Bool? { nil }
}

final class ContextMenuWindowTests: XCTestCase {
    private func window(_ id: Int, pid: Int32, layer: Int) -> [String: Any] {
        [kCGWindowNumber as String: NSNumber(value: id), kCGWindowOwnerPID as String: NSNumber(value: pid),
         kCGWindowLayer as String: NSNumber(value: layer)]
    }

    func testOnlyTheAppsOwnMenuLayerWindowsCount() {
        let windows = [window(1, pid: 42, layer: 0), window(2, pid: 42, layer: 101), window(3, pid: 7, layer: 101),
                       window(4, pid: 42, layer: 25)]

        XCTAssertEqual(menuWindowIDs(in: windows, pid: 42), [2])
    }

    // 🛑 A menu that was already open before the click must not answer for the click.
    func testOnlyANewMenuWindowMeansAMenuOpened() {
        XCTAssertTrue(menuWindowAppeared(before: [], after: [5]))
        XCTAssertTrue(menuWindowAppeared(before: [5], after: [5, 9]))
        XCTAssertFalse(menuWindowAppeared(before: [5], after: [5]))
        XCTAssertFalse(menuWindowAppeared(before: [5], after: []))
    }

    func testTheNoMenuErrorSaysTheEventWasDeliveredAndThePointerStayed() {
        let message = contextMenuNotSeenMessage(delivery: "window-event")

        XCTAssertTrue(message.contains("window-event"))
        XCTAssertTrue(message.contains("no context menu was seen"))
        XCTAssertTrue(message.contains("pointer was not moved"))
    }
}

final class ShowContextMenuTests: XCTestCase {
    // 🛑 The regression: AXShowMenu blocks for as long as the menu tracks. Waiting for it reported an
    // open menu as "did not return within 2.0 s (AX -25204)". The call here blocks for 3 s, like a menu
    // the user has not closed yet, and the outcome must come from the observation, at once.
    func testABlockingShowMenuIsJudgedByTheMenuNotByTheCall() {
        let started = Date()
        let outcome = showContextMenu(perform: {
            Thread.sleep(forTimeInterval: 3)
            return .cannotComplete
        }, returnWaitMs: 100, menuAppeared: { true })

        XCTAssertEqual(outcome, .opened)
        XCTAssertLessThan(Date().timeIntervalSince(started), 1.5)
    }

    func testNoMenuSeenIsUncertainEvenWhenTheCallSucceeded() {
        XCTAssertEqual(showContextMenu(perform: { .success }, returnWaitMs: 100, menuAppeared: { false }), .notSeen)
    }

    func testAnEarlyErrorMeansNothingOpened() {
        var looked = false
        let outcome = showContextMenu(perform: { .actionUnsupported }, returnWaitMs: 500, menuAppeared: {
            looked = true
            return true
        })

        XCTAssertEqual(outcome, .failed(AXError.actionUnsupported.rawValue))
        XCTAssertFalse(looked)
    }

    // -25204 is the AX messaging timeout: the request outlived it because the menu is tracking.
    func testAMessagingTimeoutIsNotAFailure() {
        XCTAssertEqual(showContextMenu(perform: { .cannotComplete }, returnWaitMs: 500, menuAppeared: { true }), .opened)
    }
}

final class OpenContextMenuSearchTests: XCTestCase {
    private func source() -> MenuTreeSource {
        let source = MenuTreeSource()
        // app 1 -> window 2 -> group 3 -> [text 4, menu 5 -> item 6]; app 1 -> menu bar 7 -> bar menu 8
        source.roles = [1: "AXApplication", 2: "AXWindow", 3: "AXGroup", 4: "AXStaticText", 5: "AXMenu",
                        6: "AXMenuItem", 7: "AXMenuBar", 8: "AXMenu"]
        source.children = [1: [7, 2], 2: [3], 3: [4, 5], 5: [6], 7: [8]]
        return source
    }

    // SwiftUI nests a context menu inside the view that owns it, not among the app's children.
    func testAMenuNestedInAWindowIsFound() {
        let source = source()
        let found = findOpenContextMenu(app: source.element(1), source: source)

        XCTAssertEqual(found.map(source.pid), 5)
    }

    // 🛑 The menu bar's own menus are the bar path's; a context menu read must never return one.
    func testTheMenuBarIsNeverEntered() {
        let source = source()
        source.children[3] = [4]

        XCTAssertNil(findOpenContextMenu(app: source.element(1), source: source))
    }

    func testAnAppLevelMenuIsFound() {
        let source = source()
        source.roles[9] = "AXMenu"
        source.children[1] = [7, 9, 2]

        XCTAssertEqual(findOpenContextMenu(app: source.element(1), source: source).map(source.pid), 9)
    }

    func testAnUnreadableSubtreeDoesNotHideAMenuElsewhere() {
        let source = source()
        source.roles[10] = "AXWindow"
        source.children[1] = [7, 10, 2]
        source.failing = [10]

        XCTAssertEqual(findOpenContextMenu(app: source.element(1), source: source).map(source.pid), 5)
    }

    func testTheWalkIsBounded() {
        let source = source()

        XCTAssertNil(findOpenContextMenu(app: source.element(1), source: source, limit: 3))
    }
}

final class ContextMenuTokenTests: XCTestCase {
    func testAContextMenuTokenRoundTrips() throws {
        let token = MenuSnapshotToken(pid: 4, launch: 1, depth: 40, digest: "d", created: 1, contextMenu: true)
        let decoded = try JSONDecoder().decode(MenuSnapshotToken.self, from: JSONEncoder().encode(token))

        XCTAssertEqual(decoded.contextMenu, true)
    }

    // A token minted before the field existed must keep reading as a menu-bar token.
    func testAnOlderTokenReadsAsTheMenuBar() throws {
        let json = #"{"version":1,"surface":"menu","pid":4,"launch":1,"depth":40,"digest":"d","created":1}"#
        let decoded = try JSONDecoder().decode(MenuSnapshotToken.self, from: Data(json.utf8))

        XCTAssertNil(decoded.contextMenu)

        let bar = try JSONEncoder().encode(MenuSnapshotToken(pid: 4, launch: 1, depth: 40, digest: "d", created: 1))
        let fields = try XCTUnwrap(JSONSerialization.jsonObject(with: bar) as? [String: Any])
        XCTAssertNil(fields["contextMenu"])
    }

    // The menu is already tracking, and the right-click that opened it never activated the app.
    func testPressingAnOpenContextMenuItemNeedsNothingInFront() throws {
        XCTAssertFalse(menuActionRequiresFrontmost("AXPress", contextMenu: true))
        XCTAssertTrue(menuActionRequiresFrontmost("AXPress"))

        let token = MenuSnapshotToken(pid: 4, launch: 1, depth: 40, digest: "d", created: 1, contextMenu: true)
        let pressed = try dispatchMenuAction(token: token, pid: 4, launch: 1, digest: "d", element: 0, count: 2, now: 2,
                                             frontmost: false, enabled: true, action: { true })
        XCTAssertTrue(pressed)
    }

    func testAMenuBarPressStillNeedsTheAppInFront() {
        let token = MenuSnapshotToken(pid: 4, launch: 1, depth: 40, digest: "d", created: 1)

        XCTAssertThrowsError(try dispatchMenuAction(token: token, pid: 4, launch: 1, digest: "d", element: 0, count: 2,
                                                    now: 2, frontmost: false, enabled: true, action: { true }))
    }
}

final class CoordinateStaleRefusalTests: XCTestCase {
    func testAChangedTreeNamesTheWindowKeyToPass() {
        let error = coordinateStaleRefusal(SnapshotError.refusal(.staleObservation, SnapshotToken.changedMessage),
                                           windowStableKey: "abc123")

        XCTAssertEqual((error as? SnapshotError)?.category, .staleObservation)
        XCTAssertTrue(error.localizedDescription.contains("--target-key abc123"))
        XCTAssertTrue(error.localizedDescription.contains("--revalidate-scope element"))
    }

    func testWithoutAKeyItSaysWhereToFindOne() {
        let error = coordinateStaleRefusal(SnapshotError.refusal(.staleObservation, SnapshotToken.changedMessage),
                                           windowStableKey: nil)

        XCTAssertTrue(error.localizedDescription.contains("--target-key <the window row's stableKey from see>"))
    }

    // An expired token is not cured by a key: only the changed-tree refusal is rewritten.
    func testOtherRefusalsAreLeftAlone() {
        let expired = SnapshotError.refusal(.staleObservation, "snapshot expired; run see again")
        let scope = SnapshotError.refusal(.scopeChanged, SnapshotToken.changedMessage)

        XCTAssertEqual(coordinateStaleRefusal(expired, windowStableKey: "k").localizedDescription, expired.localizedDescription)
        XCTAssertEqual((coordinateStaleRefusal(scope, windowStableKey: "k") as? SnapshotError)?.category, .scopeChanged)
    }

    func testTheTokenRefusesAChangedTreeWithTheMessageTheRewriteMatches() {
        let token = SnapshotToken(pid: 4, launch: 1, window: 9, depth: 5, digest: "old", created: 1)

        XCTAssertThrowsError(try token.validate(pid: 4, launch: 1, window: 9, digest: "new", element: 0, count: 1, now: 2)) {
            XCTAssertEqual($0.localizedDescription, SnapshotToken.changedMessage)
        }
    }
}

final class ObservationDriftTests: XCTestCase {
    private func text(_ width: Int, x: Int = 10, value: String = "saved 3 min ago") -> [String: Any] {
        ["role": "AXStaticText", "AXValue": value, "x": x, "y": 40, "width": width, "height": 16, "targetKey": "t"]
    }

    private let window: [String: Any] = ["role": "AXWindow", "x": 0, "y": 0, "width": 400, "height": 300]

    // 🛑 The regression: a status label re-laid itself out between the two reads around the screenshot,
    // and the whole see was refused with "UI changed during observation".
    func testAStaticTextWidthChangeIsTolerated() {
        let changes = toleratedObservationDrift(before: [window, text(99)], after: [window, text(129)])

        XCTAssertEqual(changes?.count, 1)
        XCTAssertEqual(changes?.first?["index"] as? Int, 1)
        XCTAssertEqual(changes?.first?["fields"] as? [String], ["width"])
    }

    func testATrailingLabelMayMoveItsXWithItsWidth() {
        XCTAssertNotNil(toleratedObservationDrift(before: [window, text(99, x: 300)], after: [window, text(129, x: 270)]))
    }

    func testAChangedValueIsNotTolerated() {
        XCTAssertNil(toleratedObservationDrift(before: [window, text(99)], after: [window, text(129, value: "saved 4 min ago")]))
    }

    func testAnXMoveAloneIsNotTolerated() {
        XCTAssertNil(toleratedObservationDrift(before: [window, text(99, x: 10)], after: [window, text(99, x: 30)]))
    }

    func testAButtonWidthChangeIsNotTolerated() {
        var before = text(99)
        var after = text(129)
        before["role"] = "AXButton"
        after["role"] = "AXButton"

        XCTAssertNil(toleratedObservationDrift(before: [window, before], after: [window, after]))
    }

    func testAHeightChangeIsNotTolerated() {
        var after = text(129)
        after["height"] = 32

        XCTAssertNil(toleratedObservationDrift(before: [window, text(99)], after: [window, after]))
    }

    func testARowCountChangeIsNotTolerated() {
        XCTAssertNil(toleratedObservationDrift(before: [window, text(99)], after: [window, text(129), text(10)]))
    }

    func testNoDifferenceExplainsNothing() {
        XCTAssertNil(toleratedObservationDrift(before: [window, text(99)], after: [window, text(99)]))
    }
}
