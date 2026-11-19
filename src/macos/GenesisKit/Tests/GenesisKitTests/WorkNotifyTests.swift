import AppKit
import ImageIO
import SwiftUI
import Vision
import XCTest
@testable import GenesisKit

@MainActor
private final class NotifyFixtureSource: WorkSource {
    struct Call: Equatable { let scope: WorkNotifyScope; let type: String; let action: String; let level: String? }
    var rows = WorkNotifyPictureFixture.rows
    var calls: [Call] = []
    var restores: [[WorkNotifyChange]] = []
    var refuse = false
    var hold = false
    var held: CheckedContinuation<Void, Never>?
    func projects() async throws -> [String] { ["Orchard"] }
    func changes() -> AsyncStream<Void> { AsyncStream { _ in } }
    func snapshot(project: String) async throws -> WorkSnapshotValue { .init(project: project, containers: [], triage: []) }
    func detail(ref: String) async throws -> WorkItemDetail { throw WorkSourceError("Unknown fixture") }
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome { throw WorkSourceError("Unsupported") }
    func notify(project: String) async throws -> [WorkNotifyRow] { rows }
    func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String, level: String?) async throws -> WorkActionOutcome {
        calls.append(.init(scope: scope, type: type, action: action, level: level))
        if hold { await withCheckedContinuation { held = $0 }; held = nil }
        if refuse { throw WorkSourceError("The fixture refused the write") }
        let layer = scope == .project ? "config.project" : "config.global"
        var changes: [WorkNotifyChange] = []
        for i in rows.indices where type == "*" || type == rows[i].type {
            for j in rows[i].cells.indices {
                var cell = rows[i].cells[j]
                guard cell.writable, action == "*" || action == cell.action,
                      let index = cell.layers.firstIndex(where: { $0.layer == layer }) else { continue }
                let before = cell.layers[index].rule ?? .inherit
                let after = level.map(WorkNotifyRule.level) ?? .inherit
                if before == after { continue }
                cell.layers[index].rule = after; cell.layers[index].level = level
                cell.level = level ?? cell.builtInLevel; cell.from = level == nil ? "default" : layer
                rows[i].cells[j] = cell
                let prefix = scope == .project ? "projects.Orchard" : "global"
                changes.append(.init(path: "\(prefix).rules.notify.\(rows[i].type).\(cell.action)",
                                     type: rows[i].type, action: cell.action, from: before, to: after))
            }
        }
        return .init(ok: true, message: "Rules updated", changes: changes)
    }
    func restoreNotify(project: String?, scope: WorkNotifyScope, changes: [WorkNotifyChange]) async throws -> WorkActionOutcome {
        restores.append(changes)
        rows = WorkNotifyPictureFixture.rows
        return .init(ok: true, message: "Restored")
    }
}

@MainActor
final class WorkNotifyTests: XCTestCase {
    private func ready(_ source: NotifyFixtureSource) async throws -> WorkScreenModel {
        let screen = WorkScreenModel(source: source)
        screen.pane = .notify
        screen.activate()
        try await wait { screen.notifyLoaded }
        return screen
    }

    private func wait(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(3)
        while !condition() && ContinuousClock.now < deadline { try await Task.sleep(for: .milliseconds(5)) }
        XCTAssertTrue(condition())
    }

    private func menu(_ target: WorkNotifyMenu.Target, _ screen: WorkScreenModel) -> NSMenu {
        MenuButtonPresenter.menu(WorkNotifyMenu.items(target: target, scope: .project, enabled: true, chooseScope: { _ in },
            apply: { scope, type, action, level in Task { await screen.setNotify(scope: scope, type: type, action: action, level: level) } }))
    }

