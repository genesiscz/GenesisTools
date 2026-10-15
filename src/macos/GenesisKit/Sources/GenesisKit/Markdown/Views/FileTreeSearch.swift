//
//  FileTreeSearch.swift
//  GenesisKit
//
//  Search behind the file sidebar's field: file NAMES anywhere under the root
//  (collapsed folders included) and TEXT inside the files. The tree itself
//  lists one folder at a time (FileTree); search is the one place that walks
//  the subtree, so it walks it once per root, off the main thread, with the
//  folders that make a home directory enormous skipped, and it stops itself
//  at a ceiling instead of pinning every vnode on the disk.
//
//  Text search is ripgrep when it is installed (it honours .gitignore, skips
//  binaries and is an order of magnitude faster than anything written here);
//  without it a Swift scan over the file types the window can render.
//

import Foundation

/// The pure parts: ranking, parsing, and which folders never get walked.
enum FileTreeSearch {
    struct Hit: Identifiable, Equatable {
        /// Absolute path of the file.
        let path: String
        /// Path relative to the search root, what the row shows.
        let relative: String
        /// 1-based line for a text hit, nil for a name hit.
        let line: Int?
        /// The matching line, trimmed, for a text hit.
        let snippet: String?

        var id: String { line.map { "\(path):\($0)" } ?? path }
        var name: String { (path as NSString).lastPathComponent }
    }

    /// Folders that are never worth walking from a home or project root:
    /// dependency trees, build output, the system's own caches.
    static let skippedFolders: Set<String> = [
        "node_modules", ".build", ".git", "Library", ".Trash", "DerivedData",
        "Pods", ".cache", "target", "dist", ".next", "vendor", "__pycache__",
    ]

    /// Enumeration stops here; a bigger root needs a narrower one.
    static let maxIndexedFiles = 200_000
    static let maxNameHits = 200
    static let maxTextHits = 300

    static func skips(directoryNamed name: String) -> Bool {
        skippedFolders.contains(name) || name.hasPrefix(".")
    }

    /// Whether a "Search in Folder…" scope stays when the tree re-roots: it does at the new root or
    /// below it; a root inside the scope, or elsewhere, drops it.
    static func keepsScope(_ scope: String, newRoot: String) -> Bool {
        scope == newRoot || scope.hasPrefix(newRoot.hasSuffix("/") ? newRoot : newRoot + "/")
    }

    /// An application or plug-in bundle (it has `Contents/Info.plist`), as
    /// opposed to an ordinary folder whose name only ends in `.app`.
    static func isBundle(_ url: URL) -> Bool {
        guard !url.pathExtension.isEmpty else { return false }
        return FileManager.default.fileExists(atPath: url.appendingPathComponent("Contents/Info.plist").path)
    }

