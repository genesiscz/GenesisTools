//
//  FileTree.swift
//
//  A folder tree for a sidebar (Genesis's markdown window first), shared through GenesisKit.
//
//  Why it is built this way (Genesis, 2026-10-01: "scrolling up to /Users/Martin lags, folding takes a
//  second"): the old tree read a folder inside a view body, on the main thread, and wrote the result
//  into a published dictionary during that body; and each expanded folder drew its whole subtree inside
//  one lazy element, so an expanded home folder was one huge eager view. Here:
//
//  - the visible tree is ONE flat array of row values (`rows`), rebuilt only when a folder opens,
//    closes or is read, and drawn by a `LazyVStack` that builds only the rows on screen;
//  - a folder is read off the main thread (`Task.detached`), once, and then served from the cache;
//  - a row is an `Equatable` value view: it takes its row and whether it is selected, never a model,
//    so a change elsewhere (a keystroke in the editor) re-renders no row.
//

import AppKit
import SwiftUI

/// One visible line of the tree.
public struct FileTreeRow: Identifiable, Equatable, Sendable {
    /// The absolute path.
    public let id: String
    public let name: String
    public let isFolder: Bool
    public let depth: Int
    public var expanded = false
    public var loading = false
    /// The row's identity in the lists: the path with its hash taken once.
    public let key: FileTreeRowKey

    public init(id: String, name: String, isFolder: Bool, depth: Int, expanded: Bool = false, loading: Bool = false) {
        self.id = id
        self.name = name
        self.isFolder = isFolder
        self.depth = depth
        self.expanded = expanded
        self.loading = loading
        self.key = FileTreeRowKey(id)
    }

    public var url: URL { URL(fileURLWithPath: id) }

    /// The name follows from the path, so the key stands in for both.
    public static func == (left: FileTreeRow, right: FileTreeRow) -> Bool {
        left.key == right.key && left.isFolder == right.isFolder && left.depth == right.depth
            && left.expanded == right.expanded && left.loading == right.loading
    }
}

/// A path as a list identity, hashed once. SwiftUI hashes and compares a lazy list's ids on every scroll frame, and a
/// non-ASCII `String` ("ČEZ") is normalized to NFC on each hash and each comparison: the profile of a tree scroll in
/// the installed viewer had that normalization as its largest piece of app-side work (2026-10-15). Equal keys have
/// equal bytes. A listing path is already one form (`standardizedFileURL.path`, then `nativeUTF8`). A selected
/// document path can be the other Unicode form of that file, so `init(selection:)` applies the listing's form first.
public struct FileTreeRowKey: Hashable, Sendable {
    public let path: String
    private let hash: Int

    public init(_ path: String) {
        var path = path
        path.makeContiguousUTF8()
        var hasher = Hasher()
        path.utf8.withContiguousStorageIfAvailable { hasher.combine(bytes: UnsafeRawBufferPointer($0)) }
        self.path = path
        self.hash = hasher.finalize()
    }

    /// The selected document's path, in the form a listing stores (`standardizedFileURL.path`, native).
    public init(selection path: String) {
        self.init(URL(fileURLWithPath: path).standardizedFileURL.path.nativeUTF8)
    }

    public static func == (left: FileTreeRowKey, right: FileTreeRowKey) -> Bool {
        guard left.hash == right.hash else { return false }
        return left.path.utf8.withContiguousStorageIfAvailable { l in
            right.path.utf8.withContiguousStorageIfAvailable { r in l.elementsEqual(r) }
        }.flatMap { $0 } ?? left.path.utf8.elementsEqual(right.path.utf8)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(hash)
    }
}

/// One directory entry.
public struct FileTreeEntry: Equatable, Sendable {
    public let path: String
    public let name: String
    public let isFolder: Bool
}

