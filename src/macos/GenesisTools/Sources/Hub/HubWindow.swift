import AppKit
import SwiftUI

// GenesisTools --hub [--mode sessions|worktrees] [--session <provider:id or id prefix>]
//                    [--tab transcript|changes|decisions] [--snapshot <png>]
//
// Every agent session in one window: live and recent sessions on the left (with the account each
// one is pinned to), one session on the right with its transcript, the changes in its folder
// (the review window, "Send to agent" aimed at this session) and its open decisions.

func runHub(_ args: [String]) -> Never {
    PerfLog.phase("hub.launch")
    var snapshotPath: String?
    var wantedSession: String?
    var tab = HubTab.transcript
    var mode = HubMode.sessions
    var activate = true
    var index = 0
    while index < args.count {
        let value = index + 1 < args.count ? args[index + 1] : nil
        switch args[index] {
        case "--snapshot": snapshotPath = value; index += 1
        case "--session": wantedSession = value; index += 1
        case "--tab": tab = HubTab(rawValue: value ?? "") ?? .transcript; index += 1
        case "--mode": mode = HubMode(rawValue: value ?? "") ?? .sessions; index += 1
        case "--no-activate": activate = false
        default: break
        }
        index += 1
    }

    let app = NSApplication.shared
    // A snapshot run must never become the active app: it would take the keystrokes of whoever is
    // typing (their words ended up in the hub's search field, 2026-09-24).
    app.setActivationPolicy(snapshotPath == nil ? .regular : .prohibited)
    let delegate = HubAppDelegate()
    app.delegate = delegate
    installBrowserURLForwarder()

    let model = HubModel(wantedSession: wantedSession, tab: tab)
    model.initialMode = mode
    let window = NSWindow(
        contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
        styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
        backing: .buffered,
        defer: false
    )
    window.title = "Agents"
    window.titlebarAppearsTransparent = true
    window.appearance = NSAppearance(named: .darkAqua)
    window.backgroundColor = ReviewPalette.background
    window.contentView = NSHostingView(rootView: HubRootView(model: model))
    window.center()
    window.setFrameAutosaveName("GenesisToolsHub")

    if let snapshotPath {
        model.onSettled = {
            DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                let web = (model.review?.renderer as? PierreWebDiffRenderer)?.webView
                ReviewSnapshot.write(window: window, webView: model.panes.contains(.changes) ? web : nil, to: snapshotPath) {
                    exit(0)
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 45) {
            FileHandle.standardError.write(Data("hub snapshot: not settled within 45 s\n".utf8))
            exit(1)
        }
        window.orderInForSnapshot()
    } else {
        window.makeKeyAndOrderFront(nil)
        if activate {
            app.activate(ignoringOtherApps: true)
        }
    }

    MainActor.assumeIsolated { HangWatch.start() }
    model.loadSessions()
    app.run()
    exit(0)
}

private final class HubAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }
}

/// What the left column lists: agent sessions, or the worktrees (branches) they worked in.
enum HubMode: String, CaseIterable {
    case sessions, worktrees, prs

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .worktrees: return "Worktrees"
        case .prs: return "PRs"
        }
    }
}

enum HubTab: String, CaseIterable {
    case transcript, changes, decisions

    var title: String {
        switch self {
        case .transcript: return "Transcript"
        case .changes: return "Changes"
        case .decisions: return "Decisions"
        }
    }

    /// Narrower than this, a pane's own content clips (the transcript list, the diff with its file list).
    var minPaneWidth: CGFloat {
        switch self {
        case .transcript: return 480
        case .changes: return 520
        case .decisions: return 360
        }
    }

    var idealPaneWidth: CGFloat {
        switch self {
        case .transcript: return 640
        case .changes: return 700
        case .decisions: return 440
        }
    }

    var symbol: String {
        switch self {
        case .transcript: return "text.bubble"
        case .changes: return "plusminus"
        case .decisions: return "checklist"
        }
    }
}

// MARK: - Model

final class HubModel: ObservableObject {
    static let recentHours = 72
    static let pageSize = 80

    @Published var sessions: [HubSession] = [] {
        didSet { worktreeSessions = nil }
    }
    @Published var loadingSessions = false
    @Published var error: String?
    @Published var filter = ""
    @Published var selectedID: String?
    /// The pane that was asked for last (`--tab`, "Open diff"); it is always among `panes`.
    @Published var tab: HubTab {
        didSet {
            if !panes.contains(tab) {
                panes = HubTab.allCases.filter { panes.contains($0) || $0 == tab }
            }
        }
    }
    /// The panes shown side by side (transcript, changes, decisions), saved between launches.
    @Published var panes: [HubTab] = (UserDefaults.standard.stringArray(forKey: "hub.panes") ?? ["transcript"]).compactMap(HubTab.init(rawValue:)) {
        didSet { UserDefaults.standard.set(panes.map(\.rawValue), forKey: "hub.panes") }
    }

