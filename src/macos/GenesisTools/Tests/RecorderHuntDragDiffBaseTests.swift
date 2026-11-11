import XCTest
@testable import GenesisToolsRecorder

/// A drag's ops name the user's own change: items are matched by id, not by their place in the list (the service may
/// reorder them), and the window builds each step on its own draft, so an agent's item that arrives in a preview's
/// answer does not make the next step "a change that cannot be sent".
final class RecorderHuntDragDiffBaseTests: XCTestCase {
    private func project() -> EditProject {
        EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
    }

    func testItemsAreMatchedByIdNotByPlace() throws {
        var mark = project()
        mark.zooms = [EditProject.Zoom(id: "a", startUs: 1_000_000, endUs: 2_000_000),
                      EditProject.Zoom(id: "b", startUs: 5_000_000, endUs: 6_000_000)]
        var moved = mark
        moved.zooms[0].startUs = 5_500_000
        moved.zooms[0].endUs = 6_500_000
        var reordered = moved
        reordered.zooms = [moved.zooms[1], moved.zooms[0]]
        let expected = try XCTUnwrap(EditOpDiff.ops(from: mark, to: moved))
        XCTAssertFalse(expected.isEmpty)
        XCTAssertEqual(EditOpDiff.ops(from: mark, to: reordered), expected, "the service sorted b before a")
        XCTAssertEqual(EditOpDiff.ops(from: mark, to: mark), [])
        var added = mark
        added.zooms.append(EditProject.Zoom(id: "c", startUs: 8_000_000, endUs: 9_000_000))
        XCTAssertNil(EditOpDiff.ops(from: mark, to: added), "an added item still has its own op")
    }

    @MainActor
    func testAnAgentsZoomDuringATextDragKeepsTheDragOneStep() throws {
        var start = project()
        start.texts = [EditProject.TextNote(id: "t1", startUs: 0, endUs: 2_000_000, text: "A")]
        let service = FakeServiceLink(project: start, rules: { project, op in
            guard op["op"] as? String == "setText" else { return try FakeRules.basic(project, op) }
            var next = project
            if let index = next.texts?.firstIndex(where: { $0.id == op["id"] as? String }), let size = op["size"] as? Double {
                next.texts?[index].size = size
            }
            return next
        })
        let model = EditorModel.on(service, store: ProjectStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("drag-\(UUID().uuidString).json")))
        // The service answers a moment after each step, as a real one does.
        service.holdAnswers = true
        model.updateText("t1") { $0.size = 0.06 }
        service.deliver()
        try service.outside("edit.apply", ops: [["op": "zoom", "from": 5.0, "to": 6.0]], path: model.store.url.path)
        service.deliver()
        model.updateText("t1") { $0.size = 0.07 }
        service.deliver()
        XCTAssertEqual(model.project.zooms.count, 1, "the preview's answer shows the agent's zoom")
        model.updateText("t1") { $0.size = 0.08 }
        service.deliver()
        XCTAssertFalse(model.notice?.contains("cannot be sent") == true, "notice: \(model.notice ?? "none")")
        model.finishGesture()
        service.deliver()
        XCTAssertEqual(service.project.texts?.first?.size, 0.08)
        XCTAssertEqual(service.project.zooms.count, 1, "the agent's zoom stays")
        XCTAssertEqual(service.count("gesture.commit"), 1, "the drag is one gesture")
    }
}
