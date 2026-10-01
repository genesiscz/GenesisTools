import AppKit
import SwiftUI

// The Agents mode: every agent session with its sub-agents, teammates and workers, from
// `tools hub agents --json` (src/hub/lib/agents, contract in .claude/plans/2026-10-01-HubAgentsTab.md).
// Swift parses no transcript here: the list is the CLI's answer, a child's transcript is the session
// screen (HubSessionDetailHost) on that child's file, and FSEvents on the open parents' folders say
// when to ask the CLI again.

// MARK: - Data

struct AgentNode: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let harness: String
    let kind: String
    var name: String?
    var description: String?
    var agentType: String?
    var model: String?
    var account: String?
    let status: String
    var startedAt: String?
    var lastAt: String
    var toolCalls: Int?
    var unreadMail: Int?
    var team: String?
    var backendType: String?
    var filePath: String?
    /// The whole prompt (up to 4000 chars): only in the one-agent answer, null in the list.
    var spawnPrompt: String?
    /// The list's 200-char preview, whitespace folded, `…` when cut.
    var spawnPromptPreview: String?
    var toolUseId: String?
    var spawnDepth: Int?
    var children: [AgentNode]?

    var title: String {
        if let name, !name.isEmpty { return name }
        if let description, !description.isEmpty { return description }
        return agentType ?? String(id.prefix(12))
    }

    var isRunning: Bool { status == "running" }
    var isTeammate: Bool { kind == "teammate" }
    var started: Date? { HubFormat.date(startedAt) }
    var last: Date? { HubFormat.date(lastAt) }
    var nested: [AgentNode] { children ?? [] }

    /// What `tools ai sessions tail` opens: the node's own file whenever the CLI gave one, so a codex
    /// and a grok worker that share a name never open each other's transcript; else the worker's name.
    var transcriptQuery: String? {
        if let filePath, !filePath.isEmpty { return filePath }
        if harness == "claude" { return nil }
        return id.isEmpty ? nil : id
    }

    /// Every text the sidebar filter matches.
    var haystack: String {
        [name, description, agentType, model, account, id, harness, kind, status, team].compactMap { $0 }.joined(separator: " ").lowercased()
    }

    /// This node or one below it is running.
    var anyRunning: Bool { isRunning || nested.contains(where: \.anyRunning) }
}

struct AgentParent: Codable, Equatable, Identifiable, Sendable {
    let sessionId: String
    let provider: String
    var title: String?
    var project: String?
    var cwd: String?
    var filePath: String?
    var model: String?
    var account: String?
    var startedAt: String?
    let lastAt: String
    var live: Bool?
    var children: [AgentNode]

    var id: String { sessionId }
    var displayTitle: String {
        let cleaned = TitleFormatter.cleanSessionTitle(title) ?? ""
        return cleaned.isEmpty ? String(sessionId.prefix(8)) : cleaned
    }

    var last: Date? { HubFormat.date(lastAt) }
    var isLive: Bool { (live ?? false) || children.contains(where: \.anyRunning) }
    var runningCount: Int { AgentTree.flatten(children).filter(\.isRunning).count }
    var totalCount: Int { AgentTree.flatten(children).count }

    /// Where Claude Code writes this session's sub-agents: `<project>/<sessionId>/subagents/`.
    var sessionFolder: String? {
        guard provider == "claude", let filePath, filePath.hasSuffix(".jsonl") else { return nil }
        return (filePath as NSString).deletingPathExtension
    }
}

struct AgentsEnvelope: Codable, Equatable, Sendable {
    var generatedAt: String?
    var parents: [AgentParent]
    var orphans: [AgentNode]?
}

/// `tools hub agents mail --session <p> --agent <c> --json`: a teammate's messages.
struct AgentMail: Codable, Equatable, Sendable {
    struct Message: Codable, Equatable, Sendable, Identifiable {
        var from: String?
        var to: String?
        var at: String?
        var text: String

        var id: String { "\(from ?? "")>\(to ?? "")@\(at ?? "")#\(text.prefix(40))" }
        var date: Date? { HubFormat.date(at) }
    }

    var received: [Message]
    var sent: [Message]
    var unread: [Message]

    var isEmpty: Bool { received.isEmpty && sent.isEmpty && unread.isEmpty }
}

enum AgentTree {
    static func flatten(_ nodes: [AgentNode]) -> [AgentNode] {
        nodes.flatMap { [$0] + flatten($0.nested) }
    }

    /// The key of one child in the list and in the navigation history: its parent session and its id.
    static func key(parent: String?, child: String) -> String {
        "\(parent ?? "-")|\(child)"
    }

    /// The child id of a parent's "Main" row: the lead session itself.
    static let mainChild = "::main"

    static func mainKey(_ parent: String) -> String {
        key(parent: parent, child: mainChild)
    }

    static func split(_ key: String) -> (parent: String?, child: String)? {
        let parts = key.split(separator: "|", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return (parts[0] == "-" ? nil : parts[0], parts[1])
    }

    /// `4m 12s`, `2h 05m`: how long a finished agent ran.
    static func duration(from start: Date?, to end: Date?) -> String? {
        guard let start, let end, end >= start else { return nil }
        let seconds = Int(end.timeIntervalSince(start))
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m \(String(format: "%02d", seconds % 60))s" }
        return "\(seconds / 3600)h \(String(format: "%02d", (seconds % 3600) / 60))m"
    }

    static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm:ss"
        return formatter
    }()

    static let day: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM"
        return formatter
    }()

    static func started(_ date: Date?) -> String? {
        guard let date else { return nil }
        return String((Calendar.current.isDateInToday(date) ? clock : day).string(from: date).prefix(Calendar.current.isDateInToday(date) ? 5 : 20))
    }
}

/// The `tools hub agents` doors. Blocking: call off the main thread.
enum AgentsSource {
    /// `GENESIS_HUB_AGENTS_FIXTURE=<file>`: the list from a file of the contract's shape instead of the CLI.
    static let fixture = ProcessInfo.processInfo.environment["GENESIS_HUB_AGENTS_FIXTURE"]
    /// The last whole list, painted when the mode opens while the CLI answers (Hub/HubSWR.swift).
    static let cache = HubSWR.cache("agents")

    static func list(session: String?) throws -> AgentsEnvelope {
        if let fixture {
            return try decode(Data(contentsOf: URL(fileURLWithPath: fixture)))
        }

        let args = ["hub", "agents", "--json"] + (session.map { ["--session", $0] } ?? [])
        return try decode(run(args))
    }

    /// `tools hub agents --session <p> --agent <c> --json`: one agent with its whole spawn prompt.
    static func agent(parent: String?, child: String) throws -> AgentNode {
        struct Envelope: Decodable {
            let agent: AgentNode
        }

        let args = ["hub", "agents", "--agent", child, "--json"] + (parent.map { ["--session", $0] } ?? [])
        return try JSONDecoder().decode(Envelope.self, from: MonitorJSON.dataByDroppingPreamble(run(args))).agent
    }

    /// Whole spawn prompts by agent key: a prompt never changes once the agent started.
    static let prompts = HubSWR.cache("agent-prompts")

    /// One running agent's numbers from `tools hub agents counts` (a tail read of its own file only).
    struct Count: Decodable, Sendable {
        let id: String
        let toolCalls: Int?
        let lastAt: String
        let status: String
    }

    /// `tools hub agents counts --session <p> --ids a,b --json`: about 0.1 s CPU against 0.42 s for the tree.
    static func counts(parent: String, ids: [String]) throws -> [Count] {
        struct Envelope: Decodable {
            let agents: [Count]
        }

        let data = try run(["hub", "agents", "counts", "--session", parent, "--ids", ids.joined(separator: ","), "--json"])
        return try JSONDecoder().decode(Envelope.self, from: MonitorJSON.dataByDroppingPreamble(data)).agents
    }

    static func mail(parent: String, child: String) throws -> AgentMail {
        let data = try run(["hub", "agents", "mail", "--session", parent, "--agent", child, "--json"])
        return try JSONDecoder().decode(AgentMail.self, from: MonitorJSON.dataByDroppingPreamble(data))
    }

