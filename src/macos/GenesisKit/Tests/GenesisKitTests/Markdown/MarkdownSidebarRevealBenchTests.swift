import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// "Show in Sidebar" on a tab, as Martin had the viewer on 2026-10-15: the tree rooted at a vault folder, a big
/// subtree above the note already expanded, the tree scrolled somewhere else. It checks that the note's row ends up
/// inside the tree's visible area and measures the main thread while the reveal runs. Real notes are only read.
///
///   MARKDOWN_REVEAL_BENCH=<root folder> MARKDOWN_REVEAL_TARGET=<note under it>
///   [MARKDOWN_REVEAL_EXPAND=<note>:<note>…] (notes whose folders open first, so a big subtree sits above the target)
///   swift test --filter MarkdownSidebarRevealBench
final class MarkdownSidebarRevealBenchTests: XCTestCase {
    /// The opt-in benchmark measures a reveal against the row actually drawn on screen.
    @MainActor
    func testShowInSidebarBringsTheRowOnScreen() throws {
        let env = ProcessInfo.processInfo.environment
        guard let rootPath = env["MARKDOWN_REVEAL_BENCH"], let targetPath = env["MARKDOWN_REVEAL_TARGET"] else {
            throw XCTSkip("set MARKDOWN_REVEAL_BENCH to a folder and MARKDOWN_REVEAL_TARGET to a note under it")
        }
        let root = URL(fileURLWithPath: rootPath)
        let target = URL(fileURLWithPath: targetPath)
        let expand = (env["MARKDOWN_REVEAL_EXPAND"] ?? "").split(separator: ":").map { URL(fileURLWithPath: String($0)) }
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-reveal-bench-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1720, height: 1255),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        window.contentView = MarkdownDocumentWindowController.contentView(model: model)
        window.alphaValue = 0
        window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        window.orderFrontRegardless()
        defer {
            window.orderOut(nil)
            window.close()
        }
        // Each expanded note opens its folders through the tab selection (the tree follows the selected tab).
        for note in expand {
            model.open([note])
            Self.settle(window, seconds: 0.6)
        }
        model.open([target])
        Self.settle(window, seconds: 2)
        let tree = try XCTUnwrap(TreeDrawnText.treeScroll(in: window), "the file tree's scroll view")
        // The reader scrolled the tree to the top meanwhile, away from the note.
        let start = Double(env["MARKDOWN_REVEAL_START"] ?? "") ?? 0
        let startY = max(0, (tree.documentView?.frame.height ?? 0) - tree.contentView.bounds.height) * start
        tree.contentView.scroll(to: NSPoint(x: 0, y: startY))
        tree.reflectScrolledClipView(tree.contentView)
        Self.settle(window, seconds: 0.5)
        let before = tree.contentView.bounds.origin.y
        let documentHeight = tree.documentView?.frame.height ?? 0

        let meter = MainBusy.Meter()
        meter.start()
        let started = Date()
        model.revealInSidebar(target)
        while Date().timeIntervalSince(started) < 2 {
            Self.settle(window, seconds: 0.05)
        }
        let busy = meter.stop()
        let after = tree.contentView.bounds.origin.y
        let shown = TreeDrawnText.lines(of: tree, savingTo: env["MARKDOWN_REVEAL_SEE_DUMP"].map { $0 + ".png" })
        // A narrow tree cuts the name in the middle ("2026-10-15-…osals.sol3.md"): its two ends identify it.
        let name = target.lastPathComponent
        let visible = shown.contains { $0.hasPrefix(String(name.prefix(11))) && $0.hasSuffix(String(name.suffix(7))) }
        print("reveal bench drawn rows: \(shown.prefix(4).joined(separator: " | ")) … \(shown.suffix(3).joined(separator: " | "))")
        let report = """
        reveal bench: tree document \(Int(documentHeight)) pt, offset \(Int(before)) -> \(Int(after)), start \(start), row visible \(visible)
          main thread: busy \(Int(busy.busyMs)) ms, longest \(Int(busy.longestMs)) ms, \(busy.passes) passes
        """
        print(report)
        if let out = env["MARKDOWN_REVEAL_BENCH_OUT"] {
            try report.write(toFile: out, atomically: true, encoding: .utf8)
        }
        XCTAssertTrue(visible, "Show in Sidebar leaves the note's row off screen")
    }

    @MainActor
    private static func settle(_ window: NSWindow, seconds: TimeInterval) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }
}
