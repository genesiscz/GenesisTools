import AppKit
import SwiftUI

/// Hosts the shared session screen (GenesisKit Sessions/Detail/SessionDetailScreen.swift) for a
/// hub session. Modeled on Genesis's `SessionDetailsPane.swift` (branch
/// feat/2026-09-24-genesis-session-redesign): same paging, same off-main document build, same
/// liveness rules, with the hub's data (MonitorSessionRow) and ToolsBridge instead of MonitorModel.
struct HubSessionDetailHost: View {
    let session: HubSession
    /// A tool row's "Open diff": absolute path and line of the change.
    var onShowChange: ((String, Int?) -> Void)?
    /// False in a multi-pane layout: the screen's own sidebar starts folded to leave room.
    var showsSidebar = true
    /// Opens with this transcript search applied (`--transcript-query`, snapshots and links).
    var transcriptQuery: String?
    /// A sub-agent or worker opened from the Agents mode (Hub/HubAgents.swift): `session.sessionId` is the
    /// transcript's query for `tools ai sessions tail` (its file or worker name), not a session of its own,
    /// so the per-session extras (spend, sub-agent list, terminal, insights, resume) stay off.
    var agentChild = false
    static let pageSize = 150
    /// Viewport first: the newest turns only, so the first layout (which scrolls to the last row and so
    /// measures every row above it) handles a screenful instead of `pageSize` turns. A 172 MB session
    /// stalled the main thread 0.9–1.5 s at open with the whole window in one go.
    /// `GENESIS_HUB_FIRST_PAGE=150` restores the old one-shot window, for A/B measurements.
    static let firstPage = ProcessInfo.processInfo.environment["GENESIS_HUB_FIRST_PAGE"].flatMap(Int.init) ?? 12
    /// With `GENESIS_HUB_FILL=1` only: the rest of the window arrives in chunks of this many turns while
    /// the reader is idle. Off by default: each prepend made the List measure every row again, 1 to 3.6 s
    /// of main thread per step on a big session (6 steps, app-perf.log 2026-10-01 01:10), which read as
    /// "lags hard every few seconds" and a scroll jump under "Loading earlier turns…". Earlier turns
    /// now come only from the reader's "Load earlier turns".
    static let fillChunk = 24
    static let autoFill = ProcessInfo.processInfo.environment["GENESIS_HUB_FILL"] == "1"
    /// Posted when a window's first page has loaded or failed: a `--snapshot` or `--bench` run starts then.
    static let firstPageDone = Notification.Name("hub.transcript.firstPageDone")

    @State private var nativeLog: SessionNativeLog?
    @State private var services = TranscriptServices.none
    @State private var changeSource: ToolChangeSource?
    @State private var spend: HubSpend.Estimate?
    @State private var branch: String?
    /// The branch web page arrives from `tools hub repo` after the first draw.
    @ObservedObject private var repos = RepoFactsStore.shared
    /// The stuck-agent verdict for the header's alert line (Hub/HubStuck.swift).
    @ObservedObject private var stuck = HubStuckStore.shared

    @State private var envelope: TranscriptEnvelope?
    @State private var turns: [TranscriptTurn] = []
    @State private var windowStart = 0
    @State private var document = TranscriptDocument.empty
    @State private var digest = SessionActivityDigest.empty
    @State private var loadState: TranscriptLoadState = .loading
    @State private var loadingEarlier = false
    @State private var banner: String?
    @State private var loadID = 0
    /// The latest `rebuild()`; an older one that finishes later is dropped.
    @State private var buildID = 0
    /// ⌘F over the whole session: the window plus the earlier turns that match, while a query is on.
    @State private var searchDocument: TranscriptDocument?
    @State private var searchNote: String?
    @State private var searchID = 0
    /// Live tail: one `tools ai sessions tail --live` process per open detail sends each new or changed
    /// turn (Hub/HubTranscriptTail.swift). Stopped while the window is hidden or minimized.
    @State private var tail: HubTranscriptTail?
    /// The window this detail is in, for the hide and minimize pauses.
    @State private var host = HostWindow()
    /// Every sub-agent of the session from `tools ai sessions subagents` (its `subagents/` directory),
    /// with the state each one's own transcript shows. nil until the first read, or for a provider
    /// without one: the digest's rows from the loaded turns stand then.
    @State private var subagents: [SessionSubagent]?
    @State private var subagentsReadAt = Date.distantPast

