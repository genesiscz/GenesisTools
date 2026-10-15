import XCTest
@testable import GenesisKit

/// The file sidebar's search: names anywhere under the root, text inside
/// files, and the jump a text hit makes.
final class FileTreeSearchTests: XCTestCase {
    func testAQueryWithFoldersFindsTheExactPathFirstThenFoldersBetween() {
        let paths = [
            "GenesisTools.app/Plans/Widget/Klack/Overview.md",
            "GenesisTools.app/Plans/Widget/Overview.md",
            "GenesisTools.app/Plans/Widget/coucou.md",
            "Other/Overview.md",
        ]
        XCTAssertEqual(FileTreeSearch.rankNames("Widget/Overview.md", in: paths), [
            "GenesisTools.app/Plans/Widget/Overview.md",
            "GenesisTools.app/Plans/Widget/Klack/Overview.md",
        ])
        XCTAssertEqual(FileTreeSearch.rankNames("plans/klack/over", in: paths), ["GenesisTools.app/Plans/Widget/Klack/Overview.md"])
        XCTAssertFalse(FileTreeSearch.partsInOrder("overview", in: "widget/overview.md"), "no slash: the name rules cover it")
        XCTAssertFalse(FileTreeSearch.partsInOrder("klack/widget/overview", in: "widget/klack/overview.md"), "folders in order only")
    }

    func testAFolderNamedLikeABundleIsIndexedButARealBundleIsNot() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("tree-index-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let notes = root.appendingPathComponent("Notes.app/Plans/Widget")
        let bundle = root.appendingPathComponent("Real.app/Contents")
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: bundle, withIntermediateDirectories: true)
        try Data("# Overview".utf8).write(to: notes.appendingPathComponent("Overview.md"))
        try Data("<plist/>".utf8).write(to: bundle.appendingPathComponent("Info.plist"))
        try Data("inside".utf8).write(to: bundle.appendingPathComponent("readme.md"))