    static func decode(_ data: Data) throws -> AgentsEnvelope {
        try JSONDecoder().decode(AgentsEnvelope.self, from: MonitorJSON.dataByDroppingPreamble(data))
    }

    private static func run(_ args: [String]) throws -> Data {
        let result = try ToolsCLIRunner.capture(args, timeout: 90)
        guard result.status == 0 else {
            let message = String(decoding: result.stderr.isEmpty ? result.stdout : result.stderr, as: UTF8.self).trimmed
            throw ReviewError.git("tools \(args.prefix(3).joined(separator: " ")) exited \(result.status): \(message.suffix(300))")
        }

        return result.stdout
    }
}

/// The folders the Agents mode watches and the files in them that matter.
enum AgentWatch {
    /// The worker session folders under the same tools home the CLI uses (`GENESIS_TOOLS_HOME`, else
    /// the home directory: `SettingsModel.toolsHome`), mirroring `sessionsDir()` in the codex and grok
    /// worker-path modules.
    static let workerFolders: [String] = {
        let home = SettingsModel.toolsHome
        return ["\(home)/.genesis-tools/codex/sessions", "\(home)/.genesis-tools/grok/sessions"]
    }()

    static let teamsFolder = FileManager.default.homeDirectoryForCurrentUser.path + "/.claude/teams"

    /// Sub-agent transcripts and metas, team inboxes, worker metas and transcripts; nothing else.
    static func matters(_ path: String) -> Bool {
        if path.contains("/subagents/") || path.contains("/inboxes/") {
            return path.hasSuffix(".jsonl") || path.hasSuffix(".json")
        }

        return workerFolders.contains { path.hasPrefix($0) } && (path.hasSuffix(".jsonl") || path.hasSuffix(".meta.json"))
    }
}

// MARK: - Model

/// The Agents mode's state. Active only while the mode shows: then one FSEvents stream covers the open
/// parents' session folders (their `subagents/`), their teams' inboxes and the codex and grok worker
/// folders, and an event asks the CLI again for the parent it touched. No timer runs faster than 30 s.
@MainActor
final class HubAgentsModel: ObservableObject {
    @Published private(set) var parents: [AgentParent] = []
    @Published private(set) var orphans: [AgentNode] = []
    @Published private(set) var loading = false
    @Published private(set) var showingCached = false
    @Published private(set) var loaded = false
    @Published private(set) var error: String?
    /// `AgentTree.key(parent:child:)` of the open child.
    @Published var selectedID: String? {
        didSet {
            if selectedID != oldValue {
                selectionChanged()
            }
        }
    }
    /// A parent folded or unfolded by hand; the rest follow `defaultOpen`.
    @Published private(set) var foldOverride: [String: Bool] = [:]
    @Published private(set) var mail: AgentMail?
    @Published private(set) var mailError: String?
    @Published private(set) var loadingMail = false
    /// Whole spawn prompts by agent key, loaded once per child (the list carries a preview only).
    @Published private(set) var prompts: [String: String] = [:]
    private var promptsLoading = Set<String>()
    /// Bumped by a deep link or a back/forward step: the list scrolls the selected row into view then,
    /// and only then (a refresh or a click never scrolls).
    @Published private(set) var revealRequest = 0
    /// The pointer is over the list: reorders wait (`StickyOrder` hold) until it leaves.
    var holdOrder = false {
        didSet {
            if oldValue, !holdOrder, orderHeld {
                reorder()
            }
        }
    }
    private var orderHeld = false
    /// The next ordering sorts everything again: the mode opened, a filter changed, a manual refresh.
    private var resortNext = true
    private var parentOrder = StickyOrder<String>()
    private var childOrders: [String: StickyOrder<String>] = [:]
    private var orphanOrder = StickyOrder<String>()

    /// A scripted run settles once the first fresh list is on screen (`--mode agents --snapshot`).
    var onLoaded: (() -> Void)?

    private var index: [String: (parent: AgentParent?, node: AgentNode)] = [:]
    private var pendingRequest: (parent: String?, child: String)?
    private var active = false
    private var watcher: DirectoryWatcher?
    private var safety: Task<Void, Never>?
    private var inFlight = false
    private var queuedFull = false
    private var queuedSessions = Set<String>()
    private var lastStart = Date.distantPast
    private var scheduled = false
    private var mailRequest = 0
    /// A refresh that may show something new (a new agent, a changed inbox) waits for this gap.
    private var queuedUrgent = false
    /// The open teammate's transcript or its team's inbox changed since its mail was read.
    private var mailDirty = false
    /// Every agent transcript the list knows: a write to one of them is growth, not a new agent.
    private var knownFiles = Set<String>()
    /// Which parent and agent each listed transcript belongs to.
    private var fileOwners: [String: (parent: String, child: String)] = [:]
    private var countsQueued: [String: Set<String>] = [:]
    private var countsInFlight = false
    private var countsScheduled = false
    private var countsLastStart = Date.distantPast
    /// The least time between two starts of `tools hub agents` (each one a bun process): 2 s when
    /// something new may have appeared, 5 s when known transcripts only grew (a running sub-agent
    /// writes its file many times a second; its row's tool count and last activity follow within 5 s).
    private static let urgentGap: TimeInterval = 2
    private static let growthGap: TimeInterval = 5

    private static let workerFolders = AgentWatch.workerFolders
    private static let teamsFolder = AgentWatch.teamsFolder

    /// The parent whose Main row (the lead session) is open.
    var selectedMain: AgentParent? {
        guard let id = selectedID, let key = AgentTree.split(id), key.child == AgentTree.mainChild, let parent = key.parent else { return nil }
        return parents.first { $0.sessionId == parent }
    }

    /// The parent of whatever is open: an agent's, or the Main row's.
    var selectedParent: AgentParent? {
        selected?.parent ?? selectedMain
    }

    /// A parent row's title, the Main row, a child's breadcrumb, Return: the lead session in the detail.
    func openMain(_ parent: AgentParent) {
        HubMainBusy.measure("agents.openMain")
        foldOverride[parent.sessionId] = true
        selectedID = AgentTree.mainKey(parent.sessionId)
    }

    /// Left and Right on the list: fold or unfold the open row's parent.
    func foldSelection(open: Bool) {
        guard let parent = selectedParent, isOpen(parent) != open else { return }
        foldOverride[parent.sessionId] = open
        rewatch()
    }

    var selected: (parent: AgentParent?, node: AgentNode)? {
        selectedID.flatMap { index[$0] }
    }

    func isOpen(_ parent: AgentParent) -> Bool {
        foldOverride[parent.sessionId] ?? defaultOpen(parent)
    }

    private func defaultOpen(_ parent: AgentParent) -> Bool {
        isLive(parent) || selected?.parent?.sessionId == parent.sessionId
    }

    func toggle(_ parent: AgentParent) {
        foldOverride[parent.sessionId] = !isOpen(parent)
        rewatch()
    }

    /// In the Live group: active now, or within two minutes of it, so a turn boundary does not move it.
    func isLive(_ parent: AgentParent) -> Bool {
        parent.isLive || parentOrder.isActive(parent.sessionId)
    }

    /// A child in its parent's sticky active bucket.
    func isActive(parent: String?, child: String) -> Bool {
        (parent.flatMap { childOrders[$0] } ?? orphanOrder).isActive(child)
    }

    /// The menu's Reload: ask the CLI again and sort the answer fresh.
    func reload() {
        resortNext = true
        refresh(sessions: nil)
    }

    /// A full re-sort (filter change, manual refresh), animated.
    func requestResort() {
        resortNext = true
        reorder()
    }

    /// Applies the order again to the rows on screen (the pointer left the list, or a re-sort).
    private func reorder() {
        let now = Date()
        let nextParents = ordered(parents, now: now)
        let nextOrphans = orderedOrphans(orphans, now: now)
        publish(nextParents, nextOrphans)
    }

