import XCTest
@testable import GenesisToolsRecorder

/// The editor's Click sound switch turns on the tick only: on an edit with no clicks settings it does not draw rings.
final class RecorderHuntClickSoundWithoutRingsTests: XCTestCase {
    private func fresh() -> EditProject {
        EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
    }

    func testClickSoundSwitchOnAFreshEditLeavesTheRingsOff() throws {
        let project = fresh()
        XCTAssertNil(project.clicks)
        var next = project
        next.clicks = EditProject.Clicks.settingSound(true, in: project.clicks)
        XCTAssertEqual(next.clicks?.highlight, false, "the sound switch made the clicks object, so the rings stay off")
        XCTAssertEqual(next.clicks?.sound, true)

        let ops = try XCTUnwrap(EditOpDiff.ops(from: project, to: next))
        XCTAssertEqual(ops.count, 1)
        guard case let .clicks(op) = ops.first else { return XCTFail("expected one clicks op, got \(ops)") }
        XCTAssertEqual(op.highlight, false, "the window asks the service for no rings")
        XCTAssertEqual(op.sound, true)
    }

    func testClickSoundSwitchKeepsRingsThatAreAlreadyOn() {
        let ringed = EditProject.Clicks(highlight: true, color: "#FF453A")
        let on = EditProject.Clicks.settingSound(true, in: ringed)
        XCTAssertEqual(on.highlight, true, "turning the sound on never turns existing rings off")
        XCTAssertEqual(on.color, "#FF453A")
        XCTAssertEqual(on.sound, true)

        let off = EditProject.Clicks.settingSound(false, in: on)
        XCTAssertEqual(off.highlight, true, "turning the sound off keeps the rings")
        XCTAssertNil(off.sound, "no click sound is written as absent")
    }

    func testClickSoundSwitchOffOnASoundOnlyEditLeavesNothingOn() {
        let soundOnly = EditProject.Clicks.settingSound(true, in: nil)
        let off = EditProject.Clicks.settingSound(false, in: soundOnly)
        XCTAssertEqual(off.highlight, false)
        XCTAssertNil(off.sound)
    }
}
