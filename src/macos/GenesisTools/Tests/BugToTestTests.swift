import Foundation
import XCTest
@testable import GenesisTools

final class BugToTestTests: XCTestCase {
    private func recording() throws -> BugToTestRecording {
        try JSONDecoder().decode(BugToTestRecording.self, from: Data(#"""
        {"version":1,"id":"fixture","title":"Cart count","initialUrl":"http://localhost:1234/","actions":[{"id":"add","kind":"click","locator":{"kind":"testId","value":"add","fingerprint":{"tag":"BUTTON","role":"button","name":"Add one item"}},"sourceUrl":"http://localhost:1234/","excluded":false,"at":1}],"evidence":[{"id":"console","kind":"console","text":"Cart count displayed: 0","excluded":false,"at":2}],"expectation":{"description":"Adding one item shows 1","kind":"text","locator":{"kind":"testId","value":"count"},"expected":"1"},"workspace":"/fixture/isolated","triggerActionId":"add"}
        """#.utf8))
    }
    func testRecordingRoundTripPreservesReviewedActionIdentityAndTrigger() throws {
        let original = try recording()
        let restored = try JSONDecoder().decode(BugToTestRecording.self, from: JSONEncoder().encode(original))
        XCTAssertEqual(restored, original)
        XCTAssertEqual(restored.actions[0].locator?.fingerprint?.name, "Add one item")
        XCTAssertEqual(restored.triggerActionId, "add")
        XCTAssertTrue(restored.validForGeneration)
    }
    func testMissingAndAmbiguousExpectedBehaviorCannotEnableGeneration() throws {
        var file = try recording()
        file.expectation?.description = " "
        XCTAssertFalse(file.validForGeneration)
        file = try recording(); file.expectation?.kind = "visible"; file.expectation?.expected = "maybe"
        XCTAssertFalse(file.validForGeneration)
        file.expectation?.expected = "true"
        XCTAssertTrue(file.validForGeneration)
        file.initialUrl = "javascript:alert(1)"
        XCTAssertFalse(file.validForGeneration)
    }
    @MainActor
    func testEditingAnExpectationInvalidatesPriorWorkspaceAndGreenResult() throws {
        let model = BugToTestModel(toolsPath: "/fixture/tools")
        model.install(try recording())
        model.result = BugToTestResult(status: "passed", message: "Assertion passed", testHash: "old-hash", report: "/fixture/report.json", durationMs: 1, exitCode: 0)
        model.expected = "2"
        model.changed()
        XCTAssertNil(model.workspace)
        XCTAssertNil(model.result)
        XCTAssertEqual(model.expectation.expected, "2")
        XCTAssertTrue(model.canGenerate)
    }
    @MainActor
    func testExcludingTheTriggerCannotUseItsOldVerifiedFailure() throws {
        let model = BugToTestModel(toolsPath: "/fixture/tools")
        model.install(try recording())
        model.result = BugToTestResult(status: "intended-failure", message: "Expected 1, received 0", testHash: "old-hash", report: "/fixture/report.json", durationMs: 1, exitCode: 1)
        model.editAction("add") { $0.excluded = true }
        XCTAssertNil(model.result)
        XCTAssertNil(model.workspace)
        XCTAssertTrue(model.recording!.actions[0].excluded)
    }
    @MainActor
    func testAChangedExpectationCannotReceiveAnOldPendingGreenResult() async throws {
        let model = BugToTestModel(toolsPath: "/fixture/tools")
        model.install(try recording())
        let started = expectation(description: "Verification started")
        let finished = expectation(description: "Verification settled")
        var release: CheckedContinuation<Void, Never>?
        model.perform("Pending fixture verification") {
            defer { finished.fulfill() }
            await withCheckedContinuation { continuation in release = continuation; started.fulfill() }
            try Task.checkCancellation()
            model.result = BugToTestResult(status: "passed", message: "Old assertion passed", testHash: "old-hash", report: "/fixture/report.json", durationMs: 1, exitCode: 0)
        }
        await fulfillment(of: [started], timeout: 2)
        model.expected = "2"; model.changed()
        release?.resume()
        await fulfillment(of: [finished], timeout: 2)
        XCTAssertNil(model.result)
        XCTAssertNil(model.workspace)
        XCTAssertEqual(model.expectation.expected, "2")
        await model.shutdown()
    }
    func testSetupFailureHasDistinctNativeOutcome() {
        let result = BugToTestResult(status: "infrastructure-error", message: "Target count was 0", testHash: "hash", report: "/fixture/report.json", durationMs: 1, exitCode: 1)
        XCTAssertEqual(result.label, "Setup or selector failed")
        XCTAssertNotEqual(result.label, "Bug reproduced")
    }
}
