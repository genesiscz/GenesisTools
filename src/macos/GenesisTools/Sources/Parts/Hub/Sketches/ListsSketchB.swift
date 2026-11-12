import AppKit
import SwiftUI

// Hub UX wave 2, area "lists" (Worktrees, Inbox, Activity), option B: "the sidebar sorts, the page summarizes".
// Drawn only with `--sketch lists=b` (GenesisKit `HubLayout`); the hooks are in Hub/HubWindow.swift. Nothing here is
// stored and nothing fetches new data: every value comes from the models the current views read.
//
// - Worktrees (C30, C31): the sidebar groups worktrees by when a session last worked in them (last hour, today, this
//   week, older), the repository becomes a tag on the row, and the selected worktree unfolds its newest sessions in
//   place, with "All 149 sessions" for the rest. The page header loses its sessions button; the diff keeps the width.
// - Inbox (C35): the sidebar is a triage source list, the Activity rail's kind of filter column: Needs your answer,
//   Staged, Waiting to send, Quiet, Everything, then projects. The page is a dense table of questions, one line each,
//   grouped by triage section; the picked line opens into the full decision card in place.
// - Activity (C38): the feed is grouped by project, newest project first. A project's heading counts what happened;
//   what needs you comes first, then the other events, and its commits fold into one line per push or author.

enum ListsSketchB {}

// MARK: - Worktrees

extension ListsSketchB {
    /// The recency groups of the sidebar.
    enum Recency: Int, CaseIterable {
        case lastHour, today, week, older, never

        var title: String {
            switch self {
            case .lastHour: return "Last hour"
            case .today: return "Today"
            case .week: return "This week"
            case .older: return "Older"
            case .never: return "No sessions"
            }
        }

        static func of(_ date: Date?, now: Date = Date(), calendar: Calendar = .current) -> Recency {
            guard let date else { return .never }
            if now.timeIntervalSince(date) < 3600 { return .lastHour }
            if calendar.isDate(date, inSameDayAs: now) { return .today }
            if now.timeIntervalSince(date) < 7 * 86400 { return .week }
            return .older
        }
    }

    /// What a row shows, as values: a count and a date, not the session list. A row compared its whole session list
    /// on every update of the sidebar (an array of ids per row and per compare) and the list sorted every worktree's
    /// sessions on every redraw; only the selected worktree shows sessions, so only it reads them.
    struct WorktreeEntry: Equatable {
        let worktree: HubWorktree
        let sessionCount: Int
        let lastActive: Date?
        let pr: RepoFacts.PullRequest?
        let prKind: String?
    }

    /// The sidebar: worktrees by recency, each with its repository as a tag; the selected one shows its sessions.
    struct WorktreeList: View {
        var model: HubModel
        @ObservedObject private var repos = RepoFactsStore.shared
        /// "No sessions" starts folded: it was 55 rows of "(detached)" under the worktrees that have work in them.
        @State private var showsNever = false
        @GenReduceMotion private var reduceMotion

