import AppKit
import SwiftUI

// Activity (`--mode timeline`): one feed across projects of sessions (start, last turn), commits,
// pushes, PR events, review comments, decisions and CI results, from `tools hub timeline --json`
// (src/hub/lib/timeline.ts: bounded pages, a cursor for older ones, filters pushed into the page).
// A row folds open to its detail (`tools hub timeline detail`, Hub/HubTimelineDetail.swift) and
// carries the actions of its kind on the right; a click on the title opens the place in the hub.
// ⌘F is the shared panel find (Hub/HubPanelFind.swift): the rows' project, title, detail and author.

// MARK: - Data

struct TimelinePRRef: Decodable, Hashable {
    let ref: String
    let number: Int
    let url: String
}

struct TimelineEvent: Decodable, Identifiable, Hashable {
    let id: String
    let kind: String
    let at: String
    let title: String
    let detail: String?
    let project: String?
    let repo: String?
    let sessionId: String?
    let provider: String?
    let sha: String?
    let branch: String?
    let author: String?
    let pr: TimelinePRRef?
    let url: String?
    /// Mine: a session, my commit, a push, my PR, my comment, a decision I answer.
    let mine: Bool?
    /// Waits for me: an open decision, failed CI on my PR, a thread on my PR whose last word is not mine.
    let needsMe: Bool?
    /// A push's old tip (all zeros for a new branch).
    let fromSha: String?
    /// A session's folder.
    let cwd: String?
    /// PR: OPEN, MERGED, CLOSED. CI: failed, success. Decision: its state. Thread: open, resolved.
    let state: String?
    /// The PR's current CI status on a PR event.
    let ci: String?
    let threadId: String?
    let path: String?
    let line: Int?

    var date: Date? { HubFormat.date(at) }
    var timelineKind: TimelineKind { TimelineKind(rawValue: kind) ?? .session }
    var shortSha: String? { sha.map { String($0.prefix(8)) } }
    var isMine: Bool { mine ?? false }
    var waitsForMe: Bool { needsMe ?? false }

    /// What the sidebar filter searches: every label a row shows, lowercased.
    var searchText: String {
        [title, detail ?? "", project ?? "", branch ?? "", author ?? "", shortSha ?? "", pr?.ref ?? "", timelineKind.title, state ?? ""]
            .joined(separator: " ")
            .lowercased()
    }
}

struct TimelineEnvelope: Decodable {
    let since: String
    let until: String?
    let before: String?
    let events: [TimelineEvent]
    let repos: [String]
    let warnings: [String]
    let elapsedMs: Int
    let cached: Bool
    let hasMore: Bool?
    let nextBefore: String?
    let truncated: [String]?
}

/// The kinds the TS side emits, in the order the sidebar lists them.
enum TimelineKind: String, CaseIterable {
    case sessionStart = "session.start"
    case session = "session.turn"
    case commit, push, pr, thread, decision, ci

    var title: String {
        switch self {
        case .sessionStart: return "Sessions started"
        case .session: return "Last turns"
        case .commit: return "Commits"
        case .push: return "Pushes"
        case .pr: return "PR events"
        case .thread: return "Review comments"
        case .decision: return "Decisions"
        case .ci: return "CI results"
        }
    }

    var symbol: String {
        switch self {
        case .sessionStart: return "play.circle"
        case .session: return "text.bubble"
        case .commit: return "smallcircle.filled.circle"
        case .push: return "arrow.up.circle"
        case .pr: return "arrow.triangle.pull"
        case .thread: return "bubble.left.and.bubble.right"
        case .decision: return "questionmark.bubble"
        case .ci: return "checkmark.seal"
        }
    }

    var color: Color {
        switch self {
        case .sessionStart, .session: return Color(red: 0.85, green: 0.6, blue: 0.95)
        case .commit: return ReviewPalette.added
        case .push: return ReviewPalette.renamed
        case .pr: return ReviewPalette.modified
        case .thread: return Color(red: 0.4, green: 0.85, blue: 0.85)
        case .decision: return Color(red: 0.98, green: 0.82, blue: 0.4)
        case .ci: return Color(red: 0.6, green: 0.75, blue: 0.95)
        }
    }

    /// The `tools hub timeline detail --kind` the row's detail loads with.
    var detailKind: String {
        switch self {
        case .sessionStart, .session: return "session"
        default: return rawValue
        }
    }
}

/// The time range the feed covers. "Since last visit" starts where the last run of the hub last
/// looked at the feed; a custom range takes two dates from the sidebar.
enum TimelineRange: String, CaseIterable {
    case lastHour, last24h, today, yesterday, last7, last30, sinceLastVisit, custom

    /// Without a saved choice: a rolling day, so just after midnight the feed is not nearly empty
    /// (`TIMELINE_DEFAULT_RANGE` in src/hub/lib/timeline.ts).
    static let fallback: TimelineRange = .last24h

    var title: String {
        switch self {
        case .lastHour: return "Last hour"
        case .last24h: return "Last 24 hours"
        case .today: return "Today"
        case .yesterday: return "Yesterday"
        case .last7: return "Last 7 days"
        case .last30: return "Last 30 days"
        case .sinceLastVisit: return "Since last visit"
        case .custom: return "Custom"
        }
    }

    /// The range in local time; a missing last visit falls back to the last 24 hours.
    func interval(now: Date = Date(), lastVisit: Date?, customFrom: Date, customTo: Date, calendar: Calendar = .current) -> DateInterval {
        let today = calendar.startOfDay(for: now)
        switch self {
        case .lastHour:
            return DateInterval(start: now.addingTimeInterval(-3600), end: now)
        case .last24h:
            return DateInterval(start: now.addingTimeInterval(-86_400), end: now)
        case .today:
            return DateInterval(start: today, end: now)
        case .yesterday:
            let start = calendar.date(byAdding: .day, value: -1, to: today) ?? today
            return DateInterval(start: start, end: today.addingTimeInterval(-0.001))
        case .last7:
            return DateInterval(start: calendar.date(byAdding: .day, value: -6, to: today) ?? today, end: now)
        case .last30:
            return DateInterval(start: calendar.date(byAdding: .day, value: -29, to: today) ?? today, end: now)
        case .sinceLastVisit:
            guard let lastVisit, lastVisit < now else { return DateInterval(start: now.addingTimeInterval(-86_400), end: now) }
            return DateInterval(start: lastVisit, end: now)
        case .custom:
            let from = min(customFrom, customTo)
            let to = max(customFrom, customTo)
            let start = calendar.startOfDay(for: from)
            let end = min(now, calendar.startOfDay(for: to).addingTimeInterval(86_400 - 0.001))
            return DateInterval(start: start, end: max(start, end))
        }
    }
}

enum TimelineAuthor: String, CaseIterable {
    case all, me, others

    var title: String {
        switch self {
        case .all: return "Everyone"
        case .me: return "Me"
        case .others: return "Others"
        }
    }
}

// MARK: - Model

