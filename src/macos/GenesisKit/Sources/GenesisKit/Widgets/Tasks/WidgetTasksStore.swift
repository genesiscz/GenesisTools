import Foundation
import SwiftUI

/// One metadata cache, watcher and mutation owner shared by the top and side surfaces.
@MainActor
public final class WidgetTasksStore: ObservableObject {
    @Published private(set) var snapshot: WidgetTaskSnapshot?
    @Published public private(set) var isLoading = false
    @Published public private(set) var mutatingID: String?
    @Published public private(set) var error: String?
    @Published public private(set) var receipt: String?
    @Published public var scope = "active" { didSet { if scope != oldValue { filtersChanged() } } }
    @Published public var project = "" { didSet { if project != oldValue { filtersChanged() } } }
    @Published public var session = "" { didSet { if session != oldValue { filtersChanged() } } }
    private let request: ([String]) async throws -> Data
    private let sessionsSource: () -> [WidgetSession]
    private let openSession: (WidgetSession, String) -> Void
    private var cache: [String: WidgetTaskSnapshot] = [:]
    private var watcher: DirectoryWatcher?
    private var watchedPath: String?
    private var visible = false
    private var stopped = false
    private var refreshTask: Task<Void, Never>?
    private var refreshID: UUID?
    private var mutationTask: Task<Void, Never>?
    private var mutationID: UUID?
    private var mutationFailure: String?
    private var displayedKey: String?

    public init(binaryPath: String, sessions: @escaping () -> [WidgetSession],
                openSession: @escaping (WidgetSession, String) -> Void) {
        let bridge = ToolsBridge(binaryPath: binaryPath)
        request = { args in
            let result = try await bridge.run(subcommand: "hub", args: ["widget", "tasks"] + args, timeoutSeconds: 15)
            guard result.exitCode == 0 else { throw ToolsBridgeError.refused(String(result.stderr.suffix(1200))) }
            return Data(result.stdout.utf8)
        }
        sessionsSource = sessions
        self.openSession = openSession
    }

    init(request: @escaping ([String]) async throws -> Data,
         sessions: @escaping () -> [WidgetSession] = { [] },
         openSession: @escaping (WidgetSession, String) -> Void = { _, _ in }) {
        self.request = request
        sessionsSource = sessions
        self.openSession = openSession
    }

    public var tasks: [WidgetTask] { displayedKey == queryKey ? snapshot?.tasks ?? [] : [] }
    public var activeCount: Int { snapshot?.activeCount ?? 0 }
    public var isMutating: Bool { mutatingID != nil }
    private var queryKey: String { "\(scope)|\(project.utf8.count):\(project)|\(session)" }

    func visibilityChanged(_ presentation: WidgetModulePresentation?) {
        guard !stopped else { return }
        visible = presentation != nil
        if visible { refresh() }
        else {
            refreshID = nil
            refreshTask?.cancel()
            refreshTask = nil
            isLoading = false
        }
    }

    private func filtersChanged() {
        guard !stopped else { return }
        error = nil
        refresh()
    }

