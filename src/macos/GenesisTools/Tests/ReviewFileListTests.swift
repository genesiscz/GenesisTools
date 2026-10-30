import AppKit
import SwiftUI
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// The file list's lookups and rows are built once per change of what they read, not per row or per body: the
/// lookups give the answers the searches over every file gave, the cached rows follow every input, and the rows'
/// value is equal across a publish that changes nothing a row draws (so `.equatable()` draws no row).
@MainActor
final class ReviewFileListTests: XCTestCase {
    private var base: URL!

    override func setUpWithError() throws {
        base = FileManager.default.temporaryDirectory
            .appendingPathComponent("review-file-list-\(UUID().uuidString.prefix(8))", isDirectory: true)
            .resolvingSymlinksInPath()
        for name in ["session", "tools", "notes"] {
            try FileManager.default.createDirectory(at: base.appendingPathComponent(name), withIntermediateDirectories: true)
        }
        // A symlink resolves only through files that exist, so the READMEs are on disk.
        for name in ["tools", "notes"] {
            try Data("x\n".utf8).write(to: base.appendingPathComponent("\(name)/README.md"))
        }
        // A second spelling of the tools repository, as a folder added through a symlink reaches it.
        try FileManager.default.createSymbolicLink(at: base.appendingPathComponent("tools-link"), withDestinationURL: base.appendingPathComponent("tools"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: base)
    }

    private func file(_ path: String, id: String? = nil, oldPath: String? = nil, add: Int = 1) -> DiffFile {
        DiffFile(id: id ?? path, path: path, oldPath: oldPath, status: oldPath == nil ? .modified : .renamed, additions: add, deletions: 0,
                 oldContents: "a\n", newContents: "b\n", skipped: nil)
    }

    /// Two roots whose files share relative paths, a rename, and two files of one root with one id (the first wins).
    private func twoRootModel() -> ReviewModel {
        let model = ReviewModel(repo: base.appendingPathComponent("session"), options: DiffViewOptions(), renderer: NullRenderer())
        var tools = ReviewRoot(folder: base.appendingPathComponent("tools").path, repo: base.appendingPathComponent("tools"))
        tools.files = [
            file("README.md", add: 3),
            file("src/new.ts", oldPath: "src/old.ts"),
            file("src/a.ts", add: 2),
            file("src/a-copy.ts", id: "src/a.ts"),
        ]
        var notes = ReviewRoot(folder: base.appendingPathComponent("notes").path, repo: base.appendingPathComponent("notes"), removable: true)
        notes.files = [file("README.md", add: 5), file("daily/2026-01-02.md", add: 7)]
        model.setRoots([tools, notes])
        return model
    }

    /// `ReviewModel.locate(fileID:)` before the index: the root by prefix, then a search over its files.
    private func searchedLocate(_ model: ReviewModel, _ id: String) -> DiffFile? {
        guard let index = ReviewRoots.index(of: id, in: model.roots), let local = model.roots[index].local(id) else { return nil }
        return model.roots[index].files.first { $0.id == local }
    }

    /// `ReviewModel.file(atPath:)` before the index: symlinks resolved per call, then a search over every file.
    private func searchedFile(_ model: ReviewModel, _ path: String) -> DiffFile? {
        let normalized = path.hasPrefix("/") ? URL(fileURLWithPath: path).resolvingSymlinksInPath().standardizedFileURL.path : path
        let wanted = ReviewRoots.global(path: normalized, in: model.roots)
        return model.files.first { $0.path == wanted || $0.oldPath == wanted }
    }

    func testTheLookupsAnswerAsTheSearchesOverEveryFileDid() {
        let model = twoRootModel()
        XCTAssertEqual(model.files.count, 6, "both roots are merged into the diff")

        let ids = model.files.map(\.id) + ["tools/missing.ts", "elsewhere/README.md", ""]
        for id in ids {
            XCTAssertEqual(model.locate(fileID: id)?.file, searchedLocate(model, id), "locate \(id)")
            XCTAssertEqual(model.repoPath(of: id), searchedLocate(model, id)?.path, "repoPath \(id)")
        }
        XCTAssertEqual(model.locate(fileID: "tools/src/a.ts")?.file.path, "src/a.ts", "of two files with one id the first wins")

        let tools = base.appendingPathComponent("tools").path
        let notes = base.appendingPathComponent("notes").path
        let paths = model.files.map(\.path) + model.files.compactMap(\.oldPath) + [
            "README.md", "src/old.ts", "src/new.ts", "missing.ts",
            tools + "/README.md", tools + "/src/old.ts", tools + "/src/a.ts", notes + "/README.md", notes + "/daily/2026-01-02.md",
            base.appendingPathComponent("tools-link").path + "/README.md", tools + "/../notes/README.md", base.path + "/session/README.md",
        ]
        // Twice: the second round answers from the remembered resolutions, and must not differ.
        for round in 1...2 {
            for path in paths {
                XCTAssertEqual(model.file(atPath: path), searchedFile(model, path), "round \(round): file(atPath: \(path))")
            }
        }
        XCTAssertEqual(model.file(atPath: base.appendingPathComponent("tools-link").path + "/README.md")?.id, "tools/README.md",
                       "a symlinked spelling of a root still finds its file")
        XCTAssertEqual(model.file(atPath: tools + "/src/old.ts")?.id, "tools/src/new.ts", "an old path finds the renamed file")
    }

    func testTheDraftBadgesReachEveryFileTheirRepositoryNamesSo() {
        let model = twoRootModel()
        let lookup = ReviewFileLookup(files: model.files, roots: model.roots)
        XCTAssertEqual(lookup.ids(repoPath: "README.md"), ["tools/README.md", "notes/README.md"],
                       "a draft names a repo-relative path, as repoPath(of:) does for both roots' README")
        for id in model.files.map(\.id) {
            guard let path = model.repoPath(of: id) else { continue }
            XCTAssertTrue(lookup.ids(repoPath: path).contains(id), "\(id) is found by its repo path \(path)")
        }
        XCTAssertEqual(lookup.ids(repoPath: "nothing.md"), [])
    }

    func testTheCachedRowsFollowEveryInputTheyAreBuiltFrom() {
        let model = twoRootModel()
        func fresh() -> [ChangedFilesTreeRow] {
            ChangedFilesTree.rows(model.filteredFiles, tree: model.fileListIsTree, collapsed: model.collapsed, roots: model.fileListTreeRoots)
        }
        var last = model.fileListRows
        XCTAssertEqual(last, fresh())

        let changes: [(String, () -> Void)] = [
            ("fold a folder", { model.collapsed.insert("dir:tools/src") }),
            ("fold a root", { model.collapsed.insert(model.roots[1].rowID) }),
            ("open them again", { model.collapsed = [] }),
            ("flat list", { model.treeMode = false }),
            ("tree again", { model.treeMode = true }),
            ("filter", { model.filter = "readme" }),
            ("no filter", { model.filter = "" }),
            ("untick a root", {
                model.setRoots([model.roots[0], ReviewRoot(folder: model.roots[1].folder, repo: model.roots[1].repo, shown: false, removable: true)])
            }),
            ("new files", { model.files = Array(model.files.dropLast()) }),
        ]
        for (name, change) in changes {
            change()
            let rows = model.fileListRows
            XCTAssertEqual(rows, fresh(), "\(name): the cached rows are the rows of the model as it is now")
            XCTAssertNotEqual(rows, last, "\(name): a positive control, the change shows in the rows")
            last = rows
        }
    }

    func testAPublishThatChangesNoRowInputLeavesTheRowsValueEqual() {
        let model = twoRootModel()
        let first = FileSidebar.rows(of: model) { _ in }

        model.notice = "Saved"
        model.commentCount = 4
        model.loading = true
        model.lastLoaded = Date()
        model.objectWillChange.send()
        let unrelated = FileSidebar.rows(of: model) { _ in }
        XCTAssertTrue(first == unrelated, "nothing a row draws changed, so the rows view draws nothing again")

        var previous = unrelated
        let inputs: [(String, () -> Void)] = [
            ("selection", { model.selectedID = "notes/README.md" }),
            ("fold", { model.collapsed.insert("dir:tools/src") }),
            ("tree mode", { model.treeMode = false }),
            ("filter", { model.filter = "a" }),
            ("root actions", { model.rootActions = ReviewRootActions(setShown: { _, _ in }, remove: { _ in }) }),
            ("remote head", {
                model.remoteHead = ReviewRemoteHead(branch: "feat/x", sha: "0123456789abcdef", base: nil) { _, _, _ in nil }
            }),
            ("roots", {
                model.setRoots([model.roots[0], ReviewRoot(folder: model.roots[1].folder, repo: model.roots[1].repo, shown: false, removable: true)])
            }),
        ]
        for (name, change) in inputs {
            change()
            let next = FileSidebar.rows(of: model) { _ in }
            XCTAssertFalse(previous == next, "\(name): a row input changed, so the rows draw again")
            previous = next
        }
    }

    /// The list draws in GenesisKit's table (`GenTreeTable`): one table row per list row, a fold takes the folder's
    /// rows out, and a scroll target (the diff's file on top, a reveal) brings its row on screen.
    func testTheTableShowsTheRowsFoldsAndScrollsToTheTarget() throws {
        let model = ReviewModel(repo: base.appendingPathComponent("session"), options: DiffViewOptions(), renderer: NullRenderer())
        var tools = ReviewRoot(folder: base.appendingPathComponent("tools").path, repo: base.appendingPathComponent("tools"))
        tools.files = (0..<300).map { file(String(format: "src/part%d/file%03d.ts", $0 / 100, $0)) }
        model.setRoots([tools])
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 620), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        let host = NSHostingView(rootView: FileSidebar(model: model).frame(width: 320, height: 620))
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.contentView = host
        window.order(.below, relativeTo: 0)
        func settle() {
            for _ in 0..<4 {
                host.layoutSubtreeIfNeeded()
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
        }
        settle()
        func table(in view: NSView) -> NSTableView? {
            if let table = view as? NSTableView { return table }
            return view.subviews.lazy.compactMap { table(in: $0) }.first
        }
        let list = try XCTUnwrap(table(in: host), "the file list is a table")
        XCTAssertEqual(list.numberOfRows, model.fileListRows.count)
        XCTAssertEqual(list.numberOfRows, 304, "src, three part folders and 300 files")

        model.collapsed.insert("dir:src/part0")
        settle()
        XCTAssertEqual(list.numberOfRows, 204, "a folded folder keeps its row and hides its 100 files")

        let target = "src/part2/file299.ts"
        model.sidebarScrollTarget = target
        settle()
        let index = try XCTUnwrap(model.fileListRows.firstIndex { $0.id == target })
        let visible = list.rows(in: list.visibleRect)
        XCTAssertTrue(visible.contains(index), "row \(index) is on screen (\(visible))")
        XCTAssertFalse(visible.contains(0), "a positive control: the list moved away from its top")
        window.close()
    }

    /// The Folders mode lays every root's header and tree rows in one table: a tree that lists a folder adds its rows,
    /// and a folded root keeps only its header.
    func testTheFoldersTableFollowsTheTreesAndTheRootFolds() throws {
        let tools = base.appendingPathComponent("tools")
        try FileManager.default.createDirectory(at: tools.appendingPathComponent("src"), withIntermediateDirectories: true)
        try Data("x\n".utf8).write(to: tools.appendingPathComponent("src/a.ts"))
        let review = ReviewModel(repo: tools, options: DiffViewOptions(), renderer: NullRenderer())
        let trees = HubFolderTreeStore()
        let roots = [tools.path, base.appendingPathComponent("notes").path]
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 320, height: 620), styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        let host = NSHostingView(rootView: HubFolderTrees(roots: roots, review: review, trees: trees, changesShown: false).frame(width: 320, height: 620))
        window.contentView = host
        window.order(.below, relativeTo: 0)
        func settle() {
            let end = Date().addingTimeInterval(1)
            while Date() < end {
                host.layoutSubtreeIfNeeded()
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
        }
        func table(in view: NSView) -> NSTableView? {
            if let table = view as? NSTableView { return table }
            return view.subviews.lazy.compactMap { table(in: $0) }.first
        }
        settle()
        let list = try XCTUnwrap(table(in: host), "the Folders list is a table")
        // tools: header, README.md, src; notes: header, README.md.
        XCTAssertEqual(list.numberOfRows, 5)

        trees.model(for: tools.path).toggle(tools.appendingPathComponent("src").path)
        settle()
        XCTAssertEqual(list.numberOfRows, 6, "an opened folder's listing reaches the table")

        trees.toggleFold(tools.path)
        settle()
        XCTAssertEqual(list.numberOfRows, 3, "a folded root keeps its header only")
        window.close()
    }
}
