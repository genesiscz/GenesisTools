import Foundation

/// The review's files by id and by path, built once per change of its files or roots (`ReviewModel.lookup`).
/// The file list asks `locate`, `repoPath` and `pathActions` for every row it draws, and the Folders tree asks
/// `file(atPath:)` for every row it draws. Each of those was a search over every file, so one publish of the model
/// cost rows × files (at 4995 rows, dictionaries cut an unrelated publish from 839 to 572 ms, 2026-10-23 file tree
/// comparison). Every answer is the one the searches gave: where two files share an id or a path, the first wins.
struct ReviewFileLookup {
    /// The roots the lookup was built from: `ReviewRoots.index` picks a merged id's root among them.
    private let roots: [ReviewRoot]
    /// Per root, in root order: its files by their repo-relative id, as `ReviewRoot.files` holds them.
    private let rootFiles: [[String: DiffFile]]
    /// The merged files by path and by old path, as `ReviewModel.files` holds them.
    private let byPath: [String: DiffFile]
    /// Merged file ids by the path their own repository names them with (`repoPath(of:)`): the drafts badges.
    private let idsByRepoPath: [String: [String]]

    init(files: [DiffFile], roots: [ReviewRoot]) {
        self.roots = roots
        let rootFiles = roots.map { root in
            var byID: [String: DiffFile] = [:]
            for file in root.files where byID[file.id] == nil {
                byID[file.id] = file
            }
            return byID
        }
        self.rootFiles = rootFiles

        var byPath: [String: DiffFile] = [:]
        var idsByRepoPath: [String: [String]] = [:]
        for file in files {
            if byPath[file.path] == nil {
                byPath[file.path] = file
            }
            if let old = file.oldPath, byPath[old] == nil {
                byPath[old] = file
            }
            if let found = Self.locate(file.id, roots: roots, rootFiles: rootFiles) {
                idsByRepoPath[found.file.path, default: []].append(file.id)
            }
        }
        self.byPath = byPath
        self.idsByRepoPath = idsByRepoPath
    }

    /// A merged file id's root, and the file as its repository names it.
    func locate(fileID: String) -> (root: ReviewRoot, file: DiffFile)? {
        Self.locate(fileID, roots: roots, rootFiles: rootFiles)
    }

    /// The merged file whose path or old path is `path` (a path as the merged diff names it).
    func file(atMergedPath path: String) -> DiffFile? {
        byPath[path]
    }

    /// The merged ids of the files that their own repository names `path`.
    func ids(repoPath path: String) -> [String] {
        idsByRepoPath[path] ?? []
    }

    private static func locate(_ fileID: String, roots: [ReviewRoot], rootFiles: [[String: DiffFile]]) -> (root: ReviewRoot, file: DiffFile)? {
        guard let index = ReviewRoots.index(of: fileID, in: roots), let local = roots[index].local(fileID),
              let file = rootFiles[index][local] else { return nil }
        return (roots[index], file)
    }
}