    func testTheCellMenuMarksItsLevelAndChangesOneProjectCell() async throws {
        let source = NotifyFixtureSource()
        let screen = try await ready(source)
        defer { screen.deactivate() }
        let cell = try XCTUnwrap(screen.notifyRows.first?.cells.first)
        let native = menu(.init(type: "bug", action: "spotted", cells: [cell]), screen)
        XCTAssertEqual(Array(native.items.prefix(4).map(\.title)), ["Nobody", "In the list", "Inbox line", "Inbox and banner"])
        XCTAssertEqual(native.item(withTitle: "Inbox line")?.state, .on)
        XCTAssertTrue(native.items.prefix(4).allSatisfy { $0.image != nil })
        native.performActionForItem(at: native.indexOfItem(withTitle: "Inbox line"))
        try await wait { source.calls.count == 1 }
        XCTAssertEqual(source.calls, [.init(scope: .project, type: "bug", action: "spotted", level: "inbox")])
    }

    func testBulkMenuMakesOneWriteAndTheNoticeRestoresEveryRawValue() async throws {
        let source = NotifyFixtureSource()
        let screen = try await ready(source)
        defer { screen.deactivate() }
        let row = try XCTUnwrap(screen.notifyRows.first)
        let native = menu(.init(type: row.type, action: "*", cells: row.cells), screen)
        native.performActionForItem(at: native.indexOfItem(withTitle: "Nobody"))
        try await wait { !screen.notifyNotices.notices.isEmpty }
        XCTAssertEqual(source.calls, [.init(scope: .project, type: "bug", action: "*", level: "off")])
        let notice = try XCTUnwrap(screen.notifyNotices.notices.last)
        let undo = try XCTUnwrap(notice.actions.first(where: { $0.label == "Undo" }))
        undo.perform(notice.id)
        try await wait { source.restores.count == 1 && screen.notifyRows == WorkNotifyPictureFixture.rows }
        XCTAssertGreaterThan(source.restores[0].count, 1)
        XCTAssertNotNil(screen.notifyCommand)
    }

    func testPendingGlyphRollsBackOnFailureAndReportsDetails() async throws {
        let source = NotifyFixtureSource()
        source.hold = true; source.refuse = true
        let screen = try await ready(source)
        defer { screen.deactivate() }
        let write = Task { await screen.setNotify(scope: .project, type: "bug", action: "spotted", level: "banner") }
        try await wait { source.held != nil }
        XCTAssertEqual(screen.notifyPending["notify:bug:spotted"], "banner")
        XCTAssertTrue(screen.pending.contains("notify:bug:spotted"))
        source.held?.resume()
        await write.value
        XCTAssertTrue(screen.notifyPending.isEmpty)
        XCTAssertEqual(screen.notifyRows, WorkNotifyPictureFixture.rows)
        let notice = try XCTUnwrap(screen.notifyNotices.notices.last)
        XCTAssertEqual(notice.text, "The notification rules could not be saved")
        XCTAssertTrue(notice.actions.contains { $0.label == "Details" })
    }

