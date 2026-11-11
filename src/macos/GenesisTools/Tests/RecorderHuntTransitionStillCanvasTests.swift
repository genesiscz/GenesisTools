import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// At a crossfade the still of the other side keeps its own canvas zoom and cover crop: the two sides' finished
/// canvases blend, so the still does not take the live side's canvas zoom and jump at the join.
final class RecorderHuntTransitionStillCanvasTests: XCTestCase {
    /// 0-4 s and 8-10 s kept, a 400 ms crossfade at output 4 s; a 2x canvas zoom covers source 6-9.5 s, so the
    /// incoming clip starts inside it while the outgoing one has none.
    private func project(kind: EditProject.TransitionKind = .crossfade) -> EditProject {
        var project = EditProject.whole(video: "/movies/demo.mp4", durationUs: 10_000_000, width: 200, height: 100, cursor: nil,
                                        recording: nil)
        project.clips = [.init(id: "c1", fromUs: 0, toUs: 4_000_000), .init(id: "c2", fromUs: 8_000_000, toUs: 10_000_000)]
        project.transitions = EditProject.Transitions(default: .init(kind: kind, ms: 400))
        var zoom = EditProject.Zoom(id: "z", startUs: 6_000_000, endUs: 9_500_000, scale: 2)
        zoom.target = .canvas
        project.zooms = [zoom]
        return project
    }

    func testTheStillCarriesItsOwnCanvasZoom() throws {
        let edit = project()
        let before = ZoomState(project: edit, cursor: nil).look(atOutput: 3_900_000)
        XCTAssertEqual(before.canvasView.scale, 1, accuracy: 0.001, "the live side is the outgoing clip, with no canvas zoom")
        let mark = try XCTUnwrap(before.transition)
        XCTAssertEqual(mark.otherCanvasView.scale, 2, accuracy: 0.001, "the incoming still starts inside the 2x canvas zoom")
        XCTAssertTrue(mark.needsOwnCanvas(liveCanvasView: before.canvasView, liveCoverFocus: before.coverFocus, cover: false))

        let after = ZoomState(project: edit, cursor: nil).look(atOutput: 4_100_000)
        let back = try XCTUnwrap(after.transition)
        XCTAssertEqual(after.canvasView.scale, 2, accuracy: 0.001)
        XCTAssertEqual(back.otherCanvasView.scale, 1, accuracy: 0.001, "the outgoing still keeps no canvas zoom")
    }

    func testOnlyACrossfadeBlendsTwoCanvases() throws {
        let mark = try XCTUnwrap(ZoomState(project: project(kind: .zoom), cursor: nil).look(atOutput: 3_900_000).transition)
        XCTAssertFalse(mark.needsOwnCanvas(liveCanvasView: .whole, liveCoverFocus: CGPoint(x: 0.5, y: 0.5), cover: false),
                       "the zoom kind keeps blending the pictures")
        var same = try XCTUnwrap(ZoomState(project: project(), cursor: nil).look(atOutput: 3_900_000).transition)
        same.otherCanvasView = .whole
        XCTAssertFalse(same.needsOwnCanvas(liveCanvasView: .whole, liveCoverFocus: CGPoint(x: 0.5, y: 0.5), cover: true),
                       "both sides alike: today's picture blend")
        same.otherCoverFocus = CGPoint(x: 0.2, y: 0.5)
        XCTAssertTrue(same.needsOwnCanvas(liveCanvasView: .whole, liveCoverFocus: CGPoint(x: 0.5, y: 0.5), cover: true),
                      "a cover crop on another place")
        XCTAssertFalse(same.needsOwnCanvas(liveCanvasView: .whole, liveCoverFocus: CGPoint(x: 0.5, y: 0.5), cover: false),
                       "the focus matters only for a cover fit")
    }
}
