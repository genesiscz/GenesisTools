//
//  GitRepoTable.swift
//  GenesisKit
//
//  The repository panel's rows in an AppKit table whose cells host the SwiftUI rows, laid over the git sidebar like
//  the file tree's table (`MarkdownTreeTable`, `MarkdownOverlaySlot`). The rows were a SwiftUI `LazyVStack` inside the
//  sidebar's scroll view: every 45 pt scroll step cost 9.4 ms of main thread on a vault (12.2 ms with a 600-row folder
//  open, spikes to 395 ms), all of it the lazy stack placing rows inside the window root's layout (benchmark,
//  2026-10-25). The table only moves its clip view while scrolling and builds a row's view when its cell comes into
//  view, so the cost no longer grows with the number of rows, and the panel needs no "Show more" pages.
//

import AppKit
import SwiftUI

/// What the keyboard does in the table: the same verbs as a click.
struct GitRepoTableKeys {
    /// Return: opens a file or a commit, opens or closes a folder.
    var activate: (GitPanelRow) -> Void
    /// Right (true) and Left (false) on a folder row.
    var setOpen: (GitPanelRow, Bool) -> Void
    /// The row the keyboard starts on (the open file), or nil for the first one.
    var start: ([GitPanelRow]) -> Int?
}

/// A handle on the table for the panel's own actions: the reveal button scrolls and lights a row.
@MainActor
final class GitRepoTableBox {
    fileprivate weak var table: NSTableView?
    fileprivate var rows: () -> [GitPanelRow] = { [] }
    fileprivate var rebuild: ((GitPanelRow) -> Bool) -> Void = { _ in }

    /// The rows on screen that match take their views again (the open file changed: only its old and new rows differ).
    func refresh(where match: @escaping (GitPanelRow) -> Bool) {
        rebuild(match)
    }

    /// Scrolls the row with `id` to the middle of the table, animated unless Reduce Motion is on. False when it has
    /// no row (yet).
    @discardableResult
    func reveal(_ id: String, reduceMotion: Bool) -> Bool {
        guard let table, let index = rows().firstIndex(where: { $0.id == id }),
              let clip = table.enclosingScrollView?.contentView else { return false }
        let rect = table.rect(ofRow: index)
        let target = NSPoint(x: 0, y: max(0, min(rect.midY - clip.bounds.height / 2, table.bounds.height - clip.bounds.height)))
        if reduceMotion {
            clip.setBoundsOrigin(target)
        } else {
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.3
                context.allowsImplicitAnimation = true
                clip.animator().setBoundsOrigin(target)
            }
        }
        table.enclosingScrollView?.reflectScrolledClipView(clip)
        return true
    }
}

