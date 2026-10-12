import AppKit
import Combine
import SwiftUI

// GenesisTools --hub [--mode sessions|worktrees|prs] [--session <provider:id or id prefix>|::procs] [--pr <n>]
//                    [--tab transcript|changes|files|decisions] [--no-activate] [--snapshot <png>]
//                    [--bench <json>] [--panes transcript,changes,…] [--width <pt>] [--glass on|off]
//                    [--file <repo-relative path>] [--height <pt>] [--style split|unified]
//                    [--worktree <path>|cleanup|cleanup-blocked] [--set <key>=true|false]
//                    [--panel-find <scope>:<text>] [--panel-find-next <n>] (Hub/HubPanelFind.swift)
//                    [--timeline-open <event id>] [--timeline-action <action id>] (Hub/HubTimeline.swift)
//                    [--session-search [text]] [--digest] (Hub/HubDaily.swift) [--prompts] [--handoff]
//                    [--decision <id>|--question <id>] (the Inbox at that card, Hub/HubInbox.swift)
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
    /// With `--session`: this sub-agent, teammate or worker of it opens in the Agents mode (`--agent <id|name>`).
    var agent: String?
    var pr: HubPRRef?
    /// With `--pr`: this repo-relative file opens in that PR's review (`--reveal <path>`, the browser
    /// extension's "Open in GenesisTools" on a diff file).
    var reveal: String?
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
    /// Opens the notification rules panel (`--rules`, Hub/HubRules.swift).
    var rules = false
    /// Opens the ⌘⇧P prompt picker (`--prompts`, Hub/HubPrompts.swift) and the handoff composer for
    /// the `--session` session (`--handoff`, Hub/HubHandoffComposer.swift).
    var prompts = false
    var handoff = false
    var widgetDestination: String?
    var widgetContext: String?
    var widgetCwd: String?
    var widgetProvider: String?
    /// Selects this worktree path in the Worktrees mode, or the cleanup panel (`--worktree cleanup`).
    var worktree: String?
    /// Inbox mode: opens the resume dialog (`--inbox-resume <id>`) or the session info popover
    /// (`--inbox-info <id>`) for this session (id or prefix) once the list has loaded; for snapshots.
    var inboxResume: String?
    var inboxInfo: String?
    /// Inbox mode: selects and scrolls to this card, a decision or todo (`--decision d_3_<session>`) or
    /// a pending form (`--question ask_…`). A question banner's click sends it (src/question/lib/hub-link.ts).
    var inboxItem: String?
    /// Activity: runs this row's action once the feed holds it (`--timeline-open <event id>`, with
    /// `--timeline-action diff` for a review comment's "Open in the diff"), else the row's click.
    var timelineOpen: String?
    var timelineAction: String?
    /// `--set <key>=<true|false>`: a setting of the scratch copy a scripted run starts from (the PR
    /// threads list open: `--set review.prThreads.open=true`). Never written to the live settings.
    var settings: [String: Bool] = [:]
    /// `--set <key>=<text>` for any other value (`--set hub.timeline.range=last30`).
    var textSettings: [String: String] = [:]
    /// `--menu "<Menu>/<Item>"`: runs that menu bar item once the hub has settled, as a click would
    /// (`--menu "Go/Pull Request…"` opens the palette with "pr " typed). Verifies the menu in a snapshot.
    var menu: String?
    var activate = true

    /// The file `--reveal` names, in the PR `--pr` names.
    var prReveal: PRReveal? {
        guard let pr, let reveal, !reveal.isEmpty else { return nil }
        return PRReveal(ref: pr, path: reveal, threadID: nil)
    }

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
            case "--agent": agent = value; index += 1
            case "--pr": pr = value.flatMap(HubPRRef.init); index += 1
            case "--reveal": reveal = value; index += 1
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
            case "--rules": rules = true
            case "--prompts": prompts = true
            case "--handoff": handoff = true
            case "--widget-destination": widgetDestination = value; index += 1
            case "--widget-context": widgetContext = value; index += 1
            case "--widget-cwd": widgetCwd = value; index += 1
            case "--widget-provider": widgetProvider = value; index += 1
            case "--worktree": worktree = value; index += 1
            case "--inbox-resume": inboxResume = value; index += 1
            case "--inbox-info": inboxInfo = value; index += 1
            case "--decision", "--question": inboxItem = value; index += 1
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
            case "--menu": menu = value; index += 1
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

    /// The flags a link may carry. Never `--snapshot`, `--bench`, `--set` or `--menu`: a link is a place to
    /// show, not a file to write or a command to run.
    static let linkKeys: Set<String> = ["mode", "session", "agent", "pr", "reveal", "tab", "filter", "worktree", "decision", "question"]

    /// `genesis-tools://hub?session=<parent>&agent=<child>` (any of `linkKeys`) as `--hub` arguments, the
    /// same ones `tools hub open` passes; nil for any other URL.
    static func arguments(fromLink raw: String) -> [String]? {
        guard let components = URLComponents(string: raw), components.scheme == "genesis-tools", components.host == "hub" else { return nil }
        var args: [String] = []
        for item in components.queryItems ?? [] where linkKeys.contains(item.name) {
            guard let value = item.value, !value.isEmpty else { continue }
            args += ["--\(item.name)", value]
        }
        return args
    }
}

