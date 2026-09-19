import XCTest
@testable import SnapshotSupport

final class ModalDispatchTests: XCTestCase {
    func testModalBlocksBackgroundAndAllowsItsControlsAndCoordinates() throws {
        let rows: [[String: Any]] = [
            ["role":"AXWindow","depth":0], ["role":"AXButton","depth":1],
            ["role":"AXSheet","depth":1,"visible":true,"x":100,"y":100,"width":200,"height":100],
            ["role":"AXButton","depth":2], ["role":"AXButton","depth":1]
        ]
        XCTAssertThrowsError(try validateModalTarget(rows: rows, target: 1))
        XCTAssertThrowsError(try validateModalTarget(rows: rows, target: 4))
        XCTAssertNoThrow(try validateModalTarget(rows: rows, target: 3))
        XCTAssertNoThrow(try validateModalTarget(rows: rows, target: 0, point: CGPoint(x: 150, y: 150)))
        XCTAssertThrowsError(try validateModalTarget(rows: rows, target: 0, point: CGPoint(x: 50, y: 50)))
        var hidden = rows
        hidden[2]["visible"] = false
        XCTAssertNoThrow(try validateModalTarget(rows: hidden, target: 1))
    }
}
final class SnapshotDispatchTests: XCTestCase {
    private enum PrimitiveError: Error {
        case reached
    }

    private func makeContext(
        token: SnapshotToken? = nil,
        observedPID: Int32 = 42,
        observedProcessLaunch: Double = 123,
        observedWindowID: Int = 7,
        observedTreeDigest: String = "stable",
        observedElementIndex: Int = 2,
        observedElementCount: Int = 4,
        observedAt: Double = 1001,
        targetEnabled: Bool = true,
        windowFocused: Bool = true,
        inputFocused: Bool = true,
        operation: SnapshotDispatchOperation = .mutation
    ) -> SnapshotDispatchContext {
        SnapshotDispatchContext(
            token: token ?? SnapshotToken(pid: 42, launch: 123, window: 7, depth: 20, digest: "stable", created: 1000),
            observedPID: observedPID,
            observedProcessLaunch: observedProcessLaunch,
            observedWindowID: observedWindowID,
            observedTreeDigest: observedTreeDigest,
            observedElementIndex: observedElementIndex,
            observedElementCount: observedElementCount,
            observedAt: observedAt,
            targetEnabled: targetEnabled,
            windowFocused: windowFocused,
            inputFocused: inputFocused,
            operation: operation
        )
    }

    private func assertRejected(
        _ context: SnapshotDispatchContext,
        message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        var dispatchCount = 0
        XCTAssertThrowsError(try dispatchSnapshotAction(context: context) {
            dispatchCount += 1
            throw PrimitiveError.reached
        }, file: file, line: line) { error in
            XCTAssertEqual(error.localizedDescription, message, file: file, line: line)
        }
        XCTAssertEqual(dispatchCount, 0, "primitive dispatch must remain unreachable", file: file, line: line)
    }

    func testRefusalCategoriesAreTypedBeforeDispatch() {
        for (context, expected) in [
            (makeContext(observedTreeDigest: "changed"), SnapshotRefusal.staleObservation),
            (makeContext(observedWindowID: 8), .scopeChanged),
            (makeContext(inputFocused: false, operation: .input), .focusMismatch),
            (makeContext(targetEnabled: false), .missingTarget)
        ] {
            var dispatches = 0
            XCTAssertThrowsError(try dispatchSnapshotAction(context: context) {
                dispatches += 1
                throw PrimitiveError.reached
            }) { error in
                let category = (error as? SnapshotError)?.category ?? (error as? SnapshotDispatchError)?.category
                XCTAssertEqual(category, expected)
            }
            XCTAssertEqual(dispatches, 0)
        }
    }

    func testValidOperationReachesPrimitiveDispatch() throws {
        let result = try dispatchSnapshotAction(context: makeContext()) { "dispatched" }

        XCTAssertEqual(result, "dispatched")
    }

    func testExpiredSnapshotDoesNotReachPrimitiveDispatch() {
        assertRejected(makeContext(observedAt: 1121), message: "snapshot expired; run see again")
    }

    func testDifferentProcessInstanceDoesNotReachPrimitiveDispatch() {
        assertRejected(makeContext(observedPID: 43), message: "snapshot belongs to a different app instance; run see again")
        assertRejected(makeContext(observedProcessLaunch: 124), message: "snapshot belongs to a different app instance; run see again")
    }