@MainActor
public final class FileTreeModel: ObservableObject {
    @Published public private(set) var rows: [FileTreeRow] = []
    @Published public private(set) var root: URL
    private var expanded = Set<String>()
    private var children: [String: [FileTreeEntry]] = [:]
    private var loading = Set<String>()
    /// Folders refreshed while their read was running: that read may predate the change.
    private var stale = Set<String>()
    /// Bumped by `reload` and `setRoot`: a listing that started before belongs to the old tree.
    private var generation = 0
    /// Folders being read again quietly (`relist`), and those that changed again while that read ran.
    private var relisting = Set<String>()
    private var relistAgain = Set<String>()
    /// Bumped by `refresh`. A quiet read applies its snapshot only when this is still the count it started with.
    private var relistEpoch: [String: Int] = [:]
    /// One FSEvents stream over the root. A folder another app writes into (an agent session saving its notes) is
    /// read again, so the tree lists what is on disk without the header's reload.
    private var watcher: DirectoryWatcher?
    /// Reduce Motion as the last clicked row saw it (system, app and widget settings), so a listing that lands later
    /// opens its folder the same way the click did.
    var reduceMotion = false
    /// The directory read. A test holds the first snapshot so a disk event can land before that snapshot is published.
    var listing: @Sendable (String) -> [FileTreeEntry] = { FileTreeListing.entries(of: $0) }
    /// Off in a test that drives `diskChanged` itself: the real stream's own events would re-read the folder and hide
    /// whether the call under test did.
    var watchesDisk = true

    /// Reads nothing yet: the host names the real root with `setRoot`.
    public init(root: URL) {
        self.root = root.standardizedFileURL
    }

    public func isExpanded(_ path: String) -> Bool {
        expanded.contains(path)
    }

    public func setRoot(_ url: URL) {
        let next = url.standardizedFileURL
        guard next.path != root.path || (children[next.path] == nil && !loading.contains(next.path)) else { return }
        root = next
        generation += 1
        loading.removeAll()
        stale.removeAll()
        watch(next.path)
        rebuild()
        load(next.path)
        // An open folder whose read the new generation dropped would stay open and empty: read it again.
        for path in expanded where path.hasPrefix(next.path + "/") && children[path] == nil {
            load(path)
        }
    }

    /// A folder row's click: open it (reading it first when it is new), or close it.
    public func toggle(_ path: String) {
        if expanded.remove(path) == nil {
            expanded.insert(path)
            if children[path] == nil {
                load(path)
            }
        }
        rebuild()
    }

    /// Opens every folder between the root and `file`, so the file's row is in the tree.
    public func reveal(_ file: URL) {
        let rootPath = root.path
        var folder = file.standardizedFileURL.deletingLastPathComponent()
        var chain: [String] = []
        while folder.path.hasPrefix(rootPath), folder.path != rootPath {
            chain.append(folder.path.nativeUTF8)
            folder = folder.deletingLastPathComponent()
        }
        guard folder.path == rootPath else { return }
        // Every tab selection reveals its note, and a rebuild walks every open folder's rows: only a folder that
        // opens now changes the tree (a read that lands rebuilds by itself).
        var opened = false
        for path in chain.reversed() {
            if expanded.insert(path).inserted { opened = true }
            if children[path] == nil {
                load(path)
            }
        }
        if opened {
            rebuild()
        }
        // A note another app wrote after its folder was read is not in that listing, so the reveal found no row and
        // did nothing (2026-10-15: notes saved at 05:30:49, "Show in Sidebar" on one at 05:33:14). Such a folder is
        // read again; the row arrives with the new listing.
        let path = file.standardizedFileURL.path
        for (parent, child) in zip([rootPath] + chain.reversed(), chain.reversed() + [path]) {
            if let listed = children[parent], !listed.contains(where: { $0.path == child }),
               FileManager.default.fileExists(atPath: child) {
                relist(parent)
            }
        }
    }

    /// Forgets every listing and reads the open folders again (the header's reload, after a rename).
    public func reload() {
        children.removeAll()
        generation += 1
        loading.removeAll()
        stale.removeAll()
        load(root.path)
        for path in expanded where path.hasPrefix(root.path + "/") {
            load(path)
        }
    }

    /// Reads one folder again (after a rename, duplicate or move to trash inside it). A quiet read already
    /// running is dropped: its snapshot predates this, and it must not replace the listing this read returns.
    public func refresh(_ folder: String) {
        children[folder] = nil
        relistEpoch[folder.nativeUTF8, default: 0] += 1
        relistAgain.remove(folder.nativeUTF8)
        if loading.contains(folder) {
            stale.insert(folder)
        }
        load(folder)
    }

    private func watch(_ rootPath: String) {
        watcher?.stop()
        watcher = nil
        guard watchesDisk else { return }
        // Folder events: one path per changed folder and batch, so a build inside the root stays cheap here.
        watcher = DirectoryWatcher(paths: [rootPath], latency: 0.4, fileEvents: false) { [weak self] folders in
            MainActor.assumeIsolated { self?.diskChanged(folders) }
        }
    }