        private var groups: [(recency: Recency, rows: [WorktreeEntry])] {
            let needle = model.filter.trimmed.lowercased()
            let cache = repos.byPath
            let entries = model.worktrees
                .filter { needle.isEmpty || "\($0.repo) \($0.branch) \($0.path)".lowercased().contains(needle) }
                .map { worktree -> WorktreeEntry in
                    let sessions = model.sessions(for: worktree)
                    let facts = cache[worktree.path]
                    return WorktreeEntry(worktree: worktree, sessionCount: sessions.count,
                                         lastActive: sessions.compactMap(\.lastActivity).max(),
                                         pr: facts?.pr, prKind: facts?.origin?.kind)
                }
            let grouped = Dictionary(grouping: entries) { Recency.of($0.lastActive) }
            return Recency.allCases.compactMap { recency in
                guard let rows = grouped[recency], !rows.isEmpty else { return nil }
                return (recency, rows.sorted { ($0.lastActive ?? .distantPast) > ($1.lastActive ?? .distantPast) })
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
                    ForEach(groups, id: \.recency) { group in
                        // A folded "No sessions" still shows the selected worktree, so the selection never hides.
                        let folded = group.recency == .never && !showsNever && model.filter.trimmed.isEmpty
                        Section {
                            ForEach(folded ? group.rows.filter { $0.worktree.path == picked } : group.rows, id: \.worktree.path) { entry in
                                let selected = picked == entry.worktree.path
                                WorktreeRow(entry: entry, selected: selected) { model.selectWorktree(entry.worktree) }
                                    .equatable()
                                    .id(entry.worktree.path)
                                if selected, entry.sessionCount > 0 {
                                    NestedSessions(model: model, sessions: model.sessions(for: entry.worktree)
                                        .sorted { ($0.lastActivity ?? .distantPast) > ($1.lastActivity ?? .distantPast) })
                                        .id("sessions:" + entry.worktree.path)
                                }
                            }
                        } header: {
                            HStack(spacing: 6) {
                                if group.recency == .never {
                                    Image(systemName: showsNever ? "chevron.down" : "chevron.right")
                                        .font(.system(size: 9, weight: .semibold))
                                        .accessibilityHidden(true)
                                }
                                Text(verbatim: group.recency.title).font(.system(size: 11.5, weight: .semibold))
                                Text(verbatim: "\(group.rows.count)").font(.system(size: 10.5, design: .monospaced))
                                Spacer()
                            }
                            .foregroundColor(ReviewPalette.dim)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 5)
                            .contentShape(Rectangle())
                            .hubSurface(.groupHeader)
                            .modifier(NeverFold(active: group.recency == .never, open: showsNever) {
                                GenMotion.perform(expanding: !showsNever, reduceMotion: reduceMotion) { showsNever.toggle() }
                            })
                        }
                    }
                }
                .padding(.bottom, 12)
                .genScrollBars()
            }
            // The selection can come from a link or a reopen: bring its row into view once the list holds it. At once,
            // not animated: an animated scrollTo in a lazy stack with pinned headers places its rows on every frame.
            .onChange(of: [picked ?? "", model.worktrees.isEmpty ? "" : "loaded"], initial: true) { _, _ in
                guard let picked, !model.worktrees.isEmpty else { return }
                DispatchQueue.main.async {
                    var instant = Transaction()
                    instant.disablesAnimations = true
                    withTransaction(instant) { proxy.scrollTo(picked, anchor: nil) }
                }
            }
            }
        }
    }

    /// The "No sessions" header as a fold button; every other header stays plain.
    private struct NeverFold: ViewModifier {
        let active: Bool
        let open: Bool
        let toggle: () -> Void

        func body(content: Content) -> some View {
            if active {
                content
                    .rowButton(cornerRadius: 0) { toggle() }
                    .instantTooltip(open ? "Fold the worktrees no session worked in" : "Show the worktrees no session worked in")
                    .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            } else {
                content
            }
        }
    }

    /// "feat/x" over "GenesisTools · #106 · 44 sessions", the last session's age at the trailing edge. The slot for the
    /// changed-file count (C31) is on the page's header only: a dashed "± –" on every row was a mark that says nothing,
    /// about 60 times per screen.
    struct WorktreeRow: View, Equatable {
        let entry: WorktreeEntry
        let selected: Bool
        let select: () -> Void

        static func == (a: WorktreeRow, b: WorktreeRow) -> Bool { a.entry == b.entry && a.selected == b.selected }

        private var worktree: HubWorktree { entry.worktree }

        private static func prColor(_ state: String) -> Color {
            switch state {
            case "OPEN": return ReviewPalette.added
            case "MERGED": return ReviewPalette.renamed
            default: return ReviewPalette.dim
            }
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
                    Text(verbatim: worktree.branch)
                        .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                        .lineLimit(1)
                        .truncationMode(.middle)
                    HStack(spacing: 5) {
                        Text(verbatim: worktree.repo)
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.7))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.07)))
                            .lineLimit(1)
                            .fixedSize()
                        if let pr = entry.pr {
                            Text(verbatim: (entry.prKind == "gitlab" ? "!" : "#") + "\(pr.number)")
                                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                                .foregroundColor(Self.prColor(pr.state))
                                .instantTooltip(pr.label(kind: entry.prKind))
                        }
                        if entry.sessionCount > 0 {
                            Text(verbatim: "\(entry.sessionCount)")
                                .font(.system(size: 10, design: .monospaced))
                                .foregroundColor(ReviewPalette.dim)
                            Image(systemName: "bubble.left.and.bubble.right")
                                .font(.system(size: 9))
                                .foregroundColor(ReviewPalette.dim)
                                .accessibilityHidden(true)
                        }
                    }
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                }
                Spacer(minLength: 4)
                if let last = entry.lastActive {
                    LiveAgo(date: last, style: .brief)
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.dim)
                        .fixedSize()
                        .padding(.top, 1)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : Color.clear))
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
            .rowButton { select() }
            .accessibilityLabel(Text(verbatim: "\(worktree.branch), \(worktree.repo), \(Plural.count(entry.sessionCount, "session"))"))
            .accessibilityAddTraits(selected ? .isSelected : [])
            .instantTooltip("\(worktree.branch)\n\(PathLabel.display(worktree.path))")
            .liveRow(selected: selected)
            .contextMenu {
                Button("Copy branch") { PathOpener.copy(worktree.branch, what: "branch") }
                Divider()
                PathActionsMenu(path: worktree.path)
            }
        }
    }

    /// The place the changed-file count takes (C31); the list reads no `git status` per worktree yet.
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

    /// The selected worktree's newest sessions under its row, then "All N sessions" with the searchable popover.
    struct NestedSessions: View {
        var model: HubModel
        let sessions: [HubSession]
        @State private var showsAll = false
        @State private var query = ""

        static let shown = 4

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(sessions.prefix(Self.shown)) { session in
                    NestedSessionRow(session: session) { model.openSession(session) }
                        .equatable()
                }
                if sessions.count > Self.shown {
                    // lint-rules-ignore: short list (at most Self.shown = 4 nested sessions and one "All" button)
                    Button {
                        showsAll = true
                    } label: {
                        Text(verbatim: "All \(Plural.count(sessions.count, "session"))…")
                            .font(.system(size: 11.5))
                            .foregroundColor(Color(red: 0.62, green: 0.78, blue: 1))
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.genHoverPlain())
                    .padding(.leading, 46)
                    .frame(height: 24)
                    .instantTooltip("Search every session that worked in this worktree, open one or resume it")
                    .popover(isPresented: $showsAll, arrowEdge: .trailing) {
                        WorktreeSessionsList(model: model, sessions: sessions, query: $query) { showsAll = false }
                    }
                }
            }
            .padding(.bottom, 4)
        }
    }

    struct NestedSessionRow: View, Equatable {
        let session: HubSession
        let open: () -> Void

        static func == (a: NestedSessionRow, b: NestedSessionRow) -> Bool {
            a.session.id == b.session.id && a.session.mtime == b.session.mtime && a.session.title == b.session.title
        }

        var body: some View {
            HStack(spacing: 6) {
                ProviderBadge(provider: session.provider, size: 12)
                Text(verbatim: session.displayTitle)
                    .font(.system(size: 11.5))
                    .foregroundColor(Color.white.opacity(0.8))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 4)
                LiveAgo(date: session.lastActivity, style: .brief)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
            }
            .padding(.leading, 40)
            .padding(.trailing, 16)
            .frame(height: 24)
            .contentShape(Rectangle())
            .rowButton { open() }
            .accessibilityLabel(Text(verbatim: "Open \(session.displayTitle)"))
            .instantTooltip("Open the session's transcript")
            .liveRow()
        }
    }

    /// The worktree page: the header with the facts of the checkout, then the diff at full height. The sessions live
    /// in the sidebar now.
    struct WorktreeDetail: View {
        var model: HubModel
        @ObservedObject private var repos = RepoFactsStore.shared
        let worktree: HubWorktree
        @State private var launchingNew = false

        var body: some View {
            let facts = repos.facts(for: worktree.path, pr: true)
            let sessions = model.sessions(for: worktree)
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
                        if let notice = model.notice {
                            NoticePill(text: notice, isError: notice.hasPrefix("cmux:")) { model.notice = nil }
                        }
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
                        ListsSketchB.ChangedSlot()
                        if let last = sessions.compactMap(\.lastActivity).max() {
                            LiveAgo(date: last) { "last session \($0)" }
                                .font(.system(size: 11.5))
                                .foregroundColor(ReviewPalette.dim)
                        }
                        Spacer(minLength: 0)
                    }
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
}

