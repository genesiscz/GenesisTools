import AppKit
import SwiftUI

// Hub UX wave 2, area "lists" (Worktrees, Inbox, Activity), option A: "one thing at a time, its facts in the row".
// Drawn only with `--sketch lists=a` (GenesisKit `HubLayout`); the hooks are in Hub/HubWindow.swift. Nothing here is
// stored and nothing fetches new data: every value comes from the models the current views read.
//
// - Worktrees (C30, C31): the rows keep their repository groups and get one fact line (PR state from the cached repo
//   facts, the session count, the last session's time, a slot for the changed-file count the list does not read yet).
//   The page shows the worktree's sessions as a real list above the diff: the newest five, then all with a filter.
// - Inbox (C35): the sidebar is a queue of questions, not of sessions, in triage order (needs your answer, blocking
//   first, then newest; staged; waiting to send; quiet sessions folded). The page shows one question at a time with
//   its session line, J and K to move, and the next questions under it.
// - Activity (C38): commits of one project and author that follow each other within 45 minutes fold into one run
//   row ("7 commits"); a push whose head is in a run names the run's branch and leaves the feed. Everything else keeps
//   its own row, so sessions and decisions stand out again.

enum ListsSketchA {}

// MARK: - Worktrees

extension ListsSketchA {
    /// The facts a worktree row shows, from values the hub already holds.
    struct WorktreeFacts: Equatable {
        var sessions: Int
        var lastActive: Date?
        /// "#106" and its state from the cached `tools hub repo --pr` answer; nil while the cache has none.
        var pr: RepoFacts.PullRequest?
        var prKind: String?

        @MainActor
        static func of(_ worktree: HubWorktree, model: HubModel, cache: [String: RepoFacts]) -> WorktreeFacts {
            let sessions = model.sessions(for: worktree)
            let facts = cache[worktree.path]
            return WorktreeFacts(
                sessions: sessions.count,
                lastActive: sessions.compactMap(\.lastActivity).max(),
                pr: facts?.pr,
                prKind: facts?.origin?.kind
            )
        }
    }

    /// The sidebar: repository groups as today, each row with branch, folder (only when it says more) and one fact line.
    struct WorktreeList: View {
        var model: HubModel
        @StateObject private var prefs = GroupPrefs(key: "worktrees.repos")
        /// Read only: a row shows a PR the store already knows, and asks for nothing (no new `tools hub repo` batch).
        @ObservedObject private var repos = RepoFactsStore.shared

        private var groups: [(repo: String, rows: [(worktree: HubWorktree, facts: WorktreeFacts)])] {
            let needle = model.filter.trimmed.lowercased()
            let rows = model.worktrees.filter { needle.isEmpty || "\($0.repo) \($0.branch) \($0.path)".lowercased().contains(needle) }
            let cache = repos.byPath
            let grouped = Dictionary(grouping: rows, by: \.repo)
            return prefs.sorted(Array(grouped.keys)).map { repo in
                let entries = (grouped[repo] ?? []).map { ($0, WorktreeFacts.of($0, model: model, cache: cache)) }
                // The main checkout first, then the worktree touched last: the row a reader comes back to is on top.
                let sorted = entries.sorted { a, b in
                    if a.0.isMain != b.0.isMain { return a.0.isMain }
                    return (a.1.lastActive ?? .distantPast) > (b.1.lastActive ?? .distantPast)
                }
                return (repo, sorted.map { (worktree: $0.0, facts: $0.1) })
            }
        }

