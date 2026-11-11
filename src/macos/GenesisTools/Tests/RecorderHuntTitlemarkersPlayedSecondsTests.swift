import XCTest
@testable import GenesisToolsRecorder

/// Title Every Marker without the service gives each step title 2.5 s of the finished movie, as the TS markerTitleOps
/// does. Before, the title ended 2.5 s of SOURCE time after its marker, so a cut or a speed-up right after the marker
/// left it on screen for less, and a marker under 2.5 s before the next one had its title cover the next title.
final class RecorderHuntTitlemarkersPlayedSecondsTests: XCTestCase {
    private func project(_ clips: [EditProject.Clip]) -> EditProject {
        var project = EditProject.whole(video: "/movies/screen.mp4", durationUs: 20_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = clips
        return project
    }

    private func spans(_ texts: [EditOp.Text]) -> [[Double]] { texts.map { [$0.from, $0.to] } }

    func testATitleOverACutPlaysTwoAndAHalfSeconds() {
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 1_500_000), EditProject.Clip(id: "b", fromUs: 2_500_000, toUs: 20_000_000)])
        let titles = EditorModel.markerTitleTexts([(us: 1_000_000, label: "Open")], in: cut)
        XCTAssertEqual(spans(titles), [[1, 4.5]], "0.5 s before the cut and 2 s after it")
        XCTAssertEqual(titles.first?.text, "1. Open")
    }

    func testATitleOverASpedUpStretchPlaysTwoAndAHalfSeconds() {
        let fast = project([
            EditProject.Clip(id: "a", fromUs: 0, toUs: 2_000_000),
            EditProject.Clip(id: "b", fromUs: 2_000_000, toUs: 10_000_000, speed: 4),
            EditProject.Clip(id: "c", fromUs: 10_000_000, toUs: 20_000_000),
        ])
        XCTAssertEqual(spans(EditorModel.markerTitleTexts([(us: 1_000_000, label: "Open")], in: fast)), [[1, 8]])
    }

    func testATitleEndsByTheNextMarkersTitleAndSkipsACutMarker() {
        let cut = project([EditProject.Clip(id: "a", fromUs: 0, toUs: 5_000_000), EditProject.Clip(id: "b", fromUs: 6_000_000, toUs: 20_000_000)])
        let titles = EditorModel.markerTitleTexts([
            (us: 1_000_000, label: "Open"),
            (us: 2_000_000, label: "Pick"),
            (us: 5_500_000, label: "Cut away"),
        ], in: cut)
        XCTAssertEqual(spans(titles), [[1, 2], [2, 4.5]], "the cut marker has no title, so it bounds nothing")
        XCTAssertEqual(titles.map(\.text), ["1. Open", "2. Pick"])
    }
}
