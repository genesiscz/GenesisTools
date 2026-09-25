import Foundation
import SwiftUI

// Worktrees mode → "Clean up worktrees": the linked worktrees that can go without losing anything,
// from `tools hub worktrees list` (src/hub/lib/worktrees.ts). A row is removable when its branch is
// in the base (`tools git merged` logic: ancestor, rebase, squash or content), nothing in it is
// uncommitted or untracked, no stash names it, nothing runs in it and no agent session wrote in it
// in the last 30 minutes. Sizes come from the `tools du` core, a few worktrees per call, after the
// list. Removal re-checks every row and runs plain `git worktree remove` (never --force); the
// branch stays.

enum WorktreeCleanup {
    /// The Worktrees mode's selection that shows this panel instead of one worktree.
    static let selectionID = "::cleanup"
    static let showBlockedKey = "hub.worktreeCleanup.showBlocked"

    /// `--worktree <path>`, `--worktree cleanup`, or `--worktree cleanup-blocked` (the panel with
    /// "Show blocked" on) into the Worktrees mode's selection.
    static func selection(for flag: String) -> String {
        switch flag {
        case "cleanup":
            return selectionID
        case "cleanup-blocked":
            HubDefaults.store.set(true, forKey: showBlockedKey)
            return selectionID
        default:
            return flag
        }
    }
}

struct CleanupBlocker: Decodable, Hashable {
    let kind: String
    let text: String
}

struct CleanupRow: Decodable, Identifiable, Hashable {
    let path: String
    let repoRoot: String
    let repo: String
    let branch: String?
    let head: String
    let verdict: String?
    let how: String?
    let base: String?
    let ignored: [String]
    let removable: Bool
    let blockers: [CleanupBlocker]
    /// Epoch ms.
    let lastActivityAt: Double?

    var id: String { path }
    var name: String { (path as NSString).lastPathComponent }
    var title: String { branch ?? "detached \(head.prefix(9))" }
    var lastActivity: Date? { lastActivityAt.map { Date(timeIntervalSince1970: $0 / 1000) } }

    /// How the branch reached the base, in words.
    var mergedHow: String {
        switch (verdict, how) {
        case ("EMPTY", _): return "no commits of its own"
        case (_, "ancestor"): return "merged"
        case (_, "cherry"): return "merged (rebased)"
        case (_, "content"): return "merged (squash)"
        case ("MERGED", _): return "merged"
        case ("STALE", _): return "stale"
        case ("UNMERGED", _): return "not merged"
        default: return "unknown"
        }
    }
}

struct CleanupReport: Decodable {
    let rows: [CleanupRow]
    let warnings: [String]
    let elapsedMs: Int
}

struct CleanupSize: Decodable {
    let path: String
    let bytes: Double
    let freeableBytes: Double?
    let elapsedMs: Int
    let error: String?
}

struct CleanupOutcome: Decodable {
    let path: String
    let removed: Bool
    let reasons: [String]
    let branch: String?
}

@MainActor
final class WorktreeCleanupStore: ObservableObject {
    static let shared = WorktreeCleanupStore()

    @Published private(set) var rows: [CleanupRow] = []
    @Published private(set) var loading = false
    @Published private(set) var loadedRepos: [String] = []
    @Published private(set) var scanMs: Int?
    @Published private(set) var sizes: [String: CleanupSize] = [:]
    @Published private(set) var sizing = Set<String>()
    @Published private(set) var removing: (done: Int, total: Int)?
    @Published var selected = Set<String>()
    @Published var notice: (text: String, isError: Bool)?

    /// Paths per `size` call: a cold scan of a 3 GB worktree takes about 5 s, so three fit the
    /// runner's deadline with room, and each batch shows up as it lands.
    private static let sizeBatch = 3
    /// Paths per `remove` call: deleting a node_modules tree takes seconds, and each call reports.
    private static let removeBatch = 2
    private var sizeQueue: [String] = []
    private var sizingTask: Task<Void, Never>?
    /// A scan asked for while one ran (the worktree list changed meanwhile): it runs when that one ends.
    private var pendingScan: (repos: [String], force: Bool)?

    var removable: [CleanupRow] { rows.filter(\.removable) }

