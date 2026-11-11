import XCTest
@testable import GenesisToolsRecorder

/// The window's undo list keeps in step with the service's journal: a drag whose ops change nothing makes no step on
/// the service, so it makes none in the window either, and the next ⌘Z still takes back the change before it.
final class RecorderHuntUndoRedoOneJournalTests: XCTestCase {
    @MainActor
    func testADragThatChangesNothingAddsNoUndoStep() throws {
        var project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        project.camera = EditProject.Camera(file: "camera.mov")
        let service = FakeServiceLink(project: project, rules: FakeRules.basic)
        let model = EditorModel.on(service, store: ProjectStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("undo-\(UUID().uuidString).json")))
        model.changeCamera(.init(size: 0.4))
        model.finishGesture()
        XCTAssertEqual(model.undoStack.count, 1)
        let name = model.undoName
        model.changeCamera(.init(size: 0.4))
        model.finishGesture()
        XCTAssertEqual(service.count("gesture.commit"), 2)
        XCTAssertEqual(model.undoStack.count, 1, "the drag that changed nothing is no step")
        XCTAssertEqual(model.undoName, name, "the Edit menu still names the real change")
        model.undo()
        XCTAssertEqual(model.project.camera?.size, project.camera?.size, "one ⌘Z takes back the size change")
        XCTAssertFalse(model.canUndo)
    }

    /// A service that says `changed: false` is believed even when its edit is not the drag's start (an agent's change
    /// came in during the drag and the window adopted it).
    func testTheAnswerSaysWhetherItChangedTheEdit() throws {
        let project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        let json = try JSONSerialization.jsonObject(with: JSONEncoder().encode(project))
        let data = try JSONSerialization.data(withJSONObject: ["revision": 3, "project": json, "changed": false])
        let answer = try JSONDecoder().decode(RecorderProtocol.EditAnswer.self, from: data)
        XCTAssertEqual(answer.changed, false)
        let older = try JSONSerialization.data(withJSONObject: ["revision": 3, "project": json])
        XCTAssertNil(try JSONDecoder().decode(RecorderProtocol.EditAnswer.self, from: older).changed)
    }
}