    /// Show or hide a pane; at least one stays. `only` shows just this one (option-click).
    func togglePane(_ pane: HubTab, only: Bool = false) {
        if only {
            panes = [pane]
        } else if panes.contains(pane) {
            if panes.count > 1 {
                panes.removeAll { $0 == pane }
            }
        } else {
            panes = HubTab.allCases.filter { panes.contains($0) || $0 == pane }
        }
        if !panes.contains(tab), let first = panes.first {
            tab = first
        } else if panes.contains(pane) {
            tab = pane
        }
    }
    @Published var transcript: [TranscriptItem] = []
    @Published var transcriptLimit = HubModel.pageSize
    @Published var transcriptTruncated = false
    @Published var transcriptTotals: String?
    @Published var transcriptEnded: String?
    @Published var loadingTranscript = false
    @Published var transcriptError: String?
    @Published var expandedTools: Set<String> = []
    @Published var decisions: [HubDecision] = []
    @Published var review: ReviewModel?
    @Published var mode = HubMode.sessions
    @Published var worktrees: [HubWorktree] = [] {
        didSet { worktreeSessions = nil }
    }
    /// Sessions per worktree path, built once per change of `sessions` or `worktrees`; rows read it
    /// on every body pass, and the raw match is sessions × worktrees per row.
    private var worktreeSessions: [String: [HubSession]]?
    @Published var loadingWorktrees = false
    @Published var selectedWorktree: String?
    @Published var notice: String?

    var onSettled: (() -> Void)?
    var initialMode = HubMode.sessions
    private let wantedSession: String?
    private var transcriptGeneration = 0

    /// PRs mode state (`tools hub pr list/show`). Main-actor: created on the main thread in `runHub`.
    let prs: PRsModel

    init(wantedSession: String?, tab: HubTab) {
        prs = MainActor.assumeIsolated { PRsModel() }
        self.wantedSession = wantedSession
        self.tab = tab
        if !panes.contains(tab) {
            panes = HubTab.allCases.filter { panes.contains($0) || $0 == tab }
        }
    }

    var selected: HubSession? {
        sessions.first { $0.id == selectedID }
    }

    var filtered: [HubSession] {
        let needle = filter.trimmed.lowercased()
        guard !needle.isEmpty else { return sessions }
        return sessions.filter {
            [$0.displayTitle, $0.project ?? "", $0.account ?? "", $0.provider, $0.sessionId, $0.cwd]
                .joined(separator: " ").lowercased().contains(needle)
        }
    }

