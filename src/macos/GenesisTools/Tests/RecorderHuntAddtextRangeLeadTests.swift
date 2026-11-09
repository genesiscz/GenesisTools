import XCTest
@testable import GenesisToolsRecorder

/// A text added at the playhead starts its fade earlier but never inside a cut, and a text added from a dragged range
/// covers that range, as every other kind the range popover adds.
final class RecorderHuntAddtextRangeLeadTests: XCTestCase {
    private func cutProject() -> EditProject {
        var project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = [EditProject.Clip(id: "a", fromUs: 0, toUs: 2_000_000), EditProject.Clip(id: "b", fromUs: 6_000_000, toUs: 10_000_000)]
        return project
    }

    func testAtThePlayheadAfterACutTheLeadStaysInTheClip() {
        let project = cutProject()
        XCTAssertEqual(EditorModel.textStart(project: project, atOutput: 2_000_000, lengthUs: 3_000_000, lead: true), 6_000_000,
                       "the first frame of clip b, not a time in the cut")
        let fade = ZoomState.textFadeUs(lengthUs: 3_000_000)
        XCTAssertEqual(EditorModel.textStart(project: project, atOutput: 3_000_000, lengthUs: 3_000_000, lead: true),
                       7_000_000 - fade, "inside a clip the lead stays")
    }

    func testFromARangeTheTextStartsWhereTheRangeDoes() {
        let project = cutProject()
        XCTAssertEqual(EditorModel.textStart(project: project, atOutput: 3_000_000, lengthUs: 1_000_000, lead: false), 7_000_000)
    }
}
