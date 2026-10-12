import GenesisKit
import XCTest
@testable import GenesisTools

/// What the hub asks its data sources, and when it does not: no `tools` process while nobody can see the
/// window (Hub/HubVisibility.swift).
@MainActor
final class HubPollGateTests: XCTestCase {
    /// Counts the list reads, which run off the main thread.
    private final class Calls: @unchecked Sendable {
        private let lock = NSLock()
        private var scopes: [String?] = []

        func add(_ scope: String?) {
            lock.lock()
            scopes.append(scope)
            lock.unlock()
        }

        var count: Int {
            lock.lock()
            defer { lock.unlock() }
            return scopes.count
        }
    }

    override func tearDown() async throws {
        HubVisibility.shared.set(true)
        try await super.tearDown()
    }

    private func agentsModel(_ calls: Calls) -> HubAgentsModel {
        let model = HubAgentsModel()
        model.cache = DiskCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent("hub-poll-gate-\(UUID().uuidString)"), namespace: "agents")
        model.readList = { scope in
            calls.add(scope)
            return AgentsEnvelope(generatedAt: nil, parents: [], orphans: [])
        }
        return model
    }

    private func waitUntil(_ condition: () -> Bool, seconds: Double = 3) async throws {
        let deadline = Date().addingTimeInterval(seconds)
        while !condition(), Date() < deadline {
            try await Task.sleep(for: .milliseconds(25))
        }
    }

    func testTheAgentsModeAsksTheCLIWhenItOpensOnAVisibleHub() async throws {
        let calls = Calls()
        let agents = agentsModel(calls)
        agents.activate()
        try await waitUntil { calls.count == 1 }
        XCTAssertEqual(calls.count, 1)
        agents.deactivate()
    }

    func testAHiddenHubAsksNothingUntilItIsShownThenAsksOnce() async throws {
        let calls = Calls()
        HubVisibility.shared.set(false)
        let agents = agentsModel(calls)
        agents.activate()
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(calls.count, 0, "a hidden hub started `tools hub agents`")

        HubVisibility.shared.set(true)
        try await waitUntil { calls.count == 1 }
        XCTAssertEqual(calls.count, 1)
        agents.deactivate()
    }

    func testShowingTheHubAgainSoonAfterAFreshListAsksNothing() async throws {
        let calls = Calls()
        let agents = agentsModel(calls)
        agents.activate()
        try await waitUntil { calls.count == 1 }

        HubVisibility.shared.set(false)
        HubVisibility.shared.set(true)
        try await Task.sleep(for: .milliseconds(400))
        XCTAssertEqual(calls.count, 1, "a list seconds old was asked for again on show")
        agents.deactivate()
    }

    func testAMissingFolderIsAnsweredWithoutTools() throws {
        var asked: [[String]] = []
        let gone = "/tmp/hub-poll-gate-gone-\(UUID().uuidString)"
        let facts = RepoFacts.fetch([gone], pr: true) { argv in
            asked.append(argv)
            return Data("[]".utf8)
        }
        XCTAssertEqual(asked, [], "`tools hub repo` ran for a folder that does not exist")
        XCTAssertEqual(facts, [RepoFacts.none(gone)])
    }

    func testAPresentFolderStillAsksToolsBesideAMissingOne() throws {
        var asked: [[String]] = []
        let here = FileManager.default.temporaryDirectory.path
        let gone = "/tmp/hub-poll-gate-gone-\(UUID().uuidString)"
        let answer = try JSONEncoder().encode([RepoFacts.none(here)])
        let facts = RepoFacts.fetch([here, gone], pr: false) { argv in
            asked.append(argv)
            return answer
        }
        XCTAssertEqual(asked, [["hub", "repo", here]])
        XCTAssertEqual(Set(facts.map(\.path)), [here, gone])
    }

    private func repoStore(_ fetch: @escaping ([String], Bool) -> [RepoFacts]) -> RepoFactsStore {
        let store = RepoFactsStore()
        store.cache = DiskCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent("hub-poll-gate-\(UUID().uuidString)"), namespace: "repo-facts")
        store.fetch = fetch
        return store
    }

    /// Runs the main queue until `done`, or for two seconds.
    private func spin(until done: () -> Bool) {
        let deadline = Date().addingTimeInterval(2)
        while !done(), Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.01))
        }
    }

    func testAFolderTheCLIDidNotAnswerIsAskedAgainAfterThePauseNotAtOnce() {
        let calls = Calls()
        let path = "/tmp/hub-poll-gate-repo-\(UUID().uuidString)"
        // The first `tools hub repo --pr` fails (no answer); later ones answer.
        let store = repoStore { paths, _ in
            calls.add(nil)
            return calls.count == 1 ? [] : paths.map(RepoFacts.none)
        }
        store.retryAfter = 0.5

        XCTAssertNil(store.facts(for: path, pr: true))
        spin { calls.count == 1 }
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertNil(store.facts(for: path, pr: true))
        RunLoop.main.run(until: Date().addingTimeInterval(0.05))
        XCTAssertEqual(calls.count, 1, "a folder the CLI did not answer was asked again at once")

        RunLoop.main.run(until: Date().addingTimeInterval(0.6))
        _ = store.facts(for: path, pr: true)
        spin { store.byPath[path] != nil }
        XCTAssertEqual(calls.count, 2, "a folder the CLI did not answer was never asked again")
        XCTAssertEqual(store.byPath[path], RepoFacts.none(path))
    }

    func testAnInvalidatedFolderThatWasNoCheckoutIsAskedForItsPRAgain() {
        let calls = Calls()
        let path = "/tmp/hub-poll-gate-repo-\(UUID().uuidString)"
        let store = repoStore { paths, _ in
            calls.add(nil)
            return paths.map(RepoFacts.none)
        }

        _ = store.facts(for: path, pr: true)
        spin { store.byPath[path] != nil }
        _ = store.facts(for: path, pr: true)
        RunLoop.main.run(until: Date().addingTimeInterval(0.1))
        XCTAssertEqual(calls.count, 1, "a folder this run found to be no checkout was asked again")

        // It became a checkout (a clone, a `git init`): the caller invalidates it.
        store.invalidate(path)
        _ = store.facts(for: path, pr: true)
        spin { calls.count == 2 }
        XCTAssertEqual(calls.count, 2, "an invalidated folder kept its old no-checkout answer")
    }

    func testADroppedAgentsModelLeavesNoVisibilityListenerBehind() {
        HubVisibility.shared.set(false)
        HubVisibility.shared.set(true)
        let before = HubVisibility.shared.listenerCount
        var model: HubAgentsModel? = agentsModel(Calls())
        weak var dropped = model
        XCTAssertEqual(HubVisibility.shared.listenerCount, before + 1)

        model = nil
        XCTAssertNil(dropped)
        HubVisibility.shared.set(false)
        HubVisibility.shared.set(true)
        XCTAssertEqual(HubVisibility.shared.listenerCount, before, "a dropped model's listener stayed registered")
    }

    func testAWaitingPollLoopRunsWhenTheHubIsShownAndEndsWhenCancelled() async throws {
        HubVisibility.shared.set(false)
        let shown = Task { @MainActor in
            await HubVisibility.shared.untilVisible()
            return true
        }
        let cancelled = Task { @MainActor in
            await HubVisibility.shared.untilVisible()
            return Task.isCancelled
        }
        try await Task.sleep(for: .milliseconds(50))
        cancelled.cancel()
        let endedOnCancel = await cancelled.value
        XCTAssertTrue(endedOnCancel)

        HubVisibility.shared.set(true)
        let ranOnShow = await shown.value
        XCTAssertTrue(ranOnShow)
    }
}
