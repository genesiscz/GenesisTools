//
//  PathMenu.swift
//  GenesisKit
//
//  The one menu of verbs for a file or a folder, built from an ordered `[PathAction]` list (a host's
//  `folderActions` / `fileActions`, so a settings screen can reorder them later). The verbs any app can
//  do run here: Finder, Cursor, the default app, Obsidian, a terminal, copy path, rename, duplicate and
//  move to the Trash. The verbs that need the host's window (its sidebar, its search, a new file in it)
//  come in as handlers, and a verb without a handler is left out. The same entries render as a SwiftUI
//  context menu (`PathActionsMenu`) or as an NSMenu dropped below a control (`PathMenuButton`).
//

import AppKit
import SwiftUI

/// A file or a folder, as a path menu treats it.
public enum PathKind: Sendable, Equatable {
    case file
    case folder

    /// What is at `url`: a folder (not a package, which Finder shows as one item), or a file.
    public static func of(_ url: URL) -> PathKind {
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        return values?.isDirectory == true && values?.isPackage != true ? .folder : .file
    }
}

/// The verbs only the host can do. A nil handler leaves its verb out of the menu.
public struct PathMenuHandlers {
    public var showInSidebar: (() -> Void)?
    public var navigateInSidebar: (() -> Void)?
    public var searchInFolder: (() -> Void)?
    public var newFile: (() -> Void)?
    public var newFolder: (() -> Void)?
    /// What a rename, a duplicate or a move to the Trash did. nil leaves those three verbs out.
    public var changed: ((FileChange) -> Void)?
    /// A reason to refuse a rename or a move to the Trash first (a tab with unsaved edits), or nil.
    public var guardChange: ((URL) -> String?)?

    public init(
        showInSidebar: (() -> Void)? = nil,
        navigateInSidebar: (() -> Void)? = nil,
        searchInFolder: (() -> Void)? = nil,
        newFile: (() -> Void)? = nil,
        newFolder: (() -> Void)? = nil,
        changed: ((FileChange) -> Void)? = nil,
        guardChange: ((URL) -> String?)? = nil
    ) {
        self.showInSidebar = showInSidebar
        self.navigateInSidebar = navigateInSidebar
        self.searchInFolder = searchInFolder
        self.newFile = newFile
        self.newFolder = newFolder
        self.changed = changed
        self.guardChange = guardChange
    }
}

/// What a menu asks the system before it offers a verb. A test passes its own, so building a menu
/// touches no LaunchServices.
public struct PathMenuEnvironment {
    /// The app macOS opens a file with ("Preview"); nil when none does, or when it is this app.
    public var defaultAppName: (URL) -> String?
    public var obsidianInstalled: Bool
    /// The host opens its own terminal (a cmux workspace) rather than Terminal.
    public var hostTerminal: Bool

    public init(defaultAppName: @escaping (URL) -> String?, obsidianInstalled: Bool, hostTerminal: Bool) {
        self.defaultAppName = defaultAppName
        self.obsidianInstalled = obsidianInstalled
        self.hostTerminal = hostTerminal
    }

    /// LaunchServices, asked once per file extension and once for Obsidian: a menu is built on every
    /// right-click, and a tree builds one per row.
    @MainActor
    public static var system: PathMenuEnvironment {
        PathMenuEnvironment(
            defaultAppName: { SystemLookups.defaultAppName(for: $0) },
            obsidianInstalled: SystemLookups.obsidianInstalled,
            hostTerminal: GenesisKit.host?.opensTerminal == true
        )
    }

    @MainActor
    private enum SystemLookups {
        static var names: [String: String?] = [:]
        static let obsidianInstalled: Bool = {
            guard let url = URL(string: "obsidian://open") else { return false }
            return NSWorkspace.shared.urlForApplication(toOpen: url) != nil
        }()

        static func defaultAppName(for file: URL) -> String? {
            let key = file.pathExtension.lowercased()
            if let known = names[key] {
                return known
            }
            let app = DefaultApp.forFile(file)
            let name = app?.bundleIdentifier == Bundle.main.bundleIdentifier ? nil : app?.name
            names[key] = name
            return name
        }
    }
}