// MARK: - Inbox

extension ListsSketchB {
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

        var symbol: String {
            switch self {
            case .needsAnswer: return "hand.raised"
            case .staged: return "tray.and.arrow.up"
            case .toSend: return "tray.and.arrow.down"
            case .quiet: return "moon.zzz"
            }
        }

        var color: Color {
            switch self {
            case .needsAnswer: return InboxStyle.accent
            case .staged: return SessionPalette.blue
            case .toSend: return ReviewPalette.modified
            case .quiet: return ReviewPalette.dim
            }
        }

        var tooltip: String {
            switch self {
            case .needsAnswer: return "Questions nobody answered yet: the ones an agent waits on first, then the newest"
            case .staged: return "Answers you picked and did not send yet"
            case .toSend: return "Answered, not taken by the session yet. Nothing here waits for you."
            case .quiet: return "Open questions in sessions where nothing moved for three days"
            }
        }
    }

    struct Entry: Identifiable, Equatable {
        let session: InboxSession
        let item: InboxItem
        let bucket: Bucket
        var id: String { item.id }
        var blocking: Bool { item.blocking ?? false }

        var heading: String {
            if let title = item.title, !title.trimmed.isEmpty { return title }
            if let first = (item.prompt ?? "").split(separator: "\n").first { return String(first) }
            return WidgetWords.decision(item.number)
        }
    }

    /// What the sidebar picked: a triage section (nil is Everything) and a project. Kept for the run only.
    @MainActor
    final class InboxPick: ObservableObject {
        static let shared = InboxPick()
        @Published var bucket: Bucket? = .needsAnswer
        @Published var project: String?
        /// The open line of the table; nil opens the first one.
        @Published var open: String?
    }

    @MainActor
    static func entries(_ inbox: HubInboxModel, filter: String) -> [Entry] {
        let needle = filter.trimmed.lowercased()
        var entries: [Entry] = []
        for session in inbox.sessions {
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

    /// The sidebar: triage sections and projects, each with its count, in the Activity rail's rows.
    struct InboxTriage: View {
        var model: HubModel
        @ObservedObject var inbox: HubInboxModel
        @ObservedObject private var pick = InboxPick.shared

        private static func projects(_ all: [Entry]) -> [(name: String, count: Int)] {
            let open = all.filter { $0.bucket == .needsAnswer }
            let grouped: [String: [Entry]] = Dictionary(grouping: open, by: { $0.session.projectName })
            let rows: [(name: String, count: Int)] = grouped.map { (name: $0.key, count: $0.value.count) }
            return rows.sorted { a, b in a.count == b.count ? a.name < b.name : a.count > b.count }
        }

        var body: some View {
            let all = ListsSketchB.entries(inbox, filter: model.filter)
            let inProject: [Entry] = pick.project.map { project in all.filter { $0.session.projectName == project } } ?? all
            let projects = Self.projects(all)
            let needing = all.filter { $0.bucket == .needsAnswer }.count
            ScrollView {
                VStack(alignment: .leading, spacing: 2) {
                    title("Triage")
                    ForEach(Bucket.allCases, id: \.self) { bucket in
                        bucketRow(bucket, count: inProject.filter { $0.bucket == bucket }.count)
                    }
                    everythingRow(count: inProject.count)
                    title("Projects")
                    projectRow(nil, count: needing)
                    ForEach(projects, id: \.name) { project in
                        projectRow(project.name, count: project.count)
                    }
                }
                .padding(.bottom, 12)
                .genScrollBars()
            }
        }

        private func bucketRow(_ bucket: Bucket, count: Int) -> some View {
            TimelineFilterRow(
                look: .project,
                title: bucket.title,
                symbol: bucket.symbol,
                symbolColor: bucket.color,
                count: "\(count)",
                selected: pick.bucket == bucket,
                tooltip: bucket.tooltip,
                select: { pick.bucket = bucket; pick.open = nil }
            )
            .equatable()
        }

        private func everythingRow(count: Int) -> some View {
            TimelineFilterRow(
                look: .project,
                title: "Everything",
                symbol: "tray.full",
                symbolColor: ReviewPalette.dim,
                count: "\(count)",
                selected: pick.bucket == nil,
                tooltip: "Every question in triage order",
                select: { pick.bucket = nil; pick.open = nil }
            )
            .equatable()
        }

        private func projectRow(_ name: String?, count: Int) -> some View {
            TimelineFilterRow(
                look: .project,
                title: name ?? "Every project",
                symbol: name == nil ? "square.stack.3d.up" : "folder",
                symbolColor: ReviewPalette.dim,
                count: "\(count)",
                selected: pick.project == name,
                tooltip: name.map { "Only \($0); the count is its questions that need an answer" } ?? "Questions of every project",
                select: { pick.project = name; pick.open = nil }
            )
            .equatable()
        }

        private func title(_ text: String) -> some View {
            Text(text)
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundColor(ReviewPalette.dim)
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 4)
        }
    }

    /// The page: one line per question, grouped by triage section; the open line shows its decision card.
    struct InboxTable: View {
        var model: HubModel
        @ObservedObject var inbox: HubInboxModel
        @ObservedObject private var pick = InboxPick.shared
        @GenReduceMotion private var reduceMotion

        var body: some View {
            let all = ListsSketchB.entries(inbox, filter: model.filter)
            let shown = all.filter { entry in
                (pick.bucket == nil || entry.bucket == pick.bucket) && (pick.project == nil || entry.session.projectName == pick.project)
            }
            // An open id that the filters hide no longer opens anything: the first shown line opens instead.
            let open = pick.open.flatMap { id in shown.contains { $0.id == id } ? id : nil } ?? shown.first?.id
            VStack(spacing: 0) {
                header(all: all, shown: shown.count)
                PanelFindBarSlot()
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                        if shown.isEmpty, inbox.loading {
                            PaneSkeleton("Looking for waiting questions")
                        } else if shown.isEmpty {
                            EmptyState(symbol: "tray", text: "No question in this section.")
                                .padding(.top, 40)
                        }
                        ForEach(Bucket.allCases, id: \.self) { bucket in
                            let rows = shown.filter { $0.bucket == bucket }
                            if !rows.isEmpty {
                                Section {
                                    ForEach(rows) { entry in
                                        line(entry, open: entry.id == open)
                                    }
                                } header: {
                                    sectionHeader(bucket, count: rows.count)
                                }
                            }
                        }
                    }
                    .padding(.bottom, 16)
                    .genScrollBars()
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .modifier(ListVariantInboxKeys(inbox: inbox, entries: shown.map { ListVariantInboxEntry(session: $0.session, item: $0.item) }, selected: open) { entry in
                inbox.selectedID = entry.session.id; inbox.keyCardID = entry.item.id; pick.open = entry.item.id
            })
        }

        @ViewBuilder
        private func line(_ entry: Entry, open: Bool) -> some View {
            TableLine(entry: entry, open: open) {
                GenMotion.perform(expanding: !open, reduceMotion: reduceMotion) {
                    pick.open = open ? "" : entry.id
                }
            }
            .equatable()
            if open {
                VStack(alignment: .leading, spacing: 8) {
                    if entry.item.isForm {
                        InboxFormCard(inbox: inbox, item: entry.item)
                    } else {
                        InboxDecisionCard(model: model, inbox: inbox, session: entry.session, item: entry.item)
                            .liveRow(selected: true)
                    }
                    if !entry.session.draftedItems.isEmpty {
                        InboxSendBar(model: model, inbox: inbox, session: entry.session)
                    }
                }
                .frame(maxWidth: HubInboxCards.readingWidth, alignment: .leading)
                .padding(.leading, 48)
                .padding(.trailing, 20)
                .padding(.vertical, 8)
                .transition(.genReveal)
            }
        }

        private func sectionHeader(_ bucket: Bucket, count: Int) -> some View {
            HStack(spacing: 8) {
                Image(systemName: bucket.symbol).foregroundColor(bucket.color).accessibilityHidden(true)
                Text(verbatim: bucket.title).font(.system(size: 12, weight: .semibold))
                Text(verbatim: "\(count)")
                    .font(.system(size: 10.5, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                Text(verbatim: bucket.tooltip)
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                Spacer()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 5)
            .hubSurface(.bar)
        }

        private func header(all: [Entry], shown: Int) -> some View {
            let open = all.filter { $0.bucket == .needsAnswer }.count
            let blocking = all.filter { $0.bucket == .needsAnswer && $0.blocking }.count
            let staged = all.filter { $0.bucket == .staged }.count
            var summary = "\(open) need an answer"
            if blocking > 0 { summary += " (\(blocking) block an agent)" }
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
                    Text(verbatim: "\(Plural.count(shown, "question")) shown")
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.dim)
                        .titlebarLabel()
                    if inbox.stagedCount > 0 {
                        Button {
                            inbox.sendAllStaged()
                        } label: {
                            Label("Send all staged (\(inbox.stagedCount))", systemImage: "paperplane.fill")
                                .font(.system(size: 12))
                                .lineLimit(1)
                        }
                        .buttonStyle(.genPrimary())
                        .fixedSize()
                        .instantTooltip("Send every staged decision of every session; each session gets one message")
                    }
                    IconButton(systemName: "arrow.clockwise", tooltip: "Look for waiting sessions again") { inbox.load() }
                }
            }
        }
    }

    /// One question in one line: mark, number, heading, session, project, the recommended pick, the age.
    struct TableLine: View, Equatable {
        let entry: Entry
        let open: Bool
        let toggle: () -> Void

        static func == (a: TableLine, b: TableLine) -> Bool { a.entry == b.entry && a.open == b.open }

        private var recommended: String? {
            entry.item.recommended ?? entry.item.choices?.first { $0.recommended == true }?.id
        }

        static let optionsWidth: CGFloat = 170
        static let sessionWidth: CGFloat = 250
        static let projectWidth: CGFloat = 140

        var body: some View {
            HStack(spacing: 8) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 12)
                Image(systemName: entry.blocking ? "hand.raised.fill" : "circle.fill")
                    .font(.system(size: entry.blocking ? 10 : 6))
                    .foregroundColor(entry.bucket.color)
                    .frame(width: 14)
                    .accessibilityLabel(Text(entry.blocking ? "An agent waits for this answer" : entry.bucket.title))
                Text(verbatim: entry.item.number.map { "\($0)" } ?? "")
                    .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 26, alignment: .trailing)
                Text(verbatim: entry.heading)
                    .font(.system(size: 12.5, weight: open ? .semibold : .regular))
                    .foregroundColor(Color.white.opacity(0.9))
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 10)
                // Fixed columns, as in a table: a long session title or project name moved every cell left of it, so
                // "3 options" started at a different x on each line.
                Group {
                    if let recommended, let count = entry.item.choices?.count, count > 0 {
                        Text(verbatim: "\(Plural.count(count, "option")) · \(recommended) recommended")
                    } else {
                        Text(verbatim: "")
                    }
                }
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
                .frame(width: Self.optionsWidth, alignment: .trailing)
                HStack(spacing: 6) {
                    ProviderBadge(provider: entry.session.provider ?? "?", size: 13)
                    Text(verbatim: entry.session.displayTitle)
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .frame(width: Self.sessionWidth, alignment: .leading)
                .instantTooltip(entry.session.displayTitle)
                Text(verbatim: entry.session.projectName)
                    .font(.system(size: 10.5, weight: .medium))
                    .foregroundColor(Color.white.opacity(0.7))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.white.opacity(0.07)))
                    .frame(width: Self.projectWidth, alignment: .trailing)
                    .instantTooltip(entry.session.projectName)
                LiveAgo(date: entry.item.date, style: .brief)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
                    .frame(minWidth: 52, alignment: .trailing)
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 6).fill(open ? Color.white.opacity(0.06) : Color.clear))
            .padding(.horizontal, 8)
            .contentShape(Rectangle())
            .rowButton { toggle() }
            .accessibilityLabel(Text(verbatim: "\(entry.heading), \(entry.session.displayTitle), \(entry.bucket.title)"))
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            .liveRow(selected: open)
        }
    }
}

