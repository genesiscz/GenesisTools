//
//  GitCommitPicker.swift
//  GenesisKit
//
//  A commit chooser that opens as a popover: a filter field over the commits, and per commit its subject, author,
//  relative and absolute date, short id (copyable), files and lines changed. Up and down move, Return picks, Esc
//  closes. Nothing of the list exists until it opens: a closed SwiftUI Menu builds every item and its accessibility
//  state with the pane around it, which stalled panes (swift skill, performance.md). What a source does not carry
//  (the GenesisTools review window's commits have no author or date) loads when the list opens, with one
//  `git log --no-walk` for all of its commits.
//

import AppKit
import SwiftUI

/// How much a commit changed: every file, and the chooser's own file when it names one.
public struct GitCommitStat: Hashable, Sendable {
    public var files: Int
    public var additions: Int
    public var deletions: Int
    /// The lines of the commit's `path` alone; nil when the choice names no file or the commit did not touch it.
    public var fileAdditions: Int?
    public var fileDeletions: Int?

    public init(files: Int, additions: Int, deletions: Int, fileAdditions: Int? = nil, fileDeletions: Int? = nil) {
        self.files = files
        self.additions = additions
        self.deletions = deletions
        self.fileAdditions = fileAdditions
        self.fileDeletions = fileDeletions
    }
}

/// One commit a `GitCommitPicker` offers. Only the id and subject are needed; the rest shows when it is known.
public struct GitCommitChoice: Identifiable, Hashable, Sendable {
    public var id: String
    public var sha: String
    public var short: String
    public var subject: String
    public var author: String?
    public var date: Date?
    /// The age as the source words it ("3 hours ago"), for a source without a date.
    public var relative: String?
    /// A short tag before the subject ("#3" for a push, "HEAD").
    public var badge: String?
    /// The repository-relative file this commit is shown for: its own line counts come with the details.
    public var path: String?
    public var stat: GitCommitStat?

    public init(id: String? = nil, sha: String, short: String? = nil, subject: String, author: String? = nil, date: Date? = nil,
                relative: String? = nil, badge: String? = nil, path: String? = nil, stat: GitCommitStat? = nil) {
        self.id = id ?? sha
        self.sha = sha
        self.short = short ?? String(sha.prefix(7))
        self.subject = subject
        self.author = author
        self.date = date
        self.relative = relative
        self.badge = badge
        self.path = path
        self.stat = stat
    }

    /// A file's history entry (the markdown viewer's "Last commit").
    public init(_ commit: GitCommit) {
        self.init(sha: commit.sha, short: commit.short, subject: commit.subject, author: commit.author, date: commit.date, path: commit.path)
    }

    /// A branch commit of the review window: author, date and counts come with the details.
    public init(_ commit: RepoCommit) {
        self.init(sha: commit.sha, short: commit.short, subject: commit.subject, relative: commit.when)
    }

    /// This choice with what the details add, never over what the source gave.
    func filled(by details: GitCommitDetails?) -> GitCommitChoice {
        guard let details else { return self }
        var copy = self
        copy.author = author ?? details.author
        copy.date = date ?? details.date
        copy.stat = stat ?? details.stat
        return copy
    }
}

/// What `git log` adds to a choice.
public struct GitCommitDetails: Hashable, Sendable {
    public var author: String
    public var date: Date
    public var stat: GitCommitStat

    public init(author: String, date: Date, stat: GitCommitStat) {
        self.author = author
        self.date = date
        self.stat = stat
    }
}

/// Reads author, date and line counts of the listed commits from the repository holding `folder`.
public struct GitCommitDetailsLoader: Hashable, Sendable {
    public var folder: URL
    /// The most commits one load asks about; a longer list shows the rest without counts.
    public static let limit = 300

    public init(folder: URL) {
        self.folder = folder
    }