    func load(repos: [String], force: Bool = false) {
        let repos = repos.sorted()
        guard !repos.isEmpty, force || repos != loadedRepos else { return }
        guard !loading else {
            pendingScan = (repos, force)
            return
        }

        loading = true
        Task {
            let span = HubPerf.begin("worktrees.cleanup.scan", "\(repos.count) repos", awaits: true)
            let result = await Task.detached(priority: .utility) { () -> Result<CleanupReport, Error> in
                Result {
                    try JSONDecoder().decode(CleanupReport.self, from: ToolsCLIRunner.run(["hub", "worktrees", "list"] + repos + ["--json"]))
                }
            }.value
            loading = false
            loadedRepos = repos
            defer {
                if let next = pendingScan {
                    pendingScan = nil
                    load(repos: next.repos, force: next.force)
                }
            }
            switch result {
            case .success(let report):
                span.end("\(report.rows.count) rows, \(report.rows.filter(\.removable).count) removable, \(report.elapsedMs) ms in tools")
                rows = report.rows
                HubMainBusy.measure("worktrees.cleanup.rows")
                scanMs = report.elapsedMs
                selected = selected.intersection(Set(report.rows.filter(\.removable).map(\.path)))
                if let warning = report.warnings.first {
                    notice = (warning, true)
                }
                // Only the removable rows: a cold scan costs about 5 s of every core per 3 GB
                // worktree, so the blocked rows are measured only when "Show blocked" lists them.
                queueSizes(report.rows.filter(\.removable).map(\.path))
            case .failure(let error):
                span.end("failed")
                notice = ("Worktree scan failed: \(error)", true)
            }
        }
    }

    func queueSizes(_ paths: [String]) {
        sizeQueue += paths.filter { sizes[$0] == nil && !sizing.contains($0) && !sizeQueue.contains($0) }
        guard sizingTask == nil else { return }
        sizingTask = Task {
            while !sizeQueue.isEmpty {
                let batch = Array(sizeQueue.prefix(Self.sizeBatch))
                sizeQueue.removeFirst(batch.count)
                sizing.formUnion(batch)
                let span = HubPerf.begin("worktrees.cleanup.size", "\(batch.count) paths", awaits: true)
                let result = await Task.detached(priority: .utility) { () -> Result<[CleanupSize], Error> in
                    Result {
                        try JSONDecoder().decode([CleanupSize].self, from: ToolsCLIRunner.run(["hub", "worktrees", "size"] + batch + ["--json"]))
                    }
                }.value
                sizing.subtract(batch)
                switch result {
                case .success(let found):
                    span.end(found.map { "\($0.elapsedMs)" }.joined(separator: ",") + " ms")
                    for size in found {
                        sizes[size.path] = size
                    }
                case .failure(let error):
                    span.end("failed")
                    notice = ("Size scan failed: \(error)", true)
                }
            }
            sizingTask = nil
        }
    }

    /// Removes in small batches through `tools hub worktrees remove --yes` (the CLI re-checks each
    /// row first and never forces). Returns the removed paths.
    func remove(_ paths: [String]) async -> [String] {
        guard removing == nil, !paths.isEmpty else { return [] }
        removing = (0, paths.count)
        var removed: [String] = []
        var kept: [CleanupOutcome] = []
        var failure: String?
        var index = 0
        while index < paths.count {
            let batch = Array(paths[index..<min(index + Self.removeBatch, paths.count)])
            let span = HubPerf.begin("worktrees.cleanup.remove", "\(batch.count) paths", awaits: true)
            let result = await Task.detached(priority: .userInitiated) { () -> Result<[CleanupOutcome], Error> in
                Result {
                    // Exit 1 means "some were kept"; the JSON on stdout still says which.
                    let capture = try ToolsCLIRunner.capture(["hub", "worktrees", "remove"] + batch + ["--yes", "--json"], timeout: 300)
                    return try JSONDecoder().decode([CleanupOutcome].self, from: capture.stdout)
                }
            }.value
            switch result {
            case .success(let outcomes):
                span.end("\(outcomes.filter(\.removed).count) removed")
                removed += outcomes.filter(\.removed).map(\.path)
                kept += outcomes.filter { !$0.removed }
            case .failure(let error):
                span.end("failed")
                failure = "\(error)"
            }
            index += batch.count
            removing = (index, paths.count)
            if failure != nil { break }
        }
        removing = nil
        let gone = Set(removed)
        rows.removeAll { gone.contains($0.path) }
        selected.subtract(gone)
        if let failure {
            notice = ("Removal stopped: \(failure)", true)
        } else if let first = kept.first {
            let name = (first.path as NSString).lastPathComponent
            notice = ("Removed \(removed.count), kept \(kept.count): \(name): \(first.reasons.first ?? "refused")", true)
        } else {
            notice = ("Removed \(removed.count) worktree\(removed.count == 1 ? "" : "s"); their branches stay", false)
        }
        return removed
    }
}

