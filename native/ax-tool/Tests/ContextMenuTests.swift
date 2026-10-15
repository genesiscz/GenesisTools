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
    var visits: [pid_t] = []
    /// Called on every role read, so a test can move a fake clock as reads happen.
    var onRead: (() -> Void)?
    var onAccess: (() -> Void)?

    func element(_ pid: pid_t) -> AXUIElement { AXUIElementCreateApplication(pid) }

    func pid(_ element: AXUIElement) -> pid_t {
        var value: pid_t = 0
        AXUIElementGetPid(element, &value)
        return value
    }

    func attribute(_ element: AXUIElement, _ name: String) -> Any? {
        onAccess?()
        if name == "AXRole" {
            visits.append(pid(element))
            onRead?()
        }

        return name == "AXRole" ? roles[pid(element)] : nil
    }

    func children(of element: AXUIElement) throws -> [AXUIElement] {
        onAccess?()
        if failing.contains(pid(element)) {
            throw ObservedTreeError("read failed")
        }

        return (children[pid(element)] ?? []).map { AXUIElementCreateApplication($0) }
    }

    func actionNames(of element: AXUIElement) -> [String] {
        onAccess?()
        return []
    }
    func isValueSettable(_ element: AXUIElement) -> Bool? {
        onAccess?()
        return nil
    }
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
    func testExplicitShowMenuChecksTakeoverAfterReadingItsBaseline() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/SnapshotWorkflow.swift"), encoding: .utf8)
        let start = try XCTUnwrap(source.range(of: "        if name == \"AXShowMenu\" {"))
        let end = try XCTUnwrap(source.range(of: "            contextMenuSeen = outcome == .opened", range: start.upperBound..<source.endIndex))
        let branch = String(source[start.lowerBound..<end.lowerBound])
        let baseline = try XCTUnwrap(branch.range(of: "let baseline = workflowMenuBaseline(pid: pid, rows: tree.rows)"))
        let dispatch = try XCTUnwrap(branch.range(of: "let outcome = workflowShowMenu(element,"))

        XCTAssertEqual(branch[baseline.upperBound..<dispatch.lowerBound].trimmingCharacters(in: .whitespacesAndNewlines),
                       "try inputGate.check()")
        XCTAssertTrue(branch.contains("baseline: baseline)"))
    }

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

    // 🛑 Review of #530: the walk had no deadline. It must stop between reads once the caller's time is up.
    func testTheWalkStopsWhenItsTimeIsUp() {
        let source = source()
        var reads = 0
        let found = findOpenContextMenu(app: source.element(1), source: source, expired: {
            reads += 1
            return reads > 2
        })

        XCTAssertNil(found)
        XCTAssertLessThanOrEqual(source.visits.count, 2)
    }

    // A wide element still reads no more than the allowance. (The enqueue cap itself only saves memory, so no
    // read count can tell it apart; this pins the read bound around it.)
    func testAWideElementReadsNoMoreThanTheAllowance() {
        let source = MenuTreeSource()
        source.roles[1] = "AXApplication"
        source.children[1] = Array(100...199)
        for pid in 100...199 { source.roles[pid_t(pid)] = "AXGroup" }
        source.roles[199] = "AXMenu"

        XCTAssertNil(findOpenContextMenu(app: source.element(1), source: source, limit: 10))
        XCTAssertLessThanOrEqual(source.visits.count, 10)
    }

    // AX can hand back the same object under two parents; a cycle must not loop or re-read it.
    func testAnElementReachedTwiceIsVisitedOnce() {
        let source = source()
        source.children[3] = [4, 2, 5]

        XCTAssertEqual(findOpenContextMenu(app: source.element(1), source: source).map(source.pid), 5)
        XCTAssertEqual(source.visits.filter { $0 == 2 }.count, 1)
    }

    // 🛑 Review of #530: the application-level menu check read every child with no shared deadline. Each read
    // here costs 0.3 s of a 0.5 s budget, so the answer must be "unknown" after two, not "no menu" after five.
    func testTheApplicationMenuCheckGivesUpAtItsDeadline() {
        let source = MenuTreeSource()
        source.roles = [1: "AXApplication", 2: "AXWindow", 3: "AXWindow", 4: "AXWindow", 5: "AXWindow", 6: "AXMenuBar"]
        source.children[1] = [2, 3, 4, 5, 6]
        var clock: TimeInterval = 0
        source.onRead = { clock += 0.3 }
        let bounded = DeadlineHierarchySource(source, deadline: 0.5, now: { clock })

        XCTAssertNil(applicationChildMenuState(app: source.element(1), source: bounded))
        XCTAssertEqual(source.visits, [2, 3])
    }

    func testAnUnreadableChildRoleLeavesTheApplicationMenuStateUnknown() {
        let source = MenuTreeSource()
        source.children[1] = [2]
        let bounded = DeadlineHierarchySource(source, deadline: .infinity)

        XCTAssertNil(applicationChildMenuState(app: source.element(1), source: bounded))
    }

    func testTheFinalChildRoleReadCannotOutliveTheApplicationMenuDeadline() {
        for role in ["AXWindow", "AXMenu"] {
            let source = MenuTreeSource()
            source.roles[2] = role
            source.children[1] = [2]
            var clock: TimeInterval = 0
            source.onRead = { clock = 1 }
            let bounded = DeadlineHierarchySource(source, deadline: 0.5, now: { clock })

            XCTAssertNil(applicationChildMenuState(app: source.element(1), source: bounded), role)
            XCTAssertEqual(source.visits, [2])
        }
    }

    func testTheApplicationMenuCheckAnswersInsideItsDeadline() {
        let source = MenuTreeSource()
        source.roles = [1: "AXApplication", 2: "AXWindow", 3: "AXMenu"]
        source.children[1] = [2, 3]
        let bounded = DeadlineHierarchySource(source, deadline: .infinity)

        XCTAssertEqual(applicationChildMenuState(app: source.element(1), source: bounded), true)
        source.children[1] = [2]
        XCTAssertEqual(applicationChildMenuState(app: source.element(1), source: bounded), false)
        source.failing = [1]
        XCTAssertNil(applicationChildMenuState(app: source.element(1), source: bounded))
    }

    func testADeadlineSourceExpiresAtItsDeadline() {
        var clock: TimeInterval = 10
        let source = DeadlineHierarchySource(MenuTreeSource(), deadline: 11, now: { clock })

        XCTAssertFalse(source.expired())
        clock = 11
        XCTAssertTrue(source.expired())
    }
}