    func testDifferentWindowDoesNotReachPrimitiveDispatch() {
        assertRejected(makeContext(observedWindowID: 8), message: "snapshot belongs to a different window; run see again")
    }

    func testChangedTreeDoesNotReachPrimitiveDispatch() {
        assertRejected(makeContext(observedTreeDigest: "changed"), message: "UI changed; run see again")
    }

    func testInvalidElementIndexDoesNotReachPrimitiveDispatch() {
        assertRejected(makeContext(observedElementIndex: 4), message: "element index outside snapshot")
    }

    func testDisabledCoordinateHitOrAncestorIsRejected() {
        for enabledStates: [Bool?] in [[false, true], [true, false, true]] {
            XCTAssertThrowsError(try validatePointerHitEnabled(enabledStates)) { error in
                XCTAssertEqual(error.localizedDescription, "element is disabled; no action dispatched")
            }
        }
    }

    func testEnabledCoordinateHitAndUnknownAncestorRemainAllowed() {
        XCTAssertNoThrow(try validatePointerHitEnabled([true, nil, true]))
    }

    func testDisabledMutationDoesNotReachPrimitiveDispatch() {
        assertRejected(makeContext(targetEnabled: false), message: "element is disabled; no action dispatched")
    }

    func testForegroundPointerOperationWithWrongWindowFocusDoesNotReachPrimitiveDispatch() {
        assertRejected(
            makeContext(windowFocused: false, operation: .pointer(background: false)),
            message: "wrong frontmost app/window; focus explicitly and refresh"
        )
    }

    func testInputOperationWithWrongInputFocusDoesNotReachPrimitiveDispatch() {
        assertRejected(
            makeContext(inputFocused: false, operation: .input),
            message: "focus changed before input; no action dispatched"
        )
    }

    func testInputOperationWithWrongWindowFocusDoesNotReachPrimitiveDispatch() {
        assertRejected(
            makeContext(windowFocused: false, operation: .input),
            message: "wrong frontmost app/window; focus explicitly and refresh"
        )
    }

    func testBackgroundPointerOperationDoesNotRequireWindowFocus() throws {
        let result = try dispatchSnapshotAction(
            context: makeContext(windowFocused: false, operation: .pointer(background: true))
        ) { "dispatched" }

        XCTAssertEqual(result, "dispatched")
    }

    func testReadOperationAllowsDisabledTarget() throws {
        let result = try dispatchSnapshotAction(context: makeContext(targetEnabled: false, operation: .read)) {
            "observed"
        }

        XCTAssertEqual(result, "observed")
    }
}

