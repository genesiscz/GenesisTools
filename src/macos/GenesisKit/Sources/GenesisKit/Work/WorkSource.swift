import Foundation
import GenesisKitBase
import os

private let workSourceLog = Logger(subsystem: "genesiskit", category: "work.source")

// The hub's Work screen (work-items P8): the open handoffs of a project with their tasks, the spotted items, the items
// reopened with nobody working on them, and who hears about each kind of change. The data comes from the `work` area of
// the actions service through the generated client. A session TODO still in the old ledger has its own read door.

public struct WorkPairingValue: Identifiable, Equatable, Sendable, Decodable {
    public enum State: String, Decodable, Sendable {
        case synced = "in-sync"
        case pending, held, drift, failed
    }

    public enum DriftDirection: String, Decodable, Sendable {
        case local, remote
    }

    public var connector: String
    public var displayName: String?
    public var enabled: Bool
    public var remoteKey: String
    public var state: State
    public var driftDirection: DriftDirection?
    public var note: String?
    public var id: String { connector }

    public init(connector: String, displayName: String? = nil, remoteKey: String, state: State,
                driftDirection: DriftDirection? = nil, note: String? = nil, enabled: Bool = true) {
        self.connector = connector; self.displayName = displayName; self.remoteKey = remoteKey
        self.state = state; self.driftDirection = driftDirection; self.note = note
        self.enabled = enabled
    }
}

/// One item as a row.
public struct WorkRowValue: Identifiable, Equatable, Sendable, Decodable {
    public var ref: String
    public var state: String
    public var type: String
    public var severity: String?
    public var worker: String?
    public var title: String
    public var project: String?
    public var slot: String?
    public var pairings: [WorkPairingValue]?
    public var id: String { ref }

    public init(ref: String, state: String, type: String, severity: String? = nil, worker: String? = nil,
                title: String, project: String? = nil, slot: String? = nil, pairings: [WorkPairingValue]? = nil) {
        self.ref = ref; self.state = state; self.type = type; self.severity = severity
        self.worker = worker; self.title = title; self.project = project; self.slot = slot
        self.pairings = pairings
    }

    public var isOpen: Bool { ["spotted", "open", "active", "reopened"].contains(state) }
}

/// An open handoff or epic with its members.
public struct WorkContainerValue: Identifiable, Equatable, Sendable, Decodable {
    public var ref: String
    public var type: String
    public var state: String
    public var title: String
    public var open: Int
    public var total: Int
    public var members: [WorkRowValue]
    public var pairings: [WorkPairingValue]?
    public var id: String { ref }

    public init(ref: String, type: String, state: String, title: String, open: Int, total: Int, members: [WorkRowValue],
                pairings: [WorkPairingValue]? = nil) {
        self.ref = ref; self.type = type; self.state = state; self.title = title
        self.open = open; self.total = total; self.members = members; self.pairings = pairings
    }
}

/// An item that waits for a look: spotted, or reopened with nobody working on it.
public struct WorkTriageValue: Identifiable, Equatable, Sendable, Decodable {
    public var ref: String
    public var group: String
    public var type: String
    public var state: String
    public var title: String
    public var `where`: String?
    public var why: String?
    public var userSees: String?
    public var severity: String?
    public var spottedBy: String?
    public var worker: String?
    public var pairings: [WorkPairingValue]?
    public var id: String { ref }

    public init(ref: String, group: String, type: String, state: String, title: String, where: String? = nil,
                why: String? = nil, userSees: String? = nil, severity: String? = nil, spottedBy: String? = nil,
                worker: String? = nil, pairings: [WorkPairingValue]? = nil) {
        self.ref = ref; self.group = group; self.type = type; self.state = state; self.title = title
        self.where = `where`; self.why = why; self.userSees = userSees; self.severity = severity
        self.spottedBy = spottedBy; self.worker = worker; self.pairings = pairings
    }
}

/// What the Work screen shows of one project.
public struct WorkSnapshotValue: Equatable, Sendable {
    public var project: String
    public var containers: [WorkContainerValue]
    public var triage: [WorkTriageValue]

    public init(project: String, containers: [WorkContainerValue], triage: [WorkTriageValue]) {
        self.project = project; self.containers = containers; self.triage = triage
    }