final class ContextMenuHydrationDeadlineTests: XCTestCase {
    func testEachMenuReadSharesOneBudgetForDiscoveryAndHydrationAndRevalidationGetsAFreshOne() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/MenuControl.swift"), encoding: .utf8)

        XCTAssertTrue(source.contains("openContextMenu(pid, source: source)"))
        XCTAssertTrue(source.contains("buildObservedTree(root: menu, source: source, depth: depth, scope: \"menu\", expired: source.expired)"))
        XCTAssertEqual(source.components(separatedBy: "source: menuReadSource()").count - 1, 2)
        XCTAssertEqual(source.components(separatedBy: "deadline: ProcessInfo.processInfo.systemUptime + 3").count - 1, 1)
    }

    func testAnExpiredContextMenuSourceMakesNoMoreAXReads() {
        let source = MenuTreeSource()
        var reads = 0
        source.onAccess = { reads += 1 }
        let bounded = DeadlineHierarchySource(source, deadline: 0, now: { 0 })
        let menu = source.element(2)

        XCTAssertNil(bounded.attribute(menu, "AXRole"))
        XCTAssertThrowsError(try bounded.children(of: menu))
        XCTAssertEqual(bounded.actionNames(of: menu), [])
        XCTAssertNil(bounded.isValueSettable(menu))
        XCTAssertEqual(reads, 0)
    }

    func testDiscoveryAndHydrationSpendTheSameReadBudget() throws {
        let source = MenuTreeSource()
        source.roles = [1: "AXApplication", 2: "AXMenu", 3: "AXMenuItem"]
        source.children = [1: [2], 2: [3]]
        var reads = 0
        source.onAccess = { reads += 1 }
        let bounded = DeadlineHierarchySource(source, deadline: 9.5, now: { Double(reads) })
        let menu = try XCTUnwrap(findOpenContextMenu(app: source.element(1), source: bounded, expired: bounded.expired))
        XCTAssertEqual(reads, 3)

        XCTAssertThrowsError(try buildObservedTree(root: menu, source: bounded, depth: 40, scope: "menu",
                                                   expired: bounded.expired)) { error in
            XCTAssertTrue(error.localizedDescription.contains("observation budget ran out"))
        }
        XCTAssertEqual(reads, 10)
    }

    func testExpiryWhileHydratingTheFinalMenuRowRefusesTheTree() {
        let source = MenuTreeSource()
        source.roles[2] = "AXMenu"
        var reads = 0
        source.onAccess = { reads += 1 }
        let bounded = DeadlineHierarchySource(source, deadline: 4.5, now: { Double(reads) })

        XCTAssertThrowsError(try buildObservedTree(root: source.element(2), source: bounded, depth: 40, scope: "menu",
                                                   expired: bounded.expired)) { error in
            XCTAssertEqual(error.localizedDescription, observationBudgetMessage(walked: 1))
        }
        XCTAssertEqual(reads, 5)
    }

    func testAContextMenuInsideItsBudgetStillHydrates() throws {
        let source = MenuTreeSource()
        source.roles = [1: "AXApplication", 2: "AXMenu", 3: "AXMenuItem"]
        source.children = [1: [2], 2: [3]]
        let bounded = DeadlineHierarchySource(source, deadline: .infinity)
        let menu = try XCTUnwrap(findOpenContextMenu(app: source.element(1), source: bounded, expired: bounded.expired))
        let tree = try buildObservedTree(root: menu, source: bounded, depth: 40, scope: "menu", expired: bounded.expired)

        XCTAssertEqual(tree.rows.compactMap { $0["role"] as? String }, ["AXMenu", "AXMenuItem"])
        XCTAssertFalse(tree.digest.isEmpty)
    }
}