/// One item of a path menu.
public struct PathMenuItem: Identifiable {
    public let id: String
    public let title: String
    /// An SF Symbol; empty draws the title alone.
    public let systemImage: String
    /// The configurable verb, nil for an item a host adds itself (a tree row's "Open").
    public let action: PathAction?
    public let destructive: Bool
    public let run: () -> Void

    public init(id: String, title: String, systemImage: String = "", action: PathAction? = nil, destructive: Bool = false, run: @escaping () -> Void) {
        self.id = id
        self.title = title
        self.systemImage = systemImage
        self.action = action
        self.destructive = destructive
        self.run = run
    }
}

/// One line of a path menu.
public enum PathMenuEntry: Identifiable {
    case item(PathMenuItem)
    /// A titled submenu: each folder a collapsed breadcrumb hides, with its own verbs.
    case submenu(id: String, title: String, systemImage: String, entries: [PathMenuEntry])
    case divider(id: String)

    public var id: String {
        switch self {
        case .item(let item): return item.id
        case .submenu(let id, _, _, _): return id
        case .divider(let id): return id
        }
    }

    /// The titles, a divider as "-" and a submenu as "title >": what a test compares.
    public static func outline(_ entries: [PathMenuEntry]) -> [String] {
        entries.map { entry in
            switch entry {
            case .item(let item): return item.title
            case .submenu(_, let title, _, _): return "\(title) >"
            case .divider: return "-"
            }
        }
    }
}

public enum PathMenu {
    /// Verbs of one group sit together; a divider goes between groups, in the order the list gives.
    static func group(_ action: PathAction) -> Int {
        switch action {
        case .showInSidebar, .navigateInSidebar, .searchInFolder: return 0
        case .newFile, .newFolder: return 1
        case .openInFinder, .openInCursor, .openInDefaultApp, .openInObsidian, .openInTerminal: return 2
        case .copyPath: return 3
        case .rename, .duplicate: return 4
        case .trash: return 5
        }
    }

    /// The menu for `url`: `actions` in their order, minus what this path or this host cannot do (a
    /// host verb without its handler, the default app or Obsidian on a folder, Obsidian when it is not
    /// installed, rename, duplicate and trash without `changed`), with a divider between groups.
    @MainActor
    public static func entries(
        for url: URL,
        kind: PathKind,
        actions: [PathAction],
        handlers: PathMenuHandlers,
        environment: PathMenuEnvironment? = nil
    ) -> [PathMenuEntry] {
        let environment = environment ?? .system
        var out: [PathMenuEntry] = []
        var lastGroup: Int?
        for action in actions {
            guard let item = item(action, url: url, kind: kind, handlers: handlers, environment: environment) else { continue }
            let group = group(action)
            if let lastGroup, lastGroup != group {
                out.append(.divider(id: "divider-\(out.count)"))
            }
            lastGroup = group
            out.append(.item(item))
        }
        return out
    }

    @MainActor
    static func item(_ action: PathAction, url: URL, kind: PathKind, handlers: PathMenuHandlers, environment: PathMenuEnvironment) -> PathMenuItem? {
        let path = url.path
        func make(_ title: String, _ symbol: String, destructive: Bool = false, _ run: @escaping () -> Void) -> PathMenuItem {
            PathMenuItem(id: action.rawValue, title: title, systemImage: symbol, action: action, destructive: destructive, run: run)
        }
        switch action {
        case .showInSidebar:
            return handlers.showInSidebar.map { make("Show in Sidebar", "sidebar.left", $0) }
        case .navigateInSidebar:
            return handlers.navigateInSidebar.map { make("Navigate in Sidebar", "arrow.turn.down.right", $0) }
        case .searchInFolder:
            return handlers.searchInFolder.map { make("Search in Folder…", "magnifyingglass", $0) }
        case .newFile:
            return handlers.newFile.map { make("New File…", "doc.badge.plus", $0) }
        case .newFolder:
            return handlers.newFolder.map { make("New Folder…", "folder.badge.plus", $0) }
        case .openInFinder:
            return make(kind == .folder ? "Open in Finder" : "Show in Finder", "folder") { PathOpener.finder(path) }
        case .openInCursor:
            return make("Open in Cursor", "chevron.left.forwardslash.chevron.right") { PathOpener.cursorWorkspace(path, kind: kind) }
        case .openInDefaultApp:
            guard kind == .file, let name = environment.defaultAppName(url) else { return nil }
            return make("Open in \(name)", "arrow.up.forward.app") { PathOpener.open(path) }
        case .openInObsidian:
            guard kind == .file, environment.obsidianInstalled else { return nil }
            return make("Open in Obsidian", "book.closed") { PathOpener.obsidian(path) }
        case .openInTerminal:
            return make(environment.hostTerminal ? "Open in a New cmux Workspace" : "Open in Terminal", "terminal") { PathOpener.terminal(path) }
        case .copyPath:
            return make("Copy Path", "doc.on.doc") { Clipboard.copy(path, what: "path") }
        case .rename:
            guard let changed = handlers.changed else { return nil }
            let guardChange = handlers.guardChange
            return make("Rename…", "pencil") { FileOperations.runRename(url, guardChange: guardChange, changed: changed) }
        case .duplicate:
            guard let changed = handlers.changed else { return nil }
            return make("Duplicate", "plus.square.on.square") { FileOperations.runDuplicate(url, changed: changed) }
        case .trash:
            guard let changed = handlers.changed else { return nil }
            let guardChange = handlers.guardChange
            return make("Move to Trash", "trash", destructive: true) { FileOperations.runTrash(url, guardChange: guardChange, changed: changed) }
        }
    }

