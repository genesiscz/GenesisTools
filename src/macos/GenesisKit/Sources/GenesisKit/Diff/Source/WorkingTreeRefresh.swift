//
//  WorkingTreeRefresh.swift
//  GenesisKit
//
//  The live reload of an Uncommitted diff. The hub's review re-read the whole repository for every file event: in a
//  checkout where agents work all day that was 15 to 50 loads a minute of 190 to 270 ms each, about nine git runs
//  apiece, while most events changed nothing it shows (2026-11-05). Here an event is classified first (a clone, an
//  index stat refresh or another worktree's commit is nothing), and a real change re-reads only its own paths.
//

import CoreServices
import Foundation

/// What one FSEvents event means for a working-tree diff (`ReviewRepositoryLayout.classify`).
public enum ReviewWatchEvent: Hashable {
    /// A working-tree path, relative to the root, whose bytes, name, existence or mode may have changed.
    case path(String)
    /// The index file was written. Any `git status` in the checkout writes it to refresh stat data.
    case index
    /// HEAD or a ref may have moved (`ReviewRepositoryLayout.movesRefs`).
    case refs
    /// FSEvents dropped events or asks for a folder to be scanned again: only a full load is safe.
    case rescan
}

/// The events of one root since its last reload.
public struct ReviewWatchBatch: Equatable {
    public var paths: Set<String> = []
    public var index = false
    public var refs = false
    public var rescan = false

    public init() {}

    /// A batch that asks for a full load.
    public static var everything: ReviewWatchBatch {
        var batch = ReviewWatchBatch()
        batch.rescan = true
        return batch
    }

    public var isEmpty: Bool { paths.isEmpty && !index && !refs && !rescan }

    public mutating func add(_ event: ReviewWatchEvent) {
        switch event {
        case .path(let path): paths.insert(path)
        case .index: index = true
        case .refs: refs = true
        case .rescan: rescan = true
        }
    }

    public mutating func merge(_ other: ReviewWatchBatch) {
        paths.formUnion(other.paths)
        index = index || other.index
        refs = refs || other.refs
        rescan = rescan || other.rescan
    }

    /// One line for the perf log: "2 paths (src/a.ts, b.md), index, refs".
    public var summary: String {
        var parts: [String] = []
        if !paths.isEmpty {
            let shown = paths.sorted().prefix(3).joined(separator: ", ")
            parts.append("\(paths.count) path\(paths.count == 1 ? "" : "s") (\(shown)\(paths.count > 3 ? ", …" : ""))")
        }
        if index { parts.append("index") }
        if refs { parts.append("refs") }
        if rescan { parts.append("rescan") }
        return parts.isEmpty ? "nothing" : parts.joined(separator: ", ")
    }
}

extension ReviewRepositoryLayout {
    /// The flags that say an item's bytes, name, existence or mode changed. A clone of a file (the agents diff hook
    /// clones every dirty file before each tool call), an extended attribute, Finder info or an owner change leaves
    /// the diff as it was.
    static let contentFlags = UInt32(kFSEventStreamEventFlagItemCreated | kFSEventStreamEventFlagItemRemoved
        | kFSEventStreamEventFlagItemRenamed | kFSEventStreamEventFlagItemModified | kFSEventStreamEventFlagItemInodeMetaMod)
    /// A folder's own events that move what is in it. A folder's modified time changes with every file made in it,
    /// and that file has its own event.
    static let folderFlags = UInt32(kFSEventStreamEventFlagItemCreated | kFSEventStreamEventFlagItemRemoved
        | kFSEventStreamEventFlagItemRenamed)
    static let rescanFlags = UInt32(kFSEventStreamEventFlagMustScanSubDirs | kFSEventStreamEventFlagUserDropped
        | kFSEventStreamEventFlagKernelDropped | kFSEventStreamEventFlagRootChanged)

