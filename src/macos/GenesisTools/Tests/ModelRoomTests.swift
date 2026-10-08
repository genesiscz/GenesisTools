import AppKit
import GenesisKit
import XCTest
@testable import GenesisTools

final class ModelRoomTests: XCTestCase {
    @MainActor
    private func fixture() -> ModelRoomDocument {
        _ = NSApplication.shared
        let document = ModelRoomDocument()
        document.model.file = ModelRoomFile(
            id: "fixture", title: "Capacity fixture", description: "Invented test data", time: ModelRoomTime(unit: "day", duration: 10, step: 1),
            quantities: [ModelRoomQuantity(id: "agents", label: "Agents", unit: "people", range: ModelRoomRange(min: 1, max: 8, step: 1), position: ModelRoomPoint(x: 20, y: 20), kind: "input", value: 4)],
            scenarios: [], subsystems: [], presentation: ModelRoomPresentation(controls: ["agents"], outputs: ["agents"], steps: [])
        )
        document.undoManager?.groupsByEvent = false
        return document
    }

    @MainActor
    func testLongSliderGestureIsOneUndoAndRedo() async throws {
        let document = fixture()
        defer { document.model.stop() }
        let before = try XCTUnwrap(document.model.file)
        let undo = try XCTUnwrap(document.undoManager)

        undo.beginUndoGrouping()
        document.model.beginGesture()
        for index in 0...100 { document.model.setInput("agents", value: 1 + Double(index) * 0.05) }
        document.model.finishGesture()
        undo.endUndoGrouping()
        XCTAssertEqual(document.model.file?.quantities[0].value, 6)
        await assertEdited(document, true)
        XCTAssertTrue(undo.canUndo)
        undo.undo()
        XCTAssertEqual(document.model.file, before)
        await assertEdited(document, false)
        XCTAssertFalse(undo.canUndo, "A slider drag must not leave individual intermediate edits on the undo stack")
        XCTAssertTrue(undo.canRedo)
        undo.redo()
        XCTAssertEqual(document.model.file?.quantities[0].value, 6)
        await assertEdited(document, true)
    }

    @MainActor
    func testOptionDragRestoresExactScenarioAndBaseline() throws {
        let document = fixture()
        defer { document.model.stop() }
        let before = try XCTUnwrap(document.model.file)
        let undo = try XCTUnwrap(document.undoManager)
        undo.beginUndoGrouping()
        document.model.beginGesture(branch: true)
        document.model.setInput("agents", value: 3)
        document.model.finishGesture()
        undo.endUndoGrouping()
        let branch = document.model.selectedScenario
        XCTAssertFalse(branch.isEmpty)
        XCTAssertEqual(document.model.file?.quantities[0].value, 4)
        XCTAssertEqual(document.model.file?.scenarios.first?.overrides["agents"], 3)
        undo.undo()
        XCTAssertEqual(document.model.file, before)
        XCTAssertEqual(document.model.selectedScenario, "")
        XCTAssertFalse(undo.canUndo)
        undo.redo()
        XCTAssertEqual(document.model.selectedScenario, branch)
        XCTAssertEqual(document.model.file?.scenarios.first?.overrides["agents"], 3)
    }

    @MainActor
    func testDiscreteKeyboardOrAccessibilityEditIsUndoable() async throws {
        let document = fixture()
        defer { document.model.stop() }
        let undo = try XCTUnwrap(document.undoManager)
        let before = document.model.file
        undo.beginUndoGrouping()
        document.model.setInput("agents", value: 5)
        undo.endUndoGrouping()
        XCTAssertEqual(document.model.file?.quantities[0].value, 5)
        await assertEdited(document, true)
        undo.undo()
        XCTAssertEqual(document.model.file, before)
        await assertEdited(document, false)
        XCTAssertFalse(undo.canUndo)
    }

    func testNativeBuildOriginNeverSilentlySwitchesCheckouts() throws {
        let built = "/fixture/feature/tools"
        XCTAssertEqual(try AppToolsOrigin.resolve(configured: built, isExecutable: { $0 == built }, fallback: { "/fixture/main/tools" }), built)
        XCTAssertEqual(try AppToolsOrigin.resolve(configured: nil, isExecutable: { _ in false }, fallback: { "/fixture/legacy/tools" }), "/fixture/legacy/tools")
        XCTAssertThrowsError(try AppToolsOrigin.resolve(configured: built, isExecutable: { _ in false }, fallback: { "/fixture/main/tools" }))
    }

