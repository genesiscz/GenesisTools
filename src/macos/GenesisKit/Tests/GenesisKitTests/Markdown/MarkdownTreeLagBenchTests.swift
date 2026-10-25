import AppKit
import Combine
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
    /// The opt-in benchmark measures publishes, scrolling, tab switching and resizing.
    @MainActor
    func testTreeCostForUnrelatedChangesAndScrolling() throws {
        let env = ProcessInfo.processInfo.environment
        guard let rootPath = env["MARKDOWN_TREE_BENCH"] else {
            throw XCTSkip("set MARKDOWN_TREE_BENCH to a folder (a large vault folder reproduces the report)")
        }
        let root = URL(fileURLWithPath: rootPath)
        let tabs = Int(env["MARKDOWN_TREE_BENCH_TABS"] ?? "") ?? 24
        let notes = try Self.notes(in: root, limit: tabs, last: env["MARKDOWN_TREE_BENCH_NOTE"])
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-tree-bench-\(UUID().uuidString)")!)
        model.filesRoot = root.path
        model.showFiles = true
        // A configuration of its own: the shared one writes the test process's defaults, which other tests read.
        model.configuration = GenesisKitMarkdownConfiguration(defaults: UserDefaults(suiteName: "md-tree-bench-config-\(UUID().uuidString)")!)
        model.configuration.wrapTabs = env["MARKDOWN_TREE_BENCH_WRAP"] == "1"
        if env["MARKDOWN_TREE_BENCH_OUTLINE"] == "1" {
            model.showOutline = true
        }
        // Experiments: the native renderer instead of the web page, and the window without its file sidebar.
        if env["MARKDOWN_TREE_BENCH_NATIVE"] == "1" {
            // The renderer is remembered in the process's defaults: put back what was there.
            let rendererKey = "markdownWindow.renderer"
            let before = UserDefaults.standard.object(forKey: rendererKey)
            model.rendererRaw = MarkdownRenderer.native.rawValue
            addTeardownBlock {
                if let before { UserDefaults.standard.set(before, forKey: rendererKey) } else { UserDefaults.standard.removeObject(forKey: rendererKey) }
            }
        }
        if env["MARKDOWN_TREE_BENCH_FILES"] == "0" {
            model.showFiles = false
        }
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
        window.order(.below, relativeTo: 0)
        defer {
            window.orderOut(nil)
            window.close()
        }
        Self.settle(window, seconds: 3)

        let tree = model.showFiles ? try XCTUnwrap(Self.treeScroll(in: window), "the file tree's scroll view") : nil
        let rows = Int(tree?.documentView?.frame.height ?? 0)
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
        // MARKDOWN_TREE_BENCH_SCROLLS: steps of 30 pt (40), back to the top after every 60.
        let scrolls = Int(env["MARKDOWN_TREE_BENCH_SCROLLS"] ?? "") ?? 40
        for step in 1...scrolls {
            let y = CGFloat(step % 60) * 30
            guard let tree else { break }
            tree.contentView.scroll(to: NSPoint(x: 0, y: y))
            tree.reflectScrolledClipView(tree.contentView)
            Self.settle(window, seconds: 0.02)
        }
        let scrolling = scrollMeter.stop()
        let scrollBodies = RenderProbe.summary(since: start)

        // A click in the tree on an open note selects its tab: alternate between the last two tabs.
        start = RenderProbe.snapshot()
        if let mark = env["MARKDOWN_TREE_BENCH_SELECT_MARK"] {
            FileManager.default.createFile(atPath: mark, contents: Data("\(ProcessInfo.processInfo.processIdentifier)".utf8))
            Self.settle(window, seconds: 0.5)
        }
        // MARKDOWN_TREE_BENCH_PUBLISHERS=1: which setter published, for every publish of the model, the configuration
        // and the two tabs during the switches (the first frame of ours below Combine).
        var publishes: [String: Int] = [:]
        var watches: [AnyCancellable] = []
        if env["MARKDOWN_TREE_BENCH_PUBLISHERS"] == "1" {
            func note(_ source: String) {
                let frame = Thread.callStackSymbols.dropFirst(2).first { line in
                    (line.contains("GenesisKit")) && !line.contains("Combine") && !line.contains("TreeLagBench")
                } ?? "?"
                let symbol = frame.split(separator: " ").dropFirst(3).first.map(String.init) ?? frame
                publishes["\(source) \(symbol)", default: 0] += 1
            }
            watches.append(model.objectWillChange.sink { _ in note("model") })
            watches.append(model.configuration.objectWillChange.sink { _ in note("configuration") })
            for doc in model.docs.suffix(2) { watches.append(doc.objectWillChange.sink { _ in note("doc") }) }
        }
        let selectMeter = MainBusy.Meter()
        selectMeter.start()
        let ids = model.docs.suffix(2).map(\.id)
        let selections = Int(env["MARKDOWN_TREE_BENCH_SELECTS"] ?? "") ?? 10
        // MARKDOWN_TREE_BENCH_SELECT_GAP: seconds between switches (0.1); 0.5 lets each switch's fade finish, as a reader's.
        let gap = Double(env["MARKDOWN_TREE_BENCH_SELECT_GAP"] ?? "") ?? 0.1
        // One open document used to crash here: `ids[step % 2]` on the second step. Alternate only with two.
        if let plan = Self.alternatingSelection(ids: ids, selections: selections) {
            for id in plan {
                model.select(id)
                Self.settle(window, seconds: gap)
            }
        } else {
            print("tree bench: selection skipped, \(ids.count) open document(s)")
        }
        let selecting = selectMeter.stop()
        let selectBodies = RenderProbe.summary(since: start)
        watches.removeAll()
        let publishReport = publishes.sorted { $0.value > $1.value }.map { "    \($0.value)x \($0.key)" }.joined(separator: "\n")

        // The reader drags the window's edge: ten frame changes of 40 pt.
        start = RenderProbe.snapshot()
        let resizeMeter = MainBusy.Meter()
        resizeMeter.start()
        let frame = window.frame
        for step in 0..<10 {
            var next = frame
            next.size.width += step % 2 == 0 ? 40 : 0
            window.setFrame(next, display: true)
            Self.settle(window, seconds: 0.05)
        }
        let resizing = resizeMeter.stop()
        let resizeBodies = RenderProbe.summary(since: start)

        let report = """
        tree bench: \(notes.count) tabs, tree document height \(rows) pt
          \(sections) active-section changes: busy \(Int(section.busyMs)) ms, longest \(Int(section.longestMs)) ms, \(section.passes) passes
            bodies: \(sectionBodies)
          \(scrolls) tree scroll steps: busy \(Int(scrolling.busyMs)) ms, longest \(Int(scrolling.longestMs)) ms, \(scrolling.passes) passes
            bodies: \(scrollBodies)
          \(selections) tab selections: busy \(Int(selecting.busyMs)) ms, longest \(Int(selecting.longestMs)) ms, \(selecting.passes) passes
            bodies: \(selectBodies)
        \(publishReport)
          10 window resizes: busy \(Int(resizing.busyMs)) ms, longest \(Int(resizing.longestMs)) ms, \(resizing.passes) passes
            bodies: \(resizeBodies)
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

    /// The ids the bench alternates, or nil when fewer than two distinct documents are open.
    static func alternatingSelection(ids: [String], selections: Int) -> [String]? {
        var distinct: [String] = []
        for id in ids where !distinct.contains(id) {
            distinct.append(id)
            if distinct.count == 2 { break }
        }
        guard distinct.count == 2, selections > 0 else { return nil }
        return (0..<selections).map { distinct[$0 % 2] }
    }

    /// Selection benchmarking requires two distinct documents and a positive switch count.
    func testAlternatingSelectionNeedsTwoDocuments() {
        XCTAssertNil(Self.alternatingSelection(ids: ["only"], selections: 10))
        XCTAssertNil(Self.alternatingSelection(ids: ["same", "same"], selections: 4))
        XCTAssertNil(Self.alternatingSelection(ids: ["a", "b"], selections: 0))
        XCTAssertEqual(Self.alternatingSelection(ids: ["a", "b"], selections: 4), ["a", "b", "a", "b"])
    }

    /// Up to `limit` markdown notes under `root`, the named one last so it is the selected tab.
    /// The walk collects `limit` notes. It used to stop at `limit - 1` to leave a slot for `last`, and it did that
    /// even when `last` was absent, so `MARKDOWN_TREE_BENCH_TABS=2` opened one document.
    private static func notes(in root: URL, limit: Int, last: String?) throws -> [URL] {
        var found: [URL] = []
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)
        while let url = walker?.nextObject() as? URL, found.count < max(limit, 0) {
            if url.pathExtension == "md" { found.append(url) }
        }
        if let last {
            let url = URL(fileURLWithPath: last).standardizedFileURL
            found.removeAll { $0.standardizedFileURL.path == url.path }
            found.append(url)
            if limit > 0, found.count > limit {
                found.removeFirst(found.count - limit)
            }
        }
        if found.isEmpty { throw XCTSkip("no markdown notes under \(root.path)") }
        return found
    }

    /// Benchmark note discovery fills its requested limit when no final note is specified.
    func testNotesCollectsTheLimitWhenNoLastNoteIsNamed() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("tree-bench-notes-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        for name in ["a.md", "b.md", "c.md"] {
            try Data("x".utf8).write(to: dir.appendingPathComponent(name))
        }
        let two = try Self.notes(in: dir, limit: 2, last: nil)
        XCTAssertEqual(two.count, 2, "a tab count of 2 opens two notes when no last note is named")
        let named = dir.appendingPathComponent("named.md")
        let withLast = try Self.notes(in: dir, limit: 2, last: named.path)
        XCTAssertEqual(withLast.count, 2)
        XCTAssertEqual(withLast.last?.standardizedFileURL.path, named.standardizedFileURL.path)
        let one = try Self.notes(in: dir, limit: 24, last: nil)
        XCTAssertEqual(one.count, 3, "the folder has three notes, so a higher limit returns each of them")
    }
}
