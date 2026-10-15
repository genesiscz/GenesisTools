import XCTest
@testable import GenesisKit

/// The shared repository status and one file's state: found from a folder, refreshed by git's own folder events.
@MainActor
final class GitReposTests: XCTestCase {
    private func git(_ args: [String], in repo: URL) throws {
        let result = try GenesisKitGTCLIProvider().git(args, in: repo, input: nil, gitDirectory: nil, environment: [
            "GIT_AUTHOR_NAME": "Alice", "GIT_AUTHOR_EMAIL": "alice@example.com",
            "GIT_COMMITTER_NAME": "Alice", "GIT_COMMITTER_EMAIL": "alice@example.com",
        ])
        XCTAssertEqual(result.status, 0, String(decoding: result.stderr, as: UTF8.self))
    }

    private func wait(_ what: String, timeout: TimeInterval = 5, until done: () -> Bool) async {
        let end = Date().addingTimeInterval(timeout)
        while !done(), Date() < end {
            try? await Task.sleep(for: .milliseconds(50))
        }
        XCTAssertTrue(done(), "timed out waiting for \(what)")
    }

    func testTheFileStateFollowsAStageWithoutBeingAsked() async throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gitrepos-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let note = repo.appendingPathComponent("plan.md")
        try git(["init", "-q", "-b", "main"], in: repo)
        try "one\n".write(to: note, atomically: true, encoding: .utf8)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        try "one\ntwo\n".write(to: note, atomically: true, encoding: .utf8)

        XCTAssertNil(GitRepos.shared.model(for: repo), "the first ask only starts the lookup")
        await wait("the repository") { GitRepos.shared.model(for: repo) != nil }
        let model = try XCTUnwrap(GitRepos.shared.model(for: repo))
        await wait("the status") { model.status?.entry(for: note)?.unstaged == .modified }

        let file = GitFileStateModel()
        file.follow(note)
        await wait("the file state") { file.state?.unstagedAdditions == 1 }
        XCTAssertEqual(file.state?.summary, "M · 1 line unstaged")

        // A stage is a change to the index: git's folder event refreshes both, nobody calls refresh.
        try git(["add", "plan.md"], in: repo)
        await wait("the staged state") { file.state?.hasStaged == true && file.state?.hasUnstaged == false }
        XCTAssertEqual(model.status?.entry(for: note)?.staged, .modified)
        XCTAssertEqual(file.state?.summary, "M · 1 line staged")

        file.follow(nil)
        XCTAssertNil(file.state)
    }

    func testTheTreeMarksAreSpelledUnderTheTreesOwnRoot() async throws {
        // /tmp is a link to /private/tmp: git names the repository by the real path, the tree by the given one.
        let name = "gittree-\(UUID().uuidString)"
        let given = URL(fileURLWithPath: "/tmp/\(name)")
        try FileManager.default.createDirectory(at: given.appendingPathComponent("notes"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: given) }
        try git(["init", "-q", "-b", "main"], in: given)
        try "a\n".write(to: given.appendingPathComponent("notes/kept.md"), atomically: true, encoding: .utf8)
        try git(["add", "."], in: given)
        try git(["commit", "-q", "-m", "First"], in: given)
        try "b\n".write(to: given.appendingPathComponent("notes/kept.md"), atomically: true, encoding: .utf8)
        try "new\n".write(to: given.appendingPathComponent("loose.md"), atomically: true, encoding: .utf8)

        let tree = GitTreeDecorationsModel()
        tree.follow(given)
        await wait("the marks") { !tree.decorations.files.isEmpty }
        XCTAssertEqual(tree.decorations.change(for: "/tmp/\(name)/notes/kept.md"), .modified)
        XCTAssertEqual(tree.decorations.change(for: "/tmp/\(name)/loose.md"), .untracked)
        XCTAssertTrue(tree.decorations.holdsChanges("/tmp/\(name)/notes"))

        let rows = [
            FileTreeRow(id: "/tmp/\(name)/notes", name: "notes", isFolder: true, depth: 0),
            FileTreeRow(id: "/tmp/\(name)/notes/kept.md", name: "kept.md", isFolder: false, depth: 1),
            FileTreeRow(id: "/tmp/\(name)/clean.md", name: "clean.md", isFolder: false, depth: 0),
        ]
        XCTAssertEqual(FileTreeView.changedRows(rows, tree.decorations).map(\.name), ["notes", "kept.md"])
        tree.follow(nil)
        XCTAssertEqual(tree.decorations, .none)
    }

    func testAFolderOutsideARepositoryHasNoModel() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("norepo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let before = GitRepos.shared.revision
        XCTAssertNil(GitRepos.shared.model(for: folder))
        await wait("the lookup") { GitRepos.shared.revision > before }
        XCTAssertNil(GitRepos.shared.model(for: folder))
    }
}
