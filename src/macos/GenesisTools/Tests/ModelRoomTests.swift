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

    func testProposalRoundTripKeepsNullEvidenceAndRequiresFiniteAnswers() throws {
        let source = #"""
        {"sourceText":"Use 10 days with a 1 day step.",
         "proposal":{"format":"genesis-model-room-proposal","version":1,"title":"Draft","explanation":"Review me.",
         "time":{"unit":"day","duration":{"value":10,"sourceQuote":"10 days","question":""},
                 "step":{"value":1,"sourceQuote":"1 day step","question":""}},
         "quantities":[{"id":"rate","label":"Rate","kind":"input","unit":"ticket/day","description":"Unknown",
                        "seed":null,"value":{"value":null,"sourceQuote":null,"question":"Choose the rate."}}],
         "outputs":["rate"]},
         "missing":[{"key":"rate.value","label":"Rate","unit":"ticket/day","question":"Choose the rate."}],
         "warnings":["Check assumptions."]}
        """#
        let review = try JSONDecoder().decode(ModelRoomProposalReview.self, from: Data(source.utf8))
        let encoded = try JSONEncoder().encode(review)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        let proposal = try XCTUnwrap(object["proposal"] as? [String: Any])
        let quantities = try XCTUnwrap(proposal["quantities"] as? [[String: Any]])
        XCTAssertTrue(quantities[0]["seed"] is NSNull)
        let number = try XCTUnwrap(quantities[0]["value"] as? [String: Any])
        XCTAssertTrue(number["value"] is NSNull)
        XCTAssertTrue(number["sourceQuote"] is NSNull)
        XCTAssertNil(quantities[0]["expression"])

        let clock = ["time.duration": "10", "time.step": "1"]
        for raw in ["", " ", "-", "nan", "inf", "1,2"] {
            XCTAssertThrowsError(try review.answers(from: clock.merging(["rate.value": raw]) { _, new in new }))
        }
        let answers = try review.answers(from: clock.merging(["rate.value": " 2.5e1 "]) { _, new in new })
        XCTAssertEqual(answers["rate.value"], 25)
        XCTAssertEqual(review.assumptions.count, 3)
    }

    @MainActor
    func testReviewedProposalCreatesANewDirtyUntitledDocument() async throws {
        let original = fixture()
        defer { original.model.stop() }
        let before = try XCTUnwrap(original.model.file)
        var proposed = before
        proposed.title = "Reviewed proposal"
        proposed.quantities[0].value = 7
        let created = try ModelRoomDocument(reviewedFile: proposed)
        defer { created.model.stop() }

        XCTAssertNil(created.fileURL)
        XCTAssertEqual(created.model.file, proposed)
        XCTAssertEqual(original.model.file, before)
        await assertEdited(created, true)
        await assertEdited(original, false)
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

    @MainActor
    func testStructuralBranchEditsPreserveBaselineAndUndoAsAGroup() throws {
        let document = fixture()
        defer { document.model.stop() }
        document.model.file?.scenarios = [ModelRoomScenario(id: "alternative", label: "Alternative")]
        document.model.selectedScenario = "alternative"
        let before = document.model.file
        let undo = try XCTUnwrap(document.undoManager)
        undo.beginUndoGrouping()
        document.model.updateQuantity("agents", title: "Rename branch quantity") { $0.label = "Alternative team" }
        XCTAssertEqual(document.model.file?.quantities[0].label, "Agents")
        XCTAssertEqual(document.model.effectiveQuantities.first?.label, "Alternative team")
        document.model.addQuantity(label: "Staff hours", kind: "input", unit: "hour")
        XCTAssertEqual(document.model.file?.quantities.count, 1)
        XCTAssertEqual(document.model.selectedQuantity, "q_staff_hours")
        document.model.removeSelected()
        XCTAssertFalse(document.model.effectiveQuantities.contains { $0.id == "q_staff_hours" })
        document.model.selectedQuantity = "agents"
        document.model.removeSelected()
        XCTAssertEqual(document.model.file?.quantities.count, 1)
        XCTAssertTrue(document.model.effectiveQuantities.isEmpty)
        undo.endUndoGrouping()
        undo.undo()
        XCTAssertEqual(document.model.file, before)
    }

    func testChartValuesConvertCompatibleUnitsAndRefuseOtherDimensions() {
        let metres = ModelRoomEvaluatedQuantity(id: "length", label: "Length", kind: "input", unit: "m", scale: 1, dimension: "length")
        let centimetres = ModelRoomEvaluatedQuantity(id: "length", label: "Length", kind: "input", unit: "cm", scale: 0.01, dimension: "length")
        let hours = ModelRoomEvaluatedQuantity(id: "length", label: "Duration", kind: "input", unit: "hour", scale: 3600, dimension: "time")
        XCTAssertEqual(centimetres.convert(300, to: metres), 3)
        XCTAssertEqual(metres.convert(2, to: centimetres), 200)
        XCTAssertNil(hours.convert(3, to: metres))
        XCTAssertNil(metres.convert(Double.greatestFiniteMagnitude, to: centimetres))
    }

    @MainActor
    func testModelEditorIsOneUndoableEditAndRefusesStaleDrafts() throws {
        let document = fixture()
        defer { document.model.stop() }
        let original = try XCTUnwrap(document.model.file)
        var draft = original
        draft.title = "Updated capacity"
        draft.time.duration = 20
        draft.scenarios = [ModelRoomScenario(id: "plan", label: "Plan", interventions: [ModelRoomIntervention(at: 4, values: ["agents": 3], label: "New team")])]
        draft.presentation.steps = [ModelRoomPresentationStep(title: "Change team", text: "A deliberate assumption", scenario: "plan", time: 5)]
        let undo = try XCTUnwrap(document.undoManager)
        undo.beginUndoGrouping()
        try document.model.commitDraft(draft, replacing: original)
        undo.endUndoGrouping()
        XCTAssertEqual(document.model.file, draft)
        XCTAssertThrowsError(try document.model.commitDraft(original, replacing: original))
        XCTAssertEqual(document.model.file, draft)
        undo.undo()
        XCTAssertEqual(document.model.file, original)
        XCTAssertFalse(undo.canUndo)
        undo.redo()
        XCTAssertEqual(document.model.file, draft)
        var invalid = draft
        invalid.time.step = 0
        XCTAssertThrowsError(try document.model.commitDraft(invalid, replacing: draft))
        XCTAssertEqual(document.model.file, draft)
    }

    @MainActor
    func testMinimalDocumentDefaultsAndTransientEditorIdentityRoundTrip() throws {
        let source = """
        {"format":"genesis-model-room","version":1,"id":"minimal","title":"Minimal","time":{"unit":"day","duration":10,"step":1},"quantities":[{"id":"value","label":"Value","unit":"1","kind":"input","value":2}],"scenarios":[{"id":"other","label":"Other"}]}
        """
        var file = try JSONDecoder().decode(ModelRoomFile.self, from: Data(source.utf8))
        try file.validateForEditing()
        XCTAssertEqual(file.description, "")
        XCTAssertEqual(file.quantities[0].position, ModelRoomPoint(x: 0, y: 0))
        XCTAssertEqual(file.quantities[0].provenance, "assumption")
        XCTAssertEqual(file.scenarios[0].color, "#a9c9ff")
        file.scenarios[0].interventions = [ModelRoomIntervention(at: 4, values: ["value": 3], label: "Before")]
        let interventionID = file.scenarios[0].interventions[0].id
        file.scenarios[0].interventions[0].label = "After"
        file.scenarios[0].interventions[0].at = 5
        XCTAssertEqual(file.scenarios[0].interventions[0].id, interventionID)
        file.presentation.steps = [ModelRoomPresentationStep(title: "Before", text: "Explanation")]
        let stepID = file.presentation.steps[0].id
        file.presentation.steps[0].title = "After"
        XCTAssertEqual(file.presentation.steps[0].id, stepID)
        let bytes = try JSONEncoder().encode(file)
        let reopened = try JSONDecoder().decode(ModelRoomFile.self, from: bytes)
        XCTAssertEqual(reopened, file)
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains(interventionID.uuidString))
        XCTAssertFalse(String(decoding: bytes, as: UTF8.self).contains(stepID.uuidString))
    }

    @MainActor
    func testSubsystemImportIsOneUndoableRevisionAndRejectsAStalePreview() throws {
        let document = fixture()
        defer { document.model.stop() }
        let original = try XCTUnwrap(document.model.file)
        let source = ModelRoomSubsystemSource(
            url: URL(fileURLWithPath: "/fixture/team.subsystem.json"), original: original,
            preview: ModelRoomSubsystemChoices(
                packageFile: ModelRoomSubsystemPackage(format: "genesis-model-room-subsystem", version: 1, model: original, members: ["agents"], boundaryInputs: [], outputs: ["agents"]),
                choices: []
            )
        )
        var result = original
        var copied = original.quantities[0]
        copied.id = "team_agents"
        copied.position.x = 280
        result.quantities.append(copied)
        result.subsystems.append(ModelRoomSubsystem(id: "subsystem_team", label: "Team", description: "", quantities: ["team_agents"]))
        let preview = ModelRoomSubsystemImportResult(document: result, subsystemId: "subsystem_team", mapping: ["agents": "team_agents"], added: ["team_agents"], bound: [], outputs: ["team_agents"])
        let undo = try XCTUnwrap(document.undoManager)
        undo.beginUndoGrouping()
        try document.model.applySubsystemImport(preview, source: source)
        undo.endUndoGrouping()
        XCTAssertEqual(document.model.file, result)
        XCTAssertEqual(document.model.selectedQuantity, "team_agents")
        XCTAssertThrowsError(try document.model.applySubsystemImport(preview, source: source))
        XCTAssertEqual(document.model.file, result)
        undo.undo()
        XCTAssertEqual(document.model.file, original)
        XCTAssertFalse(undo.canUndo)
        undo.redo()
        XCTAssertEqual(document.model.file, result)
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
