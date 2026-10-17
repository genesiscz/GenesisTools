//
//  MarkdownTreeTable.swift
//  GenesisKit
//
//  The viewer's file tree as an AppKit table whose cells host the SwiftUI rows. A SwiftUI lazy list re-laid out its
//  rows on every scroll frame, hashed and compared their ids, and walked every row's responders for accessibility
//  focus: about 12 ms of main thread per wheel event in the installed release viewer, with 100 tabs open
//  (2026-10-15). The table only moves its clip view while scrolling; a row's SwiftUI view is built when its cell comes
//  into view or its value changes.
//

import AppKit
import SwiftUI

/// A list of equal-height rows in an `NSTableView`. `cell` builds the SwiftUI view of one row; `revision` is any value
/// that changes when something the cells draw changes besides the rows themselves (the selection, a pulse, the git
/// marks, the style), so the visible cells are built again.
struct MarkdownTreeTable<Revision: Equatable>: NSViewRepresentable {
    @GenReduceMotion private var reduceMotion
    /// The visible tree rows in depth-first display order.
    let rows: [FileTreeRow]
    /// The selection, style and decoration revision used to invalidate visible cells.
    let revision: Revision
    /// The shared scroll handle used by reveals and history restoration.
    let box: MarkdownTreeScrollBox
    /// Builds the hosted SwiftUI content for a row when the table needs it.
    let cell: (FileTreeRow) -> AnyView

    /// Creates the persistent table data source and cell coordinator.
    func makeCoordinator() -> Coordinator { Coordinator() }

    /// The table's scroll view lives outside SwiftUI: laid over this slot by the window's content view
    /// (`MarkdownWindowContentView`), so its scrolling never lays out a SwiftUI host.
    func makeNSView(context: Context) -> MarkdownOverlaySlot {
        let table = MarkdownTreeTableView()
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("row"))
        column.resizingMask = .autoresizingMask
        table.addTableColumn(column)
        table.headerView = nil
        table.style = .plain
        table.intercellSpacing = .zero
        table.selectionHighlightStyle = .none
        table.backgroundColor = .clear
        table.focusRingType = .none
        table.columnAutoresizingStyle = .uniformColumnAutoresizingStyle
        table.usesAutomaticRowHeights = false
        table.dataSource = context.coordinator
        table.delegate = context.coordinator

        let scroll = NSScrollView()
        scroll.documentView = table
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.autohidesScrollers = true
        scroll.scrollerStyle = .overlay
        scroll.automaticallyAdjustsContentInsets = false
        scroll.contentInsets = NSEdgeInsets(top: MarkdownTreeScroll.padding, left: 0, bottom: MarkdownTreeScroll.padding, right: 0)
        context.coordinator.table = table
        box.scrollView = scroll
        apply(to: context.coordinator, table: table, force: true)
        let slot = MarkdownOverlaySlot(overlay: scroll)
        slot.contentHeight = { [weak table, weak scroll] in
            guard let table, let scroll else { return .greatestFiniteMagnitude }
            return CGFloat(table.numberOfRows) * table.rowHeight + scroll.contentInsets.top + scroll.contentInsets.bottom
        }
        return slot
    }

    /// Updates row content and repositions the AppKit overlay after a SwiftUI change.
    func updateNSView(_ slot: MarkdownOverlaySlot, context: Context) {
        box.scrollView = slot.overlay as? NSScrollView
        guard let table = context.coordinator.table else { return }
        apply(to: context.coordinator, table: table, force: false)
        slot.contentChanged()
    }

    /// Detaches the overlay when SwiftUI dismantles its placeholder.
    static func dismantleNSView(_ slot: MarkdownOverlaySlot, coordinator: Coordinator) {
        slot.leave()
    }

    private func apply(to coordinator: Coordinator, table: NSTableView, force: Bool) {
        let reduced = reduceMotion
        let buildCell = cell
        // Each row has its own NSHostingView, so it needs the enclosing environment's effective preference explicitly.
        coordinator.cell = { row in AnyView(buildCell(row).environment(\.nativeSettingsReduceMotion, reduced)) }
        let rowsChanged = force || coordinator.rows != rows
        let revisionChanged = force || coordinator.reduceMotion != reduced || coordinator.revision as? Revision != revision
        coordinator.reduceMotion = reduced
        let old = coordinator.rows
        coordinator.rows = rows
        coordinator.revision = revision
        if coordinator.rowHeight == nil || revisionChanged, let first = rows.first {
            let height = MarkdownTreeTableCell.height(of: coordinator.cell(first))
            if height != coordinator.rowHeight {
                coordinator.rowHeight = height
                table.rowHeight = height
            }
        }
        if rowsChanged {
            if force || !coordinator.animateRows(old, rows, table, reduced) {
                table.reloadData()
            }
            if revisionChanged { coordinator.rebuildVisible() }
        } else if revisionChanged {
            coordinator.rebuildVisible()
        }
    }

    /// A folder opening or closing: its rows slide in or out, and the rows whose value changed (the folder's chevron)
    /// take their views again. False when a reload fits better: effective Reduce Motion, a new root, or a change too
    /// large to watch.
    @MainActor
    static func animate(from old: [FileTreeRow], to new: [FileTreeRow], in table: NSTableView, reduceMotion: Bool) -> Bool {
        guard !old.isEmpty, !reduceMotion else { return false }
        let difference = new.map(\.key).difference(from: old.map(\.key))
        var removed = IndexSet()
        var inserted = IndexSet()
        for change in difference {
            switch change {
            case .remove(let offset, _, _): removed.insert(offset)
            case .insert(let offset, _, _): inserted.insert(offset)
            }
        }
        guard removed.count + inserted.count <= 400, removed.count < old.count else { return false }
        let before = Dictionary(old.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let changed = IndexSet(new.indices.filter { index in
            !inserted.contains(index) && before[new[index].key].map { $0 != new[index] } ?? false
        })
        table.beginUpdates()
        if !removed.isEmpty { table.removeRows(at: removed, withAnimation: [.slideUp, .effectFade]) }
        if !inserted.isEmpty { table.insertRows(at: inserted, withAnimation: [.slideDown, .effectFade]) }
        table.endUpdates()
        if !changed.isEmpty { table.reloadData(forRowIndexes: changed, columnIndexes: IndexSet(integer: 0)) }
        return true
    }

    /// Keeps row values and builds reusable cells for the AppKit table.
    @MainActor
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate {
        /// The table supplied by the representable, held without extending its lifetime.
        weak var table: NSTableView?
        /// The row snapshot currently exposed to the table data source.
        var rows: [FileTreeRow] = []
        /// The effective preference last applied to native animations and isolated cell hosts.
        var reduceMotion = false
        /// Native row updates, with the effective preference supplied by the representable; injectable for hosted tests.
        var animateRows: ([FileTreeRow], [FileTreeRow], NSTableView, Bool) -> Bool = { old, new, table, reduced in
            MarkdownTreeTable<Revision>.animate(from: old, to: new, in: table, reduceMotion: reduced)
        }
        /// The last applied cell revision, compared with the next representable update.
        var revision: Any?
        /// The measured height shared by all visible table rows.
        var rowHeight: CGFloat?
        /// The current builder installed by the representable for reusable cells.
        var cell: (FileTreeRow) -> AnyView = { _ in AnyView(EmptyView()) }

        /// Reports exactly the number of rows in the current snapshot.
        func numberOfRows(in tableView: NSTableView) -> Int { rows.count }

        /// Reuses or creates a hosting cell and supplies the requested row content.
        func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
            let identifier = NSUserInterfaceItemIdentifier("markdown-tree-cell")
            let view = tableView.makeView(withIdentifier: identifier, owner: nil) as? MarkdownTreeTableCell
                ?? MarkdownTreeTableCell(identifier: identifier)
            view.show(cell(rows[row]))
            return view
        }

        /// Leaves selection to row controls rather than the AppKit table.
        func tableView(_ tableView: NSTableView, shouldSelectRow row: Int) -> Bool { false }

        /// The cells on screen take their views again (the selection, a pulse or the git marks changed).
        func rebuildVisible() {
            guard let table else { return }
            let visible = table.rows(in: table.visibleRect)
            guard visible.length > 0 else { return }
            for index in visible.location..<min(visible.location + visible.length, rows.count) {
                (table.view(atColumn: 0, row: index, makeIfNecessary: false) as? MarkdownTreeTableCell)?.show(cell(rows[index]))
            }
        }
    }
}

