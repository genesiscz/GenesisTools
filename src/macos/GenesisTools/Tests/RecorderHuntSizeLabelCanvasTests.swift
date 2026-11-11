import XCTest
@testable import GenesisToolsRecorder

/// The editor's "N px" size labels name the pixels the export draws: on the export's planned canvas, in the unit the
/// renderer sizes each value by.
final class RecorderHuntSizeLabelCanvasTests: XCTestCase {
    private func portrait() -> EditProject {
        var project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.frame = EditProject.Frame(aspect: .portrait)
        project.export.maxHeight = 1080
        return project
    }

    func testATextSizeIsTheFontSizeTheExportDraws() {
        let project = portrait()
        let canvas = EditRenderer.plannedOutput(export: project.export, source: CGSize(width: 1920, height: 1080),
                                                aspect: .portrait, nominalFps: nil).canvas
        let note = EditProject.TextNote(id: "t", startUs: 0, endUs: 1_000_000, text: "Hello", size: 0.05)
        XCTAssertEqual(SizeBasis.canvasShort.pixels(0.05, in: project, atLeast: 8),
                       Int(Looks.textPlateStyle(note, size: canvas).fontSize), "the 9:16 canvas, not the source's 1080")
        XCTAssertEqual(SizeBasis.canvasShort.pixels(0.001, in: project, atLeast: 8), 8, "a text is never drawn under 8 px")
    }

    func testTheClickRingsAndAShapeLineUseThePicture() {
        let project = portrait()
        let picture = EditRenderer.plannedOutput(export: project.export, source: CGSize(width: 1920, height: 1080),
                                                 aspect: .portrait, nominalFps: nil).picture
        XCTAssertEqual(SizeBasis.pictureHeight.pixels(0.03, in: project), Int((0.03 * picture.height).rounded()))
        XCTAssertEqual(SizeBasis.pictureShort.pixels(0.01, in: project), Int((0.01 * min(picture.width, picture.height)).rounded()))
    }
}
