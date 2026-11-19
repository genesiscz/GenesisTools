import Foundation
import SwiftUI

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
                reload()
            }
        }
    }
    @Published public var pane: Pane = .items {
        didSet {
            if pane != oldValue {
                if pane == .notify { itemRef = nil; itemDetail = nil }
                reload()
            }
        }
    }
    @Published public private(set) var itemRef: String?
    @Published public private(set) var itemDetail: WorkItemDetail?
    private var adoptingItemProject = false
    @Published public private(set) var snapshot: WorkSnapshotValue?
    @Published public private(set) var notifyRows: [WorkNotifyRow] = []
    @Published public private(set) var isLoading = false
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

    public init(source: WorkSource, reloadInterval: TimeInterval = 3, settle: TimeInterval = 0.5) {
        self.source = source
        self.reloadInterval = reloadInterval
        self.settle = settle
    }

    /// Whether anyone can see the screen (the hub window is not covered, minimized or hidden). Hidden, a change
    /// waits; shown again, one reload reads what changed meanwhile.
    public func setVisible(_ next: Bool) {
        guard next != visible else { return }
        visible = next
        if next {
            if stale || projectsStale { schedule() }
        } else {
            trailing?.cancel()
            trailing = nil
        }
    }

    /// On entry, open the first matching candidate or the first listed project. Without an opening preference,
    /// keep the current selection. A choice made while the list loads takes precedence.
    public func activate(preferring projects: [String]? = nil) {
        guard listening == nil else { return }
        openingCandidates = projects
        let stream = source.changes()
        listening = Task { [weak self] in
            for await _ in stream { self?.changed() }
        }
        let previousLoad = loadToken
        opening = Task {
            guard !Task.isCancelled else { return }
            await loadProjects()
            if !Task.isCancelled && loadToken == previousLoad && itemRef == nil { reload() }
        }
    }

    /// The screen left: no more reloads while nobody sees it.
    public func deactivate() {
        opening?.cancel()
        opening = nil
        listening?.cancel()
        listening = nil
        trailing?.cancel()
        trailing = nil
        loading?.cancel()
        loading = nil
        loadToken = UUID()
        isLoading = false
        stale = true
    }

    public func loadProjects() async {
        do {
            let names = try await source.projects()
            guard !Task.isCancelled else { return }
            if project == nil && itemRef == nil { failure = nil }
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
        guard visible, listening != nil else {
            stale = true
            return
        }
        loading?.cancel()
        let project = project
        let ref = itemRef
        guard project != nil || ref != nil else {
            loading = nil
            isLoading = false
            return
        }
        stale = false
        lastReload = Date()
        isLoading = true
        let token = UUID()
        loadToken = token
        let pane = pane
        loading = Task { [weak self] in
            guard let self else { return }
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
                    self.itemDetail = detail
                } else if let project, pane == .items {
                    let next = try await self.source.snapshot(project: project)
                    guard !Task.isCancelled, self.project == project else { return }
                    self.snapshot = next
                } else if let project {
                    let rows = try await self.source.notify(project: project)
                    guard !Task.isCancelled, self.project == project else { return }
                    self.notifyRows = rows
                }
                self.failure = nil
            } catch {
                guard !Task.isCancelled else { return }
                self.failure = error.localizedDescription
            }
            guard self.loadToken == token else { return }
            self.isLoading = false
            self.loading = nil
            // Changes that came during this reload get one more, by the same rules.
            if self.stale || self.projectsStale { self.schedule() }
        }
    }

    /// A change of the store: the screen is stale, and one reload follows by the rules above.
    func changed() {
        stale = true
        projectsStale = true
        schedule()
    }

    /// One reload after the burst settles, no sooner than `reloadInterval` after the last one, never beside a running
    /// one, never while hidden. A burst that keeps going still reloads once per interval.
    private func schedule() {
        guard visible, listening != nil, trailing == nil, loading == nil else { return }
        let wait = max(settle, reloadInterval - Date().timeIntervalSince(lastReload))
        trailing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            guard self.visible, self.listening != nil, (self.stale || self.projectsStale), self.loading == nil else {
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
            guard self.visible, self.listening != nil else { return }
            if self.loadToken == previousLoad { self.reload() }
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
        reload()
    }

    public func clearNotice() { notice = nil }
}
