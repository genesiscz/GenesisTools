import XCTest
@testable import GenesisToolsRecorder

/// The export's length is the intro card, the movie and the end card, as the file plays them and as info().exportTime
/// names it; the movie's own length (outputDurationUs) stays without its cards.
final class RecorderHuntR2ExportLengthCardsTests: XCTestCase {
    private func project() -> EditProject {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 6_091_667, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.cards = EditProject.Cards(intro: EditProject.IntroCard(title: "Demo", seconds: 3),
                                          end: EditProject.EndCard(text: "Thanks", seconds: 4))
        return project
    }

    func testTheExportLengthAddsTheIntroAndTheEndCard() {
        XCTAssertEqual(CardSpans.exportLengthUs(project()), 13_091_667)
        XCTAssertEqual(CardSpans.cardsNote(project()), "3.0 s intro + 4.0 s end card")
    }

    func testAnEditWithoutCardsExportsTheMovieAlone() {
        var plain = project()
        plain.cards = nil
        XCTAssertEqual(CardSpans.exportLengthUs(plain), 6_091_667)
        XCTAssertNil(CardSpans.cardsNote(plain))
        plain.cards = EditProject.Cards(intro: nil, end: EditProject.EndCard(text: "Thanks", seconds: 2))
        XCTAssertEqual(CardSpans.exportLengthUs(plain), 8_091_667)
        XCTAssertEqual(CardSpans.cardsNote(plain), "2.0 s end card")
    }
}
