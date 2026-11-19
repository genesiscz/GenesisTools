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
                isFirstLoad = true
                read()
            }
        }
    }
    @Published public var pane: Pane = .items {
        didSet {
            if pane != oldValue {
                if pane == .notify { itemRef = nil; itemDetail = nil }
                read()
            }
        }
    }
    @Published public private(set) var itemRef: String?
    @Published public private(set) var itemDetail: WorkItemDetail?
    private var adoptingItemProject = false
    @Published public private(set) var snapshot: WorkSnapshotValue?
    public private(set) var rowAnimation: Bool?
    @Published public private(set) var notifyRows: [WorkNotifyRow] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var isFirstLoad = true
    @Published public private(set) var live: WorkLiveState = .live
    @Published public private(set) var failure: String?
    /// The answer of the last write: ok shows as a fading notice, a refusal stays until the next write.
    @Published public private(set) var notice: WorkActionOutcome?
    /// Items with a write on its way; their row shows it and refuses a second click.
    @Published public private(set) var pending: Set<String> = []

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
                    let next = try await self.source.snapshot(project: project)
                    guard !Task.isCancelled, self.project == project else { return }
                    PerfSpans.measure("work.reload") {
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
        do {
            notice = try await source.perform(action, project: project)
        } catch {
            notice = WorkActionOutcome(ok: false, message: error.localizedDescription)
        }
        await readAfterWrite()
    }

    private func readAfterWrite() async {
        read()
        // An explicit read or a navigation may supersede our read while it is in flight.
        while let current = loading { await current.value }
    }

    public func clearNotice() { notice = nil }
}

private extension WorkSnapshotValue {
    var rowRefs: Set<String> {
        Set(containers.map(\.ref) + containers.flatMap { $0.members.map(\.ref) } + triage.map(\.ref))
    }
}