    /// What the event at `event` with FSEvents `flags` means for this repository's working-tree diff; nil when it
    /// cannot change it.
    public func classify(_ event: String, flags: UInt32) -> ReviewWatchEvent? {
        if flags & Self.rescanFlags != 0 { return .rescan }
        guard flags & Self.contentFlags != 0 else { return nil }
        if movesRefs(event) { return .refs }
        let path = URL(fileURLWithPath: event).standardizedFileURL.path
        for directory in [gitDirectory.path, commonDirectory.path] where path == directory || path.hasPrefix(directory + "/") {
            // The other Git files (objects, locks, logs, other worktrees' indexes) change no diff of this checkout.
            if path == commonDirectory.path + "/info/exclude" { return .rescan }
            // A commit in a submodule moves its HEAD or a ref under `modules/` and its gitlink in this diff, with no
            // working file changed, so the whole diff is read again.
            if movesSubmoduleRef(path) { return .rescan }
            return path == gitDirectory.path + "/index" ? .index : nil
        }
        if path == root.path {
            return flags & Self.folderFlags != 0 ? .rescan : nil
        }
        guard path.hasPrefix(root.path + "/") else { return nil }
        let relative = String(path.dropFirst(root.path.count + 1))
        let wrapped = "/" + relative + "/"
        // A linked worktree's `.git` is a file that names its Git directory, and a nested repository's Git files
        // never show in this one's diff (its `index.lock` came with every git run in it, 2026-11-05).
        guard !wrapped.contains("/.git/"), !wrapped.contains("/node_modules/"), !wrapped.contains("/.build/") else { return nil }
        if flags & UInt32(kFSEventStreamEventFlagItemIsDir) != 0, flags & Self.folderFlags == 0 { return nil }
        return .path(relative)
    }

    /// A submodule's HEAD, packed refs or a ref, nested submodules included (`modules/a/modules/b/HEAD`).
    private func movesSubmoduleRef(_ path: String) -> Bool {
        let modules = commonDirectory.path + "/modules/"
        guard path.hasPrefix(modules) else { return false }
        let inside = "/" + String(path.dropFirst(modules.count))
        return inside.hasSuffix("/HEAD") || inside.hasSuffix("/packed-refs") || inside.contains("/refs/")
    }
}

/// What an Uncommitted load saw beside its files: HEAD and the index's entry count, so a live reload can tell
/// whether a ref or index event changed anything, and the paths it already knows git ignores.
public struct WorkingTreeMarks: Equatable {
    /// The HEAD file as written: `ref: refs/heads/main`, or a detached commit id.
    public var headFile: String
    /// The commit HEAD names; empty before the first commit.
    public var head: String
    /// The index header's entry count; nil when the file could not be read as an index.
    public var indexEntries: Int?
    /// Paths `git status` reported as ignored since the last full load; a folder ends with `/`.
    public var ignored: Set<String> = []

    public init(headFile: String, head: String, indexEntries: Int?, ignored: Set<String> = []) {
        self.headFile = headFile
        self.head = head
        self.indexEntries = indexEntries
        self.ignored = ignored
    }

    public func ignores(_ path: String) -> Bool {
        ignored.contains(path) || ignored.contains { $0.hasSuffix("/") && path.hasPrefix($0) }
    }
}

/// A live reload's answer (`GitWorkingTreeSource.refresh`).
public enum WorkingTreeRefresh {
    /// The files read as before; the marks may know more ignored paths.
    case same(WorkingTreeMarks)
    /// The previous answer with the batch's paths read again.
    case updated(GitWorkingTreeSource.Snapshot)
    /// Only a full load is safe; the reason goes to the perf log.
    case full(reason: String)
}

extension GitWorkingTreeSource {
    /// More changed paths than this, and one full load costs less (a checkout, a stash, a formatter run).
    public static let maxRefreshPaths = 200

