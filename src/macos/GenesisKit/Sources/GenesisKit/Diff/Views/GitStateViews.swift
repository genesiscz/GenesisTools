//
//  GitStateViews.swift
//  GenesisKit
//
//  A file's git state as a host shows it: the badge (branch and "M · 3 lines unstaged · 1 line staged") and the
//  one-letter mark a tab or a tree row carries.
//

import SwiftUI

extension GitChangeKind {
    /// Modified orange, added green, deleted and conflicted red, renamed blue, untracked grey.
    public var color: Color {
        switch self {
        case .modified: return .genWarning
        case .added: return .genSuccess
        case .deleted, .conflicted: return .genError
        case .renamed: return Color(red: 0.45, green: 0.65, blue: 1.0)
        case .untracked: return .white.opacity(0.45)
        }
    }

    /// The word a tooltip uses.
    public var word: String {
        switch self {
        case .modified: return "modified"
        case .added: return "added"
        case .deleted: return "deleted"
        case .renamed: return "renamed"
        case .untracked: return "not in git"
        case .conflicted: return "in conflict"
        }
    }
}

/// The branch and the file's state, for a status bar. A clean file shows only the branch.
public struct GitStateBadge: View {
    let state: GitFileState
    var action: (() -> Void)?

    public init(state: GitFileState, action: (() -> Void)? = nil) {
        self.state = state
        self.action = action
    }

    public var body: some View {
        let content = HStack(spacing: 5) {
            Image(systemName: "arrow.triangle.branch")
                .font(.system(size: 8, weight: .semibold))
            Text(verbatim: state.branch)
            if let kind = state.entry?.shown {
                Text(verbatim: state.summary)
                    .foregroundColor(kind.color)
            }
        }
        .contentShape(Rectangle())
        Group {
            if let action {
                Button(action: action) { content }
                    .buttonStyle(.genHoverPlain())
            } else {
                content
            }
        }
        .instantTooltip(tooltip)
        .accessibilityIdentifier("markdown-git-state")
    }

    private var tooltip: String {
        var lines = ["\(state.path) on \(state.branch)"]
        if let kind = state.entry?.shown {
            lines.append(state.isUntracked ? "Not in git yet" : "The file is \(kind.word): \(state.summary)")
        } else {
            lines.append("No changes since the last commit")
        }
        if action != nil { lines.append("Click to see the changes") }
        return lines.joined(separator: "\n")
    }
}

/// The one letter a tab or a tree row shows for a changed file.
public struct GitChangeMark: View {
    let kind: GitChangeKind
    var size: CGFloat

    public init(_ kind: GitChangeKind, size: CGFloat = 10) {
        self.kind = kind
        self.size = size
    }

    public var body: some View {
        Text(verbatim: kind.letter)
            .font(.system(size: size, weight: .bold, design: .monospaced))
            .foregroundColor(kind.color)
            .accessibilityLabel(kind.word)
    }
}

/// The mark of one file from its repository's status (one `git status` for every tab and row); nothing while the
/// repository is looked up, for a clean file and outside a repository.
public struct GitFileMark: View {
    let file: URL
    var size: CGFloat
    @ObservedObject private var repos = GitRepos.shared

    public init(file: URL, size: CGFloat = 10) {
        self.file = file
        self.size = size
    }

    public var body: some View {
        if let model = repos.model(for: file.deletingLastPathComponent()) {
            Inner(model: model, file: file, size: size)
        }
    }

    private struct Inner: View {
        @ObservedObject var model: GitRepoModel
        let file: URL
        let size: CGFloat

        var body: some View {
            if let kind = model.status?.entry(for: file)?.shown {
                GitChangeMark(kind, size: size)
                    .instantTooltip("Git: \(kind.word)")
            }
        }
    }
}
