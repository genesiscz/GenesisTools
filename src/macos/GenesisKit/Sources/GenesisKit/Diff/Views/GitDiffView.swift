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

/// What a scope's diff holds, as far as the caller knows: its lines, its files, or only whether it is empty.
public struct GitScopeStat: Hashable, Sendable {
    public var additions: Int?
    public var deletions: Int?
    public var files: Int?
    public var hasChanges: Bool

    public init(additions: Int, deletions: Int, files: Int? = nil) {
        self.additions = additions
        self.deletions = deletions
        self.files = files
        hasChanges = additions + deletions > 0 || (files ?? 0) > 0
    }

    private init(hasChanges: Bool) {
        self.hasChanges = hasChanges
    }

    /// Known to hold no change.
    public static let clean = GitScopeStat(hasChanges: false)
    /// Known to hold a change of unknown size.
    public static let changed = GitScopeStat(hasChanges: true)

    /// One file's scopes from what costs nothing more: the repository's status says whether the file has unstaged and
    /// staged changes, and the diff on screen gives the exact lines of the scope it shows. `unsaved`: the text on
    /// screen is a draft, so the scopes that read it differ from the file on disk.
    public static func forFile(status: GitRepoStatus?, file: URL, unsaved: Bool = false, current: GitFileScope,
                               phase: GitFileDiffModel.Phase, diff: DiffFile?) -> [GitFileScope: GitScopeStat] {
        var counts: [GitFileScope: GitScopeStat] = [:]
        if let status {
            let entry = status.entry(for: file)
            let staged = entry?.staged != nil && entry?.staged != .untracked
            counts[.unstaged] = unsaved || entry?.unstaged != nil ? .changed : .clean
            counts[.staged] = staged ? .changed : .clean
            counts[.uncommitted] = unsaved || entry != nil ? .changed : .clean
        }
        switch phase {
        case .ready:
            if let diff { counts[current] = GitScopeStat(additions: diff.additions, deletions: diff.deletions) }
        case .empty:
            counts[current] = .clean
        case .idle, .loading, .failed:
            break
        }
        return counts
    }
}

/// The Changes mode's scope: a chip as wide as its label that opens the five scopes, each with what it compares and,
/// when the viewer knows them, its counts. Beside it, for "Last commit", the commit chooser (`GitCommitPicker`).
/// Both lists are built when they open.
public struct GitScopePicker: View {
    @Binding var scope: GitFileScope
    @Binding var commit: String?
    let history: [GitCommit]
    /// The commit "Last commit" shows now, for its label.
    let shown: GitCommit?
    let counts: [GitFileScope: GitScopeStat]
    /// The branch Branch compares against, when the viewer knows it.
    let base: String?
    let details: GitCommitDetailsLoader?
    @State private var choosing = false

    public init(scope: Binding<GitFileScope>, commit: Binding<String?>, history: [GitCommit], shown: GitCommit?,
                counts: [GitFileScope: GitScopeStat] = [:], base: String? = nil, details: GitCommitDetailsLoader? = nil) {
        _scope = scope
        _commit = commit
        self.history = history
        self.shown = shown
        self.counts = counts
        self.base = base
        self.details = details
    }