    public var spotted: [WorkTriageValue] { triage.filter { $0.group == "spotted" } }
    public var reopened: [WorkTriageValue] { triage.filter { $0.group == "reopened-no-worker" } }
    public var openHandoffs: [WorkContainerValue] { containers.filter { $0.type == "handoff" } }
}

/// One cell of the notify grid: who hears about one action on one type, each layer's level, and the layer that decides.
public struct WorkNotifyCell: Identifiable, Equatable, Sendable {
    public struct Layer: Equatable, Sendable {
        public var layer: String
        public var level: String?
        public var wildcard: Bool
        public var rule: WorkNotifyRule?
        public var fallback: String?
        public init(layer: String, level: String?, wildcard: Bool = false, rule: WorkNotifyRule? = nil, fallback: String? = nil) {
            self.layer = layer; self.level = level; self.wildcard = wildcard; self.rule = rule
            self.fallback = fallback
        }
    }

    public var action: String
    public var level: String
    public var from: String
    public var layers: [Layer]
    public var minSeverity: String?
    public var repoPath: String?
    public var builtInLevel: String
    public var writable: Bool { from != "config.repo" }
    /// The strongest rule left when the concrete override at this scope is removed.
    public func inheriting(_ scope: WorkNotifyScope) -> (level: String, layer: String) {
        let removed = scope == .project ? "config.project" : "config.global"
        for entry in layers.reversed() {
            let value = entry.layer == removed && !entry.wildcard ? entry.fallback : entry.level
            if let value { return (value, entry.layer) }
        }
        return (builtInLevel, "default")
    }
    public var id: String { action }

    public init(action: String, level: String, from: String, layers: [Layer],
                minSeverity: String? = nil, repoPath: String? = nil, builtInLevel: String = "list") {
        self.action = action; self.level = level; self.from = from; self.layers = layers
        self.minSeverity = minSeverity; self.repoPath = repoPath; self.builtInLevel = builtInLevel
    }
}

public struct WorkNotifyRow: Identifiable, Equatable, Sendable {
    public var type: String
    public var cells: [WorkNotifyCell]
    public var id: String { type }

    public init(type: String, cells: [WorkNotifyCell]) { self.type = type; self.cells = cells }
}

/// A write the screen offers on one item.
public enum WorkScreenAction: Equatable, Sendable {
    case accept(ref: String)
    case drop(ref: String, why: String)
    case finish(ref: String, proof: String)
    case reopen(ref: String, why: String)
    case addMember(ref: String, handoff: String)
    // A tree member can belong to another project. Its own settings decide which connector gets the push.
    case unpair(ref: String, connector: String, project: String? = nil)
    case sync(ref: String, project: String? = nil)

    public var ref: String {
        switch self {
        case let .accept(ref), let .drop(ref, _), let .finish(ref, _), let .reopen(ref, _),
             let .addMember(ref, _), let .unpair(ref, _, _), let .sync(ref, _): return ref
        }
    }

    /// The past tense for the notice after the write.
    public var done: String {
        switch self {
        case .accept: return "Accepted"
        case .drop: return "Dropped"
        case .finish: return "Finished"
        case .reopen: return "Reopened"
        case let .addMember(_, handoff): return "Added to \(handoff)"
        case .unpair: return "Unpaired"
        case .sync: return "Pushed"
        }
    }
}

/// The answer of a write: ok, or the first reason it did not happen.
public struct WorkActionOutcome: Equatable, Sendable {
    public var ok: Bool
    public var message: String
    public var changes: [WorkNotifyChange]
    public init(ok: Bool, message: String, changes: [WorkNotifyChange] = []) {
        self.ok = ok; self.message = message; self.changes = changes
    }
}

public struct WorkSourceError: LocalizedError, Equatable, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
    public var errorDescription: String? { message }
}