@MainActor
final class HubTimelineModel: ObservableObject {
    static let pageSize = 200

    @Published private(set) var events: [TimelineEvent] = []
    @Published private(set) var since: Date?
    @Published private(set) var until: Date?
    @Published private(set) var warnings: [String] = []
    @Published private(set) var truncated: [String] = []
    @Published private(set) var loading = false
    @Published private(set) var loadingOlder = false
    @Published private(set) var loadedAt: Date?
    @Published private(set) var error: String?
    @Published private(set) var hasMore = false
    /// Why the last "Load older" failed; the footer shows it beside the button (the page is not empty,
    /// so the empty-list error line never renders then).
    @Published private(set) var olderError: String?
    private var nextBefore: String?

    /// The sidebar's project filter; nil = every project.
    @Published var project: String? = HubDefaults.store.string(forKey: "hub.timeline.project") {
        didSet { HubDefaults.store.set(project, forKey: "hub.timeline.project") }
    }
    /// Hidden kinds: a client-side switch over the loaded page, so a toggle never reloads.
    @Published var hidden: Set<String> = Set(HubDefaults.store.stringArray(forKey: "hub.timeline.hidden") ?? []) {
        didSet { HubDefaults.store.set(Array(hidden), forKey: "hub.timeline.hidden") }
    }
    @Published var range: TimelineRange = TimelineRange(rawValue: HubDefaults.store.string(forKey: "hub.timeline.range") ?? "") ?? .fallback {
        didSet {
            HubDefaults.store.set(range.rawValue, forKey: "hub.timeline.range")
            if range != oldValue { load(fresh: false) }
        }
    }
    @Published var customFrom: Date = HubDefaults.store.object(forKey: "hub.timeline.customFrom") as? Date ?? Calendar.current.date(byAdding: .day, value: -7, to: Date()) ?? Date() {
        didSet {
            HubDefaults.store.set(customFrom, forKey: "hub.timeline.customFrom")
            if range == .custom { load(fresh: false) }
        }
    }
    @Published var customTo: Date = HubDefaults.store.object(forKey: "hub.timeline.customTo") as? Date ?? Date() {
        didSet {
            HubDefaults.store.set(customTo, forKey: "hub.timeline.customTo")
            if range == .custom { load(fresh: false) }
        }
    }
    /// Author and "needs me" shape the page itself (a page of mine is a full page), so they reload.
    @Published var author: TimelineAuthor = TimelineAuthor(rawValue: HubDefaults.store.string(forKey: "hub.timeline.author") ?? "") ?? .all {
        didSet {
            HubDefaults.store.set(author.rawValue, forKey: "hub.timeline.author")
            if author != oldValue { load(fresh: false) }
        }
    }
    @Published var needsMe: Bool = HubDefaults.store.bool(forKey: "hub.timeline.needsMe") {
        didSet {
            HubDefaults.store.set(needsMe, forKey: "hub.timeline.needsMe")
            if needsMe != oldValue { load(fresh: false) }
        }
    }

    @Published private(set) var expanded: Set<String> = []
    @Published private(set) var details: [String: TimelineDetail] = [:]
    @Published private(set) var detailErrors: [String: String] = [:]
    @Published private(set) var loadingDetails: Set<String> = []
    /// One commit's one file, keyed `<sha>\0<path>`.
    @Published private(set) var fileDiffs: [String: TimelineFileDiff] = [:]
    @Published private(set) var loadingDiffs: Set<String> = []
    /// `tools ai-spend session` per session id; `.some(nil)` = asked, no spend.
    @Published private(set) var spend: [String: HubSpend.Estimate?] = [:]

    /// When the feed was last looked at in an earlier run of the hub: the start of "since my last visit".
    let lastVisit: Date? = HubDefaults.store.object(forKey: "hub.timeline.lastVisit") as? Date
    var onLoaded: (() -> Void)?
    /// `--timeline-open`: the event a loaded page opens once, with `opener` (HubModel.openTimelineRequest).
    var openRequest: String?
    var opener: ((TimelineEvent) -> Void)?

    func runOpenRequest() {
        guard let id = openRequest else { return }
        openRequest = nil
        guard let event = events.first(where: { $0.id == id }) else {
            HubPerf.log("timeline.open-request \(id) is not in this page (\(events.count) events)")
            return
        }
        opener?(event)
    }

    /// Bumped on every range or filter change, so a slow older load cannot land in a new range.
    private var generation = 0
    private var threadStores: [String: PRThreadsStore] = [:]

    var interval: DateInterval {
        range.interval(lastVisit: lastVisit, customFrom: customFrom, customTo: customTo)
    }

    /// The rows the list shows: hidden kinds, the project and the sidebar filter text.
    func shown(filter: String) -> [TimelineEvent] {
        let needle = filter.trimmed.lowercased()
        return events.filter { event in
            !hidden.contains(event.kind)
                && (project == nil || event.project == project)
                && (needle.isEmpty || event.searchText.contains(needle))
        }
    }

    func count(_ kind: TimelineKind) -> Int {
        events.filter { $0.kind == kind.rawValue && (project == nil || $0.project == project) }.count
    }

    var projects: [(name: String, count: Int)] {
        let grouped = Dictionary(grouping: events.compactMap(\.project), by: { $0 })
        return grouped.map { ($0.key, $0.value.count) }.sorted { $0.count == $1.count ? $0.name < $1.name : $0.count > $1.count }
    }

    /// `tools hub timeline` arguments for one page of the current range and filters.
    nonisolated static func arguments(interval: DateInterval, before: String?, limit: Int, author: TimelineAuthor, needsMe: Bool, fresh: Bool) -> [String] {
        var args = ["hub", "timeline", "--json", "--since", HubFormat.iso.string(from: interval.start), "--until", HubFormat.iso.string(from: interval.end), "--limit", "\(limit)"]
        if let before { args += ["--before", before] }
        if author != .all { args += ["--author", author.rawValue] }
        if needsMe { args.append("--needs-me") }
        if fresh { args.append("--fresh") }
        return args
    }

    func loadIfStale() {
        if let loadedAt, Date().timeIntervalSince(loadedAt) < 60 {
            let done = onLoaded
            onLoaded = nil
            done?()
            return
        }
        load(fresh: false)
    }

