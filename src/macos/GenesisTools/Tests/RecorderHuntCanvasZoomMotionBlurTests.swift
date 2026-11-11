import XCTest
@testable import GenesisToolsRecorder

/// Motion blur smears a canvas zoom's move as it smears a picture zoom's: the frame look carries the canvas view of the
/// frame before, and none across a cut.
final class RecorderHuntCanvasZoomMotionBlurTests: XCTestCase {
    private func project() -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 20_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        var zoom = EditProject.Zoom(id: "z", startUs: 1_000_000, endUs: 4_000_000, scale: 2, focusX: 0.25, focusY: 0.25)
        zoom.target = .canvas
        project.zooms = [zoom]
        project.motion = EditProject.Motion(blur: 1)
        return project
    }

    func testACanvasZoomEasingInCarriesTheCanvasViewOfTheFrameBefore() throws {
        let look = ZoomState(project: project(), cursor: nil).look(atOutput: 1_150_000)
        XCTAssertGreaterThan(look.canvasView.scale, 1.0005, "the canvas zoom is easing in")
        let previous = try XCTUnwrap(look.previousCanvasView)
        XCTAssertLessThan(previous.scale, look.canvasView.scale)
        // The picture itself does not move, so its own smear stays still.
        XCTAssertEqual(look.previousView, look.view)
    }

    func testNoBlurMeansNoPreviousCanvasView() {
        var plain = project()
        plain.motion = EditProject.Motion(blur: 0)
        XCTAssertNil(ZoomState(project: plain, cursor: nil).look(atOutput: 1_150_000).previousCanvasView)
    }

    func testACutHasNoPreviousCanvasView() {
        var cut = project()
        cut.clips = [.init(id: "a", fromUs: 0, toUs: 1_100_000), .init(id: "b", fromUs: 2_000_000, toUs: 20_000_000)]
        // The first frame after the cut jumps in source time; it has no move to smear.
        XCTAssertNil(ZoomState(project: cut, cursor: nil).look(atOutput: 1_100_000).previousCanvasView)
    }
}