func runHub(_ args: [String]) -> Never {
    PerfLog.phase("hub.launch")
    // `--resume` (a rebuild's relaunch) opens the place the hub last showed (Hub/HubPlace.swift).
    let args = HubPlace.expand(args)
    let request = HubRequest(args)
    let snapshotPath = request.snapshotPath
    let wantedSession = request.session
    let wantedPR = request.pr
    let tab = request.tab ?? .transcript
    // `--pr` alone means the PRs mode, as it does for a request handed to a running hub (`apply`).
    let mode = request.mode ?? (request.agent != nil ? .agents : request.pr != nil ? .prs : request.inboxItem != nil ? .inbox : .sessions)
    let activate = request.activate
    if !request.isScripted, !HubSingleInstance.claim() {
        exit(HubSingleInstance.forwardToRunningHub(args) ? 0 : 1)
    }
    if request.isScripted {
        HubDefaults.isolate()
        // An embedded review re-anchors and saves comments; a scripted run must not touch the user's file.
        ReviewCommentStore.readOnly = true
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
    if !request.isScripted {
        installNotificationClicksForWindowFace()
    }

    let model = HubModel(wantedSession: wantedSession, tab: tab)
    MainActor.assumeIsolated {
        AppMainMenu.install(hub: model)
    }
    model.initialMode = mode
    if let panes = request.panes { model.panes = panes }
    if let worktree = request.worktree {
        model.selectedWorktree = WorktreeCleanup.selection(for: worktree)
    }
    model.applyOverlays(request)
    MainActor.assumeIsolated {
        if let agent = request.agent {
            model.agents.request(parent: request.session, child: agent)
        } else if mode == .agents, let session = request.session {
            // `--mode agents --session <p>` opens that session's Main row.
            model.agents.request(parent: session, child: AgentTree.mainChild)
        }
        if let wantedPR {
            model.prs.request(wantedPR, reveal: request.prReveal)
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
    // The title bar strip zooms on a double-click and drags the window (WindowTitlebar.swift).
    window.contentView = HubGlass.makeContentView(root: HubRootView(model: model).defaultAppStorage(HubDefaults.store).titlebarZone())
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
    delegate.window = window
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
                        // A modal panel covers the diff: the web view's own image, drawn last, showed through it.
                        let covered = request.digest || request.rules || request.prompts || request.handoff
                            || request.sessionSearch != nil || request.palette != nil || request.find != nil
                        if let rows = HubBench.transcriptRowsLine(in: window) {
                            PerfLog.mark("hub.snapshot \(rows)")
                            FileHandle.standardError.write(Data("hub snapshot: \(rows)\n".utf8))
                        }
                        // Where a click on the title bar row lands: the empty strip must reach the zone, no
                        // control may start under the traffic lights or the title, and a mode with a header
                        // has its first row up there with no empty band under it. A modal panel's dim layer
                        // covers the strip on purpose.
                        let titlebar = (covered ? "(a modal panel covers it) " : "")
                            + WindowTitlebar.audit(window, expectsRow: model.showsTitlebarHeader).line
                        PerfLog.mark("hub.snapshot titlebar \(titlebar)")
                        FileHandle.standardError.write(Data("hub snapshot: titlebar \(titlebar)\n".utf8))
                        ReviewSnapshot.write(window: window, webView: showsDiff && !covered ? web : nil, to: snapshotPath) {
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
            if let path = later.menu {
                MainActor.assumeIsolated { AppMainMenu.perform(path) }
            }
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
        FrameWatch.start()
        HubStallTest.scheduleIfRequested()
        if !request.isScripted {
            HubNavInput.install(window: window, model: model)
        }
    }
    // `--menu` runs once the hub has settled on its mode and selection, as it does for a request
    // forwarded to a running hub: right after the model was made, File/New Agent Session had no folder
    // and the diff commands no review. Before the snapshot or bench, which run on the same signal.
    if let path = request.menu {
        let settled = model.onSettled
        var performed = false
        model.onSettled = {
            if !performed {
                performed = true
                MainActor.assumeIsolated { AppMainMenu.perform(path) }
            }
            settled?()
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
    weak var window: NSWindow?

    /// A local `.html` file Launch Services handed to this running face (LocalFileHandoff).
    func application(_ application: NSApplication, open urls: [URL]) {
        LocalFileHandoff.deliver(urls)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    /// A click on the Dock tile (or the app in the switcher with no window up) brings the hub back
    /// (Sources/App/AppDock.swift).
    @MainActor
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        AppDock.reopenHub(window)
    }

    @MainActor
    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        AppDock.menu(hubWindow: window)
    }
}

/// What the left column lists: agent sessions, the worktrees (branches) they worked in, PRs, the
/// sessions waiting for an answer (Hub/HubInbox.swift), or today's activity (Hub/HubTimeline.swift).
enum HubMode: String, CaseIterable {
    case sessions, worktrees, prs, inbox, timeline, agents

    var title: String {
        switch self {
        case .sessions: return "Sessions"
        case .worktrees: return "Worktrees"
        case .prs: return "PRs"
        case .inbox: return "Inbox"
        case .timeline: return "Activity"
        case .agents: return "Agents"
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
        case .agents: return "Agents: every session's sub-agents, teammates and codex or grok workers, live, each with its whole transcript"
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
        didSet {
            worktreeSessions = nil
            sessionSearchText = Dictionary(sessions.map { ($0.id, Self.searchText($0)) }, uniquingKeysWith: { first, _ in first })
        }
    }
    private var sessionSearchText: [String: String] = [:]
    @Published var loadingSessions = false
    /// The list on screen is the last run's, from disk, and the fresh one is loading (Hub/HubSWR.swift).
    @Published private(set) var showingCachedSessions = false
    /// Sessions the last refresh added or moved; their rows flash once.
    @Published private(set) var changedSessions = Set<String>()
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
    @Published var review: ReviewModel? {
        // A worktree or a timeline commit that replaces the session's review makes the next click on that
        // session set it up again, or the Changes pane kept the worktree's or the commit's diff.
        didSet {
            if review !== sessionReview {
                selectedSetUp = nil
            }
        }
    }
    /// The review `select` built for the selected session.
    private weak var sessionReview: ReviewModel?
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
    private var sessionsGeneration = 0
    private var didSettleLaunch = false
    var readSessions: (Int) async throws -> [HubSession] = { try await HubSource.sessions(hours: $0) }
    var readSessionCache: (Int) async -> [HubSession]? = { await HubSessionListCache.read(hours: $0) }
    var writeSessionCache: ([HubSession], Int) -> Void = { HubSessionListCache.write($0, hours: $1) }
    var readTranscript: (HubSession, Int) async throws -> TranscriptEnvelope = { try await HubSource.transcript($0, limit: $1) }
    var readDecisions: (String) throws -> SessionDecisionsEnvelope = {
        try JSONDecoder().decode(SessionDecisionsEnvelope.self, from: ToolsCLIRunner.run(["question", "inbox", "--session", $0, "--json"]))
    }
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
    /// Agents mode state (`tools hub agents`), Hub/HubAgents.swift.
    let agents: HubAgentsModel

    init(wantedSession: String?, tab: HubTab) {
        prs = MainActor.assumeIsolated { PRsModel() }
        inbox = MainActor.assumeIsolated { HubInboxModel() }
        timeline = MainActor.assumeIsolated { HubTimelineModel() }
        agents = MainActor.assumeIsolated { HubAgentsModel() }
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
            agents.$selectedID.map { _ in () }.eraseToAnyPublisher(),
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
            MainActor.assumeIsolated { HubPlace.record(self.navEntry, tab: self.tab) }
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
        case .agents: return HubNavEntry(mode: .agents, selection: agents.selectedID ?? Self.wholeList)
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
            case .agents:
                if id != Self.wholeList, let key = AgentTree.split(id) {
                    agents.select(parent: key.parent, child: key.child)
                }
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
        case .agents:
            name = id == Self.wholeList ? "Agents" : agents.selectedMain.map { "main of " + $0.displayTitle } ?? ("agent " + (agents.selected?.node.title ?? String((AgentTree.split(id)?.child ?? id).prefix(12))))
        }
        return name.count > 70 ? String(name.prefix(69)) + "…" : name
    }

    var selected: HubSession? {
        sessions.first { $0.id == selectedID } ?? leadOutsideList.flatMap { $0.id == selectedID ? $0 : nil }
    }

    /// The Agents mode's lead session when the Sessions list does not hold it (older than the list's window).
    private var leadOutsideList: HubSession?

    /// The Agents mode's detail: its lead session becomes the selected one, so the Changes, Files and
    /// Decisions panes (and "Open diff") work on it exactly as in Sessions mode.
    func selectLead(_ session: HubSession) {
        // Replaced on every pick, so no stale snapshot of an earlier lead outlives the next one.
        leadOutsideList = sessions.contains(where: { $0.id == session.id }) ? nil : session
        select(session.id)
    }

    var filtered: [HubSession] {
        let needle = filter.trimmed.lowercased()
        guard !needle.isEmpty else { return sessions }
        return sessions.filter { sessionSearchText[$0.id]?.contains(needle) == true }
    }

    static func searchText(_ row: HubSession) -> String {
        [row.displayTitle, row.project ?? "", row.account ?? "", row.provider, row.sessionId, row.cwd]
            .joined(separator: " ").lowercased()
    }

    static func timeGroups(_ rows: [HubSession], now: Date) -> [(title: String, rows: [HubSession], managed: Bool)] {
        var live: [HubSession] = [], today: [HubSession] = [], earlier: [HubSession] = []
        let calendar = Calendar.current
        for row in rows {
            if row.isLive(at: now) { live.append(row) }
            else if calendar.isDate(row.lastActivity ?? .distantPast, inSameDayAs: now) { today.append(row) }
            else { earlier.append(row) }
        }
        return [("Live", live, false), ("Today", today, false), ("Earlier", earlier, false)].filter { !$0.1.isEmpty }
    }

    func setMode(_ next: HubMode) {
        didSettleLaunch = true
        // A switch costs the renders after it: the old mode's views go and the new mode's arrive.
        MainActor.assumeIsolated { HubMainBusy.measure("mode.\(next.rawValue)") }
        let previous = mode
        mode = next
        MainActor.assumeIsolated {
            if next == .agents {
                agents.activate()
                // One screen with two sidebars: the session open in Sessions stays open, as its Main row
                // (Martin, 2026-10-01). An agent of that same session that was open stays open.
                if previous == .sessions, let session = selected, session.provider == MonitorSessionRow.claudeProvider,
                   agents.selectedParent?.sessionId != session.sessionId {
                    agents.request(parent: session.sessionId, child: AgentTree.mainChild)
                    if !agents.parents.contains(where: { $0.sessionId == session.sessionId }) {
                        agents.refresh(sessions: [session.sessionId])
                    }
                }
            } else {
                agents.deactivate()
            }
        }
        if next == .inbox {
            MainActor.assumeIsolated { inbox.loadIfStale() }
        }
        if next == .timeline {
            MainActor.assumeIsolated { timeline.loadIfStale() }
        }
        if next == .prs {
            MainActor.assumeIsolated { loadPRsIfNeeded() }
        }
        if next == .worktrees && worktrees.isEmpty && !loadingWorktrees {
            loadingWorktrees = true
            let sessions = sessions
            // The worktree a link asked for is discovered with the session folders, whatever its repo.
            let extra = selectedWorktree.flatMap { $0 == WorktreeCleanup.selectionID ? nil : [$0] } ?? []
            DispatchQueue.global(qos: .userInitiated).async {
                let span = HubPerf.begin("worktrees.discover", "\(sessions.count) sessions")
                // The last run's worktrees paint while git answers again (Hub/HubSWR.swift).
                if let cached = WorktreeDiscovery.cached(), !cached.isEmpty {
                    DispatchQueue.main.async { [weak self] in
                        guard let self, self.loadingWorktrees, self.worktrees.isEmpty else { return }
                        HubSWR.painted("worktrees.discover", "\(cached.count) worktrees")
                        self.worktrees = cached
                        if self.selectedWorktree == nil,
                           let busiest = cached.max(by: { self.sessionCount(for: $0) < self.sessionCount(for: $1) }) {
                            self.selectWorktree(busiest)
                        }
                    }
                }
                let found = WorktreeDiscovery.discover(sessions: sessions, extra: extra)
                span.end("\(found.count) worktrees")
                WorktreeDiscovery.save(found)
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    if self.worktrees != found {
                        withAnimation(SWR.animation) { self.worktrees = found }
                    }
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
        if review?.home.path != worktree.path {
            let next = ReviewModel(repo: URL(fileURLWithPath: worktree.path), options: DiffViewOptions.remembered(), session: sessions(for: worktree).first?.sessionId)
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
        let owned = session.id == selectedID
        var capturedTranscript = owned ? transcript : []
        var capturedTotals = owned ? transcriptTotals : nil
        let capturedFiles = owned && review?.session == session.sessionId ? review?.files ?? [] : []
        let capturedDecisions = owned ? decisions : []
        if capturedTranscript.isEmpty, let envelope = try? await readTranscript(session, Self.pageSize) {
            capturedTranscript = TranscriptTimeline.build(envelope.turns)
            capturedTotals = envelope.totals?.summary
        }
        var turns: [[String: Any]] = []
        for item in capturedTranscript.suffix(12) {
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
                "last activity": HubFormat.ago(session.lastActivity), "tokens": capturedTotals ?? "",
            ],
            "changed files": capturedFiles.map { ["path": $0.path, "added": $0.additions, "removed": $0.deletions] as [String: Any] },
            "decisions": capturedDecisions.map { ["number": $0.number, "title": $0.title, "status": $0.status, "answer": $0.draftOption ?? ""] as [String: Any] },
            "recent turns": turns,
        ]
        return await HubMarkdownExport.export(title: session.displayTitle, payload: payload, fileStem: "session-\(session.sessionId.prefix(8))")
    }

    func loadSessions() {
        sessionsGeneration += 1
        let generation = sessionsGeneration
        loadingSessions = true
        let hours = Self.recentHours
        Task { @MainActor in
            let fetch = Task { try await readSessions(hours) }
            // The last run's list paints at once and the window settles on it, unless a scripted
            // `--session` names one it does not hold; the fresh list then slides in behind it.
            if sessions.isEmpty, let cached = await readSessionCache(hours), !cached.isEmpty,
               sessions.isEmpty, generation == sessionsGeneration {
                HubSWR.painted("sessions.list", "\(cached.count) sessions")
                showingCachedSessions = true
                applySessions(cached)
                // Worktrees mode discovers from the session list once, so it settles on the fresh rows only.
                if initialMode != .worktrees,
                   wantedSession == nil || wantedSession == AgentProcs.selectionID || wantedSessionRow != nil {
                    settleSessions()
                }
            }
            do {
                let rows = try await fetch.value
                guard generation == sessionsGeneration else { return }
                PerfLog.markOnce("hub.sessions.first-loaded")
                loadingSessions = false
                showingCachedSessions = false
                writeSessionCache(rows, hours)
                applySessions(rows)
                settleSessions()
                resolvePendingSession(fresh: true)
            } catch {
                guard generation == sessionsGeneration else { return }
                loadingSessions = false
                showingCachedSessions = false
                self.error = "\(error)"
                if !didSettleLaunch {
                    onSettled?()
                }
            }
        }
    }

    /// A `--session` a running hub got before its list held it; selected by the next list that does.
    private var pendingSession: String?

    /// After a list landed: the pending session, when it is there now; else, on the fresh list, says so.
    @MainActor
    private func resolvePendingSession(fresh: Bool) {
        guard let wanted = pendingSession else { return }
        if let match = sessions.first(where: { $0.id == wanted || $0.sessionId.hasPrefix(wanted) }) {
            pendingSession = nil
            select(match.id)
        } else if fresh {
            pendingSession = nil
            openOlderSession(wanted, settle: false)
        }
    }

    /// How far back a session asked for by id is looked for when the list's window does not hold it.
    static let olderSessionHours = 24 * 30
    private var olderSessionRequest = 0

    /// A session asked for by id (`--session`, a link, Agent processes) that the list's last
    /// `recentHours` do not hold: the list is asked once for the last 30 days, and the session joins
    /// the list and opens. Not found, it says so. It used to open the newest session instead, saying
    /// nothing (`settle`: a launch that must still settle on something).
    @MainActor
    func openOlderSession(_ wanted: String, settle: Bool) {
        HubPerf.log("sessions.older \(wanted.prefix(8))")
        olderSessionRequest += 1
        let request = olderSessionRequest
        let modeAtStart = mode
        let selectionAtStart = selectedID
        Task { @MainActor in
            let rows = (try? await HubSource.sessions(hours: Self.olderSessionHours)) ?? []
            // A newer lookup owns the navigation now, and a reader who picked another session or mode while
            // this one ran must not be pulled back. A launch lookup (`settle`) has nobody to be pulled from.
            guard request == olderSessionRequest, settle || (mode == modeAtStart && selectedID == selectionAtStart) else {
                HubPerf.log("sessions.older \(wanted.prefix(8)) superseded")
                return
            }
            if let match = rows.first(where: { $0.id == wanted || $0.sessionId.hasPrefix(wanted) }) {
                if !sessions.contains(where: { $0.id == match.id }) {
                    sessions.append(match)
                }
                setMode(.sessions)
                select(match.id)
                return
            }

            notice = "No session \(wanted.prefix(8)) in the last \(Self.olderSessionHours / 24) days"
            if settle {
                if let first = sessions.first {
                    select(first.id)
                } else {
                    onSettled?()
                }
            }
        }
    }

    /// A worktree a link or the browser extension names that the list does not hold (its repository
    /// has no recent session): its repository's worktrees join the list, so it opens instead of
    /// "Pick a worktree" with no word about what was asked for.
    @MainActor
    func addWorktreesIfMissing(_ path: String) {
        guard !worktrees.isEmpty, !worktrees.contains(where: { $0.path == path }), FileManager.default.fileExists(atPath: path) else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            let found = WorktreeDiscovery.discover(sessions: [], extra: [path])
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let added = found.filter { row in !self.worktrees.contains { $0.path == row.path } }
                if !added.isEmpty {
                    withAnimation(SWR.animation) { self.worktrees += added }
                }
                if !self.worktrees.contains(where: { $0.path == path }) {
                    self.error = "\(path) is not a git worktree"
                }
            }
        }
    }

    private var wantedSessionRow: HubSession? {
        wantedSession.flatMap { wanted in
            sessions.first { $0.id == wanted || $0.sessionId.hasPrefix(wanted) }
        }
    }

    /// Shows `rows`, sliding new ones in; over a list already on screen, the new and moved ones flash.
    @MainActor
    private func applySessions(_ rows: [HubSession]) {
        var fresh = rows
            .filter { !($0.archived ?? false) }
            .sorted { $0.mtime > $1.mtime }
        // A session opened from search or the digest (older than the list's window) stays while
        // it is selected, or the detail pane would go blank on the next load.
        if let current = selected, !fresh.contains(where: { $0.id == current.id }) {
            fresh.append(current)
            fresh.sort { $0.mtime > $1.mtime }
        }
        guard fresh != sessions else { return }
        let before = Dictionary(sessions.map { ($0.id, "\($0.mtime)") }, uniquingKeysWith: { first, _ in first })
        let moved = SWR.changed(before: before, after: fresh.map { ($0.id, "\($0.mtime)") })
        withAnimation(SWR.animation) {
            sessions = fresh
            changedSessions = moved
        }
        SWR.fade(moved, current: { [weak self] in self?.changedSessions }, clear: { [weak self] in self?.changedSessions = [] })
    }

    /// The first selection after a load: the scripted mode or session, else the newest session.
    private func settleSessions() {
        guard !didSettleLaunch else { return }
        didSettleLaunch = true
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
        } else if initialMode == .agents {
            MainActor.assumeIsolated {
                // A wanted child settles on its transcript's first page; the list alone settles here.
                if agents.selectedID == nil {
                    agents.onLoaded = { [weak self] in
                        guard let self, self.agents.selectedID == nil else { return }
                        self.onSettled?()
                        self.onSettled = nil
                    }
                }
            }
            setMode(.agents)
        } else if initialMode == .inbox || initialMode == .timeline {
            let settle: () -> Void = { [weak self] in
                self?.onSettled?()
                self?.onSettled = nil
            }
            MainActor.assumeIsolated {
                if initialMode == .inbox { inbox.onLoaded = settle } else { timeline.onLoaded = settle }
            }
            setMode(initialMode)
        } else if wantedSession == AgentProcs.selectionID {
            // `--session ::procs` opens the Agent processes pane, which has no transcript to settle on.
            select(AgentProcs.selectionID)
            onSettled?()
            onSettled = nil
        } else if let wanted = wantedSession, wantedSessionRow == nil {
            MainActor.assumeIsolated { openOlderSession(wanted, settle: true) }
        } else if let first = wantedSessionRow ?? sessions.first {
            select(first.id)
        } else {
            onSettled?()
        }
    }

    /// The PR list of every session project, once: the PRs mode and the palette's "pr" both read it.
    @MainActor
    func loadPRsIfNeeded() {
        // Project discovery does not depend on the session roots: with none, no list load would start it.
        prs.loadProjectsIfNeeded()
        if prs.loading { return }
        guard prs.prs.isEmpty else {
            answerWithoutLoad()
            return
        }
        // One path per project; worktrees and clones of one origin collapse server-side.
        let roots = Array(Set(sessions.map(\.cwd).filter { !$0.isEmpty && FileManager.default.fileExists(atPath: $0) }.map(projectRoot(of:)))).sorted()
        // An empty list for the same projects is an answer (no open PR), not a reason for another
        // `tools hub pr list` on every ⌘K; nothing to ask before the sessions arrive.
        guard !roots.isEmpty, roots != prRootsRequested else {
            answerWithoutLoad()
            return
        }
        prRootsRequested = roots
        prs.load(paths: roots)
    }

    /// No PR load starts: whoever waits for the list's answer (the window's settle, a deferred `--menu`
    /// action) hears now, instead of waiting for a load that never comes (no project roots, say).
    @MainActor
    private func answerWithoutLoad() {
        guard let done = prs.onLoaded else { return }
        prs.onLoaded = nil
        done()
    }

    /// The projects the PR list was last asked for by `loadPRsIfNeeded`.
    private var prRootsRequested: [String]?

    /// What the command palette can name: projects, sessions, PRs and worktrees the hub already knows.
    @MainActor
    var paletteContext: HubPaletteContext {
        HubPaletteContext(
            projects: HubPaletteEngine.projects(sessions: sessions, worktrees: worktrees),
            sessions: sessions,
            prs: prs.prs,
            prsLoaded: prRootsRequested != nil && !prs.loading,
            worktrees: worktrees,
            currentPath: paletteCurrentPath
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

    /// The folder the File menu's Cursor / cmux / New session and the palette's commands act on: the
    /// worktree or PR on screen in those modes, else the selected session's project. Only the session
    /// was read, so in Worktrees mode they opened the wrong folder or refused.
    @MainActor
    private var paletteCurrentPath: String? {
        if mode == .worktrees, let path = selectedWorktree, path != WorktreeCleanup.selectionID {
            return path
        }
        if mode == .prs, let path = prs.selected?.localWorktree ?? prs.selected?.repoRoot {
            return path
        }
        return selected.map { $0.cwd.isEmpty ? nil : projectRoot(of: $0.cwd) } ?? nil
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
            // openInTerminal blocks on the terminal host's CLI (up to its timeout): never on the main actor.
            let name = (path as NSString).lastPathComponent
            let starting = "Starting a new Claude session in \(name)…"
            notice = starting
            Task.detached(priority: .userInitiated) {
                let failure = AgentLauncher.openInTerminal(name: name, cwd: path, command: ["tools", "claude", "run"])
                // Only over its own "Starting…" line: a newer notice (a copied id, say) stays on screen.
                await MainActor.run {
                    if self.notice == starting {
                        self.notice = failure ?? "Started a new Claude session in \(name)."
                    }
                }
            }
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
        if let mode = request.widgetDestination, ["new", "resume"].contains(mode) {
            MainActor.assumeIsolated {
                HubWidgetDestinationStore.shared.request = HubWidgetDestinationRequest(
                    mode: mode, session: request.session, provider: request.widgetProvider,
                    context: request.widgetContext, cwd: request.widgetCwd)
            }
        }
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
        if request.sessionSearch != nil || request.digest || request.rules {
            MainActor.assumeIsolated {
                if let text = request.sessionSearch { HubDailyModel.shared.searchQuery = text }
                if request.digest { HubDailyModel.shared.digestOpen = true }
                if request.rules { HubDailyModel.shared.rulesOpen = true }
            }
        }
        if request.prompts || request.handoff {
            MainActor.assumeIsolated {
                if request.prompts { PromptLibraryStore.shared.pickerOpen = true }
                // Resolved now to a real session: the --session prefix, else the selected one; with neither,
                // nothing is queued (a wildcard would open on whatever session showed up next).
                if request.handoff {
                    if let target = request.session ?? selectedID {
                        HubHandoffRequests.shared.pending = target
                    } else if sessions.isEmpty {
                        // A fresh launch applies its flags before the first list loads.
                        HubHandoffRequests.shared.pending = HubHandoffRequests.firstSelection
                    } else {
                        notice = "No session to hand off: select one, or pass --session."
                    }
                }
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
        } else if let id = request.inboxItem {
            MainActor.assumeIsolated {
                inbox.reveal = .item(id)
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
        // A request that navigates owns the navigation from here on. An older-session lookup still waiting for
        // its list must not select its session over it, whether the request resolves from the list, waits for a
        // fresher one or only changes the mode.
        if request.session != nil || request.mode != nil || request.agent != nil || request.worktree != nil {
            olderSessionRequest += 1
        }
        if let tab = request.tab {
            self.tab = tab
        }
        if let agent = request.agent {
            setMode(.agents)
            MainActor.assumeIsolated { agents.request(parent: request.session, child: agent) }
        } else if request.mode == .agents, let session = request.session {
            setMode(.agents)
            MainActor.assumeIsolated { agents.request(parent: session, child: AgentTree.mainChild) }
        } else if request.session == AgentProcs.selectionID {
            setMode(.sessions)
            select(AgentProcs.selectionID)
        } else if let wanted = request.session, let match = sessions.first(where: { $0.id == wanted || $0.sessionId.hasPrefix(wanted) }) {
            setMode(.sessions)
            select(match.id)
        } else if let wanted = request.session {
            // A session newer than the list (started after this window opened): the list is asked
            // again and selects it when it lands. Matched once and dropped, it did nothing at all.
            setMode(.sessions)
            pendingSession = wanted
            loadSessions()
        } else if let mode = request.mode {
            setMode(mode)
        } else if request.inboxItem != nil {
            setMode(.inbox)
        }
        if let worktree = request.worktree {
            setMode(.worktrees)
            selectedWorktree = WorktreeCleanup.selection(for: worktree)
            MainActor.assumeIsolated { addWorktreesIfMissing(worktree) }
        }
        if let ref = request.pr {
            MainActor.assumeIsolated { prs.request(ref, reveal: request.prReveal) }
            if request.mode == nil {
                setMode(.prs)
            }
        }
    }

    func select(_ id: String) {
        // Again for the same session only after a failed load: the transcript list stays empty while the
        // transcript pane is open, so it can no longer tell whether this session was set up.
        guard id != selectedSetUp || transcriptError != nil else { return }
        didSettleLaunch = true
        transcriptGeneration += 1
        loadingTranscript = false
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
        let moved = session.cwd.isEmpty ? nil : MovedCheckout.resolve(session.cwd)
        let cwd = moved ?? session.cwd
        if !cwd.isEmpty, FileManager.default.fileExists(atPath: cwd) {
            // The session too: two agents in one checkout share the folder, and "Send to agent" targets `review.session`.
            // `home`, not `repo`: the Worktree choice moves `repo` to another checkout, and comparing that with
            // the session's folder made every refresh build a new review on the main checkout again.
            if review?.home.path != cwd || review?.session != session.sessionId {
                let next = ReviewModel(repo: URL(fileURLWithPath: cwd), options: DiffViewOptions.remembered(), session: session.sessionId)
                next.embedded = true
                let worktreeKey = "hub.reviewWorktree.\(session.sessionId)"
                if let picked = HubDefaults.store.string(forKey: worktreeKey), FileManager.default.fileExists(atPath: picked) {
                    next.switchWorktree(to: picked)
                }
                next.onWorktreeChange = { url in
                    HubDefaults.store.set(url.path == cwd ? nil : url.path, forKey: worktreeKey)
                }
                if moved != nil {
                    let from = (session.cwd as NSString).abbreviatingWithTildeInPath
                    next.notice = "\(from) holds no repository, so this shows \((cwd as NSString).abbreviatingWithTildeInPath), the checkout of the same name"
                }
                sessionReview = next
                review = next
            } else {
                sessionReview = review
            }
        } else {
            sessionReview = nil
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
                let envelope = try await readTranscript(session, limit)
                guard generation == transcriptGeneration, selectedID == session.id else { return }
                transcript = HubPerf.measure("transcript.timeline", "\(envelope.turns.count) turns") {
                    TranscriptTimeline.build(envelope.turns)
                }
                transcriptTruncated = envelope.truncated
                transcriptTotals = envelope.totals?.summary
                transcriptEnded = envelope.terminated
                transcriptError = nil
            } catch {
                guard generation == transcriptGeneration, selectedID == session.id else { return }
                transcriptError = "\(error)"
            }
            loadingTranscript = false
            onSettled?()
            onSettled = nil
        }
    }
}

// MARK: - Views

/// The palette re-reads the PR list when it lands: in a fresh window "gt pr" said to open the PRs mode first.
private struct HubPaletteHost: View {
    @ObservedObject var model: HubModel
    @ObservedObject var prs: PRsModel
    @Binding var isPresented: Bool
    let seed: String
    let toggleGlass: () -> Void

    var body: some View {
        HubPaletteView(isPresented: $isPresented, context: model.paletteContext, initialQuery: seed) { action in
            model.runPalette(action) { toggleGlass() }
        }
        .onAppear { model.loadPRsIfNeeded() }
    }
}

struct HubRootView: View {
    @ObservedObject var model: HubModel

    /// The open screen in words: mode, what is selected, and the session panes.
    private var perfArea: String {
        var parts = [model.mode.rawValue]
        switch model.mode {
        case .agents:
            if let node = model.agents.selected?.node {
                parts.append("agent " + String(node.title.prefix(40)))
            } else if let parent = model.agents.selectedMain {
                parts.append("main " + String(parent.displayTitle.prefix(40)))
            }
        case .sessions:
            if let session = model.selected {
                parts.append(String(session.displayTitle.prefix(40)))
            }
        default:
            break
        }
        if model.mode == .agents || model.mode == .sessions {
            parts.append(model.tabOrder.filter { model.panes.contains($0) }.map(\.rawValue).joined(separator: ","))
        }
        return parts.joined(separator: " › ")
    }
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
        // An agent's transcript is the full session screen, as a session's transcript alone is.
        if model.mode == .agents { return model.agents.selected != nil || model.agents.selectedMain != nil ? 761 : 520 }
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
                               autoCollapse: width > 0 && sidebarRoom < Self.sidebarMinWidth,
                               // Sessions mode holds the layout for the transcript; every other
                               // mode's main view moves with the edge and reflows on release.
                               holdsLayout: model.mode == .sessions || model.mode == .agents,
                               holdsContent: model.mode == .prs && ProcessInfo.processInfo.environment["GENESIS_HUB_HOLD_CONTENT"] != "0") {
                SessionListView(model: model)
            }
            if model.mode == .prs {
                // Every main view outside Sessions mode moves with the sidebar's edge at once and
                // reflows on release: reflowed per step, a sidebar drag cost 1 to 15 ms more per step
                // than the held layout (`--bench`, 2026-09-30).
                PRsMain(model: model, prs: model.prs)
                    .freezesWidthWhileDragging(panel: "hub.sidebar")
            } else if model.mode == .inbox {
                // InboxMain with its ⌘F find (Hub/HubInboxFind.swift).
                InboxFindHost(model: model, inbox: model.inbox)
                    .freezesWidthWhileDragging(panel: "hub.sidebar")
            } else if model.mode == .timeline {
                TimelineMain(model: model, timeline: model.timeline)
                    .freezesWidthWhileDragging(panel: "hub.sidebar")
            } else if model.mode == .agents {
                // Held like Sessions: the transcript keeps its layout while the sidebar drags.
                AgentsMain(model: model, agents: model.agents)
            } else if model.mode == .worktrees {
                if let path = model.selectedWorktree, let worktree = model.worktrees.first(where: { $0.path == path }) {
                    WorktreeDetailView(model: model, worktree: worktree)
                        .freezesWidthWhileDragging(panel: "hub.sidebar")
                } else if model.selectedWorktree == WorktreeCleanup.selectionID, !model.loadingWorktrees {
                    WorktreeCleanupView(model: model)
                        .freezesWidthWhileDragging(panel: "hub.sidebar")
                } else if model.loadingWorktrees {
                    PaneSkeleton("Finding worktrees")
                } else {
                    Text("Pick a worktree")
                        .foregroundColor(ReviewPalette.dim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if model.selectedID == AgentProcs.selectionID {
                AgentProcsView(model: model)
            } else if let session = model.selected {
                SessionDetailView(model: model, session: session)
            } else if model.loadingSessions {
                TranscriptSkeleton()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                Text(model.error ?? "No sessions in the last \(HubModel.recentHours) hours")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .hubSurface(.content)
        .environment(\.hubGlass, glass)
        .preferredColorScheme(.dark)
        // Every stall and dropped-frame line in app-perf.log names this (GenesisKit Perf/PerfContext.swift).
        .task(id: perfArea) { PerfContext.area = perfArea }
        .measuredWidth("hub.root", $width)
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
                HubPaletteHost(model: model, prs: model.prs, isPresented: $paletteOpen, seed: paletteSeed) { glass.toggle() }
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
        // `tools hub --handoff`: the composer over every pane (Hub/HubHandoffComposer.swift).
        .hubHandoff(model: model)
        .widgetDestination(model: model)
    }
}

extension HubModel {
    /// The main view on screen has a `TitlebarHeader`, so its first row belongs in the title bar; an
    /// empty state ("Pick a PR or MR") has none. Follows the branches of `HubRootView.body`.
    @MainActor
    var showsTitlebarHeader: Bool {
        switch mode {
        case .prs: return prs.selected != nil
        case .inbox, .timeline: return true
        case .agents: return agents.selected != nil || agents.selectedMain != nil
        case .worktrees:
            return worktrees.contains { $0.path == selectedWorktree }
                || (selectedWorktree == WorktreeCleanup.selectionID && !loadingWorktrees)
        case .sessions: return selectedID == AgentProcs.selectionID || selected != nil
        }
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
        .inbox: "tray", .timeline: "clock", .agents: "person.2",
    ]

    /// The row's width; six titles need about 340 pt at the small control size.
    @State private var width: CGFloat = 360

    var body: some View {
        let icons = width < 340
        HStack(spacing: 1) {
            ForEach(HubMode.allCases, id: \.self) { mode in
                segment(mode, icons: icons)
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.white.opacity(0.06)))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(ReviewPalette.hairline))
        .frame(maxWidth: .infinity)
        .measuredWidth("hub.modes", $width)
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
        case .agents: return "Filter agents, sessions, models, accounts…"
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
            return HubModel.timeGroups(rows, now: Date())
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
                IconButton(systemName: "lock.shield", tooltip: "Permissions and settings (⌘,)") {
                    AppMenuTarget.shared.openSettings(nil)
                }
                .foregroundColor(ReviewPalette.dim)
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
                        RefreshingMark(showingCache: model.showingCachedSessions, what: "session list")
                    }
                }
                .frame(width: 16, height: 16)
                if model.mode == .sessions {
                    MenuButton(items: {
                        SessionGrouping.allCases.map { option in
                            .action(option.title, checked: option == mode) {
                                HubMainBusy.measure("sessions.grouping")
                                grouping = option.rawValue
                            }
                        }
                    }) {
                        Image(systemName: "rectangle.3.group")
                    }
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
            } else if model.mode == .agents {
                // Staging: the widget and Clicky entries exist only in the Preview app (main.swift).
                if NativePreview.enabled {
                    Button { WidgetLaunch.start() } label: {
                        Label("Widget sessions", systemImage: "rectangle.rightthird.inset.filled")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain).padding(.horizontal, 14).padding(.bottom, 9)
                    Button { ClickyLaunch.openSettings() } label: {
                        Label("Clicky", systemImage: "keyboard")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.plain).padding(.horizontal, 14).padding(.bottom, 9)
                }
                AgentsListView(model: model, agents: model.agents)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                        // Hub/HubAgentProcs.swift: every agent session's process tree, orphans first.
                        AgentProcsEntry(model: model)
                        if model.sessions.isEmpty, model.loadingSessions {
                            SkeletonRows(count: 10, leading: .avatar)
                                .skeletonShimmer()
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel("Loading sessions")
                        }
                        ForEach(sections, id: \.title) { section in
                            Section {
                                if !(section.managed && prefs.collapsed.contains(section.title)) {
                                    ForEach(section.rows) { session in
                                        SessionRowView(session: session, selected: session.id == model.selectedID, stuck: stuck.verdicts[session.sessionId])
                                            .rowButton { model.select(session.id) }
                                            .swrFlash(model.changedSessions.contains(session.id), cornerRadius: 6)
                                            .transition(SWR.rowTransition)
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
                                    PlainGroupHeader(title: section.title, count: section.rows.count)
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
                // The stuck badge sits by the title: on the meta line it squeezed the project and account to "Gene…".
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(session.displayTitle)
                        .font(.system(size: 12.5, weight: selected ? .semibold : .regular))
                        .lineLimit(2)
                    if let stuck {
                        Spacer(minLength: 0)
                        StuckBadge(verdict: stuck)
                    }
                }
                HStack(spacing: 6) {
                    if let project = session.project {
                        Text(project).layoutPriority(-2)
                    }
                    if let account = session.account {
                        Text(account)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().stroke(Color.white.opacity(0.15)))
                            .layoutPriority(-1)
                    }
                    Spacer(minLength: 0)
                    // Whole: the project and account truncate first, the age read "21 sec. a…" before.
                    LiveAgo(date: session.lastActivity, style: .brief).fixedSize()
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

/// The one session screen of Sessions and Agents mode: the transcript, Changes, Files and Decisions panes
/// on the selected session. The Agents mode passes `agent`: the transcript pane then shows that agent's
/// own file and the header its facts, while the other panes stay the lead session's.
struct SessionDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject private var repos = RepoFactsStore.shared
    @ObservedObject private var stuck = HubStuckStore.shared
    let session: HubSession
    var agent: AgentPaneContext?
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
                // One split view whatever the count: a pane that stays keeps its identity when another
                // opens or closes. A single pane used to be a different branch, so opening Files beside
                // the transcript made a new transcript, which loaded its page again and scrolled to the
                // latest turn (Martin, 2026-10-02: "when i open Files, the transcript always jumps").
                HSplitView {
                    ForEach(shown, id: \.self) { tab in
                        pane(tab)
                            .freezesWidthWhileResizing(heavy: tab == .transcript)
                            .frame(minWidth: tab.minPaneWidth, idealWidth: tab.idealPaneWidth, maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                // The side panels' grip, target and cursor on the split's bare 1 pt dividers too.
                .overlay(PaneDividerGrips())
                // The split view too: its frame changing per window-resize step made the root
                // hosting view rebuild the key view loop each step (72 ms with two panes).
                .freezesWidthWhileResizing()
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
            if let agent, agent.node != nil {
                if let row = agent.transcriptRow {
                    HubSessionDetailHost(session: row, onShowChange: { path, line in
                        model.showChange(path: path, line: line)
                    }, showsSidebar: model.panes.count == 1, agentChild: true)
                        .id(agent.key)
                } else {
                    Text("This agent has no transcript file")
                        .foregroundColor(ReviewPalette.dim)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else {
                HubSessionDetailHost(session: session, onShowChange: { path, line in
                    model.showChange(path: path, line: line)
                }, onOpenSubagent: { agent in
                    model.openSubagent(sessionId: session.sessionId, agentId: agent.id)
                }, showsSidebar: model.panes.count == 1, transcriptQuery: model.transcriptQuery)
                    .id(session.id)
            }
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

    /// The first row sits in the window's title bar, right of the traffic lights and the title, so the
    /// panes start right under the title bar (Martin, 2026-09-28). Its empty part zooms and drags the
    /// window (`TitlebarHeader`, `.titlebarZone()` on the root, WindowTitlebar.swift).
    @ViewBuilder
    private var header: some View {
        if let agent, let node = agent.node {
            agentHeader(agent, node: node)
        } else {
            sessionHeader
        }
    }

    /// An open agent: the way back to the lead, the agent's state, then the same pane buttons.
    private func agentHeader(_ agent: AgentPaneContext, node: AgentNode) -> some View {
        TitlebarHeader {
            HStack(spacing: 8) {
                AgentChildTitle(agents: agent.agents, parent: agent.parent, node: node)
                Spacer()
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.hasPrefix("cmux:") || notice.contains("failed") || notice.contains("not in")) { model.notice = nil }
                }
                paneToggles
                AgentCopyIdButton(model: model, node: node)
            }
        } details: {
            AgentChildDetails(agents: agent.agents, parent: agent.parent, node: node)
        }
    }

    private var sessionHeader: some View {
        TitlebarHeader(details: model.panes.contains(.transcript) ? nil : accountRow) {
            HStack(spacing: 10) {
                if !model.panes.contains(.transcript) {
                    Group {
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
                    }
                    .titlebarLabel()
                    if let verdict = stuck.verdicts[session.sessionId] {
                        StuckBadge(verdict: verdict)
                    }
                }
                Spacer()
                if model.panes.contains(.transcript) {
                    // The account row below hides with the transcript open; the forecast stays in sight.
                    // In a narrow window it gives way first, before the pane buttons' titles.
                    HubForecastChip(account: session.account)
                        .layoutPriority(-1)
                }
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.hasPrefix("cmux:") || notice.contains("failed")) { model.notice = nil }
                }
                paneToggles
                IconButton(systemName: "doc.richtext", tooltip: "Copy as Markdown (json2md): session, changes, decisions, recent turns") {
                    Task { @MainActor in model.notice = await model.exportSession(session) }
                }
            }
        }
    }

    /// Under the title bar row while the transcript is closed (the transcript shows the same facts).
    private var accountRow: some View {
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
