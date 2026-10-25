import AppKit
@testable import GenesisKit
import XCTest

/// The file sidebar from the keyboard (UX audit 2026-10-25, E3, E4, E8, E9): the tree walks with the arrows and opens
/// with Return, and the search says when it was cut or could not run.
@MainActor
final class MarkdownSidebarKeyboardTests: XCTestCase {
    /// notes/ (open) › a.md, b.md; z.md at the root.
    private let rows = [
        FileTreeRow(id: "/v/notes", name: "notes", isFolder: true, depth: 0, expanded: true),
        FileTreeRow(id: "/v/notes/a.md", name: "a.md", isFolder: false, depth: 1),
        FileTreeRow(id: "/v/notes/b.md", name: "b.md", isFolder: false, depth: 1),
        FileTreeRow(id: "/v/old", name: "old", isFolder: true, depth: 0),
        FileTreeRow(id: "/v/z.md", name: "z.md", isFolder: false, depth: 0),
    ]

    private func action(_ key: MarkdownTreeKey, at cursor: Int?) -> MarkdownTreeKeyAction {
        MarkdownTreeKeys.action(for: key, rows: rows, cursor: cursor)
    }

    func testUpAndDownMoveAndStopAtTheEnds() {
        XCTAssertEqual(action(.down, at: nil), .select(0), "the first Down lands on the first row")
        XCTAssertEqual(action(.down, at: 1), .select(2))
        XCTAssertEqual(action(.down, at: 4), .select(4))
        XCTAssertEqual(action(.up, at: 0), .select(0))
        XCTAssertEqual(action(.up, at: 3), .select(2))
    }

    func testRightOpensAFolderThenEntersIt() {
        XCTAssertEqual(action(.right, at: 3), .toggle(3), "a closed folder opens")
        XCTAssertEqual(action(.right, at: 0), .select(1), "an open folder: its first row")
        XCTAssertEqual(action(.right, at: 1), MarkdownTreeKeyAction.none, "a file has nothing to the right")
    }

    func testLeftClosesAFolderOrGoesToItsParent() {
        XCTAssertEqual(action(.left, at: 0), .toggle(0))
        XCTAssertEqual(action(.left, at: 2), .select(0), "a file inside notes: back to notes")
        XCTAssertEqual(action(.left, at: 4), MarkdownTreeKeyAction.none, "a row at the root has no parent row")
    }

    func testReturnOpensAFileAndTogglesAFolder() {
        XCTAssertEqual(action(.open, at: 1), .open(1))
        XCTAssertEqual(action(.open, at: 3), .toggle(3))
        XCTAssertEqual(action(.navigate, at: 3), .navigate(3), "⌘↓ on a folder makes it the root")
        XCTAssertEqual(action(.parent, at: nil), .up)
        XCTAssertEqual(action(.escape, at: 2), .clear)
        XCTAssertEqual(action(.escape, at: nil), MarkdownTreeKeyAction.none, "Esc with no keyboard row goes on to the window")
    }

    func testTheTableWalksAndOpensFromTheKeyboard() {
        let table = MarkdownTreeTableView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row")))
        let coordinator = MarkdownTreeTable<Int>.Coordinator()
        coordinator.rows = rows
        coordinator.table = table
        table.dataSource = coordinator
        table.delegate = coordinator
        table.coordinatorKeys = coordinator
        table.takesKeyboard = true
        table.reloadData()
        var opened: [String] = []
        var toggled: [String] = []
        coordinator.keys = MarkdownTreeKeys(
            open: { opened.append($0.id) }, toggle: { toggled.append($0.id) }, navigate: { _ in }, up: {},
            start: { rows in rows.firstIndex { $0.id == "/v/notes/a.md" } }
        )

        XCTAssertTrue(table.acceptsFirstResponder)
        XCTAssertEqual(table.selectionHighlightStyle, .regular, "the keyboard row is drawn")
        coordinator.beginKeyboard(at: nil)
        XCTAssertEqual(table.selectedRow, 1, "the keyboard starts on the open file")
        XCTAssertTrue(coordinator.handle(.down))
        XCTAssertEqual(table.selectedRow, 2)
        XCTAssertTrue(coordinator.handle(.open))
        XCTAssertEqual(opened, ["/v/notes/b.md"])
        XCTAssertTrue(coordinator.handle(.left))
        XCTAssertEqual(table.selectedRow, 0)
        XCTAssertTrue(coordinator.handle(.left))
        XCTAssertEqual(toggled, ["/v/notes"])

        // The folder closed: its rows left, and the keyboard stays on the folder, not on the index it had.
        coordinator.rows = [
            FileTreeRow(id: "/v/notes", name: "notes", isFolder: true, depth: 0),
            FileTreeRow(id: "/v/old", name: "old", isFolder: true, depth: 0),
        ]
        table.reloadData()
        coordinator.keepCursor()
        XCTAssertEqual(coordinator.cursor, 0)

        coordinator.endKeyboard()
        XCTAssertEqual(table.selectedRow, -1)
        XCTAssertNil(coordinator.cursor)
    }

    func testATreeWithoutKeysNeverTakesTheKeyboard() {
        let table = MarkdownTreeTableView()
        XCTAssertFalse(table.acceptsFirstResponder)
    }

    func testTheArrowKeysMapToTreeKeys() throws {
        func key(_ code: UInt16, _ flags: NSEvent.ModifierFlags = []) throws -> MarkdownTreeKey? {
            let event = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: 0,
                                                       windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "",
                                                       isARepeat: false, keyCode: code))
            return MarkdownTreeKey(event)
        }
        XCTAssertEqual(try key(125), .down)
        XCTAssertEqual(try key(125, .command), .navigate)
        XCTAssertEqual(try key(126, .command), .parent)
        XCTAssertEqual(try key(36), .open)
        XCTAssertEqual(try key(53), .escape)
        XCTAssertNil(try key(0), "a letter is not the tree's")
    }

    // MARK: Search and empty states

    func testACutListSaysWhatWasCut() {
        XCTAssertEqual(MarkdownFileTreeView.cutNotice(names: true, indexFull: false), "First 200 names shown. Type more of the name")
        XCTAssertEqual(MarkdownFileTreeView.cutNotice(names: true, indexFull: true),
                       "Index stopped at 200000 files. Pick a narrower folder")
        XCTAssertEqual(MarkdownFileTreeView.cutNotice(names: false, indexFull: true), "First 300 hits shown")
    }

    func testRipgrepFailsOnlyWhenItFoundNothing() {
        XCTAssertTrue(FileTreeSearch.ripgrepFailed(status: 2, hits: 0))
        XCTAssertFalse(FileTreeSearch.ripgrepFailed(status: 2, hits: 4), "an unreadable file beside real hits is no failure")
        XCTAssertFalse(FileTreeSearch.ripgrepFailed(status: 1, hits: 0), "1 is ripgrep's plain No match")
    }

    func testAnEmptyFolderAndAnUnreadableOneAreDifferentStates() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("tree-empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        XCTAssertEqual(MarkdownTreeEmpty.check(folder.path), .empty)
        XCTAssertEqual(MarkdownTreeEmpty.check(folder.appendingPathComponent("gone").path), .unreadable)
    }
}
