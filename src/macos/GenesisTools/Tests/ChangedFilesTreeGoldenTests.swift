import XCTest
import GenesisKit
@testable import GenesisToolsHub

/// GenesisKit's `ChangedFilesTree` must give the hub's file list the rows the hub's own `sidebarRows` gave before the
/// list moved to the shared table (2026-10-30): the same ids, depths, labels, sums and order, in tree and flat mode,
/// folded and open, with one root and with several. That function is kept below, frozen, as the reference.
final class ChangedFilesTreeGoldenTests: XCTestCase {
    private static func files(_ tsv: String) -> [DiffFile] {
        tsv.split(separator: "\n").compactMap { line in
            let parts = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 4, let additions = Int(parts[2]), let deletions = Int(parts[3]) else { return nil }
            let status: DiffFile.Status = switch parts[1] {
            case "added": .added
            case "removed": .deleted
            case "renamed": .renamed
            default: .modified
            }
            return DiffFile(id: parts[0], path: parts[0], status: status, additions: additions, deletions: deletions)
        }
    }

    /// Balanced synthetic trees like the benchmark's (folders of folders of ten files), plus a single-child chain.
    private static func synthetic(_ top: Int) -> [DiffFile] {
        var result: [DiffFile] = []
        for pkg in 0..<top {
            for part in 0..<4 {
                for index in 0..<10 {
                    let path = "pkg\(pkg)-module/src-part\(part)/component\(index)View\(pkg * 40 + part * 10 + index).tsx"
                    result.append(DiffFile(id: path, path: path, status: .modified, additions: index, deletions: part))
                }
            }
        }
        let chained = "deep/one/two/three/leaf.swift"
        result.append(DiffFile(id: chained, path: chained, status: .added, additions: 3, deletions: 0))
        result.append(DiffFile(id: "README.md", path: "README.md", status: .modified, additions: 1, deletions: 1))
        return result
    }

    private static func render(_ rows: [SidebarRow]) -> [String] {
        rows.map { row in
            switch row.kind {
            case .root(let index, let additions, let deletions): "\(row.id)|\(row.depth)|root \(index) +\(additions) -\(deletions)"
            case .directory(let name, let additions, let deletions): "\(row.id)|\(row.depth)|dir \(name) +\(additions) -\(deletions)"
            case .file(let file): "\(row.id)|\(row.depth)|file \(file.path) \(file.status) +\(file.additions) -\(file.deletions)"
            }
        }
    }

    private static func render(_ rows: [ChangedFilesTreeRow]) -> [String] {
        rows.map { row in
            switch row.kind {
            case .root(let index, let additions, let deletions): "\(row.id)|\(row.depth)|root \(index) +\(additions) -\(deletions)"
            case .directory(let name, let additions, let deletions): "\(row.id)|\(row.depth)|dir \(name) +\(additions) -\(deletions)"
            case .file(let file): "\(row.id)|\(row.depth)|file \(file.path) \(file.status) +\(file.additions) -\(file.deletions)"
            }
        }
    }

    /// The hub's rows and the port's, for every mode and fold this list can be in.
    private func assertSame(_ files: [DiffFile], roots: [ReviewRoot] = [], _ label: String) {
        let kitRoots = roots.map(\.treeRoot)
        let open = sidebarRows(files, tree: true, collapsed: [], roots: roots)
        let folders = open.filter { if case .file = $0.kind { return false } else { return true } }.map(\.id)
        let folds: [Set<String>] = [[], Set(folders.prefix(1)), Set(folders.enumerated().filter { $0.offset % 3 == 1 }.map(\.element))]
        for tree in [true, false] {
            for collapsed in folds {
                let hub = sidebarRows(files, tree: tree, collapsed: collapsed, roots: roots)
                let kit = ChangedFilesTree.rows(files, tree: tree, collapsed: collapsed, roots: kitRoots)
                XCTAssertEqual(Self.render(kit), Self.render(hub), "\(label) tree=\(tree) folded=\(collapsed.count)")
                for row in kit where row.isFolder {
                    XCTAssertEqual(row.expanded, !collapsed.contains(row.id), "\(label) \(row.id)")
                }
                for row in kit where !row.isFolder {
                    XCTAssertFalse(row.expanded, "\(label) \(row.id)")
                }
            }
        }
        XCTAssertFalse(open.isEmpty, label)
    }

    func testThePortGivesTheHubsRowsForTheRealChangeLists() {
        assertSame(Self.files(ChangedFilesFixtures.pr518), "#518")
        assertSame(Self.files(ChangedFilesFixtures.pr478), "#478")
        assertSame(Self.files(ChangedFilesFixtures.pr374), "#374")
        XCTAssertEqual(Self.files(ChangedFilesFixtures.pr374).count, 549)
    }

    func testThePortGivesTheHubsRowsForTheSyntheticTrees() {
        for top in [2, 12, 50] {
            assertSame(Self.synthetic(top), "synthetic \(top)")
        }
    }