    /// The list `PathActionsMenu(path:line:)` has always shown, for a path with no host behind it.
    static func legacyEntries(path: String, line: Int?, hostTerminal: Bool) -> [PathMenuEntry] {
        var out: [PathMenuEntry] = [
            .item(PathMenuItem(id: "finder", title: "Open in Finder") { PathOpener.finder(path) }),
            .item(PathMenuItem(id: "reveal", title: "Reveal in Finder") { PathOpener.reveal(path) }),
            .item(PathMenuItem(id: "cursor", title: "Open in Cursor") { PathOpener.cursor(path, line: line) }),
        ]
        if hostTerminal {
            out.append(.item(PathMenuItem(id: "cmux", title: "Open in a new cmux workspace") { PathOpener.cmux(path) }))
        }
        out.append(.divider(id: "divider-copy"))
        out.append(.item(PathMenuItem(id: "copy", title: "Copy path") { PathOpener.copy(path, what: "path") }))
        out.append(.item(PathMenuItem(id: "copy-tilde", title: "Copy ~ path") { PathOpener.copy(PathLabel.display(path), what: "path") }))
        return out
    }

    // MARK: AppKit

    /// The entries as an NSMenu, for a menu dropped below a control or opened at the pointer.
    @MainActor
    public static func nsMenu(_ entries: [PathMenuEntry]) -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false
        for entry in entries {
            switch entry {
            case .item(let item):
                let menuItem = ClosureMenuItem(item.title, item.run)
                menuItem.image = symbol(item.systemImage)
                menu.addItem(menuItem)
            case let .submenu(_, title, systemImage, children):
                let menuItem = NSMenuItem(title: title, action: nil, keyEquivalent: "")
                menuItem.image = symbol(systemImage)
                menuItem.submenu = nsMenu(children)
                menu.addItem(menuItem)
            case .divider:
                menu.addItem(.separator())
            }
        }
        return menu
    }

    private static func symbol(_ name: String) -> NSImage? {
        name.isEmpty ? nil : NSImage(systemSymbolName: name, accessibilityDescription: nil)
    }

    /// Opens the menu with its top-left corner just below `view` (a control's anchor), else at the
    /// pointer. Returns true when an item was picked.
    @MainActor
    @discardableResult
    public static func popUp(_ entries: [PathMenuEntry], below view: NSView? = nil) -> Bool {
        guard !entries.isEmpty else { return false }
        let menu = nsMenu(entries)
        if let view, view.window != nil {
            let y = view.isFlipped ? view.bounds.maxY + 4 : view.bounds.minY - 4
            return menu.popUp(positioning: nil, at: NSPoint(x: view.bounds.minX, y: y), in: view)
        }
        return menu.popUp(positioning: nil, at: NSEvent.mouseLocation, in: nil)
    }
}

// MARK: - SwiftUI

