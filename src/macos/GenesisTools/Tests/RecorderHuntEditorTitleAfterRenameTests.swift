import XCTest
@testable import GenesisToolsRecorder

/// An open editor follows a rename: recording.json is the truth, and the CLI rewrites it with no service involved.
final class RecorderHuntEditorTitleAfterRenameTests: XCTestCase {
    @MainActor
    func testARenameOfRecordingJsonReachesTheOpenEditor() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("title-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let manifest = folder.appendingPathComponent("recording.json")
        try Data(#"{"title":"Before"}"#.utf8).write(to: manifest)
        let project = EditProject.whole(video: folder.appendingPathComponent("proxy.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let service = FakeServiceLink(project: project, rules: FakeRules.basic)
        let model = EditorModel.on(service, store: ProjectStore(url: folder.appendingPathComponent("edit.json")))
        defer { model.close() }
        XCTAssertEqual(model.title, "Before")

        let renamed = expectation(description: "the editor hears the new title")
        model.onTitleChange = { title in
            if title == "After" { renamed.fulfill() }
        }
        // The CLI writes it atomically: a new file renamed over the old one.
        try Data(#"{"title":"After"}"#.utf8).write(to: manifest, options: .atomic)
        wait(for: [renamed], timeout: 5)
    }
}
