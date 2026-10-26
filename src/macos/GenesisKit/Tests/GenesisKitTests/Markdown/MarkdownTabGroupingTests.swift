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

    func testGroupResetUndoRestoresTheOldStateOnlyBeforeAnotherEdit() throws {
        let suite = "md-group-reset-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let configuration = GenesisKitMarkdownConfiguration(defaults: defaults)
        let model = MarkdownDocumentsModel(defaults: defaults)
        model.configuration = configuration
        var before = MarkdownTabGroupState()
        before.names["manual:old"] = "Reading"
        before.assigned["note"] = "manual:old"
        configuration.tabGroupState = before
        let menu = MarkdownTabGroupingMenu(configuration: configuration, notices: model)
        menu.resetGroups()
        XCTAssertEqual(configuration.tabGroupState, MarkdownTabGroupState())
        let undo = try XCTUnwrap(model.notice?.actions.first)
        guard case .action(_, let perform) = undo.kind else { return XCTFail("no button") }
        perform()
        XCTAssertEqual(configuration.tabGroupState, before)

        menu.resetGroups()
        let stale = try XCTUnwrap(model.notice?.actions.first)
        guard case .action(_, let performStale) = stale.kind else { return XCTFail("no button") }
        var later = MarkdownTabGroupState()
        later.names["manual:new"] = "Later name"
        later.assigned["note"] = "manual:new"
        configuration.tabGroupState = later
        performStale()
        XCTAssertEqual(configuration.tabGroupState, later, "Undo must not discard a later rename or move")
        XCTAssertEqual(model.notice?.tone, .warning)
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

        model.dropTab(ids[0], beside: ids[3], after: false)
        XCTAssertEqual(model.group(of: ids[0])?.title, "B", "a tab dropped on a tab joins that tab's group")
        XCTAssertEqual(model.docs.map(\.id), [ids[1], ids[2], ids[0], ids[3]], "and sits before it")

        model.dropTab(ids[0], beside: ids[3], after: true)
        XCTAssertEqual(model.docs.map(\.id), [ids[1], ids[2], ids[3], ids[0]], "a drop on a tab's right half lands after it")
        let groups = model.tabGroups.map(\.id)
        let titles = model.tabGroups.map(\.title)
        model.moveGroup(groups[0], beside: groups[1], after: true)
        XCTAssertEqual(model.tabGroups.map(\.title), [titles[1], titles[0]], "a group dropped on another's right half goes after it")
        model.moveGroup(groups[0], beside: groups[1], after: false)
        XCTAssertEqual(model.tabGroups.map(\.title), titles, "and on its left half before it")

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

    /// A real click on a tab must select it (Martin, 2026-10-23: "the whole panel is not clickable anywhere"). A
    /// rendered image passed while no tab took a click; only a click proves a control works. The click lands on one
    /// known tab, found by its accessibility frame, in a hidden window: never a scan over points, which pressed the
    /// toolbar's Obsidian button and opened dialogs on the user's screen (2026-10-23 16:45).
    func testAClickOnATabSelectsIt() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("md-tab-click-\(UUID().uuidString)")
        let names = (0 ..< 40).map { "\($0 % 2 == 0 ? "A" : "B")/note\($0).md" }
        let paths = names.map { folder.appendingPathComponent($0) }
        for url in paths {
            try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try "# \(url.lastPathComponent)".write(to: url, atomically: true, encoding: .utf8)
        }
        FrameProbe.enabled = true
        defer { FrameProbe.enabled = false }
        var results: [String] = []
        for (grouped, count, files) in [(false, 4, false), (true, 4, false), (false, 40, false), (true, 40, false),
                                        (false, 40, true), (true, 40, true)] {
            let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-tab-click-\(UUID().uuidString)")!)
            model.configuration = GenesisKitMarkdownConfiguration(
                defaults: UserDefaults(suiteName: "md-tab-click-config-\(UUID().uuidString)")!)
            model.configuration.wrapTabs = true
            model.configuration.tabGroupFrom = grouped ? 0 : 1000
            model.open(Array(paths.suffix(count)))
            model.showFiles = files
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 700),
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
            FrameProbe.reset()
            pump(1.5)
            // The page's AppKit frame must not reach into the tab bar: hit-testing ignores layer clips, so a page
            // frame over the tabs takes their clicks while they still show through its transparent top.
            func webViews(_ view: NSView) -> [NSView] {
                (String(describing: type(of: view)).contains("WebView") ? [view] : []) + view.subviews.flatMap(webViews)
            }
            let tabBottom = FrameProbe.frames.filter { $0.key.hasPrefix("md.tab.") }.map(\.value.maxY).max() ?? 0
            for web in webViews(try XCTUnwrap(window.contentView)) where !web.isHidden {
                let frame = web.convert(web.bounds, to: nil)
                let top = window.frame.height - frame.maxY
                results.append("web \(type(of: web)) top=\(Int(top)) h=\(Int(frame.height)) tabsEnd=\(Int(tabBottom))")
                XCTAssertGreaterThanOrEqual(top + 0.5, tabBottom, "the page starts below the last tab row")
            }
            let target = model.docs[model.docs.count - 2]
            let frame = try XCTUnwrap(FrameProbe.frames["md.tab." + target.id], "the tab \(target.title) has a frame")
            // SwiftUI's global space has its origin top left; a window event's location is bottom left.
            let center = NSPoint(x: frame.midX, y: window.contentLayoutRect.height + (window.frame.height
                - window.contentLayoutRect.height) - frame.midY)
            click(window, at: NSPoint(x: center.x, y: window.frame.height - frame.midY))
            let hit = model.selected?.id == target.id
            results.append("grouped=\(grouped) tabs=\(count) files=\(files) at=\(Int(center.x)),\(Int(center.y)) selected=\(hit)")
            XCTAssertTrue(hit, "a click on the tab selects it (grouped \(grouped), \(count) tabs, files \(files))")
        }
        print("tab clicks:", results.joined(separator: " | "))
    }

    /// The wrapped bar's bottom line is the sidebars' divider laid flat (Martin, 2026-10-23: "have the tab resizeable
    /// using the same component we do for resizing the sidebars"). A drag down shows more rows and is saved; a
    /// double-click goes back to the row count.
    func testDraggingTheTabBarEdgeSetsItsHeight() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("md-tab-drag-\(UUID().uuidString)")
        let paths = (0 ..< 40).map { folder.appendingPathComponent("note\($0).md") }
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        for url in paths {
            try "# \(url.lastPathComponent)".write(to: url, atomically: true, encoding: .utf8)
        }
        FrameProbe.enabled = true
        defer { FrameProbe.enabled = false }
        let model = MarkdownDocumentsModel(defaults: UserDefaults(suiteName: "md-tab-drag-\(UUID().uuidString)")!)
        model.configuration = GenesisKitMarkdownConfiguration(
            defaults: UserDefaults(suiteName: "md-tab-drag-config-\(UUID().uuidString)")!)
        model.configuration.wrapTabs = true
        model.configuration.tabGroupFrom = 1000
        model.configuration.wrapTabsMaxRows = 2
        model.open(paths)
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 520, height: 700),
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
        pump(1.5)
        let before = try XCTUnwrap(FrameProbe.frames["md.tabBarDivider"], "the tab bar has its divider")
        let point = NSPoint(x: before.midX, y: window.frame.height - before.midY)
        func event(_ type: NSEvent.EventType, _ location: NSPoint, clicks: Int = 1) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: clicks, pressure: 1)!
        }
        NSApp.postEvent(event(.leftMouseDown, point), atStart: false)
        for step in 1 ... 10 {
            NSApp.postEvent(event(.leftMouseDragged, NSPoint(x: point.x, y: point.y - CGFloat(step * 10))), atStart: false)
            pump(0.03)
        }
        NSApp.postEvent(event(.leftMouseUp, NSPoint(x: point.x, y: point.y - 100)), atStart: false)
        pump(0.5)
        let after = try XCTUnwrap(FrameProbe.frames["md.tabBarDivider"])
        print("tab bar drag: divider \(Int(before.midY)) -> \(Int(after.midY)), height \(model.configuration.tabBarHeight)")
        XCTAssertEqual(model.configuration.tabBarHeight, Double(2 * 32 + 8) + 100, accuracy: 1, "the drag sets the height")
        XCTAssertEqual(after.midY - before.midY, 100, accuracy: 2, "the bar grows with the pointer")

        NSApp.postEvent(event(.leftMouseDown, NSPoint(x: point.x, y: point.y - 100), clicks: 2), atStart: false)
        NSApp.postEvent(event(.leftMouseUp, NSPoint(x: point.x, y: point.y - 100), clicks: 2), atStart: false)
        pump(0.5)
        XCTAssertEqual(model.configuration.tabBarHeight, 0, "a double-click goes back to the row count")
        XCTAssertEqual(try XCTUnwrap(FrameProbe.frames["md.tabBarDivider"]).midY, before.midY, accuracy: 1)
    }

    private func pump(_ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if let next = NSApp.nextEvent(matching: .any, until: deadline, inMode: .default, dequeue: true) {
                NSApp.sendEvent(next)
            }
        }
    }

    /// As a pointer does it: moves onto the point and rests there (tooltips and hover previews arm), then clicks.
    private func click(_ window: NSWindow, at location: NSPoint) {
        func event(_ type: NSEvent.EventType, at point: NSPoint = location) -> NSEvent {
            NSEvent.mouseEvent(with: type, location: point, modifierFlags: [],
                               timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                               context: nil, eventNumber: 0, clickCount: type == .mouseMoved ? 0 : 1, pressure: 1)!
        }
        window.acceptsMouseMovedEvents = true
        for step in 0 ... 4 {
            let point = NSPoint(x: location.x - CGFloat(20 - step * 5), y: location.y)
            NSApp.postEvent(event(.mouseMoved, at: point), atStart: false)
            pump(0.03)
        }
        pump(Double(ProcessInfo.processInfo.environment["TAB_CLICK_REST"] ?? "") ?? 0.5)
        NSApp.postEvent(event(.leftMouseDown), atStart: false)
        NSApp.postEvent(event(.leftMouseUp), atStart: false)
        pump(0.4)
    }
}