/// Where the Work screen reads and writes. Tests give a fake; the app gives LiveWorkSource.
@MainActor
public protocol WorkSource: AnyObject {
    func projects() async throws -> [String]
    func snapshot(project: String) async throws -> WorkSnapshotValue
    func detail(ref: String) async throws -> WorkItemDetail
    func notify(project: String) async throws -> [WorkNotifyRow]
    func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome
    /// A tick for each change of the store, from any writer (the service's `work.changed`, a CLI or MCP write).
    func changes() -> AsyncStream<Void>
    // MARK: - Notify
    func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String, level: String?) async throws -> WorkActionOutcome
    func restoreNotify(project: String?, scope: WorkNotifyScope, changes: [WorkNotifyChange]) async throws -> WorkActionOutcome
}

public enum WorkNotifyScope: String, Sendable { case project, global }

/// Raw values at the edited layer. Inheritance encodes as an explicit JSON null in the Undo request.
public enum WorkNotifyRule: Codable, Equatable, Sendable {
    case inherit, level(String), threshold(level: String, minSeverity: String)
    private struct Threshold: Codable { let level: String; let minSeverity: String }

    public init(from decoder: Decoder) throws {
        let box = try decoder.singleValueContainer()
        if box.decodeNil() { self = .inherit }
        else if let level = try? box.decode(String.self) { self = .level(level) }
        else {
            let rule = try box.decode(Threshold.self)
            self = .threshold(level: rule.level, minSeverity: rule.minSeverity)
        }
    }
    public func encode(to encoder: Encoder) throws {
        var box = encoder.singleValueContainer()
        switch self {
        case .inherit: try box.encodeNil()
        case .level(let value): try box.encode(value)
        case .threshold(let value, let severity): try box.encode(Threshold(level: value, minSeverity: severity))
        }
    }
}

public struct WorkNotifyChange: Codable, Equatable, Sendable {
    public var path: String
    public var type: String
    public var action: String
    public var from: WorkNotifyRule
    public var to: WorkNotifyRule
    public init(path: String, type: String, action: String, from: WorkNotifyRule, to: WorkNotifyRule) {
        self.path = path; self.type = type; self.action = action; self.from = from; self.to = to
    }
}

// Read-only sources can still be used by the hub and its static previews.
public extension WorkSource {
    func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String, level: String?) async throws -> WorkActionOutcome {
        throw WorkSourceError("This source cannot edit notification rules.")
    }
    func restoreNotify(project: String?, scope: WorkNotifyScope, changes: [WorkNotifyChange]) async throws -> WorkActionOutcome {
        throw WorkSourceError("This source cannot restore notification rules.")
    }
}

/// The `work` area through the generated client. Each answer is an `ActionOutcome` around the method's reply; it is
/// encoded once and read into the screen's own small models, so the views never name the generated types.
@MainActor
public final class LiveWorkSource: WorkSource {
    private let rpc: GenesisToolsRPC
    private let walPath: String

    public init(rpc: GenesisToolsRPC? = nil,
                walPath: String = GenesisToolsHome.path("work/work.db-wal")) {
        self.rpc = rpc ?? .shared
        self.walPath = walPath
    }

    public func projects() async throws -> [String] {
        let names: [String] = try reply(await rpc.work.projects(WorkProjectsParams()))
        return names.sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
    }

    public func snapshot(project: String) async throws -> WorkSnapshotValue {
        let call = WorkTreeParamsCall(project: project)
        async let tree = rpc.work.tree(WorkTreeParams(project: project, call: call))
        async let triage = rpc.work.triage(WorkTriageParams(project: project, call: WorkTriageParamsCall(project: project)))
        return try await assembleSnapshot(project: project, tree: tree, triage: triage)
    }

    private nonisolated func assembleSnapshot(project: String, tree: WorkTreeResult, triage: WorkTriageResult) async throws -> WorkSnapshotValue {
        let treeData: TreeData = try reply(tree)
        let rows: [WorkTriageValue] = try reply(triage)
        return WorkSnapshotValue(project: project, containers: treeData.containers, triage: rows)
    }

    public func detail(ref: String) async throws -> WorkItemDetail {
        if ref.hasPrefix("t_") {
            // An older listing, or a TODO before its first import, has only the id used by question show.
            struct Todo: Decodable {
                var id: String
                var title: String?
                var prompt: String
                var state: String
                var project: String?
            }
            let result = try await ToolsBridge(binaryPath: ToolsBridge.defaultBinaryPath())
                .run(subcommand: "question", args: ["show", ref, "--json"])
            guard result.exitCode == 0 else { throw WorkSourceError(result.stderr) }
            let todo = try JSONDecoder().decode(Todo.self, from: Data(result.stdout.utf8))
            return WorkItemDetail(item: .init(id: todo.id, title: todo.title ?? todo.prompt, type: "task",
                                              state: WidgetTask.label(for: todo.state), project: todo.project,
                                              body: todo.prompt, acceptance: nil))
        }
        return try reply(await rpc.work.show(WorkShowParams(ref: ref)))
    }

