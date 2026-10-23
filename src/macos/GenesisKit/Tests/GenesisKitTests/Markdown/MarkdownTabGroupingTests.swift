import AppKit
import SwiftUI
import XCTest
@testable import GenesisKit

/// The tab groups: the engine's rules, the reader's own edits, and the model actions the tab bar's drags and menus call.
@MainActor
final class MarkdownTabGroupingTests: XCTestCase {
    private func item(_ path: String) -> MarkdownTabGroupItem {
        MarkdownTabGroupItem(id: path, path: path, title: ((path as NSString).lastPathComponent as NSString).deletingPathExtension)
    }

    func testProjectGroupsByTheTopFolderAndSendsSingleTabsToOther() {
        let items = ["/v/Alpha/a.md", "/v/Beta/b.md", "/v/Alpha/deep/c.md", "/v/Beta/d.md", "/v/Gamma/e.md"].map(item)
        let groups = MarkdownTabGrouping.groups(items, rule: .smart, state: .init())
        XCTAssertEqual(groups.map(\.title), ["Alpha", "Beta", "Other"], "first appearance order, Other last")
        XCTAssertEqual(groups[0].tabIDs, ["/v/Alpha/a.md", "/v/Alpha/deep/c.md"])
        XCTAssertEqual(groups[2].tabIDs, ["/v/Gamma/e.md"], "a one-tab group joins Other")
        XCTAssertTrue(MarkdownTabGrouping.groups(items, rule: .off, state: .init()).isEmpty)
    }

    func testABigProjectGroupSplitsByItsNextFolder() {
        let big = (0 ..< 7).map { "/v/Big/P/p\($0).md" } + (0 ..< 7).map { "/v/Big/Q/q\($0).md" }
        let items = (big + ["/v/Small/s1.md", "/v/Small/s2.md"]).map(item)
        let groups = MarkdownTabGrouping.groups(items, rule: .smart, state: .init(), splitAbove: 12)
        XCTAssertEqual(groups.map(\.title), ["P", "Q", "Small"])
        XCTAssertEqual(groups.first?.detail, "Big", "a split group names where it is")
        XCTAssertEqual(MarkdownTabGrouping.groups(items, rule: .smart, state: .init(), splitAbove: 20).map(\.title),
                       ["Big", "Small"], "under the limit it stays one group")
    }

    func testTheReadersMovesNamesOrderAndFoldsWin() {
        let items = ["/v/A/1.md", "/v/A/2.md", "/v/B/3.md", "/v/B/4.md"].map(item)
        var state = MarkdownTabGroupState()
        state.assigned["/v/A/2.md"] = "manual:mine"
        state.names["manual:mine"] = "Reading"
        state.order = ["dir:/v/B"]
        let groups = MarkdownTabGrouping.groups(items, rule: .smart, state: state, minimumSize: 1)
        XCTAssertEqual(groups.map(\.title), ["B", "A", "Reading"], "the saved order first, then by first appearance")
        XCTAssertEqual(groups.last?.manual, true)
        XCTAssertEqual(groups.last?.tabIDs, ["/v/A/2.md"])
        let order = MarkdownTabGrouping.visualOrder(groups, collapsed: ["dir:/v/B"], selected: "/v/B/4.md")
        XCTAssertEqual(order, ["/v/B/4.md", "/v/A/1.md", "/v/A/2.md"], "a folded group keeps only the selected tab")
    }

