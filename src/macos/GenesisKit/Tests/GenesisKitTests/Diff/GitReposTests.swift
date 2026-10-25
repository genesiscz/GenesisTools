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

    func testAnEmptyCommitInvalidatesFollowersWithoutChangingStatus() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("git-generation-\(UUID())")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try git(["init", "-q", "-b", "main"], in: root)
        try git(["commit", "--allow-empty", "-q", "-m", "First"], in: root)
        let model = GitRepoModel(root: root)
        await wait("initial status") { model.status != nil }
        let status = model.status
        let generation = model.generation
        try git(["commit", "--allow-empty", "-q", "-m", "Second"], in: root)
        model.refresh()
        await wait("refresh after identical porcelain status") { model.generation > generation }
        XCTAssertEqual(model.status, status)
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

        guard case .pending = GitRepos.shared.lookup(for: repo) else { return XCTFail("the first ask only starts the lookup") }
        await wait("the repository") { GitRepos.shared.model(for: repo) != nil }
        let model = try XCTUnwrap(GitRepos.shared.model(for: repo))
        await wait("the status") { model.status?.entry(for: note)?.unstaged == .modified }

        let file = GitFileStateModel()
        file.follow(note)
        await wait("the file state") { file.state?.unstagedAdditions == 1 }
        XCTAssertEqual(file.state?.summary, "Modified · 1 line unstaged")

        // A stage is a change to the index: git's folder event refreshes both, nobody calls refresh.
        try git(["add", "plan.md"], in: repo)
        await wait("the staged state") { file.state?.hasStaged == true && file.state?.hasUnstaged == false }
        XCTAssertEqual(model.status?.entry(for: note)?.staged, .modified)
        XCTAssertEqual(file.state?.summary, "Modified · 1 line staged")

        file.follow(nil)
        XCTAssertNil(file.state)
    }

    func testAnotherFileInTheSameFolderLoadsItsOwnStateAndHistory() async throws {
        // The status bar and the git sidebar outlive a document switch: a sibling note must load with no git event.
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gitsibling-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        let plan = repo.appendingPathComponent("plan.md")
        let todo = repo.appendingPathComponent("todo.md")
        try git(["init", "-q", "-b", "main"], in: repo)
        try "one\n".write(to: plan, atomically: true, encoding: .utf8)
        try "one\n".write(to: todo, atomically: true, encoding: .utf8)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        try "one\ntwo\n".write(to: plan, atomically: true, encoding: .utf8)
        try "one\ntwo\nthree\n".write(to: todo, atomically: true, encoding: .utf8)

        let file = GitFileStateModel()
        let history = GitHistoryModel()
        file.follow(plan)
        history.follow(.file(plan))
        await wait("the first file") { file.state?.unstagedAdditions == 1 && history.loaded }

        file.follow(todo)
        history.follow(.file(todo))
        await wait("the sibling's state") { file.state?.unstagedAdditions == 2 }
        await wait("the sibling's history") { history.loaded && history.commits.count == 1 }
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
        try git(["add", "."], in: given)
        try git(["commit", "-q", "-m", "Clean"], in: given)
        GitRepos.shared.noteSaved(given.appendingPathComponent("loose.md"))
        await wait("clean tree") { tree.hasRepository && tree.decorations == .none }
        XCTAssertTrue(FileTreeView.changedRows(rows, tree.decorations).isEmpty)

        tree.follow(nil)
        XCTAssertEqual(tree.decorations, .none)
        XCTAssertFalse(tree.hasRepository)
    }

    func testTheRevealButtonFindsTheOpenFileInItsListFolderAndPage() {
        func entry(_ path: String, untracked: Bool = false) -> GitStatusEntry {
            GitStatusEntry(path: path, oldPath: nil, staged: nil, unstaged: untracked ? .untracked : .modified)
        }
        var lists = GitRepoPanelLists.Lists()
        lists.changed = [entry("a.md"), entry("notes/b.md")]
        lists.groups = [GitUntrackedGroup(folder: "drafts", files: (0..<150).map { entry("drafts/\($0).md", untracked: true) })]
        let changed = GitRepoPanel.revealTarget(path: "notes/b.md", in: lists)
        XCTAssertEqual(changed?.key, "changes")
        XCTAssertNil(changed?.folder)
        XCTAssertEqual(changed?.index, 1)
        // Folded and past the first page of 100: the folder opens and the page grows.
        let folded = GitRepoPanel.revealTarget(path: "drafts/120.md", in: lists)
        XCTAssertEqual(folded?.key, "folder:drafts")
        XCTAssertEqual(folded?.folder, "drafts")
        XCTAssertEqual(folded?.index, 120)
        XCTAssertNil(GitRepoPanel.revealTarget(path: "clean.md", in: lists), "a file with no change has no row")
    }

    func testTheTreeCountsSumEachFilesLinesIntoItsFolders() {
        let output = "3\t1\tnotes/a.md\u{0}2\t0\tnotes/deep/b.md\u{0}-\t-\tpic.png\u{0}4\t4\t\u{0}old.md\u{0}notes/moved.md\u{0}"
        let numstat = GitQueries.parseNumstatAll(output)
        XCTAssertEqual(numstat["notes/a.md"], GitLineCount(additions: 3, deletions: 1))
        XCTAssertEqual(numstat["pic.png"], GitLineCount(additions: 0, deletions: 0), "a binary file counts no lines")
        XCTAssertEqual(numstat["notes/moved.md"], GitLineCount(additions: 4, deletions: 4), "a rename is keyed by its new path")
        XCTAssertNil(numstat["old.md"])

        let root = URL(fileURLWithPath: "/tmp/gk-counts-repo")
        let status = GitRepoStatus(root: root, branch: "main", upstream: nil, ahead: 0, behind: 0, entries: [
            GitStatusEntry(path: "notes/a.md", unstaged: .modified),
            GitStatusEntry(path: "notes/deep/b.md", unstaged: .modified),
            GitStatusEntry(path: "notes/new.md", unstaged: .untracked),
        ])
        let marks = status.decorations(under: root, numstat: numstat)
        XCTAssertEqual(marks.count(for: "/tmp/gk-counts-repo/notes/a.md"), GitLineCount(additions: 3, deletions: 1))
        XCTAssertEqual(marks.count(for: "/tmp/gk-counts-repo/notes/deep"), GitLineCount(additions: 2, deletions: 0))
        XCTAssertEqual(marks.count(for: "/tmp/gk-counts-repo/notes"), GitLineCount(additions: 5, deletions: 1))
        XCTAssertNil(marks.count(for: "/tmp/gk-counts-repo/notes/new.md"), "an untracked file has no numstat")
    }

    /// The folder walks cut paths at "/" in UTF-8 (2026-10-14); accented names keep their marks and sums, and the
    /// tree's own root is never marked.
    func testTheTreeMarksWalkFoldersWithAccentedNames() {
        let root = URL(fileURLWithPath: "/tmp/gk-accents-repo")
        let status = GitRepoStatus(root: root, branch: "main", upstream: nil, ahead: 0, behind: 0, entries: [
            GitStatusEntry(path: "Účty/úkoly/žádost/a.md", unstaged: .modified),
            GitStatusEntry(path: "Účty/úkoly/b.md", unstaged: .modified),
            GitStatusEntry(path: "Účty/c.md", unstaged: .untracked),
            GitStatusEntry(path: "jinde/d.md", unstaged: .modified),
        ])
        let numstat = [
            "Účty/úkoly/žádost/a.md": GitLineCount(additions: 2, deletions: 1),
            "Účty/úkoly/b.md": GitLineCount(additions: 1, deletions: 3),
        ]
        let marks = status.decorations(under: root.appendingPathComponent("Účty"), numstat: numstat)
        let tree = "/tmp/gk-accents-repo/Účty"
        XCTAssertEqual(Set(marks.files.keys), ["\(tree)/úkoly/žádost/a.md", "\(tree)/úkoly/b.md", "\(tree)/c.md"])
        XCTAssertEqual(marks.folders, ["\(tree)/úkoly/žádost", "\(tree)/úkoly"], "the tree's root is not marked")
        XCTAssertEqual(marks.count(for: "\(tree)/úkoly/žádost"), GitLineCount(additions: 2, deletions: 1))
        XCTAssertEqual(marks.count(for: "\(tree)/úkoly"), GitLineCount(additions: 3, deletions: 4))
        XCTAssertNil(marks.count(for: tree), "the tree's root sums nothing")
    }

    /// Martin, 2026-10-25: a moved data folder left its files listed as deleted, and opening one said "This file is not
    /// in a git repository": git ran in the deleted file's folder, which no longer exists.
    func testAFolderThatNoLongerExistsFindsTheRepositoryAroundIt() async throws {
        let repo = FileManager.default.temporaryDirectory.appendingPathComponent("gitmoved-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: repo.appendingPathComponent("data/run"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: repo) }
        try git(["init", "-q", "-b", "main"], in: repo)
        try "export {}\n".write(to: repo.appendingPathComponent("data/run/compiler.ts"), atomically: true, encoding: .utf8)
        try git(["add", "."], in: repo)
        try git(["commit", "-q", "-m", "First"], in: repo)
        try FileManager.default.moveItem(at: repo.appendingPathComponent("data"), to: repo.appendingPathComponent("moved"))
        let gone = repo.appendingPathComponent("data/run")
        XCTAssertFalse(FileManager.default.fileExists(atPath: gone.path))

        XCTAssertEqual(GitQueries(provider: GenesisKitGTCLIProvider()).root(of: gone).map { GitWorkingTreeSource.realPath($0.path) },
                       GitWorkingTreeSource.realPath(repo.path))
        _ = GitRepos.shared.lookup(for: gone)
        await wait("the repository of a folder that is gone") { GitRepos.shared.model(for: gone) != nil }

        let sides = try GitFileDiffModel.sides(gone.appendingPathComponent("compiler.ts"), text: nil, scope: .uncommitted,
                                               pick: nil, provider: GenesisKitGTCLIProvider())
        XCTAssertEqual(sides.old, "export {}\n", "the deleted file's last committed text is the old side")
        XCTAssertNil(sides.new)
    }

    func testAFolderOutsideARepositoryHasNoModel() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("norepo-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let before = GitRepos.shared.revision
        // Pending first, never "none": a view shows "not in a git repository" only for a known answer.
        guard case .pending = GitRepos.shared.lookup(for: folder) else { return XCTFail("the first ask is pending") }
        await wait("the lookup") { GitRepos.shared.revision > before }
        XCTAssertNil(GitRepos.shared.model(for: folder))
        guard case .none = GitRepos.shared.lookup(for: folder) else { return XCTFail("the answer is none") }
    }
}
