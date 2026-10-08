import XCTest

@testable import GenesisKit

final class EdgePanelGeometryTests: XCTestCase {
    private let screen = CGRect(x: -1600, y: 100, width: 1600, height: 1000)
    private let visible = CGRect(x: -1600, y: 150, width: 1600, height: 920)

    func testTopKeepsItsBezelAnchorAcrossSizes() {
        let compact = EdgePanelGeometry.frame(
            placement: .top, size: CGSize(width: 260, height: 36),
            screen: screen, visible: visible, sideCenterY: 600)
        let expanded = EdgePanelGeometry.frame(
            placement: .top, size: CGSize(width: 438, height: 490),
            screen: screen, visible: visible, sideCenterY: 600)
        for p in stride(from: 0.0, through: 1.0, by: 0.1) {
            let frame = EdgePanelGeometry.interpolate(from: compact, to: expanded, progress: p)
            XCTAssertEqual(frame.midX, screen.midX, accuracy: 0.01)
            XCTAssertEqual(frame.maxY, screen.maxY, accuracy: 0.01)
        }
    }

    func testSideFramesStayOnScreenIncludingNegativeOrigins() {
        for edge in [EdgePanelPlacement.left, .right] {
            let frame = EdgePanelGeometry.frame(
                placement: edge, size: CGSize(width: 440, height: 456),
                screen: screen, visible: visible, sideCenterY: 10_000)
            XCTAssertEqual(frame.maxY, visible.maxY)
            XCTAssertTrue(visible.contains(frame))
            if edge == .right {
                XCTAssertEqual(frame.maxX, visible.maxX)
            } else {
                XCTAssertEqual(frame.minX, visible.minX)
            }
        }
    }

    func testSmallDisplaysClampTheOpenSize() {
        let frame = EdgePanelGeometry.frame(
            placement: .right, size: CGSize(width: 3000, height: 3000),
            screen: screen, visible: visible, sideCenterY: 600)
        XCTAssertEqual(frame, visible)
    }

    func testSideJoinsPhysicalBezelWhenVisibleFrameIsInset() {
        let inset = CGRect(x: -1560, y: 150, width: 1520, height: 920)
        let right = EdgePanelGeometry.frame(placement: .right, size: CGSize(width: 38, height: 200),
                                            screen: screen, visible: inset, sideCenterY: 600)
        let left = EdgePanelGeometry.frame(placement: .left, size: CGSize(width: 38, height: 200),
                                           screen: screen, visible: inset, sideCenterY: 600)
        XCTAssertEqual(right.maxX, screen.maxX)
        XCTAssertEqual(left.minX, screen.minX)
        XCTAssertGreaterThanOrEqual(right.minY, inset.minY)
    }

    func testShapeJoinsBezelWithConcaveShoulders() {
        let rect = CGRect(x: 0, y: 0, width: 100, height: 200)
        let right = EdgePanelShape(placement: .right).path(in: rect)
        XCTAssertTrue(right.contains(CGPoint(x: 99.9, y: 5)))
        XCTAssertFalse(right.contains(CGPoint(x: 85, y: 5)))
        XCTAssertTrue(right.contains(CGPoint(x: 5, y: 100)))
        let left = EdgePanelShape(placement: .left).path(in: rect)
        XCTAssertTrue(left.contains(CGPoint(x: 0.1, y: 5)))
        XCTAssertFalse(left.contains(CGPoint(x: 15, y: 5)))
        let top = EdgePanelShape(placement: .top).path(in: rect)
        XCTAssertTrue(top.contains(CGPoint(x: 5, y: 0.1)))
        XCTAssertFalse(top.contains(CGPoint(x: 5, y: 15)))
    }

    func testMotionFinishesAtExactTargetAndClosingDoesNotOvershoot() {
        XCTAssertEqual(EdgePanelGeometry.motionProgress(0, opening: true), 0)
        XCTAssertEqual(EdgePanelGeometry.motionProgress(1, opening: true), 1)
        XCTAssertEqual(EdgePanelGeometry.motionProgress(1, opening: false), 1)
        for p in stride(from: 0.0, through: 1.0, by: 0.02) {
            let value = EdgePanelGeometry.motionProgress(p, opening: false)
            XCTAssertGreaterThanOrEqual(value, 0)
            XCTAssertLessThanOrEqual(value, 1)
        }
    }
}

final class WidgetSelectionTests: XCTestCase {
    func testRelaunchRestoresItsDestinationEvenWhenFilteredOrTemporarilyMissing() {
        XCTAssertEqual(WidgetSelection.initial(persisted: "local:codex:chosen:home", visibleKeys: ["another"]),
                       "local:codex:chosen:home")
        XCTAssertEqual(WidgetSelection.initial(persisted: nil, visibleKeys: ["first", "second"]), "first")
        XCTAssertEqual(WidgetSelection.initial(persisted: nil, visibleKeys: []), "")
    }
}
