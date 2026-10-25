//
//  MarkdownChangesPane.swift
//  GenesisKit
//
//  The viewer's fourth mode: the open file's diff for a scope (GitScopePicker), as lines (GitDiffView, split or
//  unified) or, for a note, rendered: the note with its added blocks green and its removed text struck through.
//  It reloads when the repository changes (a stage, a commit) and when the text on screen does.
//

import SwiftUI

/// Shared by Changes and the commit sheet. Full-note differences never run in a view body.
@MainActor
final class MarkdownDiffMarksModel: ObservableObject {
    struct Input: Equatable, Sendable {
        let old: String
        let new: String
    }
    private struct Output {
        let input: Input
        let marks: [MarkdownWebView.DiffMark]
    }
    @Published private var output: Output?
    private var ticket = 0
    var compute: @Sendable (String, String) -> [MarkdownWebView.DiffMark] = {
        MarkdownWebView.DiffMark.between(old: $0, new: $1)
    }

    func marks(for input: Input) -> [MarkdownWebView.DiffMark] {
        output?.input == input ? output?.marks ?? [] : []
    }

    func load(_ input: Input) async {
        ticket += 1
        let ticket = ticket
        guard output?.input != input else { return }
        let compute = compute
        let marks = await Task.detached(priority: .userInitiated) { compute(input.old, input.new) }.value
        guard ticket == self.ticket, !Task.isCancelled else { return }
        output = Output(input: input, marks: marks)
    }
}

struct MarkdownRenderedDiff<Content: View>: View {
    let old: String
    let new: String
    let content: ([MarkdownWebView.DiffMark]) -> Content
    @StateObject private var marks = MarkdownDiffMarksModel()

    var body: some View {
        let input = MarkdownDiffMarksModel.Input(old: old, new: new)
        content(marks.marks(for: input))
            .task(id: input) { await marks.load(input) }
    }
}

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
            switch repos.lookup(for: doc.folder) {
            case .pending:
                Color.clear
            case .none:
                notInGit
            case .repo:
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
        .onChange(of: doc.missing) { _, _ in load() }
        .onChange(of: repos.revision) { _, _ in load() }
    }

    private func load() {
        blame.follow(blameShows ? doc.url : nil)
        if let compare {
            diff.loadCompare(doc.url, workingText: model.workingText(for: doc), old: compare.old, new: compare.new)
        } else {
            // A file moved outside git reads its old side at the path it came from (GitWorktreeRenames).
            let movedFrom = repos.model(for: doc.folder)?.status?.entry(for: doc.url).flatMap { $0.unstaged == .renamed ? $0.oldPath : nil }
            diff.load(doc.url, workingText: model.workingText(for: doc), scope: currentScope,
                      commit: currentScope == .lastCommit ? model.changesCommit : nil, renamedFrom: movedFrom)
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
                    shown: diff.commit,
                    counts: GitScopeStat.forFile(status: repos.model(for: doc.folder)?.status, file: doc.url, unsaved: doc.isDirty,
                                                 current: currentScope, phase: diff.phase, diff: diff.file),
                    details: GitCommitDetailsLoader(folder: doc.folder)
                )
            }
            if let file = diff.file {
                GitLineCounts(additions: file.additions, deletions: file.deletions, size: 10.5)
            }
            Spacer(minLength: 8)
            if isNote {
                // GenSegmentedTabs, not a segmented Picker: the native control drew as loose buttons outside the key
                // window, and its clicks on Split / Unified did not reach the diff (Martin, 2026-10-13).
                GenSegmentedTabs("View", items: [.init(true, "Rendered"), .init(false, "Lines")], selection: $rendered, minSegmentWidth: 58)
                .fixedSize()
                .instantTooltip("Rendered: the note with its changes marked · Lines: the source diff")
                .accessibilityIdentifier("markdown-changes-rendered")
            }
            if !isNote || !rendered {
                GenSegmentedTabs("Layout", items: [.init(false, "Split"), .init(true, "Unified")], selection: $unified, minSegmentWidth: 54)
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
            MarkdownDelayedLoading(text: "Reading the changes", color: model.theme.textSecondary)
        case .empty(let reason):
            message(reason, systemImage: "checkmark.circle")
        case .failed(let error):
            // One sentence, Try again, and git's own words behind Details (`GitFailureNotice`).
            GitFailureNotice(diff.failure ?? GitFailure(message: error)) { diff.retry() }
                .padding(16)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .onAppear { GenAnnounce.post(error) }
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
        return MarkdownRenderedDiff(old: file.oldContents ?? "", new: new) { marks in
            MarkdownWebView(
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
                diffMarks: marks,
                documentURL: doc.url,
                vaultRoot: GenesisKit.host?.markdownVaultRoot
            )
        }
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

/// A spinner that waits 200 ms before it shows, then names the work: a diff that takes 50 ms never flashes one.
struct MarkdownDelayedLoading: View {
    let text: String
    let color: Color
    @State private var shown = false

    var body: some View {
        ZStack {
            if shown {
                VStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text(text).font(.system(size: 11)).foregroundColor(color)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel(text)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .task {
            try? await Task.sleep(for: .milliseconds(200))
            if !Task.isCancelled { shown = true }
        }
    }
}
