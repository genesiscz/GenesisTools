import XCTest
@testable import GenesisToolsRecorder

/// The camera preview shows while it records only when its window reached the movie's `--exclude-window-ids` at the
/// start: ScreenCaptureKit ignores the panel's sharing type, so a preview the movie did not leave out is baked into
/// it, and a frame, a zoom or a bubble change then shows two faces.
final class RecorderHuntCameraPreviewLeftOutTests: XCTestCase {
    private var cameraOn: CaptureOptions {
        var options = CaptureOptions()
        options.camera = true
        return options
    }

    /// The Start shortcut runs `choose(.followPointer)` with the picker closed: once the preview is up, its window is
    /// in the arguments, so the movie leaves it out.
    func testTheShortcutStartLeavesTheShownPreviewOut() {
        let plan = CapturePicker.startPlan(choice: .followPointer, options: cameraOn, previewWindowIDs: [77])
        XCTAssertEqual(plan.arguments, ["recorder", "start", "--fps", "60", "--camera", "--exclude-window-ids", "77"])
        XCTAssertTrue(plan.previewLeftOut)
    }

    /// No preview window (camera access off, or the setting is "Never"): the start says it left nothing out, which
    /// keeps the preview off while it records.
    func testAStartWithNoPreviewWindowSaysThePreviewWasNotLeftOut() {
        let plan = CapturePicker.startPlan(choice: .followPointer, options: cameraOn, previewWindowIDs: [])
        XCTAssertFalse(plan.previewLeftOut)
        XCTAssertEqual(plan.previewLeftOut, plan.arguments.contains("--exclude-window-ids"))
    }

    /// The countdown panel is left out too, and it does not count as the preview.
    func testTheCountdownPanelIsLeftOutButIsNotThePreview() {
        let plan = CapturePicker.startPlan(choice: .followPointer, options: cameraOn, previewWindowIDs: [], panels: [91])
        XCTAssertEqual(Array(plan.arguments.suffix(2)), ["--exclude-window-ids", "91"])
        XCTAssertFalse(plan.previewLeftOut)
        let both = CapturePicker.startPlan(choice: .followPointer, options: cameraOn, previewWindowIDs: [77], panels: [91])
        XCTAssertEqual(Array(both.arguments.suffix(2)), ["--exclude-window-ids", "77,91"])
        XCTAssertTrue(both.previewLeftOut)
    }

    /// With the camera off a preview window on screen (the picker was open) is no part of the start.
    func testACameraOffStartIgnoresThePreviewWindow() {
        let plan = CapturePicker.startPlan(choice: .followPointer, options: CaptureOptions(), previewWindowIDs: [77])
        XCTAssertEqual(plan.arguments, ["recorder", "start", "--fps", "60"])
        XCTAssertFalse(plan.previewLeftOut)
    }

    /// A preview the movie did not leave out never shows, whatever the setting says.
    func testAPreviewThatWasNotLeftOutNeverShows() {
        for policy in CameraPreviewPolicy.allCases {
            for startedByPicker in [true, false] {
                XCTAssertFalse(policy.showsPreview(startedByPicker: startedByPicker, previewLeftOut: false),
                               "\(policy) startedByPicker \(startedByPicker)")
            }
        }
    }

    /// Left out, the setting decides as before: every camera recording, picker ones only, or never.
    func testALeftOutPreviewFollowsTheSetting() {
        XCTAssertTrue(CameraPreviewPolicy.everyCameraRecording.showsPreview(startedByPicker: false, previewLeftOut: true))
        XCTAssertTrue(CameraPreviewPolicy.pickerRecordings.showsPreview(startedByPicker: true, previewLeftOut: true))
        XCTAssertFalse(CameraPreviewPolicy.pickerRecordings.showsPreview(startedByPicker: false, previewLeftOut: true))
        XCTAssertFalse(CameraPreviewPolicy.never.showsPreview(startedByPicker: true, previewLeftOut: true))
    }
}
