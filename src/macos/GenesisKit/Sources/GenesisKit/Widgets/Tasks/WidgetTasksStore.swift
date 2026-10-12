import Foundation
import SwiftUI

/// One metadata cache, watcher and mutation owner shared by the top and side surfaces.
@MainActor
public final class WidgetTasksStore: ObservableObject {
    @Published private(set) var snapshot: WidgetTaskSnapshot?
    @Published public private(set) var isLoading = false
    /// Tasks with a change on its way to the ledger. Each task has at most one; different tasks run side by side.
    @Published public private(set) var mutatingIDs: Set<String> = []
    /// The state a ticked task shows at once, until the ledger answers.
    @Published public private(set) var pendingStates: [String: String] = [:]
    /// Tasks this store just moved out of the current view (ticked done under Active), kept on screen to undo.
    @Published public private(set) var recent: [WidgetTask] = []
    @Published public private(set) var isCreating = false
    @Published public private(set) var error: String?
    @Published public private(set) var receipt: String?
    @Published public private(set) var undo: WidgetTaskUndo?
    @Published public var draft = WidgetTaskDraft()
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
    private var reconcileTask: Task<Void, Never>?
    private var refreshID: UUID?
    private var mutations: [String: (id: UUID, work: Task<Void, Never>)] = [:]
    private var createTask: Task<Void, Never>?
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
    public var isMutating: Bool { !mutatingIDs.isEmpty }
    public var projects: [String] { snapshot?.projects ?? [] }
    public var sessionFilters: [(id: String, title: String)] { (snapshot?.sessions ?? []).map { ($0.id, $0.title) } }
    private var queryKey: String { "\(scope)|\(project.utf8.count):\(project)|\(session)" }

    /// The state to draw for `task`: the ticked one while its change is in flight.
    public func shownState(_ task: WidgetTask) -> String { pendingStates[task.id] ?? task.state }

    func visibilityChanged(_ presentation: WidgetModulePresentation?) {
        guard !stopped else { return }
        visible = presentation != nil
        if visible { refresh() }
        else {
            refreshID = nil
            refreshTask?.cancel()
            refreshTask = nil
            reconcileTask?.cancel()
            reconcileTask = nil
            isLoading = false
            recent = []
            viewGeneration &+= 1
        }
    }

    private func filtersChanged() {
        guard !stopped else { return }
        error = nil
        recent = []
        viewGeneration &+= 1
        refresh()
    }