    /// One `git log` for every choice; keyed by full commit id. Off the main thread.
    public func load(_ choices: [GitCommitChoice]) throws -> [String: GitCommitDetails] {
        let asked = choices.prefix(Self.limit).filter { DiffScope.isObjectID($0.sha) }
        guard !asked.isEmpty else { return [:] }
        let result = try GenesisKitGT.provider.git(Self.arguments(asked.map(\.sha)), in: folder, input: nil, gitDirectory: nil, environment: nil)
        guard result.status == 0 else {
            throw ReviewError.git("git log: \(String(decoding: result.stderr, as: UTF8.self).trimmed)")
        }
        var paths: [String: String] = [:]
        for choice in asked {
            if let path = choice.path { paths[choice.sha] = path }
        }
        return Self.parse(String(decoding: result.stdout, as: UTF8.self), paths: paths)
    }

    /// Renames off, so every numstat line is one plain path; ids the repository lacks are skipped, not fatal.
    static func arguments(_ shas: [String]) -> [String] {
        ["-c", "core.quotePath=false", "log", "--no-walk=unsorted", "--ignore-missing", "--no-renames", "--numstat",
         "--format=%x1e%H%x1f%an%x1f%ct"] + shas + ["--"]
    }

    static func parse(_ output: String, paths: [String: String]) -> [String: GitCommitDetails] {
        var found: [String: GitCommitDetails] = [:]
        for record in output.split(separator: "\u{1e}", omittingEmptySubsequences: true) {
            let lines = record.split(separator: "\n", omittingEmptySubsequences: true)
            guard let header = lines.first else { continue }
            let parts = header.split(separator: "\u{1f}", omittingEmptySubsequences: false).map(String.init)
            guard parts.count == 3, let seconds = TimeInterval(parts[2]) else { continue }
            let path = paths[parts[0]]
            var stat = GitCommitStat(files: 0, additions: 0, deletions: 0)
            for line in lines.dropFirst() {
                let columns = line.split(separator: "\t", maxSplits: 2, omittingEmptySubsequences: false)
                guard columns.count == 3 else { continue }
                // A binary file counts as a file with no lines ("-\t-\tpath").
                let added = Int(columns[0]) ?? 0
                let removed = Int(columns[1]) ?? 0
                stat.files += 1
                stat.additions += added
                stat.deletions += removed
                if let path, columns[2] == path {
                    stat.fileAdditions = added
                    stat.fileDeletions = removed
                }
            }
            found[parts[0]] = GitCommitDetails(author: parts[1], date: Date(timeIntervalSince1970: seconds), stat: stat)
        }
        return found
    }
}

/// Which choices a filter text keeps: every word must be in the subject, the author or the tag, or start the id.
enum GitCommitFilter {
    static func matches(_ choices: [GitCommitChoice], query: String) -> [GitCommitChoice] {
        let words = query.split(whereSeparator: \.isWhitespace).map { fold(String($0)) }
        guard !words.isEmpty else { return choices }
        return choices.filter { choice in
            let text = fold([choice.subject, choice.author ?? "", choice.badge ?? ""].joined(separator: " "))
            let sha = choice.sha.lowercased()
            return words.allSatisfy { text.contains($0) || sha.hasPrefix($0) }
        }
    }

    private static func fold(_ text: String) -> String {
        text.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
}

// MARK: - Views

/// A button that opens the commit list as a popover. The label is the caller's (`GitPickerChip` by default).
public struct GitCommitPicker<Label: View>: View {
    let choices: [GitCommitChoice]
    let selection: String?
    let title: String?
    let details: GitCommitDetailsLoader?
    let onPick: (GitCommitChoice) -> Void
    let label: Label
    @State private var open = false

    /// `selection` is the commit id shown now; `details` reads what the choices lack when the list opens.
    public init(choices: [GitCommitChoice], selection: String?, title: String? = nil, details: GitCommitDetailsLoader? = nil,
                onPick: @escaping (GitCommitChoice) -> Void, @ViewBuilder label: () -> Label) {
        self.choices = choices
        self.selection = selection
        self.title = title
        self.details = details
        self.onPick = onPick
        self.label = label()
    }

