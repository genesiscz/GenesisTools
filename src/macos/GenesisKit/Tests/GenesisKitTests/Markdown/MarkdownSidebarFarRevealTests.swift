import AppKit
@testable import GenesisKit
import XCTest

/// "Show in Sidebar" on a tab whose note another app wrote after the tree read its folder, its row far below the
/// visible part of a long tree (Martin, 2026-10-15: "tab -> show in sidebar does nothing"). The folder's listing
/// predated the note, so the reveal found no row; it now reads the folder again and scrolls to the row.
final class MarkdownSidebarFarRevealTests: XCTestCase {
    /// A far reveal opens its ancestors and ends with the target row visible.
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
        window.order(.below, relativeTo: 0)
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
        XCTAssertFalse(TreeDrawnText.lines(of: tree).contains { $0.lowercased().contains("zz-target") }, "the target row starts off screen")

        model.revealInSidebar(target)
        // Lowercased: Vision read the row as "Zz-target.md" in 3 of 6 runs.
        let deadline = Date().addingTimeInterval(2)
        var visible = false
        while Date() < deadline, !visible {
            settle(window, until: Date().addingTimeInterval(0.2))
            visible = TreeDrawnText.lines(of: tree).contains { $0.lowercased().contains("zz-target") }
        }
        XCTAssertTrue(visible, "Show in Sidebar leaves the row off screen")
    }

    /// "Find it, expand the folder, scroll to it": the note sits in a closed folder below 800 rows.
    @MainActor
    func testShowInSidebarOpensAClosedFolderAndBringsItsNoteOnScreen() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Čtení-\(UUID().uuidString)")
        let big = root.appendingPathComponent("aaa-velká složka")
        let closed = root.appendingPathComponent("zz-closed")
        try FileManager.default.createDirectory(at: big, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: closed, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        for index in 0..<800 {
            try "x".write(to: big.appendingPathComponent(String(format: "Poznámka %03d.md", index)), atomically: false, encoding: .utf8)
        }
        let target = closed.appendingPathComponent("inside-target.md")
        try "# inside".write(to: target, atomically: true, encoding: .utf8)

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-reveal-closed-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 700),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer {
            window.orderOut(nil)
            window.close()
        }
        // Opening a note in the big folder opens that folder; "zz-closed" stays closed.
        model.open([big.appendingPathComponent("Poznámka 000.md")])
        settle(window, until: Date().addingTimeInterval(1.5))
        let tree = try XCTUnwrap(TreeDrawnText.treeScroll(in: window))
        tree.contentView.scroll(to: .zero)
        tree.reflectScrolledClipView(tree.contentView)
        settle(window, until: Date().addingTimeInterval(0.3))
        XCTAssertFalse(TreeDrawnText.lines(of: tree).contains { $0.lowercased().contains("inside-target") }, "the note starts hidden")

        model.revealInSidebar(target)
        let deadline = Date().addingTimeInterval(2.5)
        var visible = false
        while Date() < deadline, !visible {
            settle(window, until: Date().addingTimeInterval(0.2))
            visible = TreeDrawnText.lines(of: tree).contains { $0.lowercased().contains("inside-target") }
        }
        XCTAssertTrue(visible, "Show in Sidebar opens the closed folder and brings the note on screen")
    }

    /// The live case of 2026-10-15 10:17: the closed folder sits between two long open folders, so rows follow it. The
    /// reveal opened it, but the glide aimed with the tree's old height and SwiftUI's animated settle did not correct
    /// it: the note stayed three rows above the sidebar's top.
    @MainActor
    func testShowInSidebarCentresANoteInAClosedFolderBetweenLongFolders() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("Čtení-\(UUID().uuidString)")
        let first = root.appendingPathComponent("aaa-první")
        let closed = root.appendingPathComponent("mm-Design")
        let last = root.appendingPathComponent("zz-poslední")
        for folder in [first, closed, last] {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
        addTeardownBlock { try? FileManager.default.removeItem(at: root) }
        for index in 0..<300 {
            try "x".write(to: first.appendingPathComponent(String(format: "Poznámka %03d.md", index)), atomically: false, encoding: .utf8)
            try "x".write(to: last.appendingPathComponent(String(format: "Záznam %03d.md", index)), atomically: false, encoding: .utf8)
        }
        for index in 0..<24 {
            try "x".write(to: closed.appendingPathComponent(String(format: "Figma-%02d.md", index)), atomically: false, encoding: .utf8)
        }
        let target = closed.appendingPathComponent("Figma-05.md")

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-reveal-middle-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 700),
                              styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.order(.below, relativeTo: 0)
        defer {
            window.orderOut(nil)
            window.close()
        }
        // Both long folders open (each tab's note opens its folder); "mm-Design" stays closed.
        model.open([first.appendingPathComponent("Poznámka 000.md")])
        settle(window, until: Date().addingTimeInterval(1))
        model.open([last.appendingPathComponent("Záznam 000.md")])
        settle(window, until: Date().addingTimeInterval(1.5))
        let tree = try XCTUnwrap(TreeDrawnText.treeScroll(in: window))
        tree.contentView.scroll(to: .zero)
        tree.reflectScrolledClipView(tree.contentView)
        settle(window, until: Date().addingTimeInterval(0.3))

        model.revealInSidebar(target)
        settle(window, until: Date().addingTimeInterval(2))
        let rows = TreeDrawnText.placed(in: tree)
        let row = try XCTUnwrap(rows.first { $0.text.contains("Figma-05") }, "the note's row is on screen; drawn: \(rows.map(\.text).prefix(4)) … \(rows.map(\.text).suffix(3))")
        XCTAssertEqual(row.middle, 0.5, accuracy: 0.15, "the note's row sits in the middle of the sidebar")
    }

    @MainActor
    private func settle(_ window: NSWindow, until: Date) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: until)
    }
}