        var body: some View {
            let groups = groups
            let picked = model.selectedWorktree
            ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                    if model.loadingWorktrees, model.worktrees.isEmpty {
                        SkeletonRows(count: 8, leading: .dot)
                            .skeletonShimmer()
                            .accessibilityElement(children: .ignore)
                            .accessibilityLabel("Finding worktrees")
                    } else if !model.worktrees.isEmpty {
                        WorktreeCleanupEntry(model: model)
                    }
                    ForEach(groups, id: \.repo) { group in
                        Section {
                            if !prefs.collapsed.contains(group.repo) {
                                ForEach(group.rows, id: \.worktree.path) { entry in
                                    WorktreeRow(
                                        worktree: entry.worktree,
                                        facts: entry.facts,
                                        selected: picked == entry.worktree.path,
                                        select: { model.selectWorktree(entry.worktree) }
                                    )
                                    .equatable()
                                    .id(entry.worktree.path)
                                }
                            }
                        } header: {
                            GroupHeader(
                                title: group.repo,
                                count: group.rows.count,
                                prefs: prefs,
                                allNames: groups.map(\.repo),
                                path: (group.rows.first { $0.worktree.isMain } ?? group.rows.first)?.worktree.path
                            )
                        }
                    }
                }
                .padding(.bottom, 12)
                .genScrollBars()
            }
            // The current list's rule: a selection from a link or a reopen opens its group and comes into view. Without
            // it the page showed a worktree whose row was far below the fold, with nothing in the sidebar marking it.
            .modifier(SidebarReveal(
                proxy: proxy,
                selection: picked,
                group: groups.first { $0.rows.contains { $0.worktree.path == picked } }?.repo,
                loaded: !model.worktrees.isEmpty,
                prefs: prefs
            ))
            }
        }
    }

    /// Branch on the first line; under it the folder when it is not the branch's own last part, then the facts:
    /// "PR #106 · 149 sessions · 2h ago". The slot for the changed-file count (C31) is on the page's header only: a
    /// dashed "± –" on every row was a mark that says nothing, about 30 times per screen.
    struct WorktreeRow: View, Equatable {
        let worktree: HubWorktree
        let facts: WorktreeFacts
        let selected: Bool
        let select: () -> Void

        static func == (a: WorktreeRow, b: WorktreeRow) -> Bool {
            a.worktree == b.worktree && a.facts == b.facts && a.selected == b.selected
        }

        /// The folder says something the branch does not: not `feat/x` in a folder named `x`.
        private var folderSaysMore: Bool {
            let tail = worktree.branch.split(separator: "/").last.map(String.init) ?? worktree.branch
            return !worktree.isMain && worktree.shortName != tail && worktree.name != tail
        }

        var body: some View {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: worktree.isMain ? "house" : "arrow.triangle.branch")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 16)
                    .padding(.top, 2)
                    .instantTooltip(worktree.isMain ? "Main checkout" : "Linked worktree")
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(verbatim: worktree.branch)
                            .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if folderSaysMore {
                            Text(verbatim: worktree.shortName)
                                .font(.system(size: 10.5))
                                .foregroundColor(ReviewPalette.dim)
                                .lineLimit(1)
                                .truncationMode(.middle)
                                .layoutPriority(-1)
                        }
                    }
                    factLine
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
            .rowButton { select() }
            .accessibilityLabel(Text(verbatim: spoken))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .instantTooltip("\(worktree.branch)\n\(PathLabel.display(worktree.path))")
            .liveRow(selected: selected)
            .contextMenu {
                Button("Copy branch") { PathOpener.copy(worktree.branch, what: "branch") }
                Divider()
                PathActionsMenu(path: worktree.path)
            }
        }

        private var factLine: some View {
            HStack(spacing: 5) {
                if let pr = facts.pr {
                    ListsSketchA.PRStateTag(pr: pr, kind: facts.prKind)
                    dot
                }
                Text(verbatim: facts.sessions == 0 ? "no sessions" : Plural.count(facts.sessions, "session"))
                if let last = facts.lastActive {
                    dot
                    LiveAgo(date: last, style: .brief).fixedSize()
                }
            }
            .font(.system(size: 10.5))
            .foregroundColor(ReviewPalette.dim)
            .lineLimit(1)
        }

        private var dot: some View { Text(verbatim: "·") }

        private var spoken: String {
            var parts = [worktree.branch]
            if let pr = facts.pr { parts.append(pr.label(kind: facts.prKind)) }
            parts.append(facts.sessions == 0 ? "no sessions" : Plural.count(facts.sessions, "session"))
            return parts.joined(separator: ", ")
        }
    }

    /// "#106" in the PR state's colour: green open, purple merged, dim closed or draft.
    struct PRStateTag: View {
        let pr: RepoFacts.PullRequest
        let kind: String?

        private var color: Color {
            switch pr.state {
            case "OPEN": return ReviewPalette.added
            case "MERGED": return ReviewPalette.renamed
            default: return ReviewPalette.dim
            }
        }

        var body: some View {
            Text(verbatim: Forge(kind: kind)?.label(pr.number) ?? "#\(pr.number)")
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .foregroundColor(color)
                .instantTooltip(pr.label(kind: kind))
                .accessibilityLabel(Text(verbatim: pr.label(kind: kind)))
        }
    }

    /// The place the changed-file count takes (C31): the worktree list reads no `git status` per worktree yet, so the
    /// sketch draws the slot, not a number.
    struct ChangedSlot: View {
        var body: some View {
            Text(verbatim: "± –")
                .font(.system(size: 10, design: .monospaced))
                .padding(.horizontal, 4)
                .overlay(Capsule().stroke(style: StrokeStyle(lineWidth: 0.8, dash: [2, 2])).foregroundColor(ReviewPalette.dim.opacity(0.6)))
                .instantTooltip("Changed files: the worktree list does not read them yet (needs a git status per worktree)")
                .accessibilityLabel("Changed files not read yet")
        }
    }

    /// The worktree page: the header of today, the sessions as a list, then the diff.
    struct WorktreeDetail: View {
        var model: HubModel
        @ObservedObject private var repos = RepoFactsStore.shared
        let worktree: HubWorktree
        @State private var launchingNew = false

        var body: some View {
            let touching = model.sessions(for: worktree)
            let facts = repos.facts(for: worktree.path, pr: true)
            VStack(spacing: 0) {
                TitlebarHeader {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.triangle.branch").foregroundColor(ReviewPalette.dim)
                        ExternalLink(
                            text: worktree.branch,
                            url: facts?.branchURL,
                            font: .system(size: 15, weight: .semibold),
                            color: Color.white.opacity(0.92)
                        )
                        CompareLink(facts: facts)
                        ExternalLink(text: worktree.repo, url: facts?.webURL)
                        PullRequestLink(facts: facts)
                        Spacer()

                        Button {
                            launchingNew = true
                        } label: {
                            Label("New session here", systemImage: "plus.bubble")
                        }
                        .instantTooltip("Start Claude, Codex or Grok in this worktree; pick the cmux target first")
                        .popover(isPresented: $launchingNew, arrowEdge: .bottom) {
                            LaunchPicker(mode: .new(cwd: worktree.path, name: worktree.branch)) { outcome in
                                launchingNew = false
                                if let notice = outcome.notice { model.notice = notice }
                            }
                        }
                    }
                    .buttonStyle(.genHoverPlain())
                } details: {
                    HStack(spacing: 12) {
                        PathLabel(path: worktree.path)
                        ListsSketchA.ChangedSlot()
                        Spacer(minLength: 0)
                    }
                }
                if !touching.isEmpty {
                    WorktreeSessions(model: model, sessions: touching)
                        .id(worktree.path)
                    Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
                }
                if let review = model.review(showing: worktree) {
                    ReviewRootView(model: review)
                } else {
                    Text("Loading the worktree's changes…")
                        .font(.system(size: 12))
                        .foregroundColor(ReviewPalette.dim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            .onChange(of: [facts?.pr?.target ?? "", model.review.map { "\(ObjectIdentifier($0))" } ?? ""], initial: true) { _, _ in
                model.review(showing: worktree)?.useBranchTarget(facts?.pr?.target)
            }
            .task(id: worktree.path) {
                if model.review?.home.path != worktree.path {
                    model.selectWorktree(worktree)
                }
            }
        }
    }

    /// The worktree's sessions as a list (C30): newest five, then all of them behind "Show all", with a filter.
    struct WorktreeSessions: View {
        var model: HubModel
        let sessions: [HubSession]
        @State private var open = true
        @State private var showsAll = false
        @State private var query = ""
        @State private var resuming: String?
        @GenReduceMotion private var reduceMotion

        static let preview = 5
        static let rowHeight: CGFloat = 28

        private var shown: [HubSession] {
            let sorted = sessions.sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) }
            // The filter field shows only with the whole list, so the folded preview ignores what it holds: a filter
            // typed before "Show the newest 5" hid sessions with no field on screen to say why.
            let words = showsAll ? query.lowercased().split(whereSeparator: \.isWhitespace) : []
            let matching = words.isEmpty ? sorted : sorted.filter { session in
                let text = "\(session.displayTitle) \(session.provider) \(session.gitBranch ?? "") \(session.sessionId)".lowercased()
                return words.allSatisfy { text.contains($0) }
            }
            return showsAll ? matching : Array(matching.prefix(Self.preview))
        }

        var body: some View {
            let shown = shown
            VStack(alignment: .leading, spacing: 0) {
                GenDisclosure(isExpanded: $open, accessibilityTitle: "Sessions in this worktree") {
                    VStack(alignment: .leading, spacing: 0) {
                        if showsAll {
                            filterField
                        }
                        if showsAll {
                            ScrollView {
                                LazyVStack(alignment: .leading, spacing: 0) {
                                    ForEach(shown) { row($0) }
                                }
                                .scrollOverflowContent()
                                .genScrollBars()
                            }
                            .scrollOverflowHints(.vertical)
                            .frame(height: min(CGFloat(max(shown.count, 1)) * Self.rowHeight, 320))
                        } else {
                            ForEach(shown) { row($0) }
                        }
                        if sessions.count > Self.preview {
                            Button {
                                GenMotion.perform(expanding: !showsAll, reduceMotion: reduceMotion) { showsAll.toggle() }
                            } label: {
                                Text(verbatim: showsAll ? "Show the newest \(Self.preview)" : "Show all \(Plural.count(sessions.count, "session"))")
                                    .font(.system(size: 11.5))
                                    .foregroundColor(Color(red: 0.62, green: 0.78, blue: 1))
                            }
                            .buttonStyle(.genHoverPlain())
                            .padding(.leading, 30)
                            .padding(.vertical, 4)
                            .instantTooltip(showsAll ? "Fold the list back to the newest sessions" : "List every session that worked in this worktree, with a filter")
                        }
                    }
                    .padding(.bottom, 6)
                } label: {
                    HStack(spacing: 6) {
                        Text("Sessions").font(.system(size: 12, weight: .semibold))
                        Text(verbatim: "\(sessions.count)")
                            .font(.system(size: 11, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                        Text("newest first")
                            .font(.system(size: 11))
                            .foregroundColor(ReviewPalette.dim)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 4)
            }
        }

        private var filterField: some View {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 11)).foregroundColor(ReviewPalette.dim)
                TextField("Filter by title, agent or branch", text: $query)
                    .textFieldStyle(.plain)
                    .font(.system(size: 12))
                    .accessibilityLabel("Filter the sessions")
                if !query.isEmpty {
                    IconButton(systemName: "xmark.circle.fill", tooltip: "Clear the filter", size: 10) { query = "" }
                }
            }
            .padding(.horizontal, 8)
            .frame(height: 26)
            .background(RoundedRectangle(cornerRadius: 7).stroke(ReviewPalette.hairline))
            .frame(maxWidth: 420)
            .padding(.leading, 30)
            .padding(.vertical, 4)
        }

        private func row(_ session: HubSession) -> some View {
            HStack(spacing: 8) {
                Circle()
                    .fill(session.isLive ? ReviewPalette.added : Color.clear)
                    .frame(width: 6, height: 6)
                    .accessibilityHidden(true)
                ProviderBadge(provider: session.provider, size: 15)
                Text(verbatim: session.displayTitle)
                    .font(.system(size: 12))
                    .foregroundColor(Color.white.opacity(0.88))
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let model = session.model, !model.isEmpty {
                    Text(verbatim: model)
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                        .layoutPriority(-1)
                }
                Spacer(minLength: 8)
                LiveAgo(date: session.lastActivity, style: .brief)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(minWidth: 56, alignment: .trailing)
                LiveButton(tooltip: "Open the session's transcript in the hub") {
                    model.openSession(session)
                } label: {
                    Text("Open").font(.system(size: 11.5))
                }
                LiveButton(tooltip: "Resume the session in cmux; pick the target first") {
                    resuming = session.id
                } label: {
                    Text("Resume").font(.system(size: 11.5))
                }
                .popover(isPresented: Binding(get: { resuming == session.id }, set: { if !$0 { resuming = nil } }), arrowEdge: .bottom) {
                    LaunchPicker(mode: .resume(session)) { outcome in
                        resuming = nil
                        if let notice = outcome.notice { model.notice = notice }
                    }
                }
            }
            .padding(.leading, 22)
            .padding(.trailing, 8)
            .frame(height: Self.rowHeight)
            .contentShape(Rectangle())
            .accessibilityElement(children: .combine)
            .liveRow(selected: resuming == session.id)
        }
    }
}

