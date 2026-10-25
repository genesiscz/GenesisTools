//
//  GitRepoPanel.swift
//  GenesisKit
//
//  A repository at a glance: branch with ahead and behind, the staged, changed and untracked files, recent commits.
//  A vault can hold thousands of untracked files (a data folder an agent wrote), so untracked files fold under the
//  shallowest folder that holds no other change, as `git status` folds them, rows are lazy, and every list shows a
//  page at a time. The sort button cycles Last update, Name, Folder and Kind; a filter and an untracked switch sit
//  beside it.
//

import SwiftUI

/// How the repository panel orders its files. The sort button cycles through them in this order.
public enum GitChangeOrder: String, CaseIterable, Sendable {
    case lastUpdate, name, folder, kind

    public var title: String {
        switch self {
        case .lastUpdate: return "Last update"
        case .name: return "Name"
        case .folder: return "Folder"
        case .kind: return "Kind"
        }
    }

    public var next: GitChangeOrder {
        let all = Self.allCases
        let index = all.firstIndex(of: self) ?? 0
        return all[(index + 1) % all.count]
    }
}

/// Untracked files under one folder that holds no other change: one row, its files on demand.
public struct GitUntrackedGroup: Identifiable, Equatable, Sendable {
    /// Repo-relative, no trailing slash.
    public var folder: String
    public var files: [GitStatusEntry]
    public var id: String { folder }
}

/// The pure part of the panel: folding, ordering, filtering.
public enum GitChangeList {
    /// Untracked files folded the way `git status` folds them: under the shallowest folder that holds no tracked
    /// change. A folder that would hold a single file shows that file instead.
    public static func foldUntracked(_ entries: [GitStatusEntry]) -> (files: [GitStatusEntry], groups: [GitUntrackedGroup]) {
        // Native slicing, not NSString path helpers: their NSPathStore2 strings hash and compare through Unicode
        // normalization one character at a time, which dominated this fold on a vault of non-ASCII paths.
        func parent(_ path: Substring) -> Substring? {
            guard let slash = path.lastIndex(of: "/") else { return nil }
            return path[..<slash]
        }
        var changedFolders = Set<String>()
        for entry in entries where entry.unstaged != .untracked {
            for path in [entry.path, entry.oldPath].compactMap({ $0 }) {
                var folder = parent(Substring(path))
                while let current = folder, !current.isEmpty, changedFolders.insert(String(current)).inserted {
                    folder = parent(current)
                }
            }
        }
        var loose: [GitStatusEntry] = []
        var byFolder: [String: [GitStatusEntry]] = [:]
        for entry in entries where entry.unstaged == .untracked {
            var prefix = ""
            var key: String?
            for part in entry.path.split(separator: "/").dropLast() {
                prefix = prefix.isEmpty ? String(part) : prefix + "/" + part
                if !changedFolders.contains(prefix) {
                    key = prefix
                    break
                }
            }
            if let key {
                byFolder[key, default: []].append(entry)
            } else {
                loose.append(entry)
            }
        }
        var groups: [GitUntrackedGroup] = []
        for (folder, files) in byFolder {
            if files.count == 1 {
                loose.append(files[0])
            } else {
                groups.append(GitUntrackedGroup(folder: folder, files: files))
            }
        }
        return (loose, groups)
    }

    public static func matches(_ entry: GitStatusEntry, _ filter: String) -> Bool {
        filter.isEmpty || entry.path.localizedCaseInsensitiveContains(filter)
    }

    /// `dates` are the files' modification dates (newest first for Last update); a file without one sorts last.
    public static func sorted(_ entries: [GitStatusEntry], by order: GitChangeOrder, dates: [String: Date], staged: Bool) -> [GitStatusEntry] {
        entries.sorted { lhs, rhs in
            switch order {
            case .lastUpdate:
                let left = dates[lhs.path] ?? .distantPast, right = dates[rhs.path] ?? .distantPast
                if left != right { return left > right }
            case .name:
                let result = (lhs.path as NSString).lastPathComponent.localizedStandardCompare((rhs.path as NSString).lastPathComponent)
                if result != .orderedSame { return result == .orderedAscending }
            case .folder:
                break
            case .kind:
                let left = rank(staged ? lhs.staged : lhs.unstaged), right = rank(staged ? rhs.staged : rhs.unstaged)
                if left != right { return left < right }
            }
            return lhs.path.localizedStandardCompare(rhs.path) == .orderedAscending
        }
    }

