//
//  GitDiffView.swift
//  GenesisKit
//
//  The diff of some files as a SwiftUI view: the web renderer the GenesisTools review window uses, with its options
//  (split or unified, wrap, font size), and the scope picker a file's diff offers. Each works alone.
//

import SwiftUI

/// Files rendered as a diff. The app must bundle the diff page (`PierreWebDiffRenderer.isBundled`); without it this
/// says so instead of showing an empty page.
public struct GitDiffView: View {
    public var files: [DiffFile]
    public var options: DiffViewOptions
    /// Which agent session wrote the new side's lines (hovering a line names it); nil shows none.
    public var blame: AgentBlamePayload?
    /// A click on a blame's "Open session": the index into `blame.sources`.
    public var onBlameOpen: ((Int) -> Void)?

    public init(files: [DiffFile], options: DiffViewOptions = DiffViewOptions(), blame: AgentBlamePayload? = nil,
                onBlameOpen: ((Int) -> Void)? = nil) {
        self.files = files
        self.options = options
        self.blame = blame
        self.onBlameOpen = onBlameOpen
    }

    public var body: some View {
        if PierreWebDiffRenderer.isBundled {
            Renderer(files: files, options: options, blame: blame, onBlameOpen: onBlameOpen)
        } else {
            Text("This app does not bundle the diff viewer page.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private struct Renderer: NSViewRepresentable {
        let files: [DiffFile]
        let options: DiffViewOptions
        let blame: AgentBlamePayload?
        let onBlameOpen: ((Int) -> Void)?

        func makeCoordinator() -> Coordinator { Coordinator() }

        func makeNSView(context: Context) -> NSView {
            let renderer = PierreWebDiffRenderer.make()
            let c = context.coordinator
            c.renderer = renderer
            c.options = options
            c.files = files
            c.onBlameOpen = onBlameOpen
            renderer.onEvent = { [weak c] event in
                if case .blameOpen(let index) = event { c?.onBlameOpen?(index) }
            }
            renderer.apply(options)
            renderer.show(files, fresh: true)
            if let blame {
                c.blame = blame
                renderer.setBlame(blame)
            }
            return renderer.view
        }

        func updateNSView(_ view: NSView, context: Context) {
            let c = context.coordinator
            if c.options != options {
                c.options = options
                c.renderer?.apply(options)
            }
            if c.files != files {
                // Another file starts at its top; the same file changing keeps the reader's place.
                let fresh = c.files.map(\.id) != files.map(\.id)
                c.files = files
                c.renderer?.show(files, fresh: fresh)
            }
            c.onBlameOpen = onBlameOpen
            if c.blame != blame {
                c.blame = blame
                c.renderer?.setBlame(blame ?? AgentBlamePayload(sources: [], files: [:], loaded: files.map(\.id)))
            }
        }

        final class Coordinator {
            var renderer: PierreWebDiffRenderer?
            var files: [DiffFile] = []
            var options = DiffViewOptions()
            var blame: AgentBlamePayload?
            var onBlameOpen: ((Int) -> Void)?
        }
    }
}

/// Unstaged · Staged · Uncommitted · Last commit · Branch, and the commit for "Last commit" picked from `history`.
public struct GitScopePicker: View {
    @Binding var scope: GitFileScope
    @Binding var commit: String?
    let history: [GitCommit]
    /// The commit "Last commit" shows now, for its label.
    let shown: GitCommit?

    public init(scope: Binding<GitFileScope>, commit: Binding<String?>, history: [GitCommit], shown: GitCommit?) {
        _scope = scope
        _commit = commit
        self.history = history
        self.shown = shown
    }

    public var body: some View {
        HStack(spacing: 8) {
            Picker("Compare", selection: $scope) {
                ForEach(GitFileScope.allCases, id: \.self) { scope in
                    Text(scope.title).tag(scope)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .accessibilityIdentifier("git-scope-picker")
            if scope == .lastCommit, !history.isEmpty {
                MenuButton(style: .genHoverPlain(), items: { items }) {
                    HStack(spacing: 4) {
                        Text(verbatim: shown.map { "\($0.short) \($0.subject)" } ?? "Pick a commit")
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 8, weight: .bold))
                    }
                    .font(.system(size: 11))
                }
                .instantTooltip("Any commit that changed this file")
                .accessibilityIdentifier("git-commit-picker")
            }
        }
    }

    private var items: [MenuButtonItem] {
        history.map { entry in
            .action("\(entry.short)  \(entry.subject)  ·  \(entry.author)", checked: entry.sha == shown?.sha) {
                commit = entry.sha
            }
        }
    }
}
