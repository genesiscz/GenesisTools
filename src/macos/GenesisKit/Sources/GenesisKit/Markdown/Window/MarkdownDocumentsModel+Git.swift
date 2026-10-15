//
//  MarkdownDocumentsModel+Git.swift
//  GenesisKit
//
//  What the git sidebar asks of the window: a past version of a file read-only in its tab, two versions compared in
//  the Changes mode, a changed file opened at its scope, a commit's files in a sheet.
//

import Foundation

/// A past version of a file, shown read-only in its tab.
struct MarkdownRevision: Equatable {
    let docID: String
    let commit: GitCommit
    let text: String
}

/// Two versions of a file in the Changes mode; `new` nil compares with the text on screen.
struct MarkdownRevisionCompare: Equatable {
    let docID: String
    let old: GitCommit
    let new: GitCommit?
}

/// A commit's files, in a sheet.
struct MarkdownCommitSheet: Identifiable {
    let root: URL
    let commit: GitCommit
    var id: String { commit.sha }
}

extension MarkdownDocumentsModel {
    func showsMissingFile(_ doc: MarkdownDocument) -> Bool {
        doc.missing && !doc.isDirty && mode != .changes && revisionView?.docID != doc.id
    }

    func workingText(for doc: MarkdownDocument) -> String? {
        doc.missing && !doc.isDirty ? nil : doc.displayText
    }

    /// Reads the file as `commit` had it (at its path then, across a rename) and shows it in the tab.
    func viewRevision(_ commit: GitCommit, of doc: MarkdownDocument) {
        revisionRequest += 1
        let request = revisionRequest
        revisionView = nil
        exportError = nil
        let url = doc.url
        let id = doc.id
        let provider = GenesisKitGT.provider
        DispatchQueue.global(qos: .userInitiated).async {
            let queries = GitQueries(provider: provider)
            let result = Result { () throws -> String in
                guard let root = queries.root(of: url.deletingLastPathComponent()),
                      let path = commit.path ?? GitQueries.relative(url, to: root) else {
                    throw ReviewError.notRepository(url.deletingLastPathComponent().path)
                }
                guard let text = try queries.contents(path: path, in: root, at: .commit(commit.sha)) else {
                    throw ReviewError.git("The file at \(commit.short) could not be read.")
                }
                return text
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.selectedId == id, self.revisionRequest == request else { return }
                self.revisionCompare = nil
                switch result {
                case .success(let text): self.revisionView = MarkdownRevision(docID: id, commit: commit, text: text)
                case .failure(let error): self.exportError = "Could not read revision: \(error)"
                }
            }
        }
    }

    func compareRevision(_ old: GitCommit, with new: GitCommit?, of doc: MarkdownDocument) {
        revisionRequest += 1
        revisionView = nil
        revisionCompare = MarkdownRevisionCompare(docID: doc.id, old: old, new: new)
        setMode(.changes)
    }

    /// The past version becomes the draft: one edit, so ⌘Z takes it back, and nothing is saved until ⌘S.
    func restoreRevision(_ revision: MarkdownRevision, in doc: MarkdownDocument) {
        revisionRequest += 1
        doc.edit(revision.text)
        revisionView = nil
    }

    /// A file from the repository panel, in its tab, in the Changes mode at its staged or unstaged scope.
    func openChanges(_ entry: GitStatusEntry, staged: Bool, root: URL) {
        revisionRequest += 1
        open([root.appendingPathComponent(entry.path)])
        revisionCompare = nil
        changesScope = staged ? .staged : .unstaged
        setMode(.changes)
    }

    func openCommit(_ commit: GitCommit, root: URL) {
        commitSheet = MarkdownCommitSheet(root: root, commit: commit)
    }
}
