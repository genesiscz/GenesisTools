import XCTest
@testable import GenesisToolsRecorder

/// The drag tag over a timeline segment and the inspector's Lasts rows name how long an item plays in the edit, the
/// segment's own width on the ruler, and add its length in the recording when a clip speed or a cut makes the two
/// differ. The tag starts where the segment starts, also when the item's first moment was cut.
final class RecorderHuntDragTagPlayedLengthTests: XCTestCase {
    private func project(_ clips: [EditProject.Clip]) -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        return project
    }

    func testTheDragTagOverAFasterClipShowsThePlayedLengthAndTheRecordingLength() {
        let fast = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000),
                            EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000, speed: 2)])
        XCTAssertEqual(DragTimeTag.label(project: fast, startUs: 5_000_000, endUs: 8_000_000), "00:04.5 · 1.5 s, 3.0 s of the recording")
    }

    func testTheDragTagOfAnItemWhoseStartWasCutBeginsWhereItsSegmentDoes() {
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000),
                           EditProject.Clip(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        XCTAssertEqual(DragTimeTag.label(project: cut, startUs: 4_500_000, endUs: 7_000_000), "00:04.0 · 2.0 s, 2.5 s of the recording")
    }

    func testTheDragTagOverAPlainClipShowsOneLength() {
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 2_000_000),
                           EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000)])
        XCTAssertEqual(DragTimeTag.label(project: cut, startUs: 5_000_000, endUs: 6_500_000), "00:03.0 · 1.5 s")
    }

    func testThePlayedLengthAddsUpTheOutputSpansAtTheirSpeeds() {
        let eight = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000),
                             EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000, speed: 8)])
        XCTAssertEqual(TimelineMap.playedUs(fromUs: 5_000_000, toUs: 7_000_000, in: eight), 250_000, "check() rounds this to 0.3 s")
        XCTAssertEqual(editLength(eight, fromUs: 5_000_000, toUs: 7_000_000), "0.3 s, 2.0 s of the recording", "the same tenth as check()")
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000),
                           EditProject.Clip(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        XCTAssertEqual(TimelineMap.playedUs(fromUs: 3_000_000, toUs: 7_000_000, in: cut), 3_000_000, "the cut second plays no time")
        XCTAssertEqual(TimelineMap.playedUs(fromUs: 4_200_000, toUs: 4_800_000, in: cut), 0, "all of it was cut")
    }

    func testTheInspectorLengthNamesTheRecordingLengthOnlyWhenTheTwoDiffer() {
        let fast = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000),
                            EditProject.Clip(id: "b", fromUs: 4_000_000, toUs: 10_000_000, speed: 2)])
        XCTAssertEqual(editLength(fast, fromUs: 5_000_000, toUs: 8_000_000), "1.5 s, 3.0 s of the recording")
        XCTAssertEqual(editLength(fast, fromUs: 1_000_000, toUs: 3_000_000), "2.0 s", "a part at speed 1 plays its own length")
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 4_000_000),
                           EditProject.Clip(id: "b", fromUs: 5_000_000, toUs: 10_000_000)])
        XCTAssertEqual(editLength(cut, fromUs: 4_200_000, toUs: 4_800_000), "0.0 s, 0.6 s of the recording", "all of it was cut")
        // 3.00 s against 3.02 s: under the 0.05 s check() also ignores, so one length.
        let slight = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 10_000_000, speed: 1.006)])
        XCTAssertEqual(editLength(slight, fromUs: 1_000_000, toUs: 4_020_000), "3.0 s")
    }
}
