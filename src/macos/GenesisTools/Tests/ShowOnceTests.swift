import Foundation
import XCTest
@testable import GenesisTools

final class ShowOnceTests: XCTestCase {
    func testRecipeRoundTripPreservesTargetEvidenceAndRuntimeSecretDeclaration() throws {
        let source = """
        {"version":1,"id":"example","title":"Report","createdAt":"2026-10-06T00:00:00Z","allowedOrigins":["https://example.com"],"parameters":[{"name":"password","label":"Password","secret":true}],"steps":[{"id":"fill","title":"Fill password","enabled":true,"kind":"fill","locator":{"kind":"testId","value":"password","fingerprint":{"tag":"INPUT","role":"textbox","name":"Password"}},"pageUrl":"https://example.com/login","value":"{{password}}","evidence":{"eventId":"explicit-repair","url":"https://example.com/login","at":1,"detail":"User supplied runtime secret reference"}}]}
        """
        let recipe = try JSONDecoder().decode(ShowOnceRecipe.self, from: Data(source.utf8))
        let restored = try JSONDecoder().decode(ShowOnceRecipe.self, from: JSONEncoder().encode(recipe))
        XCTAssertEqual(restored, recipe)
        XCTAssertEqual(restored.steps[0].locator?.fingerprint?.name, "Password")
        XCTAssertNil(restored.parameters[0].defaultValue)
        XCTAssertEqual(restored.steps[0].value, "{{password}}")
    }
    func testNativeDecodeDoesNotInventMissingRequiredRecipeFields() {
        XCTAssertThrowsError(try JSONDecoder().decode(ShowOnceRecipe.self, from: Data("{\"version\":1}".utf8)))
    }
}

@MainActor
private final class ShowOnceFakeEngine: ShowOnceEngine {
    var onEvent: (([String: Any]) -> Void)?
    var onExit: ((String) -> Void)?
    var onRequest: (([String: Any]) throws -> Data)?
    func request(_ command: [String: Any]) async throws -> Data {
        if command["op"] as? String == "browsers" { return Data("[]".utf8) }
        return try onRequest?(command) ?? Data("{}".utf8)
    }
    func stop() {}
}

extension ShowOnceTests {
    @MainActor
    func testResumePreservesTheNextCheckpointReceivedBeforeAcknowledgement() async throws {
        let engine = ShowOnceFakeEngine()
        let model = ShowOnceModel(bridge: engine)
        let acknowledged = expectation(description: "resume acknowledged")
        model.checkpoint = ShowOnceProgress(runId: "run", stepId: "first", status: "checkpoint", message: "First", at: "1")
        engine.onRequest = { command in
            XCTAssertEqual(command["stepId"] as? String, "first")
            engine.onEvent?(["type": "progress", "event": ["runId": "run", "stepId": "second", "status": "checkpoint", "message": "Second", "at": "2"]])
            acknowledged.fulfill()
            return Data("{}".utf8)
        }
        model.resume()
        await fulfillment(of: [acknowledged], timeout: 1)
        XCTAssertEqual(model.checkpoint?.stepId, "second")
        XCTAssertEqual(model.checkpoint?.runId, "run")
    }
    @MainActor
    func testResumeClearsOnlyTheCheckpointAcknowledgedWithoutANewerEvent() async throws {
        let engine = ShowOnceFakeEngine()
        let model = ShowOnceModel(bridge: engine)
        let acknowledged = expectation(description: "resume acknowledged")
        model.checkpoint = ShowOnceProgress(runId: "run", stepId: "first", status: "checkpoint", message: "First", at: "1")
        engine.onRequest = { _ in acknowledged.fulfill(); return Data("{}".utf8) }
        model.resume()
        await fulfillment(of: [acknowledged], timeout: 1)
        XCTAssertNil(model.checkpoint)
    }
    @MainActor
    func testCancellationIsAvailableWithoutARecipeDuringSetupAndFirstRecording() {
        let engine = ShowOnceFakeEngine()
        let model = ShowOnceModel(bridge: engine)
        XCTAssertNil(model.recipe)
        XCTAssertFalse(model.canCancel)
        model.busy = true
        XCTAssertFalse(model.canCancel)
        model.starting = true
        XCTAssertTrue(model.canCancel)
        model.starting = false; model.recording = true
        XCTAssertTrue(model.canCancel)
        engine.onEvent?(["type": "recording-ended", "reason": "Deadline expired"])
        XCTAssertFalse(model.recording)
        XCTAssertFalse(model.canCancel)
        XCTAssertEqual(model.notice, "Deadline expired")
    }
}

extension ShowOnceTests {
    @MainActor
    func testExitedEngineStopsBothPipeReadersBeforeReportingExit() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { XCTAssertNoThrow(try FileManager.default.removeItem(at: directory)) }
        let engine = directory.appendingPathComponent("engine.sh")
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: engine)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: engine.path)
        let bridge = try ShowOnceBridge(toolsPath: engine.path)
        let exited = expectation(description: "engine exit")
        bridge.onExit = { _ in
            XCTAssertFalse(bridge.isReadingPipes)
            exited.fulfill()
        }
        await fulfillment(of: [exited], timeout: 2)
        XCTAssertFalse(bridge.isReadingPipes)
        bridge.onExit = nil
        bridge.stop()
    }
}
