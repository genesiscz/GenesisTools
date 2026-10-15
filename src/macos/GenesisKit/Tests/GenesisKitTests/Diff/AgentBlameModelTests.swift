import XCTest
@testable import GenesisKit

/// The agent attribution behind the gutter card: the session that wrote most of a hunk's lines, from a provider
/// that answers `agents blame` without the GenesisTools CLI.
@MainActor
final class AgentBlameModelTests: XCTestCase {
    private final class StubProvider: GenesisKitGTCLIProvider {
        var asked: [[String]] = []
        override func agentBlame(repo: String, paths: [String]) throws -> AgentBlameResult {
            asked.append(paths)
            return AgentBlameResult(
                sources: [
                    AgentBlameSource(provider: "claude", session: "aaaaaaaa-1111", turn: "t1", ts: "2026-10-13T10:00:00Z", prompt: "Write the plan"),
                    AgentBlameSource(provider: "codex", session: "bbbbbbbb-2222", turn: "t2", ts: "2026-10-13T11:00:00Z", prompt: nil),
                ],
                // 1-based and inclusive: lines 1-3 by the first session, 4-10 by the second.
                files: [AgentBlameFile(path: paths[0], ranges: [[1, 3, 0], [4, 10, 1]])],
                elapsedMs: 3
            )
        }
    }

    func testTheSessionThatWroteMostOfTheLinesIsNamed() async throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("blame-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let stub = StubProvider()
        _ = try stub.git(["init", "-q", "-b", "main"], in: repo, input: nil, gitDirectory: nil, environment: nil)
        let note = repo.appendingPathComponent("plan.md")
        try (1 ... 10).map { "line \($0)" }.joined(separator: "\n").write(to: note, atomically: true, encoding: .utf8)

        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = stub
        defer { GenesisKitGT.provider = previous }

        let model = AgentBlameModel()
        model.follow(note)
        let end = Date().addingTimeInterval(5)
        while model.path == nil, Date() < end {
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertEqual(model.path, "plan.md")
        XCTAssertEqual(stub.asked.first, ["plan.md"])
        // 0-based lines: 0...2 are the first session's, 2...5 mostly the second's.
        XCTAssertEqual(model.source(forLines: 0 ... 2)?.session, "aaaaaaaa-1111")
        XCTAssertEqual(model.source(forLines: 2 ... 5)?.session, "bbbbbbbb-2222")
        XCTAssertNil(model.source(forLines: 20 ... 22))
        XCTAssertEqual(model.source(forLines: 0 ... 0)?.title, "Claude · session aaaaaaaa")

        // The one switch off: nothing is followed, nothing is named.
        model.follow(nil)
        XCTAssertNil(model.source(forLines: 0 ... 2))
    }
}