final class MenuInventorySurfaceTests: XCTestCase {
    func testMenuBarOnlyObservationBypassesContextMenuDiscovery() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/MenuControl.swift"), encoding: .utf8)

        XCTAssertTrue(source.contains("if command == \"menu-see\", input[index] == \"--menu-bar-only\""))
        XCTAssertTrue(source.contains("parsed[\"--menu-bar-only\"] = \"true\""))
        XCTAssertTrue(source.contains("let contextMenu: Bool? = input[\"--menu-bar-only\"] == \"true\" ? false : token.map { $0.contextMenu == true }"))
        XCTAssertTrue(source.contains("if rootTitle == nil, contextMenu != false"))
        XCTAssertTrue(source.contains("contextMenu: contextMenu, source: menuReadSource()"))
    }
}

final class NewContextMenuTests: XCTestCase {
    private let nothingBefore = ContextMenuBaseline(windows: [], applicationMenu: false, windowMenu: false)

    // 🛑 Review of #530: with a menu already open, a dispatch that did nothing reported "opened" through the
    // AX answers, which ignored the baseline the window check honoured.
    func testAMenuThatWasAlreadyOpenAnswersForNothing() {
        let before = ContextMenuBaseline(windows: [7], applicationMenu: true, windowMenu: true)

        XCTAssertFalse(newContextMenuSeen(baseline: before, windows: { [7] }, applicationMenu: { true },
                                          windowMenu: { true }))
    }

    func testANewMenuWindowCounts() {
        let before = ContextMenuBaseline(windows: [7], applicationMenu: true, windowMenu: true)

        XCTAssertTrue(newContextMenuSeen(baseline: before, windows: { [7, 8] }, applicationMenu: { true },
                                         windowMenu: { true }))
    }

    func testAnAXMenuCountsOnlyWhereThereWasNoneBefore() {
        XCTAssertTrue(newContextMenuSeen(baseline: nothingBefore, windows: { [] }, applicationMenu: { true },
                                         windowMenu: { false }))
        XCTAssertTrue(newContextMenuSeen(baseline: nothingBefore, windows: { [] }, applicationMenu: { nil },
                                         windowMenu: { true }))
        let appBefore = ContextMenuBaseline(windows: [], applicationMenu: true, windowMenu: false)
        XCTAssertTrue(newContextMenuSeen(baseline: appBefore, windows: { [] }, applicationMenu: { true },
                                         windowMenu: { true }))
    }