    var body: some View {
        SessionDetailScreen(
            info: info,
            digest: shownDigest,
            document: searchDocument ?? document,
            loadState: loadState,
            hasEarlier: windowStart > 0 && searchDocument == nil,
            loadingEarlier: loadingEarlier,
            windowNote: searchNote ?? (windowStart > 0 ? envelope.map { "Turns \(windowStart + 1)–\($0.nextOffset)" } : nil),
            banner: banner,
            onLoadEarlier: { Task { await loadEarlier() } },
            onDismissBanner: { banner = nil },
            preset: TranscriptPreset(query: transcriptQuery ?? ""),
            leadingInset: 16,
            services: services,
            // `--set hub.session.sidebarFolded=true`: a snapshot of the folded sidebar in a single pane.
            showsSidebar: showsSidebar && !HubDefaults.store.bool(forKey: "hub.session.sidebarFolded"),
            // Cost per prompt and tool analytics sit under the usage grid, above a long sub-agent list.
            sidebarExtraFirst: true,
            actions: actions
        ) {
            if !agentChild {
                SessionTerminalSection(session: session)
                // Cost per prompt, tool analytics, handoff composer (Hub/HubSessionInsights.swift).
                SessionInsightsSection(session: session, turnCount: envelope?.nextOffset ?? 0)
            }
        }
        // A click in the transcript keeps ⌘F on its own search (Hub/HubPanelFind.swift).
        .panelFindNative("transcript")
        .background(HostWindowReader(host: host))
        // The follow process lives exactly as long as the detail is on screen.
        .onDisappear { stopTail() }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didHideNotification)) { _ in stopTail() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didMiniaturizeNotification)) { note in
            if note.object as? NSWindow === host.window { stopTail() }
        }
        .onReceive(NotificationCenter.default.publisher(for: NSApplication.didUnhideNotification)) { _ in resumeTail() }
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didDeminiaturizeNotification)) { note in
            if note.object as? NSWindow === host.window { resumeTail() }
        }
        // The sidebar asks for a turn: load the window holding it when it is earlier, then reveal it.
        .onReceive(NotificationCenter.default.publisher(for: TranscriptBus.request)) { note in
            if case .jump(let index, let rowId)? = TranscriptBus.message(note, for: TranscriptBus.request, sessionId: session.sessionId) {
                Task { await jump(toTurn: index, rowId: rowId) }
            }
        }
        .task(id: session.id) {
            tail?.stop()
            tail = nil
            envelope = nil
            turns = []
            windowStart = 0
            document = .empty
            digest = .empty
            nativeLog = nil
            services = .none
            subagents = nil
            subagentsReadAt = .distantPast
            // The last session's whole-session search: its result must not stay on screen, and one
            // still running must not land here.
            searchID += 1
            searchDocument = nil
            searchNote = nil
            spend = HubSpend.cached(session.sessionId)
            branch = Self.branch(of: session)
            loadState = .loading
            await load(offset: nil, limit: Self.firstPage)
            await refreshSubagents()
            if Self.autoFill {
                await fillWindow()
            }
            guard !agentChild else { return }
            let row = session
            let fresh = await Task.detached(priority: .utility) { HubSpend.fetch(row) }.value
            if let fresh, row.id == session.id {
                spend = fresh
            }
            // A working sub-agent writes its own file, not the session's: nothing else wakes the view.
            while !Task.isCancelled, subagents?.contains(where: { $0.state == .running }) == true {
                try? await Task.sleep(for: .seconds(20))
                await refreshSubagents()
            }
        }
    }

    /// The digest with the session's full sub-agent list, when there is one.
    private var shownDigest: SessionActivityDigest {
        guard let subagents, !subagents.isEmpty else { return digest }
        var merged = digest
        // A failed Agent call in the loaded turns is the one thing the directory cannot tell.
        let failed = Set(digest.subagents.filter { $0.state == .failed }.map(\.id))
        merged.subagents = subagents.map { agent in
            failed.contains(agent.id) ? SessionSubagent(id: agent.id, kind: agent.kind, summary: agent.summary, state: .failed) : agent
        }
        return merged
    }

    /// Off the main thread; at most once per 5 s (the live tail calls it on every append).
    private func refreshSubagents() async {
        guard !agentChild, session.provider == "claude", Date().timeIntervalSince(subagentsReadAt) >= 5 else { return }
        subagentsReadAt = Date()
        let id = session.id
        let sessionId = session.sessionId
        let listed = await Task.detached(priority: .utility) { HubSubagents.list(sessionId: sessionId) }.value
        guard id == session.id, let listed else { return }
        subagents = listed
    }

    // MARK: info

    private var info: SessionDetailInfo {
        let lastActivity = [session.lastActivity, document.lastAt].compactMap { $0 }.max()
        let pendingTool: Bool = {
            guard case .tool(let line)? = document.sections.last?.rows.last?.kind else { return false }
            return line.status == .pending
        }()
        let cacheCold = session.cacheStatus.map { $0 == .COLD }
        let inPane = session.cmux != nil
        let liveness = SessionLiveness.resolve(
            lastActivity: lastActivity,
            terminated: envelope?.terminated,
            pendingTool: pendingTool,
            cacheCold: cacheCold,
            inPane: inPane
        )

        var info = SessionDetailInfo(sessionId: session.sessionId, title: session.displayTitle, provider: AIProviders.meta(for: session.provider))
        info.account = session.account
        info.model = session.model
        info.modelSwitched = session.modelSwitched
        if !session.cwd.isEmpty {
            info.cwd = session.cwd
            info.cwdExists = FileManager.default.fileExists(atPath: session.cwd)
            info.branch = branch
        }
        info.liveness = liveness
        info.livenessNote = {
            switch liveness {
            case .running: return pendingTool ? "A tool call is waiting for its result" : "Activity in the last 2 minutes"
            case .idle: return inPane ? "Waiting in a cmux pane" : "Prompt cache is warm, no activity"
            case .ended: return envelope?.terminated == "error" ? "The transcript ended with an error" : "No recent activity"
            }
        }()
        if let status = session.cacheStatus {
            info.cacheCold = status == .COLD
            info.cacheNote = status == .COLD ? "Prompt cache is cold" : "\(SessionStatusFormat.ttlPhrase(session.cacheTtlSec ?? 0)) of prompt cache left"
        }
        info.inPane = inPane
        info.startedAt = windowStart == 0 ? document.firstAt : nil
        info.lastActivityAt = lastActivity
        info.contextTokens = session.displayContextTokens
        info.compacted = session.compacted ?? false
        var usage = nativeLog.map(\.summary.total).flatMap { $0.isEmpty ? nil : $0 } ?? SessionUsage(envelope?.totals)
        if let spend, usage?.costUsd == nil {
            var priced = usage ?? SessionUsage()
            priced.costUsd = spend.usd
            priced.costNote = spend.note
            usage = priced
        }
        info.usage = usage
        info.filePath = session.filePath
        info.turnCount = envelope.map(\.nextOffset) ?? document.turnCount
        info.toolCount = document.toolCount
        info.errorCount = document.errorCount
        if let verdict = stuck.verdicts[session.sessionId] {
            info.alert = verdict.line
            info.alertIsSevere = verdict.isLoop
        }
        return info
    }

    static func branch(of cwd: String) -> String? {
        SessionGitBranch.read(cwd: cwd)
    }

    /// One shell word: single quotes, and a `'` inside written as `'\''`.
    nonisolated static func shellQuoted(_ text: String) -> String {
        "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    /// A command word as typed: bare when no character in it means anything to a shell, else quoted. A
    /// leading `=` is quoted too: zsh (EQUALS) turns `=cat` into the path of `cat`.
    nonisolated static func shellWord(_ text: String) -> String {
        let plain = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_@%+=:,./-")
        let bare = !text.isEmpty && !text.hasPrefix("=") && text.unicodeScalars.allSatisfy { plain.contains($0) }
        return bare ? text : shellQuoted(text)
    }

    /// The branch the session ran on: the folder's branch while it runs there now, else the branch its
    /// transcript recorded (`gitBranch` from `tools ai usage sessions`). An old session no longer
    /// shows whatever the folder has checked out today, nor that branch's PR.
    static func branch(of session: HubSession) -> String? {
        let recorded = session.gitBranch.flatMap { $0.isEmpty ? nil : $0 }
        guard !session.cwd.isEmpty else { return recorded }
        if session.isLive || recorded == nil {
            return branch(of: session.cwd)
        }

        return recorded
    }

    /// The web page of `branch` in the session folder's repository, which need not be the branch
    /// checked out there now.
    static func branchURL(_ branch: String, facts: RepoFacts?) -> URL? {
        guard let facts else { return nil }
        if facts.branch == branch {
            return facts.branchURL
        }

        return facts.forge?.branch(branch)
    }

    // MARK: actions

    private var actions: SessionDetailActions {
        var actions = SessionDetailActions()
        actions.refresh = {
            // An established window keeps its start, 0 included: a nil offset asks for the latest turns, which
            // drops the earlier ones on screen once more turns arrived than the limit leaves room for.
            Task { await load(offset: turns.isEmpty ? nil : windowStart, limit: max(Self.pageSize, turns.count + Self.pageSize), throughEnd: true) }
        }
        actions.copy = { text in PathOpener.copy(text) }
        // The header's "Copy the resume command" copied an empty string (it cleared the clipboard):
        // nothing set the command. It runs in the session's folder, where the agent finds the session.
        if !agentChild, let command = AgentLauncher.resumeCommand(for: session) {
            let line = command.map(Self.shellWord).joined(separator: " ")
            actions.resumeCommand = session.cwd.isEmpty ? line : "cd \(Self.shellQuoted(session.cwd)) && \(line)"
        }
        if !session.cwd.isEmpty {
            let cwd = session.cwd
            // Finder by name: `NSWorkspace.open` on the folder handed it to QuickTime (Hub/HubPathActions.swift).
            actions.openInFinder = { PathOpener.finder(cwd) }
            actions.openInCursor = { PathOpener.cursor(cwd) }
        }
        if session.cmux != nil, ["claude", "codex", "grok"].contains(session.provider) {
            let id = session.sessionId
            // Off the main thread: it spawns `tools`, and a wait in a button action still spins the run loop.
            // A failure shows in the banner in words: a closed tab says the pane is gone, never cmux's RPC error.
            actions.focus = {
                Task {
                    let error = await Task.detached(priority: .userInitiated) { TerminalHosts.current.focus(sessionId: id) }.value
                    if let error {
                        HubPerf.log("session.focus \(id.prefix(8)) failed: \(error)")
                        banner = error
                    }
                }
            }
            actions.openTerminal = actions.focus
            // The same lines Genesis types (MonitorSessionActions), through `tools claude cmux send`.
            actions.wake = { poke(id, text: "Just poking, say \"OK\"", what: "Wake") }
            actions.keepalive = { poke(id, text: "/keepalive", what: "Keepalive") }
        }
        if let branch, let url = Self.branchURL(branch, facts: RepoFactsStore.shared.facts(for: session.cwd)) {
            actions.openBranch = { ExternalOpener.open(url) }
        }
        if let verdict = stuck.verdicts[session.sessionId] {
            actions.alertAction = { Task { await jump(toTurn: verdict.turnIndex, rowId: "t-\(verdict.toolId)") } }
        }
        return actions
    }

    /// Shows one turn's row: a turn before the loaded window loads a window from it to the current end
    /// (as the refresh does, so the newest turns stay), then the list reveals the row.
    private func jump(toTurn index: Int, rowId: String) async {
        HubPerf.log("transcript.jump turn=\(index) row=\(rowId.prefix(12)) window=\(windowStart)")
        if index < windowStart {
            let offset = max(0, index - 2)
            let end = envelope?.nextOffset ?? windowStart + turns.count
            await load(offset: offset, limit: max(Self.pageSize, end - offset))
        }
        // The list knows its session by the transcript's own id (`services.sessionId`).
        TranscriptBus.post(TranscriptBus.list, sessionId: services.sessionId, .reveal(rowId: rowId))
    }

    /// Types one line into the session's cmux pane, off the main thread; a failure shows in the banner.
    private func poke(_ sessionId: String, text: String, what: String) {
        HubPerf.log("session.\(what.lowercased()) \(sessionId.prefix(8))")
        Task {
            let error = await Task.detached(priority: .userInitiated) { TerminalHosts.current.send(sessionId: sessionId, text: text) }.value
            if let error {
                banner = "\(what) failed: \(error)"
            }
        }
    }

    // MARK: loading

    /// `throughEnd`: the window must reach the latest turn (a refresh that keeps the earlier pages),
    /// unlike a jump's window around one turn.
    private func load(offset: Int?, limit: Int, throughEnd: Bool = false) async {
        loadID += 1
        let id = loadID
        // A new window (another session, a refresh): an earlier page or a tail still on its way
        // belongs to the old one and is dropped on arrival, so its flags must not stop this one.
        loadingEarlier = false
        let span = HubPerf.begin("transcript.page", "limit=\(limit) offset=\(offset.map(String.init) ?? "-")", awaits: true)
        defer { span.end("\(turns.count) turns") }
        do {
            var limit = limit
            var fetched = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: limit, offset: offset)
            // A window that stopped short of the latest turn (more turns arrived than the limit left
            // room for) is fetched again from the same offset with exactly the room the transcript's
            // turn count asks for. Bounded: a live session can grow between two fetches.
            var tries = 0
            while throughEnd, let start = offset, let count = fetched.turnCount, fetched.nextOffset < count, tries < 3 {
                guard id == loadID else { return }
                tries += 1
                limit = count - start
                fetched = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: limit, offset: start)
            }
            guard id == loadID else { return }
            envelope = fetched
            turns = fetched.turns
            windowStart = fetched.windowStart
            await rebuild()
            // A newer load started while this one rebuilt: it owns the state, the notice and the tail.
            guard id == loadID else { return }
            HubMainBusy.measure("transcript.page.render")
            loadState = .loaded
            NotificationCenter.default.post(name: Self.firstPageDone, object: session.id)
            // This window's own follow, from its last turn (which may still grow).
            startTail()
            // Second pass: the session file adds per-call usage, models and full tool inputs.
            let path = fetched.filePath
            let scan = HubPerf.begin("transcript.nativeScan", awaits: true)
            let log = await Task.detached(priority: .utility) { SessionNativeLog.scan(path: path) }.value
            scan.end()
            guard id == loadID else { return }
            nativeLog = log
            if changeSource == nil {
                // `GENESIS_HUB_TOOL_CHANGES=per-row` brings back one process per row, for A/B measurements.
                changeSource = ProcessInfo.processInfo.environment["GENESIS_HUB_TOOL_CHANGES"] == "per-row"
                    ? CLIToolChangeSource(toolsBinary: HubSource.bridge.binaryPath)
                    : HubToolChangeSource(toolsBinary: HubSource.bridge.binaryPath)
            }
            let fresh = TranscriptServices(
                sessionId: fetched.sessionId,
                cwd: session.cwd.isEmpty ? nil : session.cwd,
                nativeLog: log,
                changes: changeSource,
                showChange: onShowChange
            )
            let sessionId = fetched.sessionId
            fresh.onQuery = { query in
                Task { @MainActor in await searchWholeSession(query, sessionId: sessionId) }
            }
            services = fresh
            await rebuild()
        } catch {
            guard id == loadID else { return }
            if document.sections.isEmpty {
                loadState = .failed(error.localizedDescription)
            } else {
                banner = error.localizedDescription
            }
            NotificationCenter.default.post(name: Self.firstPageDone, object: session.id)
        }
    }

    /// Prepends earlier turns in `fillChunk` steps until the window holds `pageSize` turns, one step per
    /// idle moment: each step inserts only its own rows above the viewport, so no step stalls the way
    /// one full-window layout did. Stops when the session changes or the start is reached.
    private func fillWindow() async {
        let id = session.id
        let span = HubPerf.begin("transcript.fill", session.sessionId.prefix(8).description, awaits: true)
        var steps = 0
        while windowStart > 0, turns.count < Self.pageSize, id == session.id, !Task.isCancelled {
            try? await Task.sleep(for: .milliseconds(250))
            guard id == session.id, !Task.isCancelled else { break }
            // A failed step would fail the same way every 250 ms: stop, the banner says why.
            guard await loadEarlier(count: min(Self.fillChunk, Self.pageSize - turns.count)) else { break }
            steps += 1
        }
        span.end("\(steps) steps, \(turns.count) turns")
    }

    /// True when a page came in.
    @discardableResult
    private func loadEarlier(count: Int = HubSessionDetailHost.pageSize) async -> Bool {
        guard windowStart > 0, !loadingEarlier else { return false }
        let owner = session.id
        let generation = loadID
        loadingEarlier = true
        defer {
            // After a newer load the flags are that load's; this page only ends itself.
            if generation == loadID {
                loadingEarlier = false
            }
        }
        let start = max(0, windowStart - count)
        let span = HubPerf.begin("transcript.earlier", "offset=\(start)", awaits: true)
        defer { span.end() }
        do {
            let page = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: windowStart - start, offset: start)
            // Another session or a refresh while it loaded: these turns are not this window's.
            guard owner == session.id, generation == loadID else { return false }
            let known = Set(turns.map(\.id))
            turns = page.turns.filter { !known.contains($0.id) } + turns
            windowStart = page.windowStart
            await rebuild()
            // The list inserting the earlier rows above the viewport (GenesisKit `TranscriptScrollAnchor`).
            HubMainBusy.measure("transcript.earlier.render")
            return true
        } catch {
            guard owner == session.id, generation == loadID else { return false }
            banner = "Could not load earlier turns: \(error.localizedDescription)"
            return false
        }
    }

    /// Starts this window's follow from its last turn (which may still grow), replacing any other one:
    /// never more than one process per open detail.
    private func startTail() {
        tail?.stop()
        tail = nil
        guard let current = envelope, loadState == .loaded, !isPaused else { return }
        let owner = session.id
        tail = HubTranscriptTail(query: session.sessionId, offset: max(windowStart, current.nextOffset - 1)) { batch in
            guard owner == session.id else { return }
            applyTail(batch)
        }
    }

    private func stopTail() {
        tail?.stop()
        tail = nil
    }

    /// Back from hidden or minimized: the new follow sends everything from the last known turn on.
    private func resumeTail() {
        guard tail == nil, !isPaused else { return }
        startTail()
    }

    private var isPaused: Bool {
        NSApp.isHidden || host.window?.isMiniaturized == true
    }

    /// One chunk of the follow: a turn at a known index replaces that row (a streaming reply, a tool
    /// result), the next index appends. Only those rows change, at the bottom, so existing rows keep
    /// their frames (a moved focusable frame rebuilds the key view loop over every row).
    private func applyTail(_ batch: HubTranscriptTail.Batch) {
        guard var current = envelope, loadState == .loaded else { return }
        let before = turns.count
        var replaced = 0
        var skipped = 0
        for var turn in batch.turns {
            guard let index = turn.index else { continue }
            // The window's rows carry no index (a sparse search view numbers its own copies).
            turn.index = nil
            let position = index - windowStart
            if position >= 0, position < turns.count {
                if turns[position] != turn {
                    turns[position] = turn
                    replaced += 1
                }
            } else if position == turns.count {
                turns.append(turn)
            } else {
                skipped += 1
            }
        }
        let appended = turns.count - before
        let changed = appended > 0 || replaced > 0
        current.turns = turns
        current.nextOffset = windowStart + turns.count
        if let totals = batch.totals {
            current.totals = totals.transcriptTotals
            current.terminated = totals.terminated
            current.turnCount = totals.turnCount
        }
        guard changed || current != envelope else { return }
        envelope = current
        HubPerf.log("transcript.follow +\(appended) turns, \(replaced) replaced\(skipped > 0 ? ", \(skipped) outside the window" : ""), \(turns.count) in window")
        guard changed else { return }
        Task {
            await rebuild()
            await refreshSubagents()
            // The renderer's side of an append: the List inserting the new rows and laying them out.
            HubMainBusy.measure("transcript.tail.render")
        }
    }

    /// ⌘F over the whole session: `tools ai sessions grep` names every matching turn; the ones before
    /// the loaded window come in with `tail --turns` and join the window in session order, so the list's
    /// own filter finds them. An empty query, or hits all inside the window, puts the window back.
    private func searchWholeSession(_ query: String, sessionId: String) async {
        searchID += 1
        let id = searchID
        let text = query.trimmingCharacters(in: .whitespaces)
        guard text.count >= 2 else {
            searchDocument = nil
            searchNote = nil
            return
        }
        let start = windowStart
        let window = turns
        let span = HubPerf.begin("transcript.search", "\(text.count) chars", awaits: true)
        let result = await Task.detached(priority: .userInitiated) { () -> Result<(TranscriptDocument?, String), Error> in
            Result {
                let hits = try HubSessionSearch.grep(sessionId: sessionId, query: text)
                let earlier = hits.turns.filter { $0 < start }
                guard !earlier.isEmpty else {
                    return (nil, hits.total == 0 ? "No turn in this session matches" : "All \(hits.total) matching turns are in this window")
                }
                let fetched = try HubSessionSearch.turns(sessionId: sessionId, indices: Array(earlier.suffix(HubSessionSearch.maxEarlier)))
                let numbered = window.enumerated().map { offset, turn -> TranscriptTurn in
                    var copy = turn
                    copy.index = start + offset
                    return copy
                }
                let document = TranscriptDocument.build(fetched + numbered)
                let more = earlier.count > HubSessionSearch.maxEarlier ? " (the latest \(HubSessionSearch.maxEarlier) of them)" : ""
                return (document, "Whole session: \(hits.total)\(hits.truncated ? "+" : "") matching turns, \(earlier.count) before this window\(more)")
            }
        }.value
        guard id == searchID else {
            span.end("superseded")
            return
        }
        switch result {
        case .success(let (document, note)):
            span.end(note)
            searchDocument = document
            searchNote = note
        case .failure(let error):
            span.end("failed")
            searchDocument = nil
            searchNote = "Whole-session search failed: \(error.localizedDescription)"
        }
    }

    /// Off the main thread: a long session is thousands of rows with regex work per prompt. Builds
    /// overlap (a fetch, the native scan, an earlier page, the live tail), and only the latest may
    /// land: an older one would drop turns added after it started.
    private func rebuild() async {
        buildID += 1
        let id = buildID
        let snapshot = turns
        let offset = windowStart
        let native = nativeLog?.summary
        let built = await Task.detached(priority: .userInitiated) {
            HubPerf.measure("transcript.document", "\(snapshot.count) turns") {
                (TranscriptDocument.build(snapshot, turnOffset: offset, native: native), SessionActivityDigest.build(snapshot))
            }
        }.value
        guard id == buildID else { return }
        document = built.0
        digest = built.1
    }
}

