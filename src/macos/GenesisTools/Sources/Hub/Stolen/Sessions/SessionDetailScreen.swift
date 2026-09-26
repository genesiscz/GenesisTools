// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground.worktrees/genesis-session-redesign/Genesis/apps/Genesis/Sources/Genesis/Sessions/SessionDetailScreen.swift at 2026-09-24T08:22:05+02:00 at commit hash 352701bd4e327a97ee223015319f46223ad3a6e5
//
//  SessionDetailScreen.swift
//  Genesis
//
//  The Session Details window, as a pure view: a two-line header (identity, status, place,
//  counters), the transcript on the left and a 300 pt sidebar on the right (stat chips, status,
//  place, files touched, commits, sub-agents, then whatever the host adds). It takes plain values
//  and closures, so a snapshot test can render it and another app can host it.
//
//  `SessionDetailsPane` is the host in Genesis.app: it loads the data and wires the actions.
//

import AppKit
// GenesisTools adaptation: the kit types are compiled into this module.
// import GenesisAIMonitorKit
import SwiftUI

struct SessionDetailInfo: Equatable {
    var sessionId: String
    var title: String
    var provider: AIProviderMeta
    var account: String?
    var model: String?
    var modelSwitched = false
    var cwd: String?
    var cwdExists = false
    var branch: String?
    var liveness: SessionLiveness = .ended
    var livenessNote = ""
    /// `58m of cache left`, `cache cold`, or nil for a provider without a cache clock.
    var cacheNote: String?
    var cacheCold = false
    /// true: a live cmux pane holds the session. nil: not known (or not a cmux provider).
    var inPane: Bool?
    var startedAt: Date?
    var lastActivityAt: Date?
    var contextTokens: Int?
    var compacted = false
    /// Whole-session tokens and cost (native session file first, envelope totals second).
    var usage: SessionUsage?
    var filePath: String?
    var turnCount = 0
    var toolCount = 0
    var errorCount = 0
    /// Explains why the session is missing from the recent list, when it is.
    var note: String?
    // GenesisTools adaptation: a warning line under the header (the hub's stuck-agent verdict,
    // Hub/HubStuck.swift); `alertIsSevere` draws it red instead of orange.
    var alert: String?
    var alertIsSevere = false

    var shortId: String { String(sessionId.prefix(8)) }

    var livenessColor: Color {
        switch liveness {
        case .running: return SessionPalette.green
        case .idle: return SessionPalette.orange
        case .ended: return SessionPalette.faint
        }
    }
}

struct SessionDetailActions {
    var refreshing = false
    var refresh: () -> Void = {}
    var openInCursor: (() -> Void)?
    var openInFinder: (() -> Void)?
    var copy: (String) -> Void = { _ in }
    /// nil disables the button.
    var focus: (() -> Void)?
    var wake: (() -> Void)?
    var keepalive: (() -> Void)?
    var resumeCommand = ""
    /// The branch's web page. nil: a click on the branch copies its name.
    var openBranch: (() -> Void)?
    /// Raise, or choose, the terminal pane of the session ("Open in a cmux pane", the status pill).
    /// nil falls back to `focus`.
    var openTerminal: (() -> Void)?
    /// "Open the Changes view at this file (and line)". nil hides every "Open diff" button.
    /// Genesis leaves it nil; the GenesisTools hub wires it to its diff window.
    var showChange: ((String, Int?) -> Void)?
    // GenesisTools adaptation: a click on the header's alert line (the hub opens the stuck call).
    var alertAction: (() -> Void)?
}

/// Window chrome the screen is drawn for: no title text, a transparent unified-compact titlebar
/// whose traffic lights sit inside the header's first row (`leadingInset`, `rowHeight`).
enum SessionDetailScreenChrome {
    static let leadingInset: CGFloat = 80
    /// The unified-compact titlebar height, so the header row and the traffic lights share a centre line.
    static let rowHeight: CGFloat = 38

    @MainActor
    static func apply(to window: NSWindow) {
        window.styleMask.insert(.fullSizeContentView)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        // An empty toolbar only to get the compact unified titlebar and its centred traffic lights.
        window.toolbar = NSToolbar(identifier: "SessionDetails")
        window.toolbarStyle = .unifiedCompact
        window.isMovableByWindowBackground = true
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = SessionPalette.backgroundNS
    }
}

