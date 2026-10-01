import XCTest
@testable import GenesisKit

final class SessionTranscriptClientTests: XCTestCase {
    func testDecodePairsToolNameAndPreview() throws {
        let json = """
        {"provider":"claude","sessionId":"abc","filePath":"/tmp/abc.jsonl","byteSize":12,"truncated":false,"nextOffset":2,"turns":[{"id":"a1","role":"assistant","at":null,"text":"reading","tools":[{"id":"toolu_01","name":"Read","inputPreview":"SessionDetailsPane.swift","result":"struct Pane","isError":false}]}]}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))
        XCTAssertEqual(envelope.provider, "claude")
        XCTAssertEqual(envelope.turns.count, 1)
        XCTAssertEqual(envelope.turns[0].tools[0].name, "Read")
        XCTAssertEqual(envelope.turns[0].tools[0].inputPreview, "SessionDetailsPane.swift")
        XCTAssertEqual(envelope.turns[0].tools[0].result, "struct Pane")
    }

    func testArgumentsAskForJson() {
        XCTAssertEqual(
            SessionTranscriptClient.arguments(sessionId: "abc-def", limit: 40),
            ["sessions", "tail", "abc-def", "--json", "--limit", "40"]
        )
    }

    func testArgumentsCarryAnOffsetForAnEarlierPage() {
        XCTAssertEqual(
            SessionTranscriptClient.arguments(sessionId: "abc", limit: 100, offset: 120),
            ["sessions", "tail", "abc", "--json", "--limit", "100", "--offset", "120"]
        )
    }

    func testDecodeReadsExitCodeCostAndWindowStart() throws {
        let json = """
        {"provider":"claude","sessionId":"abc","filePath":"/tmp/abc.jsonl","byteSize":12,"truncated":true,"nextOffset":300,"totals":{"modelCalls":3,"costUsd":1.25},"turns":[{"id":"a1","role":"assistant","at":null,"text":"","tools":[{"id":"t1","name":"Bash","inputPreview":"false","result":"","isError":true,"exitCode":1,"resultChars":4096}]}]}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))
        XCTAssertEqual(envelope.turns[0].tools[0].exitCode, 1)
        XCTAssertEqual(envelope.turns[0].tools[0].resultChars, 4096)
        XCTAssertEqual(envelope.totals?.costUsd, 1.25)
        XCTAssertEqual(envelope.windowStart, 299)
        XCTAssertNil(envelope.turnCount, "an older tools prints no turn count")
    }

    func testDecodeReadsTheTranscriptTurnCount() throws {
        let json = """
        {"provider":"claude","sessionId":"abc","filePath":"/tmp/abc.jsonl","byteSize":12,"truncated":false,"nextOffset":150,"turnCount":420,"turns":[]}
        """
        let envelope = try SessionTranscriptClient.decode(Data(json.utf8))
        XCTAssertEqual(envelope.turnCount, 420)
        XCTAssertEqual(envelope.nextOffset, 150)
    }
}
