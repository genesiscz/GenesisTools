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
    /// Not published: no view shows them, and each refresh flipped `loading` twice, which re-rendered every
    /// view that observes this model (the list, the detail, its header) for nothing.
    private(set) var loading = false
    private(set) var showingCached = false
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
    /// `tools hub agents --json [--session <p>]` and the last whole list on disk; tests replace both.
    var readList: @Sendable (String?) throws -> AgentsEnvelope = { try AgentsSource.list(session: $0) }
    var cache = AgentsSource.cache

    private var index: [String: (parent: AgentParent?, node: AgentNode)] = [:]
    private var pendingRequest: (parent: String?, child: String)?
    private var active = false
    /// The hub window can be seen (Hub/HubVisibility.swift); while it cannot, no `tools` process starts.
    private var visible = true
    /// When the last whole list landed: the window coming back asks again only past the safety interval.
    private var lastFullList = Date.distantPast
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

    init() {
        visible = HubVisibility.shared.visible
        HubVisibility.shared.onChange { [weak self] visible in self?.visibilityChanged(visible) }
    }

    /// The mode came on screen: paint the last list, ask the CLI, watch the open parents.
    func activate() {
        guard !active else { return }
        active = true
        // Opening the mode is an explicit action: the first list sorts fresh.
        resortNext = true
        HubPerf.log("agents.activate")
        if !loaded {
            Task {
                if let data = await cache.loadData(key: "all"), parents.isEmpty, orphans.isEmpty,
                   let cached = try? AgentsSource.decode(data) {
                    HubSWR.painted("agents.list", "\(cached.parents.count) parents")
                    showingCached = true
                    apply(cached, scope: nil)
                }
            }
        }
        refresh(sessions: nil)
        rewatch()
        if visible {
            startSafety()
        }
    }

    /// The hub window was covered, minimized or hidden, or came back (Hub/HubVisibility.swift). Hidden, no
    /// `tools` process starts: the FSEvents stream stays (the kernel pushes it, nothing polls) and what it
    /// reports waits in the queues. Shown again, the queues run once, and a full list is asked for when the
    /// safety loop would have asked meanwhile (a finished agent writes nothing, so no event says it stopped).
    private func visibilityChanged(_ now: Bool) {
        visible = now
        guard active else { return }
        if now {
            if Date().timeIntervalSince(lastFullList) >= safetyInterval {
                refresh(sessions: nil, urgent: false)
            }
            startIfDue()
            startCountsIfDue()
            startSafety()
        } else {
            safety?.cancel()
            safety = nil
        }
    }

    /// How long a full list stays good with no event: 30 s while an agent runs, else 120 s.
    private var safetyInterval: TimeInterval {
        anyRunning ? 30 : 120
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
                try? await Task.sleep(for: .seconds(self?.safetyInterval ?? 120))
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
        guard active, visible, !inFlight, queuedFull || !queuedSessions.isEmpty else { return }
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
            let read = readList
            let result = await Task.detached(priority: .utility) { Result { try read(scope) } }.value
            inFlight = false
            loading = false
            switch result {
            case .success(let envelope):
                span.end("\(envelope.parents.count) parents")
                error = nil
                if scope == nil {
                    showingCached = false
                    lastFullList = Date()
                    if let data = try? JSONEncoder().encode(envelope) {
                        let cache = cache
                        Task.detached(priority: .utility) { cache.writeData(data, key: "all") }
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

    /// HubBench `agents`: the list on screen lands again with one child's tool count and last activity moved,
    /// as the CLI's answer after a transcript grew. Even rounds move a child of the open parent, odd rounds a
    /// child of another parent.
    func benchRefresh(_ round: Int) {
        let open = selectedParent?.sessionId
        let candidates = parents.indices.filter { !parents[$0].children.isEmpty }
        let pick = candidates.first { (parents[$0].sessionId == open) == round.isMultiple(of: 2) } ?? candidates.first
        guard let slot = pick else { return }
        var next = parents
        var child = next[slot].children[0]
        child.toolCalls = (child.toolCalls ?? 0) + 1
        child.lastAt = ISO8601DateFormatter().string(from: Date())
        next[slot].children[0] = child
        apply(AgentsEnvelope(parents: next, orphans: orphans), scope: nil)
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
        guard active, visible, !countsInFlight, !countsQueued.isEmpty else { return }
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
        if let hit = Self.requested(child: wanted.child, parent: wanted.parent, in: index) {
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

    /// The node `--agent <child>` names under a parent whose id starts with `parent` (any parent when nil):
    /// by its id, then its Agent call's `toolUseId`, and only when neither names one, by its id's start,
    /// its teammate name or its key's end. The index is a dictionary, walked in no fixed order, so one
    /// pass over every rule could open a loose match while an exact one exists.
    static func requested(
        child: String,
        parent: String?,
        in index: [String: (parent: AgentParent?, node: AgentNode)]
    ) -> (key: String, value: (parent: AgentParent?, node: AgentNode))? {
        let candidates = index.filter { _, value in
            parent.map { want in value.parent.map { $0.sessionId.hasPrefix(want) } ?? false } ?? true
        }
        return candidates.first { $0.value.node.id == child }
            ?? candidates.first { $0.value.node.toolUseId == child }
            ?? candidates.first { key, value in
                value.node.id.hasPrefix(child) || value.node.name == child || key.hasSuffix("|" + child)
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
            // With a status filter on, a parent with nothing to show stays out of the list: under Active a
            // parent shows when it is live itself or has an active agent. With an empty filter text
            // `parentHit` is always true, so this check alone let every quiet session into Active (H14).
            // The session being read stays listed whatever the filter, as an open agent does.
            let parentStatus = status == .all || (status == .active && agents.isLive(parent))
                || agents.selectedParent?.sessionId == parent.sessionId
            guard (parentHit && parentStatus) || !children.isEmpty else { continue }
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
        let _ = RenderProbe.hit("agents.list.body")
        let sections = sections
        Group {
            if !agents.loaded && agents.parents.isEmpty {
                SkeletonRows(count: 10, leading: .dot)
                    .skeletonShimmer()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel("Loading agents")
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
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
            .contextMenu {
                Button("Show in Widget") { WidgetLaunch.pin(session: parent.sessionId, provider: parent.provider) }
            }
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

/// Hub navigation supplies values to the same rows used by the Widget session picker.
private struct AgentParentRow: View {
    let parent: AgentParent
    let running: Int
    let total: Int
    let live: Bool

    var body: some View {
        let _ = RenderProbe.hit("agents.parentRow.body")
        AgentRosterGroupLabel(title: parent.displayTitle, provider: parent.provider, project: parent.project,
                              account: parent.account, total: total, running: running, live: live, lastAt: parent.last)
            .padding(.leading, 2).padding(.trailing, 16).padding(.vertical, 6)
    }
}

private struct AgentMainRow: View {
    let parent: AgentParent
    let live: Bool
    let selected: Bool

    var body: some View {
        let _ = RenderProbe.hit("agents.mainRow.body")
        AgentRosterRow(title: "Main", provider: parent.provider, role: "lead", model: parent.model,
                       account: parent.account, status: live ? "running" : "recent", lastAt: parent.last,
                       selected: selected, showsRunningLabel: true)
            .padding(.leading, 30).padding(.trailing, 10).padding(.vertical, 5)
            .background(selectionBackground).padding(.horizontal, 6)
    }

    private var selectionBackground: some View {
        RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : .clear)
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : .clear))
    }
}

typealias AgentStatusStyle = AgentRosterStyle

private struct AgentChildRow: View {
    let node: AgentNode
    let depth: Int
    let selected: Bool
    let showsProject: Bool

    var body: some View {
        let _ = RenderProbe.hit("agents.childRow.body")
        let account = [node.account, showsProject ? node.team : nil].compactMap { $0 }.joined(separator: " · ")
        AgentRosterRow(title: node.title, provider: node.harness, role: node.kind, model: node.model,
                       account: account.isEmpty ? nil : account,
                       status: node.status, startedAt: node.started, lastAt: node.last,
                       toolCalls: node.toolCalls ?? 0, unread: node.unreadMail ?? 0, selected: selected)
            .instantTooltip(AgentTree.started(node.started).map { "Started \($0)" } ?? "Start time unknown")
            .padding(.leading, 30 + CGFloat(depth) * 14).padding(.trailing, 10).padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 8).fill(selected ? Color.white.opacity(0.08) : .clear)
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(selected ? Color.accentColor.opacity(0.55) : .clear))
            ).padding(.horizontal, 6)
    }
}

// MARK: - Detail

struct AgentsMain: View {
    @ObservedObject var model: HubModel
    @ObservedObject var agents: HubAgentsModel

    var body: some View {
        let _ = RenderProbe.hit("agents.main.body")
        if let selected = agents.selected, let parent = selected.parent {
            AgentLeadScreen(model: model, agents: agents, parent: parent, node: selected.node)
        } else if let selected = agents.selected {
            // A codex or grok worker without a lead session: its transcript alone.
            AgentDetailView(model: model, agents: agents, node: selected.node)
        } else if let parent = agents.selectedMain {
            AgentLeadScreen(model: model, agents: agents, parent: parent, node: nil)
        } else {
            if !agents.loaded {
                TranscriptSkeleton()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                // One click to the session that is most likely wanted, instead of a page of dim text (H14).
                let newest = agents.parents.first(where: agents.isLive) ?? agents.parents.first
                EmptyState(
                    symbol: "person.2",
                    text: "No agent open",
                    detail: "Pick an agent or a session's Main row in the list to read its whole transcript.",
                    actionTitle: newest.map { "Open \(TitleFormatter.cleanSessionTitle($0.displayTitle) ?? $0.displayTitle)" },
                    action: newest.map { parent in { agents.openMain(parent) } }
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }
}

/// What the Agents mode adds to the shared session screen: the open agent (nil for the lead's Main row).
struct AgentPaneContext {
    let agents: HubAgentsModel
    let parent: AgentParent
    let node: AgentNode?

    /// The transcript pane's row and identity: the agent's own file, or the lead session's.
    @MainActor
    var transcriptRow: HubSession? {
        node.flatMap { HubAgentsModel.transcriptRow(parent: parent, node: $0) }
    }

    var key: String {
        node.map { AgentTree.key(parent: parent.sessionId, child: $0.id) } ?? AgentTree.mainKey(parent.sessionId)
    }
}

/// The Agents mode's detail is Sessions mode's screen (Hub/HubWindow.swift `SessionDetailView`) on the lead
/// session: the same Transcript, Changes, Files and Decisions panes, the same "Open diff". Only the transcript
/// pane differs, when an agent is open: it shows that agent's own file, and the header carries its facts.
private struct AgentLeadScreen: View {
    @ObservedObject var model: HubModel
    /// Passed on, not observed: this screen reads nothing of it, and observing it re-ran the lead's screen on
    /// every list refresh of any parent. `parent` and `node` bring the changes that matter.
    let agents: HubAgentsModel
    let parent: AgentParent
    let node: AgentNode?

    var body: some View {
        let _ = RenderProbe.hit("agents.lead.body")
        Group {
            if let lead = model.selected, lead.sessionId == parent.sessionId {
                SessionDetailView(model: model, session: lead, agent: AgentPaneContext(agents: agents, parent: parent, node: node))
            } else {
                TranscriptSkeleton()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
        // The panes read the model's selected session (its review, decisions, added folders).
        .task(id: parent.sessionId) {
            let span = HubPerf.begin("agents.lead", String(parent.sessionId.prefix(8)))
            model.selectLead(HubAgentsModel.leadRow(parent, in: model.sessions))
            span.end()
            HubMainBusy.measure("agents.lead.render")
        }
    }
}

/// A worker that belongs to no lead session: its header and transcript only.
private struct AgentDetailView: View {
    @ObservedObject var model: HubModel
    @ObservedObject var agents: HubAgentsModel
    let node: AgentNode

    var body: some View {
        VStack(spacing: 0) {
            TitlebarHeader {
                HStack(spacing: 8) {
                    AgentChildTitle(agents: agents, parent: nil, node: node)
                    Spacer()
                    if let notice = model.notice {
                        NoticePill(text: notice, isError: notice.contains("not in")) { model.notice = nil }
                    }
                    AgentCopyIdButton(model: model, node: node)
                }
            } details: {
                AgentChildDetails(agents: agents, parent: nil, node: node)
            }
            if let row = HubAgentsModel.transcriptRow(parent: nil, node: node) {
                let key = AgentTree.key(parent: nil, child: node.id)
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
}

/// The header's title for an open agent: the lead session as a way back, then the agent and its state.
struct AgentChildTitle: View {
    @ObservedObject var agents: HubAgentsModel
    let parent: AgentParent?
    let node: AgentNode

    var body: some View {
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
    }
}

struct AgentCopyIdButton: View {
    @ObservedObject var model: HubModel
    let node: AgentNode

    var body: some View {
        IconButton(systemName: "number", tooltip: "Copy the agent id \(node.id)") {
            PathOpener.copy(node.id)
            model.notice = "Agent id copied"
        }
    }
}

/// Under the header row for an open agent: its facts, spawn prompt and (a teammate's) team mail.
struct AgentChildDetails: View {
    @ObservedObject var agents: HubAgentsModel
    let parent: AgentParent?
    let node: AgentNode
    /// Remembered, and settable in a snapshot (`--set hub.agents.promptOpen=true`).
    @AppStorage("hub.agents.promptOpen") private var promptOpen = false
    @State private var mailOpen = true

    var body: some View {
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

extension HubAgentsModel {
    /// The lead session's row: the Sessions list's when it holds it (cmux pane, cache clock), else one
    /// built from the agents list (a session older than the list's window).
    static func leadRow(_ parent: AgentParent, in sessions: [HubSession]) -> HubSession {
        if let listed = sessions.first(where: { $0.sessionId == parent.sessionId }) {
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
    /// A session sidebar's sub-agent row: the Agents mode at that agent (matched by its Agent call's id).
    @MainActor
    func openSubagent(sessionId: String, agentId: String) {
        HubPerf.log("agents.openSubagent \(sessionId.prefix(8)) \(agentId.prefix(16))")
        setMode(.agents)
        agents.request(parent: sessionId, child: agentId)
    }

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
