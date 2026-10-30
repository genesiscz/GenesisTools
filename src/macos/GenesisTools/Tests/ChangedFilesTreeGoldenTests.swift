import XCTest
import GenesisKit
@testable import GenesisToolsHub

/// GenesisKit's `ChangedFilesTree` must give the hub's file list the rows its own `sidebarRows` gives, so the list can
/// move to the shared table without a visible change: the same ids, depths, labels, sums and order, in tree and flat
/// mode, folded and open, with one root and with several.
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
        let kitRoots = roots.map { ChangedFilesTreeRoot(rowID: $0.rowID, prefix: $0.prefix) }
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