/// Every action on a path, for a `.contextMenu` on any row that shows one. `init(path:line:)` is the
/// fixed list for a path with no host behind it (the hub's rows); `init(url:kind:actions:handlers:)`
/// is a host's configured verbs (`PathMenu.entries`); `init(entries:)` draws a list built elsewhere.
/// The entries are built when the menu opens, not when the row draws.
public struct PathActionsMenu: View {
    private enum Source {
        case legacy(path: String, line: Int?)
        case configured(url: URL, kind: PathKind, actions: [PathAction], handlers: PathMenuHandlers, leading: [PathMenuItem])
        case entries([PathMenuEntry])
    }

    private let source: Source

    public init(path: String, line: Int? = nil) {
        source = .legacy(path: path, line: line)
    }

    /// `leading`: the host's own items above the verbs, then a divider (a tree file's "Open").
    public init(url: URL, kind: PathKind, actions: [PathAction], handlers: PathMenuHandlers, leading: [PathMenuItem] = []) {
        source = .configured(url: url, kind: kind, actions: actions, handlers: handlers, leading: leading)
    }

    public init(entries: [PathMenuEntry]) {
        source = .entries(entries)
    }

    public var body: some View {
        PathMenuEntriesView(entries: resolved)
    }

    @MainActor
    private var resolved: [PathMenuEntry] {
        switch source {
        case let .legacy(path, line):
            return PathMenu.legacyEntries(path: path, line: line, hostTerminal: GenesisKit.host?.opensTerminal == true)
        case let .configured(url, kind, actions, handlers, leading):
            let verbs = PathMenu.entries(for: url, kind: kind, actions: actions, handlers: handlers)
            guard !leading.isEmpty else { return verbs }
            return leading.map { PathMenuEntry.item($0) } + (verbs.isEmpty ? [] : [.divider(id: "divider-leading")]) + verbs
        case .entries(let entries):
            return entries
        }
    }
}

struct PathMenuEntriesView: View {
    let entries: [PathMenuEntry]

    var body: some View {
        ForEach(entries) { entry in
            switch entry {
            case .item(let item):
                Button(role: item.destructive ? .destructive : nil) {
                    item.run()
                } label: {
                    if item.systemImage.isEmpty {
                        Text(item.title)
                    } else {
                        Label(item.title, systemImage: item.systemImage)
                    }
                }
            case let .submenu(_, title, systemImage, children):
                Menu {
                    PathMenuEntriesView(entries: children)
                } label: {
                    Label(title, systemImage: systemImage)
                }
            case .divider:
                Divider()
            }
        }
    }
}

/// A button that drops a path menu below itself, the way a breadcrumb segment or a "+" button does.
/// Not a SwiftUI `Menu`: a Menu whose label truncates inside a header HStack sent AttributeGraph into a
/// layout cycle and crashed the GenesisTools hub (2026-09-24, `PathLabel`). The entries are built on
/// the click, so a row of these costs nothing until one opens.
public struct PathMenuButton<Label: View>: View {
    private let entries: () -> [PathMenuEntry]
    private let label: Label
    @State private var anchor = PathMenuAnchor()

    public init(entries: @escaping () -> [PathMenuEntry], @ViewBuilder label: () -> Label) {
        self.entries = entries
        self.label = label()
    }

    public var body: some View {
        Button {
            anchor.popUp(entries())
        } label: {
            label
        }
        .background(PathMenuAnchorView(anchor: anchor))
    }
}

/// The AppKit view under a `PathMenuButton`, which the menu hangs from.
@MainActor
final class PathMenuAnchor {
    weak var view: NSView?

    func popUp(_ entries: [PathMenuEntry]) {
        PathMenu.popUp(entries, below: view)
    }
}

private struct PathMenuAnchorView: NSViewRepresentable {
    let anchor: PathMenuAnchor

    func makeNSView(context: Context) -> PathMenuAnchorNSView {
        let view = PathMenuAnchorNSView()
        anchor.view = view
        return view
    }

    func updateNSView(_ view: PathMenuAnchorNSView, context: Context) {
        anchor.view = view
    }
}

/// Takes no clicks and no drags: the button in front keeps them, and in a title bar the strip's zone
/// still gets the empty space around it. It never moves the window either: a transparent view says it
/// may by default, and under a title bar control that turned the first click into a window drag
/// (`TitlebarZoneView.mouseDownCanMoveWindow`).
final class PathMenuAnchorNSView: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var mouseDownCanMoveWindow: Bool { false }
}
