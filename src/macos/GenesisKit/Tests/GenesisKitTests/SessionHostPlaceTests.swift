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

    func testTheClientAsksTheCLIAndReadsARefusalAsAnAnswer() async throws {
        let payload = self.payload
        let calls = CallLog()
        let client = SessionHostClient { args, _ in
            await calls.add(args)
            if args[1] == "describe" {
                return ToolsRunResult(stdout: payload, stderr: "", exitCode: 0, wallMs: 1)
            }
            return ToolsRunResult(stdout: #"{"ok": false, "reason": "No live cmux pane holds this session.", "host": null}"#,
                                  stderr: "", exitCode: 1, wallMs: 1)
        }

        let answers = try await client.describe(["codex-1", "none-1"])
        XCTAssertEqual(answers.count, 4)
        let refused = try await client.act(.wake, sessionId: "claude-1")
        XCTAssertEqual(refused, SessionHostActResult(ok: false, reason: "No live cmux pane holds this session."))
        let logged = await calls.all
        XCTAssertEqual(logged, [
            ["session-host", "describe", "codex-1", "none-1", "--json"],
            ["session-host", "wake", "claude-1", "--json"],
        ])

        let silent = SessionHostClient { _, _ in
            ToolsRunResult(stdout: "", stderr: "[profile:x] 3ms\n✘ No cmux pane matches \"x\".\n  Searched 6 panes.", exitCode: 1, wallMs: 1)
        }
        let unread = try await silent.act(.focus, sessionId: "x")
        XCTAssertEqual(unread, SessionHostActResult(ok: false, reason: "No cmux pane matches \"x\"."))
    }

    /// An older `tools` without the command is the window's fallback case; any other failed describe is a failure.
    func testAnOlderToolsIsUnsupportedAndEveryOtherFailedDescribeIsAnError() async {
        let older = SessionHostClient { _, _ in
            ToolsRunResult(stdout: "", stderr: "error: unknown command 'session-host'\n(Did you mean sessions?)", exitCode: 1, wallMs: 1)
        }
        do {
            _ = try await older.describe(["s1"])
            XCTFail("an older tools must throw")
        } catch {
            XCTAssertEqual(error as? SessionHostClientError, .unsupported)
        }

        let broken = SessionHostClient { _, _ in
            ToolsRunResult(stdout: "", stderr: "✘ database is locked", exitCode: 1, wallMs: 1)
        }
        do {
            _ = try await broken.describe(["s1"])
            XCTFail("a failed describe must throw")
        } catch {
            XCTAssertNil(error as? SessionHostClientError)
            XCTAssertTrue("\(error)".contains("database is locked"))
        }
    }
}

private actor CallLog {
    private(set) var all: [[String]] = []
    func add(_ args: [String]) { all.append(args) }
}
