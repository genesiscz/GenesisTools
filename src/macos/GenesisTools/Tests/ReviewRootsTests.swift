import AppKit
import XCTest
@testable import GenesisTools

/// One review over several repositories: every file under its root's folder name, one tree with one
/// top-level folder per root, and every merged id back to its own repository.
final class ReviewRootsTests: XCTestCase {
    private func file(_ path: String, add: Int = 1, del: Int = 0) -> DiffFile {
        DiffFile(id: path, path: path, oldPath: nil, status: .modified, additions: add, deletions: del,
                 oldContents: "a\n", newContents: "b\n", skipped: nil)
    }

    private func root(_ path: String, files: [DiffFile], shown: Bool = true, prefix: String) -> ReviewRoot {
        var root = ReviewRoot(folder: path, repo: URL(fileURLWithPath: path), shown: shown)
        root.prefix = prefix
        root.files = files
        return root
    }

    private var twoRoots: [ReviewRoot] {
        [
            root("/work/tools", files: [file("README.md", add: 3), file("src/a.ts", add: 2, del: 1)], prefix: "tools"),
            root("/work/notes", files: [file("README.md", add: 5), file("daily/2026-01-02.md", add: 7)], prefix: "notes"),
        ]
    }

    func testPrefixesAreFolderNamesAndTwoEqualNamesGetTheirParent() {
        XCTAssertEqual(ReviewRoots.prefixes(for: ["/work/tools", "/work/notes"]), ["tools", "notes"])
        XCTAssertEqual(ReviewRoots.prefixes(for: ["/a/notes", "/b/notes"]), ["notes (a)", "notes (b)"])
        XCTAssertFalse(ReviewRoots.prefixes(for: ["/a/notes", "/b/notes"]).contains { $0.contains("/") })
    }

    func testTheSameRelativePathInTwoRootsIsTwoFilesThatNeverCollide() {
        let merged = ReviewRoots.merge(twoRoots)
        XCTAssertEqual(merged.map(\.path), ["tools/README.md", "tools/src/a.ts", "notes/README.md", "notes/daily/2026-01-02.md"])
        XCTAssertEqual(Set(merged.map(\.id)).count, merged.count)
        XCTAssertEqual(ReviewRoots.index(of: "tools/README.md", in: twoRoots), 0)
        XCTAssertEqual(ReviewRoots.index(of: "notes/README.md", in: twoRoots), 1)
        XCTAssertEqual(twoRoots[1].local("notes/README.md"), "README.md")
        XCTAssertNil(twoRoots[1].local("tools/README.md"))
    }

    func testASingleRootKeepsItsPathsAsTheyAre() {
        let single = [root("/work/tools", files: [file("src/a.ts")], prefix: "")]
        XCTAssertEqual(ReviewRoots.merge(single).map(\.id), ["src/a.ts"])
        XCTAssertEqual(ReviewRoots.index(of: "src/a.ts", in: single), 0)
        XCTAssertEqual(ReviewRoots.global(path: "src/a.ts", in: single), "src/a.ts")
        XCTAssertEqual(ReviewRoots.global(path: "/work/tools/src/a.ts", in: single), "src/a.ts")
    }

    func testAnUntickedRootAddsNoFiles() {
        var roots = twoRoots
        roots[1].shown = false
        XCTAssertEqual(ReviewRoots.merge(roots).map(\.path), ["tools/README.md", "tools/src/a.ts"])
    }

    func testAnAbsolutePathFindsItsRootAndARelativeOneMeansTheFirstRoot() {
        XCTAssertEqual(ReviewRoots.global(path: "/work/notes/README.md", in: twoRoots), "notes/README.md")
        XCTAssertEqual(ReviewRoots.global(path: "README.md", in: twoRoots), "tools/README.md")
        XCTAssertEqual(ReviewRoots.global(path: "/elsewhere/x.md", in: twoRoots), "/elsewhere/x.md")
    }

