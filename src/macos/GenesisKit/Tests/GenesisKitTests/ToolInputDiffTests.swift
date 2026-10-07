import XCTest
@testable import GenesisKit

/// Martin, 2026-10-01: Edit and Write calls must show their input as the diff, as Claude Code does,
/// not the tool's "has been updated successfully" output.
final class ToolInputDiffTests: XCTestCase {
    func testNativeUsageRefreshAndCacheReuseTrackAppendAndReplacement() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("native-store-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("session.jsonl")
        func message(_ id: Int, input: Int) -> String {
            #"{"type":"assistant","uuid":"a\#(id)","message":{"id":"m\#(id)","model":"claude-opus","usage":{"input_tokens":\#(input)},"content":[]}}"# + "\n"
        }
        try message(1, input: 10).write(to: file, atomically: true, encoding: .utf8)
        let store = SessionNativeLogStore()
        let first = try XCTUnwrap(store.load(path: file.path))
        XCTAssertTrue(first === store.load(path: file.path))
        let writer = try FileHandle(forWritingTo: file)
        try writer.seekToEnd()
        try writer.write(contentsOf: Data(message(2, input: 100).utf8))
        let same = try XCTUnwrap(store.load(path: file.path))
        XCTAssertTrue(first === same)
        XCTAssertEqual(same.summary.total.inputTokens, 110)
        XCTAssertEqual(same.summary.total.modelCalls, 2)
        let bytes = same.appendedBytesRead
        XCTAssertEqual(same.refreshSummarySnapshot().total.inputTokens, 110)
        XCTAssertEqual(same.appendedBytesRead, bytes)

        let update = message(2, input: 120)
        let split = update.utf8.count / 2
        try writer.write(contentsOf: Data(update.utf8.prefix(split)))
        XCTAssertEqual(same.refreshSummarySnapshot().total.inputTokens, 110)
        try writer.write(contentsOf: Data(update.utf8.dropFirst(split)))
        let summary = same.refreshSummarySnapshot()
        XCTAssertEqual(summary.total.inputTokens, 130)
        XCTAssertEqual(summary.total.modelCalls, 2)
        XCTAssertEqual(summary.usage(fromTurn: "a2", untilTurn: nil)?.inputTokens, 120)
        XCTAssertEqual(summary, SessionNativeLog.scan(path: file.path)?.summary)
        try writer.close()

        try message(3, input: 7).write(to: file, atomically: true, encoding: .utf8)
        let replaced = try XCTUnwrap(store.load(path: file.path))
        XCTAssertFalse(replaced === same)
        XCTAssertEqual(replaced.summary.total.inputTokens, 7)
        let tiny = SessionNativeLogStore(byteLimit: 1)
        XCTAssertFalse(tiny.load(path: file.path) === tiny.load(path: file.path))
    }

    private func line(_ name: String, input: String, result: String) -> TranscriptToolLine {
        TranscriptToolLine(
            toolId: "toolu_1", name: name, displayName: name, symbol: "pencil", keyArgument: input, input: input,
            result: result, status: .ok, exitCode: nil, resultChars: nil, duration: nil
        )
    }