    /// The live page of the range. `fresh` skips the TS side's page cache (the PR list keeps its five minutes).
    func load(fresh: Bool) {
        generation += 1
        let mine = generation
        // An older page still on its way belongs to the old generation and is dropped on arrival.
        loadingOlder = false
        olderError = nil
        loading = true
        error = nil
        let interval = interval
        let args = Self.arguments(interval: interval, before: nil, limit: Self.pageSize, author: author, needsMe: needsMe, fresh: fresh)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("timeline.load", "\(fresh ? "fresh " : "")\(args.dropFirst(3).joined(separator: " "))")
            let result = Result { try JSONDecoder().decode(TimelineEnvelope.self, from: ToolsCLIRunner.run(args)) }
            span.end((try? result.get()).map { "\($0.events.count) events, tools \($0.elapsedMs) ms\($0.cached ? " cached" : "")" } ?? "failed")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.generation == mine else { return }
                    self.loading = false
                    switch result {
                    case .success(let envelope):
                        self.events = envelope.events
                        self.warnings = envelope.warnings
                        self.truncated = envelope.truncated ?? []
                        self.since = HubFormat.date(envelope.since) ?? interval.start
                        self.until = HubFormat.date(envelope.until) ?? interval.end
                        self.hasMore = envelope.hasMore ?? false
                        self.nextBefore = envelope.nextBefore
                        self.error = nil
                        self.loadedAt = Date()
                        // The next run's "since my last visit" starts at the last look of this one.
                        HubDefaults.store.set(Date(), forKey: "hub.timeline.lastVisit")
                    case .failure(let failure):
                        self.error = "\(failure)"
                    }
                    self.runOpenRequest()
                    let done = self.onLoaded
                    self.onLoaded = nil
                    done?()
                }
            }
        }
    }

    /// The next older page of the same range; rows already shown (a boundary shared by two pages) are skipped.
    func loadOlder() {
        guard hasMore, let cursor = nextBefore, !loadingOlder, !loading else { return }
        let mine = generation
        loadingOlder = true
        olderError = nil
        let args = Self.arguments(interval: interval, before: cursor, limit: Self.pageSize, author: author, needsMe: needsMe, fresh: false)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("timeline.older", "before \(cursor)")
            let result = Result { try JSONDecoder().decode(TimelineEnvelope.self, from: ToolsCLIRunner.run(args)) }
            span.end((try? result.get()).map { "\($0.events.count) events" } ?? "failed")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self, self.generation == mine else { return }
                    self.loadingOlder = false
                    switch result {
                    case .success(let envelope):
                        let known = Set(self.events.map(\.id))
                        self.events.append(contentsOf: envelope.events.filter { !known.contains($0.id) })
                        self.warnings = Array(Set(self.warnings + envelope.warnings)).sorted()
                        self.truncated = envelope.truncated ?? []
                        self.hasMore = envelope.hasMore ?? false
                        self.nextBefore = envelope.nextBefore
                    case .failure(let failure):
                        self.olderError = "Could not read older activity: \(failure)"
                    }
                }
            }
        }
    }

    // MARK: Details

    func isExpanded(_ event: TimelineEvent) -> Bool { expanded.contains(event.id) }

    /// Folds a row open (loading its detail once) or closed.
    func toggle(_ event: TimelineEvent) {
        if expanded.contains(event.id) {
            expanded.remove(event.id)
            return
        }
        expanded.insert(event.id)
        if details[event.id] == nil {
            loadDetail(event)
        }
        if event.timelineKind == .session || event.timelineKind == .sessionStart, let id = event.sessionId, spend[id] == nil {
            loadSpend(sessionId: id, at: event.date ?? Date())
        }
    }

    /// `tools hub timeline detail` arguments for a row; the period is the feed's range.
    func detailArguments(for event: TimelineEvent, fresh: Bool, file: String? = nil) -> [String] {
        var args = ["hub", "timeline", "detail", "--json", "--kind", event.timelineKind.detailKind, "--id", event.id]
        if let repo = event.repo { args += ["--repo", repo] }
        if let url = event.url ?? event.pr?.url, event.timelineKind == .pr || event.timelineKind == .ci || event.timelineKind == .thread {
            args += ["--pr", url]
        }
        if let from = event.fromSha { args += ["--from", from] }
        if let session = event.sessionId, event.timelineKind == .session || event.timelineKind == .sessionStart {
            args += ["--session", session]
        }
        let interval = interval
        args += ["--since", HubFormat.iso.string(from: interval.start), "--until", HubFormat.iso.string(from: interval.end)]
        if let file { args += ["--file", file] }
        if fresh { args.append("--fresh") }
        return args
    }

    func loadDetail(_ event: TimelineEvent, fresh: Bool = false) {
        guard !loadingDetails.contains(event.id) else { return }
        loadingDetails.insert(event.id)
        detailErrors[event.id] = nil
        let args = detailArguments(for: event, fresh: fresh)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("timeline.detail.\(event.timelineKind.detailKind)", event.id)
            let result = Result { try TimelineDetail.load(args) }
            span.end((try? result.get()).map { _ in "ok" } ?? "failed")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.loadingDetails.remove(event.id)
                    switch result {
                    case .success(let detail): self.details[event.id] = detail
                    case .failure(let failure): self.detailErrors[event.id] = "\(failure)"
                    }
                }
            }
        }
    }

    static func diffKey(sha: String, path: String) -> String { "\(sha)\0\(path)" }

    /// One file of a commit, on demand (the detail lists the files; the diff is a second, cached call).
    func loadFileDiff(_ event: TimelineEvent, path: String) {
        guard let sha = event.sha else { return }
        let key = Self.diffKey(sha: sha, path: path)
        if fileDiffs[key] != nil {
            fileDiffs[key] = nil
            return
        }
        guard !loadingDiffs.contains(key) else { return }
        loadingDiffs.insert(key)
        let args = detailArguments(for: event, fresh: false, file: path)
        DispatchQueue.global(qos: .userInitiated).async {
            let span = HubPerf.begin("timeline.detail.diff", "\(sha.prefix(8)) \(path)")
            let result = Result { try TimelineDetail.load(args) }
            span.end()
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.loadingDiffs.remove(key)
                    if case .success(.commit(let detail)) = result, let diff = detail.diff {
                        self.fileDiffs[key] = diff
                    } else if case .failure(let failure) = result {
                        self.fileDiffs[key] = TimelineFileDiff(path: path, text: "\(failure)", truncated: false)
                    }
                }
            }
        }
    }

    /// The list-price estimate the session pane shows, from `tools ai-spend session` (seconds; off the main thread).
    private func loadSpend(sessionId: String, at: Date) {
        spend[sessionId] = .some(nil)
        if let cached = HubSpend.cached(sessionId) {
            spend[sessionId] = cached
            return
        }
        let row = HubSession(sessionId: sessionId, mtime: at.timeIntervalSince1970 * 1000)
        DispatchQueue.global(qos: .utility).async {
            let span = HubPerf.begin("timeline.detail.spend", String(sessionId.prefix(8)))
            let estimate = HubSpend.fetch(row)
            span.end(estimate.map { SessionFormat.usd($0.usd) } ?? "none")
            DispatchQueue.main.async { [weak self] in
                MainActor.assumeIsolated { self?.spend[sessionId] = .some(estimate) }
            }
        }
    }

    // MARK: Review threads (the Review path: PRThreadsStore + PRCommand, never a second route)

    func threadStore(for url: String) -> PRThreadsStore {
        if let store = threadStores[url] { return store }
        let store = PRThreadsStore(target: .ref(url))
        threadStores[url] = store
        return store
    }
}

