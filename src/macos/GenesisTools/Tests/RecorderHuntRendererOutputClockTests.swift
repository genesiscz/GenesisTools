import XCTest
@testable import GenesisToolsRecorder

/// Fades, draw-ons, eases and click discs run their ms in the movie as it plays: a sped-up part does not shorten them,
/// and an item whose start was cut comes in from its first shown frame. Items keep their source times (those say when
/// they show). Zooms that play closer than one ease out and one ease in, a cut between them included, are linked.
final class RecorderHuntRendererOutputClockTests: XCTestCase {
    /// 0-4 s at 1x (output 0-4 s), 4-10 s at 4x (output 4-5.5 s), 10-20 s at 1x (output 5.5-15.5 s).
    private func sped() -> EditProject {
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 4_000_000), .init(id: "b", fromUs: 4_000_000, toUs: 10_000_000, speed: 4),
                         .init(id: "c", fromUs: 10_000_000, toUs: 20_000_000)]
        return project
    }

    private func whole() -> EditProject {
        EditProject.whole(video: "/tmp/x.mp4", durationUs: 20_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
    }

    private func look(_ project: EditProject, _ outUs: Int64, cursor: CursorTrack? = nil) -> ZoomState.FrameLook {
        ZoomState(project: project, cursor: cursor).look(atOutput: outUs)
    }

    func testAZoomEasesInAndOutOverItsMsOfPlayedTimeInASpedUpClip() {
        // The zoom covers source 5-9 s, which plays from output 4.25 s to 5.25 s at 4x.
        let zoom = EditProject.Zoom(id: "z", startUs: 5_000_000, endUs: 9_000_000, scale: 2)
        var fast = sped(), plain = whole()
        fast.zooms = [zoom]
        plain.zooms = [zoom]
        // 100 ms into the 450 ms ease in, and 100 ms before the end, as at 1x.
        XCTAssertEqual(look(fast, 4_350_000).view.scale, look(plain, 5_100_000).view.scale, accuracy: 0.01)
        XCTAssertLessThan(look(fast, 4_350_000).view.scale, 1.9, "not fully in after 100 ms")
        XCTAssertEqual(look(fast, 4_700_000).view.scale, 2, accuracy: 0.0001, "in after 450 ms")
        XCTAssertEqual(look(fast, 5_150_000).view.scale, look(plain, 8_900_000).view.scale, accuracy: 0.01)
    }

    func testZoomsThatTouchAcrossACutStayLinked() {
        // 2-5 s and 10-13 s with 5-10 s cut: they touch in what plays, so the view holds instead of blinking out.
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 5_000_000), .init(id: "b", fromUs: 10_000_000, toUs: 20_000_000)]
        project.zooms = [EditProject.Zoom(id: "a", startUs: 2_000_000, endUs: 5_000_000, scale: 2),
                         EditProject.Zoom(id: "b", startUs: 10_000_000, endUs: 13_000_000, scale: 2)]
        for outUs in stride(from: Int64(4_500_000), through: 5_500_000, by: 50_000) {
            XCTAssertEqual(look(project, outUs).view.scale, 2, accuracy: 0.0001, "at output \(outUs) µs")
        }
    }

    func testAZoomThatRunsIntoACutEasesOutInsideItAndTheRestOfItsEaseInPlayedTime() {
        // 0-4 s plays at 2x (output 0-2 s), 4-5 s is cut. A zoom to 4.8 s ends inside the cut, so it holds to the cut.
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 4_000_000, speed: 2), .init(id: "b", fromUs: 5_000_000, toUs: 20_000_000)]
        project.zooms = [EditProject.Zoom(id: "z", startUs: 1_000_000, endUs: 4_800_000, scale: 2)]
        XCTAssertEqual(look(project, 1_995_000).view.scale, 2, accuracy: 0.0001)
        // A zoom to 4.2 s has 200 ms of its ease out in the cut. 50 ms of play before the cut, 250 ms of it are left.
        project.zooms = [EditProject.Zoom(id: "z", startUs: 1_000_000, endUs: 4_200_000, scale: 2)]
        var plain = whole()
        plain.zooms = project.zooms
        XCTAssertEqual(look(project, 1_950_000).view.scale, look(plain, 3_950_000).view.scale, accuracy: 0.0001)
        XCTAssertLessThan(look(project, 1_950_000).view.scale, 1.9)
    }

    func testATextAShapeASpotlightAndALensFadeOverPlayedTime() {
        // Each covers source 4.5-9 s: it plays from output 4.125 s for 1.125 s at 4x.
        var project = sped()
        project.texts = [EditProject.TextNote(id: "t", startUs: 4_500_000, endUs: 9_000_000, text: "Fast")]
        project.shapes = [EditProject.Shape(id: "s", startUs: 4_500_000, endUs: 9_000_000, kind: .circle, x1: 0.2, y1: 0.2, x2: 0.4, y2: 0.4)]
        project.redactions = [EditProject.Redaction(id: "r", startUs: 4_500_000, endUs: 9_000_000, x: 0.1, y: 0.1, width: 0.2, height: 0.2,
                                                    style: .spotlight)]
        project.lens = EditProject.Lens(items: [EditProject.LensItem(id: "l", startUs: 4_500_000, endUs: 9_000_000, follow: false)])
        let frame = look(project, 4_225_000)
        XCTAssertEqual(frame.texts.first?.opacity ?? -1, 0.5, accuracy: 0.01, "100 ms into a 200 ms fade")
        XCTAssertEqual(frame.shapes.first?.drawn ?? -1, 1.0 / 3, accuracy: 0.01, "100 ms into a 300 ms draw-on")
        XCTAssertEqual(frame.spotlightFade, 0.5, accuracy: 0.01)
        XCTAssertEqual(frame.lenses.first?.opacity ?? -1, 0.5, accuracy: 0.01)
        // 100 ms before its last shown frame (output 5.25 s) it is half way out.
        XCTAssertEqual(look(project, 5_150_000).texts.first?.opacity ?? -1, 0.5, accuracy: 0.01)
    }

    func testATypewriterTypesOverItsMsOfPlayedTimeInASpedUpClip() throws {
        // Source 4.5-9 s plays from output 4.125 s at 4x: 150 ms after that, a 600 ms typewriter has typed a quarter.
        var project = sped()
        var note = EditProject.TextNote(id: "t", startUs: 4_500_000, endUs: 9_000_000, text: "ABCDEFGHIJKLMNOPQRST")
        note.animate = EditProject.TextAnimate(kind: .typewriter, ms: 600)
        project.texts = [note]
        let text = try XCTUnwrap(look(project, 4_275_000).texts.first)
        XCTAssertEqual(text.sinceUs, 150_000, "the time it has played, not the 600 ms of the recording that passed")
        XCTAssertEqual(TextMotion.at(sinceUs: text.sinceUs, note: text.note).characters, 5)
        XCTAssertEqual(TextMotion.at(sinceUs: look(project, 4_725_000).texts.first?.sinceUs, note: note).characters, 20)
    }

    func testATextWhoseStartIsCutFadesInFromItsFirstShownFrame() {
        // 0.5-1.5 s is cut; the text starts at 1 s, so its first shown frame is source 1.5 s, output 0.5 s.
        var project = whole()
        project.clips = [.init(id: "a", fromUs: 0, toUs: 500_000), .init(id: "b", fromUs: 1_500_000, toUs: 20_000_000)]
        project.texts = [EditProject.TextNote(id: "t", startUs: 1_000_000, endUs: 4_000_000, text: "Late")]
        XCTAssertEqual(look(project, 550_000).texts.first?.opacity ?? -1, 0.25, accuracy: 0.01)
        XCTAssertEqual(look(project, 800_000).texts.first?.opacity ?? -1, 1, accuracy: 0.001)
    }

    func testAClickDiscRunsItsDurationOfPlayedTimeAndEndsAtACut() {
        var project = sped()
        project.clicks = EditProject.Clicks(highlight: true, durationMs: 400)
        let track = CursorTrack(samples: [CursorTrack.Sample(ms: 0, x: 0.5, y: 0.5), CursorTrack.Sample(ms: 5000, x: 0.3, y: 0.3, click: "left"),
                                          CursorTrack.Sample(ms: 15_000, x: 0.5, y: 0.5)])
        // The click at source 5 s plays at output 4.25 s; 200 ms later its disc is half way.
        XCTAssertEqual(look(project, 4_450_000, cursor: track).marks.map(\.progress), [0.5])
        XCTAssertEqual(look(project, 4_700_000, cursor: track).marks, [], "gone after its 400 ms")
        // Across a cut the picture under the disc is gone, so the disc is too.
        var cut = whole()
        cut.clicks = EditProject.Clicks(highlight: true, durationMs: 400)
        cut.clips = [.init(id: "a", fromUs: 0, toUs: 5_100_000), .init(id: "b", fromUs: 10_000_000, toUs: 20_000_000)]
        XCTAssertEqual(look(cut, 5_050_000, cursor: track).marks.map(\.progress), [0.125])
        XCTAssertEqual(look(cut, 5_150_000, cursor: track).marks, [])
    }
}