    /// Name matching, best first: a file name that starts with the query, one
    /// that contains it, a path that contains it (`Widget/Overview`), a path whose
    /// folders hold the query's parts in order with others between them
    /// (`Widget/Overview.md` finds `Widget/Klack/Overview.md`), then a subsequence
    /// (`mdtree` finds `MarkdownFileTreeView`). Ties keep the shorter path
    /// first, so the note in the root beats its copy six folders down.
    static func rankNames(_ query: String, in relatives: [String], limit: Int = maxNameHits) -> [String] {
        let q = query.lowercased().trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return [] }
        var scored: [(score: Int, path: String)] = []
        scored.reserveCapacity(64)
        for rel in relatives {
            let lower = rel.lowercased()
            let name = lower.lastPathSegment
            let score: Int
            if name.hasPrefix(q) { score = 0 }
            else if name.contains(q) { score = 1 }
            else if lower.contains(q) { score = 2 }
            else if partsInOrder(q, in: lower) { score = 3 }
            else if isSubsequence(q, of: name) { score = 4 }
            else { continue }
            scored.append((score, rel))
        }
        scored.sort { a, b in
            if a.score != b.score { return a.score < b.score }
            if a.path.count != b.path.count { return a.path.count < b.path.count }
            return a.path < b.path
        }
        return scored.prefix(limit).map(\.path)
    }

    /// `a/b/c` against a path: the last part is in the file name, and each earlier
    /// part is in a folder, in order, any number of folders apart. A query without
    /// a slash never matches here (the name rules above cover it).
    static func partsInOrder(_ query: String, in path: String) -> Bool {
        let parts = query.split(separator: "/").map(String.init).filter { !$0.isEmpty }
        guard parts.count > 1 else { return false }
        let segments = path.split(separator: "/").map(String.init)
        guard let name = segments.last, name.contains(parts[parts.count - 1]) else { return false }
        var folder = 0
        for part in parts.dropLast() {
            while folder < segments.count - 1, !segments[folder].contains(part) { folder += 1 }
            guard folder < segments.count - 1 else { return false }
            folder += 1
        }
        return true
    }

    static func isSubsequence(_ needle: some StringProtocol, of hay: some StringProtocol) -> Bool {
        var it = hay.unicodeScalars.makeIterator()
        for ch in needle.unicodeScalars {
            var found = false
            while let h = it.next() {
                if h == ch { found = true; break }
            }
            if !found { return false }
        }
        return true
    }

    /// One `path:line:text` line of `rg --no-heading --line-number`. A path
    /// may itself contain a colon, so the split is on the first `:<digits>:`
    /// that follows the root.
    static func parseRipgrepLine(_ line: String, root: String) -> Hit? {
        let prefix = root.hasSuffix("/") ? root : root + "/"
        guard line.hasPrefix(prefix) else { return nil }
        let rest = line.dropFirst(prefix.count)
        // First ":<number>:" after the path.
        var searchFrom = rest.startIndex
        while let colon = rest[searchFrom...].firstIndex(of: ":") {
            let afterColon = rest.index(after: colon)
            guard let next = rest[afterColon...].firstIndex(of: ":"), next > afterColon,
                  let number = Int(rest[afterColon..<next]) else {
                searchFrom = afterColon
                continue
            }
            let relative = String(rest[..<colon])
            let text = String(rest[rest.index(after: next)...]).trimmingCharacters(in: .whitespaces)
            return Hit(path: prefix + relative, relative: relative, line: number, snippet: text)
        }
        return nil
    }

    /// Where ripgrep lives when it is installed; the app has no shell PATH.
    static let ripgrepCandidates = ["/opt/homebrew/bin/rg", "/usr/local/bin/rg", "/usr/bin/rg"]

    static func ripgrepPath(exists: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) }) -> String? {
        ripgrepCandidates.first(where: exists)
    }

    /// Fixed-string, case-insensitive, first three matches per file, long
    /// lines cut, dependency folders skipped. `--json` is not used: the plain
    /// form is one line per hit and parses with no allocation to speak of.
    static func ripgrepArguments(query: String, root: String) -> [String] {
        var args = [
            "--no-heading", "--with-filename", "--line-number", "--no-messages",
            "--smart-case", "--fixed-strings", "--max-count", "3",
            "--max-filesize", "2M", "--max-columns", "240", "--max-columns-preview",
            "--no-follow",
        ]
        for folder in skippedFolders.sorted() {
            args += ["--glob", "!\(folder)"]
        }
        args += ["--", query, root]
        return args
    }

    /// The Swift fallback for one file: lines that contain `query`, case-insensitive.
    static func textHits(in text: String, query: String, path: String, root: String, limit: Int = 3) -> [Hit] {
        let prefix = root.hasSuffix("/") ? root : root + "/"
        let relative = path.hasPrefix(prefix) ? String(path.dropFirst(prefix.count)) : path
        var out: [Hit] = []
        var number = 0
        for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
            number += 1
            if line.range(of: query, options: .caseInsensitive) != nil {
                out.append(Hit(path: path, relative: relative, line: number, snippet: String(line.prefix(240)).trimmingCharacters(in: .whitespaces)))
                if out.count >= limit { break }
            }
        }
        return out
    }
}

private extension String {
    var lastPathSegment: Substring {
        if let slash = lastIndex(of: "/") { return self[index(after: slash)...] }
        return self[...]
    }
}

/// The search state the sidebar observes. Every result lands on the main
/// actor; every walk, rank and grep runs off it and is dropped the moment a
/// newer query or root replaces it.
@MainActor
final class FileTreeSearchModel: ObservableObject {
    enum Mode: String, CaseIterable { case names, text }