// MARK: - Actions

/// One action a row offers: an icon button on the right and the same entry in the context menu.
struct TimelineAction: Identifiable {
    enum Run {
        case perform(() -> Void)
        /// Needs a popover anchored to the row (a launch picker, a reply box).
        case popover(TimelinePopover)
    }

    let id: String
    let symbol: String
    let title: String
    var disabled = false
    let run: Run
}

enum TimelinePopover: Identifiable {
    case resume(HubSession)
    case newAgent(cwd: String, name: String, prompt: String)
    case reply(TimelineEvent)

    var id: String {
        switch self {
        case .resume(let session): return "resume:\(session.id)"
        case .newAgent(_, let name, _): return "agent:\(name)"
        case .reply(let event): return "reply:\(event.id)"
        }
    }
}

enum TimelinePrompts {
    /// The first message of a review session for a PR: the same words the PRs mode uses, by URL.
    static func reviewPR(_ url: String) -> String {
        "Review \(url) with the genesis-tools:review-proposal skill: read the diff and its existing review threads, decide a verdict, draft comments anchored to the changed lines, and push the proposal with `tools hub proposal push` so it shows in the GenesisTools hub. Do not post, approve or merge anything on the PR."
    }

    static func reviewCommit(sha: String, repo: String) -> String {
        "Review commit \(sha) in \(repo) with the genesis-tools:review-proposal skill: read `git show \(sha)`, decide a verdict, draft comments anchored to the changed lines, and push the proposal with `tools hub proposal push` so it shows in the GenesisTools hub. Do not post anything on a PR and do not change the branch."
    }
}

extension HubModel {
    /// A timeline row's click: the session, the commit in its repository's diff, the PR, or the decision's session.
    @MainActor
    func openTimelineEvent(_ event: TimelineEvent) {
        HubPerf.log("timeline.open \(event.kind) \(event.id.prefix(40))")
        switch event.timelineKind {
        case .session, .sessionStart:
            openTimelineSession(event)
        case .decision:
            openTimelineSession(event)
            tab = .decisions
        case .commit, .push:
            showTimelineCommit(event, sha: event.sha, title: event.title)
        case .pr, .thread, .ci:
            openTimelinePR(event)
        }
    }

    /// A commit of the row's repository in the worktrees mode's in-app diff.
    @MainActor
    func showTimelineCommit(_ event: TimelineEvent, sha: String?, title: String) {
        guard let repo = event.repo, let sha, FileManager.default.fileExists(atPath: repo) else {
            notice = "This repository is not on this Mac."
            return
        }
        setMode(.worktrees)
        selectedWorktree = repo
        let next = ReviewModel(repo: URL(fileURLWithPath: repo), options: DiffViewOptions())
        next.embedded = true
        next.setScope(.commit(sha: sha, title: title))
        review = next
    }

    /// The row's session: the hub's row when it is in the list, else one built from the row (an
    /// older session the list no longer holds; the transcript loads by id all the same).
    @MainActor
    func timelineSession(_ event: TimelineEvent) -> HubSession? {
        guard let id = event.sessionId else { return nil }
        if let known = sessions.first(where: { $0.sessionId == id }) { return known }
        let folder = event.cwd ?? ""
        return HubSession(
            provider: event.provider ?? HubSession.claudeProvider,
            sessionId: id,
            title: event.title,
            cwd: folder,
            cwdShort: (folder as NSString).lastPathComponent,
            project: event.project,
            gitBranch: event.branch,
            mtime: (event.date?.timeIntervalSince1970 ?? 0) * 1000,
            modelSwitched: false,
            filePath: ""
        )
    }

    @MainActor
    func openTimelineSession(_ event: TimelineEvent, transcriptQuery query: String? = nil) {
        guard let session = timelineSession(event) else {
            notice = "This row names no session."
            return
        }
        if !sessions.contains(where: { $0.id == session.id }) {
            sessions.append(session)
        }
        openSession(session)
        if let query, !query.isEmpty {
            transcriptQuery = query
        }
    }

    /// `--timeline-open <event id> [--timeline-action <action id>]` (snapshots, links): once the feed
    /// holds the event, one of its row's actions runs (the ids `timelineActions` gives, "diff" for a
    /// review comment's "Open in the diff"), else the row's own click.
    @MainActor
    func openTimelineRequest(_ id: String, action: String?) {
        timeline.openRequest = id
        timeline.opener = { [weak self] event in
            guard let self else { return }
            HubPerf.log("timeline.open-request \(event.id.prefix(40)) action=\(action ?? "click")")
            if let action, let match = self.timelineActions(for: event, timeline: self.timeline).first(where: { $0.id == action }),
               case .perform(let run) = match.run {
                run()
            } else {
                self.openTimelineEvent(event)
            }
        }
        // A request handed to a running hub whose feed is already loaded: nothing else would run it.
        if timeline.loadedAt != nil, !timeline.loading {
            timeline.runOpenRequest()
        }
    }

    /// The row's PR in the PRs mode. With `path`, the PR's review opens at that file and the row's
    /// thread once it is built (the list, a head fetch for a PR without a worktree, the diff load).
    @MainActor
    func openTimelinePR(_ event: TimelineEvent, reveal path: String? = nil) {
        guard let ref = event.pr.flatMap({ HubPRRef($0.ref) }) else {
            notice = "This row names no PR."
            return
        }
        setMode(.prs)
        prs.request(ref, reveal: path.map { PRReveal(ref: ref, path: $0, threadID: event.threadId) })
    }