/// The table under the rows: it never takes the keyboard or a selection, so a click reaches the row's button.
final class MarkdownTreeTableView: NSTableView {
    /// Keeps keyboard focus in the row controls rather than the table itself.
    override var acceptsFirstResponder: Bool { false }

    /// A table hands a click to a subview only when this says yes, and it says yes for controls alone: without it the
    /// row's SwiftUI button never saw a click (2026-10-15, the first live check of the table).
    override func validateProposedFirstResponder(_ responder: NSResponder, for event: NSEvent?) -> Bool { true }

    /// Accessibility sees the rows on screen, as it saw the lazy list's laid-out rows: a table hands out every row and
    /// builds each one it is asked for, so one search through the window took 3.6 to 4.1 s instead of 0.4 to 0.7 s
    /// (2026-10-15).
    override func accessibilityChildren() -> [Any]? {
        let visible = rows(in: visibleRect)
        guard visible.length > 0 else { return [] }
        let cells = (visible.location..<visible.location + visible.length).compactMap {
            view(atColumn: 0, row: $0, makeIfNecessary: false)
        }
        return NSAccessibility.unignoredChildren(from: cells)
    }

    /// The empty space under the rows is the window root's, not the table's (`MarkdownOverlaySlot.contentHeight`), so
    /// a right-click there opens the sidebar's own menu.
    override func menu(for event: NSEvent) -> NSMenu? { nil }
}

/// One reused cell: a hosting view whose root view is swapped when the cell shows another row.
final class MarkdownTreeTableCell: NSView {
    private let host = NSHostingView(rootView: AnyView(EmptyView()))

    /// Creates a reusable cell whose hosting view fills the cell without sizing the window.
    init(identifier: NSUserInterfaceItemIdentifier) {
        super.init(frame: .zero)
        self.identifier = identifier
        host.translatesAutoresizingMaskIntoConstraints = false
        host.sizingOptions = []
        // A cell needs no safe area. With it, every cell that moved during a scroll recomputed its insets, marked its
        // constraints dirty, and that mark reached the table's SwiftUI host, which laid out the whole window again
        // (lldb on the check app, 2026-10-15).
        host.safeAreaRegions = []
        addSubview(host)
        NSLayoutConstraint.activate([
            host.leadingAnchor.constraint(equalTo: leadingAnchor),
            host.trailingAnchor.constraint(equalTo: trailingAnchor),
            host.topAnchor.constraint(equalTo: topAnchor),
            host.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    /// Rejects archive construction because cells are created programmatically.
    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    /// Replaces the hosted row content when a cell is reused or invalidated.
    func show(_ view: AnyView) {
        host.rootView = view
    }

    /// The height a row asks for at its ideal size.
    @MainActor
    static func height(of view: AnyView) -> CGFloat {
        let probe = NSHostingView(rootView: view)
        return max(ceil(probe.fittingSize.height), 1)
    }
}
