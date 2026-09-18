import XCTest
@testable import SnapshotSupport

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

final class CursorFeedbackTests: XCTestCase {
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
