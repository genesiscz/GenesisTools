import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// The viewer's tree is an AppKit table (`MarkdownTreeTable`): a folder opening slides its rows in, and the table
/// ends with exactly the model's rows.
final class MarkdownTreeTableTests: XCTestCase {
    private func row(_ path: String, folder: Bool = false, depth: Int = 0, expanded: Bool = false) -> FileTreeRow {
        FileTreeRow(id: path, name: (path as NSString).lastPathComponent, isFolder: folder, depth: depth, expanded: expanded)
    }

    /// Opening and closing a folder inserts and removes the corresponding table rows.
    @MainActor
    func testOpeningAFolderInsertsItsRowsAndClosingRemovesThem() throws {
        try XCTSkipIf(NSWorkspace.shared.accessibilityDisplayShouldReduceMotion, "Reduce Motion reloads instead")
        let table = NSTableView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row")))
        let source = Source()
        table.dataSource = source
        table.delegate = source
        let closed = [row("/v/Á", folder: true), row("/v/b.md")]
        source.rows = closed
        table.reloadData()
        XCTAssertEqual(table.numberOfRows, 2)

        let open = [row("/v/Á", folder: true, expanded: true), row("/v/Á/č.md", depth: 1), row("/v/Á/d.md", depth: 1),
                    row("/v/b.md")]
        source.rows = open
        XCTAssertTrue(MarkdownTreeTable<Int>.animate(from: closed, to: open, in: table))
        XCTAssertEqual(table.numberOfRows, 4)

        source.rows = closed
        XCTAssertTrue(MarkdownTreeTable<Int>.animate(from: open, to: closed, in: table))
        XCTAssertEqual(table.numberOfRows, 2)
    }

    /// Cached path keys agree for identical UTF-8 paths and distinguish neighboring names.
    func testAnEqualPathIsAnEqualKeyAndANearOneIsNot() {
        XCTAssertEqual(FileTreeRowKey("/v/ČEZ/a.md"), FileTreeRowKey(String(decoding: Array("/v/ČEZ/a.md".utf8), as: UTF8.self)))
        XCTAssertNotEqual(FileTreeRowKey("/v/ČEZ/a.md"), FileTreeRowKey("/v/ČEZ/b.md"))
        XCTAssertEqual(Set([FileTreeRowKey("/v/ČEZ"), FileTreeRowKey("/v/ČEZ")]).count, 1)
    }

    /// A note opened as a precomposed name ("Čtení.md", NFC) against a listing that stored the decomposed name (NFD).
    /// `FileTreeRowKey` compares exact bytes, so the selection has to be put through the listing's form first.
    func testADecomposedSelectionMatchesThePrecomposedListingName() {
        let composed = "Čtení.md".precomposedStringWithCanonicalMapping
        let decomposed = "Čtení.md".decomposedStringWithCanonicalMapping
        XCTAssertFalse(composed.utf8.elementsEqual(decomposed.utf8))
        let folder = "/vault/notes"
        let composedPath = folder + "/" + composed
        let listed = URL(fileURLWithPath: composedPath).standardizedFileURL.path.nativeUTF8
        XCTAssertFalse(composedPath.utf8.elementsEqual(listed.utf8))
        let row = FileTreeRowKey(listed)
        XCTAssertNotEqual(FileTreeRowKey(composedPath), row, "the raw bytes of the two forms stay different keys")
        XCTAssertEqual(FileTreeRowKey(selection: composedPath), row)
        XCTAssertEqual(FileTreeRowKey(selection: folder + "/" + decomposed), row)
    }

    @MainActor
    private final class Source: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        var rows: [FileTreeRow] = []
        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            return NSTextField(labelWithString: rows[row].name)
        }
    }
}