    /// Moves on whenever the shown view changes (a filter, or the module hidden), so a change answering late knows
    /// whether the view it started in still applies.
    private var viewGeneration = 0

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
        var filters: [String] = []
        if !project.isEmpty { filters += ["--project", project] }
        if !session.isEmpty { filters += ["--session", session] }
        let args = ["list", "--json", "--scope", scope, "--limit", "200"] + filters
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
                let shown = Set(value.tasks.map(\.id))
                if self.recent.contains(where: { shown.contains($0.id) }) { self.recent.removeAll { shown.contains($0.id) } }
                self.error = self.mutationFailure
                self.watch(value.sourcePath)
                self.reconcileRecent(key: key, filters: filters)
            } catch {
                if !Task.isCancelled, !self.stopped, self.refreshID == identity { self.report(error) }
            }
        }
    }

    /// `recent` holds saved copies of tasks outside the current view, which no list reload returns. After each fresh
    /// read of the ledger they are read again, across every state: a task edited, reopened or dismissed elsewhere
    /// shows its current version, and one that is gone or back in view leaves, so no row offers an undo against a
    /// version the ledger no longer has.
    private func reconcileRecent(key: String, filters: [String]) {
        reconcileTask?.cancel()
        reconcileTask = nil
        guard !recent.isEmpty else { return }
        reconcileTask = Task { [weak self] in
            guard let self else { return }
            do {
                let data = try await self.request(["list", "--json", "--scope", "all", "--limit", "200"] + filters)
                try Task.checkCancellation()
                guard !self.stopped, self.queryKey == key else { return }
                self.reconcile(recentWith: try JSONDecoder().decode(WidgetTaskSnapshot.self, from: data))
            } catch {
                guard !Task.isCancelled else { return }
                PerfLog.mark("widget.tasks recent rows not reread: \(error.localizedDescription)")
            }
        }
    }

    func reconcile(recentWith ledger: WidgetTaskSnapshot) {
        let current = Dictionary(ledger.tasks.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // A task past the list's limit is not known to be gone: its saved copy stays.
        func latest(_ saved: WidgetTask) -> WidgetTask? {
            guard let now = current[saved.id] else { return ledger.truncated ? saved : nil }
            return now
        }
        let next = recent.compactMap(latest).filter { !matchesScope($0) }
        if next != recent { recent = next }
        if let undo, latest(undo.task) != undo.task { self.undo = nil }
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

    /// The row's checkbox: done, or open again. A row under "Just changed" goes back to the state it had before, so a
    /// task ticked done while in progress returns to in progress, not to open.
    public func toggle(_ task: WidgetTask) {
        // Only while the row is still the version this store saved: a later change from another surface (a
        // dismissal) is not undone as if it were this store's tick.
        if recent.contains(where: { $0.id == task.id }), let prior = priorStates[task.id],
           prior.revision == task.revision, prior.updatedTs == task.updatedTs
        {
            let back = WidgetTaskAction.returning(to: prior.state)
            if let first = back.first, task.actions.contains(first) {
                perform(first, on: task, then: back.dropFirst().first)
                return
            }
        }
        if let action = task.toggleAction { perform(action, on: task) }
    }

    /// Ticks, unticks, acknowledges or dismisses one task. The row shows the new state at once; the ledger's
    /// answer confirms it, or the row returns to the saved state with the reason. `next` is a second step (an undo
    /// back to in progress), run against the version this one returned.
    public func perform(_ action: WidgetTaskAction, on task: WidgetTask, then next: WidgetTaskAction? = nil) {
        guard !stopped, mutations[task.id] == nil, task.actions.contains(action) else { return }
        let args = ["update", task.id, "--action", action.rawValue,
                    "--revision", String(task.revision), "--state", task.state, "--updated-at", task.updatedTs,
                    "--session", task.sessionId, "--provider", task.provider]
        let view = viewGeneration
        pendingStates[task.id] = action.targetState
        mutate(task, args: args) { [weak self] data in
            guard let self else { return }
            let response = try JSONDecoder().decode(WidgetTaskUpdate.self, from: data)
            guard response.receipt.saved, response.receipt.id == task.id,
                  response.receipt.action == action.rawValue, response.receipt.state == action.targetState,
                  response.receipt.from == task.state, response.receipt.revision == task.revision,
                  response.task.revision == task.revision, response.task.updatedTs == response.receipt.at,
                  response.task.id == task.id, response.task.state == action.targetState,
                  response.task.sessionId == task.sessionId, response.task.provider == task.provider else {
                throw ToolsBridgeError.refused("The task update returned an inconsistent receipt. Refresh to confirm its state.")
            }
            self.receipt = "\(response.task.statusLabel): \(response.task.title) · saved"
            self.priorStates[task.id] = (task.state, response.task.revision, response.task.updatedTs)
            if let next {
                self.undo = nil
                self.applyLocally(response.task, view: view)
                // `mutate` lets go of the task right after this returns; the second step starts then.
                Task { @MainActor [weak self] in self?.perform(next, on: response.task) }
                return
            }
            let back = WidgetTaskAction.returning(to: task.state)
            self.undo = back.first.flatMap { first in
                response.task.actions.contains(first)
                    ? WidgetTaskUndo(task: response.task, action: first, then: back.dropFirst().first) : nil
            }
            self.applyLocally(response.task, view: view)
        }
    }

    /// The state each task had before this store last changed it, and the version that change saved, so a "Just
    /// changed" row can go back to it while the ledger still holds that version.
    private var priorStates: [String: (state: String, revision: Int, updatedTs: String)] = [:]

    /// New title and text for an open task, against the version the user edited. `onSaved` runs only once the ledger
    /// confirmed the edit, with the task as saved, so an editor that waits for it keeps the user's text through a
    /// refusal or a failure.
    public func edit(_ task: WidgetTask, title: String, details: String, onSaved: @escaping (WidgetTask) -> Void = { _ in }) {
        let title = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let details = details.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stopped, mutations[task.id] == nil, task.editable, !title.isEmpty else { return }
        var args = ["edit", task.id, "--json", "--title", title]
        if !details.isEmpty { args += ["--details", details] }
        args += ["--revision", String(task.revision), "--state", task.state, "--updated-at", task.updatedTs,
                 "--session", task.sessionId, "--provider", task.provider]
        let view = viewGeneration
        mutate(task, args: args) { [weak self] data in
            guard let self else { return }
            let response = try JSONDecoder().decode(WidgetTaskSaved.self, from: data)
            guard response.receipt.saved, response.task.id == task.id, response.task.revision == task.revision + 1 else {
                throw ToolsBridgeError.refused("The task edit returned an inconsistent receipt. Refresh to confirm its text.")
            }
            self.receipt = "Saved: \(response.task.title)"
            self.undo = nil
            self.applyLocally(response.task, view: view)
            onSaved(response.task)
        }
    }

    private func mutate(_ task: WidgetTask, args: [String], saved: @escaping (Data) throws -> Void) {
        let identity = UUID()
        mutatingIDs.insert(task.id)
        mutationFailure = nil
        error = nil
        receipt = nil
        undo = nil
        let work = Task { [weak self] in
            guard let self else { return }
            defer {
                if self.mutations[task.id]?.id == identity {
                    self.mutations[task.id] = nil
                    self.mutatingIDs.remove(task.id)
                    self.pendingStates[task.id] = nil
                }
            }
            do {
                try Task.checkCancellation()
                let data = try await self.request(args)
                try Task.checkCancellation()
                guard !self.stopped, self.mutations[task.id]?.id == identity else { return }
                try saved(data)
                self.cache.removeAll(keepingCapacity: true)
                self.refresh(force: true)
            } catch {
                guard !self.stopped, self.mutations[task.id]?.id == identity else { return }
                if Task.isCancelled {
                    self.error = "Update stopped. Refreshing the saved task state."
                } else { self.report(error) }
                self.mutationFailure = self.error
                self.cache.removeAll(keepingCapacity: true)
                self.refresh(force: true)
            }
        }
        mutations[task.id] = (identity, work)
    }

    /// Shows the saved task before the reload lands, so a tick never flickers back to its old state. A task that
    /// left the current view moves to `recent`, where it stays visible with an undo until the filters change. `view`
    /// is the view the change started in: one that answers after the filters changed or the module was hidden
    /// (both clear `recent`) adds no row to the view shown now, nor does a task the project or session filter hides.
    private func applyLocally(_ task: WidgetTask, view: Int) {
        let inView = matchesScope(task)
        recent.removeAll { $0.id == task.id }
        if !inView, view == viewGeneration, matchesFilters(task) { recent = Array(([task] + recent).prefix(5)) }
        guard var value = snapshot, let index = value.tasks.firstIndex(where: { $0.id == task.id }) else { return }
        if inView { value.tasks[index] = task } else { value.tasks.remove(at: index) }
        snapshot = value
    }

    private func matchesFilters(_ task: WidgetTask) -> Bool {
        (project.isEmpty || project == (task.sourceContext.project ?? task.sourceContext.cwd ?? ""))
            && (session.isEmpty || session == task.provider + ":" + task.sessionId)
    }

    private func matchesScope(_ task: WidgetTask) -> Bool {
        switch scope {
        case "active": return ["open", "acknowledged"].contains(task.state)
        case "completed": return task.state == "implemented"
        case "dismissed": return task.state == "dismissed"
        default: return true
        }
    }

    /// The sessions a new task can belong to: the widget's live sessions first (newest activity), then the ones
    /// the ledger already knows. Built when the menu opens, never in a body.
    /// The project and worktree the last chosen session put in the draft, so the next choice can tell them apart
    /// from a project the user picked in the Project menu.
    private var sessionContext = (project: "", cwd: "")

    /// Files the new task under `choice`. Its project and worktree replace the ones the previous session brought,
    /// even when they are empty (a session only the ledger knows has none), so a task never lands under the last
    /// session's project; a project the user picked by hand stays when the new session has none.
    public func chooseSession(_ choice: WidgetTaskSessionChoice) {
        draft.session = choice.id
        draft.sessionTitle = choice.title
        if !choice.project.isEmpty || draft.project == sessionContext.project {
            draft.project = choice.project
        }
        if !choice.cwd.isEmpty || draft.cwd == sessionContext.cwd {
            draft.cwd = choice.cwd
        }
        sessionContext = (choice.project, choice.cwd)
    }

    public func sessionChoices(limit: Int = 30) -> [WidgetTaskSessionChoice] {
        var seen = Set<String>()
        var choices: [WidgetTaskSessionChoice] = []
        for live in sessionsSource().filter({ $0.parentKey == nil && $0.agentId == nil })
            .sorted(by: { $0.activityAt > $1.activityAt }) {
            let id = live.target.provider + ":" + live.target.sessionId
            if seen.insert(id).inserted {
                choices.append(.init(id: id, title: live.title, project: live.project, cwd: live.target.cwd))
            }
        }
        for known in snapshot?.sessions ?? [] where seen.insert(known.id).inserted {
            choices.append(.init(id: known.id, title: known.title, project: "", cwd: ""))
        }
        return Array(choices.prefix(limit))
    }

    /// Adds the drafted task. On success the title and details clear, the session and project stay for the next.
    public func create() {
        let title = draft.title.trimmingCharacters(in: .whitespacesAndNewlines)
        let details = draft.details.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !stopped, !isCreating, !title.isEmpty else { return }
        var args = ["create", "--json", "--title", title]
        if !details.isEmpty { args += ["--details", details] }
        if !draft.session.isEmpty {
            args += ["--session", draft.session]
            if !draft.sessionTitle.isEmpty { args += ["--session-title", draft.sessionTitle] }
        }
        if !draft.project.isEmpty { args += ["--project", draft.project] }
        if !draft.cwd.isEmpty { args += ["--cwd", draft.cwd] }
        isCreating = true
        error = nil
        receipt = nil
        undo = nil
        let submitted = draft
        createTask = Task { [weak self] in
            guard let self else { return }
            defer {
                self.isCreating = false
                self.createTask = nil
            }
            do {
                let data = try await self.request(args)
                guard !self.stopped else { return }
                let response = try JSONDecoder().decode(WidgetTaskSaved.self, from: data)
                guard response.receipt.saved, response.task.state == "open" else {
                    throw ToolsBridgeError.refused("The new task returned an inconsistent receipt. Refresh to confirm it.")
                }
                if self.draft == submitted {
                    self.draft.title = ""
                    self.draft.details = ""
                }
                self.receipt = "Added: \(response.task.title)"
                self.reveal(response.task)
                self.cache.removeAll(keepingCapacity: true)
                self.refresh(force: true)
            } catch {
                guard !self.stopped, !Task.isCancelled else { return }
                self.report(error)
            }
        }
    }

    /// Widens the filters when they would hide a task the user just added.
    private func reveal(_ task: WidgetTask) {
        if !["active", "all"].contains(scope) { scope = "active" }
        if !project.isEmpty, project != (task.sourceContext.project ?? task.sourceContext.cwd ?? "") { project = "" }
        if !session.isEmpty, session != task.provider + ":" + task.sessionId { session = "" }
    }

    public func cancelUpdate() {
        for mutation in mutations.values { mutation.work.cancel() }
    }

    public func clearFeedback() {
        mutationFailure = nil
        error = nil
        receipt = nil
        undo = nil
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
        refreshTask?.cancel()
        refreshTask = nil
        reconcileTask?.cancel()
        reconcileTask = nil
        for mutation in mutations.values { mutation.work.cancel() }
        mutations = [:]
        createTask?.cancel()
        createTask = nil
        watcher?.stop()
        watcher = nil
        cache.removeAll()
        isLoading = false
        isCreating = false
        mutatingIDs = []
        pendingStates = [:]
    }

    private func report(_ failure: Error) {
        error = failure.localizedDescription
        PerfLog.mark("widget.tasks \(failure.localizedDescription)")
    }
}