extension SnapshotDispatchTests {
    func testDropdownSelectionRequiresOneExactEnabledObservedOption() throws {
        let option: [String: Any] = ["role": "AXMenuItem", "AXTitle": "High", "AXEnabled": "1", "actions": ["AXPress"]]
        XCTAssertEqual(try exactMenuOptionIndex(rows: [option], value: "High"), 0)
        XCTAssertThrowsError(try exactMenuOptionIndex(rows: [option], value: "high"))
        XCTAssertThrowsError(try exactMenuOptionIndex(rows: [option, option], value: "High"))
        var disabled = option
        disabled["AXEnabled"] = "0"
        XCTAssertThrowsError(try exactMenuOptionIndex(rows: [disabled], value: "High"))
        var unselectable = option
        unselectable["actions"] = ["AXShowMenu"]
        XCTAssertThrowsError(try exactMenuOptionIndex(rows: [unselectable], value: "High"))
    }
    func testSiblingTextDistinguishesRepeatedUnnamedControlsAndRejectsChangedRows() throws {
        let checkbox: [String: Any] = ["role": "AXCheckBox", "depth": 2, "targetKey": "same-checkbox"]
        func rows(_ second: String) -> [[String: Any]] {
            [["role": "AXGroup", "depth": 1], checkbox,
             ["role": "AXStaticText", "depth": 2, "AXValue": "First task"],
             ["role": "AXGroup", "depth": 1], checkbox,
             ["role": "AXStaticText", "depth": 2, "AXValue": second]]
        }
        var observed = rows("Second task")
        try bindTargetsToSiblingText(&observed)
        let key = try XCTUnwrap(observed[4]["targetKey"] as? String)
        XCTAssertNotEqual(observed[1]["targetKey"] as? String, key)
        XCTAssertEqual(try preparedTargetIndex(key: key, rows: observed), 4)
        var changed = rows("Different task")
        try bindTargetsToSiblingText(&changed)
        XCTAssertThrowsError(try preparedTargetIndex(key: key, rows: changed))
        var identical = rows("First task")
        try bindTargetsToSiblingText(&identical)
        XCTAssertThrowsError(try preparedTargetIndex(key: XCTUnwrap(identical[1]["targetKey"] as? String), rows: identical))
    }
    func testPreparedChromeTargetsAreBoundToThePrimaryDocument() throws {
        let toolbar: [String: Any] = ["role": "AXTextField", "AXTitle": "Address", "targetKey": "toolbar"]
        let page: [String: Any] = ["role": "AXWebArea", "depth": 2, "AXURL": "https://example.test/todos"]
        let extensionFrame: [String: Any] = ["role": "AXWebArea", "depth": 5, "AXURL": "chrome-extension://fixture/frame"]
        var original = [toolbar, page, extensionFrame]
        try bindTargetsToBrowserDocument(&original)
        var moved = [toolbar, page, ["role": "AXWebArea", "depth": 5, "AXURL": "chrome-extension://fixture/other"]]
        try bindTargetsToBrowserDocument(&moved)
        XCTAssertEqual(original[0]["targetKey"] as? String, moved[0]["targetKey"] as? String)
        var changed = [toolbar, ["role": "AXWebArea", "depth": 2, "AXURL": "https://example.test/account"]]
        try bindTargetsToBrowserDocument(&changed)
        let key = try XCTUnwrap(original[0]["targetKey"] as? String)
        XCTAssertThrowsError(try preparedTargetIndex(key: key, rows: changed))
        XCTAssertThrowsError(try validatePreparedTarget(before: original[0], after: changed[0], sameElement: true))
        var nativeRows = [toolbar]
        try bindTargetsToBrowserDocument(&nativeRows)
        XCTAssertEqual(nativeRows[0]["targetKey"] as? String, "toolbar")
    }
    func testPreparedFingerprintIgnoresLayoutButRefusesChangedOrAmbiguousTargets() throws {
        let first: [String:Any] = ["role":"AXLink","AXTitle":"Forecast","AXURL":"https://weather.example/today","AXValue":"","x":10,"AXFocused":"0"]
        var moved = first
        moved["x"] = 900
        moved["AXFocused"] = "1"
        let key = try snapshotTargetKey(first)
        XCTAssertEqual(key,try snapshotTargetKey(moved))
        let firstPage: [String:Any] = ["role":"AXWebArea","AXTitle":"Weather","AXURL":"https://weather.example/today"]
        let otherPage: [String:Any] = ["role":"AXWebArea","AXTitle":"Account","AXURL":"https://example.test/account"]
        XCTAssertNotEqual(try snapshotTargetKey(first,ancestors:[firstPage]),try snapshotTargetKey(first,ancestors:[otherPage]))
        moved["AXURL"] = "https://other.example/delete"
        XCTAssertNotEqual(key,try snapshotTargetKey(moved))
        XCTAssertEqual(try preparedTargetIndex(key:key,rows:[["targetKey":"other"],["targetKey":key]]),1)
        XCTAssertThrowsError(try preparedTargetIndex(key:key,rows:[["targetKey":"other"]]))
        XCTAssertThrowsError(try preparedTargetIndex(key:key,rows:[["targetKey":key],["targetKey":key]]))
    }
    func testPreparedClickKeepsTheSameSemanticTarget() throws {
        let before: [String:Any] = ["role":"AXLink","AXTitle":"Forecast","AXEnabled":true,"x":10]
        var after = before
        after["x"] = 200
        after["AXFocused"] = true
        XCTAssertNoThrow(try validatePreparedTarget(before:before,after:after,sameElement:true))
        XCTAssertThrowsError(try validatePreparedTarget(before:before,after:after,sameElement:false))
        after["AXValue"] = "changed"
        XCTAssertThrowsError(try validatePreparedTarget(before:before,after:after,sameElement:true))
        after = before
        after["AXTitle"] = "Delete account"
        XCTAssertThrowsError(try validatePreparedTarget(before:before,after:after,sameElement:true))
        after = before
        after["AXEnabled"] = false
        XCTAssertThrowsError(try validatePreparedTarget(before:before,after:after,sameElement:true))
    }
}

