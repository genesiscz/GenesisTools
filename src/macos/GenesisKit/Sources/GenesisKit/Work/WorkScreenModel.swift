import Foundation
import SwiftUI

/// The state of the Work screen of one project. It loads through a `WorkSource`, reloads on every change of the store
/// (at most once each 0.3 s while changes keep coming), and runs the writes of the rows.
@MainActor
public final class WorkScreenModel: ObservableObject {
    public enum Pane: String, CaseIterable, Sendable {
        case items, notify
        public var title: String { self == .items ? "Items" : "Notifications" }
    }

    @Published public private(set) var projects: [String] = []
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
    private var listening: Task<Void, Never>?
    private var loading: Task<Void, Never>?
    private var lastReload = Date.distantPast
    private var trailing: Task<Void, Never>?

    public init(source: WorkSource) {
        self.source = source
    }

    /// The screen is on screen: read the projects and the chosen one, and follow the store's changes.
    public func activate() {
        guard listening == nil else { return }
        let stream = source.changes()
        listening = Task { [weak self] in
            for await _ in stream { self?.changed() }
        }
        Task { await loadProjects() }
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
    }

    public func reload() {
        guard let project else { return }
        loading?.cancel()
        isLoading = true
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
            self.isLoading = false
        }
    }

    /// One reload per burst of changes: at once when the last one is older than 0.3 s, else once at the end.
    func changed() {
        let wait = 0.3 - Date().timeIntervalSince(lastReload)
        if wait <= 0 {
            lastReload = Date()
            reload()
            return
        }
        guard trailing == nil else { return }
        trailing = Task { [weak self] in
            try? await Task.sleep(for: .seconds(wait))
            guard let self, !Task.isCancelled else { return }
            self.trailing = nil
            self.lastReload = Date()
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
