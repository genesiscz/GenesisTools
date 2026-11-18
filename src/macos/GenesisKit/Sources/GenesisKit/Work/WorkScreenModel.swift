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
    @Published public var project: String? { didSet { if project != oldValue { reload() } } }
    @Published public var pane: Pane = .items { didSet { if pane != oldValue { reload() } } }
    @Published public private(set) var snapshot: WorkSnapshotValue?
    @Published public private(set) var notifyRows: [WorkNotifyRow] = []
    @Published public private(set) var isLoading = false
    @Published public private(set) var failure: String?
    /// The answer of the last write: ok shows as a fading notice, a refusal stays until the next write.
    @Published public private(set) var notice: WorkActionOutcome?
    /// Items with a write on its way; their row shows it and refuses a second click.
    @Published public private(set) var pending: Set<String> = []

    private let source: WorkSource
    /// The shortest time between two reloads that a change of the store starts.
    let reloadInterval: TimeInterval
    /// How long a burst must be quiet before its reload, within `reloadInterval`.
    let settle: TimeInterval
    private var listening: Task<Void, Never>?
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
            if stale { schedule() }
        } else {
            trailing?.cancel()
            trailing = nil
        }
    }

    /// The screen is on screen: read the projects and the chosen one, and follow the store's changes.
    public func activate() {
        guard listening == nil else { return }
        let stream = source.changes()
        listening = Task { [weak self] in
            for await _ in stream { self?.changed() }
        }
        // Back on the screen: the changes made while it was away were not followed, so read once more (a new
        // project choice reads by itself).
        Task {
            let before = project
            await loadProjects()
            if project == before { reload() }
        }
    }

    /// The screen left: no more reloads while nobody sees it.
    public func deactivate() {
        listening?.cancel()
        listening = nil
        trailing?.cancel()
        trailing = nil
    }

    public func loadProjects() async {
        do {
            projects = try await source.projects()
            if project == nil || !(projects.contains(project ?? "")) { project = projects.first }
        } catch {
            failure = error.localizedDescription
        }
        projectsLoaded = true
    }

    public func reload() {
        guard let project else { return }
        loading?.cancel()
        stale = false
        lastReload = Date()
        isLoading = true
        let token = UUID()
        loadToken = token
        let pane = pane
        loading = Task { [weak self] in
            guard let self else { return }
            do {
                switch pane {
                case .items:
                    let next = try await self.source.snapshot(project: project)
                    guard !Task.isCancelled, self.project == project else { return }
                    self.snapshot = next
                case .notify:
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
            if self.stale { self.schedule() }
        }
    }

    /// A change of the store: the screen is stale, and one reload follows by the rules above.
    func changed() {
        stale = true
        schedule()
    }

    /// One reload after the burst settles, no sooner than `reloadInterval` after the last one, never beside a running
    /// one, never while hidden. A burst that keeps going still reloads once per interval.
    private func schedule() {
        guard visible, trailing == nil, loading == nil else { return }
        let wait = max(settle, reloadInterval - Date().timeIntervalSince(lastReload))
        trailing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.trailing = nil
            guard self.visible, self.stale, self.loading == nil else { return }
            self.changeReloads += 1
            self.reload()
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
