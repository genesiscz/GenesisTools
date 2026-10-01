import XCTest
@testable import GenesisKit

/// Martin, 2026-10-01: Edit and Write calls must show their input as the diff, as Claude Code does,
/// not the tool's "has been updated successfully" output.
final class ToolInputDiffTests: XCTestCase {
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
