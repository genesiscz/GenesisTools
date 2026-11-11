import XCTest
@testable import GenesisToolsRecorder

/// A transition plays at most half of each neighbouring clip. fx.ts `transitionJoins` reports the same `halfUs`, and
/// info() reports it as `playsMs`; fx.test.ts "a transition next to a short clip" uses the same clips.
final class RecorderHuntTransitionLengthClampedTests: XCTestCase {
    /// a 0 to 5 s, b 8 to 8.3 s (absent when `short` is false) and c 10 to 20 s, with a 1000 ms crossfade everywhere.
    private func project(short: Bool, shortSpeed: Double = 1) -> EditProject {
        var project = EditProject.whole(video: "/movies/demo.mp4", durationUs: 20_000_000, width: 200, height: 100, cursor: nil, recording: nil)
        var clips = [EditProject.Clip(id: "a", fromUs: 0, toUs: 5_000_000)]
        if short {
            clips.append(EditProject.Clip(id: "b", fromUs: 8_000_000, toUs: 8_300_000, speed: shortSpeed))
        }
        clips.append(EditProject.Clip(id: "c", fromUs: 10_000_000, toUs: 20_000_000))
        project.clips = clips
        project.transitions = EditProject.Transitions(default: .init(kind: .crossfade, ms: 1000))
        return project
    }

    func testAJoinNextToAShortClipIsHeldInsideHalfOfIt() throws {
        let short = project(short: true)
        let joins = TransitionLook.joins(in: short)
        XCTAssertEqual(joins.map(\.clip), ["b", "c"])
        XCTAssertEqual(joins.map(\.atUs), [5_000_000, 5_300_000])
        XCTAssertEqual(joins.map(\.halfUs), [150_000, 150_000], "half of the 0.3 s clip on each join")
        XCTAssertNil(TransitionLook.mark(atOutputUs: 4_800_000, project: short, track: nil), "before the 150 ms half")
        let first = try XCTUnwrap(TransitionLook.mark(atOutputUs: 4_925_000, project: short, track: nil))
        XCTAssertEqual(first.progress, 0.25, accuracy: 0.001)
    }

    func testTwoLongNeighboursPlayTheWholeLength() {
        XCTAssertEqual(TransitionLook.joins(in: project(short: false)).map(\.halfUs), [500_000])
    }

    func testASpedUpShortClipHoldsHalfOfItsOutputLength() {
        let joins = TransitionLook.joins(in: project(short: true, shortSpeed: 2))
        XCTAssertEqual(joins.map(\.atUs), [5_000_000, 5_150_000])
        XCTAssertEqual(joins.map(\.halfUs), [75_000, 75_000], "b at 2x plays 0.15 s")
    }
}
