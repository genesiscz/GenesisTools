import AppKit
import Combine
import SwiftUI

// GenesisTools --hub [--mode sessions|worktrees|prs] [--session <provider:id or id prefix>] [--pr <n>]
//                    [--tab transcript|changes|files|decisions] [--no-activate] [--snapshot <png>]
//                    [--bench <json>] [--panes transcript,changes,…] [--width <pt>] [--glass on|off]
//                    [--file <repo-relative path>] [--height <pt>] [--style split|unified]
//                    [--worktree <path>|cleanup|cleanup-blocked] [--set <key>=true|false]
//                    [--panel-find <scope>:<text>] [--panel-find-next <n>] (Hub/HubPanelFind.swift)
//                    [--timeline-open <event id>] [--timeline-action <action id>] (Hub/HubTimeline.swift)
// (`tools hub` builds the app when needed and runs this; a second launch goes to the running hub.)
// `--snapshot` and `--bench` run off screen on a scratch copy of the hub's settings (HubDefaults).
//
// Every agent session in one window: live and recent sessions on the left (with the account each
// one is pinned to), one session on the right with its transcript, the changes in its folder
// (the review window, "Send to agent" aimed at this session) and its open decisions.

/// The `--hub` arguments. A launch while a hub runs hands the same list to that hub
/// (Hub/HubSingleInstance.swift), so both paths parse it here.
struct HubRequest {
    var snapshotPath: String?
    var benchPath: String?
    var session: String?
    var pr: HubPRRef?
    var tab: HubTab?
    var mode: HubMode?
    var panes: [HubTab]?
    var width: CGFloat?
    var height: CGFloat?
    /// A snapshot shows the diff split or unified (`--style`), whatever the live window uses.
    var style: DiffViewOptions.Style?
    var glass: Bool?
    /// A snapshot opens this file of the diff (repo-relative path) before it captures.
    var file: String?
    /// The session list's filter (which also searches history), `--filter <text>`.
    var filter: String?
    /// Opens the command palette with this text, `--palette <text>`.
    var palette: String?
    /// Opens find in files with this query, `--find <text>`.
    var find: String?
    /// Opens the session's transcript with this search applied (whole session), `--transcript-query`.
    var transcriptQuery: String?
    /// Opens the transcript search over every session with this text (`--session-search [text]`) and
    /// the Today digest (`--digest`), Hub/HubDaily.swift.
    var sessionSearch: String?
    var digest = false
    /// Selects this worktree path in the Worktrees mode, or the cleanup panel (`--worktree cleanup`).
    var worktree: String?
    /// Inbox mode: opens the resume dialog (`--inbox-resume <id>`) or the session info popover
    /// (`--inbox-info <id>`) for this session (id or prefix) once the list has loaded; for snapshots.
    var inboxResume: String?
    var inboxInfo: String?
    /// Activity: runs this row's action once the feed holds it (`--timeline-open <event id>`, with
    /// `--timeline-action diff` for a review comment's "Open in the diff"), else the row's click.
    var timelineOpen: String?
    var timelineAction: String?
    /// `--set <key>=<true|false>`: a setting of the scratch copy a scripted run starts from (the PR
    /// threads list open: `--set review.prThreads.open=true`). Never written to the live settings.
    var settings: [String: Bool] = [:]
    /// `--set <key>=<text>` for any other value (`--set hub.timeline.range=last30`).
    var textSettings: [String: String] = [:]
    var activate = true

    /// Off screen, never active, on scratch settings.
    var isScripted: Bool { snapshotPath != nil || benchPath != nil }

    init(_ args: [String]) {
        var index = 0
        while index < args.count {
            let value = index + 1 < args.count ? args[index + 1] : nil
            switch args[index] {
            case "--snapshot": snapshotPath = value; index += 1
            case "--bench": benchPath = value; index += 1
            case "--session": session = value; index += 1
            case "--pr": pr = value.flatMap(HubPRRef.init); index += 1
            case "--tab": tab = value.flatMap(HubTab.init(rawValue:)); index += 1
            case "--mode": mode = value.flatMap(HubMode.init(rawValue:)); index += 1
            case "--panes":
                let list = (value ?? "").split(separator: ",").compactMap { HubTab(rawValue: String($0)) }
                panes = list.isEmpty ? nil : list
                index += 1
            case "--width": width = value.flatMap(Double.init).map { CGFloat($0) }; index += 1
            case "--file": file = value; index += 1
            case "--height": height = value.flatMap(Double.init).map { CGFloat($0) }; index += 1
            case "--style": style = value.flatMap(DiffViewOptions.Style.init(rawValue:)); index += 1
            case "--glass": glass = value.map { $0 == "on" || $0 == "1" || $0 == "true" }; index += 1
            case "--filter": filter = value; index += 1
            case "--palette":
                palette = Self.optionalText(value) ?? ""
                index += Self.optionalText(value) == nil ? 0 : 1
            case "--find":
                find = Self.optionalText(value) ?? ""
                index += Self.optionalText(value) == nil ? 0 : 1
            case "--transcript-query": transcriptQuery = value; index += 1
            case "--session-search":
                sessionSearch = Self.optionalText(value) ?? ""
                index += Self.optionalText(value) == nil ? 0 : 1
            case "--digest": digest = true
            case "--worktree": worktree = value; index += 1
            case "--inbox-resume": inboxResume = value; index += 1
            case "--inbox-info": inboxInfo = value; index += 1
            case "--timeline-open": timelineOpen = value; index += 1
            case "--timeline-action": timelineAction = value; index += 1
            case "--set":
                let pair = (value ?? "").split(separator: "=", maxSplits: 1).map(String.init)
                if pair.count == 2 {
                    if ["true", "false", "1", "0"].contains(pair[1]) {
                        settings[pair[0]] = pair[1] == "true" || pair[1] == "1"
                    } else {
                        textSettings[pair[0]] = pair[1]
                    }
                }
                index += 1
            case "--no-activate": activate = false
            default: break
            }
            index += 1
        }
    }

    /// The text of `--palette [text]` and `--find [text]`: the next argument unless it is another
    /// flag, so `--palette --snapshot x.png` keeps its snapshot path.
    private static func optionalText(_ value: String?) -> String? {
        guard let value, !value.hasPrefix("--") else { return nil }
        return value
    }
}

