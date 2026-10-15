import AppKit
@testable import GenesisKit
import XCTest

/// Martin's "Show in Sidebar" case played slowly in a visible window, for a screen recording (it never activates, so
/// it takes nobody's focus). Skipped unless MARKDOWN_REVEAL_DEMO names a scratch vault folder; real notes are never
/// written. The window's number goes to MARKDOWN_REVEAL_DEMO_WINDOW so a recorder can attach to it.
///
///   1. The tree opens big task folders, as Martin's had them; then another app writes a note into a folder the tree
///      already read, and it opens as a tab.
///   2. The tree scrolls to its top; "Show in Sidebar" on that tab.
///   3. The tree scrolls to its top again; "Show in Sidebar" on a note that was there from the start.
final class MarkdownSidebarRevealDemoTests: XCTestCase {
    @MainActor
    func testPlayTheRevealForARecording() throws {
        let env = ProcessInfo.processInfo.environment
        guard let rootPath = env["MARKDOWN_REVEAL_DEMO"] else { throw XCTSkip("set MARKDOWN_REVEAL_DEMO to a scratch vault folder") }
        let root = URL(fileURLWithPath: rootPath)
        let folder = root.appendingPathComponent("col-271437-marketplace-2.0")
        let late = folder.appendingPathComponent("2026-10-15-UnslopProposals.sol3.md")
        let early = folder.appendingPathComponent("WorkItem.md")
        try? FileManager.default.removeItem(at: late)
        let expand = (env["MARKDOWN_REVEAL_EXPAND"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }

        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-reveal-demo-\(UUID().uuidString)")!)
        model.configuration = GenesisKitMarkdownConfiguration(defaults: UserDefaults(suiteName: "md-reveal-demo-config-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        let window = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1180, height: 760),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.title = "Reveal demo"
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        for note in expand {
            model.open([note])
            settle(window, seconds: 0.4)
        }
        if let out = env["MARKDOWN_REVEAL_DEMO_WINDOW"] {
            try "\(window.windowNumber)".write(toFile: out, atomically: true, encoding: .utf8)
        }
        // The recorder needs a moment to attach.
        settle(window, seconds: 3)

        try "# sol3\n\nWritten after the tree read its folder.\n".write(to: late, atomically: true, encoding: .utf8)
        model.open([late])
        settle(window, seconds: 1.5)
        let tree = try XCTUnwrap(TreeDrawnText.treeScroll(in: window))
        tree.contentView.scroll(to: .zero)
        tree.reflectScrolledClipView(tree.contentView)
        settle(window, seconds: 1.5)
        GenesisKit.log("markdown demo: reveal the late note")
        model.revealInSidebar(late)
        settle(window, seconds: 3)

        tree.contentView.scroll(to: .zero)
        tree.reflectScrolledClipView(tree.contentView)
        settle(window, seconds: 1.5)
        GenesisKit.log("markdown demo: reveal an early note")
        model.revealInSidebar(early)
        settle(window, seconds: 3)
    }

    @MainActor
    private func settle(_ window: NSWindow, seconds: TimeInterval) {
        let end = Date().addingTimeInterval(seconds)
        while Date() < end {
            window.displayIfNeeded()
            RunLoop.main.run(until: Date().addingTimeInterval(0.016))
        }
    }
}