    public var body: some View {
        Button {
            open.toggle()
        } label: {
            label
        }
        .buttonStyle(.genHoverPlain())
        .gitCommitPopover(isPresented: $open, choices: choices, selection: selection, title: title, details: details, onPick: onPick)
    }
}

public extension GitCommitPicker where Label == GitPickerChip {
    /// The chip shows the selected commit's short id and subject.
    init(choices: [GitCommitChoice], selection: String?, title: String? = nil, details: GitCommitDetailsLoader? = nil,
         onPick: @escaping (GitCommitChoice) -> Void) {
        let current = choices.first { $0.sha == selection }
        self.init(choices: choices, selection: selection, title: title, details: details, onPick: onPick) {
            GitPickerChip(title: current?.short ?? "Pick a commit", detail: current?.subject, monospacedTitle: current != nil)
        }
    }
}

public extension View {
    /// The commit list as a popover from this view. Its rows are built when it opens, never while it is closed.
    /// With `onPickRange`, Shift with the arrows or a Shift-click picks several commits in a row: the callback gets
    /// them in list order, every commit between the two ends included, even ones the filter hides.
    func gitCommitPopover(isPresented: Binding<Bool>, choices: [GitCommitChoice], selection: String?, title: String? = nil,
                          details: GitCommitDetailsLoader? = nil, onPick: @escaping (GitCommitChoice) -> Void,
                          onPickRange: (([GitCommitChoice]) -> Void)? = nil) -> some View {
        popover(isPresented: isPresented, arrowEdge: .bottom) {
            GitCommitPickerList(choices: choices, selection: selection, title: title, details: details,
                pickRange: onPickRange.map { pickRange in
                    { range in
                        isPresented.wrappedValue = false
                        pickRange(range)
                    }
                }) { choice in
                isPresented.wrappedValue = false
                onPick(choice)
            }
        }
    }
}

/// What the open list shows and where its highlight is: the filter text, the rows it keeps, the details read so far.
struct GitCommitPickerState {
    let choices: [GitCommitChoice]
    var query = "" {
        didSet {
            guard query != oldValue else { return }
            refilter()
            highlighted = rows.first?.id
        }
    }
    var loaded: [String: GitCommitDetails] = [:] {
        didSet { refilter() }
    }
    /// The rows the filter keeps, stored when the text or the details change rather than filtered on every hover.
    private(set) var rows: [GitCommitChoice] = []
    /// The row the keyboard or the pointer is on: Return picks it.
    var highlighted: String?
    /// Where a Shift-extended range started; nil while one commit is chosen.
    var anchor: String?

    init(choices: [GitCommitChoice], selection: String?, query: String = "") {
        self.choices = choices
        self.query = query
        refilter()
        highlighted = selection.flatMap { sha in rows.first { $0.sha == sha }?.id } ?? rows.first?.id
    }

    /// Moves the highlight `step` rows, stopping at either end; from no highlight, down starts at the top. A plain move
    /// ends a range.
    mutating func move(_ step: Int) {
        anchor = nil
        advance(step)
    }

    /// Shift with an arrow: the range grows from where it started.
    mutating func extend(_ step: Int) {
        if anchor == nil { anchor = highlighted }
        advance(step)
    }

    /// Shift-click: the range runs from where it started (or the highlighted row) to `id`.
    mutating func extend(to id: String) {
        if anchor == nil { anchor = highlighted }
        highlighted = id
    }

    /// The commits of a range, in the list's order and with every commit between its ends (also the ones the filter
    /// hides, so the diff never skips one); nil while one commit is chosen.
    var range: [GitCommitChoice]? {
        guard let anchor, let highlighted, anchor != highlighted,
              let start = choices.firstIndex(where: { $0.id == anchor }),
              let end = choices.firstIndex(where: { $0.id == highlighted }) else { return nil }
        return Array(choices[min(start, end)...max(start, end)])
    }

