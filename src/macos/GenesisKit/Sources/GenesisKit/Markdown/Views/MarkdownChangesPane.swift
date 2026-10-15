//
//  MarkdownChangesPane.swift
//  GenesisKit
//
//  The viewer's fourth mode: the open file's diff for a scope (GitScopePicker), as lines (GitDiffView, split or
//  unified) or, for a note, rendered: the note with its added blocks green and its removed text struck through.
//  It reloads when the repository changes (a stage, a commit) and when the text on screen does.
//

import SwiftUI

struct MarkdownChangesPane: View {
    @ObservedObject var doc: MarkdownDocument
    @ObservedObject var model: MarkdownDocumentsModel
    @ObservedObject private var configuration = GenesisKitMarkdownConfiguration.shared
    @ObservedObject private var repos = GitRepos.shared
    @StateObject private var diff = GitFileDiffModel()
    @StateObject private var blame = AgentBlameModel()
    @AppStorage("markdown.config.changesRendered") private var rendered = true
    @AppStorage("markdown.config.changesUnified") private var unified = false
    @State private var follower: GitRepoFollower?

    private var currentScope: GitFileScope { model.changesScope ?? configuration.gitDefaultScope }
    /// Two versions picked in the git sidebar, when they are this file's.
    private var compare: MarkdownRevisionCompare? {
        model.revisionCompare.flatMap { $0.docID == doc.id ? $0 : nil }
    }
    private var isNote: Bool { DocumentPreview.presentation(for: doc.url) == .markdown }
    /// Attribution on the line diff: the setting is on, the new side is the file on disk, and it has no draft.
    private var blameShows: Bool {
        configuration.gitShows(\.gitAgentAttribution) && compare == nil && !doc.isDirty
            && [.unstaged, .uncommitted, .branch].contains(currentScope)
    }

    var body: some View {
        VStack(spacing: 0) {
            if repos.model(for: doc.folder) == nil {
                notInGit
            } else {
                header
                Rectangle().fill(model.theme.border).frame(height: 1)
                content
            }
        }
        .background(model.theme.page)
        .onAppear {
            load()
            let follower = GitRepoFollower(skipFirst: true) { load() }
            follower.follow(doc.url)
            self.follower = follower
        }
        .onChange(of: model.changesScope) { _, _ in load() }
        .onChange(of: model.changesCommit) { _, _ in load() }
        .onChange(of: model.revisionCompare) { _, _ in load() }
        .onChange(of: doc.displayText) { _, _ in load() }
        .onChange(of: repos.revision) { _, _ in load() }
    }

    private func load() {
        blame.follow(blameShows ? doc.url : nil)
        if let compare {
            diff.loadCompare(doc.url, text: doc.displayText, old: compare.old, new: compare.new)
        } else {
            diff.load(doc.url, text: doc.displayText, scope: currentScope, commit: currentScope == .lastCommit ? model.changesCommit : nil)
        }
    }

    private var header: some View {
        HStack(spacing: 10) {
            if let compare {
                Image(systemName: "arrow.left.arrow.right")
                Text(verbatim: "\(compare.old.short) → \(compare.new?.short ?? "the current text")")
                    .font(.system(size: 11, weight: .semibold))
                Button("Done") { model.revisionCompare = nil }
                    .buttonStyle(.genHoverPlain())
                    .accessibilityIdentifier("markdown-compare-done")
            } else {
                GitScopePicker(
                    scope: Binding(get: { currentScope }, set: { model.changesScope = $0 }),
                    commit: $model.changesCommit,
                    history: diff.history,
                    shown: diff.commit
                )
            }
            if let file = diff.file {
                Text(verbatim: "+\(file.additions) −\(file.deletions)")
                    .font(GenTypography.mono(10.5))
                    .foregroundColor(model.theme.textSecondary)
            }
            Spacer(minLength: 8)
            if isNote {
                Picker("View", selection: $rendered) {
                    Text("Rendered").tag(true)
                    Text("Lines").tag(false)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .instantTooltip("Rendered: the note with its changes marked · Lines: the source diff")
                .accessibilityIdentifier("markdown-changes-rendered")
            }
            if !isNote || !rendered {
                Picker("Layout", selection: $unified) {
                    Text("Split").tag(false)
                    Text("Unified").tag(true)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                .accessibilityIdentifier("markdown-changes-layout")
            }
        }
        .font(.system(size: 11))
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private var content: some View {
        switch diff.phase {
        case .idle, .loading:
            ProgressView()
                .controlSize(.small)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .empty(let reason):
            message(reason, systemImage: "checkmark.circle")
        case .failed(let error):
            message(error, systemImage: "exclamationmark.triangle")
        case .ready:
            if let file = diff.file {
                if isNote && rendered {
                    renderedDiff(file)
                } else {
                    GitDiffView(
                        files: [file],
                        options: DiffViewOptions(diffStyle: unified ? .unified : .split, wrap: true, fontSize: 12 * model.zoom),
                        blame: blameShows ? blame.state.payload : nil,
                        onBlameOpen: { index in blame.state.source(at: index).map(AgentBlame.open) }
                    )
                }
            }
        }
    }

    /// The new side rendered, with the changes against the old side marked.
    private func renderedDiff(_ file: DiffFile) -> some View {
        let new = file.newContents ?? ""
        return MarkdownWebView(
            markdown: new,
            scrollTarget: nil,
            highlightQuery: nil,
            highlightToken: 0,
            onWikilink: { model.follow($0, from: doc) },
            onActiveSection: { _ in },
            onRelativeLink: { model.follow($0, from: doc) },
            zoom: model.zoom,
            cssVariables: model.theme.cssVariables,
            articleWidth: model.articleWidth <= 0 ? nil : model.articleWidth,
            columnResizable: false,
            diffMarks: MarkdownWebView.DiffMark.between(old: diff.oldText ?? "", new: new),
            documentURL: doc.url,
            vaultRoot: GenesisKit.host?.markdownVaultRoot
        )
    }

    private func message(_ text: String, systemImage: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 22, weight: .light))
            Text(verbatim: text)
                .font(.system(size: 12))
                .multilineTextAlignment(.center)
        }
        .foregroundColor(model.theme.textSecondary)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var notInGit: some View {
        VStack(spacing: 10) {
            message("This file is not in a git repository.", systemImage: "arrow.triangle.branch")
                .frame(height: 80)
            Button("Back to the reading view") { model.setMode(.preview) }
                .buttonStyle(.genHoverPlain())
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
