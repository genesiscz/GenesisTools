import XCTest
@testable import GenesisToolsRecorder

/// camera.json's placement carries the bubble's shape and size from the picker or Settings into a new edit. It was
/// dropped whole for an app recording and whenever the preview was not on screen at the stop, so the edit got a
/// medium circle in the bottom right.
final class RecorderHuntCameraBubblePlacementTests: XCTestCase {
    func testAnUnknownRecordedAreaStillWritesTheShape() {
        let placement = CameraBubble.placement(bubble: CGRect(x: 100, y: 100, width: 260, height: 260), recorded: nil,
                                               shape: .rounded)
        XCTAssertEqual(placement as NSDictionary, ["shape": "rounded"] as NSDictionary)
    }

    func testAnEmptyRecordedAreaStillWritesTheShape() {
        let placement = CameraBubble.placement(bubble: CGRect(x: 100, y: 100, width: 260, height: 260), recorded: .zero,
                                               shape: .square)
        XCTAssertEqual(placement as NSDictionary, ["shape": "square"] as NSDictionary)
    }

    func testAKnownRecordedAreaWritesPlaceAndSize() {
        let placement = CameraBubble.placement(bubble: CGRect(x: 1600, y: 100, width: 200, height: 200),
                                               recorded: CGRect(x: 0, y: 0, width: 2000, height: 1000), shape: .circle)
        XCTAssertEqual(placement["x"] as? Double ?? -1, 0.85, accuracy: 0.0001)
        XCTAssertEqual(placement["size"] as? Double ?? -1, 0.2, accuracy: 0.0001)
        XCTAssertEqual(placement["shape"] as? String, "circle")
    }

    private func window(pid: Int, owner: String, layer: Int = 0, _ rect: CGRect) -> [String: Any] {
        [
            kCGWindowOwnerPID as String: NSNumber(value: pid),
            kCGWindowOwnerName as String: owner,
            kCGWindowLayer as String: NSNumber(value: layer),
            kCGWindowBounds as String: ["X": rect.minX, "Y": rect.minY, "Width": rect.width, "Height": rect.height] as NSDictionary,
        ]
    }

    /// An app recording records the app's windows, so the recorded area is their union, flipped into Cocoa points.
    func testAnAppsCanvasIsTheUnionOfItsWindows() {
        let windows = [
            window(pid: 4242, owner: "Notes", CGRect(x: 100, y: 100, width: 800, height: 600)),
            window(pid: 4242, owner: "Notes", CGRect(x: 1000, y: 200, width: 400, height: 300)),
            window(pid: 4242, owner: "Notes", layer: 25, CGRect(x: 0, y: 0, width: 3000, height: 30)),
            window(pid: 77, owner: "Mail", CGRect(x: 0, y: 0, width: 50, height: 50)),
        ]
        XCTAssertEqual(CameraBubble.appCanvas(windows: windows, app: "4242", primaryHeight: 1000),
                       CGRect(x: 100, y: 300, width: 1300, height: 600))
        XCTAssertEqual(CameraBubble.appCanvas(windows: windows, app: "notes", primaryHeight: 1000),
                       CGRect(x: 100, y: 300, width: 1300, height: 600))
        XCTAssertNil(CameraBubble.appCanvas(windows: windows, app: "Safari", primaryHeight: 1000))
    }
}