    public static func sorted(_ groups: [GitUntrackedGroup], by order: GitChangeOrder, dates: [String: Date]) -> [GitUntrackedGroup] {
        // Once per group, not per comparison: one folder can hold thousands of files.
        var newest: [String: Date] = [:]
        if order == .lastUpdate {
            for group in groups { newest[group.folder] = group.files.compactMap { dates[$0.path] }.max() ?? .distantPast }
        }
        return groups.sorted { lhs, rhs in
            switch order {
            case .lastUpdate:
                let left = newest[lhs.folder] ?? .distantPast, right = newest[rhs.folder] ?? .distantPast
                if left != right { return left > right }
            case .name:
                let result = (lhs.folder as NSString).lastPathComponent.localizedStandardCompare((rhs.folder as NSString).lastPathComponent)
                if result != .orderedSame { return result == .orderedAscending }
            case .kind:
                if lhs.files.count != rhs.files.count { return lhs.files.count > rhs.files.count }
            case .folder:
                break
            }
            return lhs.folder.localizedStandardCompare(rhs.folder) == .orderedAscending
        }
    }

    private static func rank(_ kind: GitChangeKind?) -> Int {
        switch kind {
        case .conflicted: return 0
        case .modified: return 1
        case .added: return 2
        case .renamed: return 3
        case .deleted: return 4
        case .untracked: return 5
        case nil: return 6
        }
    }
}

/// The modification dates of a status's files, read off the main thread once per status.
@MainActor
final class GitChangeDates: ObservableObject {
    struct Key: Equatable {
        let root: URL
        let generation: Int
    }
    private var ticket = 0
    var readDates: @Sendable (URL, [String]) -> [String: Date] = { root, paths in
        var result: [String: Date] = [:]
        for path in paths {
            let values = try? root.appendingPathComponent(path).resourceValues(forKeys: [.contentModificationDateKey])
            if let date = values?.contentModificationDate { result[path] = date }
        }
        return result
    }
    @Published private(set) var dates: [String: Date] = [:]
    /// Bumped with every new set of dates, so the panel's derived lists know to sort again.
    private(set) var version = 0
    private var loadedRoot: String?
    private var loadedGeneration = -1

    func load(root: URL, entries: [GitStatusEntry], generation: Int) {
        guard loadedRoot != root.path || loadedGeneration != generation else { return }
        if loadedRoot != root.path {
            version += 1
            dates = [:]
        }
        loadedRoot = root.path
        loadedGeneration = generation
        ticket += 1
        let ticket = ticket
        let paths = entries.map(\.path)
        let readDates = readDates
        Task.detached(priority: .utility) { [weak self] in
            let result = readDates(root, paths)
            await self?.apply(result, root: root, generation: generation, ticket: ticket)
        }
    }

    private func apply(_ result: [String: Date], root: URL, generation: Int, ticket: Int) {
        guard root.path == loadedRoot, generation == loadedGeneration, ticket == self.ticket else { return }
        version += 1
        dates = result
    }
}

/// The panel's lists, derived off the main thread once per change of their inputs (status, file dates, order, filter,
/// the untracked switch). Derived in the body, the fold and the sorts over a vault's thousands of entries ran on every
/// render, five times per tab switch (the parent re-renders the panel with new closures).
@MainActor
final class GitRepoPanelLists: ObservableObject {
    struct Lists: Sendable {
        var staged: [GitStatusEntry] = []
        var changed: [GitStatusEntry] = []
        var loose: [GitStatusEntry] = []
        /// Untracked folders, their files sorted.
        var groups: [GitUntrackedGroup] = []
        var newest: [String: Date] = [:]
        var untrackedTotal = 0
    }