    /// One FSEvents batch of changed folders: each one the tree has read is read again. Most are a note saved in
    /// place; its folder's listing comes back equal and the rows stay as they are. A folder whose first read is
    /// still in flight is marked stale: that read's snapshot may predate the event, and dropping it leaves the
    /// tree on the old listing (`refresh` already does this).
    func diskChanged(_ folders: [String]) {
        // Folder events name the folder with a trailing "/". Keys in `children` and `loading` are native strings.
        let paths = Set(folders.map { raw -> String in
            let trimmed = raw.count > 1 && raw.hasSuffix("/") ? String(raw.dropLast()) : raw
            return trimmed.nativeUTF8
        })
        for folder in paths {
            if loading.contains(folder) {
                stale.insert(folder)
            } else if children[folder] != nil {
                relist(folder)
            }
        }
    }

    /// Reads a folder the tree already lists again, without the loading spinner, and rebuilds only when the listing
    /// changed.
    private func relist(_ path: String) {
        let path = path.nativeUTF8
        guard children[path] != nil, !loading.contains(path) else { return }
        guard relisting.insert(path).inserted else {
            relistAgain.insert(path)
            return
        }
        let generation = generation
        let epoch = relistEpoch[path, default: 0]
        let read = listing
        Task { [weak self] in
            let listed = await Task.detached(priority: .utility) { read(path) }.value
            guard let self else { return }
            self.relisting.remove(path)
            guard generation == self.generation, self.relistEpoch[path, default: 0] == epoch else { return }
            if let old = self.children[path], old != listed {
                self.children[path] = listed
                self.rebuild()
            }
            if self.relistAgain.remove(path) != nil {
                self.relist(path)
            }
        }
    }

    private func load(_ path: String) {
        let path = path.nativeUTF8
        guard !loading.contains(path) else { return }
        loading.insert(path)
        rebuild()
        let generation = generation
        let read = listing
        Task { [weak self] in
            let listed = await Task.detached(priority: .userInitiated) { read(path) }.value
            guard let self, generation == self.generation else { return }
            self.loading.remove(path)
            if self.stale.remove(path) != nil {
                self.load(path)
                return
            }
            self.children[path] = listed
            // A folder the user opened grows by its rows like the click did; the root's first listing just appears.
            let opened = self.expanded.contains(path)
            GenMotion.perform(expanding: true, reduceMotion: GenMotion.systemReduceMotion || reduceMotion || !opened) {
                self.rebuild()
            }
        }
    }

    /// The flat list of what is visible: depth-first, an open folder's children right under it.
    private func rebuild() {
        var out: [FileTreeRow] = []
        func walk(_ path: String, depth: Int) {
            for entry in children[path] ?? [] {
                let open = entry.isFolder && expanded.contains(entry.path)
                out.append(FileTreeRow(
                    id: entry.path,
                    name: entry.name,
                    isFolder: entry.isFolder,
                    depth: depth,
                    expanded: open,
                    loading: open && loading.contains(entry.path)
                ))
                if open {
                    walk(entry.path, depth: depth + 1)
                }
            }
        }
        walk(root.path.nativeUTF8, depth: 0)
        if out != rows {
            rows = out
        }
    }
}

public enum FileTreeListing {
    /// One directory, folders first, then files, each in Finder's order; hidden files skipped.
    /// Never throws: an unreadable folder lists as empty.
    public static func entries(of path: String) -> [FileTreeEntry] {
        let url = URL(fileURLWithPath: path)
        let keys: [URLResourceKey] = [.isDirectoryKey, .isPackageKey]
        guard let items = try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles]) else {
            return []
        }
        let entries = items.map { item -> FileTreeEntry in
            let values = try? item.resourceValues(forKeys: Set(keys))
            // A package (an .app, a .bundle) is one item, as in Finder.
            let folder = (values?.isDirectory ?? false) && !(values?.isPackage ?? false)
            // Native strings: every row, the open-folder set and the git marks compare and hash these (`nativeUTF8`).
            return FileTreeEntry(
                path: item.standardizedFileURL.path.nativeUTF8, name: item.lastPathComponent.nativeUTF8, isFolder: folder
            )
        }
        return entries.sorted { left, right in
            if left.isFolder != right.isFolder {
                return left.isFolder
            }
            return left.name.localizedStandardCompare(right.name) == .orderedAscending
        }
    }
}

