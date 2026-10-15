//
//  GitFileDiffModel.swift
//  GenesisKit
//
//  One file's diff for a scope, as a `DiffFile` with both sides in full: the working side is the text on screen (an
//  unsaved draft included), the others come from git. Also the file's recent commits, for an "Any commit" pick.
//

import Foundation

@MainActor
public final class GitFileDiffModel: ObservableObject {
    public enum Phase: Equatable {
        case idle
        case loading
        /// Both sides are the same: nothing to show, and why.
        case empty(String)
        case ready
        case failed(String)
    }

    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var file: DiffFile?
    /// The old side's text, for a rendered diff.
    @Published public private(set) var oldText: String?
    /// The commits that changed the file, newest first.
    @Published public private(set) var history: [GitCommit] = []
    /// The commit `lastCommit` shows: the one picked, else the newest.
    @Published public private(set) var commit: GitCommit?
    private var ticket = 0
    var makeDiff: @Sendable (String, String?, String?) -> DiffFile = { GitFileDiffModel.diffFile(path: $0, old: $1, new: $2) }

    public init() {}

    /// Loads `scope` for `url`; `text` is the working side, `commit` a picked commit id for `lastCommit`.
    public func load(_ url: URL, text: String, scope: GitFileScope, commit pick: String? = nil) {
        load(url, workingText: text, scope: scope, commit: pick)
    }

    /// nil is a deleted working file; an empty String is a present empty file.
    func load(_ url: URL, workingText text: String?, scope: GitFileScope, commit pick: String? = nil) {
        ticket += 1
        let ticket = self.ticket
        if file == nil { phase = .loading }
        let provider = GenesisKitGT.provider
        let makeDiff = self.makeDiff
        DispatchQueue.global(qos: .userInitiated).async {
            let span = PerfSpans.begin("git.fileDiff", "\(scope.rawValue) \(url.lastPathComponent)")
            let result = Result { () throws -> (Sides, DiffFile?) in
                let sides = try Self.sides(url, text: text, scope: scope, pick: pick, provider: provider)
                return (sides, sides.old == sides.new ? nil : makeDiff(sides.path, sides.old, sides.new))
            }
            span.end()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket else { return }
                switch result {
                case .failure(let error):
                    self.file = nil
                    self.oldText = nil
                    self.phase = .failed("\(error)")
                case .success(let (sides, file)):
                    self.history = sides.history
                    self.commit = sides.commit
                    self.oldText = sides.old
                    if sides.old == sides.new {
                        self.file = nil
                        self.phase = .empty(sides.emptyReason)
                    } else {
                        self.file = file
                        self.phase = .ready
                    }
                }
            }
        }
    }

    /// Two versions of `url`: `old` against `new`, or against `text` when `new` is nil.
    public func loadCompare(_ url: URL, text: String, old: GitCommit, new: GitCommit?) {
        loadCompare(url, workingText: text, old: old, new: new)
    }

    func loadCompare(_ url: URL, workingText text: String?, old: GitCommit, new: GitCommit?) {
        ticket += 1
        let ticket = self.ticket
        if file == nil { phase = .loading }
        let provider = GenesisKitGT.provider
        let makeDiff = self.makeDiff
        DispatchQueue.global(qos: .userInitiated).async {
            let result = Result { () throws -> (Sides, DiffFile?) in
                let queries = GitQueries(provider: provider)
                guard let root = queries.root(of: url.deletingLastPathComponent()), let path = GitQueries.relative(url, to: root) else {
                    throw ReviewError.notRepository(url.deletingLastPathComponent().path)
                }
                let oldText = try queries.contents(path: old.path ?? path, in: root, at: .commit(old.sha))
                let newText: String?
                if let new {
                    newText = try queries.contents(path: new.path ?? path, in: root, at: .commit(new.sha))
                } else {
                    newText = text
                }
                let sides = Sides(path: path, old: oldText, new: newText, history: [], commit: nil, emptyReason: "The two versions are the same.")
                return (sides, oldText == newText ? nil : makeDiff(path, oldText, newText))
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.ticket == ticket else { return }
                switch result {
                case .failure(let error):
                    self.file = nil
                    self.oldText = nil
                    self.phase = .failed("\(error)")
                case .success(let (sides, file)):
                    self.oldText = sides.old
                    if sides.old == sides.new {
                        self.file = nil
                        self.phase = .empty("The two versions are the same.")
                    } else {
                        self.file = file
                        self.phase = .ready
                    }
                }
            }
        }
    }

    struct Sides {
        var path: String
        var old: String?
        var new: String?
        var history: [GitCommit]
        var commit: GitCommit?
        var emptyReason: String
    }

    nonisolated static func sides(_ url: URL, text: String?, scope: GitFileScope, pick: String?, provider: GenesisKitGTProvider) throws -> Sides {
        let queries = GitQueries(provider: provider)
        guard let root = queries.root(of: url.deletingLastPathComponent()), let path = GitQueries.relative(url, to: root) else {
            throw ReviewError.notRepository(url.deletingLastPathComponent().path)
        }
        let history = (try? provider.history(of: url, limit: 30)) ?? []
        func at(_ revision: GitRevision, path: String = path) throws -> String? {
            try queries.contents(path: path, in: root, at: revision)
        }
        switch scope {
        case .unstaged:
            let index = try at(.index)
            return Sides(path: path, old: index, new: text, history: history, commit: nil, emptyReason: "No unstaged changes in this file.")
        case .staged:
            return Sides(path: path, old: try at(.head), new: try at(.index), history: history, commit: nil, emptyReason: "Nothing of this file is staged.")
        case .uncommitted:
            return Sides(path: path, old: try at(.head), new: text, history: history, commit: nil, emptyReason: "No changes since the last commit.")
        case .lastCommit:
            let picked = try pick.map { try queries.pickedCommit($0, of: url, in: root) }
            guard let commit = picked ?? history.first else {
                return Sides(path: path, old: nil, new: nil, history: history, commit: nil, emptyReason: "This file has no commits yet.")
            }
            // The file's path in that commit, for a history that crossed a rename.
            let then = commit.path ?? path
            let new = try at(.commit(commit.sha), path: then)
            let old = try at(.commit("\(commit.sha)^"), path: then)
            return Sides(path: then, old: old, new: new, history: history, commit: commit, emptyReason: "The commit did not change this file.")
        case .branch:
            let base = GitWorkingTreeSource(repo: root).baseBranch()
            let mergeBase = try provider.git(["merge-base", "HEAD", base], in: root, input: nil, gitDirectory: nil, environment: nil)
            guard mergeBase.status == 0 else {
                throw ReviewError.git("no merge base with \(base)")
            }
            let sha = String(decoding: mergeBase.stdout, as: UTF8.self).trimmed
            return Sides(path: path, old: try at(.commit(sha)), new: text, history: history, commit: nil, emptyReason: "This branch has not changed this file since \(base).")
        }
    }

    nonisolated static func diffFile(path: String, old: String?, new: String?) -> DiffFile {
        let counts = GitWorkingTreeSource.lineCounts(old: old ?? "", new: new ?? "")
        let status: DiffFile.Status = old == nil ? .added : (new == nil ? .deleted : .modified)
        return DiffFile(id: path, path: path, oldPath: nil, status: status, additions: counts.additions, deletions: counts.deletions,
                        oldContents: old, newContents: new, skipped: nil)
    }
}
