import Combine
import GenesisKit
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// A session often starts in the main checkout and works in a linked worktree; the Changes and Files tabs showed
/// the main checkout, which held none of its work (nabidky-2.0 on 2026-10-16).
final class ReviewWorktreeActivityTests: XCTestCase {
    private let main = RepoWorktree(path: "/work/app", branch: "develop", head: "aaaaaaa1")
    private let poc = RepoWorktree(path: "/work/app-poc", branch: "feat/poc", head: "bbbbbbb2")
    private let nested = RepoWorktree(path: "/work/app/.claude/worktrees/agent-1", branch: "agent", head: "ccccccc3")
    private var all: [RepoWorktree] { [main, poc, nested] }

    private final class TurnWindowProvider: GenesisKitGTCLIProvider {
        var requestedWindows: [Int] = []
        let recent = "/tmp/activity-repo-a/recent.swift"
        let older = "/tmp/activity-repo-b/older.swift"

        override func agentTurnChanges(session: String, lastTurns: Int) throws -> GitWorkingTreeSource.TurnChanges {
            requestedWindows.append(lastTurns)
            let paths = lastTurns == 5 ? [recent] : [recent, older]
            let data = try JSONSerialization.data(withJSONObject: [
                "files": paths.map { ["path": $0] }, "objects": "/unused",
            ])
            return try JSONDecoder().decode(GitWorkingTreeSource.TurnChanges.self, from: data)
        }
    }

    func testActivityCacheKeepsRepositoryDependentTurnFallbackSeparate() {
        let previous = GenesisKitGT.provider
        let provider = TurnWindowProvider()
        GenesisKitGT.provider = provider
        defer { GenesisKitGT.provider = previous }
        let a = RepoWorktree(path: "/tmp/activity-repo-a", branch: nil, head: "aaaaaaa1")
        let aAlias = RepoWorktree(path: "/private/tmp/activity-repo-a", branch: "other-label", head: "aaaaaaa1")
        let b = RepoWorktree(path: "/tmp/activity-repo-b", branch: nil, head: "bbbbbbb2")
        let session = UUID().uuidString

        XCTAssertEqual(WorktreeActivity.changedFiles(session: session, worktrees: [a]), [provider.recent])
        XCTAssertEqual(WorktreeActivity.changedFiles(session: session, worktrees: [b]), [provider.recent, provider.older])
        XCTAssertEqual(provider.requestedWindows, [5, 5, 50])
        XCTAssertEqual(WorktreeActivity.changedFiles(session: session, worktrees: [aAlias, a]), [provider.recent])
        XCTAssertEqual(provider.requestedWindows, [5, 5, 50], "equivalent normalized worktree sets reuse the cache")

        provider.requestedWindows = []
        let reverseSession = UUID().uuidString
        XCTAssertEqual(WorktreeActivity.changedFiles(session: reverseSession, worktrees: [b]), [provider.recent, provider.older])
        XCTAssertEqual(WorktreeActivity.changedFiles(session: reverseSession, worktrees: [a]), [provider.recent])
        XCTAssertEqual(provider.requestedWindows, [5, 50, 5], "a cached 50-turn answer must not replace another repository's 5-turn answer")
    }

    func testAFileBelongsToTheCheckoutWithTheLongestMatchingPath() {
        let counts = WorktreeActivity.counts(
            files: ["/work/app/src/a.ts", "/work/app/.claude/worktrees/agent-1/src/b.ts", "/work/app-poc/src/c.ts", "/work/app-poc/src/d.ts"],
            worktrees: all)

        XCTAssertEqual(counts, [main.path: 1, nested.path: 1, poc.path: 2])
    }

    func testASiblingFolderWithTheSamePrefixIsNotInsideTheCheckout() {
        let counts = WorktreeActivity.counts(files: ["/work/app-other/x.ts", "/work/application/y.ts"], worktrees: all)

        XCTAssertTrue(counts.isEmpty)
    }

    func testTheCheckoutTheSessionChangedMostIsRecommended() {
        let files = ["/work/app/a.ts", "/work/app-poc/b.ts", "/work/app-poc/c.ts"]

        XCTAssertEqual(WorktreeActivity.recommended(files: files, worktrees: all), poc.path)
    }

    func testATieKeepsGitWorktreeOrderRegardlessOfFileOrder() {
        let files = ["/work/app-poc/b.ts", "/work/app/a.ts"]

        XCTAssertEqual(WorktreeActivity.recommended(files: files, worktrees: all), main.path)
        XCTAssertEqual(WorktreeActivity.recommended(files: files.reversed(), worktrees: all), main.path)
        XCTAssertEqual(WorktreeActivity.recommended(files: files, worktrees: [poc, main]), poc.path)
    }

