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

    func testDisablingAttributionDiscardsAnInFlightReply() async throws {
        final class Delayed: GenesisKitGTCLIProvider {
            let gate = DispatchSemaphore(value: 0)
            let started: XCTestExpectation
            let finished: XCTestExpectation
            let root: URL
            init(_ root: URL, _ started: XCTestExpectation, _ finished: XCTestExpectation) {
                self.root = root; self.started = started; self.finished = finished
            }
            override func git(_ arguments: [String], in repo: URL, input: Data?, gitDirectory: String?, environment: [String: String]?) throws -> GitRunResult {
                // The private folder has no repository follower; only the blame lookup resolves it.
                if arguments == ["rev-parse", "--show-toplevel"] {
                    return GitRunResult(status: 0, stdout: Data(root.path.utf8), stderr: Data())
                }
                return GitRunResult(status: 1, stdout: Data(), stderr: Data())
            }
            override func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus? { nil }
            override func agentBlame(repo: String, paths: [String]) throws -> AgentBlameResult {
                started.fulfill()
                _ = gate.wait(timeout: .now() + 5)
                finished.fulfill()
                return AgentBlameResult(sources: [], files: [], elapsedMs: 0)
            }
        }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("blame-cancel-\(UUID())")
        let started = expectation(description: "blame started"), finished = expectation(description: "blame finished")
        started.assertForOverFulfill = false
        finished.assertForOverFulfill = false
        let provider = Delayed(root, started, finished)
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = provider
        defer { GenesisKitGT.provider = previous }
        let model = AgentBlameModel()
        model.follow(root.appendingPathComponent("note.md"))
        await fulfillment(of: [started], timeout: 3)
        model.follow(nil)
        for _ in 0..<8 { provider.gate.signal() }
        await fulfillment(of: [finished], timeout: 3)
        try await Task.sleep(for: .milliseconds(100))
        XCTAssertNil(model.path, "the delayed reply must not resurrect even the file identity")
        XCTAssertNil(model.source(forLines: 0...1))
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

/// The spawn meter's burst rule and labels (`SpawnMeter`), which put a burst of child processes into the perf log.
final class SpawnStormTests: XCTestCase {
    func testABurstIsReportedWhenItStartsWhileItLastsAndWhenItEnds() {
        var storm = SpawnStorm()
        var lines: [String] = []
        for index in 0..<(SpawnStorm.burstStarts - 1) {
            XCTAssertNil(storm.start("GenesisTools agents blame", at: Double(index) * 0.1), "under the burst size: quiet")
            _ = storm.finish(at: Double(index) * 0.1 + 0.05)
        }
        let last = Double(SpawnStorm.burstStarts - 1) * 0.1
        if let line = storm.start("git status", at: last) { lines.append(line) }
        XCTAssertEqual(lines.count, 1)
        let burst = SpawnStorm.burstStarts
        XCTAssertTrue(lines[0].hasPrefix("spawn.storm \(burst) child processes started in 10 s"), lines[0])
        XCTAssertTrue(lines[0].contains("GenesisTools agents blame ×\(burst - 1), git status ×1"), lines[0])

        XCTAssertNil(storm.start("git status", at: 4.5), "no second line within 30 s")
        XCTAssertTrue(storm.start("git status", at: 34)?.hasPrefix("spawn.storm ongoing 30 s") == true)
        // The first finish once the window holds few starts and few children run ends it.
        let over = storm.finish(at: 40)
        XCTAssertTrue(over?.hasPrefix("spawn.storm over after \(Int(40 - last)) s: \(SpawnStorm.burstStarts + 2) child processes started") == true,
                      over ?? "nil")
        XCTAssertNil(storm.finish(at: 41))
        XCTAssertNil(storm.start("git status", at: 61), "a quiet start after the burst ended")
    }

    func testManyChildrenRunningAtOnceAreABurstToo() {
        var storm = SpawnStorm()
        var line: String?
        for index in 0..<SpawnStorm.burstRunning { line = storm.start("rg", at: Double(index)) ?? line }
        XCTAssertTrue(line?.contains("\(SpawnStorm.burstRunning) running") == true, line ?? "nil")
    }

    func testLabelsNameTheCommandNotItsPaths() {
        XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/usr/bin/git"),
                                        arguments: ["-C", "/Users/x/vault", "-c", "core.quotepath=off", "status", "-z"]),
                       "git status")
        XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/Applications/GenesisTools.app/Contents/MacOS/GenesisTools"),
                                        arguments: ["/Users/x/.genesis-tools/bin/gt-agents", "/repo/src/agents/index.ts", "blame",
                                                    "--repo", "/vault", "--files", "a/b.md", "--json"]),
                       "GenesisTools agents blame")
    }
}