    func testCrosshairRepaintsWithoutInvalidatingTheWholeGrid() async throws {
        let prior = RenderProbe.enabled
        RenderProbe.enabled = true
        defer { RenderProbe.enabled = prior }
        let rows = WorkNotifyPictureFixture.rows
        let crosshair = WorkNotifyCrosshair()
        let grid = WorkNotifyFrozenGrid(rows: rows, allRows: rows, pending: [:], enabled: true,
                                        apply: nil, crosshair: crosshair)
        let host = NSHostingView(rootView: grid.frame(width: 1080, height: 300))
        let window = NSWindow(contentRect: CGRect(x: 0, y: 0, width: 1080, height: 300), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        window.orderInForSnapshot()
        defer { window.close() }
        try await wait { RenderProbe.snapshot()["work.notify.row.bug", default: 0] > 0 }
        try await Task.sleep(for: .milliseconds(80))
        let before = RenderProbe.snapshot()
        crosshair.hover(.init(type: "bug", action: "spotted"), inside: true)
        try await wait { RenderProbe.snapshot()["work.notify.crosshair", default: 0] > before["work.notify.crosshair", default: 0] }
        let after = RenderProbe.snapshot()
        let rendered = rows.reduce(0) { count, row in
            let key = "work.notify.row." + row.type
            return count + after[key, default: 0] - before[key, default: 0]
        }
        XCTAssertLessThanOrEqual(rendered, 1)
        print("Work notification crosshair update evaluated " + String(rendered) + " value rows")
    }

    func testRepositoryMenuFilterWordsAndPictures() async throws {
        let source = NotifyFixtureSource()
        let screen = try await ready(source)
        defer { screen.deactivate() }
        let rows = screen.notifyRows
        XCTAssertEqual(WorkNotifyWords.filtered(rows, query: "bu").map(\.type), ["bug"])
        XCTAssertEqual(WorkNotifyWords.filtered(rows, query: "ha").map(\.type), ["handoff"])
        let row = try XCTUnwrap(rows.first)
        let locked = try XCTUnwrap(row.cells.first(where: { !$0.writable }))
        let lockedMenu = menu(.init(type: "bug", action: locked.action, cells: [locked]), screen)
        let limited = try XCTUnwrap(row.cells.first { $0.minSeverity == "high" })
        XCTAssertTrue(WorkNotifyWords.tooltip(type: row.type, cell: limited, level: limited.level, pending: false).contains("Only high and above"))
        XCTAssertTrue(lockedMenu.items.contains { $0.title == "Open the file" })
        XCTAssertFalse(lockedMenu.items.contains { $0.title == "Inbox line" })
        XCTAssertEqual(WorkNotifyWords.action("reopen-undelivered"), "Reopen not delivered")
        let pictures = ProcessInfo.processInfo.environment["WIDGET_SHOTS"]
        let image = try WorkNotifyPicture.render(WorkNotifyPane(screen: screen), name: "work-notify-after", folder: pictures)
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = false
        try VNImageRequestHandler(cgImage: image).perform([request])
        let text = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: " ")
        for expected in ["Spotted", "Reopen", "delivered", "Bug", "Handoff", "Inbox line"] {
            XCTAssertTrue(text.contains(expected), "Missing \(expected) in \(text)")
        }
        for raw in ["reopen-undelivered", "sync-held", "tools work config set"] { XCTAssertFalse(text.contains(raw), text) }
        guard let folder = pictures else { return }
        let before = try WorkNotifyPicture.render(BaselineNotifyGrid(project: WorkNotifyPictureFixture.project, rows: rows),
                                                  name: "work-notify-before", folder: folder)
        XCTAssertEqual(before.width, image.width)
        XCTAssertEqual(before.height, image.height)
        let cell = try XCTUnwrap(row.cells.first)
        try WorkNativeMenuPicture.write(menu(.init(type: "bug", action: cell.action, cells: [cell]), screen),
                                        name: "work-notify-cell-menu", folder: folder)
        try WorkNativeMenuPicture.write(menu(.init(type: "bug", action: "*", cells: row.cells), screen),
                                        name: "work-notify-row-menu", folder: folder)
    }
}

enum WorkNotifyPictureFixture {
    static let project = "Orchard"
    static let size = CGSize(width: 1100, height: 600)
    static let actions = ["spotted", "accepted", "claimed", "finished", "reopened", "reopen-undelivered",
                          "dropped", "commented", "sync-held", "sync-failed"]
    static let types = ["bug", "task", "handoff"]
    static let rows: [WorkNotifyRow] = types.enumerated().map { typeIndex, type in
        WorkNotifyRow(type: type, cells: actions.enumerated().map { actionIndex, action in
            let index = (typeIndex * actions.count + actionIndex) % 4
            let level = ["inbox", "list", "banner", "off"][index]
            let layer = ["config.project", "default", "config.global", "config.repo"][index]
            let threshold = action == "reopened" ? "high" : nil
            let rule: WorkNotifyRule = threshold.map { .threshold(level: level, minSeverity: $0) } ?? .level(level)
            let layers = [WorkNotifyCell.Layer(layer: "default", level: "list")] +
                ["config.global", "config.repo", "config.project"].map {
                    WorkNotifyCell.Layer(layer: $0, level: layer == $0 ? level : nil, rule: layer == $0 ? rule : nil)
                }
            return WorkNotifyCell(action: action, level: level, from: layer, layers: layers, minSeverity: threshold,
                                  repoPath: "/fixture/Orchard/genesis-tools.config.json")
        })
    }
}

