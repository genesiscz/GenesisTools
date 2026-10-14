import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// The viewer as the user had it when the file tree lagged (2026-10-14): 24 tabs, the file tree rooted at a vault
/// folder with a 243-entry folder expanded. It measures the main thread's busy time and the bodies that re-ran for
/// one unrelated model change (the preview's active section) and for scrolling the tree. Real notes are only read.
///
///   MARKDOWN_TREE_BENCH=<folder> [MARKDOWN_TREE_BENCH_NOTE=<note in it>] swift test --filter MarkdownTreeLagBench
///   Counts: MARKDOWN_TREE_BENCH_SECTIONS (20), MARKDOWN_TREE_BENCH_SELECTS (10). MARKDOWN_TREE_BENCH_MARK=<file> appears
///   when the first measured loop starts, so `sample <pid>` from the shell can attach to it.
final class MarkdownTreeLagBenchTests: XCTestCase {
    @MainActor
    func testTreeCostForUnrelatedChangesAndScrolling() throws {
        let env = ProcessInfo.processInfo.environment
        guard let rootPath = env["MARKDOWN_TREE_BENCH"] else {
            throw XCTSkip("set MARKDOWN_TREE_BENCH to a folder (the vault's ČEZ folder reproduces the report)")
        }
        let root = URL(fileURLWithPath: rootPath)
        let notes = try Self.notes(in: root, limit: 24, last: env["MARKDOWN_TREE_BENCH_NOTE"])
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-tree-bench-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        model.open(notes)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1900, height: 1150),
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
        Self.settle(window, seconds: 3)

        let tree = try XCTUnwrap(Self.treeScroll(in: window), "the file tree's scroll view")
        let rows = Int(tree.documentView?.frame.height ?? 0)
        RenderProbe.enabled = true
        defer { RenderProbe.enabled = false }

        // One unrelated change: the preview reports the section the reader scrolled to.
        var start = RenderProbe.snapshot()
        let sections = Int(env["MARKDOWN_TREE_BENCH_SECTIONS"] ?? "") ?? 20
        // A sampler can attach when this file appears (MARKDOWN_TREE_BENCH_MARK=<path>).
        if let mark = env["MARKDOWN_TREE_BENCH_MARK"] {
            FileManager.default.createFile(atPath: mark, contents: Data("\(ProcessInfo.processInfo.processIdentifier)".utf8))
        }
        let meter = MainBusy.Meter()
        meter.start()
        for index in 0..<sections {
            model.activeSectionSlug = "bench-section-\(index)"
            Self.settle(window, seconds: 0.05)
        }
        let section = meter.stop()
        let sectionBodies = RenderProbe.summary(since: start)

        // Scrolling the tree by a row height and a half at a time.
        start = RenderProbe.snapshot()
        let scrollMeter = MainBusy.Meter()
        scrollMeter.start()
        for step in 1...40 {
            let y = CGFloat(step) * 30
            tree.contentView.scroll(to: NSPoint(x: 0, y: y))
            tree.reflectScrolledClipView(tree.contentView)
            Self.settle(window, seconds: 0.02)
        }
        let scrolling = scrollMeter.stop()
        let scrollBodies = RenderProbe.summary(since: start)

        // A click in the tree on an open note selects its tab: alternate between the last two tabs.
        start = RenderProbe.snapshot()
        let selectMeter = MainBusy.Meter()
        selectMeter.start()
        let ids = model.docs.suffix(2).map(\.id)
        let selections = Int(env["MARKDOWN_TREE_BENCH_SELECTS"] ?? "") ?? 10
        for step in 0..<selections {
            model.select(ids[step % 2])
            Self.settle(window, seconds: 0.1)
        }
        let selecting = selectMeter.stop()
        let selectBodies = RenderProbe.summary(since: start)

        let report = """
        tree bench: \(notes.count) tabs, tree document height \(rows) pt
          \(sections) active-section changes: busy \(Int(section.busyMs)) ms, longest \(Int(section.longestMs)) ms, \(section.passes) passes
            bodies: \(sectionBodies)
          40 tree scroll steps: busy \(Int(scrolling.busyMs)) ms, longest \(Int(scrolling.longestMs)) ms, \(scrolling.passes) passes
            bodies: \(scrollBodies)
          \(selections) tab selections: busy \(Int(selecting.busyMs)) ms, longest \(Int(selecting.longestMs)) ms, \(selecting.passes) passes
            bodies: \(selectBodies)
        """
        print(report)
        if let out = env["MARKDOWN_TREE_BENCH_OUT"] {
            try report.write(toFile: out, atomically: true, encoding: .utf8)
        }
    }

    @MainActor
    private static func settle(_ window: NSWindow, seconds: TimeInterval) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }

    /// The tallest scroll view in the window's left third: the file tree's.
    @MainActor
    private static func treeScroll(in window: NSWindow) -> NSScrollView? {
        var found: [NSScrollView] = []
        func walk(_ view: NSView) {
            if let scroll = view as? NSScrollView { found.append(scroll) }
            view.subviews.forEach(walk)
        }
        guard let content = window.contentView else { return nil }
        walk(content)
        return found
            .filter { $0.convert($0.bounds, to: nil).midX < window.frame.width / 3 }
            .max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
    }

    /// Up to `limit` markdown notes under `root`, the named one last so it is the selected tab.
    private static func notes(in root: URL, limit: Int, last: String?) throws -> [URL] {
        var found: [URL] = []
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL, found.count < limit - 1 {
            if url.pathExtension == "md" { found.append(url) }
        }
        if let last {
            found.append(URL(fileURLWithPath: last))
        }
        if found.isEmpty { throw XCTSkip("no markdown notes under \(root.path)") }
        return found
    }
}
