import CoreGraphics
import XCTest
@testable import SnapshotSupport

/// An area records on the one display that holds all of it; one across a display edge has none.
final class RegionDisplayTests: XCTestCase {
    private let displays = [
        DisplayFrame(id: 1, bounds: CGRect(x: 0, y: 0, width: 1440, height: 900)),
        DisplayFrame(id: 2, bounds: CGRect(x: 1440, y: 0, width: 1920, height: 1080)),
    ]

    func testAnAreaInsideOneDisplayRecordsThere() {
        XCTAssertEqual(regionDisplay(CGRect(x: 100, y: 100, width: 400, height: 300), displays: displays), 1)
        XCTAssertEqual(regionDisplay(CGRect(x: 1439.5, y: 0, width: 1920, height: 1080), displays: displays), 2)
    }

    func testAnAreaAcrossADisplayEdgeOrOffEveryDisplayHasNone() {
        XCTAssertNil(regionDisplay(CGRect(x: 1300, y: 100, width: 400, height: 300), displays: displays))
        XCTAssertNil(regionDisplay(CGRect(x: 100, y: 2000, width: 400, height: 300), displays: displays))
    }
}
