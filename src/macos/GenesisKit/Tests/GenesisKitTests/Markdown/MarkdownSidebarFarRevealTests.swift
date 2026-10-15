import AppKit
@testable import GenesisKit
import XCTest

/// "Show in Sidebar" on a tab whose note another app wrote after the tree read its folder, its row far below the
/// visible part of a long tree (Martin, 2026-10-15: "tab -> show in sidebar does nothing"). The folder's listing
/// predated the note, so the reveal found no row; it now reads the folder again and scrolls to the row.
final class MarkdownSidebarFarRevealTests: XCTestCase {
    @MainActor
    func testShowInSidebarBringsAFarRowOnScreen() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Čtení-\(UUID().uuidString)")
        let big = root.appendingPathComponent("aaa-velká složka")
        try FileManager.default.createDirectory(at: big, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        for index in 0..<800 {
            try "x".write(to: big.appendingPathComponent(String(format: "Poznámka %03d.md", index)), atomically: false, encoding: .utf8)
        }
        let inBig = big.appendingPathComponent("Poznámka 000.md")
        let target = root.appendingPathComponent("zz-target.md")

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-reveal-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 700),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        // A note in the big folder opens it (the tree follows the selected tab), then the target's tab.
        model.open([inBig])
        settle(window, until: Date().addingTimeInterval(1.5))
        // Another app writes the note after the tree read its folder (the 2026-10-15 case), then it opens as a tab.
        try "# target".write(to: target, atomically: true, encoding: .utf8)
        model.open([target])
        settle(window, until: Date().addingTimeInterval(1))
        let tree = try XCTUnwrap(TreeDrawnText.treeScroll(in: window))
        tree.contentView.scroll(to: .zero)
        tree.reflectScrolledClipView(tree.contentView)
        settle(window, until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(TreeDrawnText.lines(of: tree).contains { $0.contains("zz-target") }, "the target row starts off screen")

        model.revealInSidebar(target)
        let deadline = Date().addingTimeInterval(2)
        var visible = false
        while Date() < deadline, !visible {
            settle(window, until: Date().addingTimeInterval(0.2))
            visible = TreeDrawnText.lines(of: tree).contains { $0.contains("zz-target") }
        }
        XCTAssertTrue(visible, "Show in Sidebar leaves the row off screen")
    }

    @MainActor
    private func settle(_ window: NSWindow, until: Date) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: until)
    }
}
