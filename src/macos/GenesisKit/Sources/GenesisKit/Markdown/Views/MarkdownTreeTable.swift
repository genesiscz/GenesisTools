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
    /// What the keyboard does on a row (Up, Down, Left, Right, Return). nil: the table never takes the keyboard.
    var keys: MarkdownTreeKeys? = nil
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
        table.coordinatorKeys = context.coordinator

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
        coordinator.keys = keys
        (table as? MarkdownTreeTableView)?.takesKeyboard = keys != nil
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
        if rowsChanged { coordinator.keepCursor() }
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
    final class Coordinator: NSObject, NSTableViewDataSource, NSTableViewDelegate, MarkdownTreeKeyTarget {
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
        /// The keyboard's verbs, from the representable.
        var keys: MarkdownTreeKeys?
        /// The row the keyboard is on, by identity, so a folder opening above it does not move it to another row.
        private var cursorKey: FileTreeRowKey?

        /// The keyboard row's index in the current rows.
        var cursor: Int? { cursorKey.flatMap { key in rows.firstIndex { $0.key == key } } }

        /// Puts the keyboard on `index` (nil: off), selects it in the table and scrolls it into view.
        func setCursor(_ index: Int?) {
            guard let table else { return }
            guard let index, rows.indices.contains(index) else {
                cursorKey = nil
                table.deselectAll(nil)
                return
            }
            cursorKey = rows[index].key
            table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
            table.scrollRowToVisible(index)
            if NSWorkspace.shared.isVoiceOverEnabled {
                GenAnnounce.post(MarkdownTreeKeys.spoken(rows[index]), priority: .low)
            }
        }

        /// The rows changed (a folder opened, a listing landed): the keyboard stays on its row, or leaves when it is gone.
        func keepCursor() {
            guard cursorKey != nil, let table else { return }
            if let index = cursor {
                if table.selectedRow != index { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
            } else {
                cursorKey = nil
                table.deselectAll(nil)
            }
        }

        /// The table took the keyboard: start on the row it was clicked on, else the open file, else the first row.
        func beginKeyboard(at clicked: Int?) {
            if let clicked { setCursor(clicked); return }
            guard cursor == nil else { return }
            setCursor(keys?.start(rows) ?? (rows.isEmpty ? nil : 0))
        }

        func endKeyboard() {
            cursorKey = nil
            table?.deselectAll(nil)
        }

        /// Runs one key; false hands it on.
        func handle(_ key: MarkdownTreeKey) -> Bool {
            guard let keys else { return false }
            switch MarkdownTreeKeys.action(for: key, rows: rows, cursor: cursor) {
            case .none:
                return false
            case .select(let index):
                setCursor(index)
            case .toggle(let index):
                keys.toggle(rows[index])
            case .open(let index):
                keys.open(rows[index])
            case .navigate(let index):
                keys.navigate(rows[index])
            case .up:
                keys.up()
            case .clear:
                endKeyboard()
                table?.window?.makeFirstResponder(nil)
            }
            return true
        }

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

/// The table under the rows. A click reaches the row's button; the keyboard, when the host gives it verbs
/// (`MarkdownTreeKeys`), walks the rows with a selection of its own, which the pointer's hover never moves.
final class MarkdownTreeTableView: NSTableView {
    /// The coordinator that owns the rows and the keyboard row.
    weak var coordinatorKeys: (any MarkdownTreeKeyTarget)?
    /// Whether the host gave the keyboard any verbs.
    var takesKeyboard = false {
        didSet { if takesKeyboard != oldValue { selectionHighlightStyle = takesKeyboard ? .regular : .none } }
    }
    /// A row click that brings the keyboard here, read once by `becomeFirstResponder`.
    var clickedRowForKeyboard: Int?

    override var acceptsFirstResponder: Bool { takesKeyboard }

    override func becomeFirstResponder() -> Bool {
        guard super.becomeFirstResponder() else { return false }
        coordinatorKeys?.beginKeyboard(at: clickedRowForKeyboard)
        clickedRowForKeyboard = nil
        return true
    }

    override func resignFirstResponder() -> Bool {
        guard super.resignFirstResponder() else { return false }
        coordinatorKeys?.endKeyboard()
        return true
    }

    override func keyDown(with event: NSEvent) {
        if let key = MarkdownTreeKey(event), coordinatorKeys?.handle(key) == true { return }
        super.keyDown(with: event)
    }

    /// A click on a row puts the keyboard there, as in Finder's sidebar: Up and Down go on from the clicked row.
    func noteRowClick(_ row: Int) {
        guard takesKeyboard, row >= 0 else { return }
        if window?.firstResponder === self {
            coordinatorKeys?.beginKeyboard(at: row)
        } else {
            clickedRowForKeyboard = row
            window?.makeFirstResponder(self)
        }
    }

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
    private let host = MarkdownTreeCellHost(rootView: AnyView(EmptyView()))

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

/// A cell's hosting view: a click on the row tells the table, so the keyboard continues from that row.
final class MarkdownTreeCellHost: NSHostingView<AnyView> {
    override func mouseDown(with event: NSEvent) {
        var view: NSView? = superview
        while let current = view, !(current is MarkdownTreeTableView) { view = current.superview }
        if let table = view as? MarkdownTreeTableView {
            table.noteRowClick(table.row(for: self))
        }
        super.mouseDown(with: event)
    }
}

/// The coordinator side of the table's keyboard.
@MainActor
protocol MarkdownTreeKeyTarget: AnyObject {
    func beginKeyboard(at clicked: Int?)
    func endKeyboard()
    func handle(_ key: MarkdownTreeKey) -> Bool
}

/// A key the tree answers.
enum MarkdownTreeKey: Equatable {
    case up, down, left, right
    /// Return or Enter.
    case open
    /// ⌘↓: a folder becomes the root, a file opens.
    case navigate
    /// ⌘↑: the folder above the root.
    case parent
    case escape

    init?(_ event: NSEvent) {
        let command = event.modifierFlags.intersection(.deviceIndependentFlagsMask).contains(.command)
        switch event.keyCode {
        case 126: self = command ? .parent : .up
        case 125: self = command ? .navigate : .down
        case 123: self = .left
        case 124: self = .right
        case 36, 76: self = .open
        case 53: self = .escape
        default: return nil
        }
    }
}

/// What a key does to the rows: pure, so it is tested without a window.
enum MarkdownTreeKeyAction: Equatable {
    case none
    case select(Int)
    case toggle(Int)
    case open(Int)
    case navigate(Int)
    case up
    case clear
}

/// The verbs the keyboard reaches: the host's own, so a key does what a click on the row does.
struct MarkdownTreeKeys {
    /// Opens a file (Return on a file row).
    var open: (FileTreeRow) -> Void
    /// Opens or closes a folder (Right, Left, Return on a folder row).
    var toggle: (FileTreeRow) -> Void
    /// Makes a folder the root (⌘↓ on a folder row).
    var navigate: (FileTreeRow) -> Void
    /// The folder above the root (⌘↑).
    var up: () -> Void
    /// The row the keyboard starts on (the open file), or nil for the first row.
    var start: ([FileTreeRow]) -> Int?

    /// Up and Down move, Right opens a folder or goes into it, Left closes it or goes to its parent, Return opens a
    /// file or toggles a folder, ⌘↓ goes into a folder, ⌘↑ goes up, Esc lets the keyboard go.
    static func action(for key: MarkdownTreeKey, rows: [FileTreeRow], cursor: Int?) -> MarkdownTreeKeyAction {
        if key == .parent { return .up }
        if key == .escape { return cursor == nil ? .none : .clear }
        guard !rows.isEmpty else { return .none }
        guard let index = cursor, rows.indices.contains(index) else {
            return key == .down || key == .up ? .select(0) : .none
        }
        let row = rows[index]
        switch key {
        case .down:
            return .select(min(index + 1, rows.count - 1))
        case .up:
            return .select(max(index - 1, 0))
        case .right:
            guard row.isFolder else { return .none }
            if !row.expanded { return .toggle(index) }
            let next = index + 1
            return next < rows.count && rows[next].depth > row.depth ? .select(next) : .none
        case .left:
            if row.isFolder, row.expanded { return .toggle(index) }
            guard row.depth > 0 else { return .none }
            let parent = rows[..<index].lastIndex { $0.depth == row.depth - 1 && $0.isFolder }
            return parent.map(MarkdownTreeKeyAction.select) ?? .none
        case .open:
            return row.isFolder ? .toggle(index) : .open(index)
        case .navigate:
            return row.isFolder ? .navigate(index) : .open(index)
        case .parent, .escape:
            return .none
        }
    }

    /// A row as VoiceOver says it when the keyboard lands on it.
    static func spoken(_ row: FileTreeRow) -> String {
        row.isFolder ? "\(row.name), folder, \(row.expanded ? "expanded" : "collapsed")" : row.name
    }
}