struct SessionDetailScreen<SidebarExtra: View>: View {
    let info: SessionDetailInfo
    let digest: SessionActivityDigest
    let document: TranscriptDocument
    let loadState: TranscriptLoadState
    var hasEarlier = false
    var loadingEarlier = false
    var windowNote: String?
    var banner: String?
    var onLoadEarlier: () -> Void = {}
    var onDismissBanner: () -> Void = {}
    var preset = TranscriptPreset()
    /// Space before the header's first row. 80 pt clears the traffic lights of a window the
    /// screen fills; a host that places the screen beside its own sidebar passes 16.
    var leadingInset: CGFloat = SessionDetailScreenChrome.leadingInset
    /// Session file, change log and `showChange`, for the tool rows. Build it once per loaded
    /// session file (rows compare it by identity).
    var services: TranscriptServices = .none
    let actions: SessionDetailActions
    let sidebarExtra: SidebarExtra

    @State private var showSidebar = true
    // GenesisTools adaptation: the sidebar covers the transcript in a narrow pane (`SessionSidebarSplit`).
    @State private var sidebarCovers = false

    init(
        info: SessionDetailInfo,
        digest: SessionActivityDigest,
        document: TranscriptDocument,
        loadState: TranscriptLoadState,
        hasEarlier: Bool = false,
        loadingEarlier: Bool = false,
        windowNote: String? = nil,
        banner: String? = nil,
        onLoadEarlier: @escaping () -> Void = {},
        onDismissBanner: @escaping () -> Void = {},
        preset: TranscriptPreset = TranscriptPreset(),
        leadingInset: CGFloat = SessionDetailScreenChrome.leadingInset,
        services: TranscriptServices = .none,
        showsSidebar: Bool = true,
        actions: SessionDetailActions,
        @ViewBuilder sidebarExtra: () -> SidebarExtra
    ) {
        // A host that places the screen in a narrow pane starts it with the sidebar folded.
        _showSidebar = State(initialValue: showsSidebar)
        self.info = info
        self.digest = digest
        self.document = document
        self.loadState = loadState
        self.hasEarlier = hasEarlier
        self.loadingEarlier = loadingEarlier
        self.windowNote = windowNote
        self.banner = banner
        self.onLoadEarlier = onLoadEarlier
        self.onDismissBanner = onDismissBanner
        self.preset = preset
        self.leadingInset = leadingInset
        self.services = services
        self.actions = actions
        self.sidebarExtra = sidebarExtra()
    }

    var body: some View {
        VStack(spacing: 0) {
            SessionDetailHeader(info: info, actions: actions, leadingInset: leadingInset, showSidebar: $showSidebar)
            if let banner, !banner.isEmpty {
                SessionBanner(text: banner, onDismiss: onDismissBanner)
            }
            // GenesisTools adaptation: the hub hosts this screen in panes narrower than the transcript's
            // 460 pt plus the sidebar. The HStack then grew past its frame and the pane clipped the
            // sidebar and the header's sidebar toggle; `SessionSidebarSplit` (Hub/HubSessionDetail.swift)
            // lets the sidebar cover the transcript's edge instead, with a shadow to set it apart.
            SessionSidebarSplit(mainMinWidth: 460) {
                SessionTranscriptList(
                    document: document,
                    provider: info.provider,
                    modelName: info.model,
                    loadState: loadState,
                    hasEarlier: hasEarlier,
                    loadingEarlier: loadingEarlier,
                    windowNote: windowNote,
                    onLoadEarlier: onLoadEarlier,
                    preset: preset,
                    services: services
                )
                .frame(maxWidth: .infinity)
                if showSidebar {
                    HStack(spacing: 0) {
                        Rectangle().fill(SessionPalette.hairline).frame(width: 1)
                        SessionDetailSidebar(info: info, digest: digest, actions: actions, extra: sidebarExtra)
                            .frame(width: 300)
                    }
                    .shadow(color: .black.opacity(sidebarCovers ? 0.45 : 0), radius: 14, x: -4)
                }
            }
            .onGeometryChange(for: Bool.self, of: { SessionSidebarSplit.overlays(width: $0.size.width, sidebar: 301, mainMinWidth: 460) }) { sidebarCovers = $0 }
        }
        .background(SessionPalette.background)
        // The header's first row IS the titlebar row: it draws under the traffic lights.
        .ignoresSafeArea(.container, edges: .top)
        .environment(\.colorScheme, .dark)
    }
}

// MARK: - Header