    /// Focuses the cmux pane of a session, off the main thread; the notice says what happened.
    @MainActor
    func focusTimelinePane(_ event: TimelineEvent) {
        guard let id = event.sessionId else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let failure = TerminalHosts.current.focus(sessionId: id)
            DispatchQueue.main.async { [weak self] in
                self?.notice = failure.map { "No cmux pane found for this session: \($0.suffix(120))" } ?? "Focused the session's cmux pane"
            }
        }
    }

    /// The host page of a commit, push (compare) or PR, from the repository's origin facts.
    @MainActor
    func timelineHostURL(_ event: TimelineEvent, compare: Bool = false) -> URL? {
        if let url = event.url.flatMap(URL.init(string:)), event.timelineKind != .push, event.timelineKind != .commit {
            return url
        }
        guard let repo = event.repo, let forge = RepoFactsStore.shared.facts(for: repo)?.forge else { return nil }
        if compare, let from = event.fromSha, let to = event.sha, !from.allSatisfy({ $0 == "0" }) {
            return forge.compare(base: from, head: to)
        }
        return event.sha.flatMap { forge.commit($0) }
    }

    /// The actions a row offers, in the order they sit on the right; the context menu lists the same.
    @MainActor
    func timelineActions(for event: TimelineEvent, timeline: HubTimelineModel) -> [TimelineAction] {
        var actions: [TimelineAction] = []
        func add(_ id: String, _ symbol: String, _ title: String, disabled: Bool = false, _ perform: @escaping () -> Void) {
            actions.append(TimelineAction(id: id, symbol: symbol, title: title, disabled: disabled, run: .perform(perform)))
        }
        func popover(_ id: String, _ symbol: String, _ title: String, _ popover: TimelinePopover) {
            actions.append(TimelineAction(id: id, symbol: symbol, title: title, run: .popover(popover)))
        }

        switch event.timelineKind {
        case .session, .sessionStart:
            add("open", "text.bubble", "Open in the hub") { [weak self] in self?.openTimelineSession(event) }
            if let session = timelineSession(event) {
                popover("resume", "play.circle", "Resume this session (pick the terminal target)", .resume(session))
            }
            add("focus", "rectangle.on.rectangle", "Focus its cmux pane") { [weak self] in self?.focusTimelinePane(event) }
            add("transcript", "text.magnifyingglass", "Open the transcript at the last prompt of this period") { [weak self, weak timeline] in
                var prompt: String?
                if let timeline, case .session(let detail)? = timeline.details[event.id] {
                    prompt = detail.prompts.last?.text
                }
                self?.openTimelineSession(event, transcriptQuery: prompt.map { String($0.prefix(60)) })
            }
            let folder = event.cwd ?? ""
            add("cursor", "chevron.left.forwardslash.chevron.right", "Open the folder in Cursor", disabled: folder.isEmpty) { PathOpener.cursor(folder) }
            add("copy", "doc.on.doc", "Copy the session id") { PathOpener.copy(event.sessionId ?? "") }
        case .commit:
            add("diff", "rectangle.split.2x1", "Show this commit in the in-app diff") { [weak self] in self?.openTimelineEvent(event) }
            add("host", "arrow.up.right.square", "Open the commit on the host") { [weak self] in
                guard let self else { return }
                if let url = self.timelineHostURL(event) {
                    ExternalOpener.open(url)
                } else {
                    self.notice = "The repository's origin is not known yet; try again in a moment."
                }
            }
            add("copy", "number", "Copy the sha") { PathOpener.copy(event.sha ?? "") }
            add("prs", "arrow.triangle.pull", "Open the PRs that contain it") { [weak self, weak timeline] in
                guard let self, let timeline else { return }
                if case .commit(let detail)? = timeline.details[event.id] {
                    guard let first = detail.prs.first, let ref = HubPRRef(first.ref) else {
                        self.notice = "No PR of this repository contains \(event.shortSha ?? "this commit")."
                        return
                    }
                    self.setMode(.prs)
                    self.prs.request(ref)
                } else {
                    if timeline.isExpanded(event) { timeline.loadDetail(event) } else { timeline.toggle(event) }
                    self.notice = "Reading the commit's PRs; open the row to pick one."
                }
            }
            if let repo = event.repo, let sha = event.sha {
                popover("review", "checklist", "Review this commit with an agent (a proposal, nothing posted)", .newAgent(cwd: repo, name: "review \(event.project ?? "") \(sha.prefix(8))", prompt: TimelinePrompts.reviewCommit(sha: sha, repo: repo)))
            }
        case .push:
            add("compare", "arrow.left.arrow.right.square", "Compare view on the host") { [weak self] in
                guard let self else { return }
                if let url = self.timelineHostURL(event, compare: true) {
                    ExternalOpener.open(url)
                } else {
                    self.notice = "No compare page: a new branch, or the origin is not known yet."
                }
            }
            add("pr", "arrow.triangle.pull", "Open the PR in the hub", disabled: event.pr == nil) { [weak self] in self?.openTimelinePR(event) }
            add("diff", "rectangle.split.2x1", "Show the pushed tip in the in-app diff") { [weak self] in self?.openTimelineEvent(event) }
        case .pr, .ci:
            add("hub", "arrow.triangle.pull", "Open in the hub") { [weak self] in self?.openTimelinePR(event) }
            add("host", "arrow.up.right.square", "Open on the host") { [weak self] in
                if let url = self?.timelineHostURL(event) { ExternalOpener.open(url) }
            }
            if let repo = event.repo, let url = event.url {
                popover("review", "checklist", "Review this PR with an agent (a proposal, nothing posted)", .newAgent(cwd: repo, name: "review \(event.project ?? "") \(event.pr?.ref ?? "")", prompt: TimelinePrompts.reviewPR(url)))
            }
            let failed = event.state == "failed" || event.ci == "failed"
            add("fix", "wrench.and.screwdriver", failed ? "Fix the failed checks: opens the PR, whose Checks section sends the log to an agent" : "No failed check on this PR", disabled: !failed) { [weak self] in
                self?.openTimelinePR(event)
            }
        case .thread:
            popover("reply", "arrowshape.turn.up.left", "Reply in this thread", .reply(event))
            let resolved = event.state == "resolved"
            add("resolve", resolved ? "checkmark.circle.fill" : "checkmark.circle", resolved ? "Reopen this thread" : "Resolve this thread") { [weak self, weak timeline] in
                guard let timeline, let url = event.pr?.url, let thread = event.threadId else { return }
                timeline.threadStore(for: url).resolve(thread: thread, resolved: !resolved)
                self?.notice = resolved ? "Reopening the thread…" : "Resolving the thread…"
            }
            add("host", "arrow.up.right.square", "Open the comment on the host") { [weak self] in
                if let url = self?.timelineHostURL(event) { ExternalOpener.open(url) }
            }
            add("diff", "rectangle.split.2x1", "Open the PR's diff at this file") { [weak self] in self?.openTimelinePR(event, reveal: event.path) }
        case .decision:
            add("open", "questionmark.bubble", "Open the session's Decisions pane") { [weak self] in self?.openTimelineEvent(event) }
            add("copy", "doc.on.doc", "Copy the question") { PathOpener.copy(event.title) }
        }
        return actions
    }
}

// MARK: - Sidebar