    /// Lands new rows. Moves (a new row, a bucket change) slide with the SWR animation; a refresh that only
    /// changed counts and times lands without one: animated, every such refresh cost about 500 ms of main
    /// thread in frame commits (`hub.agents.refresh.render`, 2026-10-01).
    private func publish(_ nextParents: [AgentParent], _ nextOrphans: [AgentNode]) {
        guard nextParents != parents || nextOrphans != orphans else { return }
        let shape: ([AgentParent], [AgentNode]) -> [String] = { parents, orphans in
            parents.flatMap { ["p" + $0.sessionId] + AgentTree.flatten($0.children).map(\.id) } + orphans.map(\.id)
        }
        let moved = shape(nextParents, nextOrphans) != shape(parents, orphans)
        let land = {
            if nextParents != self.parents { self.parents = nextParents }
            if nextOrphans != self.orphans { self.orphans = nextOrphans }
        }
        if moved {
            withAnimation(SWR.animation, land)
        } else {
            land()
        }
    }

    /// Parents and each parent's children in their sticky order (GenesisKit `StickyOrder`).
    private func ordered(_ raw: [AgentParent], now: Date) -> [AgentParent] {
        let resort = resortNext
        let hold = holdOrder && !resort
        orderHeld = hold
        resortNext = false
        let byId = Dictionary(raw.map { ($0.sessionId, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = parentOrder.update(raw.map { .init(id: $0.sessionId, active: $0.isLive, lastAt: $0.last ?? .distantPast) }, now: now, resort: resort, hold: hold)
        return ids.compactMap { byId[$0] }.map { parent in
            var copy = parent
            var order = childOrders[parent.sessionId] ?? StickyOrder()
            let children = Dictionary(parent.children.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
            let childIds = order.update(parent.children.map { .init(id: $0.id, active: $0.anyRunning, lastAt: $0.last ?? .distantPast) }, now: now, resort: resort, hold: hold)
            childOrders[parent.sessionId] = order
            copy.children = childIds.compactMap { children[$0] }
            return copy
        }
    }

    private func orderedOrphans(_ raw: [AgentNode], now: Date) -> [AgentNode] {
        let byId = Dictionary(raw.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        let ids = orphanOrder.update(raw.map { .init(id: $0.id, active: $0.anyRunning, lastAt: $0.last ?? .distantPast) }, now: now, resort: false, hold: holdOrder)
        return ids.compactMap { byId[$0] }
    }

    var anyRunning: Bool {
        parents.contains { $0.children.contains(where: \.anyRunning) } || orphans.contains(where: \.anyRunning)
    }

    // MARK: Activation

    /// The mode came on screen: paint the last list, ask the CLI, watch the open parents.
    func activate() {
        guard !active else { return }
        active = true
        // Opening the mode is an explicit action: the first list sorts fresh.
        resortNext = true
        HubPerf.log("agents.activate")
        if !loaded {
            Task {
                if let data = await AgentsSource.cache.loadData(key: "all"), parents.isEmpty, orphans.isEmpty,
                   let cached = try? AgentsSource.decode(data) {
                    HubSWR.painted("agents.list", "\(cached.parents.count) parents")
                    showingCached = true
                    apply(cached, scope: nil)
                }
            }
        }
        refresh(sessions: nil)
        rewatch()
        startSafety()
    }

    /// The mode left the screen: no watcher, no refresh.
    func deactivate() {
        guard active else { return }
        active = false
        HubPerf.log("agents.deactivate")
        watcher?.stop()
        watcher = nil
        safety?.cancel()
        safety = nil
        // Nothing queued survives the mode: a request already running finishes, nothing new starts.
        queuedFull = false
        queuedSessions = []
        queuedUrgent = false
        countsQueued = [:]
    }

    /// A slow re-ask behind the events: a finished agent stops writing, so no event says it went idle.
    private func startSafety() {
        safety?.cancel()
        safety = Task { [weak self] in
            while !Task.isCancelled {
                let running = self?.anyRunning ?? false
                try? await Task.sleep(for: .seconds(running ? 30 : 120))
                guard !Task.isCancelled else { break }
                self?.refresh(sessions: nil)
            }
        }
    }

    // MARK: Refresh

    /// Ask the CLI again: `sessions` nil is the whole list, else only those parents (`--session`).
    func refresh(sessions: Set<String>?, urgent: Bool = true) {
        queuedUrgent = queuedUrgent || urgent
        if let sessions, !queuedFull {
            queuedSessions.formUnion(sessions)
        } else {
            queuedFull = true
            queuedSessions = []
        }
        startIfDue()
    }

    private func startIfDue() {
        guard active, !inFlight, queuedFull || !queuedSessions.isEmpty else { return }
        let wait = (queuedUrgent ? Self.urgentGap : Self.growthGap) - Date().timeIntervalSince(lastStart)
        if wait > 0 {
            guard !scheduled else { return }
            scheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                MainActor.assumeIsolated {
                    self?.scheduled = false
                    self?.startIfDue()
                }
            }
            return
        }

        // One parent goes through `--session`; several, or a worker folder, ask for the whole list.
        let scope: String? = queuedFull || queuedSessions.count > 1 ? nil : queuedSessions.first
        queuedFull = false
        queuedSessions = []
        queuedUrgent = false
        inFlight = true
        lastStart = Date()
        loading = true
        Task {
            let span = HubPerf.begin("agents.list", scope.map { "session \($0.prefix(8))" } ?? "all", awaits: true)
            let result = await Task.detached(priority: .utility) { Result { try AgentsSource.list(session: scope) } }.value
            inFlight = false
            loading = false
            switch result {
            case .success(let envelope):
                span.end("\(envelope.parents.count) parents")
                error = nil
                if scope == nil {
                    showingCached = false
                    if let data = try? JSONEncoder().encode(envelope) {
                        Task.detached(priority: .utility) { AgentsSource.cache.writeData(data, key: "all") }
                    }
                }
                apply(envelope, scope: scope)
            case .failure(let failure):
                span.end("failed")
                error = "\(failure)"
                HubPerf.log("agents.list failed: \(failure)")
            }
            if !loaded || scope == nil {
                loaded = true
                onLoaded?()
                onLoaded = nil
            }
            resolvePendingRequest(final: scope == nil)
            startIfDue()
        }
    }

    /// Lands a list: the whole list, or one parent merged into the one on screen. Equal data publishes nothing.
    private func apply(_ envelope: AgentsEnvelope, scope: String?) {
        var nextParents = parents
        var nextOrphans = orphans
        if let scope {
            // In place: the parent keeps its slot, the order below decides any move.
            if let fresh = envelope.parents.first(where: { $0.sessionId == scope }) {
                if let slot = nextParents.firstIndex(where: { $0.sessionId == scope }) {
                    nextParents[slot] = fresh
                } else {
                    nextParents.append(fresh)
                }
            }
        } else {
            nextParents = envelope.parents
            nextOrphans = envelope.orphans ?? []
        }
        let now = Date()
        nextParents = ordered(nextParents, now: now)
        nextOrphans = orderedOrphans(nextOrphans, now: now)
        let pathsBefore = watchedPaths()
        if nextParents != parents || nextOrphans != orphans {
            // What a refresh costs on screen: the list and the open detail re-rendering after it.
            HubMainBusy.measure("agents.refresh.render")
        }
        publish(nextParents, nextOrphans)
        rebuildIndex()
        if watchedPaths() != pathsBefore {
            rewatch()
        }
        // The open teammate's mail, once its transcript or an inbox changed.
        if mailDirty, let current = selected, current.node.isTeammate, scope == nil || scope == current.parent?.sessionId {
            mailDirty = false
            loadMail()
        }
    }

    private func rebuildIndex() {
        var next: [String: (parent: AgentParent?, node: AgentNode)] = [:]
        for parent in parents {
            for node in AgentTree.flatten(parent.children) {
                next[AgentTree.key(parent: parent.sessionId, child: node.id)] = (parent, node)
            }
        }
        for node in AgentTree.flatten(orphans) {
            next[AgentTree.key(parent: nil, child: node.id)] = (nil, node)
        }
        index = next
        knownFiles = Set(next.values.compactMap(\.node.filePath))
        fileOwners = Dictionary(next.values.compactMap { value in
            guard let path = value.node.filePath, let parent = value.parent else { return nil }
            return (path, (parent.sessionId, value.node.id))
        }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: Watching

    private func watchedPaths() -> [String] {
        guard active else { return [] }
        var paths = Set(Self.workerFolders)
        for parent in parents where isOpen(parent) || selectedParent?.sessionId == parent.sessionId {
            if let folder = parent.sessionFolder {
                paths.insert(folder)
            }
            for team in Set(AgentTree.flatten(parent.children).compactMap(\.team)) {
                paths.insert("\(Self.teamsFolder)/\(team)/inboxes")
            }
        }
        return paths.sorted()
    }

    /// One stream for every open parent (not one per row); rebuilt only when the folder set changes.
    private func rewatch() {
        let paths = watchedPaths()
        guard paths != (watcher?.paths ?? []) else { return }
        watcher?.stop()
        watcher = nil
        guard !paths.isEmpty else { return }
        HubPerf.log("agents.watch \(paths.count) folders")
        watcher = DirectoryWatcher(paths: paths, latency: 0.5, accepts: AgentWatch.matters) { [weak self] changed in
            MainActor.assumeIsolated { self?.filesChanged(changed) }
        }
    }

    private func filesChanged(_ paths: [String]) {
        var sessions = Set<String>()
        var full = false
        for path in paths {
            if let parent = parents.first(where: { parent in parent.sessionFolder.map { path.hasPrefix($0 + "/") } ?? false }) {
                sessions.insert(parent.sessionId)
            } else if path.hasPrefix(Self.teamsFolder + "/"),
                      let parent = parents.first(where: { parent in parent.children.contains { $0.team.map { path.hasPrefix("\(Self.teamsFolder)/\($0)/") } ?? false } }) {
                sessions.insert(parent.sessionId)
            } else {
                full = true
            }
        }
        if let open = selected?.node.filePath, paths.contains(where: { $0 == open || $0.contains("/inboxes/") }) {
            mailDirty = true
        }
        // Only writes to transcripts already listed: those rows' numbers through the cheap counts door,
        // never the whole tree. Anything else (a new agent, a meta, an inbox, a worker folder) asks for the tree.
        let grown = paths.compactMap { fileOwners[$0] }
        if !full, grown.count == paths.count {
            for owner in grown {
                countsQueued[owner.parent, default: []].insert(owner.child)
            }
            startCountsIfDue()
            return
        }
        let urgent = paths.contains { !knownFiles.contains($0) }
        refresh(sessions: full ? nil : sessions, urgent: urgent)
    }

    // MARK: Counts of growing transcripts

    private func startCountsIfDue() {
        guard active, !countsInFlight, !countsQueued.isEmpty else { return }
        let wait = Self.growthGap - Date().timeIntervalSince(countsLastStart)
        if wait > 0 {
            guard !countsScheduled else { return }
            countsScheduled = true
            DispatchQueue.main.asyncAfter(deadline: .now() + wait) { [weak self] in
                MainActor.assumeIsolated {
                    self?.countsScheduled = false
                    self?.startCountsIfDue()
                }
            }
            return
        }

        let batch = countsQueued
        countsQueued = [:]
        countsInFlight = true
        countsLastStart = Date()
        Task {
            for (parent, ids) in batch {
                let span = HubPerf.begin("agents.counts", "\(ids.count) agents of \(parent.prefix(8))", awaits: true)
                let list = Array(ids)
                let result = await Task.detached(priority: .utility) { Result { try AgentsSource.counts(parent: parent, ids: list) } }.value
                switch result {
                case .success(let counts):
                    span.end("\(counts.count) rows")
                    applyCounts(counts, parent: parent)
                case .failure(let failure):
                    span.end("failed")
                    HubPerf.log("agents.counts failed: \(failure)")
                    refresh(sessions: [parent], urgent: false)
                }
            }
            countsInFlight = false
            startCountsIfDue()
        }
    }

    /// Patches only the numbers of the counted rows: same order, same identity, no animation. A row that
    /// stopped running reads the parent's tree once, which alone knows `failed` and the task notifications.
    private func applyCounts(_ counts: [AgentsSource.Count], parent: String) {
        guard let slot = parents.firstIndex(where: { $0.sessionId == parent }) else { return }
        let byId = Dictionary(counts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // A status change either way (an agent stopped, or an idle teammate got work) reads the tree
        // once: only it knows `failed`, the task notifications and the Active filter's state.
        var statusChanged = false
        func patch(_ nodes: [AgentNode]) -> [AgentNode] {
            nodes.map { node in
                var copy = node
                if let count = byId[node.id] {
                    copy.toolCalls = count.toolCalls ?? node.toolCalls
                    copy.lastAt = count.lastAt
                    if node.isRunning != (count.status == "running") {
                        statusChanged = true
                    }
                }
                copy.children = node.children.map(patch)
                return copy
            }
        }
        var next = parents
        next[slot].children = patch(parents[slot].children)
        if next != parents {
            HubMainBusy.measure("agents.counts.render")
            parents = next
            rebuildIndex()
        }
        if statusChanged {
            refresh(sessions: [parent], urgent: true)
        } else if mailDirty, let current = selected, current.node.isTeammate, current.parent?.sessionId == parent {
            mailDirty = false
            loadMail()
        }
    }

    // MARK: Selection, mail, deep links

    /// Back and forward: select and scroll the row into view.
    func select(parent: String?, child: String) {
        selectedID = AgentTree.key(parent: parent, child: child)
        revealRequest += 1
    }

    private func selectionChanged() {
        // A mail read still running belongs to the previous row: its answer must not land on this one.
        mailRequest += 1
        loadingMail = false
        mail = nil
        mailError = nil
        if let parent = selected?.parent {
            // The open child's parent unfolds and joins the watch.
            if foldOverride[parent.sessionId] == false {
                foldOverride[parent.sessionId] = true
            }
        }
        rewatch()
        if selected?.node.isTeammate == true {
            loadMail()
        }
        loadPrompt()
    }

    /// The open child's whole spawn prompt: from disk when read before, else `tools hub agents --agent`, once.
    private func loadPrompt() {
        guard let key = selectedID, let current = selected, prompts[key] == nil, !promptsLoading.contains(key) else { return }
        if let full = current.node.spawnPrompt, !full.isEmpty {
            prompts[key] = full
            return
        }
        promptsLoading.insert(key)
        let parent = current.parent?.sessionId
        let child = current.node.id
        Task {
            let span = HubPerf.begin("agents.prompt", child, awaits: true)
            let result = await Task.detached(priority: .utility) { () -> Result<String, Error> in
                if let data = AgentsSource.prompts.readData(key: key), let text = String(data: data, encoding: .utf8) {
                    return .success(text)
                }
                return Result {
                    let text = try AgentsSource.agent(parent: parent, child: child).spawnPrompt ?? ""
                    AgentsSource.prompts.writeData(Data(text.utf8), key: key)
                    return text
                }
            }.value
            promptsLoading.remove(key)
            switch result {
            case .success(let text):
                span.end("\(text.count) chars")
                prompts[key] = text
            case .failure(let failure):
                span.end("failed")
                HubPerf.log("agents.prompt failed for \(child): \(failure)")
            }
        }
    }

    func loadMail() {
        guard let current = selected, current.node.isTeammate, let parent = current.parent else { return }
        mailRequest += 1
        let request = mailRequest
        let parentId = parent.sessionId
        let child = current.node.id
        loadingMail = true
        Task {
            let span = HubPerf.begin("agents.mail", child, awaits: true)
            let result = await Task.detached(priority: .utility) { Result { try AgentsSource.mail(parent: parentId, child: child) } }.value
            guard request == mailRequest else {
                span.end("superseded")
                return
            }
            loadingMail = false
            switch result {
            case .success(let fresh):
                span.end("\(fresh.received.count) in, \(fresh.sent.count) out, \(fresh.unread.count) unread")
                mailError = nil
                if fresh != mail {
                    mail = fresh
                }
            case .failure(let failure):
                span.end("failed")
                mailError = "\(failure)"
            }
        }
    }

    /// `--session <parent> --agent <child>`: selects that child once the list holds it. The child may be
    /// named by its id, its id's start, or its teammate name; the parent by its id or id's start.
    func request(parent: String?, child: String) {
        pendingRequest = (parent, child)
        resolvePendingRequest(final: false)
    }

    private func resolvePendingRequest(final: Bool) {
        guard let wanted = pendingRequest, loaded || !parents.isEmpty else { return }
        // `--session <p>` alone: the lead session's Main row.
        if wanted.child == AgentTree.mainChild {
            if let parent = parents.first(where: { wanted.parent.map($0.sessionId.hasPrefix) ?? false }) {
                pendingRequest = nil
                foldOverride[parent.sessionId] = true
                selectedID = AgentTree.mainKey(parent.sessionId)
                revealRequest += 1
            } else if final {
                pendingRequest = nil
                error = "No agent session \(wanted.parent?.prefix(8) ?? "") in the list"
            }
            return
        }
        let hit = index.first { key, value in
            let parentMatches = wanted.parent.map { want in value.parent.map { $0.sessionId.hasPrefix(want) } ?? false } ?? true
            let node = value.node
            return parentMatches && (node.id == wanted.child || node.id.hasPrefix(wanted.child) || node.name == wanted.child || key.hasSuffix("|" + wanted.child))
        }
        if let hit {
            pendingRequest = nil
            if let parent = hit.value.parent {
                foldOverride[parent.sessionId] = true
            }
            selectedID = hit.key
            revealRequest += 1
        } else if final {
            pendingRequest = nil
            error = "No agent \(wanted.child)\(wanted.parent.map { " under session \($0.prefix(8))" } ?? "") in the list"
        }
    }

    /// The child's transcript as a session row for the shared session screen.
    static func transcriptRow(parent: AgentParent?, node: AgentNode) -> HubSession? {
        guard let query = node.transcriptQuery else { return nil }
        let millis = (node.last?.timeIntervalSince1970 ?? 0) * 1000
        return HubSession(
            provider: node.harness,
            sessionId: query,
            title: node.title,
            cwd: parent?.cwd ?? "",
            cwdShort: parent?.project ?? "",
            project: parent?.project,
            mtime: millis,
            model: node.model,
            cacheStatus: nil,
            cacheTtlSec: nil,
            account: node.account ?? parent?.account,
            filePath: node.filePath ?? ""
        )
    }
}

// MARK: - Sidebar

private enum AgentListItem: Identifiable {
    case parent(AgentParent, open: Bool, running: Int, total: Int)
    case main(AgentParent)
    case child(AgentNode, parent: String?, depth: Int)
    case more(parent: String, hidden: Int)

    var id: String {
        switch self {
        case .parent(let parent, _, _, _): return "p|" + parent.sessionId
        case .child(let node, let parent, _): return "c|" + AgentTree.key(parent: parent, child: node.id)
        case .more(let parent, _): return "m|" + parent
        case .main(let parent): return "c|" + AgentTree.mainKey(parent.sessionId)
        }
    }
}

/// Which agents the list shows (the chips in the "Live" header). Active is the default: running
/// agents, and ones that ran in the last two minutes (`StickyOrder`'s hold), so a turn boundary does
/// not hide a row.
enum AgentStatusFilter: String, CaseIterable {
    case all, active, idle, off

    var title: String {
        switch self {
        case .all: return "All"
        case .active: return "Active"
        case .idle: return "Idle"
        case .off: return "Off"
        }
    }

    var tooltip: String {
        switch self {
        case .all: return "Every agent"
        case .active: return "Running agents, and ones that ran in the last two minutes"
        case .idle: return "Teammates waiting for work"
        case .off: return "Finished, failed or killed agents"
        }
    }
}

struct AgentsListView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var agents: HubAgentsModel
    @AppStorage("hub.agents.statusFilter") private var statusRaw = AgentStatusFilter.active.rawValue
    /// Parents whose finished children show beyond the first `shownPerParent`.
    @State private var expandedAll = Set<String>()
    /// A row click puts the keyboard on the list, for Left, Right and Return.
    @FocusState private var listFocused: Bool
    private static let shownPerParent = 40

    private var status: AgentStatusFilter { AgentStatusFilter(rawValue: statusRaw) ?? .active }

    private func statusMatches(_ node: AgentNode, parent: String?) -> Bool {
        switch status {
        case .all: return true
        case .active: return node.anyRunning || agents.isActive(parent: parent, child: node.id)
        case .idle: return node.status == "idle"
        case .off: return ["completed", "failed", "killed"].contains(node.status)
        }
    }

    /// The nodes that pass the text and status filters, keeping a parent node for a matching child.
    /// The open agent always stays, so a filter never takes the row being read.
    private func matching(_ nodes: [AgentNode], parent: String?, needle: String) -> [AgentNode] {
        nodes.compactMap { node in
            let below = matching(node.nested, parent: parent, needle: needle)
            let open = agents.selectedID == AgentTree.key(parent: parent, child: node.id)
            let hit = open || ((needle.isEmpty || node.haystack.contains(needle)) && statusMatches(node, parent: parent))
            if hit {
                var copy = node
                copy.children = below
                return copy
            }
            guard !below.isEmpty else { return nil }
            var copy = node
            copy.children = below
            return copy
        }
    }

    private func items(for parents: [AgentParent], needle: String) -> [AgentListItem] {
        var rows: [AgentListItem] = []
        for parent in parents {
            let parentHit = needle.isEmpty || "\(parent.displayTitle) \(parent.project ?? "") \(parent.account ?? "") \(parent.sessionId) \(parent.provider)".lowercased().contains(needle)
            let children = matching(parent.children, parent: parent.sessionId, needle: parentHit ? "" : needle)
            // With a status filter on, a parent with nothing to show stays out of the list.
            // The parent and its Main row always show; a text filter still has to match it or a child.
            guard parentHit || !children.isEmpty else { continue }
            let open = needle.isEmpty || parentHit ? agents.isOpen(parent) : true
            rows.append(.parent(parent, open: open, running: parent.runningCount, total: parent.totalCount))
            guard open else { continue }
            rows.append(.main(parent))
            let limit = expandedAll.contains(parent.sessionId) ? Int.max : Self.shownPerParent
            var shown = 0
            for child in children {
                if shown >= limit, !child.anyRunning {
                    continue
                }
                shown += 1
                append(child, parent: parent.sessionId, depth: 0, into: &rows)
            }
            if children.count > shown {
                rows.append(.more(parent: parent.sessionId, hidden: children.count - shown))
            }
        }
        return rows
    }

    private func append(_ node: AgentNode, parent: String?, depth: Int, into rows: inout [AgentListItem]) {
        rows.append(.child(node, parent: parent, depth: depth))
        for child in node.nested {
            append(child, parent: parent, depth: depth + 1, into: &rows)
        }
    }

    private var sections: [(title: String, rows: [AgentListItem])] {
        let needle = model.filter.trimmed.lowercased()
        // Live is the sticky active bucket: a parent leaves it two minutes after its last activity.
        let live = agents.parents.filter { agents.isLive($0) }
        let today = agents.parents.filter { !agents.isLive($0) && Calendar.current.isDateInToday($0.last ?? .distantPast) }
        let earlier = agents.parents.filter { !agents.isLive($0) && !Calendar.current.isDateInToday($0.last ?? .distantPast) }
        var orphanRows: [AgentListItem] = []
        for node in matching(agents.orphans, parent: nil, needle: needle) {
            append(node, parent: nil, depth: 0, into: &orphanRows)
        }
        // Live always shows: its header holds the status chips.
        return [("Live", items(for: live, needle: needle))] + [
            ("Today", items(for: today, needle: needle)),
            ("Earlier", items(for: earlier, needle: needle)),
            ("Workers without a session", orphanRows),
        ].filter { !$0.1.isEmpty }
    }

    var body: some View {
        let sections = sections
        Group {
            if !agents.loaded && agents.parents.isEmpty {
                VStack(spacing: 8) {
                    ProgressView().controlSize(.small)
                    Text("Loading agents…").foregroundColor(ReviewPalette.dim)
                }
                .font(.system(size: 12))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2, pinnedViews: [.sectionHeaders]) {
                            if let error = agents.error {
                                Text(error)
                                    .font(.system(size: 11))
                                    .foregroundColor(ReviewPalette.removed)
                                    .lineLimit(3)
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 4)
                            }
                            ForEach(sections, id: \.title) { section in
                                Section {
                                    ForEach(section.rows) { item in
                                        row(item)
                                            .transition(SWR.rowTransition)
                                    }
                                    if section.title == "Live", section.rows.isEmpty {
                                        Text(status == .all ? "No live agent sessions" : "No \(status.title.lowercased()) agents in live sessions")
                                            .font(.system(size: 11.5))
                                            .foregroundColor(ReviewPalette.dim)
                                            .padding(.horizontal, 14)
                                            .padding(.vertical, 6)
                                    }
                                } header: {
                                    if section.title == "Live" {
                                        liveHeader(count: parentCount(section.rows))
                                    } else {
                                        PlainGroupHeader(title: section.title, count: section.title.hasPrefix("Workers") ? section.rows.count : parentCount(section.rows))
                                    }
                                }
                            }
                        }
                        .padding(.bottom, 12)
                    }
                    // Reorders wait while the pointer is over the list, and happen when it leaves.
                    .onHover { agents.holdOrder = $0 }
                    // Left and Right fold and unfold the open row's parent, Return opens its lead session.
                    .focusable()
                    .focusEffectDisabled()
                    .focused($listFocused)
                    .onKeyPress(.leftArrow) {
                        agents.foldSelection(open: false)
                        return .handled
                    }
                    .onKeyPress(.rightArrow) {
                        agents.foldSelection(open: true)
                        return .handled
                    }
                    .onKeyPress(.return) {
                        guard let parent = agents.selectedParent else { return .ignored }
                        agents.openMain(parent)
                        return .handled
                    }
                    // Only an explicit reveal (a deep link, back and forward) scrolls; a refresh never does.
                    .onChange(of: agents.revealRequest) { _, _ in
                        guard let key = agents.selectedID else { return }
                        DispatchQueue.main.async {
                            withAnimation(.snappy(duration: 0.25)) { proxy.scrollTo("c|" + key, anchor: .center) }
                        }
                    }
                }
            }
        }
    }

    private func parentCount(_ rows: [AgentListItem]) -> Int {
        rows.filter { if case .parent = $0 { return true } else { return false } }.count
    }

    /// "Live" with its count, and the status chips that filter every group.
    private func liveHeader(count: Int) -> some View {
        HStack(spacing: 4) {
            Text("Live")
            Text(verbatim: "\(count)").font(.system(size: 10.5, design: .monospaced))
            Spacer(minLength: 4)
            ForEach(AgentStatusFilter.allCases, id: \.self) { option in
                FilterChip(title: option.title, isOn: option == status, tint: ReviewPalette.renamed) {
                    guard option != status else { return }
                    HubMainBusy.measure("agents.statusFilter")
                    statusRaw = option.rawValue
                    agents.requestResort()
                }
                .instantTooltip(option.tooltip)
            }
        }
        .font(.system(size: 11.5, weight: .semibold))
        .foregroundColor(ReviewPalette.dim)
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 4)
        .hubSurface(.bar)
    }

    @ViewBuilder
    private func row(_ item: AgentListItem) -> some View {
        switch item {
        case .parent(let parent, let open, let running, let total):
            // Only the chevron folds; the rest of the row opens the lead session.
            HStack(alignment: .top, spacing: 0) {
                Button {
                    withAnimation(.snappy(duration: 0.2)) { agents.toggle(parent) }
                } label: {
                    Image(systemName: open ? "chevron.down" : "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundColor(ReviewPalette.dim)
                        .frame(width: 22, height: 26)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip(open ? "Fold its agents (Left)" : "Unfold its agents (Right)")
                AgentParentRow(parent: parent, running: running, total: total, live: agents.isLive(parent))
                    .rowButton {
                        listFocused = true
                        agents.openMain(parent)
                    }
            }
            .padding(.leading, 6)
            .padding(.top, 4)
        case .main(let parent):
            AgentMainRow(parent: parent, live: agents.isLive(parent), selected: agents.selectedID == AgentTree.mainKey(parent.sessionId))
                .rowButton {
                    listFocused = true
                    agents.openMain(parent)
                }
        case .child(let node, let parent, let depth):
            let key = AgentTree.key(parent: parent, child: node.id)
            AgentChildRow(node: node, depth: depth, selected: agents.selectedID == key, showsProject: parent == nil)
                .rowButton {
                    HubMainBusy.measure("agents.select")
                    listFocused = true
                    agents.selectedID = key
                }
        case .more(let parent, let hidden):
            Button {
                expandedAll.insert(parent)
            } label: {
                Text(verbatim: "Show \(hidden) more agents")
                    .font(.system(size: 11))
                    .foregroundColor(ReviewPalette.dim)
                    .padding(.leading, 40)
                    .padding(.vertical, 4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
        }
    }
}

/// A parent session: fold chevron, harness, title, live dot; project, account, counts, last activity.
private struct AgentParentRow: View {
    let parent: AgentParent
    let running: Int
    let total: Int
    /// In the sticky active bucket (Live), not only live this second.
    let live: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 7) {
            ZStack(alignment: .bottomTrailing) {
                ProviderBadge(provider: parent.provider)
                if live {
                    Circle()
                        .fill(ReviewPalette.added)
                        .frame(width: 7, height: 7)
                        .overlay(Circle().stroke(ReviewPalette.sidebar, lineWidth: 1.5))
                        .offset(x: 3, y: 3)
                }
            }
            .padding(.top, 1)
            VStack(alignment: .leading, spacing: 3) {
                Text(parent.displayTitle)
                    .font(.system(size: 12.5, weight: .semibold))
                    .lineLimit(2)
                HStack(spacing: 6) {
                    if let project = parent.project {
                        Text(project).layoutPriority(-2)
                    }
                    if let account = parent.account {
                        Text(account)
                            .padding(.horizontal, 5)
                            .padding(.vertical, 1)
                            .background(Capsule().stroke(Color.white.opacity(0.15)))
                            .layoutPriority(-1)
                    }
                    Text(verbatim: running > 0 ? "\(total) agents · \(running) running" : "\(total) agents")
                        .foregroundColor(running > 0 ? ReviewPalette.added : ReviewPalette.dim)
                        .fixedSize()
                    Spacer(minLength: 0)
                    LiveAgo(date: parent.last, style: .brief).fixedSize()
                }
                .font(.system(size: 10.5))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            }
        }
        .padding(.leading, 2)
        .padding(.trailing, 10)
        .padding(.vertical, 6)
        .padding(.trailing, 6)
        .contentShape(Rectangle())
    }
}

/// The first row under a parent: the lead session itself (harness, model, live state, last activity).
private struct AgentMainRow: View {
    let parent: AgentParent
    let live: Bool
    let selected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(live ? ReviewPalette.added : Color.white.opacity(0.3))
                .frame(width: 7, height: 7)
                .padding(.top, 5)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Main")
                        .font(.system(size: 12, weight: selected ? .semibold : .medium))
                    Spacer(minLength: 0)
                    if parent.isLive {
                        Text("running").foregroundColor(ReviewPalette.added).font(.system(size: 10.5)).fixedSize()
                    } else {
                        LiveAgo(date: parent.last, style: .brief).font(.system(size: 10.5)).foregroundColor(ReviewPalette.dim).fixedSize()
                    }
                }
                HStack(spacing: 5) {
                    Badge(parent.provider, color: AgentStatusStyle.harnessColor(parent.provider), look: .filled)
                    Badge("lead")
                    let labels = [parent.model, parent.account].compactMap { $0 }
                    if !labels.isEmpty {
                        Text(verbatim: labels.joined(separator: " · ")).truncationMode(.tail).layoutPriority(-1)
                    }
                    Spacer(minLength: 0)
                }
                .font(.system(size: 10.5))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            }
        }
        .padding(.leading, 30)
        .padding(.trailing, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.white.opacity(0.08) : Color.clear)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : Color.clear))
        )
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
    }
}

