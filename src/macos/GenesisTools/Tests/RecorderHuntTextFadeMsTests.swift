import XCTest
@testable import GenesisToolsRecorder

/// A text's `animate { kind: fade, ms }` fades it in over its ms, as the API, the toolset doc and the editor's "Takes"
/// slider say: the opacity envelope of ZoomState.texts takes the ms (textFadeInUs), and TextMotion adds no second
/// fade. A text with no animate keeps the 0.2 s fade of ZoomState.texts alone.
final class RecorderHuntTextFadeMsTests: XCTestCase {
    func testAFadeWithALengthFadesInOverIt() {
        var note = EditProject.TextNote(id: "t", startUs: 0, endUs: 6_000_000, text: "Slow title")
        note.animate = EditProject.TextAnimate(kind: .fade, ms: 2000)
        XCTAssertEqual(ZoomState.textFadeInUs(note, playedUs: 6_000_000), 2_000_000, "the envelope fades in over the ms")
        XCTAssertEqual(TextMotion.at(sinceUs: 0, note: note).opacity, 1, accuracy: 0.001, "no second fade on top of it")
        XCTAssertEqual(TextMotion.at(sinceUs: 1_000_000, note: note).opacity, 1, accuracy: 0.001)
        let half = TextMotion.at(sinceUs: 1_000_000, note: note)
        XCTAssertEqual(half.characters, 10, "a fade shows every letter")
        XCTAssertEqual(half.drop, 0, "a fade does not move")
    }

    func testATextWithoutAnimateKeepsTheShortFade() {
        let note = EditProject.TextNote(id: "t", startUs: 0, endUs: 6_000_000, text: "Slow title")
        XCTAssertEqual(TextMotion.at(sinceUs: 0, note: note), .init(characters: 10, opacity: 1, drop: 0))
        XCTAssertEqual(TextMotion.at(sinceUs: 300_000, note: note).opacity, 1)
    }

    func testTheDrawnOpacityFollowsTheLongFadeAndKeepsTheShortFadeOut() {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        var slow = EditProject.TextNote(id: "slow", startUs: 1_000_000, endUs: 4_000_000, text: "Slow")
        slow.animate = EditProject.TextAnimate(kind: .fade, ms: 2000)
        let plain = EditProject.TextNote(id: "plain", startUs: 1_000_000, endUs: 4_000_000, text: "Plain")
        project.texts = [slow, plain]
        // What drawText shows: the envelope of ZoomState.texts times the text's own motion.
        func shown(_ id: String, atSourceUs us: Int64) -> Double {
            guard let entry = ZoomState.texts(atSourceUs: us, project: project).first(where: { $0.note.id == id }) else { return 0 }
            return entry.opacity * TextMotion.at(sinceUs: us - entry.note.startUs, note: entry.note).opacity
        }
        XCTAssertEqual(shown("slow", atSourceUs: 1_300_000), 0.15, accuracy: 0.001, "0.3 s into a 2 s fade")
        XCTAssertEqual(shown("plain", atSourceUs: 1_300_000), 1, accuracy: 0.001, "the default fade is done after 0.2 s")
        XCTAssertEqual(shown("slow", atSourceUs: 2_000_000), 0.5, accuracy: 0.001)
        XCTAssertEqual(shown("slow", atSourceUs: 3_500_000), 1, accuracy: 0.001)
        XCTAssertEqual(shown("slow", atSourceUs: 3_900_000), 0.5, accuracy: 0.001, "the 0.2 s fade-out stays")
        XCTAssertEqual(shown("plain", atSourceUs: 3_900_000), 0.5, accuracy: 0.001)
    }
}
