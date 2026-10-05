import XCTest
@testable import GenesisTools

/// A session's folder that holds no repository resolves to the checkout of the same name one level
/// down. A miss is not remembered: a checkout that appears later (a move still in progress) is found.
final class HubMovedCheckoutTests: XCTestCase {
    private var root = ""

    override func setUpWithError() throws {
        root = (NSTemporaryDirectory() as NSString).appendingPathComponent("hub-moved-checkout-\(UUID().uuidString)")
        try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(atPath: root)
    }

    private func makeRepository(_ path: String) throws {
        let git = (path as NSString).appendingPathComponent(".git")
        try FileManager.default.createDirectory(atPath: git, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: (git as NSString).appendingPathComponent("HEAD"), contents: Data("ref: refs/heads/main\n".utf8))
    }

    func testAMissIsNotRememberedOnceTheCheckoutArrives() throws {
        let folder = (root as NSString).appendingPathComponent("App")
        XCTAssertNil(MovedCheckout.resolve(folder), "nothing moved yet")

        let moved = (root as NSString).appendingPathComponent("Group/App")
        try makeRepository(moved)

        XCTAssertEqual(MovedCheckout.resolve(folder), moved)
    }

    func testAMovedCheckoutThatLeavesAgainIsNotAnsweredFromTheCache() throws {
        let folder = (root as NSString).appendingPathComponent("Tool")
        let moved = (root as NSString).appendingPathComponent("Group/Tool")
        try makeRepository(moved)
        XCTAssertEqual(MovedCheckout.resolve(folder), moved)

        try FileManager.default.removeItem(atPath: moved)

        XCTAssertNil(MovedCheckout.resolve(folder))
    }

    func testARestoredOriginalCheckoutWinsOverTheCachedMove() throws {
        let folder = (root as NSString).appendingPathComponent("Back")
        let moved = (root as NSString).appendingPathComponent("Group/Back")
        try makeRepository(moved)
        XCTAssertEqual(MovedCheckout.resolve(folder), moved)

        try makeRepository(folder)

        XCTAssertNil(MovedCheckout.resolve(folder), "the recorded folder is a repository again: it is its own answer")
    }

    func testABrokenWorktreePointerIsNotARepository() throws {
        let folder = (root as NSString).appendingPathComponent("Site")
        try FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        try "gitdir: \(root)/gone/.git/worktrees/site\n".write(toFile: (folder as NSString).appendingPathComponent(".git"), atomically: true, encoding: .utf8)
        let moved = (root as NSString).appendingPathComponent("Group/Site")
        try makeRepository(moved)

        XCTAssertEqual(MovedCheckout.resolve(folder), moved)
    }

    func testALiveWorktreePointerIsARepository() throws {
        let main = (root as NSString).appendingPathComponent("main")
        try makeRepository(main)
        let gitdir = (main as NSString).appendingPathComponent(".git/worktrees/feature")
        try FileManager.default.createDirectory(atPath: gitdir, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: (gitdir as NSString).appendingPathComponent("HEAD"), contents: Data("ref: refs/heads/feature\n".utf8))
        let worktree = (root as NSString).appendingPathComponent("feature")
        try FileManager.default.createDirectory(atPath: worktree, withIntermediateDirectories: true)
        try "gitdir: ../main/.git/worktrees/feature\n".write(toFile: (worktree as NSString).appendingPathComponent(".git"), atomically: true, encoding: .utf8)

        XCTAssertTrue(MovedCheckout.isRepository(worktree), "a relative gitdir resolves from the worktree")
        XCTAssertNil(MovedCheckout.resolve(worktree))
    }
}