/// The host's colours and type, so the tree matches the window it sits in.
public struct FileTreeStyle {
    public var text: Color
    public var secondary: Color
    public var muted: Color
    public var accent: Color
    public var selection: Color
    public var font: (_ semibold: Bool) -> Font
    /// The glyphs, indent and row padding around the text. A host whose `font` grows passes
    /// `.scaled(toText:)` with the same size, so the rows grow with it.
    public var metrics: FileTreeMetrics

    public init(
        text: Color,
        secondary: Color,
        muted: Color,
        accent: Color,
        selection: Color,
        font: @escaping (_ semibold: Bool) -> Font,
        metrics: FileTreeMetrics = .compact
    ) {
        self.text = text
        self.secondary = secondary
        self.muted = muted
        self.accent = accent
        self.selection = selection
        self.font = font
        self.metrics = metrics
    }
}

/// The sizes of a row around its text: the chevron, the icon, the indent per level and the padding.
public struct FileTreeMetrics: Equatable, Sendable {
    public var chevron: CGFloat = 7
    public var chevronWidth: CGFloat = 8
    public var icon: CGFloat = 9
    public var iconWidth: CGFloat = 12
    public var indent: CGFloat = 11
    public var verticalPadding: CGFloat = 3
    public var spacing: CGFloat = 5

    /// The sizes drawn for 9.5 pt text, the tree's first look and the hub's.
    public static let compact = FileTreeMetrics()
    static let compactText: CGFloat = 9.5

    /// The gap between a row's edge and its content, on each side. It does not grow with the text.
    static let rowInset: CGFloat = 8

    /// What a row spends in width besides its two insets and its name, at these metrics: the indent for
    /// `depth`, the chevron slot, the icon and the three gaps of the row's HStack (after the chevron,
    /// after the icon, and before the trailing Spacer, which HStack keeps a gap before even at
    /// minLength 0). A host that fits its text to the row's width reads it from `scaled(toText: 1)`,
    /// where it is the width per point of text.
    func widthBesidesName(depth: Int) -> CGFloat {
        CGFloat(depth) * indent + chevronWidth + iconWidth + 3 * spacing
    }

    /// The room a git mark takes at a row's end: its letter (0.62 em in the monospaced face at the icon's size)
    /// and the gap before it.
    var gitMarkWidth: CGFloat { spacing + icon * 0.62 }

    /// Every size in proportion to a text size, so the row height, the icons and the indent follow the
    /// font. `compact` at 9.5 pt.
    public static func scaled(toText size: CGFloat) -> FileTreeMetrics {
        let ratio = max(size, 1) / compactText
        let base = FileTreeMetrics.compact
        return FileTreeMetrics(
            chevron: base.chevron * ratio,
            chevronWidth: base.chevronWidth * ratio,
            icon: base.icon * ratio,
            iconWidth: base.iconWidth * ratio,
            indent: base.indent * ratio,
            verticalPadding: base.verticalPadding * ratio,
            spacing: base.spacing * ratio
        )
    }
}

/// A row (or a header) to light up once: "Show in Sidebar" pulses the row it scrolled to. `at` keeps a
/// row that scrolls into view later from replaying it.
public struct FileTreePulse: Equatable, Sendable {
    public var id: String
    public var token: Int
    public var at: Date

    public init(id: String, token: Int, at: Date = Date()) {
        self.id = id
        self.token = token
        self.at = at
    }

    /// Plays only this soon after it was asked for.
    public static let lifetime: TimeInterval = 2

    public func isFresh(now: Date = Date()) -> Bool {
        now.timeIntervalSince(at) < Self.lifetime
    }
}

/// A host's own row menu: its configured verbs (`PathMenu`) instead of `FileItemMenu`.
public struct FileTreeMenu {
    public var folderActions: [PathAction]
    public var fileActions: [PathAction]
    /// The host's verbs for one row: its sidebar, its search, a new file in a folder, what a change did.
    public var handlers: (URL, PathKind) -> PathMenuHandlers

    public init(folderActions: [PathAction], fileActions: [PathAction], handlers: @escaping (URL, PathKind) -> PathMenuHandlers) {
        self.folderActions = folderActions
        self.fileActions = fileActions
        self.handlers = handlers
    }
}