    struct Inputs: Equatable, Sendable {
        var root: URL
        var generation: Int
        var datesVersion: Int
        var order: GitChangeOrder
        var filter: String
        var untracked: Bool
    }

    @Published private(set) var lists = Lists()
    private var inputs: Inputs?
    /// The inputs `lists` were derived from; an empty state waits for them, or a stale list would flash "no match".
    private(set) var settled: Inputs?
    private var ticket = 0

    func lists(for root: URL) -> Lists {
        inputs?.root == root ? lists : Lists()
    }

    func update(_ inputs: Inputs, entries: [GitStatusEntry], dates: [String: Date]) {
        guard inputs != self.inputs else { return }
        if self.inputs?.root != inputs.root { lists = Lists() }
        self.inputs = inputs
        ticket += 1
        let ticket = ticket
        Task.detached(priority: .userInitiated) { [weak self] in
            let lists = Self.derive(entries, dates: dates, inputs: inputs)
            await self?.apply(lists, inputs: inputs, ticket: ticket)
        }
    }

    private func apply(_ lists: Lists, inputs: Inputs, ticket: Int) {
        guard ticket == self.ticket else { return }
        settled = inputs
        self.lists = lists
    }

    nonisolated static func derive(_ entries: [GitStatusEntry], dates: [String: Date], inputs: Inputs) -> Lists {
        let filter = inputs.filter
        var lists = Lists()
        lists.staged = GitChangeList.sorted(
            entries.filter { $0.staged != nil && GitChangeList.matches($0, filter) }, by: inputs.order, dates: dates, staged: true
        )
        lists.changed = GitChangeList.sorted(
            entries.filter { $0.unstaged != nil && $0.unstaged != .untracked && GitChangeList.matches($0, filter) },
            by: inputs.order, dates: dates, staged: false
        )
        guard inputs.untracked else { return lists }
        let fold = GitChangeList.foldUntracked(entries)
        lists.loose = GitChangeList.sorted(fold.files.filter { GitChangeList.matches($0, filter) }, by: inputs.order, dates: dates, staged: false)
        let groups = fold.groups.compactMap { group -> GitUntrackedGroup? in
            let files = group.files.filter { GitChangeList.matches($0, filter) }
            guard !files.isEmpty else { return nil }
            return GitUntrackedGroup(folder: group.folder, files: GitChangeList.sorted(files, by: inputs.order, dates: dates, staged: false))
        }
        lists.groups = GitChangeList.sorted(groups, by: inputs.order, dates: dates)
        for group in lists.groups { lists.newest[group.folder] = group.files.compactMap { dates[$0.path] }.max() }
        lists.untrackedTotal = lists.loose.count + lists.groups.reduce(0) { $0 + $1.files.count }
        return lists
    }
}

/// A repository at a glance: branch with ahead and behind, the staged, changed and untracked files, recent commits.
public struct GitRepoPanel: View {
    @ObservedObject var repo: GitRepoModel
    @ObservedObject var log: GitHistoryModel
    var onOpenFile: (GitStatusEntry, _ staged: Bool) -> Void
    var onOpenCommit: (GitCommit) -> Void

    @StateObject private var dates = GitChangeDates()
    @StateObject private var derived = GitRepoPanelLists()
    @AppStorage("genesiskit.gitRepoPanel.order") private var orderRaw = GitChangeOrder.lastUpdate.rawValue
    @AppStorage("genesiskit.gitRepoPanel.untracked") private var showUntracked = true
    @State private var filter = ""
    @State private var openFolders: Set<String> = []
    @State private var shown: [String: Int] = [:]
    /// The row "Show the open file" picked, lit for a moment.
    @State private var flash: String?
    /// The row the keys move (a file row's id or a folder row's `folderRowID`); Return opens it.
    @State private var keyed: String?
    @FocusState private var listFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The open file, relative to the repository's root: the reveal button scrolls to its row.
    var revealPath: String?