    private mutating func advance(_ step: Int) {
        guard !rows.isEmpty else { return }
        let index = highlighted.flatMap { id in rows.firstIndex { $0.id == id } } ?? (step > 0 ? -1 : rows.count)
        highlighted = rows[min(max(index + step, 0), rows.count - 1)].id
    }

    var highlightedChoice: GitCommitChoice? {
        highlighted.flatMap { id in rows.first { $0.id == id } }
    }

    /// Whether any choice lacks what the details add.
    var needsDetails: Bool {
        choices.contains { $0.author == nil || $0.date == nil || $0.stat == nil }
    }

    private mutating func refilter() {
        rows = GitCommitFilter.matches(choices.map { $0.filled(by: loaded[$0.sha]) }, query: query)
    }
}

/// The open list: filter field, commits, and a footer with the count and the keys.
struct GitCommitPickerList: View {
    let selection: String?
    let title: String?
    let details: GitCommitDetailsLoader?
    /// Several commits in a row; nil offers one commit only.
    let pickRange: (([GitCommitChoice]) -> Void)?
    let pick: (GitCommitChoice) -> Void

    @State private var state: GitCommitPickerState
    /// Set by a key, cleared by the scroll it causes: a row the pointer moves onto never scrolls the list.
    @State private var scrollTarget: String?
    /// When a key last moved the highlight: rows that scroll under a still pointer must not take it back.
    @State private var keyMovedAt = Date.distantPast
    @State private var loading = false
    @FocusState private var searchFocused: Bool

    static let width: CGFloat = 470
    static let maxListHeight: CGFloat = 384
    /// How far Page Up and Page Down move.
    static let page = 8

    init(choices: [GitCommitChoice], selection: String?, title: String?, details: GitCommitDetailsLoader?, query: String = "",
         pickRange: (([GitCommitChoice]) -> Void)? = nil, pick: @escaping (GitCommitChoice) -> Void) {
        self.selection = selection
        self.title = title
        self.details = details
        self.pickRange = pickRange
        self.pick = pick
        _state = State(initialValue: GitCommitPickerState(choices: choices, selection: selection, query: query))
    }