/// What the host does with the tree: open a file, re-root, and the file menu's actions.
public struct FileTreeActions {
    public var open: (URL) -> Void
    /// A double-click on a folder, and "Show as Root" in its menu.
    public var setRoot: (URL) -> Void
    /// The rename, trash and duplicate results: the host updates its tabs (`FileItemMenu`).
    public var changed: (FileChange) -> Void
    /// A reason to refuse a rename or a move to the Trash (a tab with unsaved edits), or nil.
    public var guardChange: ((URL) -> String?)?
    /// Bump it whenever the closures would act differently (the hub: whether Changes is open). A row's
    /// equality cannot compare closures, so without it an unchanged row keeps the old ones.
    public var revision: Int
    /// The host's own row menu; nil keeps Finder's `FileItemMenu`.
    public var menu: FileTreeMenu?
    /// A double-click on a file, after the single click's `open`: a host with preview tabs keeps the tab.
    public var openKept: ((URL) -> Void)?

    public init(
        open: @escaping (URL) -> Void,
        setRoot: @escaping (URL) -> Void,
        changed: @escaping (FileChange) -> Void,
        guardChange: ((URL) -> String?)? = nil,
        revision: Int = 0,
        menu: FileTreeMenu? = nil,
        openKept: ((URL) -> Void)? = nil
    ) {
        self.open = open
        self.setRoot = setRoot
        self.changed = changed
        self.guardChange = guardChange
        self.revision = revision
        self.menu = menu
        self.openKept = openKept
    }
}

public struct FileTreeView: View {
    @ObservedObject var model: FileTreeModel
    let selected: String?
    let style: FileTreeStyle
    let actions: FileTreeActions
    let pulse: FileTreePulse?
    let icon: (FileTreeRow) -> String
    /// Git marks (M, A, U, D on files, a dot on folders that hold changes); nil shows none.
    let git: GitTreeDecorations?
    /// Only the changed files and the folders that hold them (with `git`).
    let changedOnly: Bool

    public init(
        model: FileTreeModel,
        selected: String?,
        style: FileTreeStyle,
        actions: FileTreeActions,
        pulse: FileTreePulse? = nil,
        git: GitTreeDecorations? = nil,
        changedOnly: Bool = false,
        icon: @escaping (FileTreeRow) -> String = FileTreeView.defaultIcon
    ) {
        self.model = model
        self.selected = selected
        self.style = style
        self.actions = actions
        self.pulse = pulse
        self.git = git
        self.changedOnly = changedOnly
        self.icon = icon
    }

    /// The rows `changedOnly` leaves: a changed file, or a folder that holds one.
    public static func changedRows(_ rows: [FileTreeRow], _ git: GitTreeDecorations) -> [FileTreeRow] {
        rows.filter { git.change(for: $0.id) != nil || git.holdsChanges($0.id) }
    }

    public static func defaultIcon(_ row: FileTreeRow) -> String {
        if row.isFolder {
            return row.expanded ? "folder.fill" : "folder"
        }
        switch (row.name as NSString).pathExtension.lowercased() {
        case "md", "markdown", "mdx": return "doc.text"
        case "canvas": return "rectangle.3.group"
        case "base", "csv": return "tablecells"
        case "json", "yaml", "yml", "toml": return "curlybraces"
        case "png", "jpg", "jpeg", "gif", "webp", "heic", "svg": return "photo"
        default: return "doc"
        }
    }

    public var body: some View {
        let _ = RenderProbe.hit("tree.view")
        let selectedKey = selected.map { FileTreeRowKey(selection: $0) }
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(changedOnly && git != nil ? Self.changedRows(model.rows, git ?? .none) : model.rows, id: \.key) { row in
                FileTreeRowView(
                    row: row, selected: row.key == selectedKey, icon: icon(row), style: style, model: model, actions: actions,
                    pulse: pulse?.id == row.id ? pulse : nil,
                    change: git?.change(for: row.id), holdsChanges: git?.holdsChanges(row.id) ?? false,
                    lines: git?.count(for: row.id)
                )
                .equatable()
            }
        }
    }
}

