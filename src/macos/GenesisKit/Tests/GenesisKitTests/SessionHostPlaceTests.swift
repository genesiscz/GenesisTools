import XCTest
@testable import GenesisKitBase
@testable import GenesisKit

/// `tools ai session-host describe --json` as GenesisTools prints it (`SessionHostView` in
/// src/ai/lib/session-host/types.ts): a T3 Code thread, a cmux pane, a kind this build does not know, and no host.
final class SessionHostPlaceTests: XCTestCase {
    private let payload = """
    {"answers": [
      {"sessionId": "codex-1", "host": {"kind": "t3", "place": "T3 Code thread", "label": "Fixture thread", "live": false,
        "note": "Waiting in its T3 Code thread",
        "actions": {"focus": {"enabled": true, "tip": "Open the thread in T3 Code"},
                    "wake": {"enabled": true, "tip": "Send a poke"},
                    "keepalive": {"enabled": false, "reason": "T3 Code has no keepalive command."}}}},
      {"sessionId": "claude-1", "host": {"kind": "cmux", "place": "cmux pane", "label": "work · tab", "live": null,
        "note": "cmux is not reachable",
        "actions": {"focus": {"enabled": false, "reason": "cmux is not reachable: refused"},
                    "wake": {"enabled": false, "reason": "cmux is not reachable: refused"},
                    "keepalive": {"enabled": false, "reason": "cmux is not reachable: refused"}}}},
      {"sessionId": "later-1", "host": {"kind": "tmux", "place": "tmux window", "label": "main:2", "live": true,
        "note": "", "actions": {"focus": {"enabled": true, "tip": "Raise"}, "wake": {"enabled": true, "tip": "Poke"},
                                "keepalive": {"enabled": true, "tip": "Keep"}}}},
      {"sessionId": "none-1", "host": null, "reason": "No T3 Code thread or cmux pane holds this session."}
    ]}
    """

    func testDecodesEveryHostAndTheMissingOne() throws {
        let answers = try JSONDecoder().decode(SessionHostAnswers.self, from: Data(payload.utf8)).answers

        XCTAssertEqual(answers.map(\.sessionId), ["codex-1", "claude-1", "later-1", "none-1"])
        let t3 = try XCTUnwrap(answers[0].host)
        XCTAssertEqual(t3.label, "Fixture thread")
        XCTAssertEqual(t3.live, false)
        XCTAssertEqual(t3.symbol, "bubble.left.and.text.bubble.right")
        XCTAssertEqual(t3.actions.focus.help, "Open the thread in T3 Code")
        XCTAssertEqual(t3.actions.keepalive.help, "T3 Code has no keepalive command.")
        XCTAssertNil(answers[1].host?.live)
        XCTAssertEqual(answers[1].host?.symbol, "rectangle.split.2x1")
        XCTAssertEqual(answers[2].host?.symbol, "macwindow", "a host kind this build does not know still shows")
        XCTAssertNil(answers[3].host)
        XCTAssertEqual(answers[3].reason, "No T3 Code thread or cmux pane holds this session.")
    }
}