// MARK: - Inbox

extension ListsSketchA {
    /// Where a question stands in the triage order.
    enum Bucket: Int, CaseIterable {
        case needsAnswer, staged, toSend, quiet

        var title: String {
            switch self {
            case .needsAnswer: return "Needs your answer"
            case .staged: return "Staged, not sent"
            case .toSend: return "Waiting to send"
            case .quiet: return "Quiet for 3+ days"
            }
        }

        var tooltip: String {
            switch self {
            case .needsAnswer: return "Questions an agent asked and nobody answered: the ones that block an agent first, then the newest"
            case .staged: return "Answers you picked and did not send yet"
            case .toSend: return "Answered, not taken by the session yet. Nothing here waits for you."
            case .quiet: return "Open questions in sessions where nothing moved for three days"
            }
        }
    }

    /// One question of the queue with its session.
    struct Entry: Identifiable, Equatable {
        let session: InboxSession
        let item: InboxItem
        let bucket: Bucket
        var id: String { item.id }

        var heading: String {
            if let title = item.title, !title.trimmed.isEmpty { return title }
            if let prompt = item.questions?.first?.prompt, !prompt.trimmed.isEmpty { return prompt }
            if let first = (item.prompt ?? "").split(separator: "\n").first { return String(first) }
            return WidgetWords.decision(item.number)
        }