/// The panel's rows in a table. `revision` is any value that changes when the cells draw differently with the same
/// rows (the flash, the order's date column, the revealed file), so the visible cells are built again.
struct GitRepoTable<Revision: Equatable>: NSViewRepresentable {
    @GenReduceMotion private var reduceMotion
    let rows: [GitPanelRow]
    let revision: Revision
    let box: GitRepoTableBox
    var keys: GitRepoTableKeys?
    let cell: (GitPanelRow) -> AnyView

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> MarkdownOverlaySlot {
        let table = MarkdownTreeTableView()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain
        table.intercellSpacing = NSSize(width: 0, height: 1)
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.focusRingType = .none
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.usesAutomaticRowHeights = false
        table.dataSource = context.coordinator
        table.delegate = context.coordinator
        table.coordinatorKeys = context.coordinator
        table.setAccessibilityIdentifier("git-repo-rows")

        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: 2, left: 0, bottom: 8, right: 0)
        context.coordinator.table = table
        box.table = table
        box.rows = { [weak coordinator = context.coordinator] in coordinator?.rows ?? [] }
        box.rebuild = { [weak coordinator = context.coordinator] match in coordinator?.rebuildAvailable(where: match) }
        apply(to: context.coordinator, table: table, force: true)
        let slot = MarkdownOverlaySlot(overlay: scroll)
        slot.contentHeight = { [weak table, weak scroll] in
            guard let table, let scroll else { return .greatestFiniteMagnitude }
            let rows = table.numberOfRows > 0 ? table.rect(ofRow: table.numberOfRows - 1).maxY : 0
            return rows + scroll.contentInsets.top + scroll.contentInsets.bottom
        }
        return slot
    }

    func updateNSView(_ slot: MarkdownOverlaySlot, context: Context) {
        guard let table = context.coordinator.table else { return }
        box.table = table
        apply(to: context.coordinator, table: table, force: false)
        slot.contentChanged()
    }

    static func dismantleNSView(_ slot: MarkdownOverlaySlot, coordinator: Coordinator) {
        slot.leave()
    }

    private func apply(to coordinator: Coordinator, table: NSTableView, force: Bool) {
        let reduced = reduceMotion
        let buildCell = cell
        coordinator.cell = { row in AnyView(buildCell(row).environment(\.nativeSettingsReduceMotion, reduced)) }
        coordinator.keys = keys
        (table as? MarkdownTreeTableView)?.takesKeyboard = keys != nil
        let rowsChanged = force || coordinator.rows != rows
        let revisionChanged = force || coordinator.revision as? Revision != revision
        let old = coordinator.rows
        coordinator.rows = rows
        coordinator.revision = revision
        if coordinator.rowHeight == nil, let first = rows.first(where: { $0.kind == .file }) ?? rows.first {
            let height = MarkdownTreeTableCell.height(of: coordinator.cell(first))
            coordinator.rowHeight = height
            table.rowHeight = height
        }
        if rowsChanged {
            let span = PerfSpans.begin("git.panel.table", "\(old.count) → \(rows.count) rows")
            if force {
                table.reloadData()
            } else if Self.animate(from: old, to: rows, in: table, reduceMotion: reduced) {
                // Rows moved with their row views: rebuild those whose value changed, found by id.
                let before = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
                if !revisionChanged { coordinator.rebuildAvailable { before[$0.id] != $0 } }
            } else {
                // A sort, a filter or a large fold: the row views on screen stay and take their new rows. A reload threw
                // every row view away, and each new one re-ran AppKit's key-view loop and moved a SwiftUI host into the
                // window: 1,159 + 892 of 2,172 busy samples of a sort on a vault (2026-10-25).
                if old.count != rows.count { table.noteNumberOfRowsChanged() }
                if !revisionChanged { coordinator.rebuildAvailable(changedFrom: old) }
            }
            if force || revisionChanged { coordinator.rebuildAvailable() }
            span.end()
            coordinator.keepCursor()
        } else if revisionChanged {
            coordinator.rebuildAvailable()
        }
    }

    /// A folder opening or closing, a filter or a new status: rows that came slide in, rows that went slide out (the
    /// caller then gives every row view on screen its row). False when the rows on screen should simply take their new
    /// rows: Reduce Motion, a reorder, or a change too large to watch.
    @MainActor
    static func animate(from old: [GitPanelRow], to new: [GitPanelRow], in table: NSTableView, reduceMotion: Bool) -> Bool {
        guard !old.isEmpty, !reduceMotion, abs(new.count - old.count) <= 400 else { return false }
        // Linear, not `difference(from:)`: Myers costs O(n × d), and a sort or a filter over thousands of rows made it
        // the slowest part of a click (195 ms per sort on a vault, 2026-10-25). Rows kept on both sides must keep their
        // order; a reorder (a sort) reloads instead, since a table cannot animate a move with inserts and removes.
        let oldIDs = old.map(\.id), newIDs = new.map(\.id)
        let oldSet = Set(oldIDs), newSet = Set(newIDs)
        let removed = IndexSet(oldIDs.indices.filter { !newSet.contains(oldIDs[$0]) })
        let inserted = IndexSet(newIDs.indices.filter { !oldSet.contains(newIDs[$0]) })
        guard removed.count + inserted.count <= 400, removed.count < old.count,
              oldIDs.filter(newSet.contains) == newIDs.filter(oldSet.contains) else { return false }
        let before = Dictionary(old.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let changed = IndexSet(new.indices.filter { index in
            !inserted.contains(index) && before[new[index].id].map { $0 != new[index] } ?? false
        })
        table.beginUpdates()
        if !removed.isEmpty { table.removeRows(at: removed, withAnimation: [.slideUp, .effectFade]) }
        if !inserted.isEmpty { table.insertRows(at: inserted, withAnimation: [.slideDown, .effectFade]) }
        table.endUpdates()
        return true
    }

    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate, MarkdownTreeKeyTarget {
        weak var table: NSTableView?
        var rows: [GitPanelRow] = []
        var revision: Any?
        var cell: (GitPanelRow) -> AnyView = { _ in AnyView(EmptyView()) }
        var keys: GitRepoTableKeys?
        /// Every row has one height, measured once: a row of another height would have to be measured, and each change
        /// of the rows would move the ones below it.
        var rowHeight: CGFloat?
        private var cursorID: String?

        var cursor: Int? { cursorID.flatMap { id in rows.firstIndex { $0.id == id } } }

        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            let identifier = NSUserInterfaceItemIdentifier("git-repo-cell")
            let view = tableView.makeView(withIdentifier: identifier, owner: nil) as? MarkdownTreeTableCell
                ?? MarkdownTreeTableCell(identifier: identifier)
            view.show(cell(rows[row]))
            return view
        }

        func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }

        /// Every row view the table holds (on screen and the few it prepared beyond) that `match` picks takes its current
        /// row. Each rebuild swaps a hosted SwiftUI root, about a millisecond, so only rows that changed are rebuilt.
        func rebuildAvailable(where match: (GitPanelRow) -> Bool = { _ in true }) {
            guard let table else { return }
            let rows = rows
            let cell = cell
            table.enumerateAvailableRowViews { rowView, index in
                guard index < rows.count, match(rows[index]) else { return }
                (rowView.view(atColumn: 0) as? MarkdownTreeTableCell)?.show(cell(rows[index]))
            }
        }

        /// After an in-place refill: a row view shows another row when its index now holds a different value.
        func rebuildAvailable(changedFrom old: [GitPanelRow]) {
            guard let table else { return }
            let rows = rows
            let cell = cell
            table.enumerateAvailableRowViews { rowView, index in
                guard index < rows.count, index >= old.count || old[index] != rows[index] else { return }
                (rowView.view(atColumn: 0) as? MarkdownTreeTableCell)?.show(cell(rows[index]))
            }
        }

        // MARK: Keyboard

        private func setCursor(_ index: Int?) {
            guard let table else { return }
            guard let index, rows.indices.contains(index), rows[index].selectable else {
                cursorID = nil
                table.deselectAll(nil)
                return
            }
            cursorID = rows[index].id
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            table.scrollRowToVisible(index)
            if NSWorkspace.shared.isVoiceOverEnabled { GenAnnounce.post(rows[index].spoken, priority: .low) }
        }

        func keepCursor() {
            guard cursorID != nil, let table else { return }
            if let index = cursor {
                if table.selectedRow != index { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
            } else {
                cursorID = nil
                table.deselectAll(nil)
            }
        }

        func beginKeyboard(at clicked: Int?) {
            if let clicked, rows.indices.contains(clicked), rows[clicked].selectable {
                setCursor(clicked)
                return
            }
            guard cursor == nil else { return }
            setCursor(keys?.start(rows) ?? rows.firstIndex(where: \.selectable))
        }

        func endKeyboard() {
            cursorID = nil
            table?.deselectAll(nil)
        }

        func handle(_ key: MarkdownTreeKey) -> Bool {
            guard let keys else { return false }
            switch GitPanelRow.action(for: key, rows: rows, cursor: cursor) {
            case .none:
                return false
            case .select(let index):
                setCursor(index)
            case .activate(let index):
                keys.activate(rows[index])
            case .setOpen(let index, let open):
                keys.setOpen(rows[index], open)
            case .clear:
                endKeyboard()
                table?.window?.makeFirstResponder(nil)
            }
            return true
        }
    }
}