    func testAnUnreadableAnswerProvesNothing() {
        XCTAssertFalse(newContextMenuSeen(baseline: nothingBefore, windows: { [] }, applicationMenu: { nil },
                                          windowMenu: { nil }))
    }

    func testTheCostlierReadsRunOnlyWhenTheCheaperSawNothing() {
        var treeRead = false
        XCTAssertTrue(newContextMenuSeen(baseline: nothingBefore, windows: { [3] }, applicationMenu: { true },
                                         windowMenu: {
                                             treeRead = true
                                             return true
                                         }))
        XCTAssertFalse(treeRead)
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

final class ContextMenuDeliveryTests: XCTestCase {
    // 🛑 AXShowMenu last: SwiftUI answers it with an enclosing view's menu, so a real right mouse event goes first.
    func testTheMouseEventsGoBeforeAXShowMenu() {
        XCTAssertEqual(contextMenuDeliveries(nil), [.windowEvent, .postToPid, .showMenu])
    }

    func testASettingPicksASubsetInTheFixedOrder() {
        XCTAssertEqual(contextMenuDeliveries("AXShowMenu, post-to-pid"), [.postToPid, .showMenu])
        XCTAssertEqual(contextMenuDeliveries("nonsense"), ContextMenuDelivery.allCases)
    }

    private func step(_ delivery: ContextMenuDelivery, _ answer: Bool?,
                      log: @escaping (ContextMenuDelivery) -> Void) -> ContextMenuStep {
        ContextMenuStep(delivery) {
            log(delivery)
            return answer
        }
    }

    func testTheFirstDeliveryThatOpensAMenuEndsTheRun() throws {
        var ran: [ContextMenuDelivery] = []
        let run = try runContextMenuDeliveries([step(.windowEvent, false) { ran.append($0) },
                                                step(.postToPid, true) { ran.append($0) },
                                                step(.showMenu, true) { ran.append($0) }], anyMenuOpen: { false })

        XCTAssertEqual(run, ContextMenuRun(openedBy: .postToPid, tried: [.windowEvent, .postToPid]))
        XCTAssertEqual(ran, [.windowEvent, .postToPid])
        XCTAssertEqual(run.description, "post-to-pid")
    }

    // A menu open without counting as new must not get a second right-click that could close it.
    func testNoLaterDeliveryRunsWhileAMenuIsOpen() throws {
        var ran: [ContextMenuDelivery] = []
        let run = try runContextMenuDeliveries([step(.windowEvent, false) { ran.append($0) },
                                                step(.postToPid, true) { ran.append($0) }], anyMenuOpen: { true })

        XCTAssertEqual(run, ContextMenuRun(openedBy: nil, tried: [.windowEvent]))
        XCTAssertEqual(ran, [.windowEvent])
    }

    func testANotApplicableDeliveryIsNotCountedAsTried() throws {
        let run = try runContextMenuDeliveries([step(.windowEvent, false) { _ in }, step(.postToPid, false) { _ in },
                                                step(.showMenu, nil) { _ in }], anyMenuOpen: { false })

        XCTAssertNil(run.openedBy)
        XCTAssertEqual(run.tried, [.windowEvent, .postToPid])
        XCTAssertEqual(run.description, "window-event, then post-to-pid")
    }

    func testAnAXShowMenuFallbackErrorReachesTheCaller() {
        let failure = AXError.failure.rawValue
        var ran: [ContextMenuDelivery] = []
        let steps = [step(.windowEvent, false) { ran.append($0) },
                     step(.postToPid, false) { ran.append($0) },
                     ContextMenuStep(.showMenu) {
                         ran.append(.showMenu)
                         let outcome = showContextMenu(perform: { .failure }, menuAppeared: {
                             XCTFail("an early AX failure must not be reported as an opened menu")
                             return false
                         })
                         if case .failed(let code) = outcome {
                             throw NSError(domain: "AXShowMenu", code: Int(code))
                         }
                         return outcome == .opened
                     }]

        XCTAssertThrowsError(try runContextMenuDeliveries(steps, anyMenuOpen: { false })) { error in
            XCTAssertEqual((error as NSError).domain, "AXShowMenu")
            XCTAssertEqual((error as NSError).code, Int(failure))
        }
        XCTAssertEqual(ran, [.windowEvent, .postToPid, .showMenu])
    }

    func testAPlainCGEventCarriesTheWindowAndItsLocalPosition() throws {
        let factory = try WindowEventFactory(windowID: 123, bounds: CGRect(x: -200, y: -400, width: 500, height: 452))
        let event = try factory.pidMouse(type: .rightMouseDown, button: .right, point: CGPoint(x: -115, y: -279), clickCount: 1)

        XCTAssertEqual(event.type, .rightMouseDown)
        XCTAssertEqual(event.location, CGPoint(x: -115, y: -279))
        XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 1)
        XCTAssertEqual(event.getIntegerValueField(CGEventField(rawValue: 51)!), 123)
        XCTAssertEqual(event.getIntegerValueField(.mouseEventWindowUnderMousePointer), 123)
        XCTAssertEqual(event.getIntegerValueField(.mouseEventWindowUnderMousePointerThatCanHandleThisEvent), 123)
        // Without the window-local location the event opened nothing on a background fixture.
        typealias GetLocation = @convention(c) (CGEvent) -> CGPoint
        let handle = try XCTUnwrap(dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY))
        defer { dlclose(handle) }
        let getLocation = unsafeBitCast(try XCTUnwrap(dlsym(handle, "CGEventGetWindowLocation")), to: GetLocation.self)
        XCTAssertEqual(getLocation(event), CGPoint(x: 85, y: 121))
    }

