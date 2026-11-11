import XCTest
@testable import GenesisToolsRecorder

/// The zoom doc promised that a 2.5x canvas zoom at x 0.15 makes a phone-left frame's phone fill the frame. The view
/// stays inside the canvas, so a focus nearer an edge than 0.5 / scale moves in to that distance: the doc now says so,
/// and its example keeps its focus.
final class RecorderHuntCanvasZoomDocExampleTests: XCTestCase {
    private func canvasZoomed(scale: Double, focusX: Double) -> EditProject {
        var project = EditProject.whole(video: "/tmp/hunt-canvas-doc.mp4", durationUs: 5_000_000, width: 1920, height: 1080,
                                        cursor: nil, recording: nil)
        project.zooms = [EditProject.Zoom(id: "c", startUs: 1_000_000, endUs: 3_000_000, scale: scale, focusX: focusX, focusY: 0.5,
                                          easeInMs: 0, easeOutMs: 0, target: .canvas)]
        return project
    }

    func testAFocusNearerAnEdgeThanHalfTheViewMovesIn() {
        let view = ZoomCurve.canvasView(atSource: 2_000_000, project: canvasZoomed(scale: 2.5, focusX: 0.15))
        XCTAssertEqual(view.scale, 2.5, accuracy: 0.001)
        XCTAssertEqual(view.centerX, 0.2, accuracy: 0.001)
    }

    func testTheDocExampleKeepsItsFocus() {
        let view = ZoomCurve.canvasView(atSource: 2_000_000, project: canvasZoomed(scale: 4, focusX: 0.14))
        XCTAssertEqual(view.centerX, 0.14, accuracy: 0.001)
    }
}