func runHub(_ args: [String]) -> Never {
    PerfLog.phase("hub.launch")
    let request = HubRequest(args)
    let snapshotPath = request.snapshotPath
    let wantedSession = request.session
    let wantedPR = request.pr
    let tab = request.tab ?? .transcript
    // `--pr` alone means the PRs mode, as it does for a request handed to a running hub (`apply`).
    let mode = request.mode ?? (request.pr != nil ? .prs : .sessions)
    let activate = request.activate
    if !request.isScripted, !HubSingleInstance.claim() {
        exit(HubSingleInstance.forwardToRunningHub(args) ? 0 : 1)
    }
    if request.isScripted {
        HubDefaults.isolate()
        if let glass = request.glass { HubDefaults.store.set(glass, forKey: HubGlass.key) }
        for (key, value) in request.settings { HubDefaults.store.set(value, forKey: key) }
        for (key, value) in request.textSettings { HubDefaults.store.set(value, forKey: key) }
    }

    let app = NSApplication.shared
    // A snapshot run must never become the active app: it would take the keystrokes of whoever is
    // typing (their words ended up in the hub's search field, 2026-09-24).
    app.setActivationPolicy(request.isScripted ? .prohibited : .regular)
    let delegate = HubAppDelegate()
    app.delegate = delegate
    installBrowserURLForwarder()
    MainActor.assumeIsolated { AppMainMenu.install() }

    let model = HubModel(wantedSession: wantedSession, tab: tab)
    model.initialMode = mode
    if let panes = request.panes { model.panes = panes }
    if let worktree = request.worktree {
        model.selectedWorktree = WorktreeCleanup.selection(for: worktree)
    }
    model.applyOverlays(request)
    MainActor.assumeIsolated {
        if let wantedPR {
            model.prs.request(wantedPR)
        }
        // The Inbox count in the mode switch; the Inbox mode itself loads when it opens.
        if !request.isScripted && mode != .inbox {
            model.inbox.load()
        }
    }
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
    window.contentView = HubGlass.makeContentView(root: HubRootView(model: model).defaultAppStorage(HubDefaults.store))
    window.center()
    if request.isScripted {
        // Start from the live hub's size, but never write a scripted resize back into it.
        window.setFrameUsingName("GenesisToolsHub")
        if request.width != nil || request.height != nil {
            var frame = window.frame
            frame.size.width = request.width ?? frame.width
            frame.size.height = request.height ?? frame.height
            window.setFrame(frame, display: false)
        }
    } else {
        window.setFrameAutosaveName("GenesisToolsHub")
    }
    MainActor.assumeIsolated {
        HubGlass.apply(to: window, enabled: HubDefaults.store.bool(forKey: HubGlass.key))
        HubLiveResize.shared.watch(window)
    }

    if let benchPath = request.benchPath {
        model.onSettled = {
            // The Changes pane's web diff renders after the transcript settles.
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                MainActor.assumeIsolated { HubBench.run(window: window, model: model, output: benchPath) }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 240) {
            FileHandle.standardError.write(Data("hub bench: did not finish within 240 s, writing a partial report\n".utf8))
            if !MainActor.assumeIsolated({ HubBench.finishEarly() }) { exit(1) }
        }
        window.orderInForSnapshot()
    } else if let snapshotPath {
        model.onSettled = {
            MainActor.assumeIsolated {
                // PRs mode shows the PR's own review, not the selected session's.
                let review: @MainActor () -> ReviewModel? = { model.mode == .prs ? model.prs.review : model.review }
                HubSnapshotFocus.whenReady(review: review, file: request.file, style: request.style) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) {
                        let web = (review()?.renderer as? PierreWebDiffRenderer)?.webView
                        let showsDiff = model.mode == .prs || model.panes.contains(.changes)
                        if let rows = HubBench.transcriptRowsLine(in: window) {
                            PerfLog.mark("hub.snapshot \(rows)")
                            FileHandle.standardError.write(Data("hub snapshot: \(rows)\n".utf8))
                        }
                        ReviewSnapshot.write(window: window, webView: showsDiff ? web : nil, to: snapshotPath) {
                            exit(0)
                        }
                    }
                }
            }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 60) {
            FileHandle.standardError.write(Data("hub snapshot: not settled within 60 s\n".utf8))
            exit(1)
        }
        window.orderInForSnapshot()
    } else {
        window.makeKeyAndOrderFront(nil)
        if activate {
            app.activate(ignoringOtherApps: true)
        }
        HubSingleInstance.serve { args in
            let later = HubRequest(args)
            model.apply(later)
            if window.isMiniaturized {
                window.deminiaturize(nil)
            }
            window.makeKeyAndOrderFront(nil)
            if later.activate {
                app.activate(ignoringOtherApps: true)
            }
        }
    }

    MainActor.assumeIsolated {
        HangWatch.start()
        HubStallTest.scheduleIfRequested()
        if !request.isScripted {
            HubNavInput.install(window: window, model: model)
        }
    }
    model.loadSessions()
    // The hub is a live monitor: transcripts stream in while it sits behind other windows. App Nap
    // throttled the whole process there (main-queue work ran 0.5–1 s late and even a dedicated
    // userInteractive sampler thread woke only at the end of each "stall"). Only this face opts out.
    let liveWindow = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "GenesisTools hub: live session monitor")
    app.run()
    ProcessInfo.processInfo.endActivity(liveWindow)
    exit(0)
}

private final class HubAppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

}

/// What the left column lists: agent sessions, the worktrees (branches) they worked in, PRs, the
/// sessions waiting for an answer (Hub/HubInbox.swift), or today's activity (Hub/HubTimeline.swift).
enum HubMode: String, CaseIterable {
    case sessions, worktrees, prs, inbox, timeline

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .worktrees: return "Worktrees"
        case .prs: return "PRs"
        case .inbox: return "Inbox"
        case .timeline: return "Activity"
        }
    }

    /// The mode switch's tooltip for one segment; `waiting` is the Inbox's count of answers due.
    func tooltip(waiting: Int) -> String {
        switch self {
        case .sessions: return "Sessions: every agent session of the last days, with its transcript, changes and files"
        case .worktrees: return "Worktrees: the branches the sessions work in, with their diffs"
        case .prs: return "PRs and MRs of those projects, with their diffs, threads and checks"
        case .inbox: return waiting > 0 ? "Inbox: sessions waiting for your answer (\(waiting))" : "Inbox: sessions waiting for your answer (none right now)"
        case .timeline: return "Activity: sessions, commits, pushes, PR events, review comments, decisions and CI results across your projects, by day"
        }
    }
}

enum HubTab: String, CaseIterable {
    case transcript, changes, files, decisions

    var title: String {
        switch self {
        case .transcript: return "Transcript"
        case .changes: return "Changes"
        case .files: return "Files"
        case .decisions: return "Decisions"
        }
    }

    /// Narrower than this, a pane's own content clips (the transcript list, the diff with its file list).
    var minPaneWidth: CGFloat {
        switch self {
        // The session screen's own column minimum: at 420 its search and filter rows overflowed
        // and were cut off at both edges.
        case .transcript: return 460
        case .changes: return 440
        case .files: return 220
        case .decisions: return 320
        }
    }

    var idealPaneWidth: CGFloat {
        switch self {
        case .transcript: return 640
        case .changes: return 700
        case .files: return 300
        case .decisions: return 440
        }
    }

