import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// The default camera bubble (bottom right, 0.24, margin 0.035) was drawn over the captions, which wrapped at 0.86 of
/// the width and never looked at it. The caption now makes room: it wraps short of the bubble, or lifts above it when
/// that leaves too narrow a plate.
final class RecorderHuntR2BubbleCaptionRoomTests: XCTestCase {
    private let longLine = "This caption line is long enough to run under the camera bubble in the bottom right corner of the frame"

    /// The bubble's square in Core Image space (lower-left origin), as the renderer passes it.
    private func bubble(_ camera: EditProject.Camera, canvas: CGSize) -> CGRect {
        let rect = camera.rect(canvas: canvas)
        return CGRect(x: rect.minX, y: canvas.height - rect.maxY, width: rect.width, height: rect.height)
    }

    private func draw(_ size: CGSize, avoid: CGRect?) -> (used: CGFloat, plate: CGRect?) {
        let black = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: size))
        let line = CaptionTrack.Line(fromUs: 0, toUs: 2_000_000, text: longLine)
        let track = CaptionTrack(lines: [line])
        let settings = EditProject.Captions(show: true, size: 0.045, position: .bottom)
        let drawn = Looks.drawCaption(line, track: track, settings: settings, on: black, size: size, avoid: avoid)
        return (drawn.used, drawn.plate)
    }

    private func camera(_ corner: EditProject.CameraCorner) -> EditProject.Camera {
        var camera = EditProject.Camera(file: "camera.mov")
        camera.corner = corner
        return camera
    }

    /// The defect: on 1920 × 1080 the plate spanned x 160 to 1760 at the bubble's height.
    func testTheDefaultBubbleNarrowsALandscapeCaption() throws {
        let size = CGSize(width: 1920, height: 1080)
        let room = bubble(camera(.bottomRight), canvas: size)
        let free = try XCTUnwrap(draw(size, avoid: nil).plate)
        XCTAssertTrue(free.intersects(room), "the long line reaches under the bubble when nothing is in the way")

        let drawn = draw(size, avoid: room)
        let plate = try XCTUnwrap(drawn.plate)
        XCTAssertFalse(plate.intersects(room), "the plate \(plate) stays clear of the bubble \(room)")
        XCTAssertEqual(plate.minY, 54, accuracy: 1, "a narrowed plate keeps its place at the bottom")
        XCTAssertEqual(plate.midX, size.width / 2, accuracy: 1, "and stays centred")
        XCTAssertEqual(drawn.used, plate.maxY, accuracy: 1)
    }

    /// The bottom-left bubble narrows the plate from the other side.
    func testABottomLeftBubbleNarrowsFromTheLeft() throws {
        let size = CGSize(width: 1920, height: 1080)
        let room = bubble(camera(.bottomLeft), canvas: size)
        let plate = try XCTUnwrap(draw(size, avoid: room).plate)
        XCTAssertFalse(plate.intersects(room))
        XCTAssertEqual(plate.midX, size.width / 2, accuracy: 1)
    }

    /// On a phone-portrait canvas the room beside the bubble is under 0.45 of the width, so the plate lifts above it.
    func testAPortraitCaptionLiftsAboveTheBubble() throws {
        let size = CGSize(width: 1080, height: 1920)
        let room = bubble(camera(.bottomRight), canvas: size)
        let drawn = draw(size, avoid: room)
        let plate = try XCTUnwrap(drawn.plate)
        XCTAssertFalse(plate.intersects(room))
        XCTAssertGreaterThanOrEqual(plate.minY, room.maxY, "the plate sits above the bubble's top")
        XCTAssertEqual(drawn.used, plate.maxY, accuracy: 1, "the keys plate stacks above the moved caption")
    }

    /// A bubble at the top leaves a bottom caption alone.
    func testABubbleAtTheTopChangesNothing() throws {
        let size = CGSize(width: 1920, height: 1080)
        let free = try XCTUnwrap(draw(size, avoid: nil).plate)
        let plate = try XCTUnwrap(draw(size, avoid: bubble(camera(.topRight), canvas: size)).plate)
        XCTAssertEqual(plate, free)
    }
}
