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
        let options = RecorderMenu.menuOptions(sound: .saved, saved: saved)
        XCTAssertEqual(options, saved)
        XCTAssertTrue(options.countdown)
        XCTAssertTrue(options.camera)
        XCTAssertFalse(options.microphone)
    }

    func testRecordScreenWithAudioTurnsBothSourcesOn() {
        let options = RecorderMenu.menuOptions(sound: .microphoneAndSystem, saved: saved)
        XCTAssertTrue(options.systemAudio)
        XCTAssertTrue(options.microphone)
        XCTAssertTrue(options.camera)
        XCTAssertTrue(options.countdown)
    }

    /// Q10: the system-only row keeps the microphone off even when the saved choice has it on.
    func testRecordScreenWithSystemAudioOnlyLeavesTheMicrophoneOff() {
        var withMic = saved
        withMic.microphone = true
        let options = RecorderMenu.menuOptions(sound: .systemOnly, saved: withMic)
        XCTAssertTrue(options.systemAudio)
        XCTAssertFalse(options.microphone)
        XCTAssertTrue(options.camera)
    }

    /// A new menu command crosses the socket after the older ones, so an older process still reads their numbers.
    func testTheMenuCommandNumbersStayPut() {
        XCTAssertEqual(RecorderMenu.Command.recordScreenWithAudio.rawValue, 2)
        XCTAssertEqual(RecorderMenu.Command.quit.rawValue, 6)
        XCTAssertEqual(RecorderMenu.Command.recordScreenWithSystemAudio.rawValue, 7)
    }

    /// The menu's start passes the camera on, so the start leaves the preview out of the movie.
    func testAMenuStartWithTheCameraLeavesThePreviewOut() {
        let options = RecorderMenu.menuOptions(sound: .saved, saved: saved)
        let plan = CapturePicker.startPlan(choice: .followPointer, options: options, previewWindowIDs: [77])
        XCTAssertTrue(plan.previewLeftOut)
        XCTAssertTrue(plan.arguments.contains("--camera"))
    }
}