    func setMode(_ next: HubMode) {
        mode = next
        if next == .prs {
            // One path per project; worktrees and clones of one origin collapse server-side.
            let roots = Array(Set(sessions.map(\.cwd).filter { !$0.isEmpty && FileManager.default.fileExists(atPath: $0) }.map(projectRoot(of:)))).sorted()
            MainActor.assumeIsolated {
                if prs.prs.isEmpty {
                    prs.load(paths: roots)
                }
            }
        }
        if next == .worktrees && worktrees.isEmpty && !loadingWorktrees {
            loadingWorktrees = true
            let sessions = sessions
            DispatchQueue.global(qos: .userInitiated).async {
                let span = HubPerf.begin("worktrees.discover", "\(sessions.count) sessions")
                let found = WorktreeDiscovery.discover(sessions: sessions)
                span.end("\(found.count) worktrees")
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    self.worktrees = found
                    self.loadingWorktrees = false
                    if self.selectedWorktree == nil,
                       let busiest = found.max(by: { self.sessionCount(for: $0) < self.sessionCount(for: $1) }) {
                        self.selectWorktree(busiest)
                    }
                    self.onSettled?()
                    self.onSettled = nil
                }
            }
        }
    }

    func sessions(for worktree: HubWorktree) -> [HubSession] {
        if worktreeSessions == nil {
            worktreeSessions = HubPerf.measure("worktrees.map", "\(sessions.count) sessions \(worktrees.count) worktrees") {
                WorktreeDiscovery.sessionsByWorktree(sessions, worktrees: worktrees)
            }
        }
        return worktreeSessions?[worktree.path] ?? []
    }

    func sessionCount(for worktree: HubWorktree) -> Int {
        sessions(for: worktree).count
    }

    func selectWorktree(_ worktree: HubWorktree) {
        selectedWorktree = worktree.path
        notice = nil
        if review?.repo.path != worktree.path {
            let next = ReviewModel(repo: URL(fileURLWithPath: worktree.path), options: DiffViewOptions(), session: sessions(for: worktree).first?.sessionId)
            next.embedded = true
            next.scope = worktree.isMain ? .uncommitted : .branch
            review = next
        }
    }

    /// A transcript tool row's "Open diff": the Changes tab, scrolled to that file.
    func showChange(path: String, line: Int?) {
        tab = .changes
        guard let review else {
            notice = "This session's folder is not on this Mac."
            return
        }
        let root = review.repo.path + "/"
        review.reveal(path: path.hasPrefix(root) ? String(path.dropFirst(root.count)) : path)
    }

    func openSession(_ session: HubSession) {
        mode = .sessions
        select(session.id)
    }

    func resume(_ session: HubSession) -> String {
        guard let command = AgentLauncher.resumeCommand(for: session) else {
            return "No resume command for \(session.provider)."
        }

        return AgentLauncher.openInTerminal(name: session.displayTitle, cwd: session.cwd, command: command)
            ?? "Resuming \(session.displayTitle) in a new cmux workspace."
    }

    func newSession(in worktree: HubWorktree) -> String {
        AgentLauncher.openInTerminal(name: worktree.branch, cwd: worktree.path, command: ["tools", "claude", "run"])
            ?? "Started a new Claude session in \(worktree.name)."
    }

    @MainActor
    func exportWorktree(_ worktree: HubWorktree) async -> String {
        let files = (review?.files ?? []).map { ["path": $0.path, "status": $0.status.rawValue, "added": $0.additions, "removed": $0.deletions] as [String: Any] }
        let touching = sessions(for: worktree).map {
            ["provider": $0.provider, "title": $0.displayTitle, "account": $0.account ?? "", "last activity": HubFormat.ago($0.lastActivity), "id": $0.sessionId] as [String: Any]
        }
        let payload: [String: Any] = [
            "worktree": ["branch": worktree.branch, "repo": worktree.repo, "path": worktree.path, "scope": review?.scope.title ?? ""],
            "changed files": files,
            "sessions": touching,
        ]
        return await HubMarkdownExport.export(title: "\(worktree.repo) · \(worktree.branch)", payload: payload, fileStem: "worktree-\(worktree.name)")
    }

    @MainActor
    func exportSession(_ session: HubSession) async -> String {
        var turns: [[String: Any]] = []
        for item in transcript.suffix(12) {
            switch item {
            case .user(let turn): turns.append(["who": "You", "text": String(turn.text.prefix(600))])
            case .assistant(let turn): turns.append(["who": "Agent", "text": String(turn.text.prefix(600))])
            case .work(_, _, let tools): turns.append(["who": "Tools", "text": summarizeGroup(tools)])
            }
        }
        let payload: [String: Any] = [
            "session": [
                "title": session.displayTitle, "provider": session.provider, "account": session.account ?? "",
                "model": session.model ?? "", "folder": session.cwd, "id": session.sessionId,
                "last activity": HubFormat.ago(session.lastActivity), "tokens": transcriptTotals ?? "",
            ],
            "changed files": (review?.files ?? []).map { ["path": $0.path, "added": $0.additions, "removed": $0.deletions] as [String: Any] },
            "decisions": decisions.map { ["number": $0.number, "title": $0.title, "status": $0.status, "answer": $0.draftOption ?? ""] as [String: Any] },
            "recent turns": turns,
        ]
        return await HubMarkdownExport.export(title: session.displayTitle, payload: payload, fileStem: "session-\(session.sessionId.prefix(8))")
    }

    func loadSessions() {
        loadingSessions = true
        Task { @MainActor in
            do {
                let rows = try await HubSource.sessions(hours: Self.recentHours)
                PerfLog.markOnce("hub.sessions.first-loaded")
                loadingSessions = false
                sessions = rows
                    .filter { !($0.archived ?? false) }
                    .sorted { $0.mtime > $1.mtime }
                let wanted = wantedSession.flatMap { wanted in
                    sessions.first { $0.id == wanted || $0.sessionId.hasPrefix(wanted) }
                }
                if initialMode == .worktrees {
                    if let first = sessions.first {
                        selectedID = first.id
                    }
                    setMode(.worktrees)
                } else if initialMode == .prs {
                    MainActor.assumeIsolated {
                        prs.onLoaded = { [weak self] in
                            self?.onSettled?()
                            self?.onSettled = nil
                        }
                    }
                    setMode(.prs)
                } else if let first = wanted ?? sessions.first {
                    select(first.id)
                } else {
                    onSettled?()
                }
            } catch {
                loadingSessions = false
                self.error = "\(error)"
                onSettled?()
            }
        }
    }

    func select(_ id: String) {
        guard id != selectedID || transcript.isEmpty else { return }
        selectedID = id
        transcript = []
        transcriptLimit = Self.pageSize
        transcriptTotals = nil
        transcriptEnded = nil
        transcriptError = nil
        expandedTools = []
        guard let session = selected else { return }
        // No decision source is wired to sessions yet: an empty list, never made-up decisions.
        decisions = []
        let cwd = session.cwd
        if !cwd.isEmpty, FileManager.default.fileExists(atPath: cwd) {
            // The session too: two agents in one checkout share the folder, and "Send to agent" targets `review.session`.
            if review?.repo.path != cwd || review?.session != session.sessionId {
                review = ReviewModel(repo: URL(fileURLWithPath: cwd), options: DiffViewOptions(), session: session.sessionId)
                review?.embedded = true
            }
        } else {
            review = nil
        }
        loadTranscript(older: false)
    }

    func loadTranscript(older: Bool) {
        guard let session = selected else { return }
        transcriptGeneration += 1
        let generation = transcriptGeneration
        loadingTranscript = true
        if older {
            transcriptLimit += Self.pageSize
        }

        let limit = transcriptLimit
        Task { @MainActor in
            do {
                let envelope = try await HubSource.transcript(session, limit: limit)
                guard generation == transcriptGeneration else { return }
                transcript = HubPerf.measure("transcript.timeline", "\(envelope.turns.count) turns") {
                    TranscriptTimeline.build(envelope.turns)
                }
                transcriptTruncated = envelope.truncated
                transcriptTotals = envelope.totals?.summary
                transcriptEnded = envelope.terminated
                transcriptError = nil
            } catch {
                guard generation == transcriptGeneration else { return }
                transcriptError = "\(error)"
            }
            loadingTranscript = false
            onSettled?()
            onSettled = nil
        }
    }
}