    public func refresh(force: Bool = false) {
        guard !stopped else { return }
        let key = queryKey
        if !force, let cached = cache[key] {
            refreshID = nil
            refreshTask?.cancel()
            refreshTask = nil
            if isLoading { isLoading = false }
            displayedKey = key
            if snapshot != cached { snapshot = cached }
            return
        }
        refreshTask?.cancel()
        let identity = UUID()
        refreshID = identity
        isLoading = true
        var args = ["list", "--json", "--scope", scope, "--limit", "200"]
        if !project.isEmpty { args += ["--project", project] }
        if !session.isEmpty { args += ["--session", session] }
        refreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.refreshID == identity {
                    self.isLoading = false
                    self.refreshTask = nil
                }
            }
            do {
                try Task.checkCancellation()
                let data = try await self.request(args)
                try Task.checkCancellation()
                guard !self.stopped, self.refreshID == identity, self.queryKey == key else { return }
                let value = try JSONDecoder().decode(WidgetTaskSnapshot.self, from: data)
                if self.cache.count >= 8 { self.cache.removeAll(keepingCapacity: true) }
                self.cache[key] = value
                self.displayedKey = key
                if self.snapshot != value { self.snapshot = value }
                self.error = self.mutationFailure
                self.watch(value.sourcePath)
            } catch {
                if !Task.isCancelled, !self.stopped, self.refreshID == identity { self.report(error) }
            }
        }
    }

    private func watch(_ path: String) {
        guard watchedPath != path else { return }
        watcher?.stop()
        watchedPath = path
        let resolved = URL(fileURLWithPath: path).resolvingSymlinksInPath().path
        watcher = DirectoryWatcher(paths: [(resolved as NSString).deletingLastPathComponent], latency: 0.2,
                                   accepts: { $0 == resolved }) { [weak self] _ in
            MainActor.assumeIsolated { self?.sourceChanged() }
        }
    }

    func sourceChanged() {
        guard !stopped else { return }
        cache.removeAll(keepingCapacity: true)
        if visible { refresh(force: true) }
    }

    public func perform(_ action: WidgetTaskAction, on task: WidgetTask) {
        guard !stopped, mutationTask == nil, task.actions.contains(action) else { return }
        let identity = UUID()
        mutationID = identity
        mutatingID = task.id
        mutationFailure = nil
        error = nil
        receipt = nil
        let args = ["update", task.id, "--action", action.rawValue,
                    "--revision", String(task.revision), "--state", task.state, "--updated-at", task.updatedTs,
                    "--session", task.sessionId, "--provider", task.provider]
        mutationTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.mutationID == identity {
                    self.mutatingID = nil
                    self.mutationTask = nil
                }
            }
            do {
                try Task.checkCancellation()
                let data = try await self.request(args)
                try Task.checkCancellation()
                guard !self.stopped, self.mutationID == identity else { return }
                let response = try JSONDecoder().decode(WidgetTaskUpdate.self, from: data)
                guard response.receipt.saved, response.receipt.id == task.id,
                      response.receipt.action == action.rawValue, response.receipt.state == action.targetState,
                      response.receipt.from == task.state, response.receipt.revision == task.revision,
                      response.task.revision == task.revision, response.task.updatedTs == response.receipt.at,
                      response.task.id == task.id, response.task.state == action.targetState,
                      response.task.sessionId == task.sessionId, response.task.provider == task.provider else {
                    throw ToolsBridgeError.refused("The task update returned an inconsistent receipt. Refresh to confirm its state.")
                }
                self.receipt = "\(response.task.statusLabel): \(response.task.title) · saved locally"
                self.cache.removeAll(keepingCapacity: true)
                self.refresh(force: true)
            } catch {
                guard !self.stopped, self.mutationID == identity else { return }
                if Task.isCancelled {
                    self.error = "Update stopped. Refreshing the saved task state."
                } else { self.report(error) }
                self.mutationFailure = self.error
                self.cache.removeAll(keepingCapacity: true)
                self.refresh(force: true)
            }
        }
    }

    public func cancelUpdate() { mutationTask?.cancel() }

    public func clearFeedback() {
        mutationFailure = nil
        error = nil
        receipt = nil
    }

    public func sourceSession(for task: WidgetTask) -> WidgetSession? {
        let matches = sessionsSource().filter {
            $0.target.sessionId == task.sessionId && $0.target.provider == task.provider
        }
        return matches.count == 1 ? matches.first : nil
    }

    public func openSource(_ task: WidgetTask) {
        if let session = sourceSession(for: task) { openSession(session, "decision:" + task.id) }
    }

    public func stop() {
        stopped = true
        visible = false
        refreshID = nil
        mutationID = nil
        refreshTask?.cancel()
        mutationTask?.cancel()
        refreshTask = nil
        mutationTask = nil
        watcher?.stop()
        watcher = nil
        cache.removeAll()
        isLoading = false
        mutatingID = nil
    }

    private func report(_ failure: Error) {
        error = failure.localizedDescription
        PerfLog.mark("widget.tasks \(failure.localizedDescription)")
    }
}