    func testTheTreeHasOneTopLevelFolderPerRootWithItsOwnTotals() {
        let rows = sidebarRows(ReviewRoots.merge(twoRoots), tree: true, collapsed: [], roots: twoRoots)
        let roots = rows.compactMap { row -> (Int, Int, Int)? in
            if case .root(let index, let additions, let deletions) = row.kind { return (index, additions, deletions) }
            return nil
        }
        XCTAssertEqual(roots.map(\.0), [0, 1])
        XCTAssertEqual(roots.map(\.1), [5, 12])
        XCTAssertEqual(roots.map(\.2), [1, 0])
        XCTAssertEqual(rows.filter { $0.depth == 0 }.count, 2, "only the root rows sit at the top level")

        // Each root's files sit under it, and its folder rows read without the root's name.
        let ids = rows.map(\.id)
        XCTAssertEqual(ids, ["dir:tools", "dir:tools/src", "tools/src/a.ts", "tools/README.md",
                             "dir:notes", "dir:notes/daily", "notes/daily/2026-01-02.md", "notes/README.md"])
        let names = rows.compactMap { row -> String? in
            if case .directory(let name, _, _) = row.kind { return name }
            return nil
        }
        XCTAssertEqual(names, ["src", "daily"])
    }

    func testACollapsedOrEmptyRootKeepsOnlyItsRow() {
        var roots = twoRoots
        roots[1].files = []
        let rows = sidebarRows(ReviewRoots.merge(roots), tree: true, collapsed: ["dir:tools"], roots: roots)
        XCTAssertEqual(rows.map(\.id), ["dir:tools", "dir:notes"])
    }

    func testTheFlatListGroupsEachRootsFoldersUnderIt() {
        let rows = sidebarRows(ReviewRoots.merge(twoRoots), tree: false, collapsed: [], roots: twoRoots)
        XCTAssertEqual(rows.map(\.id), ["dir:tools", "tools/README.md", "dir:tools/src", "tools/src/a.ts",
                                        "dir:notes", "notes/README.md", "dir:notes/daily", "notes/daily/2026-01-02.md"])
    }

    func testOneRootStillBuildsTheOldTree() {
        let rows = sidebarRows([file("src/lib/a.ts"), file("b.ts")], tree: true, collapsed: [])
        XCTAssertEqual(rows.map(\.id), ["dir:src/lib", "src/lib/a.ts", "b.ts"])
    }

    func testAReviewModelMapsAMergedFileBackToItsRepository() {
        let model = ReviewModel(repo: URL(fileURLWithPath: "/work/tools"), options: DiffViewOptions(), renderer: NullRenderer())
        model.setRoots([
            ReviewRoot(folder: "/work/tools", repo: URL(fileURLWithPath: "/work/tools")),
            ReviewRoot(folder: "/work/notes", repo: URL(fileURLWithPath: "/work/notes"), removable: true),
        ])
        XCTAssertEqual(model.roots.map(\.prefix), ["tools", "notes"])
        XCTAssertEqual(model.roots.map(\.folder), ["/work/tools", "/work/notes"])

        let notFound = model.locate(fileID: "notes/README.md")
        XCTAssertNil(notFound, "nothing loaded yet")

        model.setRoots([ReviewRoot(folder: "/work/tools", repo: URL(fileURLWithPath: "/work/tools"))])
        XCTAssertEqual(model.roots.map(\.prefix), [""], "back to one root: paths lose the prefix")
    }

    /// Two real repositories with the same changed file: both load into one diff, and each merged file
    /// leads back to its own repository on disk.
    func testTwoRepositoriesLoadIntoOneDiffAndEachFileMapsBackToItsOwn() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("review-roots-\(UUID().uuidString.prefix(8))")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        let repos = try ["tools", "notes"].map { name -> URL in
            let repo = base.appendingPathComponent(name)
            try FileManager.default.createDirectory(at: repo, withIntermediateDirectories: true)
            try git(repo, ["init", "-q"])
            try "one\n".write(to: repo.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
            try git(repo, ["add", "README.md"])
            try git(repo, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "init"])
            try "one\ntwo \(name)\n".write(to: repo.appendingPathComponent("README.md"), atomically: true, encoding: .utf8)
            return repo
        }

