import Foundation
import SwiftUI

public enum WorkLiveState: Equatable, Sendable {
    case live, catchingUp, stopped(reason: String)
}

/// The state of the Work screen of one project. It loads through a `WorkSource` and runs the writes of the rows.
///
/// Every session writes the store (to-do rows, handoffs, spots), and one reload costs about 1.3 s of CPU in the
/// service at today's sizes. So a change of the store only marks the screen stale: one reload runs at the end of a
/// burst, at most once per `reloadInterval`, never two at once, and none while the screen cannot be seen
/// (`setVisible(false)`); the first look after that reloads once if anything changed.
@MainActor
public final class WorkScreenModel: ObservableObject {
    public enum Pane: String, CaseIterable, Sendable {
        case items, notify
        public var title: String { self == .items ? "Items" : "Notifications" }
    }

    @Published public private(set) var projects: [String] = []
    /// The first project read for this activation ended, whatever it found. An empty store settles here.
    @Published public private(set) var projectsLoaded = false
    @Published public var project: String? {
        didSet {
            openingCandidates = nil // A row click or history navigation takes precedence over the pending opening choice.
            if adoptingItemProject {
                // A later read can discover a move. Keep the reader in the original list until they follow it.
                if let movedFrom, project == movedFrom { return }
                if let oldValue, project != oldValue, itemDetail?.item.project == oldValue || movedFrom == oldValue {
                    movedFrom = oldValue
                    project = oldValue
                } else if project != oldValue {
                    resetFind()
                }
                return
            }
            if project != oldValue || itemRef != nil {
                resetFind()
                itemRef = nil
                itemDetail = nil
                snapshot = nil
                notifyRows = []
                clearProjectEdits()
                if failure != nil { failure = nil }
                isFirstLoad = true
                read()
            }
        }
    }
    @Published public var pane: Pane = .items {
        didSet {
            if pane != oldValue {
                if failure != nil { failure = nil }
                if pane == .notify { itemRef = nil; itemDetail = nil }
                read()
            }
        }
    }
    @Published public private(set) var itemRef: String?
    @Published public private(set) var itemDetail: WorkItemDetail? {
        didSet { if let itemDetail { receivedDetail(itemDetail) } }
    }
    private var adoptingItemProject = false
    @Published public private(set) var snapshot: WorkSnapshotValue? {
        didSet {
            updateResults()
            if snapshot != nil { loadIndexIfNeeded(); revealRouteIfReady() }
        }
    }
    private var confirmedSnapshot: WorkSnapshotValue?
    private var pendingItemStates: [String: String] = [:]
    public private(set) var rowAnimation: Bool?
    @Published public private(set) var notifyRows: [WorkNotifyRow] = []
    @Published public private(set) var notifyLoaded = false
    @Published public private(set) var isLoading = false
    @Published public private(set) var isFirstLoad = true
    @Published public private(set) var live: WorkLiveState = .live
    @Published public private(set) var failure: String?
    /// The answer of the last write: ok shows as a fading notice, a refusal stays until the next write.
    @Published public private(set) var notice: WorkActionOutcome?
    /// Items with a write on its way; their row shows it and refuses a second click.
    @Published public private(set) var pending: Set<String> = []
    @Published public private(set) var notifyPending: [String: String] = [:]
    @Published public private(set) var notifyCommand: String?
    public let noticeStack = NoticeStackModel()
    private var itemNoticeID: StackedNotice.ID?
    private var notifyGeneration = UUID()

    private let source: WorkSource
    private var openingCandidates: [String]?
    /// The shortest time between two reloads that a change of the store starts.
    let reloadInterval: TimeInterval
    /// How long a burst must be quiet before its reload, within `reloadInterval`.
    let settle: TimeInterval
    private var listening: Task<Void, Never>?
    private var active = false
    private var wake: NSObjectProtocol?
    private var retry: Task<Void, Never>?
    private var retryIndex = 0
    private let retryDelays: [TimeInterval]
    private let catchUpDelay: TimeInterval
    private var opening: Task<Void, Never>?
    private var loading: Task<Void, Never>?
    /// The load that owns `loading`; a cancelled older one never clears it.
    private var loadToken = UUID()
    private var lastReload = Date.distantPast
    private var trailing: Task<Void, Never>?
    /// A change arrived that no reload has read yet.
    private var stale = false
    private var projectsStale = false
    public private(set) var visible = true
    /// Reloads that a change of the store started, for tests and the bench.
    private(set) var changeReloads = 0

