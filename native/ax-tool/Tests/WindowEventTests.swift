import AppKit
import XCTest
@testable import SnapshotSupport

final class WindowEventTests: XCTestCase {
    func testRejectedDragStartPostsNoMouseEvents() throws {
        // Regression: PR #376 t7 — validate the start immediately before mouse-down.
        let factory = try WindowEventFactory(windowID: 456, bounds: CGRect(x: 0, y: 0, width: 500, height: 500))
        var posted: [CGEvent] = []

        XCTAssertThrowsError(try factory.drag(start: CGPoint(x: 10, y: 10),
            points: [CGPoint(x: 20, y: 20)], stepDelay: 0,
            verify: { point in
                if point == CGPoint(x: 10, y: 10) {
                    throw WindowEventError.unavailable("window changed")
                }
            }, post: { posted.append($0) })) { error in
                XCTAssertEqual(error.localizedDescription, "window changed")
            }
        XCTAssertTrue(posted.isEmpty)
    }

    func testInterruptedDragReleasesAtLastVerifiedPoint() throws {
        // Regression: PR #376 t7 — interrupted drag must not drop at its planned destination.
        let factory = try WindowEventFactory(windowID: 456, bounds: CGRect(x: 0, y: 0, width: 500, height: 500))
        var posted: [CGEvent] = []
        XCTAssertThrowsError(try factory.drag(start: CGPoint(x: 10, y: 10),
            points: [CGPoint(x: 20, y: 20), CGPoint(x: 100, y: 100)], stepDelay: 0,
            verify: { point in
                if point.x == 100 { throw WindowEventError.unavailable("window changed") }
            }, post: { posted.append($0) }))
        XCTAssertEqual(posted.map(\.type), [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
        XCTAssertEqual(posted.last?.location, CGPoint(x: 20, y: 20))
    }

    func testCompletedDragReleasesAtTheVerifiedDestination() throws {
        let factory = try WindowEventFactory(windowID: 456, bounds: CGRect(x: 0, y: 0, width: 500, height: 500))
        var posted: [CGEvent] = []
        try factory.drag(start: CGPoint(x: 10, y: 10), points: [CGPoint(x: 100, y: 100)], stepDelay: 0,
                         verify: { _ in }, post: { posted.append($0) })
        XCTAssertEqual(posted.map(\.type), [.leftMouseDown, .leftMouseDragged, .leftMouseUp])
        XCTAssertEqual(posted.last?.location, CGPoint(x: 100, y: 100))
    }

    func testWheelScrollCarriesTargetWindowAndBothAxes() throws {
        let factory = try WindowEventFactory(windowID: 456, bounds: CGRect(x: 100, y: 100, width: 500, height: 452))
        let event = try factory.scroll(point: CGPoint(x: 200, y: 250), deltaX: -60, deltaY: 120)
        XCTAssertEqual(event.type, .scrollWheel)
        XCTAssertEqual(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis1), 120)
        XCTAssertEqual(event.getIntegerValueField(.scrollWheelEventPointDeltaAxis2), -60)
        XCTAssertEqual(try XCTUnwrap(NSEvent(cgEvent: event)).windowNumber, 456)
    }

    func testRightClickCarriesWindowIdentityAndLocalPosition() throws {
        let factory = try WindowEventFactory(windowID: 123, bounds: CGRect(x: -200, y: -400, width: 500, height: 452))
        let event = try factory.mouse(type: .rightMouseDown, point: CGPoint(x: -115, y: -279), clickCount: 2)
        XCTAssertEqual(event.type, .rightMouseDown)
        XCTAssertEqual(event.location, CGPoint(x: -115, y: -279))
        XCTAssertEqual(event.getIntegerValueField(.mouseEventClickState), 2)
        XCTAssertEqual(event.getIntegerValueField(.mouseEventWindowUnderMousePointer), 123)
        let decoded = try XCTUnwrap(NSEvent(cgEvent: event))
        XCTAssertEqual(decoded.windowNumber, 123)
        // No receiver NSWindow exists in this process: inspect the transport field directly.
        typealias GetLocation = @convention(c) (CGEvent) -> CGPoint
        let handle = try XCTUnwrap(dlopen("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics", RTLD_LAZY))
        defer { dlclose(handle) }
        let symbol = try XCTUnwrap(dlsym(handle, "CGEventGetWindowLocation"))
        let getLocation = unsafeBitCast(symbol, to: GetLocation.self)
        XCTAssertEqual(getLocation(event), CGPoint(x: 85, y: 121))
    }

    func testDragPinsTheElementOnlyBeforeMouseDown() {
        // Regression: the final review round on PR #376. verifyPoint ignored the target
        // it was handed and asserted the captured element frame on EVERY step, so a drag
        // whose target moves — which is every real drag — threw after the first movement
        // and left the caller with a half-completed drag plus an error.
        let start = CGPoint(x: 100, y: 200)

        XCTAssertEqual(WindowEventFactory.dragVerifyTarget(point: start, start: start), .element)
        XCTAssertEqual(WindowEventFactory.dragVerifyTarget(point: CGPoint(x: 101, y: 200), start: start), .window)
        XCTAssertEqual(WindowEventFactory.dragVerifyTarget(point: CGPoint(x: 400, y: 640), start: start), .window)
    }

    func testDragVerifiesEveryStepAndAbortsWithRelease() throws {
        // The verification is per step, not sampled: a drag that becomes unsafe midway
        // must stop there. Pair this with the rule above — every step is checked, but
        // after mouse-down the check pins the window, not the moving element.
        let factory = try WindowEventFactory(windowID: 789, bounds: CGRect(x: 0, y: 0, width: 800, height: 600))
        var verified: [CGPoint] = []
        var posted: [CGEventType] = []
        let start = CGPoint(x: 10, y: 10)
        let points = [CGPoint(x: 20, y: 20), CGPoint(x: 30, y: 30), CGPoint(x: 40, y: 40)]

        XCTAssertThrowsError(
            try factory.drag(start: start, points: points, stepDelay: 0,
                             verify: { point in
                                 verified.append(point)
                                 if point == points[1] {
                                     throw WindowEventError.unavailable("geometry moved")
                                 }
                             },
                             post: { posted.append($0.type) })
        )

        XCTAssertEqual(verified, [start, points[0], points[1]])
        XCTAssertEqual(posted.last, .leftMouseUp)
    }
}