    public func notify(project: String) async throws -> [WorkNotifyRow] {
        let result = try await rpc.work.config(WorkConfigParams(project: project, call: .init(project: project)))
        return try await notifyRows(from: result)
    }

    private nonisolated func notifyRows(from result: WorkConfigResult) async throws -> [WorkNotifyRow] {
        let data: ConfigData = try reply(result)
        return data.rows.map { row in
            WorkNotifyRow(type: row.type, cells: row.notify.map { cell in
                let data = cell.editor ?? cell.resolved
                return WorkNotifyCell(action: cell.action, level: data.level, from: data.from,
                               layers: data.layers.map { .init(layer: $0.layer, level: $0.value,
                                                                wildcard: $0.wildcard ?? false, rule: $0.rule, fallback: $0.fallback) },
                               minSeverity: data.minSeverity, repoPath: data.repoPath,
                               builtInLevel: data.builtInLevel ?? "list")
            })
        }
    }

    // MARK: - Notify
    public func setNotify(project: String?, scope: WorkNotifyScope, type: String, action: String,
                          level: String?) async throws -> WorkActionOutcome {
        guard let type = WorkConfigSetParamsNotifyType(rawValue: type),
              let action = WorkConfigSetParamsNotifyAction(rawValue: action) else {
            throw WorkSourceError("Choose a known work type and change.")
        }
        let choice = level.flatMap(WorkConfigSetParamsNotifyLevel.init(rawValue:))
        guard level == nil || choice != nil else { throw WorkSourceError("Choose a known notification level.") }
        return try await changeNotify(.init(scope: scope == .global ? .value1 : .value0, project: project,
                                             notify: .init(type: type, action: action, level: choice), call: .init(project: project)))
    }

    public func restoreNotify(project: String?, scope: WorkNotifyScope, changes: [WorkNotifyChange]) async throws -> WorkActionOutcome {
        let restore = try JSONDecoder().decode([WorkConfigSetParamsRestoreItem].self, from: JSONEncoder().encode(changes))
        return try await changeNotify(.init(scope: scope == .global ? .value1 : .value0, project: project,
                                             restore: restore, call: .init(project: project)))
    }

    private func changeNotify(_ params: WorkConfigSetParams) async throws -> WorkActionOutcome {
        struct Changes: Decodable { var changed: [WorkNotifyChange] }
        let data: Changes = try reply(await rpc.work.configSet(params))
        return WorkActionOutcome(ok: true, message: data.changed.isEmpty ? "The rules already match" : "Notification rules updated",
                                 changes: data.changed)
    }