    public init(source: WorkSource, reloadInterval: TimeInterval = 3, settle: TimeInterval = 0.5,
                retryDelays: [TimeInterval] = [5, 15, 60], catchUpDelay: TimeInterval = 1) {
        self.source = source
        self.reloadInterval = reloadInterval
        self.settle = settle
        self.retryDelays = retryDelays
        self.catchUpDelay = catchUpDelay
    }

    // MARK: - Live

    /// Whether anyone can see the screen (the hub window is not covered, minimized or hidden). Hidden, a change
    /// waits; shown again, one reload reads what changed meanwhile.
    public func setVisible(_ next: Bool) {
        guard next != visible else { return }
        visible = next
        guard active else { return }
        if next {
            reconnect()
        } else {
            opening?.cancel()
            stopListening()
            cancelRead()
        }
    }

    /// On entry, open the first matching candidate or the first listed project. Without an opening preference,
    /// keep the current selection. A choice made while the list loads takes precedence.
    public func activate(preferring projects: [String]? = nil) {
        guard !active else { return }
        active = true
        if projectsLoaded { projectsLoaded = false }
        if itemRef != nil, companionReadNeeded { reload() }
        openingCandidates = projects
        if visible { listen() }
        wake = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification,
            object: nil, queue: .main) { [weak self] _ in Task { @MainActor in self?.reconnect() } }
        let previousLoad = loadToken
        opening = Task {
            guard !Task.isCancelled else { return }
            await loadProjects()
            if !Task.isCancelled && loadToken == previousLoad && itemRef == nil { read() }
        }
    }

    /// The screen left: no more reloads while nobody sees it.
    public func deactivate() {
        active = false
        if let wake { NSWorkspace.shared.notificationCenter.removeObserver(wake); self.wake = nil }
        listTask?.cancel()
        invalidateFindReads()
        opening?.cancel()
        opening = nil
        stopListening()
        cancelRead()
    }

    private func cancelRead() {
        loading?.cancel()
        loading = nil
        loadToken = UUID()
        if isLoading { isLoading = false }
        if live == .catchingUp { live = .live }
        stale = true
        projectsStale = true
    }

    private func stopListening() {
        listening?.cancel()
        listening = nil
        trailing?.cancel()
        trailing = nil
        retry?.cancel()
        retry = nil
        retryIndex = 0
    }

    public func reconnect() {
        guard active, visible else { return }
        stopListening()
        restart()
    }

    private func restart() {
        PerfSpans.measure("work.live.reconnect") { listen() }
        if projectsStale {
            schedule()
        } else {
            read()
        }
    }

    private func listen() {
        if live != .live { live = .live }
        let stream = source.changes()
        listening = Task { [weak self] in
            for await _ in stream {
                guard !Task.isCancelled else { return }
                self?.retryIndex = 0
                self?.changed()
            }
            guard !Task.isCancelled, let self else { return }
            self.listening = nil
            self.live = .stopped(reason: "The GenesisTools service stopped.")
            guard self.retryDelays.indices.contains(self.retryIndex) else { return }
            let delay = self.retryDelays[self.retryIndex]
            self.retryIndex += 1
            self.retry = Task { [weak self] in
                try? await Task.sleep(for: .seconds(delay))
                guard !Task.isCancelled else { return }
                self?.restart()
            }
        }
    }

    public func loadProjects() async {
        do {
            let names = try await source.projects()
            guard !Task.isCancelled else { return }
            if projects != names { projects = names }
            if itemRef != nil {
                // The item owns its project, even when the default project's list finishes last.
                openingCandidates = nil
                if !projectsLoaded { projectsLoaded = true }
                return
            }
            let candidates = openingCandidates ?? [project].compactMap { $0 }
            let match = candidates.lazy.compactMap { candidate in
                names.first { $0 == candidate } ?? names.first { $0.caseInsensitiveCompare(candidate) == .orderedSame }
            }.first
            openingCandidates = nil
            let next = match ?? names.first
            if project != next { project = next }
        } catch {
            guard !Task.isCancelled else { return }
            if itemRef == nil { failure = error.localizedDescription }
        }
        if !projectsLoaded { projectsLoaded = true }
    }

    // MARK: - Find and select

    @Published public var filter = WorkFilter.default {
        didSet {
            guard oldValue != filter else { return }
            collapsedMatches.removeAll()
            archiveLimit = 200
            filterNotice = nil
            updateResults()
            loadIndexIfNeeded()
        }
    }
    @Published public private(set) var index: [WorkRowValue] = []
    @Published public private(set) var results: WorkItemsProjection?
    @Published public private(set) var indexLoading = false
    @Published public private(set) var indexFailure: String?
    @Published public private(set) var listFailure: String?
    @Published public private(set) var movedFrom: String?
    @Published public private(set) var filterNotice: String?
    public var selection: String? { itemRef }
    public var visibleRefs: [String] { results?.visibleRefs ?? [] }

    private var indexedProject: String?
    private var indexTask: Task<Void, Never>?
    private var listTask: Task<Void, Never>?
    private var expanded: Set<String> = []
    private var collapsedMatches: Set<String> = []
    private var archiveLimit = 200
    private var cachedDetails: [String: WorkItemDetail] = [:]
    private var recentRefs: [String] = []
    private var companionReadNeeded = false

    private func resetFind() {
        parentRef = nil
        indexTask?.cancel()
        listTask?.cancel()
        indexTask = nil
        listTask = nil
        indexedProject = nil
        indexLoading = false
        indexFailure = nil
        listFailure = nil
        index = []
        expanded.removeAll()
        collapsedMatches.removeAll()
        filter = .default
        filterNotice = nil
        movedFrom = nil
    }

    private func updateResults() {
        results = snapshot.map { WorkItemsProjection(snapshot: $0, filter: filter, index: index,
                                                     archiveLimit: archiveLimit, expanded: expanded,
                                                     collapsed: collapsedMatches) }
    }

    public func toggleContainer(_ ref: String) {
        guard let container = results?.containers.first(where: { $0.value.ref == ref }) else { return }
        if container.isExpanded {
            expanded.remove(ref)
            collapsedMatches.insert(ref)
        } else {
            expanded.insert(ref)
            collapsedMatches.remove(ref)
        }
        updateResults()
    }

    public func showMore() {
        archiveLimit += 200
        updateResults()
    }

    public func loadIndexIfNeeded() {
        guard let project, filter.requiresIndex, indexedProject != project, indexTask == nil else { return }
        indexLoading = true
        indexFailure = nil
        indexTask = Task {
            do {
                let rows = try await source.list(project: project)
                guard !Task.isCancelled, self.project == project else { return }
                index = rows
                indexedProject = project
                updateResults()
                revealRouteIfReady()
            } catch {
                guard !Task.isCancelled, self.project == project else { return }
                indexFailure = error.localizedDescription
            }
            indexLoading = false
            indexTask = nil
        }
    }

    private func receivedDetail(_ detail: WorkItemDetail) {
        guard let ref = itemRef else { return }
        recentRefs.removeAll { $0 == ref }
        recentRefs.append(ref)
        cachedDetails[ref] = detail
        if recentRefs.count > 20 { cachedDetails.removeValue(forKey: recentRefs.removeFirst()) }
        if snapshot == nil || companionReadNeeded { readListBesideDetail() }
        revealRouteIfReady()
    }

    public func readListBesideDetail() {
        guard let project else { return }
        companionReadNeeded = false
        listTask?.cancel()
        listFailure = nil
        listTask = Task {
            do {
                let value = try await source.snapshot(project: project)
                guard !Task.isCancelled, self.project == project else { return }
                snapshot = value
            } catch {
                guard !Task.isCancelled, self.project == project else { return }
                listFailure = error.localizedDescription
            }
        }
    }

    private func invalidateFindReads() {
        cachedDetails.removeAll()
        recentRefs.removeAll()
        indexedProject = nil
        indexTask?.cancel()
        indexTask = nil
        indexLoading = false
        companionReadNeeded = true
    }

    @Published public private(set) var parentRef: String?

    public func selectMember(_ ref: String) {
        let container = selection
        select(ref)
        parentRef = container
    }

    public func returnToContainer() {
        if let parentRef { select(parentRef) }
    }

    public func openMovedItem() {
        guard movedFrom != nil, let ref = itemRef, let destination = itemDetail?.item.project else { return }
        project = destination
        select(ref)
    }

    public func pairings(for ref: String) -> [WorkPairingValue] {
        guard let snapshot else { return [] }
        for container in snapshot.containers {
            if container.ref == ref { return container.pairings ?? [] }
            if let member = container.members.first(where: { $0.ref == ref }) { return member.pairings ?? [] }
        }
        return snapshot.triage.first { $0.ref == ref }?.pairings ?? []
    }

    public func title(for ref: String) -> String? {
        if let title = cachedDetails[ref]?.item.title { return title }
        if let snapshot {
            for container in snapshot.containers {
                if container.ref == ref { return container.title }
                if let row = container.members.first(where: { $0.ref == ref }) { return row.title }
            }
            if let row = snapshot.triage.first(where: { $0.ref == ref }) { return row.title }
        }
        return index.first { $0.ref == ref }?.title
    }

    public func select(_ ref: String?) {
        guard let ref else { closeItem(); return }
        guard ref != itemRef else { return }
        routeToReveal = nil
        movedFrom = nil
        parentRef = nil
        itemRef = ref
        let cached = cachedDetails[ref]
        itemDetail = cached
        failure = nil
        if pane != .items { pane = .items }
        else if cached == nil || isLoading || cached?.item.project != project { reload() }
    }

    public func moveSelection(_ step: Int) {
        guard step != 0, !visibleRefs.isEmpty else { return }
        let refs = visibleRefs
        let current = itemRef.flatMap { refs.firstIndex(of: $0) }
        let next = current.map { min(max(0, $0 + (step > 0 ? 1 : -1)), refs.count - 1) }
            ?? (step > 0 ? 0 : refs.count - 1)
        select(refs[next])
    }

    private var routeToReveal: String?
    private var routeHadFilter = false

    public func openItem(_ ref: String) {
        let hadFilter = filter.isActive
        select(ref)
        routeToReveal = ref
        routeHadFilter = hadFilter
        revealRouteIfReady()
    }

    private func revealRouteIfReady() {
        guard let ref = routeToReveal, ref == itemRef, let detail = itemDetail,
              let snapshot, snapshot.project == detail.item.project else { return }
        guard let results else { return }
        if results.visibleRefs.contains(ref) { routeToReveal = nil; return }
        if let parent = results.containers.first(where: { !$0.isExpanded && $0.members.contains(where: { $0.ref == ref }) }) {
            routeToReveal = nil
            toggleContainer(parent.ref)
            return
        }
        let indexed = indexedProject == project
        if filter.requiresIndex && !indexed { return }
        routeToReveal = nil
        let wasFiltered = routeHadFilter
        let onTree = snapshot.containers.contains { $0.ref == ref || $0.members.contains { $0.ref == ref } }
            || snapshot.spotted.contains { $0.ref == ref } || snapshot.reopened.contains { $0.ref == ref }
        let next: WorkFilter
        if onTree {
            next = .default
        } else if detail.item.state == "done" {
            next = WorkFilter(states: [.done])
        } else if detail.item.state == "dropped" {
            next = WorkFilter(states: [.dropped])
        } else {
            next = WorkFilter(states: [])
        }
        if let container = snapshot.containers.first(where: { $0.members.contains { $0.ref == ref } }) {
            expanded.insert(container.ref)
            collapsedMatches.remove(container.ref)
        }
        // A closed item's archive page is part of its route. Reveal it even beyond the first 200.
        if let position = index.firstIndex(where: { $0.ref == ref }), ["done", "dropped"].contains(detail.item.state) {
            if !results.archive.contains(where: { $0.ref == ref }) && filter != next {
                filter = next
            }
            archiveLimit = max(archiveLimit, ((position / 200) + 1) * 200)
        } else {
            filter = next
        }
        updateResults()
        if wasFiltered { filterNotice = "Filter cleared to show \(ref)" }
        if !indexed, filter.requiresIndex {
            routeToReveal = ref
            routeHadFilter = false
            loadIndexIfNeeded()
        }
    }

    public func closeItem() {
        guard itemRef != nil else { return }
        routeToReveal = nil
        parentRef = nil
        itemRef = nil
        itemDetail = nil
        failure = nil
        if project == nil, let first = projects.first { project = first }
        else { reload() }
    }

    // MARK: - Reload

    public func reload() {
        read(explicit: true)
    }

    private func read(explicit: Bool = false, change: Bool = false) {
        loading?.cancel()
        if live == .catchingUp { live = .live }
        let project = project
        let ref = itemRef
        guard project != nil || ref != nil else {
            loading = nil
            if isLoading { isLoading = false }
            return
        }
        stale = false
        lastReload = Date()
        let showLoading = explicit || isFirstLoad
        if isLoading != showLoading { isLoading = showLoading }
        let token = UUID()
        loadToken = token
        let pane = pane
        loading = Task { [weak self] in
            guard let self else { return }
            let span = PerfSpans.begin("work.live.reload", awaits: true)
            let slow = change ? Task { [weak self, catchUpDelay] in
                try? await Task.sleep(for: .seconds(catchUpDelay))
                guard !Task.isCancelled, let self, self.loadToken == token, self.live == .live else { return }
                self.live = .catchingUp
            } : nil
            defer { slow?.cancel(); span.end() }
            do {
                if let ref {
                    let detail = try await self.source.detail(ref: ref)
                    guard !Task.isCancelled, self.itemRef == ref else { return }
                    self.adoptingItemProject = true
                    if self.project != detail.item.project {
                        self.snapshot = nil
                        self.notifyRows = []
                        self.project = detail.item.project
                    }
                    self.adoptingItemProject = false
                    if self.itemDetail != detail { self.itemDetail = detail }
                } else if let project, pane == .items {
                    let confirmed = try await self.source.snapshot(project: project)
                    guard !Task.isCancelled, self.project == project else { return }
                    PerfSpans.measure("work.reload") {
                        self.confirmedSnapshot = confirmed
                        let next = confirmed.previewing(self.pendingItemStates)
                        if self.snapshot != next {
                            PerfMainBusy.measure("work.reload")
                            self.rowAnimation = self.snapshot.flatMap { previous in
                                let old = previous.rowRefs, new = next.rowRefs
                                let count = old.symmetricDifference(new).count
                                return (1...GenMotion.maxAnimatedRows).contains(count) ? new.count >= old.count : nil
                            }
                            self.snapshot = next
                        }
                    }
                } else if let project {
                    let rows = try await self.source.notify(project: project)
                    guard !Task.isCancelled, self.project == project else { return }
                    if self.notifyRows != rows { self.notifyRows = rows }
                    if !self.notifyLoaded { self.notifyLoaded = true }
                }
                if self.isFirstLoad { self.isFirstLoad = false }
                if self.failure != nil { self.failure = nil }
            } catch {
                guard !Task.isCancelled else { return }
                if self.failure != error.localizedDescription { self.failure = error.localizedDescription }
            }
            guard self.loadToken == token else { return }
            if self.isLoading { self.isLoading = false }
            if self.live == .catchingUp { self.live = .live }
            self.loading = nil
            // Changes that came during this reload get one more, by the same rules.
            if self.stale || self.projectsStale { self.schedule() }
        }
    }

    /// A change of the store: the screen is stale, and one reload follows by the rules above.
    func changed() {
        PerfSpans.measure("work.live.tick") {
            invalidateFindReads()
            stale = true
            projectsStale = true
            schedule()
        }
    }

    /// One reload after the burst settles, no sooner than `reloadInterval` after the last one, never beside a running
    /// one, never while hidden. A burst that keeps going still reloads once per interval.
    private func schedule() {
        guard active, visible, trailing == nil, loading == nil else { return }
        let wait = max(settle, reloadInterval - Date().timeIntervalSince(lastReload))
        trailing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            guard self.active, self.visible, self.stale || self.projectsStale, self.loading == nil else {
                self.trailing = nil
                return
            }
            self.changeReloads += 1
            let previousLoad = self.loadToken
            if self.projectsStale {
                self.projectsStale = false
                await self.loadProjects()
            }
            guard !Task.isCancelled else { return }
            self.trailing = nil
            guard self.active, self.visible, self.loadToken == previousLoad else { return }
            self.read(change: true)
        }
    }

    public func perform(_ action: WorkScreenAction) async {
        await write(action)
    }

    @discardableResult
    public func write(_ action: WorkScreenAction) async -> Bool {
        let project = itemRef == action.ref ? (itemDetail?.item.project ?? self.project) : self.project
        guard let project, !pending.contains(action.ref) else { return false }
        pending.insert(action.ref)
        defer { pending.remove(action.ref) }
        switch action {
        case .finish: pendingItemStates[action.ref] = "done"
        case .drop: pendingItemStates[action.ref] = "dropped"
        case .accept: pendingItemStates[action.ref] = "open"
        case .reopen: pendingItemStates[action.ref] = "reopened"
        default: break
        }
        showPendingItemStates()
        let outcome: WorkActionOutcome
        do {
            outcome = try await source.perform(action, project: project)
        } catch {
            outcome = WorkActionOutcome(ok: false, message: error.localizedDescription)
        }
        notice = outcome
        if outcome.ok {
            itemNoticeID = noticeStack.push(.init(text: outcome.message))
        } else {
            let failed = "The work item could not be changed"
            let report = FailureReport.unexpected(outcome.message, outcome: failed, action: "Change the work item")
            itemNoticeID = noticeStack.push(.init(text: failed, tone: .error, actions: [.details(report)]))
        }
        pendingItemStates[action.ref] = nil
        if !outcome.ok { showPendingItemStates() }
        invalidateFindReads()
        await readAfterWrite()
        return outcome.ok
    }

    private func showPendingItemStates() {
        guard let confirmedSnapshot, confirmedSnapshot.project == project, snapshot != nil else { return }
        let next = confirmedSnapshot.previewing(pendingItemStates)
        if snapshot != next {
            rowAnimation = nil
            snapshot = next
        }
    }

    private func readAfterWrite() async {
        read()
        await finishCurrentRead()
    }

    func finishCurrentRead() async {
        // An explicit read or a navigation may supersede our read while it is in flight.
        while let current = loading { await current.value }
    }

    public func clearNotice() {
        if let itemNoticeID { noticeStack.dismiss(itemNoticeID); self.itemNoticeID = nil }
        notice = nil
    }

    // MARK: - Notify

    private func clearProjectEdits() {
        notifyGeneration = UUID()
        if notifyLoaded { notifyLoaded = false }
        if !notifyPending.isEmpty { notifyPending = [:] }
        if notifyCommand != nil { notifyCommand = nil }
        let remaining = pending.filter { !$0.hasPrefix("notify:") }
        if remaining != pending { pending = remaining }
    }

    public func setNotify(scope: WorkNotifyScope, type: String, action: String, level: String?) async {
        guard let project, pane == .notify else { return }
        if case .stopped = live { return }
        let layer = scope == .global ? "config.global" : "config.project"
        var previews: [String: String] = [:]
        for row in notifyRows where type == "*" || type == row.type {
            for cell in row.cells where cell.writable && (action == "*" || action == cell.action) {
                let key = "notify:\(row.type):\(cell.action)"
                // A project override remains visible when its global default is edited.
                if scope == .global && ["config.project", "config.repo"].contains(cell.from) {
                    previews[key] = cell.level
                } else if let level {
                    previews[key] = level
                } else {
                    previews[key] = cell.inheriting(scope).level
                }
            }
        }
        let keys = Set(previews.keys).union(["notify:\(type):\(action)"])
        guard !previews.isEmpty, pending.isDisjoint(with: keys) else { return }
        pending.formUnion(keys)
        notifyPending.merge(previews) { _, new in new }
        let generation = notifyGeneration
        defer {
            if notifyGeneration == generation {
                pending.subtract(keys)
                notifyPending = notifyPending.filter { !keys.contains($0.key) }
            }
        }
        do {
            let result = try await source.setNotify(project: project, scope: scope, type: type, action: action, level: level)
            guard result.ok else { throw WorkSourceError(result.message) }
            var message = result.message
            if notifyGeneration == generation {
                await readAfterWrite()
                if notifyGeneration == generation, pane == .notify, failure == nil {
                    if let change = result.changes.last {
                        notifyCommand = command(for: change, scope: scope, project: project)
                    }
                    let conflicts = result.changes.contains { change in
                        guard let row = notifyRows.first(where: { $0.type == change.type }),
                              let cell = row.cells.first(where: { $0.action == change.action }) else { return true }
                        let stored = cell.layers.first { $0.layer == layer && !$0.wildcard }?.rule ?? .inherit
                        return stored != change.to
                    }
                    if conflicts { message = "Changed by another writer" }
                    else if !result.changes.isEmpty {
                        let name = type == "*" ? WorkNotifyWords.action(action) : WorkNotifyWords.type(type)
                        let affected = Plural.count(result.changes.count, type == "*" ? "type" : "rule")
                        let effect = level == "off" ? "nobody hears about it" : level.map(WorkNotifyWords.level)?.lowercased() ?? "inherited level"
                        message = "\(name): \(effect) for \(affected)"
                    }
                } else if pane == .notify && failure != nil {
                    message = "Rules saved. The updated rules could not be read."
                }
            }
            let fixes: [StackedNotice.Action] = result.changes.isEmpty ? [] : [
                .undo { [weak self] id in Task {
                    await self?.undoNotify(project: project, scope: scope, changes: result.changes, noticeID: id)
                } }
            ]
            noticeStack.push(.init(text: message, actions: fixes))
        } catch {
            showNotifyFailure(error, outcome: "The notification rules could not be saved")
        }
    }

    private func undoNotify(project: String, scope: WorkNotifyScope, changes: [WorkNotifyChange],
                            noticeID: StackedNotice.ID) async {
        do {
            let result = try await source.restoreNotify(project: project, scope: scope, changes: changes)
            guard result.ok else { throw WorkSourceError(result.message) }
            if self.project == project, pane == .notify { await readAfterWrite() }
            noticeStack.push(.init(text: "Restored the previous notification rules"), replacing: noticeID)
        } catch {
            showNotifyFailure(error, outcome: "The previous rules could not be restored", replacing: noticeID)
        }
    }

    private func showNotifyFailure(_ error: Error, outcome: String, replacing: StackedNotice.ID? = nil) {
        let report = FailureReport.unexpected(error.localizedDescription, outcome: outcome, action: "Change notification rules")
        noticeStack.push(.init(text: outcome, tone: .error, actions: [.details(report)]), replacing: replacing)
    }

    private func command(for change: WorkNotifyChange, scope: WorkNotifyScope, project: String) -> String? {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let json = try? String(decoding: encoder.encode(change.to), as: UTF8.self) else { return nil }
        if scope == .project && project.contains(".") {
            // A dotted CLI path cannot represent this project. The typed command takes the name as one word.
            let newLevel: String?
            switch change.to {
            case .inherit: newLevel = nil
            case .level(let value), .threshold(let value, _): newLevel = value
            }
            let object: [String: Any] = ["type": change.type, "action": change.action, "level": newLevel as Any]
            guard let bytes = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]) else { return nil }
            return "tools work config-set --scope project --project " + ShellWords.word(project) +
                " --notify " + ShellWords.quoted(String(decoding: bytes, as: UTF8.self))
        }
        return "tools work config set " + ShellWords.word(change.path) + " " + ShellWords.quoted(json)
    }
}

private extension WorkSnapshotValue {
    func previewing(_ states: [String: String]) -> Self {
        guard !states.isEmpty else { return self }
        var result = self
        for i in containers.indices {
            if let state = states[containers[i].ref] { result.containers[i].state = state }
            for j in containers[i].members.indices {
                if let state = states[containers[i].members[j].ref] { result.containers[i].members[j].state = state }
            }
        }
        for i in triage.indices {
            if let state = states[triage[i].ref] { result.triage[i].state = state }
        }
        return result
    }

    var rowRefs: Set<String> {
        Set(containers.map(\.ref) + containers.flatMap { $0.members.map(\.ref) } + triage.map(\.ref))
    }
}
