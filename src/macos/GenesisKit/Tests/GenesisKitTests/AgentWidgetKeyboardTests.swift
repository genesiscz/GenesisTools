import XCTest

@testable import GenesisKit

final class AgentWidgetKeyboardTests: XCTestCase {
    func testReceiptSourceContextDecodesWithoutInventingNativeIDs() throws {
        let data = Data(#"{"id":"answer:fixture","kind":"answer","sessionKey":"fixture","sourceId":"fixture","at":1700000000000,"title":"Question","body":"Answer","status":"answered","choices":[],"attachments":[],"refs":[],"read":false,"sourceContext":{"sessionId":"fixture-session","agent":"codex","agentLabel":"Worker","branch":"feat/example","commitSha":"abc123","cwd":"/fixture/project","isWorktree":true,"worktreePath":"/fixture/worktree"},"transcriptAnchor":{"kind":"receipt-time","provider":"codex","sessionId":"fixture-session","receivedAt":1700000000000}}"#.utf8)
        let card = try JSONDecoder().decode(WidgetCard.self, from: data)
        XCTAssertEqual(card.sourceContext?.agentLabel, "Worker")
        XCTAssertEqual(card.sourceContext?.branch, "feat/example")
        XCTAssertEqual(card.sourceContext?.worktreePath, "/fixture/worktree")
        XCTAssertEqual(card.transcriptAnchor?.kind, "receipt-time")
        XCTAssertNil(card.transcriptAnchor?.messageId)
    }

    func testLegacyReceiptStillDecodesWithoutSourceContext() throws {
        let data = Data(#"{"id":"answer:fixture","kind":"answer","sessionKey":"fixture","sourceId":"fixture","at":1700000000000,"title":"Question","body":"Answer","status":"answered","choices":[],"attachments":[],"refs":[],"read":false}"#.utf8)
        let card = try JSONDecoder().decode(WidgetCard.self, from: data)
        XCTAssertNil(card.sourceContext)
        XCTAssertNil(card.transcriptAnchor)
    }

}