    /// A sub-agent's file is all sidechain lines; its calls must still have their input.
    func testASidechainCallHasItsEditInput() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tool-input-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("agent-a1.jsonl")
        let lines = [
            #"{"type":"assistant","isSidechain":true,"uuid":"u1","message":{"id":"m1","model":"claude-opus","content":[{"type":"tool_use","id":"toolu_1","name":"Edit","input":{"file_path":"/tmp/x.swift","old_string":"let a = 1","new_string":"let a = 2"}}]}}"#,
            #"{"type":"user","isSidechain":true,"uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","content":"The file /tmp/x.swift has been updated successfully."}]}}"#,
        ]
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        let log = try XCTUnwrap(SessionNativeLog.scan(path: file.path))
        let detail = try XCTUnwrap(log.detail(for: "toolu_1"), "a sidechain call lost its input")
        XCTAssertEqual(detail.edits, [ToolEditPair(old: "let a = 1", new: "let a = 2")])
    }

    /// Codex encrypts a spawn_agent message; the opened call shows a marker, not the base64 (2026-10-02).
    func testACodexEncryptedMessageOpensAsAMarker() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tool-input-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("rollout-codex.jsonl")
        let token = "gAAAAAB" + String(repeating: "Qx9_-", count: 40) + "=="
        let arguments = #"{\"task_name\":\"pr589_astra\",\"message\":\""# + token + #"\"}"#
        let lines = [
            #"{"type":"response_item","payload":{"type":"function_call","name":"spawn_agent","call_id":"call_1","arguments":""# + arguments + #""}}"#,
            #"{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"ok"}}"#,
        ]
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        let log = try XCTUnwrap(SessionNativeLog.scan(path: file.path))
        let shown = try XCTUnwrap(log.detail(for: "call_1")?.arguments)
        XCTAssertFalse(shown.contains("gAAAAA"), shown)
        XCTAssertTrue(shown.contains("[encrypted by Codex, \(token.count) chars]"), shown)
        XCTAssertTrue(shown.contains("pr589_astra"), shown)
    }

    /// The TypeScript marker accepts `[A-Za-z0-9_=-]` only; a non-ASCII letter is not a Codex token.
    func testANonASCIITokenLookalikeIsNotRedacted() {
        let lookalike = "gAAAAAB" + String(repeating: "é", count: 45)
        XCTAssertEqual(SessionNativeLog.withoutEncryptedToken(lookalike) as? String, lookalike)
        let token = "gAAAAAB" + String(repeating: "Qx9_-", count: 9)
        XCTAssertEqual(SessionNativeLog.withoutEncryptedToken(token) as? String, "[encrypted by Codex, \(token.count) chars]")
    }

    /// Codex records a script's commands, patches and MCP calls as `item_completed` events, keyed by
    /// the item id. The transcript clips their output at 2,000 characters; opening one shows all of it.
    func testACodexItemOpensWithItsFullInputAndOutput() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tool-input-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let file = dir.appendingPathComponent("rollout-codex-items.jsonl")
        let output = (1...400).map { "line \($0) of the build log" }.joined(separator: "\\n")
        let expected = output.replacingOccurrences(of: "\\n", with: "\n")
        XCTAssertGreaterThan(expected.count, 2000)
        let lines = [
            #"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"exec-1","command":["/bin/zsh","-lc","make build"],"aggregated_output":""# + output + #"","exit_code":0}}}"#,
            #"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"FileChange","id":"patch-1","status":"completed","changes":{"/tmp/a.swift":{"type":"update","unified_diff":"@@ -1 +1 @@\n-let a = 1\n+let a = 2"}}}}}"#,
            #"{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"McpToolCall","id":"mcp-1","server":"docs","tool":"lookup","arguments":{"query":"swift","limit":3},"result":{"content":[{"type":"text","text":"found 3"}]}}}}"#,
        ]
        try (lines.joined(separator: "\n") + "\n").write(to: file, atomically: true, encoding: .utf8)
        let log = try XCTUnwrap(SessionNativeLog.scan(path: file.path))

        let command = try XCTUnwrap(log.detail(for: "exec-1"), "a command item has no detail")
        XCTAssertEqual(command.command, "make build")
        XCTAssertEqual(command.fullResult, expected)

        let patch = try XCTUnwrap(log.detail(for: "patch-1")?.patch, "a file change item has no patch")
        XCTAssertTrue(patch.contains("*** Update File: /tmp/a.swift"), patch)
        XCTAssertTrue(patch.contains("+let a = 2"), patch)

        let mcp = try XCTUnwrap(log.detail(for: "mcp-1"), "an MCP item has no detail")
        XCTAssertTrue(mcp.arguments?.contains(#""query" : "swift""#) == true, mcp.arguments ?? "nil")
        XCTAssertEqual(mcp.fullResult, "found 3")
    }

    func testAnEditDrawsItsDiffFirstWithTheStatusUnder() {
        let detail = ToolCallDetail(filePath: "/tmp/x.swift", edits: [ToolEditPair(old: "let a = 1", new: "let a = 2")])
        let shown = ToolPresentation.make(
            line: line("Edit", input: "/tmp/x.swift", result: "The file /tmp/x.swift has been updated successfully."),
            loaded: ToolLoaded(detail: detail), context: 0, cwd: "/tmp"
        )
        XCTAssertTrue(shown.inputFirst)
        XCTAssertEqual(shown.block?.lines.map(\.mark), [.removed, .added])
        XCTAssertEqual(shown.block?.lines.map(\.number), [1, 1], "no file line known: numbers count from the hunk")
        XCTAssertFalse(shown.summary.contains("successfully"))
    }

    func testAWriteIsAllAddedLines() {
        let detail = ToolCallDetail(filePath: "/tmp/new.txt", content: "one\ntwo\n")
        let shown = ToolPresentation.make(line: line("Write", input: "/tmp/new.txt", result: "File created successfully"), loaded: ToolLoaded(detail: detail), context: 0, cwd: nil)
        XCTAssertEqual(shown.block?.lines.map(\.mark), [.added, .added])
        XCTAssertEqual(shown.bodyCap, ToolPresentation.writeCap)
    }

    func testAnEditNotLoadedYetDoesNotShowTheToolsBoilerplate() {
        let shown = ToolPresentation.make(
            line: line("Edit", input: "/tmp/x.swift", result: "The file /tmp/x.swift has been updated successfully. (file state is current in your context)"),
            loaded: nil, context: 0, cwd: "/tmp"
        )
        XCTAssertEqual(shown.summary, "Updated x.swift")
    }

    func testAClosedRowCountsItsLinesWithoutBuildingTheBlock() {
        for result in ["     1→a\n     2→b\n     3→c\n", "one\ntwo", "only", "x\n\ny\n"] {
            let call = line("Read", input: "/tmp/a.swift", result: result)
            let open = ToolPresentation.make(line: call, loaded: nil, context: 0, cwd: "/tmp")
            let closed = ToolPresentation.make(line: call, loaded: nil, context: 0, cwd: "/tmp", body: false)
            XCTAssertEqual(closed.summary, open.summary, result)
            XCTAssertNotNil(open.block, result)
            XCTAssertNil(closed.block, result)
        }
    }
}