final class CursorFeedbackTests: XCTestCase {
    func testFreshValidationRunsAfterPresentationAndBeforeInput() throws {
        var events: [String] = []
        try dispatchAfterPresentation(present: { events.append("present") },
            validate: { events.append("validate") }, dispatch: { events.append("input") })
        XCTAssertEqual(events, ["present", "validate", "input"])
        events.removeAll()
        var pixelsChanged = false
        XCTAssertThrowsError(try dispatchAfterPresentation(present: { pixelsChanged = true }, validate: {
            if pixelsChanged { throw CocoaError(.validationMissingMandatoryProperty) }
        }, dispatch: { events.append("input") }))
        XCTAssertTrue(events.isEmpty)
        XCTAssertThrowsError(try dispatchAfterPresentation(present: { throw CocoaError(.featureUnsupported) },
            validate: { events.append("validate") }, dispatch: { events.append("input") }))
        XCTAssertTrue(events.isEmpty)
    }
    func testPresentationReceiptsAreBoundedAndCannotReleaseAnotherEvent() throws {
        try FileManager.default.createDirectory(atPath: CursorReceipt.directory, withIntermediateDirectories: true,
                                               attributes: [.posixPermissions: 0o700])
        let first = try CursorReceipt()
        let second = try CursorReceipt()
        XCTAssertFalse(CursorReceipt.acknowledge("../events"))
        XCTAssertTrue(CursorReceipt.acknowledge(first.id))
        XCTAssertFalse(second.wait(timeoutMs: 1))
        XCTAssertTrue(first.wait(timeoutMs: 10))
        XCTAssertFalse(first.wait(timeoutMs: 1))
        let started = ProcessInfo.processInfo.systemUptime
        XCTAssertFalse(second.wait(timeoutMs: 5))
        XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - started, 0.2)
        var releasedID: String?
        do {
            let released = try CursorReceipt()
            releasedID = released.id
        }
        XCTAssertFalse(CursorReceipt.acknowledge(releasedID!))
        var event = CursorFeedbackEvent(action: "click", point: .zero)
        event.receiptID = "../../not-a-receipt"
        XCTAssertFalse(event.valid)
        event.receiptID = first.id
        XCTAssertTrue(event.valid)
    }
    func testOnlyActionVerbsHaveFeedback() {
        for verb in ["get", "see", "list", "find", "screenshot", "snapshot", "judge", "resolve", "replay"] {
            XCTAssertNil(CursorFeedbackEvent.semantic(verb), verb)
        }
        for verb in ["press", "click", "move", "drag", "scroll", "set", "type", "key", "paste", "select", "perform", "focus", "hotkey", "window"] {
            XCTAssertNotNil(CursorFeedbackEvent.semantic(verb), verb)
        }
    }
    func testCoordinatesAndPayloadAreBounded() {
        XCTAssertTrue(CursorFeedbackEvent(action: "click", point: CGPoint(x: -1200, y: 500)).valid)
        XCTAssertTrue(CursorFeedbackEvent(action: "key", point: nil).valid)
        XCTAssertFalse(CursorFeedbackEvent(action: "shell", point: .zero).valid)
        XCTAssertFalse(CursorFeedbackEvent(action: "click", point: CGPoint(x: CGFloat.infinity, y: 1)).valid)
        let desktop = CGRect(x: -1920, y: -1080, width: 3840, height: 2160)
        XCTAssertEqual(CursorMotion.viewPoint(CGPoint(x: -100, y: 400), desktop: desktop, primaryTop: 1080),
                       CGPoint(x: 1820, y: 400))
    }
    func testCursorMappingTracksDisplaysAboveLeftAndRightAndChangedPrimaryHeight() {
        let laptop = CGRect(x:0,y:0,width:2056,height:1329)
        let left = CGRect(x:-1488,y:1329,width:2560,height:1440)
        let right = CGRect(x:1072,y:1329,width:3440,height:1440)
        let desktop = laptop.union(left).union(right)
        for point in [CGPoint(x:500,y:500), CGPoint(x:-700,y:-600), CGPoint(x:2600,y:-600)] {
            let cocoa = CursorMotion.appKitPoint(point,primaryTop:laptop.maxY)
            let local = CursorMotion.viewPoint(point,desktop:desktop,primaryTop:laptop.maxY)
            XCTAssertEqual(CGPoint(x:desktop.minX+local.x,y:desktop.maxY-local.y),cocoa)
            XCTAssertTrue([laptop,left,right].contains { $0.contains(cocoa) })
        }
        let point = CGPoint(x:500,y:500)
        XCTAssertEqual(CursorMotion.viewPoint(point,desktop:laptop,primaryTop:1329),point)
        XCTAssertEqual(CursorMotion.viewPoint(point,desktop:desktop,primaryTop:1329),CGPoint(x:1988,y:1940))
        let resized = CGRect(x:0,y:0,width:1728,height:1117)
        XCTAssertEqual(CursorMotion.viewPoint(point,desktop:resized,primaryTop:1117),point)
    }
    func testCursorEventRetainsDisplayLocalCoordinatesAcrossDifferentGlobalOrigins() {
        var event = CursorFeedbackEvent(action:"click",point:CGPoint(x:-700,y:-600))
        event.displayID = 4
        XCTAssertFalse(event.valid)
        event.displayX = 788
        event.displayY = 840
        XCTAssertTrue(event.valid)
        XCTAssertEqual(event.displayPoint,CGPoint(x:788,y:840))
        event.displayY = -1
        XCTAssertFalse(event.valid)
    }
    func testMovementEndsAtTheTargetAndReducedMotionDoesNotGlide() {
        let from = CGPoint(x: -50, y: 10), to = CGPoint(x: 800, y: 400)
        let points = CursorMotion.points(from: from, to: to)
        XCTAssertEqual(points.first, from)
        XCTAssertEqual(points.last, to)
        XCTAssertEqual(CursorMotion.points(from: from, to: to, reduced: true), [to])
        XCTAssertLessThanOrEqual(CursorMotion.duration(from: from, to: to), 0.65)
        XCTAssertTrue(points.allSatisfy { $0.x.isFinite && $0.y.isFinite })
    }
    func testBundledArtworkHasAllTwelveCuaSemanticStates() throws {
        let artwork = try CuaCursorArtwork()
        XCTAssertEqual(artwork.actionNames.count, 12)
        for action in artwork.actionNames {
            XCTAssertFalse(artwork.layer(action: action, reduced: true).sublayers?.isEmpty ?? true)
        }
    }
}