/// One row. Equal while its row value, selection, icon, visual style, pulse and actions' revision are.
struct FileTreeRowView: View, Equatable {
    let row: FileTreeRow
    let selected: Bool
    let icon: String
    let style: FileTreeStyle
    let model: FileTreeModel
    let actions: FileTreeActions
    /// Only the row it names gets one; every other row gets nil, so a pulse re-renders one row.
    var pulse: FileTreePulse?
    /// The file's git change (its letter at the row's end, its name tinted), nil for none.
    var change: GitChangeKind?
    /// A folder that holds changes: a dot at the row's end.
    var holdsChanges = false
    /// Lines added and removed against HEAD (a folder's summed), drawn before the mark.
    var lines: GitLineCount?
    @GenReduceMotion private var reduceMotion
    /// Resolve when the row is made: a font closure may capture mutable host settings, so
    /// asking both old and new closures during equality would lose the previous font.
    private let resolvedFont: Font

    init(row: FileTreeRow, selected: Bool, icon: String, style: FileTreeStyle,
         model: FileTreeModel, actions: FileTreeActions, pulse: FileTreePulse? = nil,
         change: GitChangeKind? = nil, holdsChanges: Bool = false, lines: GitLineCount? = nil) {
        // Counts how often a list builds its rows, not how often a row draws (`tree.row`): a list that walks its
        // `ForEach` on every unrelated publish builds every visible row again even when no row then draws.
        RenderProbe.hit("tree.rowItem")
        self.row = row
        self.selected = selected
        self.icon = icon
        self.style = style
        self.model = model
        self.actions = actions
        self.pulse = pulse
        self.change = change
        self.holdsChanges = holdsChanges
        self.lines = lines
        resolvedFont = style.font(selected)
    }

    static func == (left: FileTreeRowView, right: FileTreeRowView) -> Bool {
        left.row == right.row && left.selected == right.selected && left.icon == right.icon
            && left.style.metrics == right.style.metrics && left.pulse == right.pulse
            && left.style.text == right.style.text && left.style.secondary == right.style.secondary
            && left.style.muted == right.style.muted && left.style.accent == right.style.accent
            && left.style.selection == right.style.selection && left.resolvedFont == right.resolvedFont
            && left.actions.revision == right.actions.revision
            && left.change == right.change && left.holdsChanges == right.holdsChanges && left.lines == right.lines
    }

    var body: some View {
        let _ = RenderProbe.hit("tree.row")
        let metrics = style.metrics
        Button {
            if row.isFolder {
                model.reduceMotion = reduceMotion
                GenMotion.perform(expanding: !row.expanded, reduceMotion: reduceMotion) { model.toggle(row.id) }
            } else {
                actions.open(row.url)
            }
        } label: {
            HStack(spacing: metrics.spacing) {
                if row.isFolder {
                    Image(systemName: row.expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: metrics.chevron, weight: .bold))
                        .foregroundColor(style.muted)
                        .frame(width: metrics.chevronWidth)
                } else {
                    Spacer().frame(width: metrics.chevronWidth)
                }
                Image(systemName: icon)
                    .font(.system(size: metrics.icon))
                    .foregroundColor(row.isFolder ? style.accent : style.muted)
                    .frame(width: metrics.iconWidth)
                Text(row.name)
                    .font(resolvedFont)
                    .foregroundColor(selected ? style.accent : (change?.color ?? style.secondary))
                    .lineLimit(1)
                    .truncationMode(.middle)
                if row.loading {
                    ProgressView().controlSize(.mini)
                }
                Spacer(minLength: 0)
                if let lines, lines.additions + lines.deletions > 0 {
                    GitLineCounts(additions: lines.additions, deletions: lines.deletions, size: max(9, metrics.icon - 2))
                }
                if let change {
                    GitChangeMark(change, size: metrics.icon)
                        .instantTooltip("Git: \(change.word)")
                } else if holdsChanges {
                    Circle()
                        .fill(GitChangeKind.modified.color.opacity(0.8))
                        .frame(width: metrics.icon * 0.5, height: metrics.icon * 0.5)
                        .instantTooltip("Holds changed files")
                }
            }
            .padding(.leading, FileTreeMetrics.rowInset + CGFloat(row.depth) * metrics.indent)
            .padding(.trailing, FileTreeMetrics.rowInset)
            .padding(.vertical, metrics.verticalPadding)
            .background(selected ? style.selection : Color.clear)
            .fileTreePulse(pulse, color: style.accent)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        // The first click opens or closes the folder at once; the second click of a double-click
        // re-roots the tree there (the open and close in between are undone by the new root). On a file
        // the first click opened it already; the second keeps it (`openKept`).
        .simultaneousGesture(TapGesture(count: 2).onEnded {
            if row.isFolder {
                actions.setRoot(row.url)
            } else {
                actions.openKept?(row.url)
            }
        })
        .contextMenu {
            if let menu = actions.menu {
                configuredMenu(menu)
            } else {
                FileItemMenu(
                    url: row.url,
                    isFolder: row.isFolder,
                    open: row.isFolder ? nil : { actions.open(row.url) },
                    setRoot: row.isFolder ? { actions.setRoot(row.url) } : nil,
                    guardChange: actions.guardChange
                ) { change in
                    refresh(after: change)
                    actions.changed(change)
                }
            }
        }
        .accessibilityIdentifier(row.isFolder ? "file-tree-folder" : "file-tree-item")
        .accessibilityLabel(row.name)
    }