    var body: some View {
        let _ = RenderProbe.hit("git.commitPicker.list")
        VStack(spacing: 0) {
            if let title {
                Text(verbatim: title)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14)
                    .padding(.top, 10)
            }
            filterField
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            Divider()
            list
            Divider()
            footer
        }
        .frame(width: Self.width)
        .onAppear {
            scrollTarget = state.highlighted
            // The popover's window takes the keyboard a moment after it appears.
            DispatchQueue.main.async { searchFocused = true }
        }
        .onChange(of: state.query) { _, _ in scrollTarget = state.highlighted }
        .task { await loadDetails() }
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            TextField("Filter by subject, author or commit id", text: $state.query)
                .textFieldStyle(.plain)
                .font(.system(size: 12.5))
                .focused($searchFocused)
                .onSubmit { submit() }
                .onKeyPress(.upArrow, phases: [.down, .repeat]) { press in move(-1, extending: press.modifiers.contains(.shift)) }
                .onKeyPress(.downArrow, phases: [.down, .repeat]) { press in move(1, extending: press.modifiers.contains(.shift)) }
                .onKeyPress(.pageUp) { move(-Self.page) }
                .onKeyPress(.pageDown) { move(Self.page) }
                .accessibilityLabel("Filter commits")
                .accessibilityIdentifier("git-commit-picker-filter")
            if !state.query.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the filter", size: 11, tint: .secondary) { state.query = "" }
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.primary.opacity(0.06)))
    }

    @ViewBuilder
    private var list: some View {
        if state.rows.isEmpty {
            Text(verbatim: state.query.isEmpty ? "No commits to show." : "No commit matches “\(state.query)”.")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 22)
        } else {
            ScrollViewReader { proxy in
                FittedScroll(maxHeight: Self.maxListHeight) {
                    LazyVStack(spacing: 1) {
                        let inRange = Set(state.range?.map(\.id) ?? [])
                        ForEach(state.rows) { choice in
                            GitCommitPickerRow(choice: choice, current: choice.sha == selection,
                                               highlighted: choice.id == state.highlighted || inRange.contains(choice.id)) {
                                click(choice)
                            }
                            .id(choice.id)
                            .onHover { inside in
                                // A range keeps its ends while the pointer crosses other rows.
                                guard inside, state.anchor == nil, state.highlighted != choice.id,
                                      Date().timeIntervalSince(keyMovedAt) > 0.4 else { return }
                                state.highlighted = choice.id
                            }
                        }
                    }
                    .padding(5)
                }
                .onChange(of: scrollTarget) { _, target in
                    guard let target else { return }
                    proxy.scrollTo(target)
                    scrollTarget = nil
                }
                .onAppear {
                    guard let target = scrollTarget else { return }
                    // After the first layout: a lazy stack has no row to scroll to before it.
                    DispatchQueue.main.async {
                        proxy.scrollTo(target, anchor: .center)
                        scrollTarget = nil
                    }
                }
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 8) {
            let total = state.choices.count
            Text(verbatim: state.rows.count == total ? Plural.count(total, "commit") : "\(state.rows.count) of \(Plural.count(total, "commit"))")
            if loading {
                ProgressView().controlSize(.mini)
                    .accessibilityLabel("Reading the line counts")
            }
            Spacer(minLength: 8)
            Text(verbatim: keysHint)
                .accessibilityHidden(true)
        }
        .font(.system(size: 10.5))
        .foregroundStyle(.secondary)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }

    /// The keys, and with a range how many commits Return shows.
    private var keysHint: String {
        if let range = state.range {
            return "\(Plural.count(range.count, "commit")) chosen  ·  ↩ show them  ·  ↑↓ back to one"
        }
        return pickRange == nil ? "↑↓ move  ·  ↩ show  ·  esc close"
            : "↑↓ move  ·  ⇧↑↓ or ⇧-click more  ·  ↩ show  ·  esc close"
    }

    private func submit() {
        if pickRange != nil, let range = state.range {
            pickRange?(range)
        } else if let choice = state.highlightedChoice {
            pick(choice)
        }
    }

    /// A click shows that one commit; with Shift (when ranges are offered) it extends the range instead.
    private func click(_ choice: GitCommitChoice) {
        if pickRange != nil, NSEvent.modifierFlags.contains(.shift) {
            state.extend(to: choice.id)
            keyMovedAt = Date()
            return
        }

        pick(choice)
    }

    private func move(_ step: Int, extending: Bool = false) -> KeyPress.Result {
        if extending, pickRange != nil {
            state.extend(step)
        } else {
            state.move(step)
        }
        scrollTarget = state.highlighted
        keyMovedAt = Date()
        return .handled
    }

    private func loadDetails() async {
        guard let details, state.needsDetails else { return }
        loading = true
        let asked = state.choices
        let found = await Task.detached(priority: .userInitiated) { () -> [String: GitCommitDetails] in
            let span = PerfSpans.begin("git.commitPicker.details", "\(asked.count) commits")
            defer { span.end() }
            do {
                return try details.load(asked)
            } catch {
                PerfSpans.log("git.commitPicker.details failed: \(error)")
                return [:]
            }
        }.value
        loading = false
        guard !Task.isCancelled, !found.isEmpty else { return }
        state.loaded = found
    }
}

/// One commit: subject and counts on the first line; id, author, age and date on the second. The copy button exists
/// only on the highlighted row, so a long list carries one button per row, not two.
struct GitCommitPickerRow: View {
    let choice: GitCommitChoice
    let current: Bool
    let highlighted: Bool
    let pick: () -> Void

