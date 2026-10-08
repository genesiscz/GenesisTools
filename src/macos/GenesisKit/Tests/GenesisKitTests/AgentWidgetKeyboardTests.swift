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

    func testPhysicalNumberRowWorksWithNonNumericLayoutCharacters() {
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x12, characters: "+"), 1)
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x13, characters: "ě"), 2)
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x14, characters: "š"), 3)
    }

    func testNumericKeypadAndUnrelatedKeys() {
        XCTAssertEqual(AgentWidgetKeyboard.choiceNumber(keyCode: 0x54, characters: "2"), 2)
        XCTAssertNil(AgentWidgetKeyboard.choiceNumber(keyCode: 0, characters: "a"))
        XCTAssertNil(AgentWidgetKeyboard.choiceNumber(keyCode: 0, characters: "0"))
    }
}
