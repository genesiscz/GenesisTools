//
//  MarkdownGitViews.swift
//  GenesisKit
//
//  The viewer's git surfaces built from the Diff components: the git sidebar (this file's history, the repository
//  panel), the read-only banner over a past version, and the commit sheet with notes as rendered diffs.
//

import SwiftUI

/// The git sidebar beside Files and Outline. `Equatable` on the document, the model's identity and the theme: it
/// observes the document and the repositories itself, so a publish of the window's model (a heading report, a tab
/// switch) no longer runs it, and with it the repository panel (+13.9 ms per publish on a vault, 2026-10-25).
struct MarkdownGitSidebar: View, Equatable {
    @ObservedObject var doc: MarkdownDocument
    let model: MarkdownDocumentsModel
    let theme: MarkdownTheme
    @ObservedObject private var repos = GitRepos.shared
    @StateObject private var fileHistory = GitHistoryModel()
    @StateObject private var repoLog = GitHistoryModel(limit: 50)
    @AppStorage("markdown.config.gitSidebarTab") private var tab = "file"
    /// The last repository the Repository tab showed: a tab outside any repository keeps it on screen rather than
    /// blanking the panel (Martin, 2026-10-25).
    @State private var lastRepo: GitRepoModel?

    static func == (lhs: MarkdownGitSidebar, rhs: MarkdownGitSidebar) -> Bool {
        lhs.doc === rhs.doc && lhs.model === rhs.model && lhs.theme == rhs.theme
    }

    var body: some View {
        let _ = RenderProbe.hit("md.gitSidebar")
        VStack(alignment: .leading, spacing: 0) {
            // Changes keeps the stored value "repo" of the former Repository tab, so a saved choice still lands on it.
            GenSegmentedTabs("Git", items: [.init("file", "This file"), .init("repo", "Changes"), .init("commits", "Commits")],
                             selection: $tab)
                .frame(maxWidth: .infinity)
                .padding(8)
                .accessibilityIdentifier("markdown-git-tab")
            Rectangle().fill(theme.border).frame(height: 1)
            if tab == "repo" {
                // The panel's rows scroll in their own table; a scroll view around it would lay the window out again.
                repoTab
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else if tab == "commits" {
                ScrollView {
                    commitsTab
                        .padding(8)
                }
            } else {
                ScrollView {
                    fileTab
                        .padding(8)
                }
            }
        }
        .background(theme.page.opacity(0.6))
        .onAppear { follow() }
        .onChange(of: doc.url) { _, _ in follow() }
    }

    @ViewBuilder
    private var repoTab: some View {
        switch repos.lookup(for: doc.folder) {
        case .pending:
            if let lastRepo { repoPanel(lastRepo, revealPath: nil) }
        case .repo(let repo):
            repoPanel(repo, revealPath: GitQueries.relative(doc.url, to: repo.root))
                .onAppear { lastRepo = repo }
                .onChange(of: repo.root) { _, _ in lastRepo = repo }
        case .none:
            VStack(alignment: .leading, spacing: 4) {
                notInGit
                if let lastRepo {
                    Text(verbatim: "Showing \(lastRepo.root.lastPathComponent), the last repository.")
                        .font(.system(size: 11))
                        .foregroundColor(theme.textSecondary)
                        .padding(.horizontal, 8)
                    repoPanel(lastRepo, revealPath: nil)
                }
            }
        }
    }

    @ViewBuilder
    private var fileTab: some View {
        switch repos.lookup(for: doc.folder) {
        case .pending:
            EmptyView()
        case .repo:
            MarkdownGitFileHistory(doc: doc, model: model, history: fileHistory)
        case .none:
            notInGit
        }
    }

    /// The repository's recent commits; a click opens one in a sheet.
    @ViewBuilder
    private var commitsTab: some View {
        switch repos.lookup(for: doc.folder) {
        case .pending:
            EmptyView()
        case .repo(let repo):
            if repoLog.loaded && repoLog.commits.isEmpty {
                Text("No commits yet.")
                    .font(.system(size: 11))
                    .foregroundColor(theme.textSecondary)
            } else {
                GitCommitList(commits: repoLog.commits, onOpen: { [model] in model.openCommit($0, root: repo.root) })
            }
        case .none:
            notInGit
        }
    }

    private var notInGit: some View {
        Text("This file is not in a git repository.")
            .font(.system(size: 11))
            .foregroundColor(theme.textSecondary)
            .padding(tab == "file" ? 0 : 8)
    }

    private func repoPanel(_ repo: GitRepoModel, revealPath: String?) -> some View {
        GitRepoPanel(
            repo: repo,
            revealPath: revealPath,
            onOpenFile: { [model] entry, staged in model.openChanges(entry, staged: staged, root: repo.root) }
        )
        .equatable()
    }

    private func follow() {
        fileHistory.follow(.file(doc.url))
        repoLog.follow(.repository(doc.folder))
    }
}

/// This file's commits. It observes the window's model (the version shown in the tab), so it lives apart from the
/// sidebar, which does not.
private struct MarkdownGitFileHistory: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    @ObservedObject var history: GitHistoryModel