@MainActor
enum WorkNotifyPicture {
    /// Snapshot the native scroll view, menus and text field in the same host for both versions.
    @discardableResult
    static func render(_ view: some View, name: String, folder: String?) throws -> CGImage {
        let size = WorkNotifyPictureFixture.size
        let host = NSHostingView(rootView: view
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading).padding(16)
            .frame(width: size.width, height: size.height, alignment: .topLeading)
            .background(Color.black).environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: CGRect(origin: .zero, size: size), styleMask: [.borderless],
                              backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        window.orderInForSnapshot()
        defer { window.close() }
        RunLoop.main.run(until: Date().addingTimeInterval(0.12))
        host.layoutSubtreeIfNeeded()
        let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: bitmap)
        let image = try XCTUnwrap(bitmap.cgImage)
        XCTAssertGreaterThanOrEqual(image.width, Int(size.width))
        if let folder {
            let directory = URL(fileURLWithPath: folder, isDirectory: true)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let url = directory.appendingPathComponent(name + ".png")
            let destination = try XCTUnwrap(CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil))
            CGImageDestinationAddImage(destination, image, nil)
            XCTAssertTrue(CGImageDestinationFinalize(destination))
        }
        return image
    }
}

// Layout at the original base, for same-size before and after captures.
private struct BaselineNotifyGrid: View {
    let project: String
    let rows: [WorkNotifyRow]

    public init(project: String, rows: [WorkNotifyRow]) {
        self.project = project
        self.rows = rows
    }

    private var actions: [String] { rows.first?.cells.map(\.action) ?? [] }

    public var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Grid(alignment: .leading, horizontalSpacing: 10, verticalSpacing: 6) {
                GridRow {
                    Text("Type").font(.system(size: 11, weight: .semibold)).foregroundStyle(KitPalette.dim)
                    ForEach(actions, id: \.self) { action in
                        Text(action).font(.system(size: 10.5, weight: .semibold)).foregroundStyle(KitPalette.dim)
                            .lineLimit(2).frame(width: 74, alignment: .leading)
                    }
                }
                Divider().gridCellColumns(actions.count + 1)
                ForEach(rows) { row in
                    GridRow {
                        Text(row.type).font(.system(size: 12, weight: .medium))
                        ForEach(row.cells) { cell in
                            BaselineNotifyCell(cell: cell)
                        }
                    }
                }
            }
            HStack(spacing: 6) {
                Image(systemName: "terminal").foregroundStyle(KitPalette.faint)
                Text(verbatim: "tools work config set projects.\(project).rules.notify.<type>.<action> '\"inbox\"'")
                    .font(.system(size: 11, design: .monospaced)).foregroundStyle(KitPalette.dim)
                    .textSelection(.enabled)
            }
            Text("off: nobody · list: the tree only · inbox: one quiet inbox line · banner: the line with a notification")
                .font(.system(size: 11)).foregroundStyle(KitPalette.faint)
        }
        .accessibilityIdentifier("work-notify-grid")
    }
}

private struct BaselineNotifyCell: View {
    let cell: WorkNotifyCell

    static func color(_ level: String) -> Color {
        switch level {
        case "off": return KitPalette.faint
        case "inbox": return KitPalette.renamed
        case "banner": return KitPalette.modified
        default: return KitPalette.dim
        }
    }

