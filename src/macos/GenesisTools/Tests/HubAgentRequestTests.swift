import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// `--agent <child>` opens the node that child names. An Agent call's id (`toolu_…`) names exactly one
/// node by its `toolUseId`; a node whose id merely starts with it, or whose name equals it, never wins.
@MainActor
final class HubAgentRequestTests: XCTestCase {
    func testAnExactToolUseIdBeatsEveryLooseMatch() {
        let call = "toolu_abc"
        func node(_ id: String, name: String? = nil, toolUseId: String? = nil) -> AgentNode {
            AgentNode(id: id, harness: "claude", kind: "subagent", name: name, status: "done", lastAt: "", toolUseId: toolUseId)
        }
        var index: [String: (parent: AgentParent?, node: AgentNode)] = [:]
        // Many loose matches: a dictionary walks them in an unspecified order, so a single-pass lookup
        // that takes the first match almost never lands on the exact one.
        for n in 0..<20 {
            index["p|decoy-\(n)"] = (nil, node("decoy-\(n)", name: call))
        }
        index["p|\(call)def"] = (nil, node("\(call)def"))
        index["p|agent-exact"] = (nil, node("agent-exact", toolUseId: call))

        XCTAssertEqual(HubAgentsModel.requested(child: call, parent: nil, in: index)?.key, "p|agent-exact")
    }

    func testAnExactIdBeatsAPrefix() {
        func node(_ id: String) -> AgentNode {
            AgentNode(id: id, harness: "claude", kind: "subagent", status: "done", lastAt: "")
        }
        var index: [String: (parent: AgentParent?, node: AgentNode)] = [:]
        for n in 0..<20 {
            index["p|a1\(n)"] = (nil, node("a1\(n)"))
        }
        index["p|a1"] = (nil, node("a1"))

        XCTAssertEqual(HubAgentsModel.requested(child: "a1", parent: nil, in: index)?.key, "p|a1")
    }

    /// A session waiting for its user writes nothing, so `live` is false for it; the CLI says `open` when a
    /// live agent process holds the session, and the Live group counts that.
    func testASessionAnAgentProcessHoldsIsInTheLiveGroupWhileItsTranscriptIsOld() throws {
        let json = #"{"sessionId":"s1","provider":"claude","lastAt":"2026-10-16T14:20:02.762Z","live":false,"open":true,"children":[]}"#
        let parent = try JSONDecoder().decode(AgentParent.self, from: Data(json.utf8))

        XCTAssertFalse(parent.isLive)
        XCTAssertTrue(parent.hasProcess)
        XCTAssertTrue(HubAgentsModel().isPresent(parent))

        let quiet = try JSONDecoder().decode(AgentParent.self, from: Data(#"{"sessionId":"s2","provider":"claude","lastAt":"2026-10-16T14:20:02.762Z","live":false,"children":[]}"#.utf8))
        XCTAssertFalse(HubAgentsModel().isPresent(quiet))
    }

    func testALooseMatchStillAnswersWhenNothingMatchesExactly() {
        let index: [String: (parent: AgentParent?, node: AgentNode)] = [
            "p|worker-1234": (nil, AgentNode(id: "worker-1234", harness: "codex", kind: "worker", status: "done", lastAt: "")),
        ]

        XCTAssertEqual(HubAgentsModel.requested(child: "worker-12", parent: nil, in: index)?.key, "p|worker-1234")
    }

    /// A refresh slides only when few rows move; a move counts once, a bulk change counts every row.
    func testChangedRowsCountsMovesOnceAndBulkChangesInFull() {
        let rows = (0..<30).map { "r\($0)" }
        XCTAssertEqual(HubAgentsModel.changedRows(from: rows, to: rows), 0)
        var moved = rows
        moved.insert(moved.remove(at: 20), at: 0)
        XCTAssertEqual(HubAgentsModel.changedRows(from: rows, to: moved), 1)
        XCTAssertEqual(HubAgentsModel.changedRows(from: rows, to: rows + ["new"]), 1)
        XCTAssertEqual(HubAgentsModel.changedRows(from: rows, to: Array(rows.dropFirst(12))), 12)
        XCTAssertGreaterThan(HubAgentsModel.changedRows(from: rows, to: rows.reversed()), HubAgentsModel.animatedChangeLimit)
    }
}