/// `tools ai sessions subagents --json`: every sub-agent of a Claude session and whether it still works.
enum HubSubagents {
    private struct Envelope: Decodable {
        struct Agent: Decodable {
            let id: String
            let name: String?
            let description: String?
            let agentType: String?
            let toolUseId: String?
            let lastAt: String
            let state: String
        }

        let subagents: [Agent]
    }

    /// Blocking: call off the main thread. nil when the read failed (the digest's rows stay).
    static func list(sessionId: String) -> [SessionSubagent]? {
        do {
            let rows = try decode(ToolsCLIRunner.run(["ai", "sessions", "subagents", sessionId, "--json"]))
            let running = rows.filter { $0.state == .running }.count
            HubPerf.log("subagents \(sessionId.prefix(8)): \(rows.count), \(running) running")
            return rows
        } catch {
            HubPerf.log("subagents failed for \(sessionId.prefix(8)): \(error)")
            return nil
        }
    }

    /// The command's stdout as rows (src/utils/ai/transcripts/subagents.ts).
    static func decode(_ data: Data) throws -> [SessionSubagent] {
        try JSONDecoder().decode(Envelope.self, from: MonitorJSON.dataByDroppingPreamble(data)).subagents.map(row)
    }

    private static func row(_ agent: Envelope.Agent) -> SessionSubagent {
        let title = agent.description ?? agent.agentType ?? agent.id
        var summary = agent.name.map { "\($0): \(title)" } ?? title
        // The stolen row has no "stopped" state: the text says it, the row keeps the "done" state.
        if agent.state == "stopped" {
            summary += " (stopped, last write \(agent.lastAt.prefix(16).replacingOccurrences(of: "T", with: " ")) UTC)"
        }

        let state: SessionSubagent.State = agent.state == "running" ? .running : .done
        return SessionSubagent(id: agent.toolUseId ?? agent.id, kind: agent.agentType ?? "Agent", summary: summary, state: state)
    }
}