    /// Rows a list shows before "Show more".
    static let page = 100

    public init(repo: GitRepoModel, log: GitHistoryModel, revealPath: String? = nil,
                onOpenFile: @escaping (GitStatusEntry, Bool) -> Void, onOpenCommit: @escaping (GitCommit) -> Void) {
        self.repo = repo
        self.log = log
        self.revealPath = revealPath
        self.onOpenFile = onOpenFile
        self.onOpenCommit = onOpenCommit
    }

    private var order: GitChangeOrder { GitChangeOrder(rawValue: orderRaw) ?? .lastUpdate }

    private var inputs: GitRepoPanelLists.Inputs {
        GitRepoPanelLists.Inputs(root: repo.root, generation: repo.generation, datesVersion: dates.version, order: order, filter: filter, untracked: showUntracked)
    }

    public var body: some View {
        let _ = RenderProbe.hit("git.repoPanel")
        ScrollViewReader { proxy in
            panel(proxy)
        }
    }

    private func panel(_ proxy: ScrollViewProxy) -> some View {
        LazyVStack(alignment: .leading, spacing: 1) {
            if let failure = repo.failure {
                GitFailureNotice(failure) { repo.retry() }
                    .padding(.vertical, 4)
            }
            if let status = repo.status {
                branch(status)
                controls(proxy)
                    .padding(.vertical, 6)
                let lists = derived.lists(for: repo.root)
                list("Staged", lists.staged, key: "staged", staged: true)
                list("Changes", lists.changed, key: "changes", staged: false)
                if showUntracked {
                    untracked(lists)
                }
                emptyState(status, lists)
            } else if repo.failure == nil {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading the repository")
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
            if !log.commits.isEmpty {
                Text("Recent commits")
                    .kicker()
                    .padding(.top, 10)
                GitCommitList(commits: log.commits, onOpen: onOpenCommit)
            }
        }
        .focusable()
        .focused($listFocused)
        .focusEffectDisabled()
        .onKeyPress(.upArrow, phases: [.down, .repeat]) { _ in moveKeyed(-1, proxy) }
        .onKeyPress(.downArrow, phases: [.down, .repeat]) { _ in moveKeyed(1, proxy) }
        .onKeyPress(.return) { activateKeyed(open: nil) }
        .onKeyPress(.rightArrow) { activateKeyed(open: true) }
        .onKeyPress(.leftArrow) { activateKeyed(open: false) }
        .onKeyPress(.escape) {
            guard keyed != nil else { return .ignored }
            keyed = nil
            return .handled
        }
        .task(id: GitChangeDates.Key(root: repo.root, generation: repo.generation)) {
            dates.load(root: repo.root, entries: repo.status?.entries ?? [], generation: repo.generation)
        }
        .task(id: inputs) {
            derived.update(inputs, entries: repo.status?.entries ?? [], dates: dates.dates)
        }
    }

    private func branch(_ status: GitRepoStatus) -> some View {
        let tracking = Self.trackingText(status)
        return HStack(spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.branch")
                Text(verbatim: status.branch)
                    .font(.system(size: 12, weight: .semibold))
                    .lineLimit(1)
                if status.ahead > 0 { Text(verbatim: "↑\(status.ahead)").foregroundStyle(.secondary) }
                if status.behind > 0 { Text(verbatim: "↓\(status.behind)").foregroundStyle(.secondary) }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: "Branch \(status.branch), \(tracking)"))
            .instantTooltip(tracking)
            Spacer(minLength: 0)
            IconButton(systemName: "arrow.clockwise", tooltip: "Read the repository's status again", size: 11) { repo.refresh() }
        }
        .font(.system(size: 11))
    }

    /// The branch's upstream and its ahead and behind counts, in words.
    static func trackingText(_ status: GitRepoStatus) -> String {
        guard let upstream = status.upstream else { return "No upstream branch" }
        var counts: [String] = []
        if status.ahead > 0 { counts.append("\(Plural.count(status.ahead, "commit")) ahead") }
        if status.behind > 0 { counts.append("\(Plural.count(status.behind, "commit")) behind") }
        return "Tracks \(upstream)" + (counts.isEmpty ? ", up to date" : ": " + counts.joined(separator: ", "))
    }

    /// Why the lists are empty: a clean repository, a filter that matches nothing, or untracked files hidden.
    @ViewBuilder
    private func emptyState(_ status: GitRepoStatus, _ lists: GitRepoPanelLists.Lists) -> some View {
        let shownCount = lists.staged.count + lists.changed.count + (showUntracked ? lists.untrackedTotal : 0)
        if status.entries.isEmpty {
            emptyText("No uncommitted changes.")
        } else if shownCount == 0, derived.settled == inputs {
            if !filter.isEmpty {
                emptyRow("No file matches “\(filter)”.", action: "Clear filter") { filter = "" }
            } else if !showUntracked {
                let hidden = status.entries.filter { $0.unstaged == .untracked }.count
                emptyRow("\(Plural.count(hidden, "untracked file")) \(hidden == 1 ? "is" : "are") hidden.", action: "Show") { showUntracked = true }
            }
        }
    }

    private func emptyText(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
            .padding(.vertical, 4)
    }

    private func emptyRow(_ text: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack(spacing: 8) {
            emptyText(text)
            Button(action, action: perform)
                .buttonStyle(.genHoverPlain())
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(Color.accentColor)
        }
        .accessibilityIdentifier("git-repo-empty")
    }

    /// The sort button (a click takes the next order, a right-click lists them all), the filter, the untracked switch.
    private func controls(_ proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 6) {
            Button {
                orderRaw = order.next.rawValue
            } label: {
                Label(order.title, systemImage: "arrow.up.arrow.down")
                    .font(.system(size: 11))
                    .lineLimit(1)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 5))
            .fixedSize()
            .contextMenu {
                ForEach(GitChangeOrder.allCases, id: \.self) { option in
                    Button {
                        orderRaw = option.rawValue
                    } label: {
                        if option == order {
                            Label(option.title, systemImage: "checkmark")
                        } else {
                            Text(option.title)
                        }
                    }
                }
            }
            .instantTooltip("Ordered by \(order.title.lowercased()). Click for \(order.next.title.lowercased()); right-click for every order.")
            TextField("Filter", text: $filter)
                .textFieldStyle(.roundedBorder)
                .controlSize(.small)
                .font(.system(size: 11))
                .onExitCommand { filter = "" }
                .accessibilityLabel("Filter files")
            if !filter.isEmpty {
                IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the filter (Esc)", size: 11, tint: .secondary) { filter = "" }
            }
            let listed = revealTarget(in: derived.lists(for: repo.root)) != nil
            IconButton(systemName: "scope", tooltip: listed ? "Show the open file in the list" : "The open file has no changes here", size: 11) {
                reveal(proxy)
            }
            .disabled(!listed)
            .accessibilityIdentifier("git-repo-reveal")
            IconButton(
                systemName: showUntracked ? "questionmark.folder.fill" : "questionmark.folder",
                tooltip: showUntracked ? "Hide untracked files" : "Show untracked files",
                size: 11,
                tint: showUntracked ? .accentColor : nil
            ) { showUntracked.toggle() }
        }
    }

    /// Where the open file's row is: its list's key, the folder it is folded in, and its place in that list.
    private func revealTarget(in lists: GitRepoPanelLists.Lists) -> (key: String, folder: String?, index: Int)? {
        revealPath.flatMap { Self.revealTarget(path: $0, in: lists) }
    }

    static func revealTarget(path: String, in lists: GitRepoPanelLists.Lists) -> (key: String, folder: String?, index: Int)? {
        for (key, entries) in [("changes", lists.changed), ("staged", lists.staged), ("untracked", lists.loose)] {
            if let index = entries.firstIndex(where: { $0.path == path }) {
                return (key, nil, index)
            }
        }
        for group in lists.groups {
            if let index = group.files.firstIndex(where: { $0.path == path }) {
                return ("folder:" + group.folder, group.folder, index)
            }
        }
        return nil
    }

    /// Opens the open file's folder and page when needed, scrolls its row to the middle and lights it for a moment.
    private func reveal(_ proxy: ScrollViewProxy) {
        guard let path = revealPath, let target = revealTarget(in: derived.lists(for: repo.root)) else { return }
        if let folder = target.folder {
            openFolders.insert(folder)
        }
        if target.index >= shown[target.key] ?? Self.page {
            shown[target.key] = (target.index / Self.page + 1) * Self.page
        }
        let id = target.key + ":" + path
        // On the next turn: a folder just opened or a page just grown has no row to scroll to yet.
        DispatchQueue.main.async {
            withAnimation(reduceMotion ? nil : .easeInOut(duration: 0.3)) {
                proxy.scrollTo(id, anchor: .center)
            }
            flash = id
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                guard flash == id else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.4)) { flash = nil }
            }
        }
    }

    @ViewBuilder
    private func list(_ title: String, _ entries: [GitStatusEntry], key: String, staged: Bool) -> some View {
        if !entries.isEmpty {
            Text(verbatim: "\(title) · \(entries.count)")
                .kicker()
                .padding(.top, 6)
            let limit = shown[key] ?? Self.page
            ForEach(entries.prefix(limit)) { entry in
                row(entry, staged: staged, indent: 0, id: key + ":" + entry.path)
            }
            more(key: key, total: entries.count, limit: limit, indent: 0)
        }
    }

    @ViewBuilder
    private func untracked(_ lists: GitRepoPanelLists.Lists) -> some View {
        if lists.untrackedTotal > 0 {
            Text(verbatim: "Untracked · \(lists.untrackedTotal)")
                .kicker()
                .padding(.top, 6)
            ForEach(lists.groups) { group in
                folderRow(group, newest: lists.newest[group.folder])
                if openFolders.contains(group.folder) || !filter.isEmpty {
                    let key = "folder:" + group.folder
                    let limit = shown[key] ?? Self.page
                    ForEach(group.files.prefix(limit)) { entry in
                        row(entry, staged: false, indent: 16, id: key + ":" + entry.path)
                    }
                    more(key: key, total: group.files.count, limit: limit, indent: 16)
                }
            }
            let limit = shown["untracked"] ?? Self.page
            ForEach(lists.loose.prefix(limit)) { entry in
                row(entry, staged: false, indent: 0, id: "untracked:" + entry.path)
            }
            more(key: "untracked", total: lists.loose.count, limit: limit, indent: 0)
        }
    }

    private func folderRow(_ group: GitUntrackedGroup, newest: Date?) -> some View {
        let open = openFolders.contains(group.folder) || !filter.isEmpty
        return Button {
            if openFolders.contains(group.folder) {
                openFolders.remove(group.folder)
            } else {
                openFolders.insert(group.folder)
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: "folder")
                    .font(.system(size: 11))
                    .foregroundStyle(GitChangeKind.untracked.color)
                Text(verbatim: (group.folder as NSString).lastPathComponent + "/")
                    .font(.system(size: 11.5))
                    .lineLimit(1)
                Text(verbatim: (group.folder as NSString).deletingLastPathComponent)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                Text(verbatim: Plural.count(group.files.count, "file"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                if order == .lastUpdate, let newest {
                    age(newest)
                }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 5))
        // The system tooltip, not `instantTooltip`: that one puts an AppKit hover view on every row, and scrolling the
        // list made and dropped one per row (Martin, 2026-10-13: the panel lagged while scrolling).
        .help(group.folder + "/")
        .overlay(keyedRing(Self.folderRowID(group.folder)))
        .accessibilityValue(open ? "Expanded" : "Collapsed")
        .id(Self.folderRowID(group.folder))
    }

    static func folderRowID(_ folder: String) -> String { "folder-row:" + folder }

    private func keyedRing(_ id: String) -> some View {
        RoundedRectangle(cornerRadius: 5)
            .strokeBorder(Color.accentColor.opacity(listFocused && keyed == id ? 0.8 : 0), lineWidth: 1.5)
            .allowsHitTesting(false)
    }

    /// The rows the keys walk, in the order the panel draws them.
    enum KeyRow: Equatable {
        case file(GitStatusEntry, staged: Bool, id: String)
        case folder(String)

        var id: String {
            switch self {
            case .file(_, _, let id): return id
            case .folder(let folder): return GitRepoPanel.folderRowID(folder)
            }
        }
    }

    static func keyRows(_ lists: GitRepoPanelLists.Lists, untracked: Bool, isOpen: (String) -> Bool, limit: (String) -> Int) -> [KeyRow] {
        var rows: [KeyRow] = []
        rows += lists.staged.prefix(limit("staged")).map { .file($0, staged: true, id: "staged:" + $0.path) }
        rows += lists.changed.prefix(limit("changes")).map { .file($0, staged: false, id: "changes:" + $0.path) }
        guard untracked else { return rows }
        for group in lists.groups {
            rows.append(.folder(group.folder))
            if isOpen(group.folder) {
                let key = "folder:" + group.folder
                rows += group.files.prefix(limit(key)).map { .file($0, staged: false, id: key + ":" + $0.path) }
            }
        }
        rows += lists.loose.prefix(limit("untracked")).map { .file($0, staged: false, id: "untracked:" + $0.path) }
        return rows
    }

    private var keyRows: [KeyRow] {
        Self.keyRows(derived.lists(for: repo.root), untracked: showUntracked,
                     isOpen: { openFolders.contains($0) || !filter.isEmpty }, limit: { shown[$0] ?? Self.page })
    }

    private func moveKeyed(_ step: Int, _ proxy: ScrollViewProxy) -> KeyPress.Result {
        let rows = keyRows
        guard !rows.isEmpty else { return .ignored }
        let index = rows.firstIndex { $0.id == keyed }.map { min(max($0 + step, 0), rows.count - 1) } ?? (step > 0 ? 0 : rows.count - 1)
        let id = rows[index].id
        keyed = id
        proxy.scrollTo(id)
        return .handled
    }

    /// Return opens the keyed file or flips its folder; Right and Left open and close a folder.
    private func activateKeyed(open: Bool?) -> KeyPress.Result {
        guard let row = keyRows.first(where: { $0.id == keyed }) else { return .ignored }
        switch row {
        case .file(let entry, let staged, _):
            guard open == nil else { return .ignored }
            onOpenFile(entry, staged)
        case .folder(let folder):
            let isOpen = openFolders.contains(folder)
            if open ?? !isOpen { openFolders.insert(folder) } else { openFolders.remove(folder) }
        }
        return .handled
    }

    private func row(_ entry: GitStatusEntry, staged: Bool, indent: CGFloat, id: String) -> some View {
        Button {
            keyed = id
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
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                if order == .lastUpdate, let date = dates.dates[entry.path] {
                    age(date)
                }
            }
            .padding(.leading, 8 + indent)
            .padding(.trailing, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 5))
        .background(RoundedRectangle(cornerRadius: 5).fill(Color.accentColor.opacity(flash == id ? 0.3 : 0)))
        .overlay(keyedRing(id))
        .help(entry.path)
        .accessibilityAddTraits(entry.path == revealPath ? .isSelected : [])
        .id(id)
    }

    private func age(_ date: Date) -> some View {
        Text(verbatim: LiveTimeFormat.text(.compact, date, now: Date()) ?? "")
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .fixedSize()
    }

    @ViewBuilder
    private func more(key: String, total: Int, limit: Int, indent: CGFloat) -> some View {
        if total > limit {
            Button {
                shown[key] = limit + Self.page
            } label: {
                Text(verbatim: "Show \(min(Self.page, total - limit)) more of \(total - limit)")
                    .font(.system(size: 11))
                    .foregroundStyle(Color.accentColor)
                    .padding(.leading, 8 + indent)
                    .padding(.vertical, 3)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(RowButtonStyle(cornerRadius: 5))
        }
    }
}
