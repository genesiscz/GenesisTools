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
    /// The first read of the projects ended, whatever it found: a store with no project settles here.
    @Published public private(set) var projectsLoaded = false
    @Published public var project: String? {
        didSet {
            openingCandidates = nil // A row click or history navigation takes precedence over the pending opening choice.
            if adoptingItemProject { return }
            if project != oldValue || itemRef != nil {
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
    @Published public private(set) var itemDetail: WorkItemDetail?
    private var adoptingItemProject = false
    @Published public private(set) var snapshot: WorkSnapshotValue?
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
            stopListening()
        }
    }

    /// On entry, open the first matching candidate or the first listed project. Without an opening preference,
    /// keep the current selection. A choice made while the list loads takes precedence.
    public func activate(preferring projects: [String]? = nil) {
        guard !active else { return }
        active = true
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
        opening?.cancel()
        opening = nil
        stopListening()
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
        read()
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
            projects = names
            if itemRef != nil {
                // The item owns its project, even when the default project's list finishes last.
                openingCandidates = nil
                projectsLoaded = true
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
        projectsLoaded = true
    }

    public func openItem(_ ref: String) {
        itemRef = ref
        itemDetail = nil
        failure = nil
        if pane == .items { reload() } else { pane = .items }
    }

    public func closeItem() {
        guard itemRef != nil else { return }
        itemRef = nil
        itemDetail = nil
        failure = nil
        if project == nil, let first = projects.first { project = first }
        else { reload() }
    }

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
            if self.stale { self.schedule() }
        }
    }

    /// A change of the store: the screen is stale, and one reload follows by the rules above.
    func changed() {
        PerfSpans.measure("work.live.tick") {
            stale = true
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
            self.trailing = nil
            guard self.visible, self.stale, self.loading == nil else { return }
            self.changeReloads += 1
            self.read(change: true)
        }
    }

    public func perform(_ action: WorkScreenAction) async {
        guard let project, !pending.contains(action.ref) else { return }
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
        do {
            notice = try await source.perform(action, project: project)
        } catch {
            notice = WorkActionOutcome(ok: false, message: error.localizedDescription)
        }
        if let notice {
            if notice.ok {
                itemNoticeID = noticeStack.push(.init(text: notice.message))
            } else {
                let outcome = "The work item could not be changed"
                let report = FailureReport.unexpected(notice.message, outcome: outcome, action: "Change the work item")
                itemNoticeID = noticeStack.push(.init(text: outcome, tone: .error, actions: [.details(report)]))
            }
        }
        pendingItemStates[action.ref] = nil
        if notice?.ok != true { showPendingItemStates() }
        await readAfterWrite()
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