        let model = ReviewModel(repo: repos[0], options: DiffViewOptions(), renderer: NullRenderer())
        model.setRoots([
            ReviewRoot(folder: repos[0].path, repo: repos[0]),
            ReviewRoot(folder: repos[1].path, repo: repos[1], removable: true),
        ])
        model.reload()
        let deadline = Date().addingTimeInterval(20)
        while (model.loading || model.files.count < 2) && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }

        XCTAssertEqual(model.files.map(\.path), ["tools/README.md", "notes/README.md"])
        XCTAssertEqual(model.roots.map(\.files.count), [1, 1])
        XCTAssertNil(model.error, "a multi-root diff never shows one root's state over the whole pane")
        let notes = try XCTUnwrap(model.files.first { $0.path == "notes/README.md" })
        XCTAssertEqual(notes.newContents, "one\ntwo notes\n")
        XCTAssertEqual(model.absolutePath(of: notes), repos[1].appendingPathComponent("README.md").path)
        XCTAssertEqual(model.repoPath(of: notes.id), "README.md")
        XCTAssertEqual(model.file(atPath: repos[1].appendingPathComponent("README.md").path)?.id, "notes/README.md")
        XCTAssertEqual(model.file(atPath: "README.md")?.id, "tools/README.md", "a relative path means the session's own repository")

        // A PR head that no checkout holds covers only the PR's own repository: its files go to the
        // host, and the other root's files still open on disk.
        let tools = try XCTUnwrap(model.files.first { $0.path == "tools/README.md" })
        model.remoteHead = ReviewRemoteHead(branch: "feat/x", sha: "0123456789abcdef", base: nil) { path, line in
            URL(string: "https://example.com/blob/0123456789abcdef/\(path)#L\(line ?? 0)")
        }
        XCTAssertNil(model.absolutePath(of: tools))
        XCTAssertEqual(model.hostURL(of: tools.id, line: 2)?.absoluteString, "https://example.com/blob/0123456789abcdef/README.md#L2")
        XCTAssertEqual(model.absolutePath(of: notes), repos[1].appendingPathComponent("README.md").path)
        XCTAssertNil(model.hostURL(of: notes.id))
        model.remoteHead = nil

        // Unticking a root drops its files at once, before any reload.
        model.setRoots([
            ReviewRoot(folder: repos[0].path, repo: repos[0]),
            ReviewRoot(folder: repos[1].path, repo: repos[1], shown: false, removable: true),
        ])
        XCTAssertEqual(model.files.map(\.path), ["tools/README.md"])
    }

    @discardableResult
    private func git(_ repo: URL, _ args: [String]) throws -> Int32 {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        process.arguments = ["-C", repo.path] + args
        // Scratch repositories: no signing, hooks or other settings from the developer's git config.
        var environment = ProcessInfo.processInfo.environment
        environment["GIT_CONFIG_GLOBAL"] = "/dev/null"
        environment["GIT_CONFIG_NOSYSTEM"] = "1"
        process.environment = environment
        try process.run()
        process.waitUntilExit()
        XCTAssertEqual(process.terminationStatus, 0, "git \(args.joined(separator: " "))")
        return process.terminationStatus
    }
}

/// A renderer that draws nothing, for models built in tests.
private final class NullRenderer: DiffRenderer {
    let view = NSView()
    var onEvent: ((DiffRendererEvent) -> Void)?
    func show(_ files: [DiffFile], fresh: Bool) {}
    func apply(_ options: DiffViewOptions) {}
    func reveal(fileID: String) {}
    func find() {}
    func showComments(_ comments: [RenderedComment]) {}
    func threadActionFinished(id: String, ok: Bool) {}
    func setThreadSelection(_ ids: [String]) {}
    func focusThread(cardID: String?, reply: Bool) {}
    func showKeys(_ show: Bool) {}
    func setBlame(_ payload: AgentBlamePayload) {}
    func showBlame(fileID: String, line: Int) {}
}
