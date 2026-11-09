import XCTest
@testable import GenesisToolsRecorder

/// A words field keeps what is being typed while the service stores it trimmed, and typing in a caption line is one
/// gesture and one undo step that never hides the line.
final class RecorderHuntTextFieldTypingTests: XCTestCase {
    func testTheDraftShowsWhileItIsTheStoredWordsTrimmed() {
        XCTAssertEqual(FieldDraft.shown(draft: "Hello ", stored: "Hello"), "Hello ", "the typed space stays")
        XCTAssertEqual(FieldDraft.shown(draft: "Hello\n", stored: "Hello"), "Hello\n")
        XCTAssertEqual(FieldDraft.shown(draft: "Hello ", stored: "Bye"), "Bye", "an undo or an agent's change shows")
        XCTAssertEqual(FieldDraft.shown(draft: nil, stored: "Bye"), "Bye")
        XCTAssertEqual(FieldDraft.shown(draft: "", stored: "Bye"), "Bye", "a refused empty value shows the stored words")
    }

    /// fixLine and unfixLine as the service applies them, keyed as TranscriptSettings.key keys a line.
    private static func rules(_ project: EditProject, _ op: [String: Any]) throws -> EditProject {
        var next = project
        let key = String(Int((((op["from"] as? Double) ?? 0) * 1000).rounded()))
        var settings = next.transcript ?? .init()
        switch op["op"] as? String {
        case "fixLine": settings.fixes[key] = (op["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        case "unfixLine": settings.fixes.removeValue(forKey: key)
        default: return try FakeRules.basic(project, op)
        }
        next.transcript = settings.fixes.isEmpty ? nil : settings
        return next
    }

    @MainActor
    func testTypingACaptionLineIsOneUndoStepAndNeverHidesIt() throws {
        let project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        let service = FakeServiceLink(project: project, rules: Self.rules)
        let model = EditorModel.on(service, store: ProjectStore(url: FileManager.default.temporaryDirectory.appendingPathComponent("typing-\(UUID().uuidString).json")))
        let line = CaptionTrack.Line(fromUs: 1_000_000, toUs: 2_000_000, text: "Hello")
        let key = EditProject.TranscriptSettings.key(line)

        model.typeCaption(line, text: "Hello ")
        model.typeCaption(line, text: "Hello w")
        model.typeCaption(line, text: "Hello wo")
        model.finishGesture()
        XCTAssertEqual(model.undoStack.count, 1, "three keystrokes are one undo step")
        XCTAssertEqual(model.undoName, "Caption Fix")
        XCTAssertEqual(model.project.transcript?.fixes[key], "Hello wo")

        model.typeCaption(line, text: "")
        model.typeCaption(line, text: "  ")
        model.finishGesture()
        XCTAssertEqual(model.project.transcript?.fixes[key], "Hello wo", "an empty field keeps the last fix, never hides the line")
        XCTAssertEqual(model.undoStack.count, 1)

        model.typeCaption(line, text: "Hello")
        model.finishGesture()
        XCTAssertNil(model.project.transcript?.fixes[key], "the transcript's own words take the fix back")
    }

    func testACaptionFixPastTheLimitIsRefused() {
        XCTAssertNil(EditLimits.captionFix.refusal(String(repeating: "a", count: 300)))
        XCTAssertNotNil(EditLimits.captionFix.refusal(String(repeating: "a", count: 301)))
    }
}
