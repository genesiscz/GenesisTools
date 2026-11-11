import XCTest
@testable import GenesisToolsRecorder

/// A part exported from the window is a clip of the movie without the intro and end cards, as `exportAs` in
/// src/recorder/lib/edit.ts makes it for the CLI, the REPL and the window's GIF, WebM and cleaned-sound route. A whole
/// export keeps the cards.
final class RecorderHuntPartExportCardsTests: XCTestCase {
    private func cardedProject() -> EditProject {
        // Output 0–2 plays source 0–2, 2–5 plays 3–6, 5–6 plays 6–8 at 2×.
        var project = EditProject(source: .init(video: "/m.mp4", durationUs: 8_000_000, width: 100, height: 100),
                                  clips: [.init(id: "a", fromUs: 0, toUs: 2_000_000), .init(id: "b", fromUs: 3_000_000, toUs: 6_000_000),
                                          .init(id: "c", fromUs: 6_000_000, toUs: 8_000_000, speed: 2)])
        project.cards = .init(intro: .init(title: "Demo", seconds: 3), end: .init(text: "Bye", seconds: 3))
        project.audio.voiceovers = [
            .init(id: "v-intro", atUs: 500_000, card: .intro, file: "/intro.mp3", durationUs: 1_000_000),
            .init(id: "v-movie", atUs: 3_500_000, file: "/movie.mp3", durationUs: 1_000_000),
            .init(id: "v-end", atUs: 0, card: .end, file: "/end.mp3", durationUs: 1_000_000),
        ]
        return project
    }

    func testAPartExportLeavesTheIntroAndEndCardsOut() throws {
        let project = cardedProject()
        let rendered = EditorModel.exportedProject(project, part: (1_000_000, 5_500_000))
        XCTAssertNil(rendered.cards, "a part is a clip of the movie, without the cards around it")
        XCTAssertEqual(rendered.clips.map { [$0.fromUs, $0.toUs] }, [[1_000_000, 2_000_000], [3_000_000, 6_000_000], [6_000_000, 7_000_000]])
        XCTAssertEqual(rendered.outputDurationUs, 4_500_000)
        let spans = CardSpans(project: rendered, enabled: true)
        XCTAssertEqual(spans.leadUs, 0)
        XCTAssertEqual(spans.tailUs, 0)
        // A voiceover on a card has no card to play over in the part, so the export leaves it out without an error.
        XCTAssertEqual(VoiceoverMix.exportPlacements(rendered, cards: spans).map(\.clip.id), ["v-movie"])
    }

    func testAWholeExportKeepsTheCards() {
        let project = cardedProject()
        let rendered = EditorModel.exportedProject(project, part: nil)
        XCTAssertEqual(rendered, project)
        let spans = CardSpans(project: rendered, enabled: true)
        XCTAssertEqual(spans.leadUs, 3_000_000)
        XCTAssertEqual(spans.tailUs, 3_000_000)
        XCTAssertEqual(VoiceoverMix.exportPlacements(rendered, cards: spans).map(\.clip.id), ["v-intro", "v-movie", "v-end"])
    }

    func testAPartPastTheMovieExportsTheWholeEdit() {
        let project = cardedProject()
        XCTAssertEqual(EditorModel.exportedProject(project, part: (7_000_000, 9_000_000)), project)
    }
}
