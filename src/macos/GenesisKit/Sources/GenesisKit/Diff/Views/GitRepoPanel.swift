//
//  GitRepoPanel.swift
//  GenesisKit
//
//  A repository at a glance: branch with ahead and behind, the staged, changed and untracked files, recent commits.
//  A vault can hold thousands of untracked files (a data folder an agent wrote), so untracked files fold under the
//  shallowest folder that holds no other change, as `git status` folds them. The rows live in an AppKit table
//  (`GitRepoTable`) that builds only the rows on screen, so 5,000 rows scroll like 50 and no list needs pages. The sort
//  button cycles Last update, Name, Folder and Kind; in Last update the changed and untracked files and folders form
//  one list, newest first. A filter and an untracked switch sit beside it.
//
//  Costs that shaped it (benchmark on a vault of 5,650 entries, 2026-10-25): the lists are derived off the main thread
//  once per change of their inputs, a status read that finds the same status and the same dates changes nothing, and
//  the panel is `Equatable` so a publish of the window's model does not run it.
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

    /// The last path component, sliced natively (an `NSString` helper bridges and normalizes a Czech path per call).
    static func name(_ path: String) -> Substring {
        path.lastIndex(of: "/").map { path[path.index(after: $0)...] } ?? Substring(path)
    }

    static func folder(_ path: String) -> Substring {
        path.lastIndex(of: "/").map { path[..<$0] } ?? ""
    }

    /// `dates` are the files' modification dates (newest first for Last update); a file without one sorts last. Each
    /// entry's keys are looked up once, not once per comparison.
    public static func sorted(_ entries: [GitStatusEntry], by order: GitChangeOrder, dates: [String: Date], staged: Bool) -> [GitStatusEntry] {
        struct Keyed {
            let entry: GitStatusEntry
            let date: Date
            let name: Substring
            let rank: Int
        }
        let keyed = entries.map { entry in
            Keyed(entry: entry, date: order == .lastUpdate ? dates[entry.path] ?? .distantPast : .distantPast,
                  name: order == .name ? name(entry.path) : "", rank: order == .kind ? rank(staged ? entry.staged : entry.unstaged) : 0)
        }
        return keyed.sorted { lhs, rhs in
            switch order {
            case .lastUpdate:
                if lhs.date != rhs.date { return lhs.date > rhs.date }
            case .name:
                let result = lhs.name.localizedStandardCompare(rhs.name)
                if result != .orderedSame { return result == .orderedAscending }
            case .folder:
                break
            case .kind:
                if lhs.rank != rhs.rank { return lhs.rank < rhs.rank }
            }
            return lhs.entry.path.localizedStandardCompare(rhs.entry.path) == .orderedAscending
        }.map(\.entry)
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
                let result = name(lhs.folder).localizedStandardCompare(name(rhs.folder))
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

/// One row of the panel's table, a value: the table compares rows to know which cells to build again.
enum GitPanelRow: Equatable, Identifiable {
    case section(key: String, title: String)
    case file(entry: GitStatusEntry, staged: Bool, id: String, indent: Bool, date: Date?)
    case folder(folder: String, count: Int, newest: Date?, open: Bool)
    case commitsHeader
    case commit(GitCommit)

    enum Kind: Hashable {
        case section, file, folder, commitsHeader, commit
    }

    var id: String {
        switch self {
        case .section(let key, _): return "section:" + key
        case .file(_, _, let id, _, _): return id
        case .folder(let folder, _, _, _): return GitRepoPanel.folderRowID(folder)
        case .commitsHeader: return "section:commits"
        case .commit(let commit): return "commit:" + commit.sha
        }
    }

    var kind: Kind {
        switch self {
        case .section: return .section
        case .file: return .file
        case .folder: return .folder
        case .commitsHeader: return .commitsHeader
        case .commit: return .commit
        }
    }

    /// The keyboard stops on files, folders and commits, never on a heading.
    var selectable: Bool {
        switch self {
        case .file, .folder, .commit: return true
        case .section, .commitsHeader: return false
        }
    }

    /// What VoiceOver says when the keyboard lands on the row.
    var spoken: String {
        switch self {
        case .section(_, let title): return title
        case .file(let entry, _, _, _, _): return String(GitChangeList.name(entry.path))
        case .folder(let folder, let count, _, let open):
            return "\(GitChangeList.name(folder)), folder, \(Plural.count(count, "file")), \(open ? "expanded" : "collapsed")"
        case .commitsHeader: return "Recent commits"
        case .commit(let commit): return commit.subject
        }
    }

    /// What a key does: Up and Down walk the selectable rows (they repeat while held), Return opens a file or a commit
    /// and opens or closes a folder, Right opens and Left closes a folder, Esc lets the keyed row go and is ignored when
    /// nothing is keyed, so it still reaches the window or a sheet.
    enum KeyAction: Equatable {
        case none
        case select(Int)
        case activate(Int)
        case setOpen(Int, Bool)
        case clear
    }

    static func action(for key: MarkdownTreeKey, rows: [GitPanelRow], cursor: Int?) -> KeyAction {
        if key == .escape { return cursor == nil ? .none : .clear }
        let selectable = rows.indices.filter { rows[$0].selectable }
        guard !selectable.isEmpty else { return .none }
        guard let index = cursor, rows.indices.contains(index) else {
            switch key {
            case .down: return .select(selectable[0])
            case .up: return .select(selectable[selectable.count - 1])
            default: return .none
            }
        }
        switch key {
        case .down: return .select(selectable.first { $0 > index } ?? index)
        case .up: return .select(selectable.last { $0 < index } ?? index)
        case .open: return .activate(index)
        case .right, .left:
            guard case .folder(_, _, _, let open) = rows[index] else { return .none }
            let wanted = key == .right
            return open == wanted ? .none : .setOpen(index, wanted)
        case .navigate, .parent, .escape: return .none
        }
    }
}

/// The panel's lists and its files' dates, derived off the main thread. A status read bumps `reads`; the dates are
/// read again then (an edited file stays "modified" but moves up in Last update), and the lists are derived again only
/// when the status, the dates or an input changed. Before, every read re-read 5,650 dates (76 ms), derived the lists
/// twice and re-ran the panel six times, even when nothing had changed (2026-10-25).
@MainActor
final class GitRepoPanelLists: ObservableObject {
    struct Lists: Equatable, Sendable {
        var staged: [GitStatusEntry] = []
        var changed: [GitStatusEntry] = []
        var loose: [GitStatusEntry] = []
        /// Untracked folders, their files sorted.
        var groups: [GitUntrackedGroup] = []
        var newest: [String: Date] = [:]
        var untrackedTotal = 0
        /// Last update with untracked files shown: changes, untracked files and folders in one list, newest first.
        var recent: [Recent] = []
        /// Every listed file's modification date.
        var dates: [String: Date] = [:]
        /// A listed path → its row id and the folder it is folded in: the reveal button's lookup.
        var places: [String: Place] = [:]

        enum Recent: Equatable, Sendable {
            case file(GitStatusEntry)
            case folder(String)
        }

        struct Place: Equatable, Sendable {
            var id: String
            var folder: String?
        }
    }

    struct Inputs: Equatable, Sendable {
        var root: URL
        var order: GitChangeOrder
        var filter: String
        var untracked: Bool
    }

    @Published private(set) var lists = Lists()
    /// The inputs `lists` were derived from; an empty state waits for them, or a stale list would flash "no match".
    private(set) var settled: Inputs?
    private var inputs: Inputs?
    private var status: GitRepoStatus?
    private var reads = -1
    private var ticket = 0
    /// Bumped with each new `lists`, for the row cache.
    private(set) var version = 0
    var readDates: @Sendable (URL, [String]) -> [String: Date] = GitRepoPanelLists.modificationDates

    /// `lstat` per path: about 2.5 µs each, where `URL.resourceValues` cost 76 ms for 5,650 paths.
    nonisolated static func modificationDates(root: URL, paths: [String]) -> [String: Date] {
        var result: [String: Date] = [:]
        result.reserveCapacity(paths.count)
        var info = stat()
        let base = root.path + "/"
        for path in paths where lstat(base + path, &info) == 0 {
            let time = info.st_mtimespec
            result[path] = Date(timeIntervalSince1970: TimeInterval(time.tv_sec) + TimeInterval(time.tv_nsec) / 1_000_000_000)
        }
        return result
    }

    func lists(for root: URL) -> Lists {
        inputs?.root == root ? lists : Lists()
    }

    func update(_ inputs: Inputs, status: GitRepoStatus?, reads: Int) {
        let rootChanged = inputs.root != self.inputs?.root
        let statusChanged = status != self.status
        let inputsChanged = inputs != self.inputs
        let reread = rootChanged || statusChanged || reads != self.reads
        guard reread || inputsChanged else { return }
        if rootChanged {
            lists = Lists()
            settled = nil
            version += 1
        }
        self.inputs = inputs
        self.status = status
        self.reads = reads
        ticket += 1
        let ticket = ticket
        let entries = status?.entries ?? []
        let old = lists
        let readDates = readDates
        Task.detached(priority: .userInitiated) { [weak self] in
            let span = PerfSpans.begin("git.panel.derive", "\(entries.count) entries \(inputs.order.rawValue)")
            let dates = reread ? readDates(inputs.root, entries.map(\.path)) : old.dates
            // A read that found the same status and the same dates, with the same inputs, changes nothing.
            let derive = rootChanged || statusChanged || inputsChanged || dates != old.dates
            let next = derive ? Self.derive(entries, dates: dates, inputs: inputs) : nil
            let changed = next.map { $0 != old } ?? false
            span.end()
            await self?.apply(changed ? next : nil, inputs: inputs, ticket: ticket)
        }
    }

    private func apply(_ next: Lists?, inputs: Inputs, ticket: Int) {
        guard ticket == self.ticket else { return }
        let wasSettled = settled == inputs
        settled = inputs
        if let next {
            version += 1
            lists = next
        } else if !wasSettled {
            // The empty state waits for `settled`: the same lists, now known to answer these inputs.
            objectWillChange.send()
        }
    }

    nonisolated static func derive(_ entries: [GitStatusEntry], dates: [String: Date], inputs: Inputs) -> Lists {
        let filter = inputs.filter
        var lists = Lists()
        lists.dates = dates
        lists.staged = GitChangeList.sorted(
            entries.filter { $0.staged != nil && GitChangeList.matches($0, filter) }, by: inputs.order, dates: dates, staged: true
        )
        lists.changed = GitChangeList.sorted(
            entries.filter { $0.unstaged != nil && $0.unstaged != .untracked && GitChangeList.matches($0, filter) },
            by: inputs.order, dates: dates, staged: false
        )
        for entry in lists.staged { lists.places[entry.path] = Lists.Place(id: "staged:" + entry.path) }
        for entry in lists.changed { lists.places[entry.path] = Lists.Place(id: "changes:" + entry.path) }
        guard inputs.untracked else { return lists }
        let fold = GitChangeList.foldUntracked(entries)
        lists.loose = GitChangeList.sorted(fold.files.filter { GitChangeList.matches($0, filter) }, by: inputs.order, dates: dates, staged: false)
        let groups = fold.groups.compactMap { group -> GitUntrackedGroup? in
            let files = group.files.filter { GitChangeList.matches($0, filter) }
            guard !files.isEmpty else { return nil }
            return GitUntrackedGroup(folder: group.folder, files: GitChangeList.sorted(files, by: inputs.order, dates: dates, staged: false))
        }
        lists.groups = GitChangeList.sorted(groups, by: inputs.order, dates: dates)
        for group in lists.groups {
            lists.newest[group.folder] = group.files.compactMap { dates[$0.path] }.max()
            for entry in group.files {
                lists.places[entry.path] = Lists.Place(id: "folder:\(group.folder):\(entry.path)", folder: group.folder)
            }
        }
        for entry in lists.loose { lists.places[entry.path] = Lists.Place(id: "untracked:" + entry.path) }
        lists.untrackedTotal = lists.loose.count + lists.groups.reduce(0) { $0 + $1.files.count }
        if inputs.order == .lastUpdate {
            // One list, newest first: a change, an untracked file and an untracked folder (by its newest file) compete
            // for the top (Martin, 2026-10-25: the changes section topped out at a note 5 h old while untracked files
            // below it were a minute old).
            var items: [(date: Date, path: String, item: Lists.Recent)] = []
            items += lists.changed.map { (dates[$0.path] ?? .distantPast, $0.path, .file($0)) }
            items += lists.loose.map { (dates[$0.path] ?? .distantPast, $0.path, .file($0)) }
            items += lists.groups.map { (lists.newest[$0.folder] ?? .distantPast, $0.folder, .folder($0.folder)) }
            items.sort { $0.date != $1.date ? $0.date > $1.date : $0.path.localizedStandardCompare($1.path) == .orderedAscending }
            lists.recent = items.map(\.item)
        }
        return lists
    }
}

/// A repository at a glance: branch with ahead and behind, the staged, changed and untracked files, recent commits.
/// `Equatable` on what it shows (the repository, its log, the open file), not on its callbacks: the parent builds it
/// with new closures on every render, and before this every publish of the window's model ran the panel again
/// (+13.9 ms per publish, +45 ms per tab switch on a vault, 2026-10-25).
public struct GitRepoPanel: View, Equatable {
    @ObservedObject var repo: GitRepoModel
    @ObservedObject var log: GitHistoryModel
    var onOpenFile: (GitStatusEntry, _ staged: Bool) -> Void
    var onOpenCommit: (GitCommit) -> Void

    @StateObject private var derived = GitRepoPanelLists()
    @AppStorage("genesiskit.gitRepoPanel.order") private var orderRaw = GitChangeOrder.lastUpdate.rawValue
    @AppStorage("genesiskit.gitRepoPanel.untracked") private var showUntracked = true
    @State private var filter = ""
    @State private var openFolders: Set<String> = []
    /// The row "Show the open file" picked, lit for a moment.
    @State private var flash: String?
    @State private var box = GitRepoTableBox()
    @State private var rowCache = RowCache()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    /// The open file, relative to the repository's root: the reveal button scrolls to its row.
    var revealPath: String?

    public init(repo: GitRepoModel, log: GitHistoryModel, revealPath: String? = nil,
                onOpenFile: @escaping (GitStatusEntry, Bool) -> Void, onOpenCommit: @escaping (GitCommit) -> Void) {
        self.repo = repo
        self.log = log
        self.revealPath = revealPath
        self.onOpenFile = onOpenFile
        self.onOpenCommit = onOpenCommit
    }

    public static func == (lhs: GitRepoPanel, rhs: GitRepoPanel) -> Bool {
        lhs.repo === rhs.repo && lhs.log === rhs.log && lhs.revealPath == rhs.revealPath
    }

    private var order: GitChangeOrder { GitChangeOrder(rawValue: orderRaw) ?? .lastUpdate }

    private var inputs: GitRepoPanelLists.Inputs {
        GitRepoPanelLists.Inputs(root: repo.root, order: order, filter: filter, untracked: showUntracked)
    }

    private struct TaskKey: Equatable {
        let inputs: GitRepoPanelLists.Inputs
        let reads: Int
    }

    private struct Revision: Equatable {
        let flash: String?
        let revealPath: String?
    }

    public var body: some View {
        let _ = RenderProbe.hit("git.repoPanel")
        let lists = derived.lists(for: repo.root)
        // The rows follow the inputs the lists were derived for, not the controls' state: a click on the sort button
        // changes the rows once, when the new lists arrive, instead of once with the old lists and once with the new.
        let shape = derived.settled ?? inputs
        let rows = rowCache.rows(version: derived.version, root: repo.root, key: RowCache.Key(
            order: shape.order, untracked: shape.untracked, filtering: !shape.filter.isEmpty, open: openFolders, commits: log.commits)) {
            Self.rows(lists, order: shape.order, untracked: shape.untracked,
                      isOpen: { openFolders.contains($0) || !shape.filter.isEmpty }, commits: log.commits)
        }
        VStack(alignment: .leading, spacing: 0) {
            header(lists)
                .padding(.horizontal, 8)
                .padding(.top, 8)
            GitRepoTable(rows: rows, revision: Revision(flash: flash, revealPath: revealPath), box: box, keys: keys) { row in
                AnyView(cell(row))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .padding(.horizontal, 8)
        }
        .task(id: TaskKey(inputs: inputs, reads: repo.reads)) {
            derived.update(inputs, status: repo.status, reads: repo.reads)
        }
        // Main-thread busy time after each interaction, written to perf.log (`main busy … git.panel.*`), so a later
        // build's numbers can be compared with these without a bench.
        .onAppear { PerfMainBusy.measure("git.panel.open") }
        .onChange(of: orderRaw) { _, _ in PerfMainBusy.measure("git.panel.sort") }
        .onChange(of: filter) { _, _ in PerfMainBusy.measure("git.panel.filter") }
        .onChange(of: openFolders) { _, _ in PerfMainBusy.measure("git.panel.fold") }
        .onChange(of: showUntracked) { _, _ in PerfMainBusy.measure("git.panel.untracked") }
    }

    // MARK: Rows

    /// The rows in drawn order. Other orders: Staged, Changes, Untracked (folders, then loose files). Last update with
    /// untracked files shown: Staged, then one Changes list newest first. An open folder's files follow its row.
    static func rows(_ lists: GitRepoPanelLists.Lists, order: GitChangeOrder, untracked: Bool, isOpen: (String) -> Bool,
                     commits: [GitCommit]) -> [GitPanelRow] {
        var rows: [GitPanelRow] = []
        let dated = order == .lastUpdate
        func file(_ entry: GitStatusEntry, staged: Bool, id: String, indent: Bool = false) -> GitPanelRow {
            .file(entry: entry, staged: staged, id: id, indent: indent, date: dated ? lists.dates[entry.path] : nil)
        }
        func folder(_ group: GitUntrackedGroup) {
            let open = isOpen(group.folder)
            rows.append(.folder(folder: group.folder, count: group.files.count, newest: dated ? lists.newest[group.folder] : nil, open: open))
            guard open else { return }
            rows += group.files.map { file($0, staged: false, id: "folder:\(group.folder):\($0.path)", indent: true) }
        }
        if !lists.staged.isEmpty {
            rows.append(.section(key: "staged", title: "Staged · \(lists.staged.count)"))
            rows += lists.staged.map { file($0, staged: true, id: "staged:" + $0.path) }
        }
        if untracked, order == .lastUpdate {
            let total = lists.changed.count + lists.untrackedTotal
            if total > 0 {
                rows.append(.section(key: "changes", title: "Changes · \(total)"))
                let groups = Dictionary(lists.groups.map { ($0.folder, $0) }, uniquingKeysWith: { first, _ in first })
                for item in lists.recent {
                    switch item {
                    case .file(let entry):
                        rows.append(file(entry, staged: false, id: (entry.unstaged == .untracked ? "untracked:" : "changes:") + entry.path))
                    case .folder(let name):
                        if let group = groups[name] { folder(group) }
                    }
                }
            }
        } else {
            if !lists.changed.isEmpty {
                rows.append(.section(key: "changes", title: "Changes · \(lists.changed.count)"))
                rows += lists.changed.map { file($0, staged: false, id: "changes:" + $0.path) }
            }
            if untracked, lists.untrackedTotal > 0 {
                rows.append(.section(key: "untracked", title: "Untracked · \(lists.untrackedTotal)"))
                lists.groups.forEach(folder)
                rows += lists.loose.map { file($0, staged: false, id: "untracked:" + $0.path) }
            }
        }
        if !commits.isEmpty {
            rows.append(.commitsHeader)
            rows += commits.map { .commit($0) }
        }
        return rows
    }

    /// The rows the keys walk, in drawn order (the file, folder and commit rows).
    static func keyRows(_ rows: [GitPanelRow]) -> [String] {
        rows.filter(\.selectable).map(\.id)
    }

    /// Rows are built once per change of the lists or of what the rows show, not on every render (the filter field's
    /// keystrokes render the panel before the new lists arrive).
    @MainActor
    final class RowCache {
        struct Key: Equatable {
            let order: GitChangeOrder
            let untracked: Bool
            let filtering: Bool
            let open: Set<String>
            let commits: [GitCommit]
        }
        private var last: (version: Int, root: URL, key: Key, rows: [GitPanelRow])?

        func rows(version: Int, root: URL, key: Key, build: () -> [GitPanelRow]) -> [GitPanelRow] {
            if let last, last.version == version, last.root == root, last.key == key { return last.rows }
            let rows = build()
            last = (version, root, key, rows)
            return rows
        }
    }

    private var keys: GitRepoTableKeys {
        GitRepoTableKeys(
            activate: { row in activate(row, open: nil) },
            setOpen: { row, open in activate(row, open: open) },
            start: { rows in revealPath.flatMap { path in rows.firstIndex { $0.id == derived.lists.places[path]?.id } } }
        )
    }

    /// Return opens the keyed file or commit, or flips its folder; Right and Left open and close a folder.
    private func activate(_ row: GitPanelRow, open: Bool?) {
        switch row {
        case .file(let entry, let staged, _, _, _):
            guard open == nil else { return }
            onOpenFile(entry, staged)
        case .folder(let folder, _, _, let isOpen):
            if open ?? !isOpen { openFolders.insert(folder) } else { openFolders.remove(folder) }
        case .commit(let commit):
            guard open == nil else { return }
            onOpenCommit(commit)
        case .section, .commitsHeader:
            break
        }
    }

    // MARK: Header

    @ViewBuilder
    private func header(_ lists: GitRepoPanelLists.Lists) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            if let failure = repo.failure {
                GitFailureNotice(failure) { repo.retry() }
                    .padding(.vertical, 4)
            }
            if let failure = log.failure {
                GitFailureNotice(failure) { log.reload() }
                    .padding(.vertical, 4)
            }
            if let status = repo.status {
                branch(status)
                controls(lists)
                    .padding(.vertical, 6)
                emptyState(status, lists)
            } else if repo.failure == nil {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading the repository")
                }
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
            }
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

    /// The sort button (a click takes the next order, a right-click lists them all), the filter, the reveal button and
    /// the untracked switch.
    private func controls(_ lists: GitRepoPanelLists.Lists) -> some View {
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
            let listed = revealPath.flatMap { lists.places[$0] } != nil
            IconButton(systemName: "scope", tooltip: listed ? "Show the open file in the list" : "The open file has no changes here", size: 11) {
                reveal(lists)
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

    /// Opens the open file's folder when needed, scrolls its row to the middle and lights it for a moment.
    private func reveal(_ lists: GitRepoPanelLists.Lists) {
        guard let path = revealPath, let place = lists.places[path] else { return }
        if let folder = place.folder { openFolders.insert(folder) }
        // On the next turn: a folder just opened has no row to scroll to yet.
        DispatchQueue.main.async {
            box.reveal(place.id, reduceMotion: reduceMotion)
            flash = place.id
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) {
                if flash == place.id { flash = nil }
            }
        }
    }

    static func folderRowID(_ folder: String) -> String { "folder-row:" + folder }

    // MARK: Cells

    @ViewBuilder
    private func cell(_ row: GitPanelRow) -> some View {
        let _ = RenderProbe.hit("git.row")
        switch row {
        // Every row is one height (the table's): headings sit on the row's bottom edge, a commit is one line.
        case .section(_, let title):
            Text(verbatim: title)
                .kicker()
                .padding(.bottom, 2)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .accessibilityAddTraits(.isHeader)
        case .commitsHeader:
            Text("Recent commits")
                .kicker()
                .padding(.bottom, 2)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .accessibilityAddTraits(.isHeader)
        case .file(let entry, let staged, let id, let indent, let date):
            fileRow(entry, staged: staged, id: id, indent: indent, date: date)
        case .folder(let folder, let count, let newest, let open):
            folderRow(folder, count: count, newest: newest, open: open)
        case .commit(let commit):
            Button {
                onOpenCommit(commit)
            } label: {
                HStack(spacing: 6) {
                    Text(verbatim: commit.short)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(.secondary)
                    Text(verbatim: commit.subject)
                        .font(.system(size: 11.5))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    age(commit.date)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .help("\(commit.subject)\n\(commit.author) · \(commit.short)")
            .buttonStyle(RowButtonStyle(cornerRadius: 5))
            .accessibilityAction(named: "Copy commit id") { Clipboard.copy(commit.sha, what: "commit id") }
            .accessibilityIdentifier("git-commit-\(commit.short)")
        }
    }

    private func folderRow(_ folder: String, count: Int, newest: Date?, open: Bool) -> some View {
        Button {
            if openFolders.contains(folder) { openFolders.remove(folder) } else { openFolders.insert(folder) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 10)
                Image(systemName: "folder")
                    .font(.system(size: 11))
                    .foregroundStyle(GitChangeKind.untracked.color)
                Text(verbatim: GitChangeList.name(folder) + "/")
                    .font(.system(size: 11.5))
                    .lineLimit(1)
                Text(verbatim: String(GitChangeList.folder(folder)))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                Text(verbatim: Plural.count(count, "file"))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .fixedSize()
                if let newest { age(newest) }
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 5))
        // The system tooltip, not `instantTooltip`: that one puts an AppKit hover view on every row.
        .help(folder + "/")
        .accessibilityValue(open ? "Expanded" : "Collapsed")
    }

    private func fileRow(_ entry: GitStatusEntry, staged: Bool, id: String, indent: Bool, date: Date?) -> some View {
        Button {
            onOpenFile(entry, staged)
        } label: {
            HStack(spacing: 6) {
                if let kind = staged ? entry.staged : entry.unstaged {
                    GitChangeMark(kind)
                }
                Text(verbatim: String(GitChangeList.name(entry.path)))
                    .font(.system(size: 11.5))
                    .lineLimit(1)
                Text(verbatim: String(GitChangeList.folder(entry.path)))
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                if let date { age(date) }
            }
            .padding(.leading, 8 + (indent ? 16 : 0))
            .padding(.trailing, 8)
            .padding(.vertical, 3)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .buttonStyle(RowButtonStyle(cornerRadius: 5))
        .background(RoundedRectangle(cornerRadius: 5).fill(Color.accentColor.opacity(flash == id ? 0.3 : 0)))
        // A rename says where it came from: a folder moved outside git pairs its files (GitWorktreeRenames).
        .help(entry.oldPath.map { "\($0) → \(entry.path)" } ?? entry.path)
        .accessibilityAddTraits(entry.path == revealPath ? .isSelected : [])
    }

    private func age(_ date: Date) -> some View {
        Text(verbatim: LiveTimeFormat.text(.compact, date, now: Date()) ?? "")
            .font(.system(size: 11))
            .monospacedDigit()
            .foregroundStyle(.secondary)
            .fixedSize()
    }
}