enum CleanupFormat {
    static func bytes(_ value: Double) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(value), countStyle: .file)
    }
}

struct WorktreeCleanupView: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var store = WorktreeCleanupStore.shared
    @AppStorage(WorktreeCleanup.showBlockedKey) private var showBlocked = false
    @State private var pending: [CleanupRow]?
    @State private var find = PanelFindModel(scope: "worktree.cleanup", title: "the worktrees")

    /// The main checkout of every repository the Worktrees mode lists.
    private var repos: [String] {
        let mains = Dictionary(grouping: model.worktrees, by: \.commonDir).compactMap { $0.value.first { $0.isMain }?.path }
        return Array(Set(mains)).sorted()
    }

    var body: some View {
        let shown = store.rows.filter { showBlocked || $0.removable }
        VStack(spacing: 0) {
            header
            PanelFindBar(find: find)
            if store.rows.isEmpty {
                Text(store.loading ? "Checking every worktree: merge state, changes, stashes, running processes…" : "No linked worktrees.")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                        ForEach(groups(shown), id: \.repo) { group in
                            Section {
                                ForEach(group.rows) { row in
                                    rowView(row)
                                }
                            } header: {
                                sectionHeader(group.repo, rows: group.rows)
                            }
                        }
                        if shown.isEmpty {
                            Text("Nothing is removable. \"Show blocked\" lists every worktree with the reason it stays.")
                                .foregroundColor(ReviewPalette.dim)
                                .padding(18)
                        }
                    }
                    .padding(.bottom, 14)
                }
            }
        }
        .hubSurface(.content)
        .panelFind(find, revision: shown) { groups(shown).flatMap(\.rows).map(Self.searchable) }
        .onAppear { HubMainBusy.measure("worktrees.cleanup.open") }
        .task(id: repos) { store.load(repos: repos) }
        .task(id: "\(showBlocked) \(store.rows.count)") {
            if showBlocked {
                store.queueSizes(store.rows.filter { !$0.removable && !$0.blockers.contains { $0.kind == "missing" } }.map(\.path))
            }
        }
        .confirmationDialog(
            confirmTitle,
            isPresented: Binding(get: { pending != nil }, set: { if !$0 { pending = nil } }),
            titleVisibility: .visible,
            presenting: pending
        ) { rows in
            Button("Remove \(rows.count == 1 ? "it" : "all \(rows.count)")", role: .destructive) {
                let paths = rows.map(\.path)
                pending = nil
                Task { @MainActor in
                    let removed = await store.remove(paths)
                    let gone = Set(removed)
                    model.worktrees.removeAll { gone.contains($0.path) }
                }
            }
            Button("Cancel", role: .cancel) { pending = nil }
        } message: { rows in
            Text(confirmMessage(rows))
        }
    }

    private var confirmTitle: String {
        guard let rows = pending else { return "" }
        return rows.count == 1 ? "Remove the worktree \(rows[0].name)?" : "Remove \(rows.count) worktrees?"
    }

    private func confirmMessage(_ rows: [CleanupRow]) -> String {
        var lines = rows.prefix(12).map { row -> String in
            var line = "• \(row.title)  \(row.path)"
            if let size = store.sizes[row.path] {
                line += "  (\(CleanupFormat.bytes(size.bytes)))"
            }
            if !row.ignored.isEmpty {
                line += "\n   also deletes ignored: \(row.ignored.prefix(6).joined(separator: ", "))\(row.ignored.count > 6 ? ", …" : "")"
            }
            return line
        }
        if rows.count > 12 {
            lines.append("… and \(rows.count - 12) more")
        }
        lines.append("")
        lines.append("Each one is checked again first. Removal is `git worktree remove` without --force; the branches stay.")
        return lines.joined(separator: "\n")
    }

    // MARK: Header

    private var header: some View {
        let removable = store.removable
        let known = removable.compactMap { store.sizes[$0.path] }
        let total = known.reduce(0) { $0 + $1.bytes }
        let frees = known.reduce(0) { $0 + ($1.freeableBytes ?? 0) }
        let chosen = store.rows.filter { store.selected.contains($0.path) }
        return VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Image(systemName: "trash").foregroundColor(ReviewPalette.dim)
                Text("Clean up worktrees").font(.system(size: 15, weight: .semibold))
                Spacer()
                if let notice = store.notice {
                    NoticePill(text: notice.text, isError: notice.isError) { store.notice = nil }
                }
                if let progress = store.removing {
                    ProgressView().controlSize(.small)
                    Text(verbatim: "Removing \(progress.done) of \(progress.total)…").font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                }
                Toggle("Show blocked (\(store.rows.count - removable.count))", isOn: $showBlocked)
                    .toggleStyle(.checkbox)
                    .font(.system(size: 12))
                    .instantTooltip("Also list the worktrees that stay, each with the reason")
                Button {
                    pending = chosen
                } label: {
                    Label("Remove selected (\(chosen.count))", systemImage: "trash")
                }
                .disabled(chosen.isEmpty || store.removing != nil)
                .instantTooltip("Asks first, listing every folder that goes")
                IconButton(systemName: "arrow.clockwise", tooltip: "Check every worktree again") {
                    store.load(repos: repos, force: true)
                }
                .disabled(store.loading)
            }
            .buttonStyle(.genHoverPlain())
            HStack(spacing: 6) {
                if store.loading {
                    ProgressView().controlSize(.small)
                }
                Text(verbatim: summary(removable: removable.count, sized: known.count, total: total, frees: frees))
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                Spacer()
                if !removable.isEmpty {
                    Button(store.selected.count == removable.count ? "Select none" : "Select all removable") {
                        store.selected = store.selected.count == removable.count ? [] : Set(removable.map(\.path))
                    }
                    .buttonStyle(.genHoverPlain())
                    .font(.system(size: 11.5))
                }
            }
            Text("Removable: the branch is in the base (merged, rebased or squashed, or it has no commits), nothing is uncommitted or untracked, no stash names it, nothing runs in it and no agent session wrote in it in the last 30 minutes.")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.leading, 18)
        .padding(.trailing, 14)
        .padding(.top, 34)
        .padding(.bottom, 10)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
    }

    private func summary(removable: Int, sized: Int, total: Double, frees: Double) -> String {
        var text = "\(removable) removable of \(store.rows.count) linked worktrees"
        if sized > 0 {
            text += " · \(CleanupFormat.bytes(total)) on disk, removing frees at least \(CleanupFormat.bytes(frees))"
            if sized < removable {
                text += " (\(sized) of \(removable) measured)"
            }
        }
        if let ms = store.scanMs {
            text += " · checked in \(String(format: "%.1f", Double(ms) / 1000)) s"
        }
        return text
    }

    // MARK: Rows

    private func groups(_ rows: [CleanupRow]) -> [(repo: String, rows: [CleanupRow])] {
        let grouped = Dictionary(grouping: rows, by: \.repoRoot)
        return grouped.keys.sorted().map { key in
            let members = grouped[key] ?? []
            return (members.first?.repo ?? key, members.sorted { ($0.lastActivityAt ?? 0) < ($1.lastActivityAt ?? 0) })
        }
    }

    private func sectionHeader(_ repo: String, rows: [CleanupRow]) -> some View {
        HStack(spacing: 8) {
            Text(repo).font(.system(size: 12, weight: .semibold))
            Text(verbatim: "\(rows.filter(\.removable).count) removable").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
            if let base = rows.first?.base {
                Text(verbatim: "against \(base)").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
            }
            Spacer()
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 6)
        .hubSurface(.content)
    }

    private func rowView(_ row: CleanupRow) -> some View {
        let isSelected = store.selected.contains(row.path)
        return HStack(alignment: .top, spacing: 10) {
            if row.removable {
                // A drawn checkbox, not a Toggle: 30+ AppKit checkboxes made the panel's first layout slow.
                IconButton(systemName: isSelected ? "checkmark.square.fill" : "square", tooltip: "Select for \"Remove selected\"", size: 13) {
                    if isSelected { store.selected.remove(row.path) } else { store.selected.insert(row.path) }
                }
                .foregroundColor(isSelected ? ReviewPalette.renamed : ReviewPalette.dim)
                .frame(width: 16)
            } else {
                Image(systemName: "lock")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.modified)
                    .frame(width: 16)
                    .instantTooltip("Stays: \(row.blockers.map(\.text).joined(separator: "; "))")
            }
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 8) {
                    FindText(row.title, field: "title")
                        .font(.system(size: 12.5, weight: .medium))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    FindText(row.mergedHow, field: "merged")
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundColor(row.removable ? ReviewPalette.added : ReviewPalette.dim)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.06)))
                        .instantTooltip("tools git merged: \(row.verdict ?? "no verdict") by \(row.how ?? "-") against \(row.base ?? "no base")")
                }
                PathLabel(path: row.path, font: .system(size: 10.5, design: .monospaced))
                ForEach(row.blockers, id: \.self) { blocker in
                    FindText(blocker.text, field: "blocker:\(blocker.text)")
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.modified)
                        .lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            sizeCell(row)
            Text(verbatim: HubFormat.ago(row.lastActivity))
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 90, alignment: .trailing)
                .instantTooltip("Last activity: the newest of its HEAD commit, reflog and index")
            if row.removable {
                IconButton(systemName: "trash", tooltip: "Remove this worktree (asks first; the branch stays)") {
                    pending = [row]
                }
                .disabled(store.removing != nil)
            } else {
                Color.clear.frame(width: 18, height: 1)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(RoundedRectangle(cornerRadius: 8).fill(isSelected ? Color.white.opacity(0.07) : Color.clear))
        .findRow(row.path, cornerRadius: 8)
        .padding(.horizontal, 6)
    }

    /// What ⌘F searches in a row: the texts the row shows, under the keys its FindTexts use.
    static func searchable(_ row: CleanupRow) -> PanelFindRow {
        PanelFindRow(id: row.path, fields: [
            PanelFindField("title", row.title),
            PanelFindField("merged", row.mergedHow),
            PanelFindField("path", PathLabel.display(row.path)),
        ] + row.blockers.map { PanelFindField("blocker:\($0.text)", $0.text) })
    }

    @ViewBuilder
    private func sizeCell(_ row: CleanupRow) -> some View {
        VStack(alignment: .trailing, spacing: 2) {
            if let size = store.sizes[row.path] {
                if size.error != nil {
                    Text("size failed").font(.system(size: 11)).foregroundColor(ReviewPalette.removed)
                        .instantTooltip(size.error ?? "")
                } else {
                    Text(verbatim: CleanupFormat.bytes(size.bytes))
                        .font(.system(size: 11.5, design: .monospaced))
                        .instantTooltip("On disk, with APFS clones counted once (tools du)")
                    if let frees = size.freeableBytes {
                        Text(verbatim: "frees ≥ \(CleanupFormat.bytes(frees))")
                            .font(.system(size: 10.5, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                            .instantTooltip("Bytes no clone elsewhere shares: the least that removing it gives back")
                    }
                }
            } else if store.sizing.contains(row.path) {
                ProgressView().controlSize(.mini)
            } else {
                Text("—").foregroundColor(ReviewPalette.dim)
            }
        }
        .frame(width: 110, alignment: .trailing)
    }
}

/// The Worktrees list's first row: opens the cleanup panel, with the removable count once known.
struct WorktreeCleanupEntry: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var store = WorktreeCleanupStore.shared

    var body: some View {
        let selected = model.selectedWorktree == WorktreeCleanup.selectionID
        HStack(spacing: 8) {
            Image(systemName: "trash")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 16)
            Text("Clean up worktrees")
                .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
            Spacer(minLength: 4)
            if !store.rows.isEmpty {
                Text(verbatim: "\(store.removable.count)")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.white.opacity(0.08)))
                    .instantTooltip("\(store.removable.count) worktrees can go without losing anything")
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
        .rowButton { model.selectedWorktree = WorktreeCleanup.selectionID }
        .instantTooltip("Merged, clean worktrees with their size; remove them one by one or together")
    }
}