enum AgentStatusStyle {
    static func color(_ status: String) -> Color {
        switch status {
        case "running": return ReviewPalette.added
        case "idle": return ReviewPalette.renamed
        case "failed": return ReviewPalette.removed
        case "killed": return ReviewPalette.modified
        default: return Color.white.opacity(0.3)
        }
    }

    static func harnessColor(_ harness: String) -> Color {
        switch harness {
        case "codex": return Color(red: 0.45, green: 0.8, blue: 0.75)
        case "grok": return Color(red: 0.75, green: 0.6, blue: 0.95)
        default: return Color(red: 0.9, green: 0.6, blue: 0.4)
        }
    }
}

/// One agent: status dot, name, unread mail, last activity; harness, kind, model, account, tool calls,
/// start. Values only, no model: a dense list's rows must not observe the hub (HubWindow's rule).
private struct AgentChildRow: View {
    let node: AgentNode
    let depth: Int
    let selected: Bool
    let showsProject: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Circle()
                .fill(AgentStatusStyle.color(node.status))
                .frame(width: 7, height: 7)
                .padding(.top, 5)
                .instantTooltip(node.status)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text(node.title)
                        .font(.system(size: 12, weight: selected ? .semibold : .regular))
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    if let unread = node.unreadMail, unread > 0 {
                        CountBadge(unread, tooltip: "\(unread) unread team messages waiting in its inbox", color: ReviewPalette.modified)
                    }
                    // The last activity, kept current by the label's own clock (GenesisKit LiveTime), never by the row.
                    LiveAgo(date: node.last, style: .brief)
                        .font(.system(size: 10.5))
                        .foregroundColor(node.isRunning ? ReviewPalette.added : ReviewPalette.dim)
                        .fixedSize()
                }
                HStack(spacing: 5) {
                    Badge(node.harness, color: AgentStatusStyle.harnessColor(node.harness), look: .filled)
                    Badge(node.kind)
                    // One text, so a narrow row cuts it at its end instead of leaving a letter of each part.
                    let labels = [node.model, node.account, showsProject ? node.team : nil].compactMap { $0 }
                    if !labels.isEmpty {
                        Text(verbatim: labels.joined(separator: " · ")).truncationMode(.tail).layoutPriority(-1)
                    }
                    Spacer(minLength: 0)
                    // Tool calls and run time stay whole; model, account and team truncate first. A running agent's
                    // run time is live ("12m"), a finished one's is fixed ("ran 41m"); the start time is the tooltip.
                    let tools = node.toolCalls.flatMap { $0 > 0 ? "\($0) tools" : nil }
                    HStack(spacing: 0) {
                        if let tools {
                            Text(verbatim: tools)
                        }
                        if node.isRunning, let started = node.started {
                            LiveTime(date: started, style: .compact) { (tools == nil ? "" : " · ") + "run " + $0 }
                        } else if let ran = AgentTree.duration(from: node.started, to: node.last) {
                            Text(verbatim: (tools == nil ? "" : " · ") + "ran " + ran)
                        }
                    }
                    .font(.system(size: 10.5, design: .monospaced))
                    .fixedSize()
                    .instantTooltip(AgentTree.started(node.started).map { "Started \($0)" } ?? "Start time unknown")
                }
                .font(.system(size: 10.5))
                .foregroundColor(ReviewPalette.dim)
                .lineLimit(1)
            }
        }
        .padding(.leading, 30 + CGFloat(depth) * 14)
        .padding(.trailing, 10)
        .padding(.vertical, 5)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(selected ? Color.white.opacity(0.08) : Color.clear)
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : Color.clear))
        )
        .padding(.horizontal, 6)
        .contentShape(Rectangle())
    }
}

