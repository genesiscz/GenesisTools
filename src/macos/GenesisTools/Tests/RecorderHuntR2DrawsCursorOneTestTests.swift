import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// The Style tab said "the system cursor is in its picture" for a movie recorded with a drawn cursor whose
/// cursor-shapes/ folder is missing (a copy of a plain movie made before duplicate copied that folder). The note now
/// tells the two cases apart, with the same test as CursorTrack.drawsCursor.
final class RecorderHuntR2DrawsCursorOneTestTests: XCTestCase {
    private let shaped = [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5, shape: "abc")]

    func testSystemCursorTrackSaysTheSystemCursorIsInThePicture() {
        let track = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5)])
        XCTAssertEqual(EditorView.cursorNote(for: track)?.contains("system cursor in its picture"), true)
    }

    func testShapeRowsWithoutPicturesSayThePicturesAreMissing() {
        let track = CursorTrack(samples: shaped)
        XCTAssertFalse(track.drawsCursor)
        let note = EditorView.cursorNote(for: track)
        XCTAssertEqual(note?.contains("cursor pictures"), true)
        XCTAssertEqual(note?.contains("system cursor in its picture"), false)
    }

    func testDrawnCursorHasNoNote() {
        let image = CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: 16, height: 16))
        let track = CursorTrack(samples: shaped,
                                shapes: ["abc": CursorTrack.Shape(image: image, hotX: 0, hotY: 0, width: 16, height: 16)])
        XCTAssertTrue(track.drawsCursor)
        XCTAssertNil(EditorView.cursorNote(for: track))
    }
}