    var body: some View {
        let _ = RenderProbe.hit("git.commitPicker.row")
        HStack(spacing: 2) {
            Button(action: pick) {
                content
            }
            .buttonStyle(GitChooserRowStyle())
            .accessibilityLabel(Text(verbatim: spoken))
            .accessibilityAddTraits(current ? .isSelected : [])
            // The copy button shows only on the highlighted row; VoiceOver reaches it on every row.
            .accessibilityAction(named: "Copy commit id") { Clipboard.copy(choice.sha, what: "commit id") }
            .accessibilityIdentifier("git-commit-choice-\(choice.short)")
            ZStack {
                if highlighted {
                    IconButton(systemName: "doc.on.doc", tooltip: "Copy the commit id \(choice.sha)", size: 10.5, tint: .secondary) {
                        Clipboard.copy(choice.sha, what: "commit id")
                    }
                }
            }
            .frame(width: 24)
        }
        .padding(.trailing, 2)
        .background(GitChooserRowBackground(highlighted: highlighted))
    }

    private var content: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.accentColor)
                .opacity(current ? 1 : 0)
                .frame(width: 12)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    if let badge = choice.badge {
                        Text(verbatim: badge)
                            .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.primary.opacity(0.08)))
                    }
                    Text(verbatim: choice.subject)
                        .font(.system(size: 12.5, weight: current ? .semibold : .regular))
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 8)
                    if let lines = lines {
                        GitLineCounts(additions: lines.additions, deletions: lines.deletions, size: 11)
                    }
                }
                HStack(spacing: 5) {
                    Text(verbatim: choice.short)
                        .font(.system(size: 11, design: .monospaced))
                    if let author = choice.author {
                        Text(verbatim: "·")
                        Text(verbatim: author)
                            .lineLimit(1)
                    }
                    if let date = choice.date {
                        Text(verbatim: "·")
                        LiveAgo(date: date, style: .brief)
                        Text(verbatim: "·")
                        Text(verbatim: Self.absolute(date))
                            .lineLimit(1)
                    } else if let relative = choice.relative {
                        Text(verbatim: "·")
                        Text(verbatim: relative)
                    }
                    Spacer(minLength: 8)
                    if let stat = choice.stat, stat.files > 0 {
                        Text(verbatim: Plural.count(stat.files, "file"))
                    }
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 5)
        .padding(.leading, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    /// The file's own lines when the choice names a file the commit touched, else the whole commit's.
    private var lines: (additions: Int, deletions: Int)? {
        guard let stat = choice.stat else { return nil }
        if let added = stat.fileAdditions, let removed = stat.fileDeletions { return (added, removed) }
        return stat.files > 0 ? (stat.additions, stat.deletions) : nil
    }

    private var spoken: String {
        var parts = [choice.subject, "commit \(choice.short)"]
        if let author = choice.author { parts.append("by \(author)") }
        if let date = choice.date {
            parts.append(date.formatted(date: .abbreviated, time: .shortened))
        } else if let relative = choice.relative {
            parts.append(relative)
        }
        if let lines { parts.append("\(lines.additions) lines added, \(lines.deletions) removed") }
        return parts.joined(separator: ", ")
    }

    /// "13 Oct, 14:02" this year, "13 Oct 2025, 14:02" before, in one English form: the system region's own form
    /// ("13. 10. at 14:02" on a Czech Mac) mixed two languages in one row.
    static func absolute(_ date: Date, now: Date = Date()) -> String {
        let thisYear = Calendar.current.isDate(date, equalTo: now, toGranularity: .year)
        return (thisYear ? dayFormat : yearFormat).string(from: date)
    }

    private static let dayFormat = format("d MMM, HH:mm")
    private static let yearFormat = format("d MMM yyyy, HH:mm")

    private static func format(_ pattern: String) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.dateFormat = pattern
        return formatter
    }
}
