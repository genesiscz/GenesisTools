import XCTest
@testable import GenesisToolsRecorder

/// The zoom inspector offers Follow Cursor only for a picture zoom. A canvas zoom holds its focus (0...1 of the canvas):
/// the renderer never follows the cursor there (ZoomCurve.canvasView), and the service refuses follow for one. Before,
/// the inspector offered Follow Cursor for every zoom, the edit saved mode follow, and the export held the focus anyway.
final class RecorderHuntCanvasZoomNoFollowTests: XCTestCase {
    private func zoom(target: EditProject.ZoomTarget?, mode: EditProject.ZoomMode = .manual) -> EditProject.Zoom {
        EditProject.Zoom(id: "z1", startUs: 1_000_000, endUs: 3_000_000, mode: mode, target: target)
    }

    func testOnlyAPictureZoomOffersFollowCursor() {
        XCTAssertTrue(zoom(target: nil).offersFollowCursor, "a zoom with no target zooms the picture and may follow")
        XCTAssertTrue(zoom(target: .picture).offersFollowCursor)
        XCTAssertTrue(zoom(target: nil, mode: .follow).offersFollowCursor)
        XCTAssertFalse(zoom(target: .canvas).offersFollowCursor, "a canvas zoom holds its focus")
        XCTAssertFalse(zoom(target: .canvas, mode: .follow).offersFollowCursor,
                       "a canvas zoom saved with follow before the rule holds its focus too")
    }
}