// MARK: - Activity

extension ListsSketchB {
    /// One project's part of the feed.
    struct ProjectDigest: Identifiable {
        let name: String
        let newest: Date?
        /// Events that wait for the user, then every other event that is not a commit or a push, newest first.
        let events: [TimelineEvent]
        /// Commits with the push that sent them (by the push's head), or by author when no push names them.
        let commitGroups: [CommitGroup]
        let counts: [(kind: TimelineKind, count: Int)]
        var id: String { name }
    }

    struct CommitGroup: Identifiable, Equatable {
        let key: String
        let push: TimelineEvent?
        let author: String?
        let commits: [TimelineEvent]
        var id: String { key }
    }

    static func digests(_ events: [TimelineEvent]) -> [ProjectDigest] {
        let byProject = Dictionary(grouping: events) { $0.project ?? "No project" }
        let digests = byProject.map { name, events -> ProjectDigest in
            let sorted = events.sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
            let commits = sorted.filter { $0.timelineKind == .commit }
            let pushes = sorted.filter { $0.timelineKind == .push }
            let others = sorted.filter { $0.timelineKind != .commit && $0.timelineKind != .push }
            // A push takes the commits from its head down to the next older push's head (or the end of the page).
            var groups: [CommitGroup] = []
            var taken = Set<String>()
            let pushHeads = Set(pushes.compactMap(\.sha))
            for push in pushes {
                guard let head = push.sha, let start = commits.firstIndex(where: { $0.sha == head }) else { continue }
                var run: [TimelineEvent] = []
                for commit in commits[start...] {
                    if taken.contains(commit.id) { break }
                    if commit.id != commits[start].id, let sha = commit.sha, pushHeads.contains(sha) { break }
                    run.append(commit)
                    taken.insert(commit.id)
                }
                groups.append(CommitGroup(key: push.id, push: push, author: run.first?.author, commits: run))
            }
            let loose = Dictionary(grouping: commits.filter { !taken.contains($0.id) }) { $0.author ?? "" }
            for (author, run) in loose {
                groups.append(CommitGroup(key: "\(name)|\(author)", push: nil, author: author.isEmpty ? nil : author, commits: run))
            }
            let unmatchedPushes = pushes.filter { push in !groups.contains { $0.push?.id == push.id } }
            let needs = others.filter(\.waitsForMe)
            let rest = (others.filter { !$0.waitsForMe } + unmatchedPushes)
                .sorted { ($0.date ?? .distantPast) > ($1.date ?? .distantPast) }
            let kinds = Dictionary(grouping: sorted, by: \.timelineKind)
            return ProjectDigest(
                name: name,
                newest: sorted.first?.date,
                events: needs + rest,
                commitGroups: groups.sorted { ($0.commits.first?.date ?? .distantPast) > ($1.commits.first?.date ?? .distantPast) },
                counts: TimelineKind.allCases.compactMap { kind in kinds[kind].map { (kind, $0.count) } }
            )
        }
        return digests.sorted { ($0.newest ?? .distantPast) > ($1.newest ?? .distantPast) }
    }