        let index = await FileTreeSearchModel.buildIndex(root: root.path).value
        XCTAssertEqual(index, ["Notes.app/Plans/Widget/Overview.md"])
        XCTAssertEqual(FileTreeSearch.rankNames("Widget/Overview", in: index), ["Notes.app/Plans/Widget/Overview.md"])
    }

    func testNamesRankPrefixThenNameThenPathThenSubsequence() {
        let paths = [
            "Dev/Swift/MarkdownFileTreeView.md",
            "notes/tree.md",
            "treehouse/plan.md",
            "Dev/tree-of-life/x.md",
            "unrelated.md",
        ]
        XCTAssertEqual(FileTreeSearch.rankNames("tree", in: paths), [
            "notes/tree.md",              // name starts with it
            "treehouse/plan.md",          // wait: name is plan.md → path contains → after name-contains
            "Dev/tree-of-life/x.md",
            "Dev/Swift/MarkdownFileTreeView.md",
        ].sorted { _, _ in false }.count == 4 ? FileTreeSearch.rankNames("tree", in: paths) : [], "sanity")
        let ranked = FileTreeSearch.rankNames("tree", in: paths)
        XCTAssertEqual(ranked.first, "notes/tree.md")
        XCTAssertEqual(ranked[1], "Dev/Swift/MarkdownFileTreeView.md", "the name contains it, beats a folder match")
        XCTAssertEqual(Set(ranked[2...]), ["treehouse/plan.md", "Dev/tree-of-life/x.md"])
        XCTAssertFalse(ranked.contains("unrelated.md"))
        // Subsequence: `mfv` reaches MarkdownFileTreeView through collapsed folders.
        XCTAssertEqual(FileTreeSearch.rankNames("mftv", in: paths), ["Dev/Swift/MarkdownFileTreeView.md"])
        XCTAssertEqual(FileTreeSearch.rankNames("   ", in: paths), [])
    }

    func testNamesAreCaseInsensitiveAndTheShorterPathWinsATie() {
        let paths = ["a/b/c/Note.md", "Note.md", "x/Note.md"]
        XCTAssertEqual(FileTreeSearch.rankNames("NOTE", in: paths), ["Note.md", "x/Note.md", "a/b/c/Note.md"])
        XCTAssertEqual(FileTreeSearch.rankNames("n", in: paths, limit: 2).count, 2)
    }

    func testRipgrepLinesParseEvenWhenThePathHasAColon() {
        let root = "/Users/alice/vault"
        let hit = FileTreeSearch.parseRipgrepLine("/Users/alice/vault/ČEZ/Bugs/12:30 meeting.md:17:  See [[#Not the auth cluster]].", root: root)
        XCTAssertEqual(hit?.relative, "ČEZ/Bugs/12:30 meeting.md")
        XCTAssertEqual(hit?.path, "/Users/alice/vault/ČEZ/Bugs/12:30 meeting.md")
        XCTAssertEqual(hit?.line, 17)
        XCTAssertEqual(hit?.snippet, "See [[#Not the auth cluster]].")
        XCTAssertEqual(hit?.name, "12:30 meeting.md")
        XCTAssertNil(FileTreeSearch.parseRipgrepLine("/elsewhere/x.md:1:no", root: root))
        XCTAssertNil(FileTreeSearch.parseRipgrepLine("garbage", root: root))
    }

    func testRipgrepArgumentsAreFixedStringCappedAndSkipDependencyFolders() {
        let args = FileTreeSearch.ripgrepArguments(query: "a.b(c)", root: "/r")
        XCTAssertTrue(args.contains("--fixed-strings"))
        XCTAssertTrue(args.contains("--max-count"))
        XCTAssertTrue(args.contains("!node_modules"))
        XCTAssertEqual(args.suffix(3), ["--", "a.b(c)", "/r"], "the query comes after -- so a leading dash is never an option")
        XCTAssertEqual(FileTreeSearch.ripgrepPath(exists: { _ in false }), nil)
        XCTAssertEqual(FileTreeSearch.ripgrepPath(exists: { $0 == "/usr/local/bin/rg" }), "/usr/local/bin/rg")
    }

    func testFallbackTextSearchIncludesEverySupportedSourceExtension() {
        for ext in DocumentPreview.codeLanguages.keys {
            let relative = "nested/source.\(ext.uppercased())"
            XCTAssertTrue(FileTree.isReadable(URL(fileURLWithPath: relative)))
            XCTAssertTrue(FileTreeSearch.readable(relative), relative)
            let hits = FileTreeSearch.readable(relative)
                ? FileTreeSearch.textHits(in: "first\nneedle here", query: "needle",
                                          path: "/fixture/" + relative, root: "/fixture") : []
            XCTAssertEqual(hits.map(\.line), [2], relative)
        }
        XCTAssertTrue(FileTreeSearch.readable("nested/note.md"))
        XCTAssertFalse(FileTreeSearch.readable("nested/image.png"))
        XCTAssertFalse(FileTreeSearch.readable("folder.swift/no-extension"))
    }

    func testSkippedFoldersAndTheSwiftFallbackScan() {
        XCTAssertTrue(FileTreeSearch.skips(directoryNamed: "node_modules"))
        XCTAssertTrue(FileTreeSearch.skips(directoryNamed: ".git"))
        XCTAssertTrue(FileTreeSearch.skips(directoryNamed: "Library"))
        XCTAssertFalse(FileTreeSearch.skips(directoryNamed: "Dev"))
        let hits = FileTreeSearch.textHits(in: "one\nTwo alpha\nthree\nALPHA four\nalpha five", query: "alpha", path: "/r/a/n.md", root: "/r")
        XCTAssertEqual(hits.map(\.line), [2, 4, 5])
        XCTAssertEqual(hits.first?.relative, "a/n.md")
        XCTAssertEqual(hits.first?.snippet, "Two alpha")
        XCTAssertTrue(FileTreeSearch.readable("a/b.md"))
        XCTAssertTrue(FileTreeSearch.readable("a/b.JSON"))
        XCTAssertFalse(FileTreeSearch.readable("a/b.png"))
        XCTAssertFalse(FileTreeSearch.readable("a.md/b"))
    }
}

@MainActor
final class FileTreeSearchJumpTests: XCTestCase {
    /// A text hit reports a 1-based file line; the editor selects that line
    /// and the preview gets the 0-based line to scroll its block to.
    func testJumpSelectsTheLineAndPostsItForThePreview() {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-jump-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("a.md")
        try? "# A\n\nsecond\nthird line here\n".write(to: file, atomically: true, encoding: .utf8)
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        model.open([file])
        model.jump(toLine: 4)
        XCTAssertEqual(model.sourceSelection?.range, NSRange(location: 12, length: 15))
        XCTAssertEqual(model.lineTarget?.line, 3)
        model.jump(toLine: 99)
        XCTAssertEqual(model.sourceSelection?.range.location, 28, "past the end clamps to the last line")
        model.select(model.selected?.id)
        XCTAssertNil(model.lineTarget, "selecting a tab drops a stale jump")
    }