// MARK: - Detail

struct AgentsMain: View {
    @ObservedObject var model: HubModel
    @ObservedObject var agents: HubAgentsModel

    var body: some View {
        if let selected = agents.selected {
            AgentDetailView(model: model, agents: agents, parent: selected.parent, node: selected.node)
        } else if let parent = agents.selectedMain {
            AgentMainDetailView(model: model, agents: agents, parent: parent)
        } else {
            VStack(spacing: 8) {
                if !agents.loaded {
                    ProgressView()
                    Text("Loading agents…").foregroundColor(ReviewPalette.dim)
                } else {
                    Text("Pick an agent to read its whole transcript")
                        .foregroundColor(ReviewPalette.dim)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

private struct AgentDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var agents: HubAgentsModel
    let parent: AgentParent?
    let node: AgentNode
    /// Remembered, and settable in a snapshot (`--set hub.agents.promptOpen=true`).
    @AppStorage("hub.agents.promptOpen") private var promptOpen = false
    @State private var mailOpen = true

    var body: some View {
        VStack(spacing: 0) {
            header
            if let row = HubAgentsModel.transcriptRow(parent: parent, node: node) {
                let key = AgentTree.key(parent: parent?.sessionId, child: node.id)
                AgentTranscriptPane(row: row, key: key) { path, line in
                    model.showChange(path: path, line: line)
                }
                    .equatable()
                    .id(key)
                    .freezesWidthWhileResizing()
            } else {
                Text("This agent has no transcript file")
                    .foregroundColor(ReviewPalette.dim)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var header: some View {
        TitlebarHeader {
            HStack(spacing: 8) {
                if let parent {
                    Button {
                        agents.openMain(parent)
                    } label: {
                        HStack(spacing: 4) {
                            Image(systemName: "chevron.left").font(.system(size: 10, weight: .semibold))
                            Text(parent.displayTitle).lineLimit(1)
                        }
                        .font(.system(size: 12.5))
                        .foregroundColor(Color.white.opacity(0.75))
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Back to the lead session \(parent.sessionId.prefix(8))")
                    .layoutPriority(-1)
                    Text("›").foregroundColor(ReviewPalette.dim).titlebarLabel()
                }
                Group {
                    ProviderBadge(provider: node.harness)
                    Text(node.title)
                        .font(.system(size: 15, weight: .semibold))
                        .lineLimit(1)
                    Circle()
                        .fill(AgentStatusStyle.color(node.status))
                        .frame(width: 7, height: 7)
                    Text(node.status)
                        .font(.system(size: 11.5))
                        .foregroundColor(ReviewPalette.dim)
                }
                .titlebarLabel()
                Spacer()
                if let notice = model.notice {
                    NoticePill(text: notice, isError: notice.contains("not in")) { model.notice = nil }
                }
                IconButton(systemName: "number", tooltip: "Copy the agent id \(node.id)") {
                    PathOpener.copy(node.id)
                    model.notice = "Agent id copied"
                }
            }
        } details: {
            VStack(alignment: .leading, spacing: 8) {
                facts
                if let prompt = shownPrompt, !prompt.isEmpty {
                    spawnPrompt(prompt)
                }
                if node.isTeammate {
                    mailStrip
                }
            }
        }
    }

    /// The whole prompt once loaded, the list's preview until then.
    private var shownPrompt: String? {
        let key = AgentTree.key(parent: parent?.sessionId, child: node.id)
        return [agents.prompts[key], node.spawnPrompt, node.spawnPromptPreview].compactMap { $0 }.first { !$0.isEmpty }
    }

    private var facts: some View {
        HStack(spacing: 8) {
            chip("person.2", node.kind + (node.backendType.map { " · \($0)" } ?? ""))
            if let agentModel = node.model {
                chip("cpu", agentModel)
            }
            if let account = node.account ?? parent?.account {
                chip("person.crop.circle", account)
            }
            if node.isRunning, let started = node.started {
                HStack(spacing: 5) {
                    Image(systemName: "timer")
                    LiveTime(date: started, style: .elapsed)
                }
                .modifier(AgentChipStyle())
                .instantTooltip("Running since \(AgentTree.started(started) ?? "")")
            } else if let duration = AgentTree.duration(from: node.started, to: node.last) {
                chip("timer", "ran \(duration)")
            }
            if let tools = node.toolCalls {
                chip("wrench.and.screwdriver", "\(tools) tool calls")
            }
            if let team = node.team {
                chip("person.3", team)
            }
            if let path = node.filePath {
                PathLabel(path: path)
            }
            Spacer(minLength: 0)
        }
    }

    private func spawnPrompt(_ prompt: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { promptOpen.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: promptOpen ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                    Text("Spawn prompt").kicker()
                    if !promptOpen {
                        Text(prompt.replacingOccurrences(of: "\n", with: " "))
                            .font(.system(size: 11.5))
                            .foregroundColor(ReviewPalette.dim)
                            .lineLimit(1)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip(promptOpen ? "Hide the prompt the agent was started with" : "Show the prompt the agent was started with")
            if promptOpen {
                ScrollView {
                    Text(prompt)
                        .font(.system(size: 12))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(8)
                }
                .frame(maxHeight: 200)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
            }
        }
    }

    private var mailStrip: some View {
        VStack(alignment: .leading, spacing: 4) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { mailOpen.toggle() }
            } label: {
                HStack(spacing: 5) {
                    Image(systemName: mailOpen ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
                    Text("Team mail").kicker()
                    if let mail = agents.mail {
                        Text(verbatim: "\(mail.received.count) received · \(mail.sent.count) sent" + (mail.unread.isEmpty ? "" : " · \(mail.unread.count) waiting"))
                            .font(.system(size: 11.5))
                            .foregroundColor(mail.unread.isEmpty ? ReviewPalette.dim : ReviewPalette.modified)
                    } else if agents.loadingMail {
                        ProgressView().controlSize(.mini)
                    } else if let error = agents.mailError {
                        Text("could not load").font(.system(size: 11)).foregroundColor(ReviewPalette.removed).instantTooltip(error)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.genHoverPlain())
            .instantTooltip("Messages this teammate received and sent; waiting ones are in its inbox and not delivered yet")
            if mailOpen, let mail = agents.mail, !mail.isEmpty {
                let rows = mailRows(mail)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(rows, id: \.id) { row in
                            AgentMailRow(row: row)
                        }
                    }
                    .padding(6)
                }
                .frame(maxHeight: 150)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.04)))
            }
        }
    }

    /// Every message in time order, newest last; waiting ones at the end.
    private func mailRows(_ mail: AgentMail) -> [AgentMailRow.Row] {
        let delivered = mail.received.map { AgentMailRow.Row(message: $0, direction: .received) }
            + mail.sent.map { AgentMailRow.Row(message: $0, direction: .sent) }
        let ordered = delivered.sorted { ($0.message.date ?? .distantPast) < ($1.message.date ?? .distantPast) }
        return ordered + mail.unread.map { AgentMailRow.Row(message: $0, direction: .waiting) }
    }

    private func chip(_ icon: String, _ text: String) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon)
            Text(text).lineLimit(1).truncationMode(.middle)
        }
        .modifier(AgentChipStyle())
    }
}

/// The session screen on one agent's transcript. Equal while it shows the same agent: a list refresh
/// (new counts, a later last activity) must not re-render the transcript, which follows its file itself.
private struct AgentTranscriptPane: View, Equatable {
    let row: HubSession
    let key: String
    /// False for a parent's Main: the normal session screen with spend, terminal, insights and resume.
    var child = true
    let onShowChange: (String, Int?) -> Void

    static func == (left: AgentTranscriptPane, right: AgentTranscriptPane) -> Bool {
        left.key == right.key && left.row.sessionId == right.row.sessionId
    }

    var body: some View {
        HubSessionDetailHost(session: row, onShowChange: onShowChange, showsSidebar: true, agentChild: child)
    }
}

/// A parent's Main: the lead session's own screen, as in Sessions mode (spend, terminal, insights, resume,
/// the same live follow), under a header with the session's facts and a way into Sessions mode.
private struct AgentMainDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var agents: HubAgentsModel
    let parent: AgentParent

    /// The Sessions list's row when it holds this session (cmux pane, cache clock), else one from the list.
    private var row: HubSession {
        if let listed = model.sessions.first(where: { $0.sessionId == parent.sessionId }) {
            return listed
        }
        return HubSession(
            provider: parent.provider,
            sessionId: parent.sessionId,
            title: parent.title,
            cwd: parent.cwd ?? "",
            cwdShort: parent.project ?? "",
            project: parent.project,
            mtime: (parent.last?.timeIntervalSince1970 ?? 0) * 1000,
            model: parent.model,
            cacheStatus: nil,
            cacheTtlSec: nil,
            account: parent.account,
            filePath: parent.filePath ?? ""
        )
    }

    var body: some View {
        let key = AgentTree.mainKey(parent.sessionId)
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 8) {
                    Group {
                        ProviderBadge(provider: parent.provider)
                        Text(parent.displayTitle)
                            .font(.system(size: 15, weight: .semibold))
                            .lineLimit(1)
                        Circle()
                            .fill(agents.isLive(parent) ? ReviewPalette.added : Color.white.opacity(0.3))
                            .frame(width: 7, height: 7)
                        Text(verbatim: "Main · \(parent.totalCount) agents" + (parent.runningCount > 0 ? " · \(parent.runningCount) running" : ""))
                            .font(.system(size: 11.5))
                            .foregroundColor(ReviewPalette.dim)
                    }
                    .titlebarLabel()
                    Spacer()
                    if let notice = model.notice {
                        NoticePill(text: notice, isError: notice.contains("not in")) { model.notice = nil }
                    }
                    IconButton(systemName: "text.bubble", tooltip: "Open this session in Sessions mode (changes, files, decisions)") {
                        model.openAgentParent(parent.sessionId)
                    }
                }
            }
            AgentTranscriptPane(row: row, key: key, child: false) { path, line in
                model.showChange(path: path, line: line)
            }
                .equatable()
                .id(key)
                .freezesWidthWhileResizing()
        }
    }
}

