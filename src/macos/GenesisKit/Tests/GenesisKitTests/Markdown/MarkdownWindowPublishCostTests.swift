import AppKit
@testable import GenesisKit
import SwiftUI
import XCTest

/// What one documents-model publish may cost (2026-10-14: the file tree "laggy af"). Every publish re-ran all tab
/// bodies, walked every tree row and made the window's hosting view re-measure the whole tree for its minimum size.
final class MarkdownWindowPublishCostTests: XCTestCase {
    /// The window owns its size: the hosting view derives none (no min, max or intrinsic size from SwiftUI).
    @MainActor
    func testTheWindowContentStatesNoSizesOfItsOwn() {
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-cost-\(UUID().uuidString)")!)
        XCTAssertEqual(MarkdownDocumentWindowController.contentView(model: model).rootSizingOptions(), [])
    }

    /// What the hosting view used to impose by itself, the window's minimum now states: in each sidebar state the
    /// formula equals the content's minimum measured with the standard sizing, and a narrower window grows to it.
    @MainActor
    func testTheWindowMinimumFollowsWhatTheContentNeeds() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-cost-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let note = dir.appendingPathComponent("a-rather-long-note-name-for-the-path-bar.md")
        try "# Note\n\n## Section\n\nBody.".write(to: note, atomically: true, encoding: .utf8)
        let states: [(files: Bool, filesWidth: Double, outline: Bool, git: Bool, gitWidth: Double)] = [
            (false, 230, false, false, 280), (true, 230, false, true, 280), (false, 230, true, false, 280),
            (true, 230, true, true, 280), (true, 400, true, true, 450),
        ]
        for state in states {
            let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-cost-\(UUID().uuidString)")!)
            model.filesRoot = dir.path
            model.showFiles = state.files
            model.filesWidth = state.filesWidth
            model.showOutline = state.outline
            model.showGit = state.git
            model.gitWidth = state.gitWidth
            model.open([note])
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 1400, height: 700),
                styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.isReleasedWhenClosed = false
            window.contentView = NSHostingView(rootView: MarkdownDocumentWindowController.root(model: model))
            window.alphaValue = 0
            window.level = .init(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
            window.order(.below, relativeTo: 0)
            settle(window, 0.8)
            let needed = window.contentMinSize
            let stated = MarkdownWindowMinimum.size(for: model)
            let label = "files \(state.files) \(Int(state.filesWidth)), outline \(state.outline), git \(state.git) \(Int(state.gitWidth))"
            XCTAssertGreaterThan(needed.width, 0, "the standard sizing states a minimum: \(label)")
            XCTAssertEqual(stated.width, needed.width, accuracy: 0.5, label)
            XCTAssertGreaterThanOrEqual(stated.height, needed.height, label)
            window.orderOut(nil)
            window.close()
        }

        // The window owns it now: a window narrower than the sidebars need grows to the minimum.
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-cost-\(UUID().uuidString)")!)
        model.showFiles = true
        model.showOutline = true
        model.showGit = true
        model.filesWidth = 230
        model.gitWidth = 280
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 650, height: 500),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.isReleasedWhenClosed = false
        MarkdownWindowMinimum.apply(to: window, model: model)
        XCTAssertEqual(window.contentMinSize.width, 743, accuracy: 0.5)
        XCTAssertEqual(window.frame.width, 743, accuracy: 0.5, "the window grows to its minimum")
        window.close()
    }

    /// The preview's section is no input of a tab or a tree row: changing it runs neither body, while the window,
    /// which does read the model, still updates. A selection still reaches the tabs.
    @MainActor
    func testAnUnrelatedPublishSkipsTabsAndTreeRows() throws {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("md-cost-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }
        let notes = try (1...3).map { index -> URL in
            let note = dir.appendingPathComponent("note-\(index).md")
            try "# Note \(index)\n\n## Section\n\nBody.".write(to: note, atomically: true, encoding: .utf8)
            return note
        }
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-cost-\(UUID().uuidString)")!)
        model.filesRoot = dir.path
        model.showFiles = true
        model.open(notes)

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1100, height: 700),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
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
        settle(window, 1.0)
        RenderProbe.enabled = true
        defer { RenderProbe.enabled = false }

        let before = RenderProbe.snapshot()
        for index in 0..<3 {
            model.findQuery = "unrelated-\(index)"
            settle(window, 0.05)
        }
        let unrelated = RenderProbe.snapshot().merging(before) { now, then in now - then }
        XCTAssertGreaterThan(unrelated["md.window", default: 0], 0, "the window reads the model and updates")
        XCTAssertEqual(unrelated["md.tab", default: 0], 0, "no tab shows the section")
        XCTAssertEqual(unrelated["tree.rowItem", default: 0], 0, "the tree builds no row for the section")

        // The heading on screen is not the window's (`MarkdownSectionSpy`): it redraws the outline and nothing else.
        model.showOutline = true
        settle(window, 0.3)
        let beforeSection = RenderProbe.snapshot()
        for index in 0..<3 {
            model.activeSectionSlug = "section-\(index)"
            settle(window, 0.05)
        }
        let section = RenderProbe.snapshot().merging(beforeSection) { now, then in now - then }
        XCTAssertEqual(section["md.window", default: 0], 0, "a heading change does not redraw the window")
        XCTAssertGreaterThan(section["md.outline", default: 0], 0, "the outline follows the heading")

        let beforeSelect = RenderProbe.snapshot()
        model.select(model.docs[0].id)
        settle(window, 0.2)
        let selected = RenderProbe.snapshot().merging(beforeSelect) { now, then in now - then }
        XCTAssertGreaterThan(selected["md.tab", default: 0], 0, "a selection still redraws the tabs it changes")
    }

    /// Automated viewer fixtures must never order a window front, including opt-in measurements and recording fixtures.
    func testViewerFixturesNeverOrderTheirWindowsFront() throws {
        let folder = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let fixtures = [
            "MarkdownSidebarFarRevealTests.swift", "MarkdownSidebarRevealBenchTests.swift",
            "MarkdownSidebarRevealDemoTests.swift", "MarkdownTreeLagBenchTests.swift",
            "MarkdownTreeOverlayTests.swift", "MarkdownWindowPublishCostTests.swift", "MarkdownDocumentWindowTests.swift",
        ]
        // Split the spellings so this policy test does not match its own deny-list.
        let forbidden = ["order" + "Front(", "orderFront" + "Regardless(", "makeKeyAnd" + "OrderFront("]
        for fixture in fixtures {
            let source = try String(contentsOf: folder.appendingPathComponent(fixture), encoding: .utf8)
            for call in forbidden {
                XCTAssertFalse(source.contains(call), "\(fixture) must use hosted below-window ordering, found \(call)")
            }
        }
    }

    @MainActor
    private func settle(_ window: NSWindow, _ seconds: TimeInterval) {
        window.contentView?.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        RunLoop.main.run(until: Date().addingTimeInterval(seconds))
    }
}