    @MainActor
    func testActivityCanRefreshAgainAndKeepsAManualCheckout() async {
        let model = ReviewModel(repo: URL(fileURLWithPath: main.path), options: DiffViewOptions(), session: "fixture", renderer: NullRenderer())
        model.worktrees = all
        model.worktreeChosen = true
        let first = expectation(description: "first activity")
        let firstSubscription = model.$recommendedWorktree.dropFirst().sink { _ in first.fulfill() }
        let mainFile = main.path + "/a.ts"
        model.refreshWorktreeActivity(load: { _, _ in [mainFile] })
        await fulfillment(of: [first], timeout: 2)
        firstSubscription.cancel()
        XCTAssertFalse(model.activityRequested)
        XCTAssertEqual(model.worktreeActivity, [main.path: 1])

        let second = expectation(description: "updated activity")
        let secondSubscription = model.$recommendedWorktree.dropFirst().sink { _ in second.fulfill() }
        defer { secondSubscription.cancel() }
        let pocFile = poc.path + "/b.ts"
        model.refreshWorktreeActivity(load: { _, _ in [pocFile] })
        await fulfillment(of: [second], timeout: 2)
        XCTAssertFalse(model.activityRequested)
        XCTAssertEqual(model.worktreeActivity, [poc.path: 1])
        XCTAssertEqual(model.recommendedWorktree, poc.path)
        XCTAssertEqual(model.repo.path, main.path)
    }

    @MainActor
    func testASamePathPickNotifiesTheEmbeddedPersistenceCallback() {
        let model = ReviewModel(repo: URL(fileURLWithPath: main.path), options: DiffViewOptions(), renderer: NullRenderer())
        var saved: [URL] = []
        model.onWorktreeChange = { saved.append($0) }
        model.switchWorktree(to: main.path)
        XCTAssertTrue(model.worktreeChosen)
        XCTAssertEqual(saved.map(\.path), [main.path])
        model.switchWorktree(to: main.path, chosen: false)
        XCTAssertEqual(saved.count, 1)
    }

    @MainActor
    func testSelectingAWorktreeInTheHubMarksTheReviewAsChosen() {
        let hub = HubModel(wantedSession: nil, tab: .changes)
        let tree = HubWorktree(path: poc.path, repo: "app", commonDir: "/work/app/.git", branch: "feat/poc", isMain: false)
        hub.selectWorktree(tree)
        XCTAssertEqual(hub.selectedWorktree, poc.path)
        XCTAssertEqual(hub.review?.repo.path, poc.path)
        XCTAssertEqual(hub.review?.worktreeChosen, true)
    }

    func testFilesInNoCheckoutRecommendNothing() {
        XCTAssertNil(WorktreeActivity.recommended(files: ["/elsewhere/notes.md"], worktrees: all))
        XCTAssertNil(WorktreeActivity.recommended(files: [], worktrees: all))
    }

    func testTmpAndPrivateTmpNameOneFolder() {
        let tree = RepoWorktree(path: "/private/tmp/cc/app/wt", branch: nil, head: "ddddddd4")
        let counts = WorktreeActivity.counts(files: ["/tmp/cc/app/wt/src/a.ts"], worktrees: [main, tree])

        XCTAssertEqual(counts, [tree.path: 1])
    }

    func testTheMenuListsTouchedCheckoutsFirstAndStarsTheRecommendedOneAmongSeveral() {
        let counts = [poc.path: 5, nested.path: 2]
        let order = WorktreeActivity.ordered(all, counts: counts)

        XCTAssertEqual(order.map(\.path), [poc.path, nested.path, main.path])
        XCTAssertEqual(WorktreeActivity.title(of: poc, files: 5, recommended: true), "★ feat/poc  ·  app-poc  ·  5 files by this session")
        XCTAssertEqual(WorktreeActivity.title(of: nested, files: 1, recommended: false), "agent  ·  agent-1  ·  1 file by this session")
        XCTAssertEqual(WorktreeActivity.title(of: main, files: 0, recommended: false), main.title)
    }

    func testAnUntouchedMenuKeepsTheGitOrder() {
        XCTAssertEqual(WorktreeActivity.ordered(all, counts: [:]).map(\.path), all.map(\.path))
    }
}