/// The `tools ai sessions grep` / `tail --turns` doors behind the transcript's whole-session ⌘F.
enum HubSessionSearch {
    /// Earlier turns merged into one search view at most (the latest ones win).
    static let maxEarlier = 150

    struct Hits: Decodable {
        let total: Int
        let turns: [Int]
        let truncated: Bool
    }

    /// Blocking: call off the main thread.
    static func grep(sessionId: String, query: String) throws -> Hits {
        // `--` first: a query such as "-v" is the text to find, not an option (commander refuses it).
        let data = try ToolsCLIRunner.run(["ai", "sessions", "grep", "--json", "--limit", "500", "--", sessionId, query])
        return try JSONDecoder().decode(Hits.self, from: MonitorJSON.dataByDroppingPreamble(data))
    }

    /// Blocking: call off the main thread. The turns carry their session-wide `index`.
    static func turns(sessionId: String, indices: [Int]) throws -> [TranscriptTurn] {
        guard !indices.isEmpty else { return [] }
        let list = indices.map(String.init).joined(separator: ",")
        let data = try ToolsCLIRunner.run(["ai", "sessions", "tail", sessionId, "--json", "--turns", list])
        return try SessionTranscriptClient.decode(data).turns
    }
}


/// The window a view is in, held without SwiftUI state: setting it re-renders nothing.
final class HostWindow {
    weak var window: NSWindow?
}

/// Records the window its view moves into, once per move (not per update, as `HubWindowReader` does).
private struct HostWindowReader: NSViewRepresentable {
    let host: HostWindow

    final class Probe: NSView {
        var host: HostWindow?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            host?.window = window
        }
    }

    func makeNSView(context: Context) -> Probe {
        let probe = Probe()
        probe.host = host
        return probe
    }

    func updateNSView(_ view: Probe, context: Context) {
        view.host = host
    }
}
