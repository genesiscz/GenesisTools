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
    static let pageSize = 150

    @State private var nativeLog: SessionNativeLog?
    @State private var services = TranscriptServices.none
    @State private var changeSource: CLIToolChangeSource?
    @State private var spend: HubSpend.Estimate?
    @State private var branch: String?
    /// The branch web page arrives from `tools hub repo` after the first draw.
    @ObservedObject private var repos = RepoFactsStore.shared

    @State private var envelope: TranscriptEnvelope?
    @State private var turns: [TranscriptTurn] = []
    @State private var windowStart = 0
    @State private var document = TranscriptDocument.empty
    @State private var digest = SessionActivityDigest.empty
    @State private var loadState: TranscriptLoadState = .loading
    @State private var loadingEarlier = false
    @State private var banner: String?
    @State private var loadID = 0

    var body: some View {
        SessionDetailScreen(
            info: info,
            digest: digest,
            document: document,
            loadState: loadState,
            hasEarlier: windowStart > 0,
            loadingEarlier: loadingEarlier,
            windowNote: windowStart > 0 ? envelope.map { "Turns \(windowStart + 1)–\($0.nextOffset)" } : nil,
            banner: banner,
            onLoadEarlier: { Task { await loadEarlier() } },
            onDismissBanner: { banner = nil },
            leadingInset: 16,
            services: services,
            showsSidebar: showsSidebar,
            actions: actions
        ) {
            SessionTerminalSection(session: session)
        }
        .task(id: session.id) {
            envelope = nil
            turns = []
            windowStart = 0
            document = .empty
            digest = .empty
            nativeLog = nil
            services = .none
            spend = HubSpend.cached(session.sessionId)
            branch = session.cwd.isEmpty ? nil : Self.branch(of: session.cwd)
            loadState = .loading
            await load(offset: nil, limit: Self.pageSize)
            let row = session
            let fresh = await Task.detached(priority: .utility) { HubSpend.fetch(row) }.value
            if let fresh, row.id == session.id {
                spend = fresh
            }
        }
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
        return info
    }

    static func branch(of cwd: String) -> String? {
        SessionGitBranch.read(cwd: cwd)
    }

    // MARK: actions

    private var actions: SessionDetailActions {
        var actions = SessionDetailActions()
        actions.refresh = {
            Task { await load(offset: windowStart > 0 ? windowStart : nil, limit: max(Self.pageSize, turns.count + Self.pageSize)) }
        }
        actions.copy = { text in
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
        }
        if !session.cwd.isEmpty {
            let cwd = session.cwd
            actions.openInFinder = { NSWorkspace.shared.open(URL(fileURLWithPath: cwd)) }
            actions.openInCursor = {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
                process.arguments = ["-a", "Cursor", cwd]
                try? process.run()
            }
        }
        if session.cmux != nil, session.provider == "claude" {
            let id = session.sessionId
            // Off the main thread: it spawns `tools`, and a wait in a button action still spins the run loop.
            actions.focus = {
                Task.detached(priority: .userInitiated) { _ = TerminalHosts.current.focus(sessionId: id) }
            }
            actions.openTerminal = actions.focus
        }
        if let url = RepoFactsStore.shared.facts(for: session.cwd)?.branchURL {
            actions.openBranch = { ExternalOpener.open(url) }
        }
        return actions
    }

    // MARK: loading

    private func load(offset: Int?, limit: Int) async {
        loadID += 1
        let id = loadID
        let span = HubPerf.begin("transcript.page", "limit=\(limit) offset=\(offset.map(String.init) ?? "-")", awaits: true)
        defer { span.end("\(turns.count) turns") }
        do {
            let fetched = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: limit, offset: offset)
            guard id == loadID else { return }
            envelope = fetched
            turns = fetched.turns
            windowStart = fetched.windowStart
            await rebuild()
            loadState = .loaded
            // Second pass: the session file adds per-call usage, models and full tool inputs.
            let path = fetched.filePath
            let scan = HubPerf.begin("transcript.nativeScan", awaits: true)
            let log = await Task.detached(priority: .utility) { SessionNativeLog.scan(path: path) }.value
            scan.end()
            guard id == loadID else { return }
            nativeLog = log
            if changeSource == nil {
                changeSource = CLIToolChangeSource(toolsBinary: HubSource.bridge.binaryPath)
            }
            services = TranscriptServices(
                sessionId: fetched.sessionId,
                cwd: session.cwd.isEmpty ? nil : session.cwd,
                nativeLog: log,
                changes: changeSource,
                showChange: onShowChange
            )
            await rebuild()
        } catch {
            guard id == loadID else { return }
            if document.sections.isEmpty {
                loadState = .failed(error.localizedDescription)
            } else {
                banner = error.localizedDescription
            }
        }
    }

    private func loadEarlier() async {
        guard windowStart > 0, !loadingEarlier else { return }
        loadingEarlier = true
        defer { loadingEarlier = false }
        let start = max(0, windowStart - Self.pageSize)
        let span = HubPerf.begin("transcript.earlier", "offset=\(start)", awaits: true)
        defer { span.end() }
        do {
            let page = try await SessionTranscriptClient.fetch(using: HubSource.bridge, sessionId: session.sessionId, limit: windowStart - start, offset: start)
            let known = Set(turns.map(\.id))
            turns = page.turns.filter { !known.contains($0.id) } + turns
            windowStart = page.windowStart
            await rebuild()
        } catch {
            banner = "Could not load earlier turns: \(error.localizedDescription)"
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
