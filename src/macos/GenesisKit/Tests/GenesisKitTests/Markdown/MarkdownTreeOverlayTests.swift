import AppKit
@testable import GenesisKit
import XCTest

/// The file tree's table lies over the window's SwiftUI root (`MarkdownWindowContentView`): it sits on its slot, and a
/// right-click under its rows still shows the sidebar's menu.
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

        let below = tree.convert(NSPoint(x: tree.bounds.midX, y: tree.rect(ofRow: 1).maxY + 40), to: nil)
        let event = try XCTUnwrap(NSEvent.mouseEvent(with: .rightMouseDown, location: below, modifierFlags: [], timestamp: 0,
                                                     windowNumber: window.windowNumber, context: nil, eventNumber: 0,
                                                     clickCount: 1, pressure: 1))
        // The menu itself opens modally, so the test checks the hand-off: a view of the SwiftUI root under the pointer.
        let target = try XCTUnwrap((tree as? MarkdownTreeTableView)?.sidebarTarget(for: event), "a sidebar view under the rows")
        XCTAssertTrue(target.isDescendant(of: content.root))
    }

    private static func find<T: NSView>(_ type: T.Type, in view: NSView) -> T? {
        if let match = view as? T { return match }
        for subview in view.subviews {
            if let match = find(type, in: subview) { return match }
        }
        return nil
    }
}
