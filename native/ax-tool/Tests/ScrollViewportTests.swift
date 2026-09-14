import XCTest
@testable import SnapshotSupport

final class ScrollViewportTests: XCTestCase {
    func testChildTargetUsesContainingScrollAreaHeightForOnePage() throws {
        let ancestors = [
            ScrollViewportAncestor(identity: 10, role: "AXStaticText", frame: CGRect(x: 20, y: 80, width: 200, height: 24)),
            ScrollViewportAncestor(identity: 20, role: "AXRow", frame: CGRect(x: 20, y: 80, width: 200, height: 24)),
            ScrollViewportAncestor(identity: 30, role: "AXScrollArea", frame: CGRect(x: 10, y: 40, width: 240, height: 160)),
            ScrollViewportAncestor(identity: 40, role: "AXWindow", frame: CGRect(x: 0, y: 0, width: 600, height: 452)),
        ]

        let viewport = try resolveScrollViewport(
            ancestors: ancestors,
            selectedWindowIdentity: 40,
            selectedWindowFrame: CGRect(x: 0, y: 0, width: 600, height: 452),
            point: CGPoint(x: 100, y: 92)
        )

        XCTAssertEqual(try pageScrollDistance(viewport: viewport, axis: .vertical, pages: 1), 160)
    }

    func testWindowCoordinateTargetUsesScrollAreaUnderTheHitPoint() throws {
        let ancestors = [
            ScrollViewportAncestor(identity: 11, role: "AXButton", frame: CGRect(x: 30, y: 70, width: 40, height: 24)),
            ScrollViewportAncestor(identity: 31, role: "AXScrollArea", frame: CGRect(x: 10, y: 40, width: 240, height: 160)),
            ScrollViewportAncestor(identity: 41, role: "AXWindow", frame: CGRect(x: 0, y: 0, width: 600, height: 452)),
        ]

        let viewport = try resolveScrollViewport(
            ancestors: ancestors,
            selectedWindowIdentity: 41,
            selectedWindowFrame: CGRect(x: 0, y: 0, width: 600, height: 452),
            point: CGPoint(x: 50, y: 82)
        )

        XCTAssertEqual(try pageScrollDistance(viewport: viewport, axis: .horizontal, pages: 2), 480)
    }

    func testNestedScrollAreasUseTheNearestViewport() throws {
        let ancestors = [
            ScrollViewportAncestor(identity: 12, role: "AXRow", frame: CGRect(x: 40, y: 90, width: 120, height: 24)),
            ScrollViewportAncestor(identity: 22, role: "AXScrollArea", frame: CGRect(x: 30, y: 70, width: 140, height: 80)),
            ScrollViewportAncestor(identity: 32, role: "AXScrollArea", frame: CGRect(x: 10, y: 40, width: 240, height: 300)),
            ScrollViewportAncestor(identity: 42, role: "AXWindow", frame: CGRect(x: 0, y: 0, width: 600, height: 452)),
        ]

        let viewport = try resolveScrollViewport(
            ancestors: ancestors,
            selectedWindowIdentity: 42,
            selectedWindowFrame: CGRect(x: 0, y: 0, width: 600, height: 452),
            point: CGPoint(x: 100, y: 102)
        )

        XCTAssertEqual(viewport.identity, 22)
    }

    func testMissingScrollAreaRefusesPageDistance() {
        let ancestors = [
            ScrollViewportAncestor(identity: 13, role: "AXButton", frame: CGRect(x: 30, y: 70, width: 40, height: 24)),
            ScrollViewportAncestor(identity: 43, role: "AXWindow", frame: CGRect(x: 0, y: 0, width: 600, height: 452)),
        ]

        XCTAssertThrowsError(try resolveScrollViewport(
            ancestors: ancestors,
            selectedWindowIdentity: 43,
            selectedWindowFrame: CGRect(x: 0, y: 0, width: 600, height: 452),
            point: CGPoint(x: 50, y: 82)
        )) { error in
            XCTAssertEqual(error.localizedDescription, "no trustworthy AXScrollArea viewport at point; use --pixels")
        }
    }

    func testInvalidScrollAreaGeometryRefusesPageDistance() {
        let ancestors = [
            ScrollViewportAncestor(identity: 14, role: "AXButton", frame: CGRect(x: 30, y: 70, width: 40, height: 24)),
            ScrollViewportAncestor(identity: 34, role: "AXScrollArea", frame: CGRect(x: 10, y: 40, width: 240, height: 0)),
            ScrollViewportAncestor(identity: 44, role: "AXWindow", frame: CGRect(x: 0, y: 0, width: 600, height: 452)),
        ]

        XCTAssertThrowsError(try resolveScrollViewport(
            ancestors: ancestors,
            selectedWindowIdentity: 44,
            selectedWindowFrame: CGRect(x: 0, y: 0, width: 600, height: 452),
            point: CGPoint(x: 50, y: 82)
        )) { error in
            XCTAssertEqual(error.localizedDescription, "no trustworthy AXScrollArea viewport at point; use --pixels")
        }
    }

    func testAncestorChainFromAnotherWindowIsRejected() {
        let ancestors = [
            ScrollViewportAncestor(identity: 15, role: "AXButton", frame: CGRect(x: 30, y: 70, width: 40, height: 24)),
            ScrollViewportAncestor(identity: 35, role: "AXScrollArea", frame: CGRect(x: 10, y: 40, width: 240, height: 160)),
            ScrollViewportAncestor(identity: 45, role: "AXWindow", frame: CGRect(x: 0, y: 0, width: 600, height: 452)),
        ]

        XCTAssertThrowsError(try resolveScrollViewport(
            ancestors: ancestors,
            selectedWindowIdentity: 46,
            selectedWindowFrame: CGRect(x: 0, y: 0, width: 600, height: 452),
            point: CGPoint(x: 50, y: 82)
        ))
    }

    func testChangedViewportGeometryIsRejectedBeforeDispatch() {
        let expected = ScrollViewportAncestor(
            identity: 50,
            role: "AXScrollArea",
            frame: CGRect(x: 10, y: 40, width: 240, height: 160)
        )
        let moved = ScrollViewportAncestor(
            identity: 50,
            role: "AXScrollArea",
            frame: CGRect(x: 10, y: 41, width: 240, height: 160)
        )

        XCTAssertThrowsError(try validateScrollViewportUnchanged(expected: expected, current: moved)) { error in
            XCTAssertEqual(error.localizedDescription, "scroll viewport geometry changed; inspect before retrying")
        }
    }
}
