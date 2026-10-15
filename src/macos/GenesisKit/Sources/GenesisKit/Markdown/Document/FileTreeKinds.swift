//
//  FileTreeKinds.swift
//  GenesisKit
//
//  The filesystem behind the markdown window's file sidebar. Walking a tree
//  from a home directory is how you pin hundreds of thousands of vnodes, so
//  this lists ONE directory at a time, when a folder is actually expanded.
//

import Foundation

/// One row of the markdown window's file sidebar: a folder (its children filled when it is expanded) or a file.
struct MarkdownTreeNode: Identifiable, Equatable {
    enum Kind: String {
        case markdown
        case canvas
        case base
        case file
        case folder
    }

    var id: String
    var name: String
    var kind: Kind
    var children: [MarkdownTreeNode] = []

    var isFolder: Bool { kind == .folder }
}

enum FileTree {
    /// Text files the markdown window can render itself. Anything else is
    /// handed to the system rather than opened as a tab.
    static let readableExtensions: Set<String> = [
        "md", "markdown", "mdx", "txt", "text", "canvas", "base",
        "json", "yaml", "yml", "toml", "csv", "log",
    ]

    static func kind(for url: URL, isDirectory: Bool) -> MarkdownTreeNode.Kind {
        if isDirectory { return .folder }
        switch url.pathExtension.lowercased() {
        case "md", "markdown", "mdx": return .markdown
        case "canvas": return .canvas
        case "base": return .base
        default: return .file
        }
    }

    /// Also every source file the viewer highlights (`DocumentPreview.codeLanguages`), so a click,
    /// a search hit or a drop opens `Report.ts` as a tab rather than in another app.
    static func isReadable(_ url: URL) -> Bool {
        let ext = url.pathExtension.lowercased()
        return readableExtensions.contains(ext) || DocumentPreview.codeLanguages[ext] != nil
    }

    /// One directory's contents, folders first then files, each alphabetical.
    /// Children are left empty: they are filled by another call when the folder
    /// is expanded. An unreadable directory yields nothing rather than throwing —
    /// a sidebar must not fail the window.
    static func children(of directory: URL, includeHidden: Bool = false) -> [MarkdownTreeNode] {
        let contents = (try? FileManager.default.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: includeHidden ? [] : [.skipsHiddenFiles]
        )) ?? []

        var folders: [MarkdownTreeNode] = []
        var files: [MarkdownTreeNode] = []
        for url in contents {
            let isDirectory = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            let node = MarkdownTreeNode(
                id: url.standardizedFileURL.path,
                name: url.lastPathComponent,
                kind: kind(for: url, isDirectory: isDirectory)
            )
            if isDirectory { folders.append(node) } else { files.append(node) }
        }
        let byName: (MarkdownTreeNode, MarkdownTreeNode) -> Bool = {
            $0.name.localizedStandardCompare($1.name) == .orderedAscending
        }
        return folders.sorted(by: byName) + files.sorted(by: byName)
    }

    /// The folders from `root` down to `file`, so opening a document can reveal
    /// it without expanding anything else. Empty when the file is not under root.
    static func expansionPath(to file: URL, from root: URL) -> [String] {
        let rootPath = root.standardizedFileURL.path
        let filePath = file.standardizedFileURL.path
        guard filePath.hasPrefix(rootPath.hasSuffix("/") ? rootPath : rootPath + "/") else { return [] }

        var out: [String] = []
        var current = file.standardizedFileURL.deletingLastPathComponent()
        while current.path.count > rootPath.count {
            out.append(current.path)
            current = current.deletingLastPathComponent()
        }
        out.append(rootPath)
        return out.reversed()
    }

    /// Where the sidebar should start for a document: its own folder.
    static func defaultRoot(for file: URL) -> URL {
        file.standardizedFileURL.deletingLastPathComponent()
    }
}
