import XCTest
@testable import GenesisToolsRecorder

/// The keys plate, the cursor's hide-after and the smooth cursor's fade run on the movie as it plays: a shortcut pressed
/// inside a cut shows no plate after the cut, and a sped-up part does not shorten the plate's time or the stillness
/// before the cursor hides.
final class RecorderHuntR2PointerOverlaysPlayedTimeTests: XCTestCase {
    private func whole() -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 20_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.keys = EditProject.Keys()
        return project
    }

    private func key(_ project: EditProject, _ track: CursorTrack, _ outUs: Int64) -> String? {
        ZoomState(project: project, cursor: track).look(atOutput: outUs).key?.label
    }

    private func clock(_ project: EditProject, _ outUs: Int64) -> CursorTrack.PlayedClock {
        CursorTrack.PlayedClock(placed: TimelineMap.placed(project), outUs: outUs)
    }

    /// A move at 0 s, one at 1 s, then the pointer stands still.
    private let still = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.1, y: 0.1), CursorTrack.Sample(ms: 1000, x: 0.5, y: 0.5),
                                              CursorTrack.Sample(ms: 15_000, x: 0.5, y: 0.5)])

    func testAShortcutPressedInsideACutShowsNoPlateAfterTheCut() {
        let track = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5), CursorTrack.Sample(ms: 5000, x: 0.5, y: 0.5, key: "⌃F13")])
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 4_000_000), .init(id: "b", fromUs: 6_000_000, toUs: 20_000_000)]
        XCTAssertNil(key(project, track, 4_100_000), "the press at 5 s was cut")
        // Control: uncut, the same press shows 1.1 s later.
        XCTAssertEqual(key(whole(), track, 6_100_000), "⌃F13")
    }

    func testACutPressDoesNotReplaceTheKeptPlateBeforeIt() {
        let track = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5), CursorTrack.Sample(ms: 3500, x: 0.5, y: 0.5, key: "⌘A"),
                                          CursorTrack.Sample(ms: 5000, x: 0.5, y: 0.5, key: "⌃F13")])
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 4_000_000), .init(id: "b", fromUs: 6_000_000, toUs: 20_000_000)]
        // ⌘A plays at 3.5 s; at output 4.1 s it is 0.6 s old in played time.
        XCTAssertEqual(key(project, track, 4_100_000), "⌘A")
        XCTAssertNil(key(project, track, 4_800_000), "1.3 s of play after ⌘A")
    }

    func testAPlateHoldsItsDurationOfPlayedTimeInASpedUpClip() {
        let track = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5), CursorTrack.Sample(ms: 2000, x: 0.5, y: 0.5, key: "⌘C")])
        var project = whole()
        // 0-1 s at 1x, 1-20 s at 4x: the press at 2 s plays at output 1.25 s.
        project.clips = [.init(id: "a", fromUs: 0, toUs: 1_000_000), .init(id: "b", fromUs: 1_000_000, toUs: 20_000_000, speed: 4)]
        XCTAssertEqual(key(project, track, 2_250_000), "⌘C", "1.0 s of play after the press")
        XCTAssertNil(key(project, track, 2_500_000), "1.25 s of play is past its 1.2 s")
        // Control: at speed 1 with no cut, the same clock as before.
        XCTAssertEqual(key(whole(), track, 3_000_000), "⌘C")
        XCTAssertNil(key(whole(), track, 3_300_000))
    }

    func testTheCursorHidesAfterItsStillnessInPlayedTime() {
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 20_000_000, speed: 4)]
        // Source 7 s plays at output 1.75 s: 1.5 s of play after the move at 1 s (output 0.25 s).
        XCTAssertEqual(still.visibility(atMs: 7000, hideAfterMs: 2000, clock: clock(project, 1_750_000)), 1)
        // 2.15 s of play: half way through the 300 ms fade.
        XCTAssertEqual(still.visibility(atMs: 9600, hideAfterMs: 2000, clock: clock(project, 2_400_000)), 0.5, accuracy: 0.01)
        // Control: without a clock, source time as before.
        XCTAssertEqual(still.visibility(atMs: 7000, hideAfterMs: 2000), 0)
    }

    func testACutStretchOfStillnessDoesNotCount() {
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 10_000_000, toUs: 20_000_000)]
        // Source 10.5 s plays at output 2.5 s: 1 s of play after the move at 1 s, then 0.5 s after the cut.
        XCTAssertEqual(still.visibility(atMs: 10_500, hideAfterMs: 2000, clock: clock(project, 2_500_000)), 1)
    }

    func testTheSmoothCursorFadesAfterItsIdleSecondsInPlayedTime() throws {
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 20_000_000, speed: 4)]
        let settings = EditProject.CursorSmooth(strength: 0.6, jitterPx: 3, idleFadeSeconds: 2)
        let mark = try XCTUnwrap(still.smoothMark(atMs: 7000, settings: settings, aspect: 0.5625, clock: clock(project, 1_750_000)))
        XCTAssertEqual(mark.opacity, 1)
        let plain = try XCTUnwrap(still.smoothMark(atMs: 7000, settings: settings, aspect: 0.5625))
        XCTAssertEqual(plain.opacity, 0)
    }
}