    /// The Uncommitted answer after `batch`, from `previous` (an Uncommitted answer of this repository with its
    /// marks). git reads only the batch's paths: one `status` and, for tracked paths, one `diff --numstat`; the HEAD
    /// side of a text file already listed is reused, since HEAD did not move.
    public func refresh(_ previous: Snapshot, batch: ReviewWatchBatch, layout: ReviewRepositoryLayout) -> WorkingTreeRefresh {
        if batch.rescan { return .full(reason: "FSEvents asked for a rescan") }
        if batch.index { return .full(reason: "the index may have changed paths without changing its count") }
        guard var marks = previous.marks else { return .full(reason: "the last answer has no marks") }
        guard let now = readMarks(layout) else { return .full(reason: "HEAD could not be read") }
        if now.headFile != marks.headFile || now.head != marks.head { return .full(reason: "HEAD moved") }
        // A file added to or removed from the index (`git add` of a new file, `git rm --cached`, `git mv`) can change
        // the list; a stat refresh keeps the count.
        guard let entries = now.indexEntries, entries == marks.indexEntries else {
            return .full(reason: "the index gained or lost entries")
        }
        // Revalidate ignored paths: exclude rules can change outside the watched checkout.
        let paths = batch.paths
        if paths.isEmpty { return .same(marks) }
        if paths.count > Self.maxRefreshPaths { return .full(reason: "\(paths.count) paths changed") }
        if paths.contains(where: Self.changesRules) { return .full(reason: "a .gitignore or .gitattributes changed") }

        let region = paths.sorted()
        var checkedFolders: Set<String> = []
        for path in region {
            var folder = layout.root.appendingPathComponent(path).deletingLastPathComponent()
            while folder.path.hasPrefix(layout.root.path + "/"), checkedFolders.insert(folder.path).inserted {
                // A pathspec below a gitlink cannot report its submodule's dirty/clean transition.
                if FileManager.default.fileExists(atPath: folder.appendingPathComponent(".git").path) {
                    return .full(reason: "content inside a nested repository changed")
                }
                folder.deleteLastPathComponent()
            }
        }
        func inRegion(_ path: String) -> Bool {
            region.contains { path == $0 || path.hasPrefix($0 + "/") }
        }
        guard let data = try? gitData(["--literal-pathspecs", "status", "--porcelain=v2", "-z", "--untracked-files=all",
                                       "--ignored=matching", "--"] + region) else {
            return .full(reason: "git status failed")
        }
        guard let status = Self.parseStatus(data) else { return .full(reason: "a rename, a conflict or a submodule") }
        marks.ignored.formUnion(status.ignored)

        let touched = { (file: DiffFile) in inRegion(file.path) || file.oldPath.map(inRegion) == true }
        let before = previous.files.filter(touched)
        let kept = previous.files.filter { !touched($0) }
        // A move outside git is a deleted file and an untracked twin (GitWorktreeRenames), and `diff --find-renames`
        // pairs a deleted file with an added one: a pair can form or break only with a deletion and an addition.
        if before.contains(where: { $0.status == .renamed }) { return .full(reason: "a renamed pair changed") }
        let known = Dictionary(before.map { ($0.path, $0) }, uniquingKeysWith: { first, _ in first })
        let anyAdded = kept.contains { $0.status == .added } || status.entries.contains { $0.status == .added }
        let anyDeleted = kept.contains { $0.status == .deleted } || status.entries.contains { $0.status == .deleted }
        let newDeleted = status.entries.contains { $0.status == .deleted && known[$0.path]?.status != .deleted }
        let newAdded = status.entries.contains { $0.status == .added && known[$0.path]?.status != .added }
        let addedContentChanged = before.contains { $0.status == .added }
        if (newDeleted && anyAdded) || ((newAdded || addedContentChanged) && anyDeleted) {
            return .full(reason: "a rename may have formed")
        }

        var olds = Blobs()
        var unread: [(rev: String, path: String)] = []
        for entry in status.entries where entry.status != .added {
            if let file = known[entry.path], file.status != .added, file.image == nil, let text = file.oldContents {
                olds.contents["HEAD:\(entry.path)"] = .text(text)
            } else {
                unread.append((rev: "HEAD", path: entry.path))
            }
        }
        let read = catFile(unread)
        olds.contents.merge(read.contents) { _, new in new }
        olds.oids.merge(read.oids) { _, new in new }

        let tracked = status.entries.filter { !$0.untracked }.map(\.path)
        var counts: [String: (additions: Int, deletions: Int)] = [:]
        if !tracked.isEmpty {
            guard let numstat = try? gitData(["--literal-pathspecs", "diff", "--numstat", "-z", "HEAD", "--"] + tracked) else {
                return .full(reason: "git diff failed")
            }
            counts = parseNumstat(numstat)
        }

        var files = kept
        for entry in status.entries {
            // `git diff HEAD` leaves out a tracked file whose text is HEAD's again (staged, then edited back).
            if !entry.untracked, counts[entry.path] == nil { continue }
            files.append(makeFile(entry, old: "HEAD", new: nil, olds: olds, news: Blobs(), counts: counts))
        }
        files.sort { $0.path < $1.path }
        if files == previous.files { return .same(marks) }
        var snapshot = previous
        snapshot.files = files
        snapshot.marks = marks
        return .updated(snapshot)
    }

    /// A rules file changes which files are listed or how they read, anywhere below it.
    static func changesRules(_ path: String) -> Bool {
        let name = (path as NSString).lastPathComponent
        return name == ".gitignore" || name == ".gitattributes"
    }

