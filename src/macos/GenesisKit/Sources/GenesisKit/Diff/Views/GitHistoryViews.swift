//
//  GitHistoryViews.swift
//  GenesisKit
//
//  The git sidebar's parts, each usable alone: a commit list (a file's history or a repository's log), the
//  repository panel (branch, ahead and behind, staged and unstaged files, recent commits), and a commit's files with
//  their diffs.
//

import SwiftUI

/// Commits newest first: short id, subject, author and age. A click opens one; the context menu, a button on the
/// hovered or keyed row and the C key compare. With the keyboard in the list, Up and Down move, Return opens, C
/// compares with the current text and Esc clears.
public struct GitCommitList: View {
    let commits: [GitCommit]
    var selected: String?
    var onOpen: (GitCommit) -> Void
    var onCompare: ((GitCommit) -> Void)?
    var onCompareWithSelected: ((GitCommit) -> Void)?
    /// The row the keys move, apart from the open commit (`selected`).
    @State private var keyed: String?
    @State private var hovered: String?
    @FocusState private var focused: Bool

    public init(commits: [GitCommit], selected: String? = nil, onOpen: @escaping (GitCommit) -> Void,
                onCompare: ((GitCommit) -> Void)? = nil, onCompareWithSelected: ((GitCommit) -> Void)? = nil) {
        self.commits = commits
        self.selected = selected
        self.onOpen = onOpen
        self.onCompare = onCompare
        self.onCompareWithSelected = onCompareWithSelected
    }

    public var body: some View {
        ScrollViewReader { proxy in
            LazyVStack(alignment: .leading, spacing: 1) {
                ForEach(commits) { commit in
                    row(commit)
                        .id(commit.sha)
                }
            }
            .focusable()
            .focused($focused)
            .focusEffectDisabled()
            .onKeyPress(.upArrow, phases: [.down, .repeat]) { _ in move(-1, proxy) }
            .onKeyPress(.downArrow, phases: [.down, .repeat]) { _ in move(1, proxy) }
            .onKeyPress(.return) {
                guard let commit = keyedCommit else { return .ignored }
                onOpen(commit)
                return .handled
            }
            .onKeyPress(characters: CharacterSet(charactersIn: "c")) { press in
                guard press.modifiers.isEmpty, let onCompare, let commit = keyedCommit else { return .ignored }
                onCompare(commit)
                return .handled
            }
            .onKeyPress(.escape) {
                guard keyed != nil else { return .ignored }
                keyed = nil
                return .handled
            }
        }
    }

    private var keyedCommit: GitCommit? {
        keyed.flatMap { sha in commits.first { $0.sha == sha } }
    }

    private func move(_ step: Int, _ proxy: ScrollViewProxy) -> KeyPress.Result {
        GitHistoryKeys.move(commits.map(\.sha), from: keyed ?? selected, by: step) { id in
            keyed = id
            proxy.scrollTo(id)
        }
    }

    private func row(_ commit: GitCommit) -> some View {
        let open = commit.sha == selected
        let showsCompare = onCompare != nil && (hovered == commit.sha || (focused && keyed == commit.sha))
        return HStack(spacing: 0) {
            Button {
                keyed = commit.sha
                onOpen(commit)
            } label: {
                GitCommitRow(commit: commit, selected: open)
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 5))
            .accessibilityAddTraits(open ? .isSelected : [])
            .accessibilityAction(named: "Copy commit id") { Clipboard.copy(commit.sha, what: "commit id") }
            .accessibilityActions {
                if let onCompare {
                    Button("Compare with the current text") { onCompare(commit) }
                }
                if let onCompareWithSelected, let selected, selected != commit.sha {
                    Button("Compare with the selected commit") { onCompareWithSelected(commit) }
                }
            }
            if let onCompare {
                // Space kept while hidden, so the row's text does not reflow under the pointer.
                IconButton(systemName: "arrow.left.arrow.right", tooltip: "Compare with the current text (C)", size: 10.5, tint: .secondary) {
                    onCompare(commit)
                }
                .opacity(showsCompare ? 1 : 0)
                .allowsHitTesting(showsCompare)
                .accessibilityHidden(true)
                .frame(width: 24)
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 5)
                .strokeBorder(Color.accentColor.opacity(focused && keyed == commit.sha ? 0.8 : 0), lineWidth: 1.5)
                .allowsHitTesting(false)
        )
        .onHover { inside in
            if inside { hovered = commit.sha } else if hovered == commit.sha { hovered = nil }
        }
        .contextMenu {
            if let onCompare {
                Button("Compare with the current text") { onCompare(commit) }
            }
            if let onCompareWithSelected, let selected, selected != commit.sha {
                Button("Compare with the selected commit") { onCompareWithSelected(commit) }
            }
            Button("Copy commit id") { Clipboard.copy(commit.sha, what: "commit id") }
        }
        .accessibilityIdentifier("git-commit-\(commit.short)")
    }
}