    /// The Activity page by project. The filter rail is today's; its project filter narrows to one section.
    struct ActivityByProject: View {
        var model: HubModel
        @ObservedObject var timeline: HubTimelineModel
        @ObservedObject private var repos = RepoFactsStore.shared
        @State private var allEvents: Set<String> = []
        @State private var find = PanelFindModel(scope: "timeline", title: "Activity")
        @State private var searching = false
        @State private var openGroups: Set<String> = []
        @GenReduceMotion private var reduceMotion
        @AppStorage(HubActivityRows.allActionsKey, store: HubDefaults.store) private var allActions = false
        @AppStorage(HubActivityRows.commitPrefixKey, store: HubDefaults.store) private var commitPrefix = false

        static let eventsShown = 6

        var body: some View {
            let events = timeline.shown(filter: model.filter)
            let digests = ListsSketchB.digests(events)
            VStack(spacing: 0) {
                header(events: events.count, projects: digests.count)
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
                        ForEach(digests) { digest in
                            Section {
                                section(digest)
                            } header: {
                                projectHeader(digest)
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
            .panelFind(find, revision: events.map(\.rowID).joined(separator: "|")) {
                events.map { TimelineRowView.searchable($0, detail: timeline.details[$0.id], commitPrefix: commitPrefix) }
            }
        }

        @ViewBuilder
        private func section(_ digest: ProjectDigest) -> some View {
            let showsAll = searching || allEvents.contains(digest.name)
            let shown = showsAll ? digest.events : Array(digest.events.prefix(Self.eventsShown))
            ForEach(shown, id: \.rowID) { event in
                eventRow(event, nested: false)
            }
            if digest.events.count > Self.eventsShown {
                Button {
                    GenMotion.perform(expanding: !showsAll, reduceMotion: reduceMotion) {
                        if showsAll { allEvents.remove(digest.name) } else { allEvents.insert(digest.name) }
                    }
                } label: {
                    Text(verbatim: showsAll ? "Show fewer" : "Show \(digest.events.count - Self.eventsShown) more events")
                        .font(.system(size: 11.5))
                        .foregroundColor(Color(red: 0.62, green: 0.78, blue: 1))
                }
                .buttonStyle(.genHoverPlain())
                .padding(.leading, 52)
                .padding(.vertical, 3)
            }
            ForEach(digest.commitGroups) { group in
                let open = searching || openGroups.contains(group.id)
                CommitGroupRow(group: group, open: open, commitPrefix: commitPrefix) {
                    GenMotion.perform(expanding: !open, reduceMotion: reduceMotion) {
                        if open { openGroups.remove(group.id) } else { openGroups.insert(group.id) }
                    }
                }
                .equatable()
                .padding(.horizontal, 10)
                if open {
                    ForEach(group.commits, id: \.rowID) { commit in
                        eventRow(commit, nested: true)
                    }
                    .transition(.genReveal)
                }
            }
            Spacer().frame(height: 10)
        }

        private func eventRow(_ event: TimelineEvent, nested: Bool) -> some View {
            TimelineRowView(
                model: model,
                timeline: timeline,
                event: event,
                compact: true,
                expanded: timeline.isExpanded(event),
                projectPicked: event.project != nil && timeline.project == event.project,
                forge: event.repo.flatMap { repos.facts(for: $0)?.forge },
                allActions: allActions,
                commitPrefix: commitPrefix
            )
            .equatable()
            .swrFlash(timeline.changed.contains(event.id), cornerRadius: 6)
            .findRow(event.rowID)
            .padding(.leading, nested ? 44 : 10)
            .padding(.trailing, 10)
        }

        private func projectHeader(_ digest: ProjectDigest) -> some View {
            let words = digest.counts.map { entry -> String in
                switch entry.kind {
                case .commit: return Plural.count(entry.count, "commit")
                case .push: return Plural.count(entry.count, "push", "pushes")
                case .decision: return Plural.count(entry.count, "decision")
                case .session: return Plural.count(entry.count, "last turn")
                case .sessionStart: return Plural.count(entry.count, "session started", "sessions started")
                case .pr: return Plural.count(entry.count, "PR event")
                case .thread: return Plural.count(entry.count, "review comment")
                case .ci: return Plural.count(entry.count, "CI result")
                }
            }
            let waiting = digest.events.filter(\.waitsForMe).count
            return HStack(spacing: 8) {
                Image(systemName: "folder").foregroundColor(ReviewPalette.dim).accessibilityHidden(true)
                Text(verbatim: digest.name).font(.system(size: 13, weight: .semibold))
                if waiting > 0 {
                    Badge("\(waiting) need you", color: ReviewPalette.modified, look: .tone, symbol: "hand.raised.fill")
                }
                Text(verbatim: words.joined(separator: " · "))
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                Spacer()
                LiveAgo(date: digest.newest, style: .brief)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 6)
            .hubSurface(.bar)
        }

        private func header(events: Int, projects: Int) -> some View {
            TitlebarHeader {
                HStack(spacing: 10) {
                    Group {
                        Image(systemName: "clock.arrow.circlepath").foregroundColor(ReviewPalette.renamed)
                        Text(timeline.range.title).font(.system(size: 14, weight: .semibold))
                        Text(verbatim: "\(timeline.pageCount(events)) events in \(Plural.count(projects, "project"))")
                            .font(.system(size: 12))
                            .foregroundColor(ReviewPalette.dim)
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
    }

    /// "▸ ⬆ Pushed feat/x · 7 commits · newest subject … Martin 6m ago", or "▸ ● 12 commits by Martin …".
    struct CommitGroupRow: View, Equatable {
        let group: CommitGroup
        let open: Bool
        let commitPrefix: Bool
        let toggle: () -> Void

        static func == (a: CommitGroupRow, b: CommitGroupRow) -> Bool {
            a.group == b.group && a.open == b.open && a.commitPrefix == b.commitPrefix
        }

        var body: some View {
            let newest = group.commits.first
            HStack(spacing: 8) {
                Image(systemName: open ? "chevron.down" : "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 22)
                Image(systemName: group.push == nil ? TimelineKind.commit.symbol : TimelineKind.push.symbol)
                    .font(.system(size: 11.5))
                    .foregroundColor(group.push == nil ? TimelineKind.commit.color : TimelineKind.push.color)
                    .frame(width: 16)
                if let branch = group.push?.branch {
                    Text(verbatim: "Pushed \(branch)")
                        .font(.system(size: 12, weight: .semibold))
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .layoutPriority(1)
                    Text(verbatim: "·").foregroundColor(ReviewPalette.dim)
                }
                Text(verbatim: Plural.count(group.commits.count, "commit") + (group.push == nil ? group.author.map { " by \($0)" } ?? "" : ""))
                    .font(.system(size: 12, weight: group.push == nil ? .semibold : .regular))
                    .fixedSize()
                if let newest {
                    Text(verbatim: newest.shownTitle(keepsPrefix: commitPrefix))
                        .font(.system(size: 12))
                        .foregroundColor(Color.white.opacity(0.55))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                Spacer(minLength: 6)
                LiveAgo(date: newest?.date ?? group.push?.date, style: .brief)
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .fixedSize()
                    .frame(minWidth: 52, alignment: .trailing)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 26)
            .contentShape(Rectangle())
            .rowButton { toggle() }
            .accessibilityLabel(Text(verbatim: Plural.count(group.commits.count, "commit") + (group.push?.branch.map { ", pushed to \($0)" } ?? "")))
            .accessibilityValue(Text(open ? "Expanded" : "Collapsed"))
            .instantTooltip(open ? "Fold the commits" : "Show the \(group.commits.count) commits")
            .liveRow()
        }
    }
}