struct SessionDetailHeader: View {
    let info: SessionDetailInfo
    let actions: SessionDetailActions
    var leadingInset: CGFloat = SessionDetailScreenChrome.leadingInset
    @Binding var showSidebar: Bool

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                AIProviderGlyph(meta: info.provider, size: 18)
                Text(verbatim: info.title)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(SessionPalette.text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                    .layoutPriority(1)
                    .instantTooltip(info.title)
                    // GenesisTools adaptation: the title and the ids behind it can be copied.
                    .contextMenu {
                        Button("Copy title") { actions.copy(info.title) }
                        Button("Copy session id") { actions.copy(info.sessionId) }
                        if !actions.resumeCommand.isEmpty {
                            Button("Copy the resume command") { actions.copy(actions.resumeCommand) }
                        }
                    }
                Button { (actions.openTerminal ?? actions.focus)?() } label: {
                    HStack(spacing: 5) {
                        SessionStatusDot(color: info.livenessColor, size: 7)
                        Text(verbatim: info.liveness.label)
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(info.liveness == .ended ? SessionPalette.dim : info.livenessColor)
                    }
                }
                .buttonStyle(.genHoverPlain())
                .disabled(actions.openTerminal == nil && actions.focus == nil)
                .fixedSize()
                .instantTooltip(info.livenessNote + ((actions.openTerminal ?? actions.focus) == nil ? "" : " · click to raise its terminal pane"))
                .accessibilityIdentifier("session-details-status")
                if let model = info.model, !model.isEmpty {
                    Button { actions.copy(model) } label: { SessionPill(text: model) }
                        .buttonStyle(.genHoverPlain())
                        .fixedSize()
                        .instantTooltip("Copy the model name")
                }
                if info.modelSwitched {
                    SessionPill(text: "switched", color: SessionPalette.orange)
                        .fixedSize()
                        .instantTooltip("The model changed since the previous turn")
                }
                if let account = info.account, !account.isEmpty {
                    Button { actions.copy(account) } label: {
                        Text(verbatim: "@\(account)")
                            .font(.system(size: 12))
                            .foregroundStyle(SessionPalette.dim)
                            .lineLimit(1)
                    }
                    .buttonStyle(.genHoverPlain())
                    .fixedSize()
                    .instantTooltip("The account this session bills · click to copy")
                }
                Spacer(minLength: 12)
                // A narrow window or pane keeps the context size, then drops the counters, instead of
                // pushing the whole screen wider than its frame.
                ViewThatFits(in: .horizontal) {
                    counters.fixedSize()
                    compactCounters.fixedSize()
                    Color.clear.frame(width: 0, height: 0)
                }
                headerButtons
            }
            .padding(.leading, leadingInset)
            .padding(.trailing, 12)
            .frame(height: SessionDetailScreenChrome.rowHeight)

