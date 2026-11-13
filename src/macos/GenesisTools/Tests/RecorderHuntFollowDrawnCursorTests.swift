import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// A part or a lens that follows the cursor sits on the pointer the viewer sees (the smooth cursor, the drawn cursor,
/// or the system cursor in the pixels), not on a wider average of the raw track, so it does not lag behind a click.
final class RecorderHuntFollowDrawnCursorTests: XCTestCase {
    /// A fast move from x 0.2 to 0.8 just before a click at 1 s; `drawn` gives the track a cursor picture to draw.
    private func track(drawn: Bool) -> CursorTrack {
        let shapes = drawn
            ? ["arrow": CursorTrack.Shape(image: CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: 10, height: 10)),
                                          hotX: 0, hotY: 0, width: 5, height: 5)]
            : [:]
        return CursorTrack(samples: [
            CursorTrack.Sample(ms: 0, x: 0.2, y: 0.5, shape: drawn ? "arrow" : nil),
            CursorTrack.Sample(ms: 900, x: 0.2, y: 0.5),
            CursorTrack.Sample(ms: 950, x: 0.8, y: 0.5),
            CursorTrack.Sample(ms: 1000, x: 0.8, y: 0.5, click: "left"),
            CursorTrack.Sample(ms: 1200, x: 0.8, y: 0.5),
        ], shapes: shapes)
    }

    private func project() -> EditProject {
        EditProject.whole(video: "/tmp/x.mp4", durationUs: 3_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
    }

    func testAFollowingPartCentresOnTheDrawnCursorAtAClick() throws {
        let track = track(drawn: true)
        let edit = project()
        var part = EditProject.Redaction(id: "s", startUs: 0, endUs: 3_000_000, x: 0, y: 0, width: 0.2, height: 0.2,
                                         style: .spotlight)
        part.follow = true
        let pointer = CursorTrack.Pointer(edit)
        let seen = try XCTUnwrap(track.pointerPoint(atMs: 1000, pointer: pointer))
        XCTAssertEqual(seen.x, 0.8, accuracy: 1e-6, "the drawn cursor sits where it clicked")
        let placed = ZoomState.placed(part, atSourceUs: 1_000_000, track: track, pointer: pointer)
        XCTAssertEqual(placed.x + placed.width / 2, seen.x, accuracy: 1e-6)
        XCTAssertEqual(placed.y + placed.height / 2, seen.y, accuracy: 1e-6)
    }

    func testThePointerIsTheSmoothCursorWhenItIsOnAndTheRawTrackWithoutADrawnCursor() throws {
        var edit = project()
        edit.cursorSmooth = .init()
        let pointer = CursorTrack.Pointer(edit)
        let drawn = track(drawn: true)
        let smooth = try XCTUnwrap(drawn.smoothMark(atMs: 930, settings: .init(), aspect: 1080.0 / 1920))
        let seen = try XCTUnwrap(drawn.pointerPoint(atMs: 930, pointer: pointer))
        XCTAssertEqual(seen.x, smooth.x, accuracy: 1e-9)
        XCTAssertEqual(seen.y, smooth.y, accuracy: 1e-9)
        // The system cursor is in the pixels: the raw place, with no smoothing at all.
        let raw = track(drawn: false)
        let plain = try XCTUnwrap(raw.pointerPoint(atMs: 960, pointer: CursorTrack.Pointer(project())))
        let exact = try XCTUnwrap(raw.point(atMs: 960))
        XCTAssertEqual(plain.x, exact.x, accuracy: 1e-9)
    }

    func testAFollowingLensSitsOnTheSmoothCursor() throws {
        var edit = project()
        edit.cursorSmooth = .init()
        edit.lens = EditProject.Lens(items: [EditProject.LensItem(id: "l", startUs: 0, endUs: 3_000_000)])
        let track = track(drawn: true)
        let mark = try XCTUnwrap(LensLook.marks(atSourceUs: 930_000, project: edit, track: track).first)
        let seen = try XCTUnwrap(track.pointerPoint(atMs: 930, pointer: CursorTrack.Pointer(edit)))
        XCTAssertEqual(mark.x, seen.x, accuracy: 1e-9)
        XCTAssertEqual(mark.y, seen.y, accuracy: 1e-9)
    }
}