    var symbol: String {
        switch self {
        case .transcript: return "text.bubble"
        case .changes: return "plusminus"
        case .files: return "doc.text"
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
    /// The sidebar's filter text, which every mode's list applies.
    @Published var filter = "" {
        didSet {
            if filter != oldValue {
                MainActor.assumeIsolated { HubMainBusy.measure("filter.\(mode.rawValue)") }
            }
        }
    }
    @Published var selectedID: String?
    /// The pane that was asked for last (`--tab`, "Open diff"); it is always among `panes`.
    @Published var tab: HubTab {
        didSet {
            if !panes.contains(tab) {
                panes = tabOrder.filter { panes.contains($0) || $0 == tab }
            }
        }
    }
    /// The panes shown side by side (transcript, changes, decisions), saved between launches.
    @Published var panes: [HubTab] = (HubDefaults.store.stringArray(forKey: "hub.panes") ?? ["transcript"]).compactMap(HubTab.init(rawValue:)) {
        didSet {
            HubDefaults.store.set(panes.map(\.rawValue), forKey: "hub.panes")
            // The header's totals chip shows once the transcript pane closes; `select` skipped its list.
            if !panes.contains(.transcript), transcript.isEmpty, !loadingTranscript, selected != nil {
                loadTranscript(older: false)
            }
        }
    }
    /// Display order of the pane-toggle buttons; drag one onto another to reorder (`paneToggles`
    /// in `SessionDetailView`). Independent of `HubTab.allCases`' declaration order once the
    /// user has dragged anything. A case added after someone already saved an order (`.files`,
    /// here) is appended rather than dropped.
    @Published var tabOrder: [HubTab] = {
        let saved = (HubDefaults.store.stringArray(forKey: "hub.tabOrder") ?? []).compactMap(HubTab.init(rawValue:))
        return saved + HubTab.allCases.filter { !saved.contains($0) }
    }() {
        didSet { HubDefaults.store.set(tabOrder.map(\.rawValue), forKey: "hub.tabOrder") }
    }

    /// A pane button dropped on another: the two trade places, and the open panes follow the order.
    func swapTabs(_ dragged: HubTab, _ target: HubTab) {
        guard dragged != target, let from = tabOrder.firstIndex(of: dragged), let to = tabOrder.firstIndex(of: target) else { return }
        tabOrder.swapAt(from, to)
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
            panes = tabOrder.filter { panes.contains($0) || $0 == pane }
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
    @Published var decisions: [InboxItem] = []
    /// `tools question inbox --session` is running for the selected session (Hub/HubDecisionsSource.swift).
    @Published var loadingDecisions = false
    /// Bumped per decisions load: only the newest one may publish (Hub/HubDecisionsSource.swift).
    var decisionsRequest = 0
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
    /// ⌘⇧F / palette "grep": the find-in-files panel is open with this query ("" = empty field).
    @Published var findQuery: String? {
        didSet {
            if findQuery == nil {
                findRoot = nil
            }
        }
    }
    /// The project folder a palette "<project> grep" named; it replaces `findRoots` until the panel closes.
    @Published var findRoot: String?
    /// `--palette <text>`: the root view opens the palette with this text, then clears it.
    @Published var paletteRequest: String?
    /// `--transcript-query <text>`: the transcript opens with this search applied.
    @Published var transcriptQuery: String?

    /// Folders added in Files for the selected session ("Add folder"), each with its own changes.
    @Published private(set) var extraFolders: [String] = []
    /// The git repository of each added folder that is inside one, keyed by folder.
    @Published private(set) var folderRepos: [String: String] = [:]
    /// Which roots Changes shows (the session's folder and added ones); empty = only the session's.
    @Published private(set) var changesRoots: Set<String> = []

    var onSettled: (() -> Void)?
    var initialMode = HubMode.sessions
    private let wantedSession: String?
    private var transcriptGeneration = 0
    /// The session `select` last set up (review, decisions, folders).
    private var selectedSetUp: String?
    private var firstPageObserver: NSObjectProtocol?

    /// PRs mode state (`tools hub pr list/show`). Main-actor: created on the main thread in `runHub`.
    let prs: PRsModel

    /// Back and forward (Hub/HubNavigation.swift). Taken from the published selection itself, so
    /// every path that changes it (rows, the palette, a handed-over `--session`, "Open") is recorded.
    @Published private(set) var history = HubNavHistory()
    private var navRecorder: AnyCancellable?
    private var navRecordPending = false
    private var navRestoring = false

    /// Inbox mode state (`tools question inbox`), Hub/HubInbox.swift.
    let inbox: HubInboxModel
    /// Today mode state (`tools hub timeline`), Hub/HubTimeline.swift.
    let timeline: HubTimelineModel

    init(wantedSession: String?, tab: HubTab) {
        prs = MainActor.assumeIsolated { PRsModel() }
        inbox = MainActor.assumeIsolated { HubInboxModel() }
        timeline = MainActor.assumeIsolated { HubTimelineModel() }
        self.wantedSession = wantedSession
        self.tab = tab
        if !panes.contains(tab) {
            panes = HubTab.allCases.filter { panes.contains($0) || $0 == tab }
        }
        MainActor.assumeIsolated { startNavRecorder() }
        // A scripted run with the transcript pane settles on that pane's first page (see `select`).
        firstPageObserver = NotificationCenter.default.addObserver(forName: HubSessionDetailHost.firstPageDone, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.onSettled?()
                self?.onSettled = nil
            }
        }
    }

    // MARK: Back and forward

    @MainActor
    private func startNavRecorder() {
        let changes: [AnyPublisher<Void, Never>] = [
            $mode.map { _ in () }.eraseToAnyPublisher(),
            $selectedID.map { _ in () }.eraseToAnyPublisher(),
            $selectedWorktree.map { _ in () }.eraseToAnyPublisher(),
            prs.$selectedID.map { _ in () }.eraseToAnyPublisher(),
            inbox.$selectedID.map { _ in () }.eraseToAnyPublisher(),
        ]
        navRecorder = Publishers.MergeMany(changes).sink { [weak self] in self?.scheduleNavRecord() }
    }

    /// `@Published` announces a change before it lands, and one click often changes two values
    /// (mode and selection), so the place is taken once, on the next turn of the main queue.
    private func scheduleNavRecord() {
        guard !navRecordPending else { return }
        navRecordPending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.navRecordPending = false
            guard !self.navRestoring else { return }
            MainActor.assumeIsolated { self.history.visit(self.navEntry) }
        }
    }

    @MainActor
    var navEntry: HubNavEntry {
        switch mode {
        case .sessions: return HubNavEntry(mode: .sessions, selection: selectedID)
        case .worktrees: return HubNavEntry(mode: .worktrees, selection: selectedWorktree)
        case .prs: return HubNavEntry(mode: .prs, selection: prs.selectedID)
        // Both lists are the content itself, so the mode alone is a place worth going back to.
        case .inbox: return HubNavEntry(mode: .inbox, selection: inbox.selectedID ?? Self.wholeList)
        case .timeline: return HubNavEntry(mode: .timeline, selection: Self.wholeList)
        }
    }

    /// The selection of a mode entry that shows its whole list (Inbox, Today).
    static let wholeList = "*"

    @MainActor
    func goBack() {
        if let entry = history.goBack() {
            restore(entry)
        }
    }

    @MainActor
    func goForward() {
        if let entry = history.goForward() {
            restore(entry)
        }
    }

    /// Shows a place from the history with the same methods the rows use; the changes it makes are
    /// not recorded again.
    @MainActor
    private func restore(_ entry: HubNavEntry) {
        navRestoring = true
        HubPerf.log("nav.restore \(entry.mode.rawValue) \(entry.selection ?? "-")")
        setMode(entry.mode)
        if let id = entry.selection {
            switch entry.mode {
            case .sessions:
                select(id)
            case .worktrees:
                if let worktree = worktrees.first(where: { $0.path == id }) {
                    selectWorktree(worktree)
                } else {
                    selectedWorktree = id
                }
            case .prs:
                if let pr = prs.prs.first(where: { $0.id == id }) {
                    prs.select(pr)
                } else {
                    prs.showUnavailable(id)
                    notice = prs.state == "all"
                        ? "That PR is not in the PR list any more."
                        : "That PR is not in the \(prs.state) list any more; pick All to find it."
                }
            case .inbox:
                inbox.selectedID = id == Self.wholeList ? nil : id
            case .timeline:
                break
            }
        }
        // The recorder's turn for these changes is already queued, so it runs first and skips them.
        DispatchQueue.main.async { [weak self] in self?.navRestoring = false }
    }

    /// What a history entry shows, for the arrows' tooltips.
    @MainActor
    func navTitle(_ entry: HubNavEntry) -> String {
        guard let id = entry.selection else { return entry.mode.title }
        let name: String
        switch entry.mode {
        case .sessions:
            name = id == AgentProcs.selectionID ? "agent processes"
                : "session " + (sessions.first { $0.id == id }?.displayTitle ?? String(id.suffix(8)))
        case .worktrees:
            name = id == WorktreeCleanup.selectionID ? "worktree cleanup"
                : "worktree " + (worktrees.first { $0.path == id }.map { "\($0.repo) \($0.branch)" } ?? (id as NSString).lastPathComponent)
        case .prs:
            name = prs.prs.first { $0.id == id }.map { "\($0.label) \($0.title)" } ?? "a PR"
        case .inbox:
            name = id == Self.wholeList ? "Inbox" : "Inbox: " + (inbox.sessions.first { $0.id == id }?.displayTitle ?? "a session")
        case .timeline:
            name = "Activity"
        }
        return name.count > 70 ? String(name.prefix(69)) + "…" : name
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
        // A switch costs the renders after it: the old mode's views go and the new mode's arrive.
        MainActor.assumeIsolated { HubMainBusy.measure("mode.\(next.rawValue)") }
        mode = next
        if next == .inbox {
            MainActor.assumeIsolated { inbox.loadIfStale() }
        }
        if next == .timeline {
            MainActor.assumeIsolated { timeline.loadIfStale() }
        }
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
        // An absolute path finds its file in whichever ticked root holds it.
        review.reveal(path: path)
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
        // With the transcript pane open, `select` fetched no list: the export reads its recent turns now.
        if transcript.isEmpty, session.id == selectedID, let envelope = try? await HubSource.transcript(session, limit: Self.pageSize) {
            transcript = TranscriptTimeline.build(envelope.turns)
            transcriptTotals = envelope.totals?.summary
        }
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
                } else if initialMode == .inbox || initialMode == .timeline {
                    let settle: () -> Void = { [weak self] in
                        self?.onSettled?()
                        self?.onSettled = nil
                    }
                    MainActor.assumeIsolated {
                        if initialMode == .inbox { inbox.onLoaded = settle } else { timeline.onLoaded = settle }
                    }
                    setMode(initialMode)
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

    /// What the command palette can name: projects, sessions, PRs and worktrees the hub already knows.
    @MainActor
    var paletteContext: HubPaletteContext {
        HubPaletteContext(
            projects: HubPaletteEngine.projects(sessions: sessions, worktrees: worktrees),
            sessions: sessions,
            prs: prs.prs,
            worktrees: worktrees,
            currentPath: selected.map { $0.cwd.isEmpty ? nil : projectRoot(of: $0.cwd) } ?? nil
        )
    }

    /// A history hit: the session in the list, or, when it is older than the list's window, a row made
    /// from the hit and added to the list.
    @MainActor
    func openHistory(_ hit: HubHistoryHit) {
        HubPerf.log("history.open \(hit.sessionId.prefix(8))")
        if let known = sessions.first(where: { $0.sessionId == hit.sessionId }) {
            select(known.id)
            return
        }
        let row = hit.sessionRow
        sessions.append(row)
        select(row.id)
    }

    /// Where ⌘⇧F searches: the selected session's project (or worktree, or PR checkout) and the
    /// folders added in Files.
    @MainActor
    var findRoots: [String] {
        if let findRoot {
            return [findRoot]
        }

        var roots: [String] = []
        if mode == .worktrees, let path = selectedWorktree, path != WorktreeCleanup.selectionID {
            roots.append(path)
        } else if mode == .prs, let path = prs.selected?.localWorktree ?? prs.selected?.repoRoot {
            roots.append(path)
        } else if let current = paletteContext.currentPath {
            roots.append(current)
        }
        roots += extraFolders.filter { !roots.contains($0) }
        return roots
    }

    /// Runs one palette command with the hub's own methods (the same ones its buttons use).
    @MainActor
    func runPalette(_ action: HubPaletteAction, toggleGlass: () -> Void) {
        switch action {
        case .openPR(let ref):
            setMode(.prs)
            prs.request(ref)
        case .selectSession(let id):
            setMode(.sessions)
            select(id)
        case .selectWorktree(let path):
            setMode(.worktrees)
            selectedWorktree = path
        case .setMode(let next):
            setMode(next)
        case .togglePane(let tab):
            togglePane(tab)
        case .openCursor(let path):
            PathOpener.cursor(path)
        case .openTerminal(let path):
            PathOpener.cmux(path)
        case .newSession(let path):
            notice = AgentLauncher.openInTerminal(name: (path as NSString).lastPathComponent, cwd: path, command: ["tools", "claude", "run"])
                ?? "Started a new Claude session in \((path as NSString).lastPathComponent)."
        case .findInFiles(let query, let root):
            findRoot = root
            findQuery = query
        case .historySearch(let query):
            // The session list's filter also searches every project's history (HubHistory.swift).
            setMode(.sessions)
            filter = query
        case .reveal(let path):
            if !panes.contains(.changes) {
                togglePane(.changes)
            }
            review?.reveal(path: path)
        case .reviewWithAgent:
            if let pr = prs.selected {
                if (pr.localWorktree ?? pr.repoRoot) == nil {
                    // No checkout to review in, so the detail shows no "Review with agent" to open.
                    notice = "\(pr.label) has no local checkout to review in."
                } else {
                    setMode(.prs)
                    prs.reviewRequested = true
                }
            } else {
                notice = "Select a PR first, then run review again."
            }
        case .toggleGlass:
            toggleGlass()
        }
    }

    /// `--filter`, `--palette`, `--find`: the list filter and the two overlays, first launch or later.
    func applyOverlays(_ request: HubRequest) {
        if let text = request.filter {
            filter = text
        }
        if let text = request.find {
            findQuery = text
        }
        if let text = request.palette {
            paletteRequest = text
        }
        if let text = request.transcriptQuery {
            transcriptQuery = text
        }
        if request.sessionSearch != nil || request.digest {
            MainActor.assumeIsolated {
                if let text = request.sessionSearch { HubDailyModel.shared.searchQuery = text }
                if request.digest { HubDailyModel.shared.digestOpen = true }
            }
        }
        // The inbox model is main-actor bound; overlays are applied on the main thread.
        if let id = request.inboxResume {
            MainActor.assumeIsolated {
                inbox.reveal = .resume(id)
                inbox.load()
            }
        } else if let id = request.inboxInfo {
            MainActor.assumeIsolated {
                inbox.reveal = .info(id)
                inbox.load()
            }
        }
        if let id = request.timelineOpen {
            MainActor.assumeIsolated { openTimelineRequest(id, action: request.timelineAction) }
        }
    }

    /// A later `GenesisTools --hub …` handed to this hub: the same flags as a first launch.
    func apply(_ request: HubRequest) {
        applyOverlays(request)
        if let tab = request.tab {
            self.tab = tab
        }
        if let wanted = request.session, let match = sessions.first(where: { $0.id == wanted || $0.sessionId.hasPrefix(wanted) }) {
            setMode(.sessions)
            select(match.id)
        } else if let mode = request.mode {
            setMode(mode)
        }
        if let worktree = request.worktree {
            setMode(.worktrees)
            selectedWorktree = WorktreeCleanup.selection(for: worktree)
        }
        if let ref = request.pr {
            MainActor.assumeIsolated { prs.request(ref) }
            if request.mode == nil {
                setMode(.prs)
            }
        }
    }

    func select(_ id: String) {
        // Again for the same session only after a failed load: the transcript list stays empty while the
        // transcript pane is open, so it can no longer tell whether this session was set up.
        guard id != selectedSetUp || transcriptError != nil else { return }
        selectedSetUp = id
        selectedID = id
        transcript = []
        transcriptLimit = Self.pageSize
        transcriptTotals = nil
        transcriptEnded = nil
        transcriptError = nil
        expandedTools = []
        guard let session = selected else { return }
        decisions = []
        loadDecisions(for: session.sessionId)
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
        restoreFolders(for: session.sessionId)
        // The transcript pane loads its own window (HubSessionDetailHost), and its first page settles a
        // scripted run. This older list only feeds the header's totals chip, which shows while that pane
        // is closed: fetching it beside the pane's first page was a second `tools ai sessions tail` per
        // click (0.5 to 3.5 s of CPU on a large session, `hub.transcript.fetch`).
        if !panes.contains(.transcript) {
            loadTranscript(older: false)
        }
    }

    // MARK: Added folders (Files → Add folder)

    private func foldersKey(_ session: String) -> String { "hub.extraFolders.\(session)" }
    private func rootsKey(_ session: String) -> String { "hub.changesRoots.\(session)" }

    private func restoreFolders(for session: String) {
        let saved = (HubDefaults.store.stringArray(forKey: foldersKey(session)) ?? []).filter { FileManager.default.fileExists(atPath: $0) }
        extraFolders = saved
        changesRoots = Set(HubDefaults.store.stringArray(forKey: rootsKey(session)) ?? [])
        folderRepos = Dictionary(uniqueKeysWithValues: saved.compactMap { folder in Self.gitRoot(of: folder).map { (folder, $0) } })
        syncChangesRoots()
    }

    private func saveFolders() {
        guard let session = selected?.sessionId else { return }
        HubDefaults.store.set(extraFolders, forKey: foldersKey(session))
        HubDefaults.store.set(Array(changesRoots), forKey: rootsKey(session))
    }

    /// The git repository that holds a folder; nil when the folder is not inside one.
    private static func gitRoot(of folder: String) -> String? {
        let root = projectRoot(of: folder)
        return FileManager.default.fileExists(atPath: (root as NSString).appendingPathComponent(".git")) ? root : nil
    }

    /// Whether an added folder can show changes (it is inside a git repository).
    func isGitFolder(_ folder: String) -> Bool {
        folder == review?.repo.path || folderRepos[folder] != nil
    }

    func addFolder(_ path: String) {
        guard !extraFolders.contains(path), path != review?.repo.path else { return }
        extraFolders.append(path)
        folderRepos[path] = Self.gitRoot(of: path)
        HubPerf.log("folders.add \(path) git=\(folderRepos[path] != nil)")
        saveFolders()
        syncChangesRoots()
    }

    func removeFolder(_ path: String) {
        extraFolders.removeAll { $0 == path }
        folderRepos[path] = nil
        changesRoots.remove(path)
        saveFolders()
        syncChangesRoots()
    }

    /// Hands the session's roots to its one review: its own folder first, then every added folder.
    /// With no added folder the review has one root and reads as it always did. An added folder in a
    /// repository already listed stays as a row that loads nothing, so no file shows twice.
    private func syncChangesRoots() {
        guard let review else { return }
        var roots = [ReviewRoot(folder: review.repo.path, repo: review.repo, shown: extraFolders.isEmpty || showsChanges(of: review.repo.path))]
        // Keyed by git root on both sides: a session in /x/repo/packages/api and an added /x/repo are one
        // repository, and seeding with the session folder itself let both load it.
        var repos: Set<String> = [Self.gitRoot(of: review.repo.path) ?? review.repo.path]
        for folder in extraFolders {
            let repo = folderRepos[folder]
            var root = ReviewRoot(folder: folder, repo: repo.map { URL(fileURLWithPath: $0) }, shown: showsChanges(of: folder), removable: true)
            if let repo, !repos.insert(repo).inserted {
                root = ReviewRoot(folder: folder, repo: nil, shown: false, removable: true)
                root.error = "Its repository \((repo as NSString).lastPathComponent) is listed already."
            }
            roots.append(root)
        }
        review.rootActions = ReviewRootActions(
            setShown: { [weak self] folder, shown in self?.setChangesRoot(folder, shown: shown) },
            remove: { [weak self] folder in self?.removeFolder(folder) }
        )
        review.setRoots(roots)
    }

    /// Stored when every root is unticked: an empty set means "not chosen yet" (the session's folder).
    private static let noRoots = "-"

    /// Whether Changes shows this root. Nothing chosen yet = only the session's own folder.
    func showsChanges(of root: String) -> Bool {
        changesRoots.isEmpty ? root == review?.repo.path : changesRoots.contains(root)
    }

    /// Show or hide one root's changes; the first choice starts from the implicit default, so ticking
    /// an added folder keeps the session's folder shown.
    func setChangesRoot(_ root: String, shown: Bool) {
        var current = changesRoots
        if current.isEmpty, let main = review?.repo.path {
            current = [main]
        }
        current.remove(Self.noRoots)
        if shown {
            current.insert(root)
        } else {
            current.remove(root)
        }
        changesRoots = current.isEmpty ? [Self.noRoots] : current
        saveFolders()
        syncChangesRoots()
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
    @AppStorage(HubGlass.key) private var glass = false
    @AppStorage("hub.prs.showDiff") private var prsShowDiff = true
    @State private var width: CGFloat = 0
    @State private var paletteOpen = false
    @State private var paletteSeed = ""

    private static let sidebarMinWidth: CGFloat = 200

    /// What the right-hand side needs before anything clips: the open panes' minimums side by side.
    private var mainMinWidth: CGFloat {
        // PRs with the diff open: the overview (360) and the diff (420) side by side. At 520 the diff
        // pushed its own header and file rail past the window edge (snapshot 2026-09-24 15:25).
        if model.mode == .prs, prsShowDiff { return 360 + 1 + 420 }
        guard model.mode == .sessions, model.selected != nil else { return 520 }
        let visible = model.tabOrder.filter { model.panes.contains($0) }
        guard visible.count > 1 else {
            // Alone, the transcript is the full session screen: a 460 pt column plus its own 300 pt
            // sidebar (Stolen/Sessions/SessionDetailScreen.swift). Any other pane alone: its minimum.
            return visible.first == .transcript ? 761 : (visible.first?.minPaneWidth ?? 480)
        }
        return visible.reduce(0) { $0 + $1.minPaneWidth } + CGFloat(visible.count - 1)
    }

    var body: some View {
        // The session list gets what the panes leave; with no room left it folds to a rail you can
        // still see (and open as a drawer), instead of pushing the panes out of the window.
        let sidebarRoom = width - mainMinWidth - 1
        let windowMinWidth = ResizableSidePanel<EmptyView>.railWidth + 1 + mainMinWidth
        HStack(spacing: 0) {
            ResizableSidePanel(key: "hub.sidebar", edge: .leading, title: "Sessions", defaultWidth: 320,
                               minWidth: Self.sidebarMinWidth, maxWidth: max(Self.sidebarMinWidth, sidebarRoom),
                               autoCollapse: width > 0 && sidebarRoom < Self.sidebarMinWidth) {
                SessionListView(model: model)
            }
            if model.mode == .prs {
                PRsMain(model: model, prs: model.prs)
            } else if model.mode == .inbox {
                // InboxMain with its ⌘F find (Hub/HubInboxFind.swift).
                InboxFindHost(model: model, inbox: model.inbox)
            } else if model.mode == .timeline {
                TimelineMain(model: model, timeline: model.timeline)
            } else if model.mode == .worktrees {
                if let path = model.selectedWorktree, let worktree = model.worktrees.first(where: { $0.path == path }) {
                    WorktreeDetailView(model: model, worktree: worktree)
                } else if model.selectedWorktree == WorktreeCleanup.selectionID, !model.loadingWorktrees {
                    WorktreeCleanupView(model: model)
                } else {
                    Text(model.loadingWorktrees ? "Finding worktrees…" : "Pick a worktree")
                        .foregroundColor(ReviewPalette.dim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if model.selectedID == AgentProcs.selectionID {
                AgentProcsView(model: model)
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
        .hubSurface(.content)
        .environment(\.hubGlass, glass)
        .preferredColorScheme(.dark)
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
        .onGeometryChange(for: Int.self, of: { $0.frame(in: .global).minX < -0.5 ? 1 : 0 }) { HubBench.note("hub.root.clipped", $0) }
        .background(HubWindowReader { window in
            HubGlass.apply(to: window, enabled: glass)
            // The root hosting view no longer derives the window's minimum from SwiftUI (that cost a
            // full layout per pass); the minimum is this, stated once per change.
            if window.contentMinSize.width != windowMinWidth {
                window.contentMinSize = NSSize(width: windowMinWidth, height: 520)
            }
        })
        .background(
            Button("") { glass.toggle() }
                .keyboardShortcut("g", modifiers: [.command, .shift])
                .opacity(0)
                .accessibilityHidden(true)
        )
        .background(
            Button("") {
                paletteSeed = ""
                paletteOpen.toggle()
            }
                .keyboardShortcut("k", modifiers: [.command])
                .opacity(0)
                .accessibilityHidden(true)
        )
        .background(
            Button("") { model.findQuery = model.findQuery == nil ? "" : nil }
                .keyboardShortcut("f", modifiers: [.command, .shift])
                .opacity(0)
                .accessibilityHidden(true)
        )
        // Here, not on the arrows: the keys still work while the sidebar is folded to its rail.
        .background(
            Button("") { model.goBack() }
                .keyboardShortcut("[", modifiers: [.command])
                .opacity(0)
                .accessibilityHidden(true)
        )
        .background(
            Button("") { model.goForward() }
                .keyboardShortcut("]", modifiers: [.command])
                .opacity(0)
                .accessibilityHidden(true)
        )
        .overlay {
            if model.findQuery != nil {
                HubFindPanel(hub: model, roots: model.findRoots)
            }
            if paletteOpen {
                HubPaletteView(isPresented: $paletteOpen, context: model.paletteContext, initialQuery: paletteSeed) { action in
                    model.runPalette(action) { glass.toggle() }
                }
            }
        }
        .onChange(of: model.paletteRequest, initial: true) { _, request in
            guard let request else { return }
            paletteSeed = request
            paletteOpen = true
            model.paletteRequest = nil
        }
        // ⌥⌘F transcript search over every session, ⌥⌘D Today digest with forecast and rules (Hub/HubDaily.swift).
        .hubDaily(model: model)
        // ⌘⇧P prompt library: saved prompts with {{variables}}, sent to the selected session (Hub/HubPrompts.swift).
        .hubPrompts(model: model)
    }
}

/// Hands the view's window to `apply` on every update (glass, minimum size). Reading state only.
struct HubWindowReader: NSViewRepresentable {
    let apply: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView { NSView() }

    func updateNSView(_ view: NSView, context: Context) {
        let apply = apply
        DispatchQueue.main.async {
            if let window = view.window { apply(window) }
        }
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

/// The mode switch. The Inbox segment carries the number of answers waiting. A sidebar too narrow
/// for five titles shows icons (a filled tray while answers wait). Buttons drawn as one segmented
/// control, not a `Picker`: a segmented Picker takes one tooltip for the whole row, so every
/// segment said the same thing; here each segment names its own mode.
private struct HubModePicker: View {
    @ObservedObject var model: HubModel
    @ObservedObject var inbox: HubInboxModel

    private static let symbols: [HubMode: String] = [
        .sessions: "text.bubble", .worktrees: "arrow.triangle.branch", .prs: "arrow.triangle.pull",
        .inbox: "tray", .timeline: "clock",
    ]

    /// The row's width; five titles need about 290 pt at the small control size.
    @State private var width: CGFloat = 320

    var body: some View {
        let icons = width < 290
        HStack(spacing: 1) {
            ForEach(HubMode.allCases, id: \.self) { mode in
                segment(mode, icons: icons)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(ReviewPalette.hairline))
        .frame(maxWidth: .infinity)
        .onGeometryChange(for: CGFloat.self, of: \.size.width) { width = $0 }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(Text("Mode"))
    }

    private func segment(_ mode: HubMode, icons: Bool) -> some View {
        let selected = model.mode == mode
        let waiting = inbox.waitingCount
        let count = mode == .inbox && waiting > 0 ? " \(waiting)" : ""
        return Button {
            model.setMode(mode)
        } label: {
            Group {
                if icons {
                    // A filled tray says something waits; the count is in the Inbox header.
                    Image(systemName: mode == .inbox && !count.isEmpty ? "tray.full.fill" : Self.symbols[mode] ?? "circle")
                        .font(.system(size: 11))
                } else {
                    Text(verbatim: mode.title + count)
                        .font(.system(size: 11, weight: selected ? .semibold : .regular))
                        .lineLimit(1)
                }
            }
            .foregroundColor(selected ? .white : Color.white.opacity(0.7))
            .frame(maxWidth: .infinity)
            .frame(height: 20)
            .background(RoundedRectangle(cornerRadius: 5).fill(selected ? Color.white.opacity(0.16) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(mode.tooltip(waiting: waiting))
        .accessibilityLabel(Text(mode.title))
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

private struct SessionListView: View {
    @ObservedObject var model: HubModel
    @StateObject private var history = HubHistoryModel()
    @AppStorage("hub.sessions.grouping") private var grouping = SessionGrouping.time.rawValue
    @StateObject private var prefs = GroupPrefs(key: "sessions.groups")
    /// Stuck verdicts of the live sessions (Hub/HubStuck.swift); rows take the value, not the store.
    @ObservedObject private var stuck = HubStuckStore.shared

    private var mode: SessionGrouping { SessionGrouping(rawValue: grouping) ?? .time }

    private var filterPlaceholder: String {
        switch model.mode {
        case .sessions: return "Filter sessions, projects, accounts…"
        case .inbox: return "Filter waiting sessions and questions…"
        case .timeline: return "Filter the activity: title, project, branch, author, sha…"
        case .worktrees, .prs: return "Filter repos, branches…"
        }
    }

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
            // Back and forward sit in the band under the title bar, right above the mode switch:
            // the switch row has no room left in a narrow sidebar.
            // The glass switch sits here too: five modes need the whole width of the row below.
            HStack(spacing: 0) {
                HubNavButtons(model: model)
                Spacer(minLength: 0)
                GlassToggle()
            }
            .padding(.horizontal, 12)
            .frame(height: 28)
            .padding(.vertical, 6)
            HubModePicker(model: model, inbox: model.inbox)
                .padding(.horizontal, 10)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").foregroundColor(ReviewPalette.dim)
                TextField(filterPlaceholder, text: $model.filter)
                    .textFieldStyle(.plain)
                // A slot that stays while idle: the spinner used to narrow the field on every refresh.
                ZStack {
                    if model.loadingSessions {
                        ProgressView().controlSize(.small)
                    }
                }
                .frame(width: 16, height: 16)
                if model.mode == .sessions {
                    Menu {
                        ForEach(SessionGrouping.allCases, id: \.self) { option in
                            Button {
                                HubMainBusy.measure("sessions.grouping")
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
            } else if model.mode == .inbox {
                InboxListView(model: model, inbox: model.inbox)
            } else if model.mode == .timeline {
                TimelineListView(model: model, timeline: model.timeline)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                        // Hub/HubAgentProcs.swift: every agent session's process tree, orphans first.
                        AgentProcsEntry(model: model)
                        ForEach(sections, id: \.title) { section in
                            Section {
                                if !(section.managed && prefs.collapsed.contains(section.title)) {
                                    ForEach(section.rows) { session in
                                        SessionRowView(session: session, selected: session.id == model.selectedID, stuck: stuck.verdicts[session.sessionId])
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
                                    .hubSurface(.bar)
                                }
                            }
                        }
                        HubHistorySection(model: model, history: history, shown: Set(sections.flatMap(\.rows).map(\.sessionId)))
                    }
                    .padding(.bottom, 12)
                }
                // Polls `tools hub stuck` (every 2 min) for the live sessions while this list shows; a new live set restarts it.
                .task(id: HubStuck.watched(model.sessions)) { await stuck.watch(HubStuck.watched(model.sessions)) }
            }
        }
        .hubSurface(.chrome)
        .task(id: model.mode == .sessions ? model.filter : "") {
            // Debounced: one history search per pause in typing, not per keystroke.
            let text = model.mode == .sessions ? model.filter : ""
            if !text.isEmpty {
                try? await Task.sleep(for: .milliseconds(450))
            }
            guard !Task.isCancelled else { return }
            history.search(text)
        }
    }
}

/// The provider's letter on its colour (session rows, the Inbox).
struct ProviderBadge: View {
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
    var stuck: StuckVerdict?

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
                    if let stuck {
                        StuckBadge(verdict: stuck)
                    }
                    LiveAgo(date: session.lastActivity)
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
    @ObservedObject private var stuck = HubStuckStore.shared
    let session: HubSession
    /// How many of the open panes fit side by side; nil until measured (then all are shown).
    @State private var fitting: Int?
    /// A pane that did not fit, shown as a drawer over the others from its rail.
    @State private var drawer: HubTab?

    /// The open panes, in order, that fit into `width` at their minimums; the rest become rails.
    /// The first pane always shows, however narrow the window.
    static func fittingCount(_ panes: [HubTab], width: CGFloat) -> Int {
        guard width > 0 else { return panes.count }
        var used: CGFloat = 0
        var count = 0
        for (index, tab) in panes.enumerated() {
            let railsLeft = CGFloat(panes.count - index - 1) * (PaneRail.width + 1)
            let divider: CGFloat = index == 0 ? 0 : 1
            guard count == 0 || used + divider + tab.minPaneWidth + railsLeft <= width else { break }
            used += divider + tab.minPaneWidth
            count += 1
        }
        return count
    }

    var body: some View {
        let visible = model.tabOrder.filter { model.panes.contains($0) }
        let shown = Array(visible.prefix(fitting ?? visible.count))
        let railed = Array(visible.dropFirst(shown.count))
        VStack(spacing: 0) {
            header
            HStack(spacing: 0) {
                if shown.count == 1, let only = shown.first {
                    pane(only).freezesWidthWhileResizing()
                } else {
                    HSplitView {
                        ForEach(shown, id: \.self) { tab in
                            pane(tab)
                                .freezesWidthWhileResizing(heavy: tab == .transcript)
                                .frame(minWidth: tab.minPaneWidth, idealWidth: tab.idealPaneWidth, maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                    // The split view too: its frame changing per window-resize step made the root
                    // hosting view rebuild the key view loop each step (72 ms with two panes).
                    .freezesWidthWhileResizing()
                }
                // Panes with no room left fold to rails at the edge instead of being pushed out of
                // the window (at 900 pt the Files pane lay past the right edge, audit 2026-09-24).
                ForEach(railed, id: \.self) { tab in
                    Rectangle().fill(ReviewPalette.hairline).frame(width: 1)
                    PaneRail(tab: tab, open: drawer == tab) {
                        withAnimation(.snappy(duration: 0.25)) { drawer = drawer == tab ? nil : tab }
                    }
                }
            }
            .overlay(alignment: .trailing) {
                if let tab = drawer, railed.contains(tab) {
                    pane(tab)
                        .frame(width: tab.idealPaneWidth)
                        .frame(maxHeight: .infinity)
                        .hubSurface(.content)
                        .overlay(alignment: .leading) { Rectangle().fill(ReviewPalette.hairline).frame(width: 1) }
                        .shadow(color: .black.opacity(0.45), radius: 18, x: -6)
                        .padding(.trailing, CGFloat(railed.count) * (PaneRail.width + 1))
                        .transition(.move(edge: .trailing).combined(with: .opacity))
                        .onExitCommand { withAnimation(.snappy(duration: 0.2)) { drawer = nil } }
                }
            }
        }
        // Only the count is state: a resize step that keeps the same panes changes nothing here.
        .onGeometryChange(for: Int.self, of: { Self.fittingCount(visible, width: $0.size.width) }) { count in
            if fitting != count {
                HubPerf.log("session.panes fit \(count) of \(visible.count)")
                fitting = count
            }
        }
        .onChange(of: railed) { _, now in
            if let open = drawer, !now.contains(open) { drawer = nil }
        }
    }

    @ViewBuilder
    private func pane(_ tab: HubTab) -> some View {
        switch tab {
        case .transcript:
            HubSessionDetailHost(session: session, onShowChange: { path, line in
                model.showChange(path: path, line: line)
            }, showsSidebar: model.panes.count == 1, transcriptQuery: model.transcriptQuery)
                .id("\(session.id)|\(model.panes.count == 1)")
        case .changes:
            HubChangesPane(model: model)
        case .files:
            HubFilesPane(model: model)
        case .decisions:
            DecisionsView(model: model, inbox: model.inbox)
        }
    }

    /// Drag one button onto another and the two swap places (animated); the order is saved in
    /// `model.tabOrder` and the panes follow it.
    private var paneToggles: some View {
        HStack(spacing: 2) {
            ForEach(model.tabOrder, id: \.self) { tab in
                PaneToggle(tab: tab, model: model, badge: badge(for: tab))
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 8).stroke(ReviewPalette.hairline))
        .hubLiquidGlass(glass, in: RoundedRectangle(cornerRadius: 8))
    }

    @Environment(\.hubGlass) private var glass

    /// A small count on the button: changed files, open decisions. `.pending` keeps the badge's place
    /// while there is no count yet, so the buttons do not move when the diff has loaded.
    private func badge(for tab: HubTab) -> PaneBadge {
        switch tab {
        case .changes, .files:
            let count = model.review?.files.count ?? 0
            return count > 0 ? .count(count) : .pending
        case .decisions: return .count(model.decisions.filter(\.isOpen).count)
        case .transcript: return .none
        }
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
                    Group {
                        if session.isLive {
                            Text("live")
                        } else {
                            LiveAgo(date: session.lastActivity) { "idle · \($0)" }
                        }
                    }
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                    if let verdict = stuck.verdicts[session.sessionId] {
                        StuckBadge(verdict: verdict)
                    }
                }
                Spacer()
                if model.panes.contains(.transcript) {
                    // The account row below hides with the transcript open; the forecast stays in sight.
                    HubForecastChip(account: session.account)
                }
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
                    HubForecastChip(account: session.account)
                    if let sessionModel = session.model {
                        chip("cpu", sessionModel)
                    }
                    if !session.cwd.isEmpty {
                        PathLabel(path: session.cwd)
                        if let branch = HubSessionDetailHost.branch(of: session) {
                            let facts = repos.facts(for: session.cwd, pr: true)
                            ExternalLink(text: branch, url: HubSessionDetailHost.branchURL(branch, facts: facts), font: .system(size: 11))
                            // The folder's PR belongs to the branch checked out there now.
                            if facts?.branch == branch {
                                CompareLink(facts: facts)
                                PullRequestLink(facts: facts)
                            }
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

// The session's Decisions pane lives in Hub/HubDecisionsPane.swift and draws the Inbox's card.

// MARK: - Pane toggle

/// A pane button's count: none for a pane that never has one, a placeholder while there is no count.
enum PaneBadge: Equatable {
    case none
    case pending
    case count(Int)
}

/// One pane button: click shows or hides the pane (option-click: only this one); drag it onto
/// another button and the two swap places. The target glows while something hovers over it.
private struct PaneToggle: View {
    let tab: HubTab
    @ObservedObject var model: HubModel
    let badge: PaneBadge
    @State private var targeted = false

    var body: some View {
        dragAndDrop(button)
    }

    private var badgeText: String {
        if case .count(let count) = badge {
            return "\(count)"
        }

        return "·"
    }

    private var button: some View {
        let open = model.panes.contains(tab)
        return Button {
            // The click's own event, not the keyboard's current state: a synthetic option-click
            // (tools control act --modifiers alt) carries the flag only on the event.
            model.togglePane(tab, only: (NSApp.currentEvent?.modifierFlags ?? NSEvent.modifierFlags).contains(.option))
        } label: {
            HStack(spacing: 5) {
                Image(systemName: tab.symbol).font(.system(size: 11))
                // The semibold width is always reserved: an open pane's bolder title used to move every
                // button to its left.
                ZStack(alignment: .leading) {
                    Text(tab.title).font(.system(size: 12, weight: .semibold)).hidden()
                    Text(tab.title).font(.system(size: 12, weight: open ? .semibold : .regular))
                }
                if badge != .none {
                    // Three digits wide from the start, "·" until the count is known: the diff's file
                    // count arriving no longer pushes the other buttons aside.
                    Text(verbatim: badgeText)
                        .font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .frame(minWidth: 19)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(Capsule().fill(Color.white.opacity(open ? 0.16 : 0.08)))
                        .opacity(badge == .pending ? 0.5 : 1)
                }
            }
            .foregroundColor(open ? Color.white : ReviewPalette.dim)
            .padding(.horizontal, 9)
            .frame(height: 24)
            .background(RoundedRectangle(cornerRadius: 6).fill(open ? Color.white.opacity(0.14) : Color.clear))
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(ReviewPalette.renamed, lineWidth: 1.5)
                    .opacity(targeted ? 1 : 0)
            )
            .scaleEffect(targeted ? 1.06 : 1)
            .animation(.snappy(duration: 0.18), value: targeted)
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(open
            ? "Hide the \(tab.title) pane · option-click: only this one · drag onto another to swap"
            : "Show the \(tab.title) pane · option-click: only this one · drag onto another to swap")
    }

    private func dragAndDrop(_ view: some View) -> some View {
        view.draggable(tab.rawValue) {
            Label(tab.title, systemImage: tab.symbol)
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .background(Capsule().fill(ReviewPalette.renamed.opacity(0.85)))
                .foregroundColor(.white)
        }
        .dropDestination(for: String.self) { items, _ in
            guard let dragged = items.first, let from = HubTab(rawValue: dragged) else { return false }
            withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) {
                model.swapTabs(from, tab)
            }
            return true
        } isTargeted: { inside in
            targeted = inside
        }
    }
}