    /// The host's verbs; a file gets "Open" above them, as in Finder. A change reads the folder it
    /// happened in again before the host hears of it.
    private func configuredMenu(_ menu: FileTreeMenu) -> some View {
        let kind: PathKind = row.isFolder ? .folder : .file
        var handlers = menu.handlers(row.url, kind)
        let hostChanged = handlers.changed
        let model = model
        let row = row
        handlers.changed = hostChanged.map { changed in
            { change in
                FileTreeRowView.refresh(model, row: row, after: change)
                changed(change)
            }
        }
        let open = actions.open
        let leading = row.isFolder ? [] : [PathMenuItem(id: "open", title: "Open", systemImage: "doc.text") { open(row.url) }]
        return PathActionsMenu(
            url: row.url, kind: kind, actions: row.isFolder ? menu.folderActions : menu.fileActions,
            handlers: handlers, leading: leading
        )
    }

    private func refresh(after change: FileChange) {
        FileTreeRowView.refresh(model, row: row, after: change)
    }

    /// The folder a change happened in: the row's own folder, or the folder a new item went into.
    static func refresh(_ model: FileTreeModel, row: FileTreeRow, after change: FileChange) {
        if case .created(let url) = change {
            model.refresh(url.deletingLastPathComponent().path)
        } else {
            model.refresh(row.url.deletingLastPathComponent().path)
        }
    }
}

extension View {
    /// Lights the view up once per new `pulse` token: an accent fill and outline that rise fast and fade,
    /// twice, after a short wait for a scroll to land; once and slower with Reduce Motion. A new token
    /// cuts the old one off.
    public func fileTreePulse(_ pulse: FileTreePulse?, color: Color, cornerRadius: CGFloat = 5) -> some View {
        modifier(FileTreePulseModifier(pulse: pulse, color: color, cornerRadius: cornerRadius))
    }
}

/// Only a row with a pulse carries the light, its state and its task. Every row scrolled into view started a task
/// and drew two empty shapes before: 300 scroll steps took 612 and 790 main-thread passes, 351 and 347 without
/// (2026-10-15, MarkdownTreeLagBenchTests with MARKDOWN_TREE_BENCH_SCROLLS=300).
private struct FileTreePulseModifier: ViewModifier {
    let pulse: FileTreePulse?
    let color: Color
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        if pulse != nil {
            content.modifier(FileTreePulseLight(pulse: pulse, color: color, cornerRadius: cornerRadius))
        } else {
            content
        }
    }
}

private struct FileTreePulseLight: ViewModifier {
    let pulse: FileTreePulse?
    let color: Color
    let cornerRadius: CGFloat
    @GenReduceMotion private var reduceMotion
    @State private var level: Double = 0

    func body(content: Content) -> some View {
        content
            .background {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(color.opacity(0.26 * level))
                    .allowsHitTesting(false)
            }
            .overlay {
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .strokeBorder(color.opacity(0.9 * level), lineWidth: 1)
                    .allowsHitTesting(false)
            }
            .task(id: pulse?.token) { await play() }
    }

    private func play() async {
        guard let pulse, pulse.isFresh() else {
            level = 0
            return
        }

        let beats = reduceMotion ? 1 : 2
        // The scroll to the row takes about 0.3 s: the light comes on where the eye lands.
        try? await Task.sleep(for: .milliseconds(reduceMotion ? 0 : 220))
        for _ in 0..<beats {
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.14)) { level = 1 }
            try? await Task.sleep(for: .milliseconds(reduceMotion ? 900 : 300))
            guard !Task.isCancelled else { return }
            withAnimation(.easeIn(duration: reduceMotion ? 0.35 : 0.42)) { level = 0 }
            try? await Task.sleep(for: .milliseconds(460))
        }
    }
}