private struct AgentChipStyle: ViewModifier {
    func body(content: Content) -> some View {
        content
            .font(.system(size: 11))
            .foregroundColor(Color.white.opacity(0.7))
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.05)))
    }
}

private struct AgentMailRow: View {
    enum Direction {
        case received, sent, waiting
    }

    struct Row: Identifiable {
        let message: AgentMail.Message
        let direction: Direction

        var id: String { "\(direction)|\(message.id)" }
    }

    let row: Row

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: symbol)
                .font(.system(size: 10))
                .foregroundColor(color)
                .frame(width: 12)
            Text(verbatim: row.message.date.map { AgentTree.clock.string(from: $0) } ?? "--:--:--")
                .font(.system(size: 10.5, design: .monospaced))
                .foregroundColor(ReviewPalette.dim)
            Text(verbatim: party)
                .font(.system(size: 11, weight: .medium))
                .foregroundColor(color)
                .lineLimit(1)
                .fixedSize()
            Text(row.message.text.replacingOccurrences(of: "\n", with: " "))
                .font(.system(size: 11))
                .foregroundColor(Color.white.opacity(0.8))
                .lineLimit(1)
                .truncationMode(.tail)
                .instantTooltip(row.message.text)
        }
    }

    private var party: String {
        switch row.direction {
        case .received: return "from \(row.message.from ?? "?")"
        case .sent: return "to \(row.message.to ?? "?")"
        case .waiting: return "waiting, from \(row.message.from ?? "?")"
        }
    }

    private var symbol: String {
        switch row.direction {
        case .received: return "arrow.down.left"
        case .sent: return "arrow.up.right"
        case .waiting: return "tray.full"
        }
    }

    private var color: Color {
        switch row.direction {
        case .received: return ReviewPalette.renamed
        case .sent: return ReviewPalette.added
        case .waiting: return ReviewPalette.modified
        }
    }
}

extension HubModel {
    /// The breadcrumb: the parent session in Sessions mode, when the session list holds it.
    @MainActor
    func openAgentParent(_ sessionId: String) {
        guard let match = sessions.first(where: { $0.sessionId == sessionId }) else {
            notice = "Session \(sessionId.prefix(8)) is not in the session list (last \(Self.recentHours) hours)"
            return
        }
        setMode(.sessions)
        select(match.id)
    }
}
