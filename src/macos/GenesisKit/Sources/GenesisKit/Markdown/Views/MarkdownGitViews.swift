//
//  MarkdownGitViews.swift
//  GenesisKit
//
//  The viewer's git surfaces built from the Diff components: the git sidebar (this file's history, the repository
//  panel), the read-only banner over a past version, and the commit sheet with notes as rendered diffs.
//

import SwiftUI

/// The git sidebar beside Files and Outline.
struct MarkdownGitSidebar: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    @ObservedObject private var repos = GitRepos.shared
    @StateObject private var fileHistory = GitHistoryModel()
    @StateObject private var repoLog = GitHistoryModel(limit: 15)
    @AppStorage("markdown.config.gitSidebarTab") private var tab = "file"

    var body: some View {
        let _ = RenderProbe.hit("md.gitSidebar")
        VStack(alignment: .leading, spacing: 0) {
            GenSegmentedTabs("Git", items: [.init("file", "This file"), .init("repo", "Repository")], selection: $tab)
                .frame(maxWidth: .infinity)
                .padding(8)
                .accessibilityIdentifier("markdown-git-tab")
            Rectangle().fill(model.theme.border).frame(height: 1)
            ScrollView {
                Group {
                    switch repos.lookup(for: doc.folder) {
                    case .pending:
                        EmptyView()
                    case .repo(let repo):
                        if tab == "file" {
                            fileTab
                        } else {
                            GitRepoPanel(
                                repo: repo,
                                log: repoLog,
                                revealPath: GitQueries.relative(doc.url, to: repo.root),
                                onOpenFile: { entry, staged in model.openChanges(entry, staged: staged, root: repo.root) },
                                onOpenCommit: { model.openCommit($0, root: repo.root) }
                            )
                        }
                    case .none:
                        Text("This file is not in a git repository.")
                            .font(.system(size: 11))
                            .foregroundColor(model.theme.textSecondary)
                    }
                }
                .padding(8)
            }
        }
        .background(model.theme.page.opacity(0.6))
        .onAppear { follow() }
        .onChange(of: doc.url) { _, _ in follow() }
    }

    private func follow() {
        fileHistory.follow(.file(doc.url))
        repoLog.follow(.repository(doc.folder))
    }

    @ViewBuilder
    private var fileTab: some View {
        if fileHistory.loaded && fileHistory.commits.isEmpty {
            Text("No commits have this file yet.")
                .font(.system(size: 11))
                .foregroundColor(model.theme.textSecondary)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                Text("Click a commit to read that version. Right-click to compare.")
                    .font(.system(size: 10))
                    .foregroundColor(model.theme.textMuted)
                GitCommitList(
                    commits: fileHistory.commits,
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
                .instantTooltip("This version becomes the unsaved text: ⌘Z takes it back, ⌘S saves it")
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