struct TimelineListView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var timeline: HubTimelineModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 2) {
                sectionTitle("Range")
                ForEach(TimelineRange.allCases, id: \.self) { range in
                    rangeRow(range)
                }
                if timeline.range == .custom {
                    customDates
                }
                sectionTitle("Who")
                Picker("", selection: $timeline.author) {
                    ForEach(TimelineAuthor.allCases, id: \.self) { Text($0.title).tag($0) }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .controlSize(.small)
                .padding(.horizontal, 16)
                .instantTooltip("Whose events: everyone, mine (my sessions, commits, pushes, PRs and comments), or other people's")
                needsMeRow
                sectionTitle("Show")
                ForEach(TimelineKind.allCases, id: \.self) { kind in
                    kindRow(kind)
                }
                sectionTitle("Projects")
                projectRow(name: nil, count: timeline.events.count)
                ForEach(timeline.projects, id: \.name) { entry in
                    projectRow(name: entry.name, count: entry.count)
                }
            }
            .padding(.bottom, 12)
        }
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundColor(ReviewPalette.dim)
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 4)
    }

    private func rangeRow(_ range: TimelineRange) -> some View {
        let selected = timeline.range == range
        let subtitle: String? = range == .sinceLastVisit ? (timeline.lastVisit.map { "from \(HubFormat.ago($0))" } ?? "no earlier visit: last 24 hours") : nil
        return HStack(spacing: 8) {
            Image(systemName: selected ? "largecircle.fill.circle" : "circle")
                .foregroundColor(selected ? ReviewPalette.renamed : ReviewPalette.dim)
                .frame(width: 16)
            // The subtitle goes under the title, so a narrow sidebar never cuts the range's name.
            VStack(alignment: .leading, spacing: 1) {
                Text(range.title).font(.system(size: 12.5, weight: selected ? .semibold : .regular)).lineLimit(1).fixedSize()
                if let subtitle {
                    Text(subtitle).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).lineLimit(2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, subtitle == nil ? 0 : 4)
        .frame(minHeight: 26)
        .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .contentShape(Rectangle())
        .rowButton { timeline.range = range }
        .padding(.horizontal, 6)
        .instantTooltip(range == .sinceLastVisit ? "Everything since the last time this feed was open in an earlier run of the hub" : "Show \(range.title.lowercased())")
    }

    private var customDates: some View {
        VStack(alignment: .leading, spacing: 4) {
            DatePicker("From", selection: $timeline.customFrom, displayedComponents: .date)
            DatePicker("To", selection: $timeline.customTo, displayedComponents: .date)
        }
        .datePickerStyle(.field)
        .font(.system(size: 11.5))
        .padding(.horizontal, 16)
        .padding(.vertical, 4)
        .instantTooltip("The custom range: whole days, from the first to the last")
    }

    private var needsMeRow: some View {
        let on = timeline.needsMe
        return HStack(spacing: 8) {
            Image(systemName: on ? "checkmark.square.fill" : "square")
                .foregroundColor(on ? ReviewPalette.modified : ReviewPalette.dim)
            Image(systemName: "hand.raised").foregroundColor(ReviewPalette.modified).frame(width: 16)
            Text("Only what needs me").font(.system(size: 12.5))
            Spacer()
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .contentShape(Rectangle())
        .rowButton { timeline.needsMe.toggle() }
        .padding(.horizontal, 6)
        .instantTooltip("Open decisions, failed CI on my PRs, and review threads on my PRs whose last word is not mine")
    }

    private func kindRow(_ kind: TimelineKind) -> some View {
        let on = !timeline.hidden.contains(kind.rawValue)
        return HStack(spacing: 8) {
            Image(systemName: on ? "checkmark.square.fill" : "square")
                .foregroundColor(on ? kind.color : ReviewPalette.dim)
            Image(systemName: kind.symbol).foregroundColor(kind.color).frame(width: 16)
            Text(kind.title).font(.system(size: 12.5))
            Spacer()
            Text(verbatim: "\(timeline.count(kind))")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .contentShape(Rectangle())
        .rowButton {
            if on { timeline.hidden.insert(kind.rawValue) } else { timeline.hidden.remove(kind.rawValue) }
        }
        .padding(.horizontal, 6)
        .instantTooltip(on ? "Hide \(kind.title.lowercased())" : "Show \(kind.title.lowercased())")
    }

    private func projectRow(name: String?, count: Int) -> some View {
        let selected = timeline.project == name
        return HStack(spacing: 8) {
            Image(systemName: name == nil ? "square.stack.3d.up" : "folder")
                .foregroundColor(ReviewPalette.dim)
                .frame(width: 16)
            Text(name ?? "Every project")
                .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                .lineLimit(1)
            Spacer()
            Text(verbatim: "\(count)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
        }
        .padding(.horizontal, 10)
        .frame(height: 26)
        .background(RoundedRectangle(cornerRadius: 7).fill(selected ? Color.white.opacity(0.08) : Color.clear))
        .contentShape(Rectangle())
        .rowButton { timeline.project = name }
        .padding(.horizontal, 6)
        .instantTooltip(name.map { "Only \($0)" } ?? "Every project")
    }
}

// MARK: - Main

/// One hour of a day in the feed.
struct TimelineHour: Identifiable {
    let hour: Date
    let events: [TimelineEvent]
    /// Not the bare date: the midnight hour starts at its day's own start, and with one id for the
    /// day's section and its "00:00" group the lazy list drew that hour's header blank.
    var id: String { "hour:\(hour.timeIntervalSince1970)" }
}

/// The feed grouped by day, then by hour inside a day.
struct TimelineDay: Identifiable {
    let day: Date
    let hours: [TimelineHour]
    var id: String { "day:\(day.timeIntervalSince1970)" }
    var count: Int { hours.reduce(0) { $0 + $1.events.count } }

    static func group(_ events: [TimelineEvent], calendar: Calendar = .current) -> [TimelineDay] {
        let byDay = Dictionary(grouping: events) { event in
            event.date.map { calendar.startOfDay(for: $0) } ?? .distantPast
        }
        return byDay.keys.sorted(by: >).map { day in
            let byHour = Dictionary(grouping: byDay[day] ?? []) { event in
                event.date.map { calendar.dateInterval(of: .hour, for: $0)?.start ?? $0 } ?? .distantPast
            }
            return TimelineDay(day: day, hours: byHour.keys.sorted(by: >).map { TimelineHour(hour: $0, events: byHour[$0] ?? []) })
        }
    }

    /// "Today", "Yesterday", else the full date.
    func title(now: Date = Date(), calendar: Calendar = .current) -> String {
        if calendar.isDate(day, inSameDayAs: now) { return "Today" }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: calendar.startOfDay(for: now)), calendar.isDate(day, inSameDayAs: yesterday) {
            return "Yesterday"
        }
        return TimelineMain.dayFormat.string(from: day)
    }
}

struct TimelineMain: View {
    @ObservedObject var model: HubModel
    @ObservedObject var timeline: HubTimelineModel
    @State private var find = PanelFindModel(scope: "timeline", title: "Activity")

    static let hourFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:00"
        return formatter
    }()

    static let dayFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .full
        return formatter
    }()

    private static let rangeFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter
    }()

    var body: some View {
        let events = timeline.shown(filter: model.filter)
        let days = TimelineDay.group(events)
        VStack(spacing: 0) {
            header(count: events.count)
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            PanelFindBar(find: find)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0, pinnedViews: [.sectionHeaders]) {
                    if events.isEmpty {
                        Text(timeline.loading ? "Reading the activity…" : timeline.error ?? (timeline.events.isEmpty ? "Nothing happened in this range." : "Nothing matches these filters."))
                            .font(.system(size: 13))
                            .foregroundColor(ReviewPalette.dim)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 40)
                    }
                    ForEach(days) { day in
                        Section {
                            ForEach(day.hours) { hour in
                                hourHeader(hour.hour, count: hour.events.count)
                                ForEach(hour.events) { event in
                                    TimelineRowView(model: model, timeline: timeline, event: event)
                                        .findRow(event.id)
                                        .padding(.horizontal, 10)
                                }
                            }
                        } header: {
                            dayHeader(day)
                        }
                    }
                    footer(shown: events.count)
                }
                .padding(.bottom, 16)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // The find re-runs when the shown rows change, a row folds open or closed, or a detail lands.
        .panelFind(find, revision: findRevision(events)) {
            events.map { TimelineRowView.searchable($0, detail: timeline.isExpanded($0) ? timeline.details[$0.id] : nil) }
        }
    }

    private func findRevision(_ events: [TimelineEvent]) -> String {
        let open = events.filter(timeline.isExpanded).map { "\($0.id)\(timeline.details[$0.id] == nil ? "" : "+")" }
        return events.map(\.id).joined(separator: "\n") + "\u{1}" + open.joined(separator: "\n")
    }

    private func dayHeader(_ day: TimelineDay) -> some View {
        let title = day.title()
        return HStack {
            Text(verbatim: title)
                .font(.system(size: 12, weight: .semibold))
            if title == "Today" || title == "Yesterday" {
                Text(verbatim: TimelineMain.dayFormat.string(from: day.day))
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            }
            Spacer()
            Text(verbatim: "\(day.count)")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 5)
        .hubSurface(.bar)
    }

    private func hourHeader(_ hour: Date, count: Int) -> some View {
        HStack {
            Text(verbatim: Self.hourFormat.string(from: hour))
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
            Rectangle().fill(ReviewPalette.hairline).frame(height: 1)
            Text(verbatim: "\(count)")
                .font(.system(size: 10, design: .monospaced))
        }
        .foregroundColor(ReviewPalette.dim)
        .padding(.horizontal, 20)
        .padding(.top, 8)
        .padding(.bottom, 3)
    }

    private func footer(shown: Int) -> some View {
        HStack(spacing: 10) {
            if timeline.hasMore {
                Button {
                    timeline.loadOlder()
                } label: {
                    Label(timeline.loadingOlder ? "Reading older activity…" : "Load older", systemImage: "arrow.down.circle")
                }
                .buttonStyle(.genHoverPlain())
                .disabled(timeline.loadingOlder)
                .instantTooltip("The next \(HubTimelineModel.pageSize) older events of this range")
                if timeline.loadingOlder {
                    ProgressView().controlSize(.small)
                } else if let failure = timeline.olderError {
                    Label(failure, systemImage: "exclamationmark.triangle.fill")
                        .font(.system(size: 11))
                        .foregroundColor(ReviewPalette.removed)
                        .lineLimit(2)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                }
                if !timeline.truncated.isEmpty {
                    Text("A page ends where its busiest source stopped reading: \(timeline.truncated.joined(separator: ", ")).")
                        .font(.system(size: 10.5))
                        .foregroundColor(ReviewPalette.dim)
                        .lineLimit(2)
                }
            } else if !timeline.events.isEmpty {
                Text("Everything in this range is shown (\(timeline.events.count) events, \(shown) after the filters).")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            }
            Spacer()
        }
        .padding(.horizontal, 20)
        .padding(.top, 14)
    }

    private func header(count: Int) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "clock.arrow.circlepath").foregroundColor(ReviewPalette.renamed)
            Text(timeline.range.title).font(.system(size: 14, weight: .semibold))
            if let since = timeline.since {
                Text(verbatim: "\(Self.rangeFormat.string(from: since)) → \(timeline.until.map(Self.rangeFormat.string(from:)) ?? "now")")
                    .font(.system(size: 11.5))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
            }
            Text(verbatim: "\(count) events")
                .font(.system(size: 12))
                .foregroundColor(ReviewPalette.dim)
            Spacer()
            if let notice = model.notice {
                NoticePill(text: notice, isError: notice.contains("failed") || notice.hasPrefix("No ")) { model.notice = nil }
            }
            if !timeline.warnings.isEmpty {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(ReviewPalette.modified)
                    .instantTooltip(timeline.warnings.joined(separator: "\n"))
            }
            if timeline.loading {
                ProgressView().controlSize(.small)
            } else if let loadedAt = timeline.loadedAt {
                Text("read \(HubFormat.ago(loadedAt))")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
            }
            IconButton(systemName: "arrow.clockwise", tooltip: "Read the activity again (skips the page cache)") {
                timeline.load(fresh: true)
            }
        }
        .padding(.horizontal, 18)
        .frame(height: 44)
        .hubSurface(.bar)
    }
}