    @Published var query = ""
    @Published var mode: Mode = .names
    @Published private(set) var hits: [FileTreeSearch.Hit] = []
    @Published private(set) var searching = false
    /// The name index hit its ceiling, or text hits were cut at theirs.
    @Published private(set) var truncated = false
    /// Names mode found no file name, so the hits are text matches inside files.
    @Published private(set) var fellBackToText = false
    /// Files the name index holds for the current root (0 before the first search).
    @Published private(set) var indexedCount = 0
    /// The folder "Search in Folder…" limits the search to, nil for the whole tree (the scope chip).
    @Published private(set) var scope: String?

    private var root: String = ""
    /// Where a search walks: the scope when there is one, else the tree's root.
    var searchRoot: String { scope ?? root }
    private var index: [String]?
    private var indexTask: Task<[String], Never>?
    private var searchTask: Task<Void, Never>?
    private var generation = 0
    private var process: Process?

    var isActive: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    /// Point the search at a folder. A new root drops the index; the next
    /// query rebuilds it.
    func setRoot(_ url: URL) {
        let path = url.standardizedFileURL.path
        guard path != root else { return }
        root = path
        if let scope, !FileTreeSearch.keepsScope(scope, newRoot: path) {
            self.scope = nil
        }
        invalidate()
    }

    /// Limits the search to `folder` (nil: the whole tree again), and runs the query there.
    func setScope(_ folder: URL?) {
        let path = folder?.standardizedFileURL.path
        guard path != scope else { return }
        scope = path
        invalidate()
    }

    /// Files under the root were renamed, copied or trashed: drop the name index and run the query
    /// again, so no hit points at a path that is gone.
    func invalidate() {
        index = nil
        indexTask?.cancel()
        indexTask = nil
        indexedCount = 0
        if isActive { run() }
    }

    func clear() {
        query = ""
        cancel()
        hits = []
        searching = false
        truncated = false
        fellBackToText = false
    }

    /// Debounced by the view: called on every keystroke, it cancels the
    /// previous run and starts over, so only the last one ever lands.
    func run() {
        cancel()
        let q = query.trimmingCharacters(in: .whitespaces)
        let root = searchRoot
        guard !q.isEmpty, !root.isEmpty else {
            hits = []
            searching = false
            truncated = false
            return
        }
        generation += 1
        let gen = generation
        fellBackToText = false
        searching = true
        let rootPath = root
        switch mode {
        case .names:
            let indexTask = self.indexTask ?? Self.buildIndex(root: rootPath)
            self.indexTask = indexTask
            searchTask = Task { [weak self] in
                let relatives = await indexTask.value
                guard !Task.isCancelled else { return }
                let ranked = await Task.detached(priority: .userInitiated) {
                    FileTreeSearch.rankNames(q, in: relatives)
                }.value
                guard let self, self.generation == gen, !Task.isCancelled else { return }
                self.index = relatives
                self.indexedCount = relatives.count
                self.truncated = relatives.count >= FileTreeSearch.maxIndexedFiles
                // A word that is in a note but in no file name (a heading, a phrase) found
                // nothing here and read as "not in the vault". Look inside the files instead.
                if ranked.isEmpty {
                    self.fellBackToText = true
                    self.runText(query: q, root: rootPath, generation: gen)
                    return
                }
                self.hits = ranked.map {
                    FileTreeSearch.Hit(path: rootPath + "/" + $0, relative: $0, line: nil, snippet: nil)
                }
                self.searching = false
            }
        case .text:
            runText(query: q, root: rootPath, generation: gen)
        }
    }

    private func runText(query: String, root: String, generation gen: Int) {
        if let rg = FileTreeSearch.ripgrepPath() {
            runRipgrep(rg, query: query, root: root, generation: gen)
        } else {
            runSwiftScan(query: query, root: root, generation: gen)
        }
    }

    private func cancel() {
        searchTask?.cancel()
        searchTask = nil
        if let process, process.isRunning { process.terminate() }
        process = nil
    }

