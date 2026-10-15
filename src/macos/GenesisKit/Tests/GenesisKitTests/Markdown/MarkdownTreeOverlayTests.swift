import AppKit
@testable import GenesisKit
import XCTest

/// The file tree's table lies over the window's SwiftUI root (`MarkdownWindowContentView`): it sits on its slot, and a
/// right-click under its rows lands in the root, where the sidebar's menu is.
final class MarkdownTreeOverlayTests: XCTestCase {
    @MainActor
    func testTheTableSitsOnItsSlotAndTheSpaceUnderTheRowsHasTheSidebarMenu() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("md-overlay-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let note = root.appendingPathComponent("one.md")
        try "# one".write(to: note, atomically: true, encoding: .utf8)
        try "# two".write(to: root.appendingPathComponent("two.md"), atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-overlay-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 600),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        let content = MarkdownDocumentWindowController.contentView(model: model)
        window.contentView = content
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        model.open([note])
        let deadline = Date().addingTimeInterval(2)
        var table: NSTableView?
        while Date() < deadline {
            RunLoop.main.run(until: Date().addingTimeInterval(0.05))
            table = Self.find(MarkdownTreeTableView.self, in: content)
            if let table, table.numberOfRows == 2 { break }
        }
        let tree = try XCTUnwrap(table, "the tree's table")
        XCTAssertEqual(tree.numberOfRows, 2)
        XCTAssertEqual(content.overlayDrift(), 0, "the table sits on its slot")
        XCTAssertFalse(tree.isDescendant(of: content.root), "the table is outside the SwiftUI root")

        // Two rows: the table ends under them, and a click below lands in the SwiftUI root (its sidebar menu).
        let scroll = try XCTUnwrap(tree.enclosingScrollView)
        XCTAssertLessThan(scroll.frame.height, 200, "the table covers its rows only")
        let blank = NSPoint(x: scroll.frame.midX, y: scroll.frame.minY - 40)
        let hit = try XCTUnwrap(content.hitTest(blank), "something under the rows")
        XCTAssertTrue(hit.isDescendant(of: content.root), "the space under the rows is the root's, not the table's")
        // The slot takes it and has no menu, so AppKit walks up to the SwiftUI host, which opens the sidebar menu.
        XCTAssertTrue(hit is MarkdownOverlaySlot, "hit: \(type(of: hit))")
    }

    private static func find<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        for subview in view.subviews {
            if let match = find(type, in: subview) { return match }
        }
        return nil
    }
}