// MARK: - Row

struct TimelineRowView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var timeline: HubTimelineModel
    let event: TimelineEvent
    @State private var popover: TimelinePopover?
    @State private var hovering = false

    private static let timeFormat: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    /// What ⌘F searches in a row: the texts the row shows, under the keys its FindTexts use, plus
    /// the texts of its folded-open detail while it is open (nothing of a closed one).
    static func searchable(_ event: TimelineEvent, detail: TimelineDetail?) -> PanelFindRow {
        // In drawing order; the branch shows on every kind but a push (its title already names it).
        let own = [
            PanelFindField("project", event.project ?? ""),
            PanelFindField("title", event.title),
            PanelFindField("detail", event.detail ?? ""),
            PanelFindField("branch", event.timelineKind == .push ? "" : event.branch ?? ""),
            PanelFindField("author", event.author ?? ""),
        ]
        return PanelFindRow(id: event.id, fields: own + (detail.map(TimelineDetailFind.fields) ?? []))
    }

    private var openTooltip: String {
        switch event.timelineKind {
        case .session, .sessionStart: return "Open this session"
        case .commit: return "Show this commit's diff"
        case .push: return "Show the pushed commit's diff"
        case .pr, .ci, .thread: return "Open this PR in the hub"
        case .decision: return "Open the session's Decisions pane"
        }
    }

    var body: some View {
        let kind = event.timelineKind
        let expanded = timeline.isExpanded(event)
        let actions = model.timelineActions(for: event, timeline: timeline)
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .center, spacing: 8) {
                IconButton(systemName: expanded ? "chevron.down" : "chevron.right", tooltip: expanded ? "Fold the details" : "Show the details (loaded once, on demand)", size: 10) {
                    timeline.toggle(event)
                }
                Text(verbatim: event.date.map { Self.timeFormat.string(from: $0) } ?? "")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(ReviewPalette.dim)
                    .frame(width: 36, alignment: .leading)
                Image(systemName: kind.symbol)
                    .font(.system(size: 11.5))
                    .foregroundColor(kind.color)
                    .frame(width: 16)
                    .instantTooltip(kind.title)
                if event.waitsForMe {
                    Image(systemName: "hand.raised.fill")
                        .font(.system(size: 10))
                        .foregroundColor(ReviewPalette.modified)
                        .instantTooltip("Waits for you")
                }
                if let project = event.project {
                    Button {
                        timeline.project = timeline.project == project ? nil : project
                    } label: {
                        FindText(project, field: "project")
                            .font(.system(size: 10.5, weight: .medium))
                            .foregroundColor(Color.white.opacity(0.7))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(Capsule().fill(Color.white.opacity(0.07)))
                            .lineLimit(1)
                            .fixedSize()
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip(timeline.project == project ? "Show every project again" : "Only \(project)")
                }
                Button {
                    model.openTimelineEvent(event)
                } label: {
                    FindText(event.title, field: "title")
                        .font(.system(size: 12.5))
                        .foregroundColor(Color.white.opacity(0.9))
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(openTooltip)
                if let detail = event.detail {
                    detailLabel(detail, kind: kind)
                }
                if let branch = event.branch, kind != .push {
                    branchLabel(branch)
                }
                Spacer(minLength: 6)
                if let author = event.author, kind != .session, kind != .sessionStart {
                    authorLabel(author)
                }
                Text(verbatim: HubFormat.ago(event.date))
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
                    .frame(width: 52, alignment: .trailing)
                HStack(spacing: 2) {
                    ForEach(actions) { action in
                        IconButton(systemName: action.symbol, tooltip: action.title, size: 11) { run(action) }
                            .disabled(action.disabled)
                            .opacity(action.disabled ? 0.35 : 1)
                    }
                }
                .opacity(hovering || expanded ? 1 : 0.55)
            }
            .padding(.horizontal, 8)
            .frame(minHeight: 26)
            .contentShape(Rectangle())
            .onHover { hovering = $0 }
            .background(RoundedRectangle(cornerRadius: 7).fill(hovering || expanded ? Color.white.opacity(0.05) : Color.clear))
            .contextMenu {
                Button(openTooltip) { model.openTimelineEvent(event) }
                Divider()
                ForEach(actions) { action in
                    Button(action.title) { run(action) }.disabled(action.disabled)
                }
                Divider()
                Button(expanded ? "Fold the details" : "Show the details") { timeline.toggle(event) }
                if let url = event.url {
                    Button("Copy the link") { PathOpener.copy(url) }
                }
            }
            .popover(item: $popover, arrowEdge: .bottom) { item in
                popoverContent(item)
            }
            if expanded {
                TimelineDetailView(model: model, timeline: timeline, event: event)
                    .padding(.leading, 62)
                    .padding(.trailing, 12)
                    .padding(.top, 2)
                    .padding(.bottom, 8)
            }
        }
    }

    /// The detail text. For a PR, comment or CI row it opens the host page; for a commit, its commit page.
    @ViewBuilder
    private func detailLabel(_ detail: String, kind: TimelineKind) -> some View {
        let text = FindText(detail, field: "detail")
            .font(.system(size: 11, design: kind == .commit || kind == .push ? .monospaced : .default))
            .foregroundColor(ReviewPalette.dim)
            .lineLimit(1)
            .truncationMode(.middle)
        if kind == .pr || kind == .ci || kind == .thread || kind == .commit {
            Button {
                if let url = model.timelineHostURL(event) {
                    ExternalOpener.open(url)
                } else {
                    model.notice = "The repository's origin is not known yet; try again in a moment."
                }
            } label: {
                text
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(kind == .commit ? "Open the commit on the host" : "Open \(event.pr?.ref ?? "the PR") on the host")
            .layoutPriority(-1)
        } else {
            text.layoutPriority(-1)
        }
    }

    /// The branch a session or commit row belongs to, linked to its host page when the origin is known.
    private func branchLabel(_ branch: String) -> some View {
        let url = event.repo.flatMap { RepoFactsStore.shared.facts(for: $0)?.forge?.branch(branch) }
        return ExternalLink(text: branch, url: url, font: .system(size: 10.5, design: .monospaced), glyph: .onHover, tooltip: "Branch \(branch)", findField: "branch")
            .lineLimit(1)
            .frame(maxWidth: 160, alignment: .leading)
            .layoutPriority(-1)
    }

    private func authorLabel(_ author: String) -> some View {
        let forge = event.pr == nil ? nil : event.repo.flatMap { RepoFactsStore.shared.facts(for: $0)?.forge }
        return HStack(spacing: 3) {
            Image(systemName: event.isMine ? "person.crop.circle.fill" : "person.crop.circle")
                .font(.system(size: 10))
                .foregroundColor(ReviewPalette.dim)
            if let url = forge?.user(author) {
                ExternalLink(text: author, url: url, font: .system(size: 11), glyph: .onHover, tooltip: event.isMine ? "\(author) (you)" : "\(author)'s profile", findField: "author")
            } else {
                FindText(author, field: "author")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .lineLimit(1)
            }
        }
        .instantTooltip(event.isMine ? "\(author) (you)" : author)
    }

    private func run(_ action: TimelineAction) {
        switch action.run {
        case .perform(let perform): perform()
        case .popover(let item): popover = item
        }
    }

    @ViewBuilder
    private func popoverContent(_ item: TimelinePopover) -> some View {
        switch item {
        case .resume(let session):
            LaunchPicker(mode: .resume(session)) { outcome in
                popover = nil
                if let notice = outcome.notice { model.notice = notice }
            }
        case .newAgent(let cwd, let name, let prompt):
            LaunchPicker(mode: .new(cwd: cwd, name: name, prompt: prompt)) { outcome in
                popover = nil
                if let notice = outcome.notice { model.notice = notice }
            }
        case .reply(let event):
            TimelineReplyForm(event: event, timeline: timeline) { notice in
                popover = nil
                if let notice { model.notice = notice }
            }
        }
    }
}

