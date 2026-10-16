import GenesisKit
import XCTest
@testable import GenesisTools

/// A session often starts in the main checkout and works in a linked worktree; the Changes and Files tabs showed
/// the main checkout, which held none of its work (nabidky-2.0 on 2026-10-16).
final class ReviewWorktreeActivityTests: XCTestCase {
    private let main = RepoWorktree(path: "/work/app", branch: "develop", head: "aaaaaaa1")
    private let poc = RepoWorktree(path: "/work/app-poc", branch: "feat/poc", head: "bbbbbbb2")
    private let nested = RepoWorktree(path: "/work/app/.claude/worktrees/agent-1", branch: "agent", head: "ccccccc3")
    private var all: [RepoWorktree] { [main, poc, nested] }

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

    func testATieGoesToTheCheckoutOfTheLatestFile() {
        let files = ["/work/app-poc/b.ts", "/work/app/a.ts"]

        XCTAssertEqual(WorktreeActivity.recommended(files: files, worktrees: all), main.path)
        XCTAssertEqual(WorktreeActivity.recommended(files: files.reversed(), worktrees: all), poc.path)
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
