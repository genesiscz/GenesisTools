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
        XCTAssertTrue(MarkdownTreeTable<Int>.animate(from: closed, to: open, in: table, reduceMotion: false))
        XCTAssertEqual(table.numberOfRows, 4)

        source.rows = closed
        XCTAssertTrue(MarkdownTreeTable<Int>.animate(from: open, to: closed, in: table, reduceMotion: false))
        XCTAssertEqual(table.numberOfRows, 2)
    }

    /// An effective motion override skips native row changes; the caller can still reload the new snapshot.
    @MainActor
    func testEffectiveReduceMotionSkipsInsertAndRemoveAnimations() {
        let table = NSTableView()
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row")))
        let source = Source()
        table.dataSource = source
        table.delegate = source
        let closed = [row("/v/folder", folder: true), row("/v/other.md")]
        let open = [row("/v/folder", folder: true, expanded: true), row("/v/folder/note.md", depth: 1), row("/v/other.md")]
        source.rows = closed
        table.reloadData()
        source.rows = open
        XCTAssertFalse(MarkdownTreeTable<Int>.animate(from: closed, to: open, in: table, reduceMotion: true))
        XCTAssertEqual(table.numberOfRows, 2, "skipping the animation leaves reloading to the caller")
        table.reloadData()
        XCTAssertEqual(table.numberOfRows, 3)
        source.rows = closed
        XCTAssertFalse(MarkdownTreeTable<Int>.animate(from: open, to: closed, in: table, reduceMotion: true))
        table.reloadData()
        XCTAssertEqual(table.numberOfRows, 2, "closing still applies the current snapshot without animation")
    }

    /// App and widget overrides reach isolated cell hosts, including when a mounted cell's preference changes.
    @MainActor
    func testEnvironmentReduceMotionReachesHostedTableCells() throws {
        let rig = MotionRig()
        let rows = [row("/v/folder", folder: true), row("/v/other.md")]
        let open = [row("/v/folder", folder: true, expanded: true), row("/v/folder/note.md", depth: 1), row("/v/other.md")]
        rig.rows = rows
        let box = MarkdownTreeScrollBox()
        let (window, _) = HostedShot.host(MotionHost(rig: rig, box: box), size: CGSize(width: 280, height: 360))
        defer {
            window.contentView = nil
            window.close()
        }
        func expect(_ reduced: Bool) {
            let deadline = Date().addingTimeInterval(2)
            while rig.readings[rows[0].id] != reduced, Date() < deadline {
                window.contentView?.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            XCTAssertEqual(rig.readings[rows[0].id], reduced, "the hosted row receives the effective environment preference")
        }
        expect(false)
        let table = try XCTUnwrap(box.scrollView?.documentView as? NSTableView)
        let coordinator = try XCTUnwrap(table.dataSource as? MarkdownTreeTable<Int>.Coordinator)
        var preferences: [Bool] = []
        coordinator.animateRows = { old, new, table, reduced in
            preferences.append(reduced)
            return MarkdownTreeTable<Int>.animate(from: old, to: new, in: table, reduceMotion: reduced)
        }
        func changeRows(_ next: [FileTreeRow], expected: [Bool]) {
            rig.rows = next
            let deadline = Date().addingTimeInterval(2)
            while preferences.count < expected.count, Date() < deadline {
                window.contentView?.layoutSubtreeIfNeeded()
                window.displayIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            XCTAssertEqual(preferences, expected, "the native update receives the enclosing effective preference")
            XCTAssertEqual(table.numberOfRows, next.count, "rows still arrive whether animated or reloaded")
        }
        rig.app = true
        expect(true)
        changeRows(open, expected: [true])
        rig.app = false
        expect(false)
        changeRows(rows, expected: [true, false])
        rig.widget = true
        expect(true)
        changeRows(open, expected: [true, false, true])
        rig.widget = false
        expect(false)
        changeRows(rows, expected: [true, false, true, false])
        rig.system = true
        expect(true)
        changeRows(open, expected: [true, false, true, false, true])
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
    private final class MotionRig: ObservableObject {
        @Published var app = false
        @Published var widget = false
        @Published var system = false
        @Published var rows: [FileTreeRow] = []
        var readings: [String: Bool] = [:]
    }

    private struct MotionHost: View {
        @ObservedObject var rig: MotionRig
        let box: MarkdownTreeScrollBox

        var body: some View {
            MarkdownTreeTable(rows: rig.rows, revision: 0, box: box) { row in
                AnyView(MotionRow(id: row.id, rig: rig))
            }
            .environment(\.accessibilityReduceMotion, rig.system)
            .environment(\.nativeSettingsReduceMotion, rig.app)
            .environment(\.widgetReduceMotion, rig.widget)
        }
    }

    private struct MotionRow: View {
        let id: String
        let rig: MotionRig
        @GenReduceMotion private var reduceMotion

        var body: some View {
            let _ = rig.readings.updateValue(reduceMotion, forKey: id)
            Text(id)
        }
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