    static func symbol(_ level: String) -> String {
        switch level {
        case "off": return "bell.slash"
        case "inbox": return "tray"
        case "banner": return "bell.badge"
        default: return "list.bullet"
        }
    }

    var body: some View {
        let decided = cell.from != "default"
        HStack(spacing: 4) {
            Image(systemName: Self.symbol(cell.level)).imageScale(.small)
            Text(cell.level).font(.system(size: 11, weight: decided ? .semibold : .regular))
        }
        .foregroundStyle(Self.color(cell.level))
        .frame(width: 74, alignment: .leading)
        .instantTooltip(title: "\(cell.action): \(cell.level), decided by \(cell.from)",
                        bullets: cell.layers.map { "\($0.layer): \($0.level ?? "not set")" })
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(cell.action) \(cell.level), decided by \(cell.from)")
        // The grid holds a cell per type and action (130 today): each one rests its tooltip like a list row.
        .liveRow(selected: false)
    }
}

/// Draws the REAL NSMenu items using AppKit's menu cells. Never opens or tracks a menu.
/// Evidence covers native item text/check/image/disabled rendering. It is NOT an open-menu screenshot,
/// and does not prove placement, pointer/keyboard interaction, or the live system material.
/// Feed MenuButtonPresenter.menu(theProductionCellOrRowItems), not a second hand-written item list.
@MainActor
enum WorkNativeMenuPicture {
    static func write(_ menu: NSMenu, name: String, folder: String, highlightedIndex: Int? = nil) throws {
        let view = WorkNativeMenuDrawing(menu: menu, highlightedIndex: highlightedIndex)
        view.appearance = NSAppearance(named: .darkAqua)
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        let directory = URL(fileURLWithPath: folder, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            .write(to: directory.appendingPathComponent(name + ".png"))
        let provenance: [String: Any] = [
            "capture": "AppKit NSMenuItemCell drawing of production NSMenu",
            "isOpenMenuScreenshot": false,
            "items": menu.items.map { item -> [String: Any] in
                ["title": item.title, "checked": item.state == .on, "enabled": item.isEnabled,
                 "separator": item.isSeparatorItem, "hasImage": item.image != nil,
                 "submenuTitles": item.submenu?.items.map(\.title) ?? []]
            },
        ]
        try JSONSerialization.data(withJSONObject: provenance, options: [.prettyPrinted, .sortedKeys])
            .write(to: directory.appendingPathComponent(name + "-provenance.json"))
    }
}

@MainActor
private final class WorkNativeMenuDrawing: NSView {
    private let cells: [NSMenuItemCell]
    private let heights: [CGFloat]
    override var isFlipped: Bool { true }

    init(menu: NSMenu, highlightedIndex: Int?) {
        cells = menu.items.enumerated().map { index, item in
            let cell = NSMenuItemCell(textCell: item.title)
            cell.menuItem = item
            cell.font = menu.font
            cell.isEnabled = item.isEnabled
            cell.state = item.state
            cell.image = item.image
            cell.isHighlighted = index == highlightedIndex && item.isEnabled
            cell.calcSize()
            return cell
        }
        heights = zip(menu.items, cells).map { item, cell in
            item.isSeparatorItem ? 10 : max(22, cell.cellSize.height + 4)
        }
        let width = max(240, cells.map { $0.cellSize.width + 48 }.max() ?? 240)
        super.init(frame: CGRect(x: 0, y: 0, width: width, height: heights.reduce(12, +)))
    }

    required init?(coder: NSCoder) { return nil }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.controlBackgroundColor.setFill()
        bounds.fill()
        var y: CGFloat = 6
        for (cell, height) in zip(cells, heights) {
            let frame = CGRect(x: 6, y: y, width: bounds.width - 12, height: height)
            if cell.menuItem?.isSeparatorItem == true {
                cell.drawSeparatorItem(withFrame: frame, in: self)
            } else {
                cell.draw(withFrame: frame, in: self)
            }
            y += height
        }
    }
}