    var body: some View {
        if let failure = history.failure {
            GitFailureNotice(failure) { history.reload() }
        }
        if history.failure == nil && history.loaded && history.commits.isEmpty {
            Text("No commits have this file yet.")
                .font(.system(size: 11))
                .foregroundColor(model.theme.textSecondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Click a commit to read that version. Right-click it, or press C, to compare.")
                    .font(.system(size: 11))
                    .foregroundColor(model.theme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
                GitCommitList(
                    commits: history.commits,
                    selected: model.revisionView.flatMap { $0.docID == doc.id ? $0.commit.sha : nil },
                    onOpen: { model.viewRevision($0, of: doc) },
                    onCompare: { model.compareRevision($0, with: nil, of: doc) },
                    onCompareWithSelected: { picked in
                        guard let shown = model.revisionView?.commit else { return }
                        // Older first, so the diff reads forward in time.
                        let (old, new) = picked.date <= shown.date ? (picked, shown) : (shown, picked)
                        model.compareRevision(old, with: new, of: doc)
                    }
                )
            }
        }
    }
}

/// The bar over a past version shown in its tab.
struct MarkdownRevisionBanner: View {
    let revision: MarkdownRevision
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    /// Observed so a key changed in Keyboard Shortcuts redraws the restore tooltip.
    @ObservedObject private var keymap = MarkdownKeymap.shared

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath")
            Text(verbatim: "Viewing \(revision.commit.short)")
                .font(.system(size: 11.5, weight: .semibold))
            Text(verbatim: revision.commit.subject)
                .lineLimit(1)
                .foregroundColor(model.theme.textSecondary)
            LiveAgo(date: revision.commit.date, style: .brief)
                .foregroundColor(model.theme.textSecondary)
            Spacer(minLength: 8)
            Button("Compare with current") { model.compareRevision(revision.commit, with: nil, of: doc) }
                .accessibilityIdentifier("markdown-revision-compare")
            Button("Restore") { model.restoreRevision(revision, in: doc) }
                .instantTooltip(
                    "This version becomes the unsaved text: \(keymap.label(for: "markdown.edit.undo") ?? "") takes it back, "
                        + "\(keymap.label(for: "markdown.file.save") ?? "") saves it")
                .accessibilityIdentifier("markdown-revision-restore")
            Button("Close") { model.revisionView = nil }
                .accessibilityIdentifier("markdown-revision-close")
        }
        .buttonStyle(.genHoverPlain())
        .font(.system(size: 11))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(model.theme.accent.opacity(0.12))
    }
}

/// A commit's files in a sheet: notes as rendered diffs, other files as code diffs.
struct MarkdownCommitSheetView: View {
    let sheet: MarkdownCommitSheet
    @ObservedObject var model: MarkdownDocumentsModel
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Text(verbatim: sheet.commit.short)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(model.theme.textSecondary)
                Text(verbatim: sheet.commit.subject)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(verbatim: sheet.commit.author)
                    .foregroundColor(model.theme.textSecondary)
                LiveAgo(date: sheet.commit.date, style: .brief)
                    .foregroundColor(model.theme.textSecondary)
                Spacer(minLength: 8)
                Button("Copy id") { Clipboard.copy(sheet.commit.sha, what: "commit id") }
                Button("Close") { dismiss() }
                    .keyboardShortcut(.cancelAction)
            }
            .buttonStyle(.genHoverPlain())
            .font(.system(size: 11))
            .padding(12)
            Rectangle().fill(model.theme.border).frame(height: 1)
            GitCommitView(root: sheet.root, commit: sheet.commit) { file in
                guard file.path.lowercased().hasSuffix(".md"), let new = file.newContents else { return nil }
                return AnyView(MarkdownRenderedDiff(old: file.oldContents ?? "", new: new) { marks in
                    MarkdownWebView(
                        markdown: new,
                        scrollTarget: nil,
                        highlightQuery: nil,
                        highlightToken: 0,
                        onWikilink: { _ in },
                        onActiveSection: { _ in },
                        zoom: model.zoom,
                        cssVariables: model.theme.cssVariables,
                        columnResizable: false,
                        diffMarks: marks,
                        documentURL: sheet.root.appendingPathComponent(file.path),
                        vaultRoot: GenesisKit.host?.markdownVaultRoot
                    )
                })
            }
        }
        .frame(minWidth: 980, idealWidth: 1100, minHeight: 620, idealHeight: 720)
        .background(model.theme.page)
    }
}