            // The full row when it fits; otherwise the same row without "started", so a narrow pane
            // keeps the folder and branch readable instead of squeezing all three.
            ViewThatFits(in: .horizontal) {
                metaRow(showStarted: true)
                metaRow(showStarted: false)
            }
            .padding(.horizontal, 16)
            .frame(height: 28)
            // GenesisTools adaptation: the alert line (see `SessionDetailInfo.alert`).
            if let alert = info.alert {
                alertRow(alert)
            }
        }
        .overlay(alignment: .bottom) {
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
        }
        .accessibilityIdentifier("session-details-header")
    }

    // GenesisTools adaptation: one line, the whole row a button when the host gave an action.
    private func alertRow(_ text: String) -> some View {
        let color = info.alertIsSevere ? SessionPalette.red : SessionPalette.orange
        return Button { actions.alertAction?() } label: {
            HStack(spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 10))
                Text(verbatim: text)
                    .lineLimit(1)
                    .truncationMode(.tail)
                Spacer(minLength: 0)
            }
            .font(.system(size: 11.5, weight: .medium))
            .foregroundStyle(color)
            .padding(.horizontal, 16)
            .frame(height: 24)
            .background(color.opacity(0.10))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(actions.alertAction == nil)
        .instantTooltip(text + (actions.alertAction == nil ? "" : "\nClick to open the call in the transcript"))
        .accessibilityIdentifier("session-details-alert")
    }

    private func metaRow(showStarted: Bool) -> some View {
        HStack(spacing: 14) {
            if let cwd = info.cwd, !cwd.isEmpty {
                metaItem("folder", (cwd as NSString).abbreviatingWithTildeInPath, tip: "\(cwd) · click to show it in Finder", action: info.cwdExists ? actions.openInFinder : nil)
                    .layoutPriority(1)
                    // GenesisTools adaptation: the folder's other actions, as in the sidebar's folder row.
                    .contextMenu {
                        Button("Copy path") { actions.copy(cwd) }
                        if let open = actions.openInFinder, info.cwdExists {
                            Button("Show in Finder", action: open)
                        }
                        if let open = actions.openInCursor, info.cwdExists {
                            Button("Open in Cursor", action: open)
                        }
                    }
            }
            if let branch = info.branch {
                metaItem("arrow.triangle.branch", branch, tip: actions.openBranch == nil ? "Git branch of the session folder · click to copy" : "Git branch of the session folder · click to open its web page", action: actions.openBranch ?? { actions.copy(branch) })
                    .layoutPriority(1)
            }
            if showStarted, let startedAt = info.startedAt {
                metaItem("clock", "started \(SessionFormat.moment(startedAt))", tip: "First entry of the loaded transcript")
                    .fixedSize()
            }
            if let last = info.lastActivityAt {
                HStack(spacing: 5) {
                    Image(systemName: "waveform.path")
                        .font(.system(size: 10))
                    // Its own clock: each second while it reads in seconds, then each minute, and
                    // the rest of the header never re-renders for it.
                    LiveTime(date: last) { "active \($0)" }
                }
                .font(.system(size: 11.5))
                .foregroundStyle(SessionPalette.dim)
                .lineLimit(1)
                .fixedSize()
                .instantTooltip("Last transcript entry or file write, \(SessionFormat.moment(last))")
            }
            Spacer(minLength: 8)
            Button {
                actions.copy(info.sessionId)
            } label: {
                Text(verbatim: info.shortId)
                    .font(SessionPalette.mono(11))
                    .foregroundStyle(SessionPalette.faint)
                    .lineLimit(1)
                    .fixedSize()
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Copy the session id \(info.sessionId)")
            .accessibilityIdentifier("session-details-copy-id")
        }
    }

    private var counters: some View {
        HStack(spacing: 10) {
            if let context = info.contextTokens {
                counter("ctx", SessionFormat.tokens(context), color: SessionPalette.secondary, tip: info.compacted ? "Context size after the last compaction" : "Context size of the last turn")
            }
            if let usage = info.usage, !usage.isEmpty {
                if usage.inputTokens > 0 {
                    counter("in", SessionFormat.tokens(usage.inputTokens), color: SessionPalette.blue, tip: "Fresh input tokens of the session\n\(usage.detailed)")
                }
                if usage.cacheReadTokens + usage.cacheWriteTokens > 0 {
                    counter("cache", SessionFormat.tokens(usage.cacheReadTokens + usage.cacheWriteTokens), color: SessionPalette.secondary, tip: "Cache reads plus cache writes\n\(usage.detailed)")
                }
                if usage.outputTokens > 0 {
                    counter("out", SessionFormat.tokens(usage.outputTokens), color: SessionPalette.green, tip: "Output tokens of the session\n\(usage.detailed)")
                }
                if let cost = usage.costUsd, cost > 0 {
                    // GenesisTools adaptation: an estimate names its source (the same note as the Cost tile).
                    counter(nil, SessionFormat.usd(cost), color: SessionPalette.orange, tip: usage.costNote ?? "Cost the session file reports")
                }
            }
            if info.errorCount > 0 {
                counter(nil, "\(info.errorCount) failed", color: SessionPalette.red, tip: "Failed tool calls in the loaded turns")
            }
        }
    }

    /// The context size and the failures only, for a narrow header.
    private var compactCounters: some View {
        HStack(spacing: 10) {
            if let context = info.contextTokens {
                counter("ctx", SessionFormat.tokens(context), color: SessionPalette.secondary, tip: "Context size of the last turn")
            }
            if info.errorCount > 0 {
                counter(nil, "\(info.errorCount) failed", color: SessionPalette.red, tip: "Failed tool calls in the loaded turns")
            }
        }
    }

    private func counter(_ label: String?, _ value: String, color: Color, tip: String) -> some View {
        Button { actions.copy(tip) } label: {
            HStack(spacing: 4) {
                if let label {
                    Text(verbatim: label)
                        .foregroundStyle(SessionPalette.faint)
                }
                Text(verbatim: value)
                    .foregroundStyle(color)
            }
            .font(SessionPalette.mono(12, weight: .semibold))
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tip + "\nClick to copy")
    }

    private var headerButtons: some View {
        HStack(spacing: 4) {
            Button {
                actions.copy(actions.resumeCommand)
            } label: {
                Image(systemName: "terminal")
                    .font(.system(size: 12))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 26))
            .instantTooltip("Copy the resume command")
            .accessibilityIdentifier("session-details-copy-resume")

            Button(action: actions.refresh) {
                Group {
                    if actions.refreshing {
                        ProgressView().controlSize(.mini)
                    } else {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 12))
                    }
                }
                .frame(width: 22, height: 22)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 26))
            .disabled(actions.refreshing)
            .keyboardShortcut("r", modifiers: .command)
            .instantTooltip("Reload the session and its transcript (⌘R)")
            .accessibilityIdentifier("session-details-refresh")

            Button {
                showSidebar.toggle()
            } label: {
                Image(systemName: "sidebar.right")
                    .font(.system(size: 12))
                    .frame(width: 22, height: 22)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 26))
            .instantTooltip(showSidebar ? "Hide the details sidebar" : "Show the details sidebar")
            .accessibilityIdentifier("session-details-sidebar-toggle")
        }
        .foregroundStyle(SessionPalette.secondary)
    }

    private func metaItem(_ symbol: String, _ text: String, tip: String, action: (() -> Void)? = nil) -> some View {
        Button { action?() } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 10))
                Text(verbatim: text)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .font(.system(size: 11.5))
            .foregroundStyle(SessionPalette.dim)
        }
        .buttonStyle(.genHoverPlain())
        .disabled(action == nil)
        .instantTooltip(tip)
    }
}

