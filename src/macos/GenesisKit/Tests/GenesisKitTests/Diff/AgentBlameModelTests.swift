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

    /// A repository change used to start one blame per open note (51 to 66 GenesisTools launches at once in Genesis
    /// Markdown, 2026-10-24); the notes of one repository now share one run, and a second wave waits for the first.
    func testTheOpenNotesOfARepositoryShareOneBlameRun() async throws {
        final class Counting: GenesisKitGTCLIProvider, @unchecked Sendable {
            let lock = NSLock()
            var runs: [[String]] = []
            var starts: [Date] = []
            override func agentBlame(repo: String, paths: [String]) throws -> AgentBlameResult {
                lock.withLock { runs.append(paths); starts.append(Date()) }
                Thread.sleep(forTimeInterval: 0.2)
                return AgentBlameResult(
                    sources: [AgentBlameSource(provider: "claude", session: "aaaaaaaa-1111", turn: "t1",
                                               ts: "2026-10-24T10:00:00Z", prompt: "Write it")],
                    files: paths.map { AgentBlameFile(path: $0, ranges: [[1, 2, 0]]) }, elapsedMs: 1)
            }
            override func repoStatus(_ folder: URL, commits: Int) throws -> GitRepoStatus? { nil }
        }
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("blame-queue-\(UUID())")
            .resolvingSymlinksInPath()
        let provider = Counting()
        let previous = GenesisKitGT.provider
        GenesisKitGT.provider = provider
        defer { GenesisKitGT.provider = previous }
        AgentBlameQueue.shared.remember(root: folder, for: folder)
        let interval = AgentBlameQueue.shared.minInterval
        AgentBlameQueue.shared.minInterval = .milliseconds(700)
        defer { AgentBlameQueue.shared.minInterval = interval }
        let models = (0..<3).map { _ in AgentBlameModel() }
        for (index, model) in models.enumerated() { model.follow(folder.appendingPathComponent("note\(index).md")) }
        try await Task.sleep(for: .milliseconds(450))
        // A second wave while the first runs: one more run for all of it, after the first.
        for model in models { model.reload() }
        try await Task.sleep(for: .milliseconds(1400))

        let (runs, starts) = provider.lock.withLock { (provider.runs, provider.starts) }
        XCTAssertEqual(runs, [["note0.md", "note1.md", "note2.md"], ["note0.md", "note1.md", "note2.md"]],
                       "one run per wave for the three notes, never one per note")
        if starts.count == 2 {
            XCTAssertGreaterThanOrEqual(starts[1].timeIntervalSince(starts[0]), 0.65, "a repository's next run waits out minInterval")
        }
        XCTAssertEqual(models.map(\.path), ["note0.md", "note1.md", "note2.md"])
        XCTAssertEqual(models[1].source(forLines: 0...1)?.session, "aaaaaaaa-1111", "each note gets its own part")
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
        let burst = SpawnStorm.burstStarts
        for index in 0..<(burst - 1) {
            XCTAssertEqual(storm.start("GenesisTools agents blame", at: Double(index) * 0.1), [], "under the burst size: quiet")
            XCTAssertEqual(storm.finish(at: Double(index) * 0.1 + 0.05), [])
        }
        let first = storm.start("git status", at: Double(burst - 1) * 0.1)
        XCTAssertEqual(first.count, 1)
        XCTAssertTrue(first.first?.hasPrefix("spawn.storm \(burst) child processes started in 10 s") == true, first.first ?? "none")
        XCTAssertTrue(first.first?.contains("GenesisTools agents blame ×\(burst - 1), git status ×1") == true, first.first ?? "none")
        _ = storm.finish(at: Double(burst - 1) * 0.1 + 0.05)

        // It goes on at 4 starts a second: one "ongoing" line after 30 s, none before.
        var ongoing: [String] = []
        var now = 4.0
        while now < 35 {
            ongoing += storm.start("git status", at: now)
            ongoing += storm.finish(at: now + 0.01)
            now += 0.25
        }
        XCTAssertEqual(ongoing.count, 1, ongoing.joined(separator: "\n"))
        XCTAssertTrue(ongoing.first?.hasPrefix("spawn.storm ongoing 30 s") == true, ongoing.first ?? "none")

        // Minutes of quiet, then one child: it ends the burst, timed to the burst's last start (20:31 to 20:35 read
        // "over after 209 s" for a 10 s burst before).
        let over = storm.start("git status", at: 300)
        XCTAssertEqual(over.count, 1)
        XCTAssertTrue(over.first?.hasPrefix("spawn.storm over after 30 s") == true, over.first ?? "none")
        XCTAssertEqual(storm.finish(at: 300.1), [], "the quiet child after it starts no new burst")
    }

    func testFinishesReportAnOngoingConcurrencyStormWithoutMoreStarts() {
        var storm = SpawnStorm()
        for _ in 0..<SpawnStorm.burstRunning { _ = storm.start("git status", at: 0) }
        XCTAssertEqual(storm.finish(at: 29), [])
        XCTAssertEqual(storm.finish(at: 60), [
            "spawn.storm ongoing 60 s: 16 child processes started, 14 running; git status ×16",
        ])
        XCTAssertEqual(storm.finish(at: 61), [], "finishes share the report deadline")
        XCTAssertEqual(storm.start("rg", at: 62), [], "starts share the same report deadline")
        XCTAssertEqual(storm.finish(at: 90), [
            "spawn.storm ongoing 90 s: 17 child processes started, 13 running; git status ×16, rg ×1",
        ])
        for _ in 0..<5 { XCTAssertEqual(storm.finish(at: 91), []) }
        XCTAssertEqual(storm.finish(at: 120), [
            "spawn.storm over after 62 s: 17 child processes started; git status ×16, rg ×1",
        ], "quiet wins over a due ongoing report")
        XCTAssertEqual(storm.finish(at: 150), [])
    }

    func testManyChildrenRunningAtOnceAreABurstToo() {
        var storm = SpawnStorm()
        var lines: [String] = []
        for index in 0..<SpawnStorm.burstRunning { lines += storm.start("rg", at: Double(index)) }
        XCTAssertTrue(lines.last?.contains("\(SpawnStorm.burstRunning) running") == true, lines.last ?? "nil")
    }

    func testLabelsGroupHeadAndCommitRevisionsTogether() {
        for revision in ["HEAD", "HEAD~2", "HEAD^{commit}", "96c986d3", "96c986d3^{commit}"] {
            XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/usr/bin/git"),
                                            arguments: ["cat-file", "-t", revision]),
                           "git cat-file", revision)
        }
        XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/usr/bin/git"),
                                        arguments: ["remote", "HEADquarters"]),
                       "git remote HEADquarters", "ordinary names beginning with HEAD remain labels")
    }

    func testLabelsNameTheCommandNotItsPaths() {
        XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/usr/bin/git"),
                                        arguments: ["-C", "/Users/x/vault", "-c", "core.quotepath=off", "status", "-z"]),
                       "git status")
        XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/Applications/GenesisTools.app/Contents/MacOS/GenesisTools"),
                                        arguments: ["/Users/x/.genesis-tools/bin/gt-agents", "/repo/src/agents/index.ts", "blame",
                                                    "--repo", "/vault", "--files", "a/b.md", "--json"]),
                       "GenesisTools agents blame")
        XCTAssertEqual(SpawnMeter.label(executable: URL(fileURLWithPath: "/usr/bin/git"),
                                        arguments: ["-c", "core.quotepath=off", "cat-file", "-t", "96c986d3c53f34fde9beb70d8f3e3c987edcfe3f^{commit}"]),
                       "git cat-file", "a commit id would split one command's count")
    }
}