    public var body: some View {
        HStack(spacing: 6) {
            Button {
                choosing.toggle()
            } label: {
                GitPickerChip(systemImage: scope.symbol, title: scope.title, detail: scope == .branch ? base.map { "vs \($0)" } : nil)
            }
            .buttonStyle(.genHoverPlain())
            .popover(isPresented: $choosing, arrowEdge: .bottom) {
                GitScopeList(selection: scope, counts: counts, base: base, shown: shown) { picked in
                    choosing = false
                    scope = picked
                }
            }
            .instantTooltip("What the diff compares: \(scope.summary(base: base, shown: shown))")
            .accessibilityLabel(Text(verbatim: "Compare: \(scope.title)"))
            .accessibilityIdentifier("git-scope-picker")
            if scope == .lastCommit, !history.isEmpty {
                GitCommitPicker(choices: history.map { GitCommitChoice($0) }, selection: (shown ?? history.first)?.sha,
                                title: "Commits that changed this file", details: details) { commit = $0.sha }
                    .instantTooltip("Any commit that changed this file")
                    .accessibilityIdentifier("git-commit-picker")
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The open scope list: a row per scope with what it compares and its counts. Up and down move, Return or a click
/// picks, 1 to 5 pick at once, Esc closes.
struct GitScopeList: View {
    let selection: GitFileScope
    let counts: [GitFileScope: GitScopeStat]
    let base: String?
    let shown: GitCommit?
    let pick: (GitFileScope) -> Void
    @State private var highlighted: GitFileScope?
    @FocusState private var focused: Bool

    static let width: CGFloat = 360

    var body: some View {
        let _ = RenderProbe.hit("git.scopePicker.list")
        VStack(alignment: .leading, spacing: 1) {
            Text("Compare")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.bottom, 4)
            ForEach(Array(GitFileScope.allCases.enumerated()), id: \.element) { index, scope in
                row(scope, key: index + 1)
            }
            if !counts.isEmpty {
                Text("Counts are this file's lines.")
                    .font(.system(size: 10.5))
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 8)
                    .padding(.top, 5)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 8)
        .frame(width: Self.width)
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.upArrow) { move(-1) }
        .onKeyPress(.downArrow) { move(1) }
        .onKeyPress(.return) {
            pick(highlighted ?? selection)
            return .handled
        }
        .onKeyPress(characters: .decimalDigits) { press in
            guard let number = Int(press.characters), (1...GitFileScope.allCases.count).contains(number) else { return .ignored }
            pick(GitFileScope.allCases[number - 1])
            return .handled
        }
        .onAppear {
            highlighted = selection
            DispatchQueue.main.async { focused = true }
        }
    }

    private func row(_ scope: GitFileScope, key: Int) -> some View {
        let current = scope == selection
        return Button {
            pick(scope)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "checkmark")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundStyle(Color.accentColor)
                    .opacity(current ? 1 : 0)
                    .frame(width: 12)
                Image(systemName: scope.symbol)
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: scope.title)
                        .font(.system(size: 12.5, weight: current ? .semibold : .regular))
                    Text(verbatim: scope.summary(base: base, shown: shown))
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 10)
                stat(counts[scope])
                Text(verbatim: "\(key)")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(GitChooserRowStyle())
        .background(GitChooserRowBackground(highlighted: highlighted == scope))
        .onHover { inside in
            if inside, highlighted != scope { highlighted = scope }
        }
        .accessibilityLabel(Text(verbatim: "\(scope.title), \(scope.summary(base: base, shown: shown))\(counts[scope].map { ", \(Self.spoken($0))" } ?? "")"))
        .accessibilityAddTraits(current ? .isSelected : [])
        .accessibilityIdentifier("git-scope-\(scope.rawValue)")
    }

    @ViewBuilder
    private func stat(_ stat: GitScopeStat?) -> some View {
        if let stat {
            if let additions = stat.additions, let deletions = stat.deletions {
                HStack(spacing: 6) {
                    if let files = stat.files {
                        Text(verbatim: Plural.count(files, "file"))
                            .font(.system(size: 11))
                            .foregroundStyle(.secondary)
                    }
                    GitLineCounts(additions: additions, deletions: deletions)
                }
            } else {
                Text(stat.hasChanges ? "Changed" : "No changes")
                    .font(.system(size: 11))
                    .foregroundStyle(stat.hasChanges ? .secondary : .tertiary)
            }
        }
    }

    private func move(_ step: Int) -> KeyPress.Result {
        let all = GitFileScope.allCases
        let index = all.firstIndex(of: highlighted ?? selection) ?? 0
        highlighted = all[min(max(index + step, 0), all.count - 1)]
        return .handled
    }

    static func spoken(_ stat: GitScopeStat) -> String {
        if let additions = stat.additions, let deletions = stat.deletions {
            return "\(Plural.count(additions, "line")) added, \(Plural.count(deletions, "line")) removed"
        }
        return stat.hasChanges ? "changed" : "no changes"
    }
}