    func testThePortGivesTheHubsRowsWithSeveralRoots() {
        var alpha = ReviewRoot(folder: "/tmp/alpha", repo: nil)
        alpha.prefix = "alpha"
        var beta = ReviewRoot(folder: "/tmp/beta", repo: nil)
        beta.prefix = "beta"
        let empty = { () -> ReviewRoot in
            var root = ReviewRoot(folder: "/tmp/gamma", repo: nil)
            root.prefix = "gamma"
            return root
        }()
        let source = Self.files(ChangedFilesFixtures.pr478)
        let merged = source.enumerated().map { offset, file -> DiffFile in
            let id = (offset % 2 == 0 ? "alpha/" : "beta/") + file.path
            return DiffFile(id: id, path: id, status: file.status, additions: file.additions, deletions: file.deletions)
        }
        assertSame(merged, roots: [alpha, beta, empty], "#478 in three roots")
    }
}

// MARK: - The hub's row builder as it was until 2026-10-30 (ReviewWindow.swift), frozen as the golden reference.

private struct SidebarRow: Identifiable, Equatable {
    enum Kind: Equatable {
        /// A root's folder in a review of several repositories: its checkbox, remove and error live here.
        case root(index: Int, additions: Int, deletions: Int)
        case directory(name: String, additions: Int, deletions: Int)
        case file(DiffFile)
    }

    let id: String
    let depth: Int
    let kind: Kind
}

private final class TreeNode {
    let name: String
    let path: String
    var children: [String: TreeNode] = [:]
    var files: [DiffFile] = []
    /// Every file under this folder, nested ones included: summed once while the tree is built.
    var additions = 0
    var deletions = 0

    init(name: String, path: String) {
        self.name = name
        self.path = path
    }
}

/// Flat: one header per directory, like GitHub's file list. Tree: nested folders, where a chain of
/// single-child folders collapses into one row (`src/browser-router/lib`), like Codex's review pane.
/// With several roots, each root is one top-level row in root order (never folded into its first
/// folder), with its files under it; a root with no files keeps its row.
private func sidebarRows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>, roots: [ReviewRoot] = []) -> [SidebarRow] {
    guard roots.count > 1 else {
        return sidebarRows(files, tree: tree, collapsed: collapsed, depth: 0, strip: "")
    }

    return roots.enumerated().flatMap { index, root -> [SidebarRow] in
        let own = files.filter { ReviewRoots.index(of: $0.id, in: roots) == index }
        let totals = own.reduce((0, 0)) { ($0.0 + $1.additions, $0.1 + $1.deletions) }
        let row = SidebarRow(id: root.rowID, depth: 0, kind: .root(index: index, additions: totals.0, deletions: totals.1))
        guard !collapsed.contains(root.rowID) else { return [row] }
        return [row] + sidebarRows(own, tree: tree, collapsed: collapsed, depth: 1, strip: root.prefix + "/")
    }
}

/// One root's rows. `strip` is the root's prefix: folder names read without it, ids keep it.
private func sidebarRows(_ files: [DiffFile], tree: Bool, collapsed: Set<String>, depth: Int, strip: String) -> [SidebarRow] {
    guard tree else {
        let grouped = Dictionary(grouping: files, by: \.directory)
        return grouped.keys.sorted().flatMap { directory -> [SidebarRow] in
            let group = grouped[directory] ?? []
            let name = directory.hasPrefix(strip) ? String(directory.dropFirst(strip.count)) : ""
            let additions = group.reduce(0) { $0 + $1.additions }
            let deletions = group.reduce(0) { $0 + $1.deletions }
            let header = name.isEmpty
                ? []
                : [SidebarRow(id: "dir:\(directory)", depth: depth, kind: .directory(name: name, additions: additions, deletions: deletions))]
            return header + group.map { SidebarRow(id: $0.id, depth: depth, kind: .file($0)) }
        }
    }

    let top = TreeNode(name: "", path: "")
    for file in files {
        var node = top
        for part in file.directory.split(separator: "/").map(String.init) where !file.directory.isEmpty {
            let path = node.path.isEmpty ? part : "\(node.path)/\(part)"
            if node.children[part] == nil {
                node.children[part] = TreeNode(name: part, path: path)
            }
            node = node.children[part]!
            node.additions += file.additions
            node.deletions += file.deletions
        }
        node.files.append(file)
    }

    var rows: [SidebarRow] = []
    func walk(_ node: TreeNode, depth: Int) {
        for child in node.children.values.sorted(by: { $0.name < $1.name }) {
            var folder = child
            var label = child.name
            while folder.files.isEmpty, folder.children.count == 1, let only = folder.children.values.first {
                folder = only
                label += "/\(only.name)"
            }
            let id = "dir:\(folder.path)"
            rows.append(SidebarRow(id: id, depth: depth, kind: .directory(name: label, additions: folder.additions, deletions: folder.deletions)))
            if !collapsed.contains(id) {
                walk(folder, depth: depth + 1)
            }
        }
        for file in node.files.sorted(by: { $0.name < $1.name }) {
            rows.append(SidebarRow(id: file.id, depth: depth, kind: .file(file)))
        }
    }
    // Several roots: the walk starts inside the root's own folder, which the caller drew already.
    let start = strip.isEmpty ? top : top.children[String(strip.dropLast())]
    if let start {
        walk(start, depth: depth)
    }
    return rows
}
