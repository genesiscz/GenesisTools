import XCTest
@testable import GenesisToolsRecorder

/// The voiceover row says a card's line does not play from the same rule the export lays it by
/// (VoiceoverMix.exportPlacements): a card that went away or ends before the line starts with nothing after it plays
/// nothing, and an intro line past its card runs on over the movie.
final class RecorderHuntCardVoiceoversTests: XCTestCase {
    private func project(introSeconds: Double?, endSeconds: Double?) -> EditProject {
        var project = EditProject(source: .init(video: "/m.mp4", durationUs: 8_000_000, width: 100, height: 100),
                                  clips: [.init(id: "a", fromUs: 0, toUs: 8_000_000)])
        project.cards = .init(intro: introSeconds.map { .init(title: "Demo", seconds: $0) },
                              end: endSeconds.map { .init(text: "Bye", seconds: $0) })
        project.audio.voiceovers = [
            .init(id: "v-intro", atUs: 2_500_000, card: .intro, file: "/intro.mp3", durationUs: 1_000_000),
            .init(id: "v-end", atUs: 3_000_000, card: .end, file: "/end.mp3", durationUs: 1_000_000),
        ]
        return project
    }

    private func placed(_ project: EditProject) -> [String] {
        VoiceoverMix.exportPlacements(project, cards: CardSpans(project: project, enabled: true)).map(\.clip.id)
    }

    func testACardLinePlaysOnlyWhereTheExportLaysIt() {
        XCTAssertEqual(placed(project(introSeconds: 3, endSeconds: 4)), ["v-intro", "v-end"])
        // The end card got shorter than the line's start: nothing follows the end card, so the line plays nowhere.
        XCTAssertEqual(placed(project(introSeconds: 3, endSeconds: 2)), ["v-intro"])
        // The intro card got shorter: its line runs on over the movie.
        XCTAssertEqual(placed(project(introSeconds: 2, endSeconds: 4)), ["v-intro", "v-end"])
        // The intro card is gone: its line plays nothing.
        XCTAssertEqual(placed(project(introSeconds: nil, endSeconds: 4)), ["v-end"])
    }
}
