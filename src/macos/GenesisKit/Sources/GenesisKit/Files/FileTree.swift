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

    public var url: URL { URL(fileURLWithPath: id) }
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
    /// Bumped by `reload` and `setRoot`: a listing that started before belongs to the old tree.
    private var generation = 0

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
            chain.append(folder.path)
            folder = folder.deletingLastPathComponent()
        }
        guard folder.path == rootPath else { return }
        for path in chain.reversed() {
            expanded.insert(path)
            if children[path] == nil {
                load(path)
            }
        }
        rebuild()
    }

    /// Forgets every listing and reads the open folders again (the header's reload, after a rename).
    public func reload() {
        children.removeAll()
        generation += 1
        loading.removeAll()
        load(root.path)
        for path in expanded where path.hasPrefix(root.path) {
            load(path)
        }
    }

    /// Reads one folder again (after a rename, duplicate or move to trash inside it).
    public func refresh(_ folder: String) {
        children[folder] = nil
        load(folder)
    }

    private func load(_ path: String) {
        guard !loading.contains(path) else { return }
        loading.insert(path)
        rebuild()
        let generation = generation
        Task { [weak self] in
            let listed = await Task.detached(priority: .userInitiated) { FileTreeListing.entries(of: path) }.value
            guard let self, generation == self.generation else { return }
            self.loading.remove(path)
            self.children[path] = listed
            self.rebuild()
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
        walk(root.path, depth: 0)
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
            return FileTreeEntry(path: item.standardizedFileURL.path, name: item.lastPathComponent, isFolder: folder)
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

    public init(text: Color, secondary: Color, muted: Color, accent: Color, selection: Color, font: @escaping (_ semibold: Bool) -> Font) {
        self.text = text
        self.secondary = secondary
        self.muted = muted
        self.accent = accent
        self.selection = selection
        self.font = font
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

    public init(
        open: @escaping (URL) -> Void,
        setRoot: @escaping (URL) -> Void,
        changed: @escaping (FileChange) -> Void,
        guardChange: ((URL) -> String?)? = nil,
        revision: Int = 0
    ) {
        self.open = open
        self.setRoot = setRoot
        self.changed = changed
        self.guardChange = guardChange
        self.revision = revision
    }
}

public struct FileTreeView: View {
    @ObservedObject var model: FileTreeModel
    let selected: String?
    let style: FileTreeStyle
    let actions: FileTreeActions
    let icon: (FileTreeRow) -> String

    public init(
        model: FileTreeModel,
        selected: String?,
        style: FileTreeStyle,
        actions: FileTreeActions,
        icon: @escaping (FileTreeRow) -> String = FileTreeView.defaultIcon
    ) {
        self.model = model
        self.selected = selected
        self.style = style
        self.actions = actions
        self.icon = icon
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
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(model.rows) { row in
                FileTreeRowView(row: row, selected: row.id == selected, icon: icon(row), style: style, model: model, actions: actions)
                    .equatable()
            }
        }
    }
}

/// One row. Equal while its row value, selection, icon and actions' revision are: nothing else re-renders it.
struct FileTreeRowView: View, Equatable {
    let row: FileTreeRow
    let selected: Bool
    let icon: String
    let style: FileTreeStyle
    let model: FileTreeModel
    let actions: FileTreeActions

    static func == (left: FileTreeRowView, right: FileTreeRowView) -> Bool {
        left.row == right.row && left.selected == right.selected && left.icon == right.icon
            && left.actions.revision == right.actions.revision
    }

    var body: some View {
        Button {
            if row.isFolder {
                model.toggle(row.id)
            } else {
                actions.open(row.url)
            }
        } label: {
            HStack(spacing: 5) {
                if row.isFolder {
                    Image(systemName: row.expanded ? "chevron.down" : "chevron.right")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundColor(style.muted)
                        .frame(width: 8)
                } else {
                    Spacer().frame(width: 8)
                }
                Image(systemName: icon)
                    .font(.system(size: 9))
                    .foregroundColor(row.isFolder ? style.accent : style.muted)
                    .frame(width: 12)
                Text(row.name)
                    .font(style.font(selected))
                    .foregroundColor(selected ? style.accent : style.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if row.loading {
                    ProgressView().controlSize(.mini)
                }
                Spacer(minLength: 0)
            }
            .padding(.leading, 8 + CGFloat(row.depth) * 11)
            .padding(.trailing, 8)
            .padding(.vertical, 3)
            .background(selected ? style.selection : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        // The first click opens or closes the folder at once; the second click of a double-click
        // re-roots the tree there (the open and close in between are undone by the new root).
        .simultaneousGesture(TapGesture(count: 2).onEnded {
            if row.isFolder {
                actions.setRoot(row.url)
            }
        })
        .contextMenu {
            FileItemMenu(
                url: row.url,
                isFolder: row.isFolder,
                open: row.isFolder ? nil : { actions.open(row.url) },
                setRoot: row.isFolder ? { actions.setRoot(row.url) } : nil,
                guardChange: actions.guardChange
            ) { change in
                model.refresh(row.url.deletingLastPathComponent().path)
                actions.changed(change)
            }
        }
        .accessibilityIdentifier(row.isFolder ? "file-tree-folder" : "file-tree-item")
        .accessibilityLabel(row.name)
    }
}