/// The review window's info banner: 10 pt rounded, quiet fill, a dismiss cross.
struct SessionBanner: View {
    let text: String
    let onDismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.circle")
                .foregroundStyle(SessionPalette.red)
            Text(verbatim: text)
                .font(.system(size: 12))
                .foregroundStyle(SessionPalette.text)
                .textSelection(.enabled)
            Spacer(minLength: 8)
            Button(action: onDismiss) {
                Image(systemName: "xmark")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 18, height: 18)
            }
            .buttonStyle(.genHoverIcon(accent: SessionPalette.red, diameter: 22))
            .instantTooltip("Dismiss")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 9)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(SessionPalette.red.opacity(0.10)))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .accessibilityIdentifier("session-details-banner")
    }
}

// MARK: - Sidebar

struct SessionDetailSidebar<Extra: View>: View {
    let info: SessionDetailInfo
    let digest: SessionActivityDigest
    let actions: SessionDetailActions
    let extra: Extra

    @State private var showAllFiles = false
    @State private var showReads = false
    @State private var showAllSubagents = false

    private static var fileLimit: Int { 10 }
    private static var subagentLimit: Int { 6 }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    overview
                    usageGrid
                    status
                    files
                    if !digest.commits.isEmpty { commits }
                    if !digest.subagents.isEmpty { subagents }
                    extra
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 14)
            }
            Rectangle().fill(SessionPalette.hairline).frame(height: 1)
            actionBar
        }
        .background(SessionPalette.sidebar)
        .accessibilityIdentifier("session-details-sidebar")
    }

    // Overview chips

    private var overview: some View {
        LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
            SessionStatChip(label: "Turns", value: "\(info.turnCount)")
            SessionStatChip(label: "Tool calls", value: "\(info.toolCount)")
            SessionStatChip(label: "Failed", value: "\(info.errorCount)", color: info.errorCount > 0 ? SessionPalette.red : SessionPalette.text)
            SessionStatChip(label: "Files changed", value: "\(digest.changedFiles.count)", color: digest.changedFiles.isEmpty ? SessionPalette.text : SessionPalette.orange)
            if let context = info.contextTokens {
                SessionStatChip(label: info.compacted ? "Context · compacted" : "Context", value: SessionFormat.tokens(context))
            }
        }
        .accessibilityIdentifier("session-details-stats")
    }

    /// Tokens and cost, all of them. Cost shows only what the session file or provider reported;
    /// nothing here prices tokens.
    @ViewBuilder
    private var usageGrid: some View {
        if let usage = info.usage, !usage.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                SessionSectionTitle(title: "Usage")
                    .padding(.bottom, 2)
                LazyVGrid(columns: [GridItem(.flexible(), spacing: 6), GridItem(.flexible(), spacing: 6)], spacing: 6) {
                    SessionStatChip(label: "Input", value: SessionFormat.tokens(usage.inputTokens), color: SessionPalette.blue)
                    SessionStatChip(label: "Output", value: SessionFormat.tokens(usage.outputTokens), color: SessionPalette.green)
                    SessionStatChip(label: "Cache read", value: SessionFormat.tokens(usage.cacheReadTokens))
                    SessionStatChip(label: "Cache write", value: SessionFormat.tokens(usage.cacheWriteTokens))
                    SessionStatChip(label: "Reasoning", value: usage.reasoningTokens > 0 ? SessionFormat.tokens(usage.reasoningTokens) : "—")
                    SessionStatChip(label: "Model calls", value: "\(usage.modelCalls)")
                    SessionStatChip(
                        label: "Cost",
                        value: usage.costUsd.map(SessionFormat.usd) ?? "not reported",
                        color: usage.costUsd == nil ? SessionPalette.faint : SessionPalette.orange
                    )
                    // GenesisTools adaptation: an estimate names its source.
                    .instantTooltip(usage.costUsd == nil ? "The session file records no price for its calls" : usage.costNote ?? "Summed from the session file")
                }
            }
            .accessibilityIdentifier("session-details-usage")
        }
    }

    // Status + place

    private var status: some View {
        VStack(alignment: .leading, spacing: 2) {
            SessionSectionTitle(title: "Session")
                .padding(.bottom, 4)
            row(symbol: nil, dot: info.livenessColor) {
                Text(verbatim: info.liveness.label)
                    .foregroundStyle(SessionPalette.text)
                Text(verbatim: info.livenessNote)
                    .foregroundStyle(SessionPalette.dim)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            .instantTooltip(info.livenessNote)
            if let cacheNote = info.cacheNote {
                row(symbol: "bolt", dot: nil) {
                    Text(verbatim: cacheNote)
                        .foregroundStyle(info.cacheCold ? SessionPalette.dim : SessionPalette.secondary)
                }
            }
            if let inPane = info.inPane {
                row(symbol: "rectangle.split.2x1", dot: nil, tip: inPane ? "Raise the pane" : "Choose a pane to resume in", action: actions.openTerminal ?? actions.focus) {
                    Text(inPane ? "Open in a cmux pane" : "No cmux pane")
                        .foregroundStyle(inPane ? SessionPalette.green : SessionPalette.dim)
                }
            }
            if let cwd = info.cwd, !cwd.isEmpty {
                row(symbol: "folder", dot: nil, action: info.cwdExists ? actions.openInFinder : nil) {
                    Text(verbatim: URL(fileURLWithPath: cwd).lastPathComponent)
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Spacer(minLength: 4)
                    folderButtons(cwd)
                }
                .instantTooltip((cwd as NSString).abbreviatingWithTildeInPath)
            }
            if let branch = info.branch {
                // GenesisTools adaptation: the tooltip carries the whole branch name, which truncates here.
                row(symbol: "arrow.triangle.branch", dot: nil, tip: "\(branch)\n\(actions.openBranch == nil ? "Copy the branch name" : "Open the branch's web page")", action: actions.openBranch ?? { actions.copy(branch) }) {
                    Text(verbatim: branch)
                        .font(SessionPalette.mono(11.5))
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            if let account = info.account, !account.isEmpty {
                row(symbol: "person.crop.circle", dot: nil, tip: "Copy the account name", action: { actions.copy(account) }) {
                    Text(verbatim: account)
                        .foregroundStyle(SessionPalette.secondary)
                    Text("pinned account")
                        .foregroundStyle(SessionPalette.faint)
                }
            }
            if let file = info.filePath, !file.isEmpty {
                // GenesisTools adaptation: one opener for every path (a missing file says so, Hub/HubPathActions.swift).
                row(symbol: "doc", dot: nil, action: { PathOpener.reveal(file) }) {
                    Text(verbatim: URL(fileURLWithPath: file).lastPathComponent)
                        .font(SessionPalette.mono(11))
                        .foregroundStyle(SessionPalette.dim)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                .instantTooltip(file)
            }
            if let note = info.note {
                Text(verbatim: note)
                    .font(.system(size: 11))
                    .foregroundStyle(SessionPalette.faint)
                    // GenesisTools adaptation: the note can be copied.
                    .textSelection(.enabled)
                    .padding(.top, 4)
            }
        }
    }

    private func folderButtons(_ cwd: String) -> some View {
        HStack(spacing: 2) {
            if let open = actions.openInCursor {
                iconButton("chevron.left.forwardslash.chevron.right", tip: "Open the folder in Cursor", enabled: info.cwdExists, action: open)
                    .accessibilityIdentifier("session-details-open-cursor")
            }
            if let open = actions.openInFinder {
                iconButton("folder", tip: "Show the folder in Finder", enabled: info.cwdExists, action: open)
                    .accessibilityIdentifier("session-details-open-finder")
            }
            iconButton("doc.on.doc", tip: "Copy \(cwd)", enabled: true) { actions.copy(cwd) }
                .accessibilityIdentifier("session-details-copy-folder")
        }
    }

    private func iconButton(_ symbol: String, tip: String, enabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 10.5))
                .foregroundStyle(SessionPalette.secondary)
                .frame(width: 16, height: 16)
        }
        .buttonStyle(.genHoverIcon(accent: SessionPalette.blue, diameter: 20))
        .disabled(!enabled)
        .instantTooltip(tip)
    }

    /// A sidebar row; with `action` the whole row is a button with the row hover (and `tip`, when
    /// given, as its tooltip; a caller's own tooltip stays on top of it).
    @ViewBuilder
    private func row<Content: View>(symbol: String?, dot: Color?, tip: String? = nil, action: (() -> Void)? = nil, @ViewBuilder content: () -> Content) -> some View {
        let body = HStack(spacing: 8) {
            Group {
                if let dot {
                    SessionStatusDot(color: dot, size: 7)
                } else if let symbol {
                    Image(systemName: symbol)
                        .font(.system(size: 10.5))
                        .foregroundStyle(SessionPalette.faint)
                }
            }
            .frame(width: 14)
            content()
        }
        .font(.system(size: 12))
        .frame(height: 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        if let action, let tip {
            Button(action: action) { body }
                .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 6))
                .instantTooltip(tip)
        } else if let action {
            Button(action: action) { body }
                .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 6))
        } else {
            body
        }
    }

    // Files

    private var files: some View {
        let changed = digest.changedFiles
        let reads = digest.readOnlyFiles
        let shown = showAllFiles ? changed : Array(changed.prefix(Self.fileLimit))

        return VStack(alignment: .leading, spacing: 1) {
            SessionSectionTitle(title: "Files touched", count: digest.files.count)
                .padding(.bottom, 5)
            if digest.files.isEmpty {
                emptyLine("No file reads or edits in the loaded turns.")
            }
            ForEach(shown) { file in
                FileTouchRow(file: file)
            }
            if changed.count > Self.fileLimit {
                moreButton(showAllFiles ? "Show fewer" : "Show \(changed.count - Self.fileLimit) more") { showAllFiles.toggle() }
            }
            if !reads.isEmpty {
                Button {
                    showReads.toggle()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 8.5, weight: .semibold))
                            .rotationEffect(.degrees(showReads ? 90 : 0))
                            .frame(width: 14)
                        Text("Read only")
                        Text(verbatim: "\(reads.count)")
                            .font(SessionPalette.mono(11))
                            .foregroundStyle(SessionPalette.faint)
                        Spacer(minLength: 0)
                    }
                    .font(.system(size: 11.5))
                    .foregroundStyle(SessionPalette.dim)
                    .frame(height: 24)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .accessibilityIdentifier("session-details-reads-toggle")
                if showReads {
                    ForEach(reads) { file in
                        FileTouchRow(file: file)
                    }
                }
            }
        }
        .accessibilityIdentifier("session-details-files")
    }

    private var commits: some View {
        VStack(alignment: .leading, spacing: 1) {
            SessionSectionTitle(title: "Commits", count: digest.commits.count)
                .padding(.bottom, 5)
            ForEach(digest.commits) { commit in
                Button {
                    actions.copy(commit.sha)
                } label: {
                    HStack(spacing: 8) {
                        Text(verbatim: String(commit.sha.prefix(7)))
                            .font(SessionPalette.mono(11.5, weight: .semibold))
                            .foregroundStyle(SessionPalette.blue)
                        Text(verbatim: commit.subject)
                            .font(.system(size: 12))
                            .foregroundStyle(SessionPalette.secondary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 6)
                    .frame(height: 26)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverRow(accent: .white, cornerRadius: 7))
                .instantTooltip("Copy \(commit.sha)\(commit.branch.map { " (\($0))" } ?? "")")
            }
        }
        .accessibilityIdentifier("session-details-commits")
    }

    // GenesisTools adaptation: a long run's sub-agents (89 in one session) pushed the hub's insight
    // sections out of reach, so the list shows the live and failed ones first and caps the rest.
    private var subagents: some View {
        let all = digest.subagents
        let open = all.filter { $0.state != .done }
        let ordered = open + all.filter { $0.state == .done }
        let limit = max(Self.subagentLimit, open.count)
        let shown = showAllSubagents ? ordered : Array(ordered.prefix(limit))
        return VStack(alignment: .leading, spacing: 1) {
            SessionSectionTitle(title: "Sub-agents", count: all.count)
                .padding(.bottom, 5)
            ForEach(shown) { agent in
                HStack(spacing: 8) {
                    SessionStatusDot(color: color(agent.state))
                        .frame(width: 14)
                    Text(verbatim: agent.summary)
                        .font(.system(size: 12))
                        .foregroundStyle(SessionPalette.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                    Spacer(minLength: 4)
                    Text(verbatim: stateLabel(agent.state))
                        .font(SessionPalette.mono(10.5))
                        .foregroundStyle(SessionPalette.faint)
                }
                .frame(height: 26)
                .instantTooltip(agent.summary)
            }
            if ordered.count > limit {
                moreButton(showAllSubagents ? "Show fewer" : "Show \(ordered.count - limit) more") { showAllSubagents.toggle() }
            }
        }
        .accessibilityIdentifier("session-details-subagents")
    }

    private func color(_ state: SessionSubagent.State) -> Color {
        switch state {
        case .done: return SessionPalette.green
        case .running, .background: return SessionPalette.orange
        case .failed: return SessionPalette.red
        }
    }

    private func stateLabel(_ state: SessionSubagent.State) -> String {
        switch state {
        case .done: return "done"
        case .running: return "running"
        case .background: return "background"
        case .failed: return "failed"
        }
    }

    private func emptyLine(_ text: String) -> some View {
        Text(verbatim: text)
            .font(.system(size: 11.5))
            .foregroundStyle(SessionPalette.faint)
            .frame(height: 22)
    }

    private func moreButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(title, action: action)
            .buttonStyle(.genHoverPlain())
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(SessionPalette.blue)
            .padding(.leading, 22)
            .frame(height: 22)
    }

    // Actions

    private var actionBar: some View {
        HStack(spacing: 6) {
            SessionActionButton(title: "Focus", symbol: "scope", tip: "Raise the live cmux pane", action: actions.focus)
                .accessibilityIdentifier("session-details-focus")
            SessionActionButton(title: "Wake", symbol: "alarm", tip: "Type a poke into the pane", action: actions.wake)
                .accessibilityIdentifier("session-details-wake")
            SessionActionButton(title: "Keepalive", symbol: "bolt.heart", tip: "Send /keepalive to the pane", action: actions.keepalive)
                .accessibilityIdentifier("session-details-keepalive")
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(height: 44)
    }
}

private struct FileTouchRow: View {
    let file: SessionFileTouch

    var body: some View {
        HStack(spacing: 8) {
            SessionStatusDot(color: dotColor)
                .frame(width: 14)
            Text(verbatim: file.name)
                .font(.system(size: 12))
                .foregroundStyle(file.changed ? SessionPalette.text : SessionPalette.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
                .layoutPriority(1)
            Text(verbatim: file.folder)
                .font(.system(size: 10.5))
                .foregroundStyle(SessionPalette.faint)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 4)
            Text(verbatim: countLabel)
                .font(SessionPalette.mono(10.5))
                .foregroundStyle(file.changed ? SessionPalette.orange.opacity(0.85) : SessionPalette.faint)
                .fixedSize()
        }
        .frame(height: 24)
        .instantTooltip(file.path)
        // GenesisTools adaptation: the row's path can be copied, revealed and opened.
        .contextMenu {
            Button("Copy path") { PathOpener.copy(file.path, what: "path") }
            Button("Reveal in Finder") { PathOpener.reveal(file.path) }
            Button("Open in Cursor") { PathOpener.cursor(file.path) }
        }
    }

    private var dotColor: Color {
        if file.writes > 0 && file.edits == 0 { return SessionPalette.green }
        if file.changed { return SessionPalette.orange }
        return SessionPalette.faint
    }

    private var countLabel: String {
        if file.changed {
            let n = file.edits + file.writes
            return n == 1 ? (file.writes > 0 ? "new" : "1 edit") : "\(n) edits"
        }
        return "\(file.reads)×"
    }
}

/// A 26 pt ghost button, the diff viewer comment card's "Edit" / "Delete" button.
private struct SessionActionButton: View {
    let title: String
    let symbol: String
    let tip: String
    let action: (() -> Void)?

    var body: some View {
        Button {
            action?()
        } label: {
            HStack(spacing: 5) {
                Image(systemName: symbol)
                    .font(.system(size: 10.5))
                Text(verbatim: title)
                    .font(.system(size: 11.5, weight: .medium))
            }
            .foregroundStyle(SessionPalette.secondary)
            .padding(.horizontal, 9)
            .frame(height: 26)
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.12)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.genHoverPlain())
        .disabled(action == nil)
        .instantTooltip(action == nil ? "\(tip) (needs a live cmux pane)" : tip)
    }
}