    public func perform(_ action: WorkScreenAction, project: String) async throws -> WorkActionOutcome {
        let outcome: Envelope<IgnoredData>
        switch action {
        case let .accept(ref):
            outcome = try decode(await rpc.work.accept(WorkAcceptParams(refs: [ref], call: .init(project: project))))
        case let .drop(ref, why):
            outcome = try decode(await rpc.work.drop(WorkDropParams(refs: [ref], why: why, call: .init(project: project))))
        case let .finish(ref, proof):
            outcome = try decode(await rpc.work.finish(WorkFinishParams(ref: ref, proof: proof, call: .init(project: project))))
        case let .reopen(ref, why):
            outcome = try decode(await rpc.work.reopen(WorkReopenParams(ref: ref, why: why, call: .init(project: project))))
        case let .addMember(ref, handoff):
            outcome = try decode(await rpc.work.addMember(WorkAddMemberParams(refs: [ref], to: handoff, call: .init(project: project))))
        case let .unpair(ref, connector, itemProject):
            let params = WorkUnpairParams(ref: ref, connector: connector, call: .init(project: itemProject ?? project))
            let result: UnpairData = try reply(await rpc.work.unpair(params))
            let message = result.removed ? "Unpaired \(ref) from \(connector)" : "\(ref) was already unpaired from \(connector)"
            return WorkActionOutcome(ok: true, message: message)
        case let .sync(ref, itemProject):
            let params = WorkSyncParams(release: ref, call: .init(project: itemProject ?? project))
            let result: SyncData = try reply(await rpc.work.sync(params))
            if result.failed > 0 {
                return WorkActionOutcome(ok: false, message: "\(ref): \(result.pushed) pushed, \(result.failed) failed")
            }
            guard result.pushed > 0 else {
                return WorkActionOutcome(ok: false, message: "No enabled connector pushed \(ref)")
            }
            return WorkActionOutcome(ok: true, message: "Pushed \(ref) to \(Plural.count(result.pushed, "connector"))")
        }
        if let value = outcome.value {
            return value.ok
                ? WorkActionOutcome(ok: true, message: "\(action.done): \(action.ref)")
                : WorkActionOutcome(ok: false, message: value.diagnostics.first?.message ?? "The store refused it")
        }
        return WorkActionOutcome(ok: false, message: outcome.skipped.first?.reason ?? "The work service could not run it")
    }

    public func changes() -> AsyncStream<Void> {
        let rpc = rpc
        let wal = walPath
        let directory = (wal as NSString).deletingLastPathComponent
        let config = (directory as NSString).appendingPathComponent("config.json")
        return AsyncStream { continuation in
            // A write through the service sends `work.changed`; a write of the CLI or the MCP tools only touches the
            // store's WAL file, which every write changes (a write after a checkpoint creates it again).
            let events = Task { @MainActor in
                // The event stream ends, with an error, when the service connection closes; the screen then reads as stopped.
                do {
                    for try await _ in rpc.events.workChanged { continuation.yield(()) }
                } catch {
                    workSourceLog.notice("work.changed ended: \(error.localizedDescription, privacy: .public)")
                }
                continuation.finish()
            }
            let watcher = DirectoryWatcher(paths: [directory], latency: 0.3,
                                           accepts: { $0 == wal || $0 == config }) { _ in continuation.yield(()) }
            continuation.onTermination = { _ in
                events.cancel()
                watcher.stop()
            }
        }
    }

    // MARK: Decoding

    private struct Diagnostic: Decodable { var message: String }
    private struct Skipped: Decodable { var reason: String }
    private struct Reply<D: Decodable>: Decodable {
        var ok: Bool
        var data: D?
        var diagnostics: [Diagnostic]
    }
    private struct Envelope<D: Decodable>: Decodable {
        var status: String
        var value: Reply<D>?
        var skipped: [Skipped]
    }
    private struct IgnoredData: Decodable {}
    private struct UnpairData: Decodable { var removed: Bool }
    private struct SyncData: Decodable { var pushed: Int; var failed: Int }
    private struct TreeData: Decodable { var containers: [WorkContainerValue] }
    private struct ConfigData: Decodable {
        struct Row: Decodable {
            struct Notify: Decodable {
                struct Resolved: Decodable {
                    struct Layer: Decodable { var layer: String; var value: String?; var wildcard: Bool?; var rule: WorkNotifyRule?; var fallback: String? }
                    var level: String
                    var from: String
                    var layers: [Layer]
                    var minSeverity: String?
                    var repoPath: String?
                    var builtInLevel: String?
                }
                var action: String
                var resolved: Resolved
                var editor: Resolved?
            }
            var type: String
            var notify: [Notify]
        }
        var rows: [Row]
    }

    private nonisolated func decode<D: Decodable, E: Encodable>(_ result: E) throws -> Envelope<D> {
        try JSONDecoder().decode(Envelope<D>.self, from: JSONEncoder().encode(result))
    }

    private nonisolated func reply<D: Decodable, E: Encodable>(_ result: E) throws -> D {
        let outcome: Envelope<D> = try decode(result)
        guard let value = outcome.value else {
            throw WorkSourceError(outcome.skipped.first?.reason ?? "The work service could not answer")
        }
        guard value.ok, let data = value.data else {
            throw WorkSourceError(value.diagnostics.first?.message ?? "The store refused the read")
        }
        return data
    }
}