extension SnapshotDispatchTests {
    func testNativeWindowIdentityDistinguishesIdenticalFrames() {
        XCTAssertTrue(matchesNativeWindowIdentity(reportedID: 7, expectedID: 7, frameMatches: true))
        XCTAssertFalse(matchesNativeWindowIdentity(reportedID: 8, expectedID: 7, frameMatches: true))
        XCTAssertFalse(matchesNativeWindowIdentity(reportedID: 7, expectedID: 7, frameMatches: false))
    }
    func testUnavailableNativeWindowIdentityRetainsGeometryFallback() {
        XCTAssertTrue(matchesNativeWindowIdentity(reportedID: nil, expectedID: 7, frameMatches: true))
        XCTAssertFalse(matchesNativeWindowIdentity(reportedID: nil, expectedID: 7, frameMatches: false))
    }
}

extension SnapshotDispatchTests {
    func testTransientObservationRecoversWithoutRepeatingInput() throws {
        var reads = 0
        var inputs = 0
        inputs += 1
        let recovered = try recoverSnapshotRead(now: { 1 }, isTransient: { _ in true }) {
            reads += 1
            if reads == 1 { throw SnapshotError.refusal(.staleObservation, "capture changed") }
            return "fresh"
        }
        XCTAssertEqual(recovered.value, "fresh")
        XCTAssertEqual(recovered.retries, 1)
        XCTAssertEqual(inputs, 1)
        XCTAssertEqual(reads, 2)
    }
    func testObservationRecoveryIsBoundedAndDoesNotRetryPermanentFailures() {
        for transient in [true, false] {
            var reads = 0
            XCTAssertThrowsError(try recoverSnapshotRead(now: { 1 }, isTransient: { _ in transient }) { () -> String in
                reads += 1
                throw SnapshotError.refusal(.scopeChanged, "test failure")
            })
            XCTAssertEqual(reads, transient ? 3 : 1)
        }
        var time: TimeInterval = 0
        var reads = 0
        XCTAssertThrowsError(try recoverSnapshotRead(now: { time }, isTransient: { _ in true }) { () -> String in
            reads += 1
            time = 2
            throw SnapshotError.refusal(.staleObservation, "deadline")
        })
        XCTAssertEqual(reads, 1)
    }
}