/// A reply to a review thread, through the Review path (PRThreadsStore → `tools hub pr reply`).
struct TimelineReplyForm: View {
    let event: TimelineEvent
    @ObservedObject var timeline: HubTimelineModel
    let done: (String?) -> Void
    @State private var text = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Reply on \(event.pr?.ref ?? "the PR") · \(event.path ?? ""):\(event.line.map(String.init) ?? "")")
                .font(.system(size: 12, weight: .semibold))
            Text(event.title)
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(2)
            TextEditor(text: $text)
                .font(.system(size: 12))
                .frame(height: 90)
                .overlay(RoundedRectangle(cornerRadius: 6).stroke(ReviewPalette.hairline))
            HStack {
                Text("Posted at once, not as a draft.")
                    .font(.system(size: 10.5))
                    .foregroundColor(ReviewPalette.dim)
                Spacer()
                Button("Cancel") { done(nil) }.keyboardShortcut(.cancelAction)
                Button("Reply") {
                    guard let url = event.pr?.url, let thread = event.threadId else {
                        done("This comment names no thread to reply in.")
                        return
                    }
                    timeline.threadStore(for: url).reply(thread: thread, body: text, draft: false)
                    done("Replying on \(event.pr?.ref ?? "the PR")…")
                }
                .keyboardShortcut(.defaultAction)
                .disabled(text.trimmed.isEmpty)
            }
        }
        .padding(12)
        .frame(width: 380)
    }
}