    /// `git status --porcelain=v2 -z` records as Uncommitted entries (HEAD against the working tree), and the
    /// ignored paths. nil for a record only a full load reads right: a rename or copy in the index (`2`), a conflict
    /// (`u`), a submodule, or a file added to the index and then deleted from disk.
    static func parseStatus(_ data: Data) -> (entries: [StatusEntry], ignored: [String])? {
        var entries: [StatusEntry] = []
        var ignored: [String] = []
        var untracked: [String] = []
        var tracked = Set<String>()
        for record in data.split(separator: 0, omittingEmptySubsequences: true) {
            let line = String(decoding: record, as: UTF8.self)
            switch line.first {
            case "1":
                // `1 XY sub mH mI mW hH hI path`
                let fields = line.split(separator: " ", maxSplits: 8, omittingEmptySubsequences: false)
                guard fields.count == 9, fields[1].count == 2, fields[2] == "N..." else { return nil }
                let index = fields[1].first, tree = fields[1].last
                let path = String(fields[8])
                let status: DiffFile.Status
                if fields[6].allSatisfy({ $0 == "0" }) {
                    guard tree != "D" else { return nil }
                    status = .added
                } else if index == "D" || tree == "D" {
                    status = .deleted
                } else {
                    status = .modified
                }
                tracked.insert(path)
                entries.append(StatusEntry(path: path, oldPath: nil, status: status))
            case "?":
                untracked.append(String(line.dropFirst(2)))
            case "!":
                ignored.append(String(line.dropFirst(2)))
            case "2", "u":
                return nil
            default:
                continue
            }
        }
        // A file deleted from the index but still on disk is both; the diff's deletion wins, as in a full load.
        entries += untracked.filter { !tracked.contains($0) }.map { StatusEntry(path: $0, oldPath: nil, status: .added, untracked: true) }
        return (entries, ignored)
    }

    /// HEAD and the index header, read from the files without a git run; `git rev-parse` only when the files cannot
    /// name the commit (a reftable repository, a symbolic ref that names another).
    func readMarks(_ layout: ReviewRepositoryLayout) -> WorkingTreeMarks? {
        guard let raw = try? String(contentsOf: layout.gitDirectory.appendingPathComponent("HEAD"), encoding: .utf8) else { return nil }
        let headFile = raw.trimmed
        let head = Self.commit(named: headFile, in: layout)
            ?? (try? git(["rev-parse", "--verify", "--quiet", "HEAD"]).trimmed) ?? ""
        return WorkingTreeMarks(headFile: headFile, head: head, indexEntries: Self.indexEntries(layout))
    }

    /// The commit a HEAD file names, from the loose ref or `packed-refs`; empty for a branch with no commit yet, nil
    /// when only git can tell.
    static func commit(named headFile: String, in layout: ReviewRepositoryLayout) -> String? {
        guard headFile.hasPrefix("ref: ") else { return isFullObjectID(headFile) ? headFile : nil }
        let name = String(headFile.dropFirst("ref: ".count)).trimmed
        let files = FileManager.default
        guard name.hasPrefix("refs/"), !files.fileExists(atPath: layout.commonDirectory.appendingPathComponent("reftable").path) else {
            return nil
        }
        // Per-worktree refs (`refs/bisect`, `refs/worktree`) live in the worktree's Git directory, the rest in the
        // common one.
        for directory in [layout.gitDirectory, layout.commonDirectory] {
            if let loose = try? String(contentsOf: directory.appendingPathComponent(name), encoding: .utf8) {
                let value = loose.trimmed
                return isFullObjectID(value) ? value : nil
            }
        }
        guard let packed = try? String(contentsOf: layout.commonDirectory.appendingPathComponent("packed-refs"), encoding: .utf8) else {
            return ""
        }
        for line in packed.split(separator: "\n") where line.hasSuffix(" " + name) {
            let oid = String(line.prefix { $0 != " " })
            if isFullObjectID(oid) { return oid }
        }
        return ""
    }

    /// The entry count in the index header (`DIRC`, version, count); 0 when there is no index yet.
    static func indexEntries(_ layout: ReviewRepositoryLayout) -> Int? {
        let url = layout.gitDirectory.appendingPathComponent("index")
        guard let handle = try? FileHandle(forReadingFrom: url) else {
            return FileManager.default.fileExists(atPath: url.path) ? nil : 0
        }
        defer { try? handle.close() }
        guard let header = try? handle.read(upToCount: 12).map(Array.init), header.count == 12,
              header[0..<4] == Array("DIRC".utf8)[...] else { return nil }
        return header[8..<12].reduce(0) { $0 << 8 | Int($1) }
    }
}
