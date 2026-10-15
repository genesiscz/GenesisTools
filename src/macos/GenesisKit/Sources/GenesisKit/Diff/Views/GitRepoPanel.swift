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
        var changedFolders = Set<String>()
        for entry in entries where entry.unstaged != .untracked {
            for path in [entry.path, entry.oldPath].compactMap({ $0 }) {
                var folder = (path as NSString).deletingLastPathComponent
                while !folder.isEmpty, changedFolders.insert(folder).inserted {
                    folder = (folder as NSString).deletingLastPathComponent
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
        func newest(_ group: GitUntrackedGroup) -> Date {
            group.files.compactMap { dates[$0.path] }.max() ?? .distantPast
        }
        return groups.sorted { lhs, rhs in
            switch order {
            case .lastUpdate:
                let left = newest(lhs), right = newest(rhs)
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
    @Published private(set) var dates: [String: Date] = [:]
    private var loadedRoot: String?
    private var loadedGeneration = -1

    func load(root: URL, entries: [GitStatusEntry], generation: Int) {
        guard loadedRoot != root.path || loadedGeneration != generation else { return }
        loadedRoot = root.path
        loadedGeneration = generation
        let paths = entries.map(\.path)
        Task.detached(priority: .utility) { [weak self] in
            var result: [String: Date] = [:]
            for path in paths {
                let values = try? root.appendingPathComponent(path).resourceValues(forKeys: [.contentModificationDateKey])
                if let date = values?.contentModificationDate { result[path] = date }
            }
            await self?.apply(result, generation: generation)
        }
    }

    private func apply(_ result: [String: Date], generation: Int) {
        guard generation == loadedGeneration else { return }
        dates = result
    }
}

/// A repository at a glance: branch with ahead and behind, the staged, changed and untracked files, recent commits.
public struct GitRepoPanel: View {
    @ObservedObject var repo: GitRepoModel
    @ObservedObject var log: GitHistoryModel
    var onOpenFile: (GitStatusEntry, _ staged: Bool) -> Void
    var onOpenCommit: (GitCommit) -> Void

    @StateObject private var dates = GitChangeDates()
    @AppStorage("genesiskit.gitRepoPanel.order") private var orderRaw = GitChangeOrder.lastUpdate.rawValue
    @AppStorage("genesiskit.gitRepoPanel.untracked") private var showUntracked = true
    @State private var filter = ""
    @State private var openFolders: Set<String> = []
    @State private var shown: [String: Int] = [:]

    /// Rows a list shows before "Show more".
    static let page = 100

    public init(repo: GitRepoModel, log: GitHistoryModel, onOpenFile: @escaping (GitStatusEntry, Bool) -> Void,
                onOpenCommit: @escaping (GitCommit) -> Void) {
        self.repo = repo
        self.log = log
        self.onOpenFile = onOpenFile
        self.onOpenCommit = onOpenCommit
    }

    private var order: GitChangeOrder { GitChangeOrder(rawValue: orderRaw) ?? .lastUpdate }

    public var body: some View {
        LazyVStack(alignment: .leading, spacing: 1) {
            if let status = repo.status {
                branch(status)
                controls
                    .padding(.vertical, 6)
                let staged = GitChangeList.sorted(
                    status.staged.filter { GitChangeList.matches($0, filter) }, by: order, dates: dates.dates, staged: true
                )
                let changed = GitChangeList.sorted(
                    status.unstaged.filter { $0.unstaged != .untracked && GitChangeList.matches($0, filter) },
                    by: order, dates: dates.dates, staged: false
                )
                list("Staged", staged, key: "staged", staged: true)
                list("Changes", changed, key: "changes", staged: false)
                if showUntracked {
                    untracked(status)
                }
                if status.entries.isEmpty {
                    Text("No uncommitted changes.")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
            }
            if !log.commits.isEmpty {
                Text("Recent commits")
                    .kicker()
                    .padding(.top, 10)
                GitCommitList(commits: log.commits, onOpen: onOpenCommit)
            }
        }
        .task(id: repo.generation) {
            dates.load(root: repo.root, entries: repo.status?.entries ?? [], generation: repo.generation)
        }
    }

    private func branch(_ status: GitRepoStatus) -> some View {
        HStack(spacing: 6) {
            Image(systemName: "arrow.triangle.branch")
            Text(verbatim: status.branch)
                .font(.system(size: 12, weight: .semibold))
                .lineLimit(1)
            if status.ahead > 0 { Text(verbatim: "↑\(status.ahead)").foregroundStyle(.secondary) }
            if status.behind > 0 { Text(verbatim: "↓\(status.behind)").foregroundStyle(.secondary) }
            Spacer(minLength: 0)
            IconButton(systemName: "arrow.clockwise", tooltip: "Read the repository's status again", size: 11) { repo.refresh() }
        }
        .font(.system(size: 11))
        .instantTooltip(status.upstream.map { "Tracks \($0)" } ?? "No upstream branch")
    }

    /// The sort button (a click takes the next order, a right-click lists them all), the filter, the untracked switch.
    private var controls: some View {
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
            IconButton(
                systemName: showUntracked ? "questionmark.folder.fill" : "questionmark.folder",
                tooltip: showUntracked ? "Hide untracked files" : "Show untracked files",
                size: 11,
                tint: showUntracked ? .accentColor : nil
            ) { showUntracked.toggle() }
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
                row(entry, staged: staged, indent: 0)
            }
            more(key: key, total: entries.count, limit: limit, indent: 0)
        }
    }

    @ViewBuilder
    private func untracked(_ status: GitRepoStatus) -> some View {
        let fold = GitChangeList.foldUntracked(status.entries)
        let files = GitChangeList.sorted(fold.files.filter { GitChangeList.matches($0, filter) }, by: order, dates: dates.dates, staged: false)
        let groups = GitChangeList.sorted(
            fold.groups.compactMap { group -> GitUntrackedGroup? in
                let files = group.files.filter { GitChangeList.matches($0, filter) }
                return files.isEmpty ? nil : GitUntrackedGroup(folder: group.folder, files: files)
            },
            by: order,
            dates: dates.dates
        )
        let total = files.count + groups.reduce(0) { $0 + $1.files.count }
        if total > 0 {
            Text(verbatim: "Untracked · \(total)")
                .kicker()
                .padding(.top, 6)
            ForEach(groups) { group in
                folderRow(group)
                if openFolders.contains(group.folder) || !filter.isEmpty {
                    let key = "folder:" + group.folder
                    let limit = shown[key] ?? Self.page
                    ForEach(GitChangeList.sorted(group.files, by: order, dates: dates.dates, staged: false).prefix(limit)) { entry in
                        row(entry, staged: false, indent: 16)
                    }
                    more(key: key, total: group.files.count, limit: limit, indent: 16)
                }
            }
            let limit = shown["untracked"] ?? Self.page
            ForEach(files.prefix(limit)) { entry in
                row(entry, staged: false, indent: 0)
            }
            more(key: "untracked", total: files.count, limit: limit, indent: 0)
        }
    }

    private func folderRow(_ group: GitUntrackedGroup) -> some View {
        let open = openFolders.contains(group.folder) || !filter.isEmpty
        let newest = group.files.compactMap { dates.dates[$0.path] }.max()
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
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.head)
                Spacer(minLength: 0)
                Text(verbatim: "\(group.files.count) files")
                    .font(.system(size: 10))
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
        .instantTooltip(group.folder + "/")
    }

    private func row(_ entry: GitStatusEntry, staged: Bool, indent: CGFloat) -> some View {
        Button {
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
                    .font(.system(size: 10))
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
        .instantTooltip(entry.path)
    }

    private func age(_ date: Date) -> some View {
        Text(verbatim: LiveTimeFormat.text(.compact, date, now: Date()) ?? "")
            .font(.system(size: 10))
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