    func testCommandFailuresKeepTheUsefulMessageFromEitherChannel() {
        let stderr = ToolsRunResult(stdout: "", stderr: "ERROR: The observation file changed after its preview.\n", exitCode: 1, wallMs: 1)
        XCTAssertEqual(modelRoomCommandFailure(stderr).localizedDescription, "The observation file changed after its preview.")
        let structured = ToolsRunResult(stdout: "{\"error\":\"Invalid formula\"}", stderr: "extra diagnostics", exitCode: 1, wallMs: 1)
        XCTAssertEqual(modelRoomCommandFailure(structured).localizedDescription, "Invalid formula")
        let empty = ToolsRunResult(stdout: "", stderr: "", exitCode: 2, wallMs: 1)
        XCTAssertEqual(modelRoomCommandFailure(empty).localizedDescription, "The local tool failed with exit code 2.")
    }

    func testChartSamplingRetainsEndpointsAndNarrowExcursionsWithinBudget() {
        let frames = (0...10000).map { tick in
            ModelRoomFrame(tick: tick, time: Double(tick), values: ["value": tick == 5432 ? 1e6 : tick == 5433 ? -1e6 : Double(tick)])
        }
        let sampled = modelRoomChartSamples(frames, quantity: "value", limit: 128)
        XCTAssertLessThanOrEqual(sampled.count, 128)
        XCTAssertEqual(sampled.first?.tick, 0)
        XCTAssertEqual(sampled.last?.tick, 10000)
        XCTAssertTrue(sampled.contains { $0.tick == 5432 })
        XCTAssertTrue(sampled.contains { $0.tick == 5433 })
        XCTAssertEqual(sampled.map(\.tick), sampled.map(\.tick).sorted())
    }

    @MainActor
    func testUnsafeDocumentsNeverReplaceTheCurrentModel() throws {
        let document = fixture()
        defer { document.model.stop() }
        let before = try XCTUnwrap(document.model.file)
        var candidates: [ModelRoomFile] = []
        var value = before
        value.quantities[0].position.x = 1e12
        candidates.append(value)
        value = before
        value.presentation.steps = [ModelRoomPresentationStep(title: "Beyond time", text: "", time: 1e300)]
        candidates.append(value)
        value = before
        value.time.step = 0
        candidates.append(value)
        value = before
        value.quantities[0].range?.step = 0
        candidates.append(value)
        value = before
        value.quantities.append(value.quantities[0])
        candidates.append(value)
        value = before
        value.quantities[0].range = ModelRoomRange(min: -1e308, max: 1e308, step: 1)
        candidates.append(value)
        for candidate in candidates {
            let bytes = try JSONEncoder().encode(candidate)
            XCTAssertThrowsError(try document.read(from: bytes, ofType: "public.json"))
            XCTAssertEqual(document.model.file, before)
        }
    }

    @MainActor
    private func assertEdited(_ document: ModelRoomDocument, _ expected: Bool) async {
        // NSDocument schedules autosaving-safety work before processing undo change counts.
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { object, _ in
            MainActor.assumeIsolated { (object as? ModelRoomDocument)?.isDocumentEdited == expected }
        }, object: document)
        await fulfillment(of: [expectation], timeout: 2)
        XCTAssertEqual(document.isDocumentEdited, expected)
    }

    @MainActor
    func testDocumentRoundTripPreservesEditableValues() throws {
        let original = fixture()
        let reopened = ModelRoomDocument()
        defer { original.model.stop(); reopened.model.stop() }
        let data = try original.data(ofType: "public.json")
        try reopened.read(from: data, ofType: "public.json")
        XCTAssertEqual(reopened.model.file, original.model.file)
        XCTAssertEqual(reopened.model.selectedQuantity, "agents")
        XCTAssertThrowsError(try reopened.read(from: Data("{broken".utf8), ofType: "public.json"))
        XCTAssertEqual(reopened.model.file, original.model.file, "A failed open must not replace the current model")
    }
}
