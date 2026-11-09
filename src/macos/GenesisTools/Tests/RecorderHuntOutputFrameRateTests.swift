import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// The editor's frame step and the motion blur's previous frame use the frame of the movie as it plays (24, 25, 30 or
/// 60 fps), not a fixed 60 fps frame, and the blur's longest smear is a share of the picture, not a pixel count.
final class RecorderHuntOutputFrameRateTests: XCTestCase {
    func testTheFrameStepLandsOnTheNextFrameOfTheMoviesRate() {
        XCTAssertEqual(EditorModel.steppedUs(from: 1_000_000, frames: 1, frameUs: 33_333), 1_033_333)
        XCTAssertEqual(EditorModel.steppedUs(from: 1_000_000, frames: -1, frameUs: 33_333), 966_667)
        XCTAssertEqual(EditorModel.steppedUs(from: 1_000_000, frames: 1, frameUs: 16_667), 1_016_667)
        XCTAssertEqual(EditorModel.steppedUs(from: 1_000_000, frames: 1, frameUs: 40_000), 1_040_000)
        // A clock between two frames goes to the next frame of the grid, so every press shows a new frame.
        XCTAssertEqual(EditorModel.steppedUs(from: 1_016_667, frames: 1, frameUs: 33_333), 1_033_333)
        XCTAssertEqual(EditorModel.steppedUs(from: 1_016_667, frames: -1, frameUs: 33_333), 1_000_000)
        XCTAssertEqual(EditorModel.steppedUs(from: 1_033_333, frames: 1, frameUs: 33_333), 1_066_667)
        // ⇧ steps one second at any rate.
        XCTAssertEqual(EditorModel.steppedUs(from: 1_000_000, frames: EditorModel.framesPerSecond(frameUs: 33_333), frameUs: 33_333),
                       2_000_000)
        XCTAssertEqual(EditorModel.framesPerSecond(frameUs: 41_667), 24)
        XCTAssertEqual(EditRenderer.frameUs(fps: 30), 33_333)
        XCTAssertEqual(EditRenderer.frameUs(fps: 25), 40_000)
    }

    func testTheMotionBlursPreviousFrameIsOneFrameOfTheMoviesRate() throws {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 20_000_000, width: 1920, height: 1080,
                                        cursor: nil, recording: nil)
        // The zoom's ease in changes the scale every frame, so each previous frame has its own scale.
        project.zooms = [EditProject.Zoom(id: "z", startUs: 1_000_000, endUs: 5_000_000, scale: 2, easeInMs: 1000)]
        project.motion = .init(blur: 0.5)
        let state = ZoomState(project: project, cursor: nil)
        state.setFrameUs(40_000)
        let outUs: Int64 = 1_400_000
        let look = state.look(atOutput: outUs)
        let expected = ZoomCurve.view(atSource: outUs - 40_000, project: project, cursor: nil)
        let previous = try XCTUnwrap(look.previousView)
        XCTAssertEqual(previous.scale, expected.scale, accuracy: 0.000_001)
        let sixty = ZoomCurve.view(atSource: outUs - 16_667, project: project, cursor: nil)
        XCTAssertNotEqual(previous.scale, sixty.scale, accuracy: 0.000_001)
    }

    func testTheLongestSmearIsAShareOfThePicture() {
        XCTAssertEqual(Looks.maxMotionBlur(width: 2228), 24, accuracy: 0.000_001)
        XCTAssertEqual(Looks.maxMotionBlur(width: 4456), 48, accuracy: 0.000_001)
    }
}
