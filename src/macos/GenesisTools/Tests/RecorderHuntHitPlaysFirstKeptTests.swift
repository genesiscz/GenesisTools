import XCTest
@testable import GenesisToolsRecorder

/// A screen hit, a private-data hit or a wait plays from its first kept moment, the rule the transcript lines follow:
/// a hit whose start is cut still shows for the rest of its time, so the Find and Hide tabs seek there and do not call it
/// cut. Only a hit that is cut whole plays nowhere.
@MainActor
final class RecorderHuntHitPlaysFirstKeptTests: XCTestCase {
    private let folder = FileManager.default.temporaryDirectory.appendingPathComponent("hit-plays-\(UUID().uuidString)")

    /// A 10 s movie with 3..5 s cut: source 5 s plays at output 3 s.
    private func model(cutTo: Int64 = 5_000_000) -> EditorModel {
        var project = EditProject.whole(video: folder.appendingPathComponent("proxy.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        project.clips = [.init(id: "a", fromUs: 0, toUs: 3_000_000), .init(id: "b", fromUs: cutTo, toUs: 10_000_000)]
        return EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
    }

    private func hit(_ sec: Double, until: Double) throws -> ScreenHit {
        let raw: [String: Any] = ["sec": sec, "untilSec": until, "file": "frames/\(sec).png", "lines": ["Inbox"],
                                  "shown": true, "boxes": [], "ops": ["hide": [], "mark": [], "cut": []]]
        return try JSONDecoder().decode(ScreenHit.self, from: JSONSerialization.data(withJSONObject: raw))
    }

    func testAHitWhoseStartIsCutPlaysFromItsFirstKeptMoment() throws {
        let model = model()
        let halfCut = try hit(4, until: 8)
        XCTAssertEqual(halfCut.playsOut(in: model.project), 3_000_000, "source 5 s, the first kept moment, plays at 3 s")
        XCTAssertNil(try hit(3.5, until: 4.5).playsOut(in: model.project), "a hit inside the cut plays nowhere")
        XCTAssertEqual(try hit(1, until: 2).playsOut(in: model.project), 1_000_000)
    }

    func testTheFindTabSeeksToTheFirstShownFrame() throws {
        let model = model()
        model.screenHits = [try hit(4, until: 8)]
        model.goToScreenHit(0)
        XCTAssertEqual(model.clock.outUs, 3_000_000, "the playhead goes where the rest of the hit shows")
    }

    func testTheHideTabSeeksToTheFirstKeptMomentOfAHit() {
        let model = model()
        model.fxGo(toSource: 4, until: 8)
        XCTAssertEqual(model.clock.outUs, 3_000_000)
    }
}