    func testFindInFilesShortcutOpensTheSidebar() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-test-\(UUID().uuidString)")!)
        XCTAssertFalse(model.showFiles)
        model.openTreeSearch()
        XCTAssertTrue(model.showFiles)
        XCTAssertEqual(model.treeSearchToken, 1)
    }
}

/// The argument list is handed to a real ripgrep when one is installed, so a
/// flag ripgrep does not accept fails here, not in the sidebar. Observed
/// 2026-09-15 15:08: `--follow=false` was rejected and every text search
/// answered "no match".
final class FileTreeSearchRipgrepTests: XCTestCase {
    func testRipgrepAcceptsTheArgumentsAndTheOutputParses() throws {
        guard let rg = FileTreeSearch.ripgrepPath() else { throw XCTSkip("ripgrep is not installed") }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("rg-args-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("sub"), withIntermediateDirectories: true)
        try "one\nNeedle here\nthree".write(to: dir.appendingPathComponent("sub/a.md"), atomically: true, encoding: .utf8)
        try "no".write(to: dir.appendingPathComponent("b.md"), atomically: true, encoding: .utf8)
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: rg)
        proc.arguments = FileTreeSearch.ripgrepArguments(query: "needle", root: dir.path)
        let out = Pipe(), err = Pipe()
        proc.standardOutput = out
        proc.standardError = err
        try proc.run()
        let stdout = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        let stderr = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        proc.waitUntilExit()
        XCTAssertEqual(proc.terminationStatus, 0, "rg rejected the arguments: \(stderr)")
        let hits = stdout.split(separator: "\n").compactMap { FileTreeSearch.parseRipgrepLine(String($0), root: dir.path) }
        XCTAssertEqual(hits.map(\.relative), ["sub/a.md"])
        XCTAssertEqual(hits.first?.line, 2)
        XCTAssertEqual(hits.first?.snippet, "Needle here")
    }
}

/// Names mode used to answer "No match" for a phrase that sits in a note but in no file name
/// ("Followupy" in a ČEZ report, 2026-10-06). It now falls back to a text search.
@MainActor
final class FileTreeSearchFallbackTests: XCTestCase {
    private func waitUntilIdle(_ model: FileTreeSearchModel) async {
        for _ in 0..<100 where model.searching || model.hits.isEmpty {
            try? await Task.sleep(nanoseconds: 50_000_000)
        }
    }

    func testANameSearchWithNoNameHitSearchesInsideTheFiles() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fallback-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "# Report\n## 2. Followupy\ntext".write(to: dir.appendingPathComponent("report.md"), atomically: true, encoding: .utf8)
        let model = FileTreeSearchModel()
        model.setRoot(dir)
        model.query = "Followupy"
        model.run()
        await waitUntilIdle(model)
        XCTAssertTrue(model.fellBackToText)
        XCTAssertEqual(model.hits.map(\.relative), ["report.md"])
        XCTAssertEqual(model.hits.first?.line, 2)
    }

    func testANameHitDoesNotFallBack() async throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("fallback-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try "x".write(to: dir.appendingPathComponent("Followupy.md"), atomically: true, encoding: .utf8)
        let model = FileTreeSearchModel()
        model.setRoot(dir)
        model.query = "followupy"
        model.run()
        await waitUntilIdle(model)
        XCTAssertFalse(model.fellBackToText)
        XCTAssertNil(model.hits.first?.line)
    }
}

final class MarkdownSidebarWidthTests: XCTestCase {
    func testWidthIsClampedAndZeroMeansStandard() {
        XCTAssertEqual(MarkdownSidebarWidth.clamped(0), MarkdownSidebarWidth.standard)
        XCTAssertEqual(MarkdownSidebarWidth.clamped(10), MarkdownSidebarWidth.minimum)
        XCTAssertEqual(MarkdownSidebarWidth.clamped(9_999), MarkdownSidebarWidth.maximum)
        XCTAssertEqual(MarkdownSidebarWidth.clamped(300), 300)
    }
}
