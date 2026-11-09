import XCTest
@testable import GenesisToolsRecorder

/// The menu bar's Record Screen rows start through the picker's one start path with the saved options, so the
/// countdown, the camera bubble and the audio toggles apply there as they do for the Start shortcut and the picker.
final class RecorderHuntMenuRecordScreenOptionsTests: XCTestCase {
    private var saved: CaptureOptions {
        var options = CaptureOptions()
        options.countdown = true
        options.camera = true
        options.microphone = false
        options.systemAudio = false
        return options
    }

    func testRecordScreenKeepsTheSavedCountdownCameraAndAudio() {
        let options = RecorderMenu.menuOptions(audio: false, saved: saved)
        XCTAssertEqual(options, saved)
        XCTAssertTrue(options.countdown)
        XCTAssertTrue(options.camera)
        XCTAssertFalse(options.microphone)
    }

    func testRecordScreenWithAudioTurnsBothSourcesOn() {
        let options = RecorderMenu.menuOptions(audio: true, saved: saved)
        XCTAssertTrue(options.systemAudio)
        XCTAssertTrue(options.microphone)
        XCTAssertTrue(options.camera)
        XCTAssertTrue(options.countdown)
    }

    /// The menu's start passes the camera on, so the start leaves the preview out of the movie.
    func testAMenuStartWithTheCameraLeavesThePreviewOut() {
        let options = RecorderMenu.menuOptions(audio: false, saved: saved)
        let plan = CapturePicker.startPlan(choice: .followPointer, options: options, previewWindowIDs: [77])
        XCTAssertTrue(plan.previewLeftOut)
        XCTAssertTrue(plan.arguments.contains("--camera"))
    }
}
