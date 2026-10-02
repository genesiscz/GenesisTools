import XCTest
@testable import GenesisTools

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

    func testALooseMatchStillAnswersWhenNothingMatchesExactly() {
        let index: [String: (parent: AgentParent?, node: AgentNode)] = [
            "p|worker-1234": (nil, AgentNode(id: "worker-1234", harness: "codex", kind: "worker", status: "done", lastAt: "")),
        ]

        XCTAssertEqual(HubAgentsModel.requested(child: "worker-12", parent: nil, in: index)?.key, "p|worker-1234")
    }
}