// MARK: - Views

struct HubRootView: View {
    @ObservedObject var model: HubModel

    var body: some View {
        HStack(spacing: 0) {
            ResizableSidePanel(key: "hub.sidebar", edge: .leading, defaultWidth: 320) {
                SessionListView(model: model)
            }
            if model.mode == .prs {
                PRsMain(model: model, prs: model.prs)
            } else if model.mode == .worktrees {
                if let path = model.selectedWorktree, let worktree = model.worktrees.first(where: { $0.path == path }) {
                    WorktreeDetailView(model: model, worktree: worktree)
                } else {
                    Text(model.loadingWorktrees ? "Finding worktrees…" : "Pick a worktree")
                        .foregroundColor(ReviewPalette.dim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if let session = model.selected {
                SessionDetailView(model: model, session: session)
            } else {
                VStack(spacing: 8) {
                    if model.loadingSessions {
                        ProgressView()
                        Text("Loading sessions…").foregroundColor(ReviewPalette.dim)
                    } else {
                        Text(model.error ?? "No sessions in the last \(HubModel.recentHours) hours")
                            .foregroundColor(ReviewPalette.dim)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Color(nsColor: ReviewPalette.background))
        .preferredColorScheme(.dark)
    }
}

/// How the session list is grouped. Project groups can be pinned, folded and reordered.
enum SessionGrouping: String, CaseIterable {
    case time, project, harness, projectHarness

    var title: String {
        switch self {
        case .time: return "By activity"
        case .project: return "By project"
        case .harness: return "By harness"
        case .projectHarness: return "By project and harness"
        }
    }
}

private struct SessionListView: View {
    @ObservedObject var model: HubModel
    @AppStorage("hub.sessions.grouping") private var grouping = SessionGrouping.time.rawValue
    @StateObject private var prefs = GroupPrefs(key: "sessions.groups")

    private var mode: SessionGrouping { SessionGrouping(rawValue: grouping) ?? .time }

    private func projectName(_ session: HubSession) -> String {
        if let project = session.project, !project.isEmpty { return project }
        return session.cwd.isEmpty ? "No folder" : (session.cwd as NSString).lastPathComponent
    }

    private var sections: [(title: String, rows: [HubSession], managed: Bool)] {
        let rows = model.filtered
        switch mode {
        case .time:
            let live = rows.filter(\.isLive)
            let today = rows.filter { !$0.isLive && Calendar.current.isDateInToday($0.lastActivity ?? .distantPast) }
            let earlier = rows.filter { !$0.isLive && !Calendar.current.isDateInToday($0.lastActivity ?? .distantPast) }
            return [("Live", live, false), ("Today", today, false), ("Earlier", earlier, false)].filter { !$0.rows.isEmpty }
        case .project, .harness, .projectHarness:
            let key: (HubSession) -> String = { session in
                switch mode {
                case .project: return projectName(session)
                case .harness: return AIProviders.meta(for: session.provider).displayName
                default: return "\(projectName(session)) · \(AIProviders.meta(for: session.provider).displayName)"
                }
            }
            let grouped = Dictionary(grouping: rows, by: key)
            return prefs.sorted(Array(grouped.keys)).map { ($0, grouped[$0] ?? [], true) }
        }
    }

    var body: some View {
        let sections = sections
        VStack(spacing: 0) {
            Picker("", selection: Binding(get: { model.mode }, set: { model.setMode($0) })) {
                ForEach(HubMode.allCases, id: \.self) { mode in
                    Text(mode.title).tag(mode)
                }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 10)
            .padding(.top, 40)
            .instantTooltip("Agent sessions, or the worktrees they work in")
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundColor(ReviewPalette.dim)
                TextField(model.mode == .sessions ? "Filter sessions, projects, accounts…" : "Filter repos, branches…", text: $model.filter)
                    .textFieldStyle(.plain)
                if model.loadingSessions {
                    ProgressView().controlSize(.small)
                }
                if model.mode == .sessions {
                    Menu {
                        ForEach(SessionGrouping.allCases, id: \.self) { option in
                            Button {
                                grouping = option.rawValue
                            } label: {
                                if option == mode { Label(option.title, systemImage: "checkmark") } else { Text(option.title) }
                            }
                        }
                    } label: {
                        Image(systemName: "rectangle.3.group")
                    }
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .fixedSize()
                    .instantTooltip("Group sessions: \(mode.title.lowercased())")
                }
            }
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .padding(.bottom, 8)

            if model.mode == .worktrees {
                WorktreeListView(model: model)
            } else if model.mode == .prs {
                PRListView(model: model, prs: model.prs)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                        ForEach(sections, id: \.title) { section in
                            Section {
                                if !(section.managed && prefs.collapsed.contains(section.title)) {
                                    ForEach(section.rows) { session in
                                        SessionRowView(session: session, selected: session.id == model.selectedID)
                                            .rowButton { model.select(session.id) }
                                    }
                                }
                            } header: {
                                if section.managed {
                                    GroupHeader(
                                        title: section.title,
                                        count: section.rows.count,
                                        prefs: prefs,
                                        allNames: sections.map(\.title),
                                        path: mode == .harness ? nil : section.rows.first.map { projectRoot(of: $0.cwd) }.flatMap { $0.isEmpty ? nil : $0 }
                                    )
                                } else {
                                    HStack {
                                        Text(section.title)
                                        Spacer()
                                        Text(verbatim: "\(section.rows.count)").font(.system(size: 10.5, design: .monospaced))
                                    }
                                    .font(.system(size: 11.5, weight: .semibold))
                                    .foregroundColor(ReviewPalette.dim)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 6)
                                    .background(ReviewPalette.sidebar)
                                }
                            }
                        }
                    }
                    .padding(.bottom, 12)
                }
            }
        }
        .background(ReviewPalette.sidebar)
    }
}

private struct ProviderBadge: View {
    let provider: String

    var body: some View {
        let (letter, color): (String, Color) = {
            switch provider {
            case "claude": return ("C", Color(red: 0.85, green: 0.47, blue: 0.34))
            case "codex": return ("X", Color(red: 0.55, green: 0.75, blue: 0.95))
            case "grok": return ("G", Color(red: 0.75, green: 0.75, blue: 0.78))
            default: return (String(provider.prefix(1)).uppercased(), ReviewPalette.dim)
            }
        }()
        Text(letter)
            .font(.system(size: 10, weight: .bold, design: .rounded))
            .foregroundColor(.black.opacity(0.8))
            .frame(width: 18, height: 18)
            .background(RoundedRectangle(cornerRadius: 5).fill(color))
            .instantTooltip(provider)
    }
}

private struct SessionRowView: View {
    let session: HubSession
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            ZStack(alignment: .bottomTrailing) {
                ProviderBadge(provider: session.provider)
                if session.isLive {
                    Circle()
                        .fill(ReviewPalette.added)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().stroke(ReviewPalette.sidebar, lineWidth: 1.5))
                        .offset(x: 3, y: 3)
                }
            }
            .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(session.displayTitle)
                    .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let project = session.project {
                        Text(project)
                    }
                    if let account = session.account {
                        Text(account)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().stroke(Color.white.opacity(0.15)))
                    }
                    Spacer(minLength: 0)
                    Text(HubFormat.ago(session.lastActivity))
                }
                .font(.system(size: 10.5))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.white.opacity(0.08) : Color.clear)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : Color.clear))
        )
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
    }
}

