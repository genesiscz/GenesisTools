//
//  ChangedFilesTree.swift
//  GenesisKit
//
//  The rows of a list of changed files, the way the hub's Changes pane shows them: nested folders where a chain of
//  single-child folders is one row (`src/browser-router/lib`), or flat with one header per directory, and with several
//  repositories one top-level row per root. Ported 2026-10-30 from the hub's `sidebarRows` and `TreeNode`
//  (GenesisTools ReviewWindow.swift) so the hub's list can draw in `GenTreeTable`; a golden test in GenesisTools
//  compares the two on real change lists.
//

import Foundation

/// One repository of a review of several: its row id and the top-level folder name its files' ids start with.
public struct ChangedFilesTreeRoot: Equatable, Sendable {
    /// The id of the root's own row (`collapsed` folds the root by it).
    public let rowID: String
    /// The first path component of every file id in this root; "" for a single root.
    public let prefix: String

    public init(rowID: String, prefix: String) {
        self.rowID = rowID
        self.prefix = prefix
    }
}

/// One visible row of the list.
public struct ChangedFilesTreeRow: Identifiable, Equatable {
    public enum Kind: Equatable {
        /// A root's folder in a review of several repositories.
        case root(index: Int, additions: Int, deletions: Int)
        case directory(name: String, additions: Int, deletions: Int)
        case file(DiffFile)
    }

    /// A file's id, `dir:<path>` for a folder, the root's `rowID` for a root.
    public let id: String
    public let depth: Int
    public let kind: Kind
    /// A root or folder row that is open; false for a file and a folded folder.
    public let expanded: Bool

    public init(id: String, depth: Int, kind: Kind, expanded: Bool) {
        self.id = id
        self.depth = depth
        self.kind = kind
        self.expanded = expanded
    }
}

extension ChangedFilesTreeRow: GenTreeRow {
    public var key: String { id }
    public var isFolder: Bool {
        if case .file = kind { return false }
        return true
    }

    public var name: String {
        switch kind {
        case .root(let index, _, _): return "root \(index + 1)"
        case .directory(let name, _, _): return name
        case .file(let file): return file.name
        }
    }
}

public enum ChangedFilesTree {
    /// The rows in display order. Flat: one header per directory, like GitHub's file list. Tree: nested folders, where
    /// a chain of single-child folders collapses into one row, like Codex's review pane. With several roots, each root
    /// is one top-level row in root order (never folded into its first folder), with its files under it; a root with
    /// no files keeps its row. `collapsed` holds the ids of the folded folders and roots.
    public static func rows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>, roots: [ChangedFilesTreeRoot] = []) -> [ChangedFilesTreeRow] {
        guard roots.count > 1 else {
            return rows(files, tree: tree, collapsed: collapsed, depth: 0, strip: "")
        }

        return roots.enumerated().flatMap { index, root -> [ChangedFilesTreeRow] in
            let own = files.filter { rootIndex(of: $0.id, in: roots) == index }
            let totals = own.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
            let open = !collapsed.contains(root.rowID)
            let row = ChangedFilesTreeRow(id: root.rowID, depth: 0, kind: .root(index: index, additions: totals.0, deletions: totals.1), expanded: open)
            guard open else { return [row] }
            return [row] + rows(own, tree: tree, collapsed: collapsed, depth: 1, strip: root.prefix + "/")
        }
    }

    /// The root a merged file id belongs to: its first path component names the root (one root: always that one).
    public static func rootIndex(of id: String, in roots: [ChangedFilesTreeRoot]) -> Int? {
        if roots.count == 1 {
            return 0
        }
        let head = id.split(separator: "/", maxSplits: 1).first.map(String.init) ?? id
        return roots.firstIndex { $0.prefix == head }
    }

    private final class Node {
        let name: String
        let path: String
        var children: [String: Node] = [:]
        var files: [DiffFile] = []
        /// Every file under this folder, nested ones included: summed once while the tree is built.
        var additions = 0
        var deletions = 0

        init(name: String, path: String) {
            self.name = name
            self.path = path
        }
    }

    /// One root's rows. `strip` is the root's prefix: folder names read without it, ids keep it.
    private static func rows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>, depth: Int, strip: String) -> [ChangedFilesTreeRow] {
        guard tree else {
            let grouped = Dictionary(grouping: files, by: \.directory)
            return grouped.keys.sorted().flatMap { directory -> [ChangedFilesTreeRow] in
                let group = grouped[directory] ?? []
                let name = directory.hasPrefix(strip) ? String(directory.dropFirst(strip.count)) : ""
                let additions = group.reduce(0) { $0 + $1.additions }
                let deletions = group.reduce(0) { $0 + $1.deletions }
                let id = "dir:\(directory)"
                let header = name.isEmpty
                    ? []
                    : [ChangedFilesTreeRow(id: id, depth: depth, kind: .directory(name: name, additions: additions, deletions: deletions), expanded: !collapsed.contains(id))]
                return header + group.map { ChangedFilesTreeRow(id: $0.id, depth: depth, kind: .file($0), expanded: false) }
            }
        }

        let top = Node(name: "", path: "")
        for file in files {
            var node = top
            for part in file.directory.split(separator: "/").map(String.init) where !file.directory.isEmpty {
                let path = node.path.isEmpty ? part : "\(node.path)/\(part)"
                let child = node.children[part] ?? Node(name: part, path: path)
                node.children[part] = child
                node = child
                node.additions += file.additions
                node.deletions += file.deletions
            }
            node.files.append(file)
        }

        var result: [ChangedFilesTreeRow] = []
        func walk(_ node: Node, depth: Int) {
            for child in node.children.values.sorted(by: { $0.name < $1.name }) {
                var folder = child
                var label = child.name
                while folder.files.isEmpty, folder.children.count == 1, let only = folder.children.values.first {
                    folder = only
                    label += "/\(only.name)"
                }
                let id = "dir:\(folder.path)"
                let open = !collapsed.contains(id)
                result.append(ChangedFilesTreeRow(id: id, depth: depth, kind: .directory(name: label, additions: folder.additions, deletions: folder.deletions), expanded: open))
                if open {
                    walk(folder, depth: depth + 1)
                }
            }
            for file in node.files.sorted(by: { $0.name < $1.name }) {
                result.append(ChangedFilesTreeRow(id: file.id, depth: depth, kind: .file(file), expanded: false))
            }
        }
        // Several roots: the walk starts inside the root's own folder, which the caller drew already.
        let start = strip.isEmpty ? top : top.children[String(strip.dropLast())]
        if let start {
            walk(start, depth: depth)
        }
        return result
    }
}