    func testAPlainCGEventOutsideTheWindowIsRefused() throws {
        let factory = try WindowEventFactory(windowID: 123, bounds: CGRect(x: 0, y: 0, width: 100, height: 100))

        XCTAssertThrowsError(try factory.pidMouse(type: .rightMouseDown, button: .right, point: CGPoint(x: 150, y: 10),
                                                  clickCount: 1))
    }
}

final class MenuItemTitleTests: XCTestCase {
    private final class Items: HierarchySource {
        let rows: [(pid: pid_t, role: String, title: String?)]
        var reads = 0
        init(_ rows: [(pid: pid_t, role: String, title: String?)]) { self.rows = rows }

        func pid(_ element: AXUIElement) -> pid_t {
            var value: pid_t = 0
            AXUIElementGetPid(element, &value)
            return value
        }

        func attribute(_ element: AXUIElement, _ name: String) -> Any? {
            reads += 1
            guard let row = rows.first(where: { $0.pid == pid(element) }) else { return nil }
            return name == "AXRole" ? row.role : name == "AXTitle" ? row.title : nil
        }

        func children(of element: AXUIElement) throws -> [AXUIElement] {
            pid(element) == 1 ? rows.map { AXUIElementCreateApplication($0.pid) } : []
        }

        func actionNames(of element: AXUIElement) -> [String] { [] }
        func isValueSettable(_ element: AXUIElement) -> Bool? { nil }
    }

    // The titles are how a caller tells the element's own menu from an enclosing view's.
    func testTitlesComeInOrderWithoutSeparators() {
        let source = Items([(2, "AXMenuItem", "Show in Sidebar"), (3, "AXMenuItem", ""), (4, "AXMenuItem", "Copy Path"),
                            (5, "AXMenuItem", nil), (6, "AXMenuItem", "Wrap Tabs")])

        XCTAssertEqual(menuItemTitles(menu: AXUIElementCreateApplication(1), source: source),
                       ["Show in Sidebar", "Copy Path", "Wrap Tabs"])
    }

    func testTitlesAreCapped() {
        let source = Items((2...9).map { ($0, "AXMenuItem", "Item \($0)") })

        XCTAssertEqual(menuItemTitles(menu: AXUIElementCreateApplication(1), source: source, limit: 3),
                       ["Item 2", "Item 3", "Item 4"])
        // Review of #530: reading stops at the requested count; the 5 items after it are never read.
        XCTAssertEqual(source.reads, 6)
    }

    func testTitlesStopWhenTheTimeIsUp() {
        let source = Items((2...9).map { ($0, "AXMenuItem", "Item \($0)") })
        var checks = 0
        let titles = menuItemTitles(menu: AXUIElementCreateApplication(1), source: source, expired: {
            checks += 1
            return checks > 3
        })

        XCTAssertEqual(titles, ["Item 2", "Item 3"])
    }
}