        var blocking: Bool { item.blocking ?? false }
    }

    /// Every question in triage order: needs your answer (blocking first, then newest), staged, waiting to send, quiet.
    @MainActor
    static func queue(_ inbox: HubInboxModel, filter: String) -> [Entry] {
        queue(inbox.sessions, filter: filter)
    }

    static func queue(_ sessions: [InboxSession], filter: String) -> [Entry] {
        let needle = filter.trimmed.lowercased()
        var entries: [Entry] = []
        for session in sessions {
            for item in session.items {
                let bucket: Bucket
                if !item.isOpen {
                    guard item.status == "answered" else { continue }
                    bucket = .toSend
                } else if session.isStale {
                    bucket = .quiet
                } else if item.status == "drafted" || item.draftOption?.isEmpty == false || item.draft?.trimmed.isEmpty == false {
                    bucket = .staged
                } else {
                    bucket = .needsAnswer
                }
                if !needle.isEmpty, !"\(session.searchText) \(item.searchText)".lowercased().contains(needle) { continue }
                entries.append(Entry(session: session, item: item, bucket: bucket))
            }
        }
        return entries.sorted { a, b in
            if a.bucket != b.bucket { return a.bucket.rawValue < b.bucket.rawValue }
            if a.blocking != b.blocking { return a.blocking }
            return (a.item.date ?? .distantPast) > (b.item.date ?? .distantPast)
        }
    }

    /// The question on the page: the key card when it is in the queue, else the first one that needs an answer.
    static func current(_ entries: [Entry], keyCardID: String?) -> Entry? {
        entries.first { $0.id == keyCardID } ?? entries.first
    }

    @MainActor
    static func pick(_ entry: Entry, inbox: HubInboxModel) {
        inbox.selectedID = entry.session.id
        inbox.keyCardID = entry.item.id
    }

    /// The question rows the sidebar shows, in its order, for Up and Down: a folded Quiet section keeps only the
    /// current question. The keys stepped through session ids before, so they skipped questions and moved a selection
    /// the page does not show.
    static func keyOrder(_ entries: [Entry], showsQuiet: Bool, current: String?) -> [String] {
        Bucket.allCases.flatMap { bucket in
            entries.filter { $0.bucket == bucket && (bucket != .quiet || showsQuiet || $0.id == current) }.map(\.id)
        }
    }

    /// The sidebar: the questions, one row each, under their triage section.
    struct InboxQueue: View {
        var model: HubModel
        @ObservedObject var inbox: HubInboxModel

