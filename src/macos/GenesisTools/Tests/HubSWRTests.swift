import XCTest
@testable import GenesisTools

/// Stale-while-revalidate (Hub/HubSWR.swift): each cached hub answer comes back from disk the way the
/// view reads it. The flash rules are GenesisKit's (SWRTests there).
final class HubSWRTests: XCTestCase {
    private func scratch(_ namespace: String) -> DiskCache {
        DiskCache(directory: FileManager.default.temporaryDirectory.appendingPathComponent("hub-swr-\(UUID().uuidString)"), namespace: namespace)
    }

    func testCleanupReportRoundTrips() throws {
        let json = """
        {"rows":[{"path":"/tmp/wt","repoRoot":"/tmp/repo","repo":"repo","branch":"feat","head":"abc123","verdict":"MERGED","how":"ancestor","base":"master","ignored":[],"removable":true,"blockers":[],"lastActivityAt":1,"lastCommitAt":2,"changedCount":0,"untrackedCount":0}],"warnings":[],"elapsedMs":5}
        """
        let report = try JSONDecoder().decode(CleanupReport.self, from: Data(json.utf8))
        let cache = scratch("worktree-cleanup")
        cache.write(report, key: "k")
        let back = try XCTUnwrap(cache.read(CleanupReport.self, key: "k"))
        XCTAssertEqual(back.rows, report.rows)
    }

    func testRepoFactsMapRoundTrips() throws {
        let json = """
        [{"path":"/tmp/repo","root":"/tmp/repo","repo":"repo","branch":"feat","head":"abc","origin":{"url":"git@github.com:o/r.git","host":"github.com","kind":"github","web":"https://github.com/o/r"},"branchUrl":null,"headUrl":null,"pr":{"number":7,"state":"OPEN","target":"master","url":"https://github.com/o/r/pull/7"},"prError":null}]
        """
        let facts = try JSONDecoder().decode([RepoFacts].self, from: Data(json.utf8))
        let cache = scratch("repo-facts")
        cache.write(Dictionary(uniqueKeysWithValues: facts.map { ($0.path, $0) }), key: "all")
        let back = try XCTUnwrap(cache.read([String: RepoFacts].self, key: "all"))
        XCTAssertEqual(back["/tmp/repo"], facts[0])
        XCTAssertEqual(back["/tmp/repo"]?.pr?.number, 7)
    }

    func testWorktreesRoundTrip() throws {
        let worktrees = [HubWorktree(path: "/tmp/repo", repo: "repo", commonDir: "/tmp/repo/.git", branch: "master", isMain: true)]
        let cache = scratch("worktrees")
        cache.write(worktrees, key: "all")
        XCTAssertEqual(cache.read([HubWorktree].self, key: "all"), worktrees)
    }
}