    func testDayAndKindRules() throws {
        let now = try XCTUnwrap(ISO8601DateFormatter().date(from: "2026-10-23T12:00:00Z"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        let items = ["/v/2026-10-23-A.md", "/v/2026-10-22-B.md", "/v/2026-10-19-C.md", "/v/2026-09-01-D.md",
                     "/v/Notes.md", "/v/setup.log"].map(item)
        let days = MarkdownTabGrouping.groups(items, rule: .day, state: .init(), minimumSize: 1, now: now,
                                             calendar: calendar)
        XCTAssertEqual(days.map(\.title), ["Today", "Yesterday", "This Week", "Earlier", "Undated"])
        let kinds = MarkdownTabGrouping.groups(items, rule: .kind, state: .init(), minimumSize: 1)
        XCTAssertEqual(kinds.map(\.title), ["Notes", "Logs"])
    }

    func testFoldedGroupsNextToEachOtherShareARow() {
        func group(_ id: String) -> MarkdownTabGroup {
            MarkdownTabGroup(id: id, title: id, detail: nil, tabIDs: [id + "1"], manual: false)
        }
        let rows = MarkdownTabGroupRows.rows([group("a"), group("b"), group("c"), group("d")], collapsed: ["a", "b", "d"])
        XCTAssertEqual(rows.map { $0.groups.map(\.id) }, [["a", "b"], ["c"], ["d"]])
    }

    func testDragsMoveTabsIntoGroupsAndReorderGroups() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("md-tab-groups-\(UUID().uuidString)")
        let paths = ["A/1.md", "A/2.md", "B/3.md", "B/4.md"].map { folder.appendingPathComponent($0) }
        for url in paths {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "# \(url.lastPathComponent)".write(to: url, atomically: true, encoding: .utf8)
        }
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-tab-groups-\(UUID().uuidString)")!)
        model.configuration = GenesisKitMarkdownConfiguration(
            defaults: UserDefaults(suiteName: "md-tab-groups-config-\(UUID().uuidString)")!)
        model.configuration.tabGroupFrom = 0
        model.open(paths)
        let ids = model.docs.map(\.id)
        XCTAssertEqual(model.tabGroups.map(\.title), ["A", "B"])

        model.dropTab(ids[0], before: ids[3])
        XCTAssertEqual(model.group(of: ids[0])?.title, "B", "a tab dropped on a tab joins that tab's group")
        XCTAssertEqual(model.docs.map(\.id), [ids[1], ids[2], ids[0], ids[3]], "and sits before it")

        model.moveGroup("dir:" + folder.appendingPathComponent("B").path, before: nil)
        XCTAssertEqual(model.tabGroups.map(\.title).last, "B", "a group dragged to the end stays there")

        let mine = model.newGroup(with: ids[1])
        model.renameGroup(mine, to: "Reading")
        XCTAssertEqual(model.group(of: ids[1])?.title, "Reading")
        model.toggleGroup(mine)
        XCTAssertFalse(model.visibleTabOrder.contains(ids[1]) && model.selected?.id != ids[1],
                       "a folded group's tabs leave Next Tab's order unless selected")
        model.ungroup(mine)
        XCTAssertNotEqual(model.group(of: ids[1])?.title, "Reading", "ungrouping gives the tab back to its rule")

        model.configuration.tabGroupFrom = 10
        XCTAssertTrue(model.tabGroups.isEmpty, "below the threshold the bar stays one flat row")
    }

    /// Renders a 72-tab bar of real vault notes (read only) to a PNG, for the eye:
    /// MARKDOWN_TAB_GROUPS_RENDER=<out.png> [MARKDOWN_TAB_GROUPS_ROOT=<folder>] swift test --filter MarkdownTabGrouping
    func testRenderSeventyTwoTabsGrouped() throws {
        let env = ProcessInfo.processInfo.environment
        guard let out = env["MARKDOWN_TAB_GROUPS_RENDER"] else { throw XCTSkip("set MARKDOWN_TAB_GROUPS_RENDER") }
        let root = URL(fileURLWithPath: env["MARKDOWN_TAB_GROUPS_ROOT"] ?? NSHomeDirectory())
        // Spread over the root's top folders, as a reader's tabs are: at most 3 notes per folder, 12 per top folder.
        var notes: [URL] = []
        var perFolder: [String: Int] = [:]
        var perTop: [String: Int] = [:]
        let walker = FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil,
                                                    options: [.skipsHiddenFiles])
        while let url = walker?.nextObject() as? URL, notes.count < 72 {
            let folder = url.deletingLastPathComponent().path
            let top = url.pathComponents.dropFirst(root.pathComponents.count).first ?? ""
            guard url.pathExtension == "md", perFolder[folder, default: 0] < 3, perTop[top, default: 0] < 12 else {
                continue
            }
            perFolder[folder, default: 0] += 1
            perTop[top, default: 0] += 1
            notes.append(url)
        }
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-tab-render-\(UUID().uuidString)")!)
        model.configuration = GenesisKitMarkdownConfiguration(
            defaults: UserDefaults(suiteName: "md-tab-render-config-\(UUID().uuidString)")!)
        model.configuration.wrapTabs = env["MARKDOWN_TAB_GROUPS_WRAP"] != "0"
        model.open(notes)
        if let folded = model.tabGroups.dropFirst(2).first { model.toggleGroup(folded.id) }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1900, height: 1150),
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
        let deadline = Date().addingTimeInterval(3)
        while Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
        let view = try XCTUnwrap(window.contentView)
        let rep = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: rep)
        try XCTUnwrap(rep.representation(using: .png, properties: [:])).write(to: URL(fileURLWithPath: out))
        print("groups:", model.tabGroups.map { "\($0.title)(\($0.tabIDs.count))" }.joined(separator: " "))
    }
}
