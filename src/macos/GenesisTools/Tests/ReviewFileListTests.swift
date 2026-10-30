import AppKit
import XCTest
@testable import GenesisToolsHost
@testable import GenesisToolsHub

/// The file list's lookups are built once per change of what they read, not per row: they give the answers the
/// searches over every file gave.
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
}