/// A key step selects and reveals one identity, including rows not created by the lazy stack yet.
enum GitHistoryKeys {
    static func move(_ ids: [String], from current: String?, by step: Int, selectAndReveal: (String) -> Void) -> KeyPress.Result {
        guard !ids.isEmpty else { return .ignored }
        let start = ids.firstIndex { $0 == current }
        let index = start.map { min(max($0 + step, 0), ids.count - 1) } ?? (step > 0 ? 0 : ids.count - 1)
        selectAndReveal(ids[index])
        return .handled
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
                    .font(.system(size: 11, design: .monospaced))
                Text(verbatim: commit.author)
                    .lineLimit(1)
                Spacer(minLength: 4)
                LiveAgo(date: commit.date, style: .brief)
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(selected ? Color.accentColor.opacity(0.14) : Color.clear)
        .clipShape(RoundedRectangle(cornerRadius: 5))
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
    @State private var failure: GitFailure?
    @State private var loaded = false
    @State private var attempt = 0
    @FocusState private var filesFocused: Bool

    public init(root: URL, commit: GitCommit, rendered: ((DiffFile) -> AnyView?)? = nil) {
        self.root = root
        self.commit = commit
        self.rendered = rendered
    }

    public var body: some View {
        HStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 1) {
                        ForEach(files) { file in
                            Button {
                                picked = file.id
                                filesFocused = true
                            } label: {
                                HStack(spacing: 6) {
                                    GitChangeMark(Self.kind(file.status))
                                    Text(verbatim: file.name)
                                        .font(.system(size: 11.5, weight: picked == file.id ? .semibold : .regular))
                                        .lineLimit(1)
                                    Spacer(minLength: 4)
                                    GitLineCounts(additions: file.additions, deletions: file.deletions, size: 11)
                                }
                                .padding(.horizontal, 8)
                                .padding(.vertical, 4)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(RoundedRectangle(cornerRadius: 5).fill(Color.accentColor.opacity(picked == file.id ? 0.14 : 0)))
                            }
                            .buttonStyle(RowButtonStyle(cornerRadius: 5))
                            // The keyboard's place is the picked row's own ring: the system focus ring around the padded
                            // list was clipped by the scroll view and sat off the rows (Martin, 2026-10-25).
                            .overlay(
                                RoundedRectangle(cornerRadius: 5)
                                    .strokeBorder(Color.accentColor.opacity(filesFocused && picked == file.id ? 0.8 : 0), lineWidth: 1.5)
                                    .allowsHitTesting(false)
                            )
                            .instantTooltip(file.path, monospaced: true)
                            .accessibilityAddTraits(picked == file.id ? .isSelected : [])
                            .id(file.id)
                        }
                    }
                    .padding(6)
                    // Up and Down pick the file before or after: the diff beside follows.
                    .focusable()
                    .focused($filesFocused)
                    .focusEffectDisabled()
                    .onKeyPress(.upArrow, phases: [.down, .repeat]) { _ in step(-1, proxy) }
                    .onKeyPress(.downArrow, phases: [.down, .repeat]) { _ in step(1, proxy) }
                }
            }
            .frame(width: 240)
            Divider()
            Group {
                if let failure {
                    GitFailureNotice(failure) {
                        self.failure = nil
                        loaded = false
                        attempt += 1
                    }
                    .padding(16)
                } else if let file = files.first(where: { $0.id == picked }) {
                    if let custom = rendered?(file) {
                        custom
                    } else {
                        GitDiffView(files: [file], options: DiffViewOptions(diffStyle: .unified, wrap: true))
                    }
                } else if loaded {
                    Text("This commit changed no files.").foregroundStyle(.secondary)
                } else {
                    HStack(spacing: 6) {
                        ProgressView().controlSize(.small)
                        Text("Reading the commit")
                    }
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .task(id: "\(commit.sha) \(attempt)") { await load() }
    }

    private func step(_ by: Int, _ proxy: ScrollViewProxy) -> KeyPress.Result {
        GitHistoryKeys.move(files.map(\.id), from: picked, by: by) { id in
            picked = id
            proxy.scrollTo(id)
        }
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
        case .failure(let error):
            failure = GitFailure(error, fallback: "Git could not read this commit. Try again.")
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
