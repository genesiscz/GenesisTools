//
//  GitHistoryViews.swift
//  GenesisKit
//
//  The git sidebar's parts, each usable alone: a commit list (a file's history or a repository's log), the
//  repository panel (branch, ahead and behind, staged and unstaged files, recent commits), and a commit's files with
//  their diffs.
//

import SwiftUI

/// Commits newest first: short id, subject, author and age. A click opens one; the context menu compares.
public struct GitCommitList: View {
    let commits: [GitCommit]
    var selected: String?
    var onOpen: (GitCommit) -> Void
    var onCompare: ((GitCommit) -> Void)?
    var onCompareWithSelected: ((GitCommit) -> Void)?

    public init(commits: [GitCommit], selected: String? = nil, onOpen: @escaping (GitCommit) -> Void,
                onCompare: ((GitCommit) -> Void)? = nil, onCompareWithSelected: ((GitCommit) -> Void)? = nil) {
        self.commits = commits
        self.selected = selected
        self.onOpen = onOpen
        self.onCompare = onCompare
        self.onCompareWithSelected = onCompareWithSelected
    }

    public var body: some View {
        LazyVStack(alignment: .leading, spacing: 1) {
            ForEach(commits) { commit in
                Button {
                    onOpen(commit)
                } label: {
                    GitCommitRow(commit: commit, selected: commit.sha == selected)
                }
                .buttonStyle(RowButtonStyle(cornerRadius: 5))
                .contextMenu {
                    if let onCompare {
                        Button("Compare with the current text") { onCompare(commit) }
                    }
                    if let onCompareWithSelected, let selected, selected != commit.sha {
                        Button("Compare with the selected commit") { onCompareWithSelected(commit) }
                    }
                    Button("Copy commit id") { Clipboard.copy(commit.sha) }
                }
                .accessibilityIdentifier("git-commit-\(commit.short)")
            }
        }
    }
}

struct GitCommitRow: View {
    let commit: GitCommit
    let selected: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: commit.subject)
                .font(.system(size: 11.5, weight: selected ? .semibold : .regular))
                .lineLimit(2)
            HStack(spacing: 6) {
                Text(verbatim: commit.short)
                    .font(.system(size: 10, design: .monospaced))
                Text(verbatim: commit.author)
                    .lineLimit(1)
                Spacer(minLength: 4)
                LiveAgo(date: commit.date, style: .brief)
            }
            .font(.system(size: 10))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.14) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

/// A repository at a glance: branch with ahead and behind, the staged and the unstaged files, recent commits.
public struct GitRepoPanel: View {
    @ObservedObject var repo: GitRepoModel
    @ObservedObject var log: GitHistoryModel
    var onOpenFile: (GitStatusEntry, _ staged: Bool) -> Void
    var onOpenCommit: (GitCommit) -> Void

    public init(repo: GitRepoModel, log: GitHistoryModel, onOpenFile: @escaping (GitStatusEntry, Bool) -> Void,
                onOpenCommit: @escaping (GitCommit) -> Void) {
        self.repo = repo
        self.log = log
        self.onOpenFile = onOpenFile
        self.onOpenCommit = onOpenCommit
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let status = repo.status {
                HStack(spacing: 6) {
                    Image(systemName: "arrow.triangle.branch")
                    Text(verbatim: status.branch)
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                    if status.ahead > 0 { Text(verbatim: "↑\(status.ahead)").foregroundStyle(.secondary) }
                    if status.behind > 0 { Text(verbatim: "↓\(status.behind)").foregroundStyle(.secondary) }
                }
                .font(.system(size: 11))
                .instantTooltip(status.upstream.map { "Tracks \($0)" } ?? "No upstream branch")
                group("Staged", status.staged, staged: true)
                group("Changes", status.unstaged, staged: false)
                if status.entries.isEmpty {
                    Text("No uncommitted changes.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            if !log.commits.isEmpty {
                Text("Recent commits")
                    .kicker()
                GitCommitList(commits: log.commits, onOpen: onOpenCommit)
            }
        }
    }

    @ViewBuilder
    private func group(_ title: String, _ entries: [GitStatusEntry], staged: Bool) -> some View {
        if !entries.isEmpty {
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: "\(title) · \(entries.count)")
                    .kicker()
                ForEach(entries) { entry in
                    Button {
                        onOpenFile(entry, staged)
                    } label: {
                        HStack(spacing: 6) {
                            if let kind = staged ? entry.staged : entry.unstaged {
                                GitChangeMark(kind)
                            }
                            Text(verbatim: (entry.path as NSString).lastPathComponent)
                                .font(.system(size: 11.5))
                                .lineLimit(1)
                            Text(verbatim: (entry.path as NSString).deletingLastPathComponent)
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                                .truncationMode(.head)
                            Spacer(minLength: 0)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(RowButtonStyle(cornerRadius: 5))
                    .instantTooltip(entry.path)
                }
            }
        }
    }
}

/// One commit's files on the left, the picked file's diff on the right; `rendered` may draw a file its own way
/// (the markdown viewer renders a note).
public struct GitCommitView: View {
    let root: URL
    let commit: GitCommit
    var rendered: ((DiffFile) -> AnyView?)?
    @State private var files: [DiffFile] = []
    @State private var picked: String?
    @State private var error: String?
    @State private var loaded = false

    public init(root: URL, commit: GitCommit, rendered: ((DiffFile) -> AnyView?)? = nil) {
        self.root = root
        self.commit = commit
        self.rendered = rendered
    }

    public var body: some View {
        HStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 1) {
                    ForEach(files) { file in
                        Button {
                            picked = file.id
                        } label: {
                            HStack(spacing: 6) {
                                GitChangeMark(Self.kind(file.status))
                                Text(verbatim: file.name)
                                    .font(.system(size: 11.5, weight: picked == file.id ? .semibold : .regular))
                                    .lineLimit(1)
                                Spacer(minLength: 4)
                                Text(verbatim: "+\(file.additions) −\(file.deletions)")
                                    .font(.system(size: 10, design: .monospaced))
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .buttonStyle(RowButtonStyle(cornerRadius: 5))
                        .instantTooltip(file.path)
                    }
                }
                .padding(6)
            }
            .frame(width: 240)
            Divider()
            Group {
                if let error {
                    Text(verbatim: error).foregroundStyle(.secondary)
                } else if let file = files.first(where: { $0.id == picked }) {
                    if let custom = rendered?(file) {
                        custom
                    } else {
                        GitDiffView(files: [file], options: DiffViewOptions(diffStyle: .unified, wrap: true))
                    }
                } else if loaded {
                    Text("This commit changed no files.").foregroundStyle(.secondary)
                } else {
                    ProgressView().controlSize(.small)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: commit.sha) { await load() }
    }

    private func load() async {
        let root = self.root
        let sha = commit.sha
        let title = commit.subject
        let result = await Task.detached(priority: .userInitiated) {
            Result { try GitWorkingTreeSource(repo: root).load(scope: .commit(sha: sha, title: title)).files }
        }.value
        switch result {
        case .success(let files):
            self.files = files
            picked = files.first?.id
        case .failure(let failure):
            error = "\(failure)"
        }
        loaded = true
    }

    static func kind(_ status: DiffFile.Status) -> GitChangeKind {
        switch status {
        case .added: return .added
        case .modified: return .modified
        case .deleted: return .deleted
        case .renamed: return .renamed
        }
    }
}