    /// Relative paths of every file under `root`, walked once, on a
    /// background task. Cancellation is checked per directory.
    static func buildIndex(root: String) -> Task<[String], Never> {
        Task.detached(priority: .userInitiated) {
            var out: [String] = []
            out.reserveCapacity(4096)
            // Resolved: the walker reports real paths, so a root behind a symlink
            // (`/var` → `/private/var`) cut the wrong number of characters.
            let rootURL = URL(fileURLWithPath: root).resolvingSymlinksInPath()
            let rootPath = rootURL.path
            let prefixCount = rootPath.hasSuffix("/") ? rootPath.count : rootPath.count + 1
            guard let walker = FileManager.default.enumerator(
                at: rootURL,
                includingPropertiesForKeys: [.isDirectoryKey],
                // Not `.skipsPackageDescendants`: a vault folder named like a bundle
                // ("GenesisTools.app" holding notes) is a package to Finder, and its
                // notes never reached the name search (2026-10-07). Real bundles
                // are skipped by their Info.plist below.
                options: [.skipsHiddenFiles]
            ) else { return out }
            // nextObject, not for-in: the enumerator's iterator is unavailable in async code.
            while let url = walker.nextObject() as? URL {
                if Task.isCancelled { return out }
                let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
                if isDir {
                    if FileTreeSearch.skips(directoryNamed: url.lastPathComponent) || FileTreeSearch.isBundle(url) {
                        walker.skipDescendants()
                    }
                    continue
                }
                let path = url.resolvingSymlinksInPath().path
                guard path.hasPrefix(rootPath) else { continue }
                out.append(String(path.dropFirst(prefixCount)))
                if out.count >= FileTreeSearch.maxIndexedFiles { return out }
            }
            return out
        }
    }

    private func runRipgrep(_ rg: String, query: String, root: String, generation gen: Int) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: rg)
        proc.arguments = FileTreeSearch.ripgrepArguments(query: query, root: root)
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError = FileHandle.nullDevice
        process = proc
        searchTask = Task.detached(priority: .userInitiated) { [weak self] in
            do { try proc.run() } catch {
                await MainActor.run { [weak self] in
                    guard let self, self.generation == gen else { return }
                    self.hits = []; self.searching = false
                }
                return
            }
            // Read everything, then cut: rg is done long before 300 hits cost anything.
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            proc.waitUntilExit()
            let text = String(decoding: data, as: UTF8.self)
            var hits: [FileTreeSearch.Hit] = []
            var cut = false
            for line in text.split(separator: "\n") {
                if let hit = FileTreeSearch.parseRipgrepLine(String(line), root: root) {
                    hits.append(hit)
                    if hits.count >= FileTreeSearch.maxTextHits { cut = true; break }
                }
            }
            let result = hits
            let wasCut = cut
            await MainActor.run { [weak self] in
                guard let self, self.generation == gen else { return }
                self.hits = result
                self.truncated = wasCut
                self.searching = false
            }
        }
    }

    private func runSwiftScan(query: String, root: String, generation gen: Int) {
        let indexTask = self.indexTask ?? Self.buildIndex(root: root)
        self.indexTask = indexTask
        searchTask = Task { [weak self] in
            let relatives = await indexTask.value
            guard !Task.isCancelled else { return }
            let scan = Task.detached(priority: .userInitiated) { () -> ([FileTreeSearch.Hit], Bool) in
                var out: [FileTreeSearch.Hit] = []
                for rel in relatives where FileTreeSearch.readable(rel) {
                    if Task.isCancelled { return (out, false) }
                    let path = root + "/" + rel
                    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
                    out += FileTreeSearch.textHits(in: text, query: query, path: path, root: root)
                    if out.count >= FileTreeSearch.maxTextHits { return (Array(out.prefix(FileTreeSearch.maxTextHits)), true) }
                }
                return (out, false)
            }
            // A detached task does not inherit cancellation, so forward it: a
            // superseded keystroke must stop this scan, not let it read every file.
            let (hits, cut) = await withTaskCancellationHandler {
                await scan.value
            } onCancel: {
                scan.cancel()
            }
            guard let self, self.generation == gen, !Task.isCancelled else { return }
            self.index = relatives
            self.indexedCount = relatives.count
            self.hits = hits
            self.truncated = cut
            self.searching = false
        }
    }
}

extension FileTreeSearch {
    static func readable(_ relative: String) -> Bool {
        readableExtension(of: relative)
    }
    private static func readableExtension(of path: String) -> Bool {
        guard let dot = path.lastIndex(of: "."), !path[dot...].contains("/") else { return false }
        return FileTree.isReadable(URL(fileURLWithPath: path))
    }
}
