import SwiftUI
import XCTest
@testable import GenesisKit

/// The shared file tree: folders first in Finder's order, a flat row list where an open folder's children
/// sit under it, listings off the main thread, and Finder's rename, duplicate and trash rules.
@MainActor
final class FileTreeTests: XCTestCase {
    private var root: URL!

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("filetree-\(UUID().uuidString)")
        let fm = FileManager.default
        try fm.createDirectory(at: root.appendingPathComponent("beta/inner"), withIntermediateDirectories: true)
        try fm.createDirectory(at: root.appendingPathComponent("Alpha"), withIntermediateDirectories: true)
        try Data("x".utf8).write(to: root.appendingPathComponent("note 10.md"))
        try Data("x".utf8).write(to: root.appendingPathComponent("note 2.md"))
        try Data("x".utf8).write(to: root.appendingPathComponent(".hidden"))
        try Data("x".utf8).write(to: root.appendingPathComponent("beta/inner/deep.md"))
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: root)
    }

    private func settle(_ model: FileTreeModel, until done: @escaping () -> Bool) async {
        for _ in 0..<200 where !done() {
            try? await Task.sleep(for: .milliseconds(10))
        }
    }

    func testRowEqualityIncludesEveryPaletteColorAndTheResolvedFont() {
        let row = FileTreeRow(id: root.appendingPathComponent("note.md").path, name: "note.md", isFolder: false, depth: 0)
        let model = FileTreeModel(root: root)
        let actions = FileTreeActions(open: { _ in }, setRoot: { _ in }, changed: { _ in })
        var size: CGFloat = 12
        let style = FileTreeStyle(text: .white, secondary: .gray, muted: .gray, accent: .blue,
                                  selection: .blue.opacity(0.2), font: { .system(size: size, weight: $0 ? .semibold : .regular) })
        func view(_ style: FileTreeStyle) -> FileTreeRowView {
            FileTreeRowView(row: row, selected: true, icon: "doc", style: style, model: model, actions: actions)
        }
        let original = view(style)
        XCTAssertTrue(original == view(style), "unchanged rows still skip a render")
        let colors: [WritableKeyPath<FileTreeStyle, Color>] = [\.text, \.secondary, \.muted, \.accent, \.selection]
        for key in colors {
            var changed = style
            changed[keyPath: key] = .red
            XCTAssertFalse(original == view(changed), "a changed palette must redraw the row")
        }
        size = 18
        XCTAssertFalse(original == view(style), "a captured font setting must compare against the old resolved value")
        var sameFont = style
        sameFont.font = { .system(size: 18, weight: $0 ? .semibold : .regular) }
        XCTAssertTrue(view(style) == view(sameFont), "font values, not closure identities, decide equality")
    }

    func testListingPutsFoldersFirstInFinderOrderAndSkipsHiddenFiles() {
        let names = FileTreeListing.entries(of: root.path).map(\.name)
        XCTAssertEqual(names, ["Alpha", "beta", "note 2.md", "note 10.md"])
    }

    func testRevealOpensTheChainAndRowsAreFlatWithDepth() async {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        model.reveal(root.appendingPathComponent("beta/inner/deep.md"))
        await settle(model) { model.rows.contains { $0.name == "deep.md" } }

        XCTAssertEqual(model.rows.map(\.name), ["Alpha", "beta", "inner", "deep.md", "note 2.md", "note 10.md"])
        XCTAssertEqual(model.rows.map(\.depth), [0, 0, 1, 2, 0, 0])

        model.toggle(root.appendingPathComponent("beta").standardizedFileURL.path)
        XCTAssertEqual(model.rows.map(\.name), ["Alpha", "beta", "note 2.md", "note 10.md"], "closing a folder hides its subtree at once")
    }

    func testReRootingReadsAnOpenFolderWhoseReadItDropped() async {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        await settle(model) { model.rows.contains { $0.name == "beta" } }

        // Both reads start, then the new root drops them before they land.
        model.reveal(root.appendingPathComponent("beta/inner/deep.md"))
        model.setRoot(root.appendingPathComponent("beta"))
        await settle(model) { model.rows.contains { $0.name == "deep.md" } }

        XCTAssertEqual(model.rows.map(\.name), ["inner", "deep.md"])
    }

    func testRefreshDuringAPendingReadReadsTheFolderAgain() async throws {
        let model = FileTreeModel(root: root)
        model.setRoot(root)
        // The read starts, lists off the main actor while the main actor sleeps, and cannot publish yet:
        // its listing has the old name.
        await Task.yield()
        Thread.sleep(forTimeInterval: 0.2)
        _ = try FileOperations.rename(root.appendingPathComponent("note 2.md"), to: "renamed.md")
        model.refresh(root.standardizedFileURL.path)
        await settle(model) { model.rows.contains { $0.name == "renamed.md" } }

        XCTAssertEqual(model.rows.map(\.name), ["Alpha", "beta", "note 10.md", "renamed.md"])
    }

    func testRenameRechecksEditsMadeWhileThePromptIsOpen() throws {
        let note = root.appendingPathComponent("note 2.md")
        let target = root.appendingPathComponent("renamed.md")
        var dirty = false
        var changes: [FileChange] = []
        var reports: [String] = []
        var checks = 0
        let guardChange: (URL) -> String? = { _ in
            checks += 1
            return dirty ? "Unsaved edits" : nil
        }
        FileOperations.runRename(note, guardChange: guardChange, changed: { changes.append($0) },
                                 prompt: { _ in dirty = true; return "renamed.md" },
                                 report: { reports.append($0) })
        XCTAssertEqual(checks, 2)
        XCTAssertEqual(reports, ["Unsaved edits"])
        XCTAssertTrue(changes.isEmpty)
        XCTAssertTrue(FileManager.default.fileExists(atPath: note.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: target.path))
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "x")

        dirty = false
        reports = []
        FileOperations.runRename(note, guardChange: guardChange, changed: { changes.append($0) },
                                 prompt: { _ in "renamed.md" }, report: { reports.append($0) })
        XCTAssertEqual(checks, 4)
        XCTAssertTrue(reports.isEmpty)
        XCTAssertEqual(changes, [.renamed(from: note, to: target)])
        XCTAssertTrue(FileManager.default.fileExists(atPath: target.path))
    }

    func testDuplicateFollowsFinderNamingAndRenameRefusesBadNames() throws {
        let note = root.appendingPathComponent("note 2.md")
        let first = try FileOperations.duplicate(note)
        let second = try FileOperations.duplicate(note)
        XCTAssertEqual(first.lastPathComponent, "note 2 copy.md")
        XCTAssertEqual(second.lastPathComponent, "note 2 copy 2.md")

        XCTAssertNotNil(FileOperations.problem(renaming: note, to: "a/b.md"))
        XCTAssertNotNil(FileOperations.problem(renaming: note, to: "  "))
        XCTAssertNotNil(FileOperations.problem(renaming: note, to: "note 10.md"), "an existing name is refused")
        XCTAssertNil(FileOperations.problem(renaming: note, to: "renamed.md"))
        XCTAssertNil(FileOperations.problem(renaming: note, to: "Note 2.md"), "a case-only rename names the same file")
        let renamed = try FileOperations.rename(note, to: "renamed.md")
        XCTAssertTrue(FileManager.default.fileExists(atPath: renamed.path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: note.path))
    }
}
