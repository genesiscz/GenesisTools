//
//  MarkdownDocumentsModel+Paths.swift
//  GenesisKit
//
//  What the window does with a path: the verbs of a path menu (the title bar's breadcrumb, a tree row,
//  a tab, a folder link), how "Show in Sidebar" finds a row, "Search in Folder…", and New File… /
//  New Folder…. The menus themselves are GenesisKit's `PathMenu`, built from the configuration's
//  `folderActions` / `fileActions`; this file supplies the verbs only this window can do.
//

import AppKit
import Foundation

/// What the file sidebar pulses after a reveal.
struct MarkdownSidebarPulse: Equatable {
    enum Target: Equatable {
        /// The row of this path, scrolled into view.
        case row(String)
        /// The sidebar's header, which names the (new) root.
        case header
    }

    var target: Target
    var token: Int
    var at = Date()

    /// The tree's own pulse value for the row (or the header) it lights.
    var tree: FileTreePulse {
        switch target {
        case .row(let path): return FileTreePulse(id: path, token: token, at: at)
        case .header: return FileTreePulse(id: "", token: token, at: at)
        }
    }
}

/// How "Show in Sidebar" reaches an item: the row inside the tree, or a new root.
enum MarkdownSidebarReveal {
    /// The deepest row a reveal opens folders down to. A note five folders below the root would open
    /// five levels of folders and indent its row past half a narrow sidebar, so it re-roots instead.
    static let maxDepth = 4

    enum Plan: Equatable {
        /// The row is in the tree, `depth` folders below the root (0: a child of the root).
        case row(depth: Int)
        /// The item is the root itself.
        case root
        /// Outside the root, or deeper than `maxDepth`: the tree re-roots at this folder (its path).
        case reRoot(String)
    }

    /// The row depth of `item` in a tree rooted at `root`: 0 for a child of the root, nil when it is
    /// not under the root (the root itself included).
    static func depth(of item: URL, under root: URL) -> Int? {
        let rootPath = root.standardizedFileURL.path
        let prefix = rootPath.hasSuffix("/") ? rootPath : rootPath + "/"
        let path = item.standardizedFileURL.path
        guard path.hasPrefix(prefix) else { return nil }
        let below = path.dropFirst(prefix.count).split(separator: "/")
        return below.isEmpty ? nil : below.count - 1
    }

    static func plan(_ item: URL, isFolder: Bool, root: URL, maxDepth: Int = maxDepth) -> Plan {
        let item = item.standardizedFileURL
        if item.path == root.standardizedFileURL.path {
            return .root
        }
        guard let depth = depth(of: item, under: root), depth <= maxDepth else {
            return .reRoot((isFolder ? item : item.deletingLastPathComponent()).path)
        }
        return .row(depth: depth)
    }

    /// Where the sidebar header's New File… / New Folder… create: the folder the tree last revealed,
    /// else the open document's folder when the tree shows it, else the root.
    static func newItemFolder(revealedFolder: URL?, selectedFile: URL?, root: URL) -> URL {
        func shown(_ folder: URL) -> Bool {
            folder.standardizedFileURL.path == root.standardizedFileURL.path || depth(of: folder, under: root) != nil
        }
        if let revealedFolder, shown(revealedFolder) {
            return revealedFolder.standardizedFileURL
        }
        if let folder = selectedFile?.standardizedFileURL.deletingLastPathComponent(), shown(folder) {
            return folder
        }
        return root.standardizedFileURL
    }
}

extension MarkdownDocumentsModel {
    /// The ONE place a single click in the file sidebar opens a file (a row, a search hit, a row menu's
    /// Open): a file the window renders becomes the preview tab (`previewTabs`), or a kept tab for a
    /// double-click (`keep`); anything else goes to the app that owns it.
    func openFromTree(_ url: URL, keep: Bool = false) {
        if FileTree.isReadable(url) {
            if keep {
                open([url])
                if let doc = selected { self.keep(doc) }
            } else {
                openPreview(url)
            }
        } else {
            NSWorkspace.shared.open(url)
        }
    }

    /// "Navigate in Sidebar": the tree re-roots at the folder (a file: its folder) and its header pulses.
    func navigateInSidebar(_ item: URL) {
        revealInSidebar(item, navigate: true)
    }

    /// "Search in Folder…": the sidebar's text search, limited to `folder`, shown as a removable chip.
    func searchInFolder(_ folder: URL) {
        treeSearchScope = folder.standardizedFileURL
        openTreeSearch()
    }

    /// New File… / New Folder… in `folder`: the name prompt, then `didCreate`.
    func createItem(_ kind: PathKind, in folder: URL) {
        FileOperations.runCreate(kind, in: folder.standardizedFileURL) { [weak self] url in
            self?.didCreate(url)
        }
    }

    /// A new file opens as a tab; either one is revealed in the tree, which reads its folders again. A
    /// tree that follows the open document is pinned first, or the new tab would move it.
    func didCreate(_ url: URL) {
        if filesRoot.isEmpty {
            filesRoot = filesRootURL.standardizedFileURL.path
        }
        applyFileChange(.created(url))
        NotificationCenter.default.post(name: .markdownTabFileChanged, object: self)
        revealInSidebar(url)
    }

    /// The verbs only this window can do, for a path menu on `url`.
    func pathHandlers(for url: URL, kind: PathKind) -> PathMenuHandlers {
        let url = url.standardizedFileURL
        let folderOnly = kind == .folder
        return PathMenuHandlers(
            showInSidebar: { [weak self] in self?.revealInSidebar(url) },
            navigateInSidebar: { [weak self] in self?.navigateInSidebar(url) },
            searchInFolder: folderOnly ? { [weak self] in self?.searchInFolder(url) } : nil,
            newFile: folderOnly ? { [weak self] in self?.createItem(.file, in: url) } : nil,
            newFolder: folderOnly ? { [weak self] in self?.createItem(.folder, in: url) } : nil,
            changed: { [weak self] change in
                guard let self else { return }
                self.applyFileChange(change)
                // The tree reads its folders again, wherever the menu was.
                NotificationCenter.default.post(name: .markdownTabFileChanged, object: self)
            },
            guardChange: { [weak self] in self?.unsavedReason($0) }
        )
    }

    /// The configured actions for `kind` (`GenesisKitMarkdownConfiguration.folderActions` / `.fileActions`).
    func pathActions(for kind: PathKind) -> [PathAction] {
        let config = GenesisKitMarkdownConfiguration.shared
        return kind == .folder ? config.folderActions : config.fileActions
    }

    /// The whole menu for `url`, built now (a click on a breadcrumb segment, a folder link).
    func pathMenu(for url: URL, kind: PathKind) -> [PathMenuEntry] {
        PathMenu.entries(for: url, kind: kind, actions: pathActions(for: kind), handlers: pathHandlers(for: url, kind: kind))
    }
}
