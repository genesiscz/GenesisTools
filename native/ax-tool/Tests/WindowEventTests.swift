import AppKit
import XCTest
@testable import SnapshotSupport

final class WindowEventTests: XCTestCase {
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
}
