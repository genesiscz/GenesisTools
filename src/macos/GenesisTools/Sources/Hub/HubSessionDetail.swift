import AppKit
import SwiftUI

/// Hosts Genesis's redesigned session screen (Hub/Stolen/Sessions/SessionDetailScreen.swift) for a
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
    static let pageSize = 150
    /// Viewport first: the newest turns only, so the first layout (which scrolls to the last row and so
    /// measures every row above it) handles a screenful instead of `pageSize` turns. A 172 MB session
    /// stalled the main thread 0.9–1.5 s at open with the whole window in one go.
    /// `GENESIS_HUB_FIRST_PAGE=150` restores the old one-shot window, for A/B measurements.
    static let firstPage = ProcessInfo.processInfo.environment["GENESIS_HUB_FIRST_PAGE"].flatMap(Int.init) ?? 12
    /// The rest of the window arrives in chunks of this many turns while the reader is idle.
    static let fillChunk = 24
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
    /// ⌘F over the whole session: the window plus the earlier turns that match, while a query is on.
    @State private var searchDocument: TranscriptDocument?
    @State private var searchNote: String?
    @State private var searchID = 0
    /// Live tail: the session file's growth appends turns without reloading the window.
    @State private var tail: HubTranscriptTail?
    @State private var tailInFlight = false
    @State private var tailAgain = false
    /// A tail event that came while earlier turns loaded, replayed when that load ends.
    @State private var tailDeferred = false
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
            actions: actions
        ) {
            SessionTerminalSection(session: session)
            // Cost per prompt, tool analytics, handoff composer (Hub/HubSessionInsights.swift).
            SessionInsightsSection(session: session, turnCount: envelope?.nextOffset ?? 0)
        }
        // A click in the transcript keeps ⌘F on its own search (Hub/HubPanelFind.swift).
        .panelFindNative("transcript")
        // The sidebar asks for a turn: load the window holding it when it is earlier, then reveal it.
        .onReceive(NotificationCenter.default.publisher(for: HubTranscriptBus.request)) { note in
            if case .jump(let index, let rowId)? = HubTranscriptBus.message(note, for: HubTranscriptBus.request, sessionId: session.sessionId) {
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
            await fillWindow()
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
        guard session.provider == "claude", Date().timeIntervalSince(subagentsReadAt) >= 5 else { return }
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
            Task { await load(offset: windowStart > 0 ? windowStart : nil, limit: max(Self.pageSize, turns.count + Self.pageSize)) }
        }
        actions.copy = { text in PathOpener.copy(text) }
        // The header's "Copy the resume command" copied an empty string (it cleared the clipboard):
        // nothing set the command. It runs in the session's folder, where the agent finds the session.
        if let command = AgentLauncher.resumeCommand(for: session) {
            let line = command.joined(separator: " ")
            actions.resumeCommand = session.cwd.isEmpty ? line : "cd \(Self.shellQuoted(session.cwd)) && \(line)"
        }
        if !session.cwd.isEmpty {
            let cwd = session.cwd
            // Finder by name: `NSWorkspace.open` on the folder handed it to QuickTime (Hub/HubPathActions.swift).
            actions.openInFinder = { PathOpener.finder(cwd) }
            actions.openInCursor = { PathOpener.cursor(cwd) }
        }
        if session.cmux != nil, session.provider == "claude" {
            let id = session.sessionId
            // Off the main thread: it spawns `tools`, and a wait in a button action still spins the run loop.
            actions.focus = {
                Task.detached(priority: .userInitiated) { _ = TerminalHosts.current.focus(sessionId: id) }
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

    /// Shows one turn's row: a turn before the loaded window loads a window around it first (the live
    /// tail then follows from its end, as after any earlier page), then the list reveals the row.
    private func jump(toTurn index: Int, rowId: String) async {
        HubPerf.log("transcript.jump turn=\(index) row=\(rowId.prefix(12)) window=\(windowStart)")
        if index < windowStart {
            await load(offset: max(0, index - 2), limit: Self.pageSize)
        }
        // The list knows its session by the transcript's own id (`services.sessionId`).
        HubTranscriptBus.post(HubTranscriptBus.list, sessionId: services.sessionId, .reveal(rowId: rowId))
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

    private func load(offset: Int?, limit: Int) async {
        loadID += 1
        let id = loadID
        // A new window (another session, a refresh): an earlier page or a tail still on its way
        // belongs to the old one and is dropped on arrival, so its flags must not stop this one.
        loadingEarlier = false
        tailDeferred = false
        let span = HubPerf.begin("transcript.page", "limit=\(limit) offset=\(offset.map(String.init) ?? "-")", awaits: true)
        defer { span.end("\(turns.count) turns") }
        do {
            let fetched = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: limit, offset: offset)
            guard id == loadID else { return }
            envelope = fetched
            turns = fetched.turns
            windowStart = fetched.windowStart
            await rebuild()
            HubMainBusy.measure("transcript.page.render")
            loadState = .loaded
            NotificationCenter.default.post(name: Self.firstPageDone, object: session.id)
            if tail == nil, FileManager.default.fileExists(atPath: fetched.filePath) {
                tail = HubTranscriptTail(path: fetched.filePath) {
                    Task { @MainActor in await followTail() }
                }
            }
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
                // The file grew while this page loaded; that growth fires no second event.
                if tailDeferred {
                    tailDeferred = false
                    Task { await followTail() }
                }
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
            // The list inserting the earlier rows above the viewport (Hub/HubTranscriptAnchor.swift).
            HubMainBusy.measure("transcript.earlier.render")
            return true
        } catch {
            guard owner == session.id, generation == loadID else { return false }
            banner = "Could not load earlier turns: \(error.localizedDescription)"
            return false
        }
    }

    /// The session file grew: fetch from the last known turn on (it may have grown too: a streaming
    /// reply, a tool result) and append. Only the new rows change, at the bottom, so existing rows keep
    /// their frames (a moved focusable frame rebuilds the key view loop over every row). One fetch at a
    /// time; growth during a fetch runs one more.
    private func followTail() async {
        guard !tailInFlight else {
            tailAgain = true
            return
        }
        tailInFlight = true
        defer { tailInFlight = false }
        repeat {
            tailAgain = false
            await tailOnce()
        } while tailAgain
    }

    private func tailOnce() async {
        guard let current = envelope, loadState == .loaded else { return }
        guard !loadingEarlier else {
            // Not `tailAgain`: that would loop here without a pause. `loadEarlier` runs it when it ends.
            tailDeferred = true
            return
        }
        let from = max(windowStart, current.nextOffset - 1)
        let startBefore = windowStart
        let owner = session.id
        let generation = loadID
        let span = HubPerf.begin("transcript.tail", "from=\(from)", awaits: true)
        do {
            let fetched = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: 400, offset: from)
            // Another session or a refresh while it loaded (both can start at turn 0, so the
            // window check below would pass): this tail is not this window's.
            guard owner == session.id, generation == loadID else {
                span.end("superseded")
                return
            }
            // The idle fill prepended earlier turns meanwhile: the merge point moved, so go again.
            guard windowStart == startBefore, !loadingEarlier else {
                span.end("window moved")
                tailAgain = true
                return
            }
            guard fetched.nextOffset >= current.nextOffset, fetched.windowStart == from else {
                span.end("stale")
                return
            }
            let keep = max(0, from - windowStart)
            if fetched.nextOffset == current.nextOffset, Array(turns.suffix(from: keep)) == fetched.turns {
                span.end("unchanged")
                return
            }
            turns = Array(turns.prefix(keep)) + fetched.turns
            var merged = fetched
            merged.turns = turns
            envelope = merged
            span.end("+\(max(0, fetched.nextOffset - current.nextOffset)) turns, \(turns.count) in window")
            await rebuild()
            await refreshSubagents()
            // The renderer's side of an append: the List inserting the new rows and laying them out.
            HubMainBusy.measure("transcript.tail.render")
        } catch {
            span.end("failed: \(error.localizedDescription)")
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

    /// Off the main thread: a long session is thousands of rows with regex work per prompt.
    private func rebuild() async {
        let snapshot = turns
        let offset = windowStart
        let native = nativeLog?.summary
        let built = await Task.detached(priority: .userInitiated) {
            HubPerf.measure("transcript.document", "\(snapshot.count) turns") {
                (TranscriptDocument.build(snapshot, turnOffset: offset, native: native), SessionActivityDigest.build(snapshot))
            }
        }.value
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

/// The session screen's transcript and its details sidebar (Hub/Stolen/Sessions/SessionDetailScreen.swift).
/// Wide enough for both, they sit side by side; narrower, the sidebar covers the transcript's trailing
/// edge. The screen never grows past its frame: as an HStack of the transcript (`minWidth: 460`) and the
/// 301 pt sidebar it grew to 761 pt in a narrower pane, the parent clipped both edges, and the sidebar
/// and the header's sidebar toggle went off screen (2026-09-25).
struct SessionSidebarSplit: Layout {
    var mainMinWidth: CGFloat = 460

    /// True when the sidebar has to cover the transcript at this width.
    static func overlays(width: CGFloat, sidebar: CGFloat, mainMinWidth: CGFloat) -> Bool {
        width - sidebar < mainMinWidth
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        proposal.replacingUnspecifiedDimensions()
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let main = subviews.first else {
            return
        }

        guard subviews.count > 1, let sidebar = subviews.last else {
            main.place(at: bounds.origin, proposal: ProposedViewSize(bounds.size))
            return
        }

        let sidebarWidth = min(sidebar.sizeThatFits(ProposedViewSize(width: nil, height: bounds.height)).width, bounds.width)
        let covers = Self.overlays(width: bounds.width, sidebar: sidebarWidth, mainMinWidth: mainMinWidth)
        let mainWidth = covers ? bounds.width : bounds.width - sidebarWidth
        main.place(at: bounds.origin, proposal: ProposedViewSize(width: mainWidth, height: bounds.height))
        sidebar.place(at: CGPoint(x: bounds.maxX - sidebarWidth, y: bounds.minY), proposal: ProposedViewSize(width: sidebarWidth, height: bounds.height))
    }
}
