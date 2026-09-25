import Foundation

// A review of several repositories at once: the hub's "Changes in <folder>" ticks. ReviewModel keeps
// one toolbar, one diff and one Files tree for all of them. Every file of a root shows under the root's
// folder name ("Notes/AI/notes.md"), so two roots with the same relative path never collide;
// each action (comments, blame, open at a line, copy path) maps the file back to its own repository.
// A review of one repository has one root with no prefix, and its paths read as they always did.

/// One repository of a review, with its last load.
struct ReviewRoot: Equatable {
    /// The folder as the hub stores it: the session's own folder, or one added in Files.
    let folder: String
    /// The git repository that holds `folder`; nil when the folder is not inside one.
    let repo: URL?
    /// Whether Changes shows this root. An unticked root keeps its folder row and loads nothing.
    var shown = true
    /// An added folder: its row offers Remove. The session's own folder cannot be removed.
    var removable = false
    /// The top-level folder name in the tree and in the diff's file headers; "" for a single root.
    var prefix = ""
    /// Repo-relative files of the last load (ids and paths without the prefix).
    var files: [DiffFile] = []
    var branch = ""
    /// Why this root has no files: a failed load, or a folder outside git. Shown on its folder row.
    var error: String?

    init(folder: String, repo: URL?, shown: Bool = true, removable: Bool = false) {
        self.folder = folder
        self.repo = repo
        self.shown = shown
        self.removable = removable
    }

    /// The tree's row id for this root's folder.
    var rowID: String { "dir:\(prefix)" }

    /// A repo-relative id or path as the merged diff names it.
    func global(_ local: String) -> String {
        prefix.isEmpty ? local : "\(prefix)/\(local)"
    }

    /// The repo-relative part of a merged id or path; nil when it is not under this root.
    func local(_ global: String) -> String? {
        guard !prefix.isEmpty else { return global }
        let head = prefix + "/"
        return global.hasPrefix(head) ? String(global.dropFirst(head.count)) : nil
    }

    /// A file of this root as the merged diff shows it.
    func prefixed(_ file: DiffFile) -> DiffFile {
        guard !prefix.isEmpty else { return file }
        var copy = file
        copy.id = global(file.id)
        copy.path = global(file.path)
        copy.oldPath = file.oldPath.map(global)
        return copy
    }

    /// The same roots, ignoring what the last load found: a change here needs a new load.
    func sameSetup(as other: ReviewRoot) -> Bool {
        folder == other.folder && repo == other.repo && shown == other.shown && removable == other.removable && prefix == other.prefix
    }
}

/// What a root's folder row can ask of the hub: tick or untick the root, or remove an added folder.
struct ReviewRootActions {
    var setShown: (_ folder: String, _ shown: Bool) -> Void
    var remove: (_ folder: String) -> Void
}

enum ReviewRoots {
    /// Unique top-level names for these repository paths: the folder name, and where two share it the
    /// parent's name in brackets ("notes (work)"). Never a slash, so the name is one folder of the tree.
    static func prefixes(for paths: [String]) -> [String] {
        let names = paths.map { ($0 as NSString).lastPathComponent }
        var result: [String] = []
        for (index, path) in paths.enumerated() {
            var name = names[index].isEmpty ? "root" : names[index].replacingOccurrences(of: "/", with: "-")
            if names.filter({ $0 == names[index] }).count > 1 {
                let parent = ((path as NSString).deletingLastPathComponent as NSString).lastPathComponent
                name += " (\(parent.isEmpty ? "/" : parent))"
            }
            var unique = name
            var counter = 2
            while result.contains(unique) {
                unique = "\(name) \(counter)"
                counter += 1
            }
            result.append(unique)
        }
        return result
    }

    /// Every shown root's files as one list, in root order, each under its root's prefix.
    static func merge(_ roots: [ReviewRoot]) -> [DiffFile] {
        roots.filter(\.shown).flatMap { root in root.files.map(root.prefixed) }
    }

    /// The root a merged file id or path belongs to.
    static func index(of global: String, in roots: [ReviewRoot]) -> Int? {
        if roots.count == 1 {
            return 0
        }
        let head = global.split(separator: "/", maxSplits: 1).first.map(String.init) ?? global
        return roots.firstIndex { $0.prefix == head }
    }

    /// A path as the merged diff names it: an absolute path inside a root (the deepest repository that
    /// holds it), else a path relative to the first root.
    static func global(path: String, in roots: [ReviewRoot]) -> String {
        guard path.hasPrefix("/") else {
            return roots.first?.global(path) ?? path
        }
        let owner = roots
            .filter { root in root.repo.map { path.hasPrefix($0.path + "/") } ?? false }
            .max { ($0.repo?.path.count ?? 0) < ($1.repo?.path.count ?? 0) }
        guard let owner, let repo = owner.repo else { return path }
        return owner.global(String(path.dropFirst(repo.path.count + 1)))
    }
}