        var body: some View {
            let entries = ListsSketchA.queue(inbox, filter: model.filter)
            let current = ListsSketchA.current(entries, keyCardID: inbox.keyCardID)
            VStack(spacing: 0) {
                HStack(spacing: 6) {
                    Image(systemName: "line.3.horizontal.decrease")
                        .foregroundColor(ReviewPalette.dim)
                        .accessibilityHidden(true)
                    Text("Needs an answer first, then newest")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                    Spacer()
                    ZStack {
                        if inbox.loading { ProgressView().controlSize(.small) }
                    }
                    .frame(width: 16, height: 16)
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 6)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1, pinnedViews: [.sectionHeaders]) {
                        if entries.isEmpty, inbox.loading {
                            SkeletonRows(count: 8, leading: .dot)
                                .skeletonShimmer()
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("Looking for waiting questions")
                        }
                        ForEach(Bucket.allCases, id: \.self) { bucket in
                            let rows = entries.filter { $0.bucket == bucket }
                            if !rows.isEmpty {
                                section(bucket, rows: rows, current: current?.id)
                            }
                        }
                    }
                    .padding(.bottom, 12)
                    .genScrollBars()
                }
            }
        }

        @ViewBuilder
        private func section(_ bucket: Bucket, rows: [Entry], current: String?) -> some View {
            if bucket == .quiet {
                GenDisclosure(isExpanded: $inbox.showsQuiet, accessibilityTitle: bucket.title) {
                    EmptyView()
                } label: {
                    sectionLabel(bucket, count: rows.count)
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .instantTooltip(bucket.tooltip)
                // Folded, the section still shows the open question, so the reader never loses it.
                ForEach(inbox.showsQuiet ? rows : rows.filter { $0.id == current }) { entry in
                    row(entry, current: current)
                        .transition(.genReveal)
                }
            } else {
                Section {
                    ForEach(rows) { entry in row(entry, current: current) }
                } header: {
                    sectionLabel(bucket, count: rows.count)
                        .padding(.horizontal, 16)
                        .padding(.top, 8)
                        .padding(.bottom, 3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .hubSurface(.chrome)
                        .instantTooltip(bucket.tooltip)
                }
            }
        }

        private func sectionLabel(_ bucket: Bucket, count: Int) -> some View {
            HStack(spacing: 6) {
                Text(verbatim: bucket.title).font(.system(size: 11.5, weight: .semibold))
                Text(verbatim: "\(count)").font(.system(size: 10.5, design: .monospaced))
            }
            .foregroundColor(ReviewPalette.dim)
        }

        private func row(_ entry: Entry, current: String?) -> some View {
            QueueRow(entry: entry, selected: entry.id == current) {
                ListsSketchA.pick(entry, inbox: inbox)
            }
            .equatable()
            // The arrow keys scroll to the question they select (`keyOrder`).
            .id(entry.id)
        }
    }

    /// One question: its heading, then session, project and when it was asked.
    struct QueueRow: View, Equatable {
        let entry: Entry
        let selected: Bool
        let select: () -> Void

        static func == (a: QueueRow, b: QueueRow) -> Bool { a.entry == b.entry && a.selected == b.selected }

        private var mark: (symbol: String, color: Color, words: String) {
            switch entry.bucket {
            case .needsAnswer:
                return entry.blocking
                    ? ("hand.raised.fill", InboxStyle.accent, "An agent waits for this answer")
                    : ("circle.fill", InboxStyle.accent, "Needs your answer")
            case .staged: return ("circle.fill", SessionPalette.blue, "Staged, not sent")
            case .toSend: return ("tray.and.arrow.down", ReviewPalette.modified, "Waiting to send")
            case .quiet: return ("circle", ReviewPalette.dim, "Quiet for three days")
            }
        }

        var body: some View {
            let mark = mark
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: mark.symbol)
                    .font(.system(size: mark.symbol == "circle.fill" ? 6 : 10))
                    .foregroundColor(mark.color)
                    .frame(width: 14, height: 16)
                    .accessibilityLabel(Text(verbatim: mark.words))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 5) {
                        if let number = entry.item.number {
                            Text(verbatim: "\(number)")
                                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                                .foregroundColor(ReviewPalette.dim)
                        }
                        Text(verbatim: entry.heading)
                            .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                            .lineLimit(2)
                    }
                    HStack(spacing: 5) {
                        ProviderBadge(provider: entry.session.provider ?? "?", size: 11)
                        Text(verbatim: entry.session.displayTitle).lineLimit(1).truncationMode(.tail)
                            .layoutPriority(1)
                        Text(verbatim: "·")
                        // Not `fixedSize`: a 60-character project name pushed the row's age off the sidebar.
                        Text(verbatim: entry.session.projectName).lineLimit(1).truncationMode(.middle)
                        Spacer(minLength: 4)
                        LiveAgo(date: entry.item.date, style: .brief).fixedSize()
                    }
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? Color.white.opacity(0.08) : Color.clear)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : Color.clear))
            )
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
            .rowButton { select() }
            .accessibilityLabel(Text(verbatim: "\(entry.heading), \(entry.session.displayTitle), \(mark.words)"))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .liveRow(selected: selected)
        }
    }

    /// The page: one question, its session line above, the next questions below. J and K move through the queue.
    struct InboxFocus: View {
        var model: HubModel
        @ObservedObject var inbox: HubInboxModel
        @FocusState private var keys: Bool

        var body: some View {
            let entries = ListsSketchA.queue(inbox, filter: model.filter)
            let current = ListsSketchA.current(entries, keyCardID: inbox.keyCardID)
            let index = current.flatMap { entry in entries.firstIndex { $0.id == entry.id } }
            VStack(spacing: 0) {
                header(entries, index: index)
                PanelFindBarSlot()
                if let failure = inbox.error {
                    ListVariantLoadFailure(failure) { inbox.load() }
                }
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if let current {
                            sessionLine(current)
                            card(current)
                            if current.session.draftedItems.isEmpty == false {
                                InboxSendBar(model: model, inbox: inbox, session: current.session)
                            }
                            upNext(entries, after: index ?? 0)
                        } else if inbox.loading {
                            PaneSkeleton("Looking for waiting questions")
                        } else {
                            EmptyState(symbol: "tray", text: "No question waits for an answer.")
                                .padding(.top, 40)
                        }
                    }
                    .frame(maxWidth: HubInboxCards.readingWidth, alignment: .leading)
                    .padding(22)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .genScrollBars()
                }

            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(ListVariantInboxKeys(inbox: inbox, entries: entries.map { ListVariantInboxEntry(session: $0.session, item: $0.item) }, selected: current?.item.id, focused: $keys) { entry in
                inbox.selectedID = entry.session.id; inbox.keyCardID = entry.item.id
            })
        }

        private func move(_ entries: [Entry], index: Int?, by step: Int) -> KeyPress.Result {
            guard !entries.isEmpty else { return .ignored }
            let next = min(max((index ?? -1) + step, 0), entries.count - 1)
            ListsSketchA.pick(entries[next], inbox: inbox)
            return .handled
        }

        private func header(_ entries: [Entry], index: Int?) -> some View {
            let open = entries.filter { $0.bucket == .needsAnswer }.count
            let staged = entries.filter { $0.bucket == .staged }.count
            var summary = open == 0 ? "Nothing needs an answer" : "\(open) need an answer"
            if staged > 0 { summary += " · \(staged) staged" }
            return TitlebarHeader {
                HStack(spacing: 10) {
                    Group {
                        Image(systemName: "tray.full").foregroundColor(InboxStyle.accent)
                            .accessibilityHidden(true)
                        Text("Waiting for you").font(.system(size: 14, weight: .semibold))
                        Text(verbatim: summary)
                            .font(.system(size: 12))
                            .foregroundColor(ReviewPalette.dim)
                    }
                    .titlebarLabel()
                    Spacer()
                    if let index {
                        Text(verbatim: "\(index + 1) of \(entries.count)")
                            .font(.system(size: 11.5, design: .monospaced))
                            .foregroundColor(ReviewPalette.dim)
                            .titlebarLabel()
                    }
                    IconButton(systemName: "chevron.up", tooltip: "Previous question (K)") {
                        _ = move(entries, index: index, by: -1)
                    }
                    IconButton(systemName: "chevron.down", tooltip: "Next question (J)") {
                        _ = move(entries, index: index, by: 1)
                    }
                    IconButton(systemName: "arrow.clockwise", tooltip: "Look for waiting sessions again") { inbox.load() }
                }
            }
        }

        private func sessionLine(_ entry: Entry) -> some View {
            let hubSession = entry.session.sessionId.flatMap(model.session(id:))
            return HStack(spacing: 8) {
                ProviderBadge(provider: entry.session.provider ?? "?", size: 16)
                Text(verbatim: entry.session.displayTitle)
                    .font(.system(size: 13, weight: .semibold))
                    .lineLimit(1)
                Text(verbatim: entry.session.projectName)
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                if let branch = entry.session.branch {
                    Text(verbatim: branch)
                        .font(.system(size: 11, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                LiveAgo(date: entry.item.date, style: .brief) { "asked \($0)" }
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
                if let hubSession {
                    Button("Open in transcript") { model.openSession(hubSession) }
                        .buttonStyle(.genHoverPlain())
                        .font(.system(size: 11.5))
                        .instantTooltip("Open the session that asked, at its transcript")
                }
            }
        }

        @ViewBuilder
        private func card(_ entry: Entry) -> some View {
            if entry.item.isForm {
                InboxFormCard(inbox: inbox, item: entry.item).id(entry.item.id)
            } else {
                InboxDecisionCard(model: model, inbox: inbox, session: entry.session, item: entry.item, keyed: keys)
                    .id(entry.item.id)
                    .liveRow(selected: true)
            }
        }

        private func upNext(_ entries: [Entry], after index: Int) -> some View {
            let next = Array(entries.dropFirst(index + 1).prefix(4))
            return VStack(alignment: .leading, spacing: 2) {
                if !next.isEmpty {
                    Text("Up next")
                        .font(.system(size: 11.5, weight: .semibold))
                        .foregroundColor(ReviewPalette.dim)
                        .padding(.top, 10)
                        .padding(.leading, 4)
                    ForEach(next) { entry in
                        QueueRow(entry: entry, selected: false) { ListsSketchA.pick(entry, inbox: inbox) }
                            .equatable()
                    }
                }
            }
        }
    }
}

// MARK: - Activity

extension ListsSketchA {
    /// Commits of one project and author that follow each other, with the push that sent them when the feed has it.
    struct Run: Identifiable, Equatable {
        var commits: [TimelineEvent]
        /// Every push whose head commit is in the run, newest first. One author's commits on several branches fall
        /// into one run, so a run with one branch name for all of them said "79 commits pushed to feat/x" for a push
        /// of three.
        var pushes: [TimelineEvent] = []
        /// "feat/x" for one push, "3 branches" for more; the branches themselves are in `branches`.
        var branches: [String] {
            var seen = Set<String>()
            return pushes.compactMap(\.branch).filter { seen.insert($0).inserted }
        }
        var id: String { "run:" + (commits.first?.id ?? "") }
        var newest: Date? { commits.first?.date }
        var oldest: Date? { commits.last?.date }
    }

    /// A row of the feed: an event, or a run of two or more commits.
    enum FeedItem: Identifiable {
        case event(TimelineEvent)
        case run(Run)

        var id: String {
            switch self {
            case .event(let event): return event.rowID
            case .run(let run): return run.id
            }
        }

        var date: Date? {
            switch self {
            case .event(let event): return event.date
            case .run(let run): return run.newest
            }
        }
    }

    /// Two commits of one project and author belong to one run when at most this much time lies between them.
    static let runGap: TimeInterval = 45 * 60

    /// The feed with commit runs folded: newest first, runs placed at their newest commit.
    static func fold(_ events: [TimelineEvent]) -> [FeedItem] {
        var runs: [Run] = []
        var open: [String: Int] = [:]
        var others: [TimelineEvent] = []
        let newestFirst = events.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
        for event in newestFirst {
            guard event.timelineKind == .commit, let date = event.date else {
                others.append(event)
                continue
            }
            let key = "\(event.project ?? "")\u{0}\(event.author ?? "")"
            if let index = open[key], let last = runs[index].oldest, last.timeIntervalSince(date) <= runGap {
                runs[index].commits.append(event)
            } else {
                open[key] = runs.count
                runs.append(Run(commits: [event]))
            }
        }
        // A push whose head is one of a run's commits joins that run and leaves the feed. One lookup table for all
        // pushes: a scan of every run's commits per push was pushes x runs x commits on each redraw of the feed.
        var runOfSha: [String: Int] = [:]
        for (index, run) in runs.enumerated() {
            for commit in run.commits {
                if let sha = commit.sha { runOfSha[sha] = index }
            }
        }
        var kept: [TimelineEvent] = []
        for event in others {
            if event.timelineKind == .push, let head = event.sha, let index = runOfSha[head] {
                runs[index].pushes.append(event)
            } else {
                kept.append(event)
            }
        }
        let items = kept.map(FeedItem.event) + runs.map { run in run.commits.count == 1 && run.pushes.isEmpty ? .event(run.commits[0]) : .run(run) }
        return items.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
    }

    struct FeedHour: Identifiable {
        let hour: Date
        let items: [FeedItem]
        var id: String { "hour:\(hour.timeIntervalSince1970)" }
    }

    struct FeedDay: Identifiable {
        let day: Date
        let hours: [FeedHour]
        var id: String { "day:\(day.timeIntervalSince1970)" }
        var count: Int { hours.reduce(0) { $0 + $1.items.count } }
    }

    static func days(_ items: [FeedItem], calendar: Calendar = .current) -> [FeedDay] {
        let byDay = Dictionary(grouping: items) { $0.date.map { calendar.startOfDay(for: $0) } ?? .distantPast }
        return byDay.keys.sorted(by: >).map { day in
            let byHour = Dictionary(grouping: byDay[day] ?? []) { $0.date.map { TimelineHour.start(of: $0, calendar: calendar) } ?? .distantPast }
            return FeedDay(day: day, hours: byHour.keys.sorted(by: >).map { hour in
                FeedHour(hour: hour, items: (byHour[hour] ?? []).sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) })
            })
        }
    }

    /// The Activity feed with commit runs. The filter rail is today's.
    struct ActivityRuns: View {
        var model: HubModel
        @ObservedObject var timeline: HubTimelineModel
        @ObservedObject private var repos = RepoFactsStore.shared
        @State private var openRuns: Set<String> = []
        @State private var find = PanelFindModel(scope: "timeline", title: "Activity")
        @State private var searching = false
        @GenReduceMotion private var reduceMotion
        @AppStorage(HubActivityRows.allActionsKey, store: HubDefaults.store) private var allActions = false
        @AppStorage(HubActivityRows.commitPrefixKey, store: HubDefaults.store) private var commitPrefix = false

        var body: some View {
            let events = timeline.shown(filter: model.filter)
            let items = ListsSketchA.fold(events)
            let nestedIDs = Set(items.flatMap { item -> [String] in
                if case .run(let run) = item { return (run.commits + run.pushes).map(\.rowID) }
                return []
            })
            let runs = items.filter { if case .run = $0 { return true } else { return false } }.count
            VStack(spacing: 0) {
                header(events: events.count, rows: items.count, runs: runs)
                PanelFindBar(find: find)
                if let failure = timeline.error {
                    ListVariantLoadFailure(failure) { timeline.load(fresh: true) }
                }
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        if events.isEmpty, timeline.loading {
                            SkeletonRows(count: 12, leading: .dot)
                                .skeletonShimmer()
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("Reading the activity")
                                .padding(.top, 8)
                        } else if events.isEmpty {
                            EmptyState(symbol: "clock.arrow.circlepath", text: "Nothing matches these filters.")
                                .padding(.top, 24)
                        }
                        ForEach(ListsSketchA.days(items)) { day in
                            Section {
                                ForEach(day.hours) { hour in
                                    hourHeader(hour)
                                    ForEach(hour.items) { item in
                                        feedRow(item)
                                            .padding(.horizontal, 10)
                                    }
                                }
                            } header: {
                                dayHeader(day)
                            }
                        }
                    }
                    .padding(.bottom, 16)
                    .genScrollBars()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .safeAreaInset(edge: .bottom) { ListVariantActivityFooter(timeline: timeline) }
            .onReceive(find.$isOpen) { searching = $0 }
            .panelFind(find, revision: findRevision(events)) {
                events.map { TimelineRowView.searchable($0, detail: timeline.isExpanded($0) ? timeline.details[$0.id] : nil, compact: nestedIDs.contains($0.rowID), commitPrefix: commitPrefix) }
            }
        }

        private func findRevision(_ events: [TimelineEvent]) -> String {
            let open = events.filter(timeline.isExpanded).map { "\($0.id)\(timeline.details[$0.id] == nil ? "" : "+")" }
            return events.map(\.rowID).joined(separator: "|") + ";" + open.joined(separator: "|") + "\(commitPrefix)"
        }

        @ViewBuilder
        private func feedRow(_ item: FeedItem) -> some View {
            switch item {
            case .event(let event):
                eventRow(event, nested: false)
            case .run(let run):
                let open = searching || openRuns.contains(run.id)
                RunRow(run: run, open: open, commitPrefix: commitPrefix) {
                    GenMotion.perform(expanding: !open, reduceMotion: reduceMotion) {
                        if open { openRuns.remove(run.id) } else { openRuns.insert(run.id) }
                    }
                }
                .equatable()
                if open {
                    ForEach(run.commits, id: \.rowID) { commit in
                        eventRow(commit, nested: true)
                    }
                    .transition(.genReveal)
                    if searching {
                        ForEach(run.pushes, id: \.rowID) { push in
                            eventRow(push, nested: true)
                        }
                    }
                }
            }
        }

        private func eventRow(_ event: TimelineEvent, nested: Bool) -> some View {
            TimelineRowView(
                model: model,
                timeline: timeline,
                event: event,
                compact: nested,
                expanded: timeline.isExpanded(event),
                projectPicked: event.project != nil && timeline.project == event.project,
                forge: event.repo.flatMap { repos.facts(for: $0)?.forge },
                allActions: allActions,
                commitPrefix: commitPrefix
            )
            .equatable()
            .swrFlash(timeline.changed.contains(event.id), cornerRadius: 6)
            .findRow(event.rowID)
            .padding(.leading, nested ? 34 : 0)
        }

        private func header(events: Int, rows: Int, runs: Int) -> some View {
            TitlebarHeader {
                HStack(spacing: 10) {
                    Group {
                        Image(systemName: "clock.arrow.circlepath").foregroundColor(ReviewPalette.renamed)
                        Text(timeline.range.title).font(.system(size: 14, weight: .semibold))
                        Text(verbatim: "\(timeline.pageCount(events)) events in \(Plural.count(rows, "row")) · \(Plural.count(runs, "commit run")) folded")
                            .font(.system(size: 12))
                            .foregroundColor(ReviewPalette.dim)
                            .lineLimit(1)
                    }
                    .titlebarLabel()
                    Spacer()
                    if let loadedAt = timeline.loadedAt {
                        LiveAgo(date: loadedAt) { "read \($0)" }
                            .font(.system(size: 11))
                            .foregroundColor(ReviewPalette.dim)
                            .titlebarLabel()
                    }
                    IconButton(systemName: "arrow.clockwise", tooltip: "Read the activity again (skips the page cache)") {
                        timeline.load(fresh: true)
                    }
                }
            }
        }

        private func dayHeader(_ day: FeedDay) -> some View {
            HStack {
                Text(verbatim: TimelineDay(day: day.day, hours: []).title())
                    .font(.system(size: 12, weight: .semibold))
                Spacer()
                Text(verbatim: Plural.count(day.count, "row"))
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 5)
            .hubSurface(.bar)
        }

        private func hourHeader(_ hour: FeedHour) -> some View {
            HStack {
                Text(verbatim: TimelineMain.hourFormat.string(from: hour.hour))
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            }
            .foregroundColor(ReviewPalette.dim)
            .padding(.horizontal, 20)
            .padding(.top, 8)
            .padding(.bottom, 3)
        }
    }

    /// "▸ 00:07–00:24 ● GenesisTools 7 commits on feat/x · newest subject … Martin 6m ago".
    struct RunRow: View, Equatable {
        let run: Run
        let open: Bool
        let commitPrefix: Bool
        let toggle: () -> Void

        static func == (a: RunRow, b: RunRow) -> Bool { a.run == b.run && a.open == b.open && a.commitPrefix == b.commitPrefix }

        private static let time: DateFormatter = {
            let formatter = DateFormatter()
            formatter.dateFormat = "HH:mm"
            return formatter
        }()

        /// "pushed to feat/x", or "pushed to 3 branches: feat/x, feat/y, …" when the run holds several pushes.
        static func pushed(_ branches: [String]) -> String? {
            guard let first = branches.first else { return nil }
            if branches.count == 1 { return "pushed to \(first)" }
            return "pushed to \(branches.count) branches: " + branches.joined(separator: ", ")
        }

        private var span: String {
            let newest = run.newest.map(Self.time.string(from:)) ?? ""
            let oldest = run.oldest.map(Self.time.string(from:)) ?? ""
            return newest == oldest ? newest : "\(oldest)–\(newest)"
        }

        var body: some View {
            let newest = run.commits.first
            HStack(spacing: 8) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 22)
                Text(verbatim: span)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(minWidth: 36, alignment: .leading)
                    .fixedSize()
                Image(systemName: run.pushes.isEmpty ? TimelineKind.commit.symbol : TimelineKind.push.symbol)
                    .font(.system(size: 11.5))
                    .foregroundColor(run.pushes.isEmpty ? TimelineKind.commit.color : TimelineKind.push.color)
                    .frame(width: 16)
                if let project = newest?.project {
                    Text(verbatim: project)
                        .font(.system(size: 10.5, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.7))
                        .padding(.horizontal, 6)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(0.07)))
                        .lineLimit(1)
                        .fixedSize()
                }
                Text(verbatim: Plural.count(run.commits.count, "commit"))
                    .font(.system(size: 12.5, weight: .semibold))
                    .fixedSize()
                if let pushed = Self.pushed(run.branches) {
                    Text(verbatim: pushed)
                        .font(.system(size: 11.5, design: .monospaced))
                        .foregroundColor(TimelineKind.push.color)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                }
                if let newest {
                    Text(verbatim: newest.shownTitle(keepsPrefix: commitPrefix))
                        .font(.system(size: 12))
                        .foregroundColor(Color.white.opacity(0.55))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 6)
                if let author = newest?.author {
                    Text(verbatim: author)
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                        .fixedSize()
                }
                LiveAgo(date: run.newest, style: .brief)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
                    .frame(minWidth: 52, alignment: .trailing)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 26)
            .contentShape(Rectangle())
            .rowButton { toggle() }
            .accessibilityLabel(Text(verbatim: "\(Plural.count(run.commits.count, "commit")) in \(newest?.project ?? "a project")" + (Self.pushed(run.branches).map { ", " + $0 } ?? "")))
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            .instantTooltip(open ? "Fold the commits" : "Show the \(run.commits.count) commits")
            .liveRow()
        }
    }
}