private struct SessionDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var repos = RepoFactsStore.shared
    let session: HubSession

    var body: some View {
        VStack(spacing: 0) {
            header
            let visible = HubTab.allCases.filter { model.panes.contains($0) }
            if visible.count == 1, let only = visible.first {
                pane(only)
            } else {
                HSplitView {
                    ForEach(visible, id: \.self) { tab in
                        pane(tab).frame(minWidth: tab.minPaneWidth, idealWidth: tab.idealPaneWidth, maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func pane(_ tab: HubTab) -> some View {
        switch tab {
        case .transcript:
            HubSessionDetailHost(session: session, onShowChange: { path, line in
                model.showChange(path: path, line: line)
            }, showsSidebar: model.panes.count == 1)
                .id("\(session.id)|\(model.panes.count == 1)")
        case .changes:
            if let review = model.review {
                ReviewRootView(model: review)
            } else {
                Text("This session's folder is not on this Mac.")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        case .decisions:
            DecisionsView(model: model)
        }
    }

    private var paneToggles: some View {
        HStack(spacing: 2) {
            ForEach(HubTab.allCases, id: \.self) { tab in
                let open = model.panes.contains(tab)
                Button {
                    model.togglePane(tab, only: NSEvent.modifierFlags.contains(.option))
                } label: {
                    HStack(spacing: 5) {
                        Image(systemName: tab.symbol).font(.system(size: 11))
                        Text(tab.title).font(.system(size: 12, weight: open ? .semibold : .regular))
                    }
                    .foregroundColor(open ? Color.white : ReviewPalette.dim)
                    .padding(.horizontal, 9)
                    .frame(height: 24)
                    .background(RoundedRectangle(cornerRadius: 6).fill(open ? Color.white.opacity(0.14) : Color.clear))
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(open ? "Hide the \(tab.title) pane (option-click: show only this one)" : "Show the \(tab.title) pane beside the others (option-click: only this one)")
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                if !model.panes.contains(.transcript) {
                    ProviderBadge(provider: session.provider)
                    Text(session.displayTitle)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                    Circle()
                        .fill(session.isLive ? ReviewPalette.added : Color.white.opacity(0.25))
                        .frame(width: 7, height: 7)
                    Text(session.isLive ? "live" : "idle · \(HubFormat.ago(session.lastActivity))")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
                Spacer()
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.hasPrefix("cmux:") || notice.contains("failed")) { model.notice = nil }
                }
                paneToggles
                IconButton(systemName: "doc.richtext", tooltip: "Copy as Markdown (json2md): session, changes, decisions, recent turns") {
                    Task { @MainActor in model.notice = await model.exportSession(session) }
                }
            }
            if !model.panes.contains(.transcript) {
                HStack(spacing: 8) {
                    chip("person.crop.circle", session.account ?? "no pin")
                    if let sessionModel = session.model {
                        chip("cpu", sessionModel)
                    }
                    if !session.cwd.isEmpty {
                        PathLabel(path: session.cwd)
                        if let branch = HubSessionDetailHost.branch(of: session.cwd) {
                            let facts = repos.facts(for: session.cwd, pr: true)
                            ExternalLink(text: branch, url: facts?.branchURL, font: .system(size: 11))
                            PullRequestLink(facts: facts)
                        }
                    }
                    if let totals = model.transcriptTotals {
                        chip("sum", totals)
                    }
                    Button {
                        PathOpener.copy(session.sessionId)
                        model.notice = "Session id copied"
                    } label: {
                        chip("number", String(session.sessionId.prefix(8)))
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Copy the full session id")
                    Spacer()
                }
            }
        }
        .padding(.leading, 18)
        .padding(.trailing, 14)
        .padding(.top, model.panes.contains(.transcript) ? 8 : 34)
        .padding(.bottom, model.panes.contains(.transcript) ? 6 : 10)
        .overlay(Rectangle().fill(ReviewPalette.hairline).frame(height: 1), alignment: .bottom)
    }

    private func chip(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
            Text(text).lineLimit(1).truncationMode(.middle)
        }
        .font(.system(size: 11))
        .foregroundColor(Color.white.opacity(0.7))
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.05)))
    }
}

// MARK: - Decisions

private struct DecisionsView: View {
    @ObservedObject var model: HubModel
    @AppStorage("hub.decisions.filter") private var filter = "open"
    @State private var sending = false

    private var ready: [HubDecision] {
        model.decisions.filter { $0.status == "waiting" && ($0.draftOption != nil || !$0.draftText.trimmed.isEmpty) }
    }

    private var shown: [Binding<HubDecision>] {
        $model.decisions
            .filter { binding in
                let decision = binding.wrappedValue
                switch filter {
                case "open": return decision.status == "waiting"
                case "answered": return decision.status != "waiting"
                default: return true
                }
            }
            .sorted { lhs, rhs in
                let left = lhs.wrappedValue
                let right = rhs.wrappedValue
                if left.blocking != right.blocking { return left.blocking }
                return left.createdAt < right.createdAt
            }
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                toolbar
                if shown.isEmpty {
                    Text(model.decisions.isEmpty ? "No decisions recorded for this session." : filter == "open" ? "No open decisions." : "Nothing here.")
                        .font(.system(size: 12.5))
                        .foregroundColor(ReviewPalette.dim)
                        .frame(maxWidth: .infinity)
                        .padding(.top, 30)
                }
                ForEach(shown) { $decision in
                    DecisionCard(decision: $decision, cwd: model.selected?.cwd)
                }
            }
            .padding(18)
        }
    }

    private var toolbar: some View {
        HStack(spacing: 10) {
            Picker("", selection: $filter) {
                Text("Open").tag("open")
                Text("Answered").tag("answered")
                Text("All").tag("all")
            }
            .pickerStyle(.segmented)
            .frame(width: 210)
            .instantTooltip("Which decisions to show")
            Text("Mock data until question_post type \"decision\" lands (h_wjwlim7x)")
                .font(.system(size: 11))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            Spacer()
            Button {
                send()
            } label: {
                Label(ready.isEmpty ? "Send answers" : "Send \(ready.count) answer\(ready.count == 1 ? "" : "s")", systemImage: "paperplane.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(ready.isEmpty ? ReviewPalette.dim : Color.black)
                    .padding(.horizontal, 12)
                    .frame(height: 28)
                    .background(RoundedRectangle(cornerRadius: 8).fill(ready.isEmpty ? Color.white.opacity(0.06) : Color(red: 1, green: 0.63, blue: 0.12)))
            }
            .buttonStyle(.genHoverPlain())
            .disabled(ready.isEmpty || sending || model.selected == nil)
            .instantTooltip("Type every drafted answer into the agent's pane as one line (\(TerminalHosts.current.name))")
        }
    }

    /// One line, e.g. `Answers: DECISION 5 c) keep it swappable; DECISION 6 a)`. One line so nothing
    /// multi-line is typed into the agent's prompt.
    private func send() {
        guard let session = model.selected else { return }
        let line = "Answers: " + ready.map(\.answerLine).joined(separator: "; ")
        let ids = Set(ready.map(\.id))
        sending = true
        Task {
            let error = await Task.detached(priority: .userInitiated) {
                TerminalHosts.current.send(sessionId: session.sessionId, text: line)
            }.value
            sending = false
            if let error {
                PathOpener.copy(line)
                model.notice = "Send failed (\(error.prefix(80))); the answers are on the clipboard"
            } else {
                for index in model.decisions.indices where ids.contains(model.decisions[index].id) {
                    model.decisions[index].status = "sent"
                }
                model.notice = "Sent \(ids.count) answer\(ids.count == 1 ? "" : "s")"
            }
        }
    }
}

extension HubDecision {
    /// `DECISION 5 c) note`, the way answers are written back to an agent.
    var answerLine: String {
        var parts = ["DECISION \(number)"]
        if let option = draftOption {
            parts.append("\(option))")
        }
        let note = draftText.trimmed.replacingOccurrences(of: "\n", with: " ")
        if !note.isEmpty {
            parts.append(note)
        }
        return parts.joined(separator: " ")
    }
}

private struct DecisionCard: View {
    @Binding var decision: HubDecision
    let cwd: String?
    @State private var expanded = false

    private let accent = Color(red: 1, green: 0.63, blue: 0.12)

    private var ageMinutes: Int {
        Int(Date().timeIntervalSince(decision.createdAt) / 60)
    }

    private var answered: Bool { decision.status != "waiting" }

    private var drafted: Bool { decision.draftOption != nil || !decision.draftText.trimmed.isEmpty }

    private var ageColor: Color {
        ageMinutes >= 120 ? ReviewPalette.removed : ageMinutes >= 30 ? ReviewPalette.modified : ReviewPalette.dim
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            header
            if !answered || expanded {
                content
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.white.opacity(answered ? 0.025 : 0.045)))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(borderColor, lineWidth: drafted && !answered ? 1.5 : 1))
    }

    private var borderColor: Color {
        if answered { return ReviewPalette.added.opacity(0.35) }
        if drafted { return accent.opacity(0.7) }
        return ageColor.opacity(0.35)
    }

    private var header: some View {
        Button {
            if answered {
                expanded.toggle()
            }
        } label: {
            HStack(spacing: 8) {
                Text(verbatim: "\(decision.number)")
                    .font(.system(size: 11, weight: .heavy, design: .monospaced))
                    .foregroundColor(.black)
                    .frame(minWidth: 20, minHeight: 20)
                    .background(RoundedRectangle(cornerRadius: 5).fill(answered ? ReviewPalette.added : accent))
                Text(decision.title)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundColor(Color.white.opacity(answered ? 0.7 : 0.95))
                    .lineLimit(answered && !expanded ? 1 : 2)
                if decision.blocking && !answered {
                    Tag(text: "blocking", color: ReviewPalette.removed)
                }
                if answered, !expanded {
                    Text(verbatim: decision.answerLine.replacingOccurrences(of: "DECISION \(decision.number) ", with: "→ "))
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundColor(ReviewPalette.added)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                if let confidence = decision.confidence {
                    Text(verbatim: "[\(confidence)%]")
                        .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
                        .foregroundColor(ReviewPalette.dim)
                        .instantTooltip(decision.confidenceProof ?? "The agent's confidence in its proposal")
                }
                if answered {
                    Label(decision.status, systemImage: "checkmark.circle.fill")
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.added)
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(ReviewPalette.dim)
                        .rotationEffect(.degrees(expanded ? 90 : 0))
                } else if drafted {
                    Tag(text: "ready to send", color: accent)
                } else {
                    Label("waiting \(ageMinutes) min", systemImage: "clock")
                        .font(.system(size: 11.5))
                        .foregroundColor(ageColor)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(!answered)
    }

    @ViewBuilder
    private var content: some View {
        Text(decision.question)
            .font(.system(size: 13))
            .foregroundColor(Color.white.opacity(0.85))
            .textSelection(.enabled)
        if let proposal = decision.proposal {
            HStack(alignment: .top, spacing: 7) {
                Image(systemName: "lightbulb").foregroundColor(accent.opacity(0.9))
                Text(proposal).italic()
            }
            .font(.system(size: 12.5))
            .foregroundColor(Color.white.opacity(0.8))
        }
        VStack(alignment: .leading, spacing: 4) {
            ForEach(decision.options) { option in
                optionRow(option)
            }
        }
        if let reasoning = decision.reasoning {
            DisclosureGroup {
                Text(reasoning)
                    .font(.system(size: 12))
                    .foregroundColor(Color.white.opacity(0.75))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
            } label: {
                Text("Reasoning").font(.system(size: 12, weight: .medium)).foregroundColor(ReviewPalette.dim)
            }
        }
        ForEach(decision.refs) { ref in
            refView(ref)
        }
        TextField(decision.draftOption == nil ? "Answer in your own words…" : "Add a note to \(decision.draftOption!))…", text: $decision.draftText, axis: .vertical)
            .textFieldStyle(.plain)
            .font(.system(size: 12.5))
            .lineLimit(1...6)
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).stroke(Color.white.opacity(0.12)))
        HStack(spacing: 8) {
            if drafted {
                Text(verbatim: decision.answerLine)
                    .font(.system(size: 11.5, design: .monospaced))
                    .foregroundColor(accent)
                    .lineLimit(1)
                    .instantTooltip("What will be sent")
            }
            Spacer()
            IconButton(systemName: "doc.on.doc", tooltip: "Copy this answer") {
                PathOpener.copy(decision.answerLine)
            }
            .disabled(!drafted)
            IconButton(systemName: "arrow.uturn.backward", tooltip: "Clear the choice and the note") {
                decision.draftOption = nil
                decision.draftText = ""
            }
            .disabled(!drafted)
            if answered {
                IconButton(systemName: "arrow.counterclockwise", tooltip: "Reopen: answer it again") {
                    decision.status = "waiting"
                }
            }
        }
    }

    private func optionRow(_ option: HubDecision.Option) -> some View {
        let chosen = decision.draftOption == option.id
        return Button {
            // A second click on the chosen option unselects it.
            decision.draftOption = chosen ? nil : option.id
        } label: {
            HStack(alignment: .top, spacing: 9) {
                Text(verbatim: "\(option.id))")
                    .font(.system(size: 12.5, weight: .bold, design: .monospaced))
                    .foregroundColor(chosen ? .black : Color.white.opacity(0.8))
                    .frame(width: 26, height: 21)
                    .background(RoundedRectangle(cornerRadius: 5).fill(chosen ? accent : Color.white.opacity(0.07)))
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(option.label).font(.system(size: 12.5, weight: .medium)).foregroundColor(Color.white.opacity(0.92))
                        if decision.recommended == option.id {
                            Tag(text: "recommended", color: ReviewPalette.added)
                        }
                    }
                    if let detail = option.detail {
                        Text(detail).font(.system(size: 11.5)).foregroundColor(ReviewPalette.dim)
                    }
                }
                Spacer(minLength: 0)
                if chosen {
                    Image(systemName: "checkmark").font(.system(size: 11, weight: .bold)).foregroundColor(accent)
                }
            }
            .padding(.vertical, 5)
            .padding(.horizontal, 7)
            .background(RoundedRectangle(cornerRadius: 8).fill(chosen ? accent.opacity(0.12) : Color.clear))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(chosen ? accent.opacity(0.6) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 8))
        .instantTooltip(chosen ? "Click again to unselect" : "Choose \(option.id))")
    }

    private func refView(_ ref: HubDecision.Ref) -> some View {
        let absolute = ref.path.hasPrefix("/") ? ref.path : cwd.map { projectRoot(of: $0) + "/" + ref.path } ?? ref.path
        return VStack(alignment: .leading, spacing: 4) {
            Button { PathOpener.cursor(absolute, line: ref.line) } label: {
                Text(verbatim: "\(ref.path):\(ref.line)")
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundColor(Color(red: 0.55, green: 0.7, blue: 1))
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Open \(ref.path) at line \(ref.line) in Cursor")
            Text(ref.excerpt)
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundColor(Color.white.opacity(0.8))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.black.opacity(0.35)))
        }
    }
}

private struct Tag: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 10, weight: .semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 1)
            .background(Capsule().fill(color.opacity(0.18)))
            .foregroundColor(color)
    }
}
