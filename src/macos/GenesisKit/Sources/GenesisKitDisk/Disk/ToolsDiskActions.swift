import Foundation
import GenesisKit

// The JSON of the commands that change the disk: `tools doctor act` (`--json` and `--ndjson`) and the clones apply
// and rollback output with its error envelope. camelCase keys, like the rest of `doctor` and `clones`. Contract
// fixtures: Sources/GenesisKitFixtures/Disk/contract-doctor-act-*, contract-clones-*.

/// How a doctor action removes a path: `trash` (frees nothing until the Trash is emptied) or `delete`.
public enum DoctorActMethod: String, Codable, Equatable, Sendable {
    case trash
    case delete
}

extension KeyedDecodingContainer {
    /// A method this build does not know (a newer CLI) reads as nil, so it does not fail the whole act result or
    /// plan. The decoders of the optional `method` fields pick this overload.
    func decodeIfPresent(_ type: DoctorActMethod.Type, forKey key: Key) throws -> DoctorActMethod? {
        guard let raw = try? decodeIfPresent(String.self, forKey: key) else { return nil }
        return DoctorActMethod(rawValue: raw)
    }
}

/// A fix a finding offers (`tools doctor --json`, `findings[].actions`).
public struct DoctorActionInfo: Codable, Equatable, Identifiable, Sendable {
    public var id: String
    public var label: String
    /// `yesno` (pass `--yes`), `typed` (pass `--confirm <phrase>`) or `none`.
    public var confirm: String?
    /// True when the action moves to the Trash instead of deleting.
    public var staged: Bool?
    /// `remove-path` or `command`.
    public var kind: String?
    /// False when the action exists but cannot run on this finding.
    public var actable: Bool?
    /// The exact phrase a `typed` confirmation needs (`DELETE`, `yes, trash`), so the UI can ask for it before a
    /// dry run.
    public var confirmPhrase: String?
    /// The method this action removes with, when it has one fixed.
    public var method: DoctorActMethod?

    public init(id: String, label: String, confirm: String? = nil, staged: Bool? = nil, kind: String? = nil,
                actable: Bool? = nil, confirmPhrase: String? = nil, method: DoctorActMethod? = nil) {
        self.confirmPhrase = confirmPhrase
        self.method = method
        self.id = id
        self.label = label
        self.confirm = confirm
        self.staged = staged
        self.kind = kind
        self.actable = actable
    }
}

/// Why `tools doctor` skipped its walking analyzers: free space under the floor or a hot `fseventsd`.
public struct DoctorScanGate: Codable, Equatable, Sendable {
    public var gated: Bool
    public var reasons: [String]
    public var availableBytes: Int64?
    public var floorBytes: Int64?
    public var fseventsdRssBytes: Int64?
    public var fseventsdLimitBytes: Int64?

    public init(gated: Bool, reasons: [String] = [], availableBytes: Int64? = nil, floorBytes: Int64? = nil,
                fseventsdRssBytes: Int64? = nil, fseventsdLimitBytes: Int64? = nil) {
        self.gated = gated
        self.reasons = reasons
        self.availableBytes = availableBytes
        self.floorBytes = floorBytes
        self.fseventsdRssBytes = fseventsdRssBytes
        self.fseventsdLimitBytes = fseventsdLimitBytes
    }
}

/// The volume around an act: free space before and after, and why the delta may still grow.
public struct DoctorActVolume: Codable, Equatable, Sendable {
    public var path: String?
    public var availableBefore: Int64?
    public var availableAfter: Int64?
    public var totalBefore: Int64?
    public var deltaBytes: Int64?
    public var settleNote: String?

    public init(path: String? = nil, availableBefore: Int64? = nil, availableAfter: Int64? = nil,
                totalBefore: Int64? = nil, deltaBytes: Int64? = nil, settleNote: String? = nil) {
        self.path = path
        self.availableBefore = availableBefore
        self.availableAfter = availableAfter
        self.totalBefore = totalBefore
        self.deltaBytes = deltaBytes
        self.settleNote = settleNote
    }
}

/// What happened to one finding.
public struct DoctorActItem: Codable, Equatable, Identifiable, Sendable {
    public var findingId: String
    /// `ok`, `staged` (in the Trash), `skipped` (dry run), `failed` or `refused`.
    public var status: String
    /// For `refused`: `blocked`, `confirm-required`, `outside-allowlist`, …
    public var reason: String?
    public var severity: DoctorSeverity
    public var paths: [String]
    public var estimatedBytes: Int64?
    public var remeasuredBytes: Int64?
    /// `yes`, `no` or `later`.
    public var freesNow: String?
    /// How to undo it, when possible ("Finder: Put Back from the Trash").
    public var restore: String?
    public var trashPaths: [String]?
    public var blacklistReason: String?
    /// For `confirm-required`: `yesno` or `typed`, and the phrase a typed confirmation expects.
    public var requiredConfirm: String?
    public var expectedPhrase: String?
    public var error: String?

    public var id: String { findingId }

    public init(findingId: String, status: String, reason: String? = nil, severity: DoctorSeverity, paths: [String],
                estimatedBytes: Int64? = nil, remeasuredBytes: Int64? = nil, freesNow: String? = nil,
                restore: String? = nil, trashPaths: [String]? = nil, blacklistReason: String? = nil,
                requiredConfirm: String? = nil, expectedPhrase: String? = nil, error: String? = nil) {
        self.findingId = findingId
        self.status = status
        self.reason = reason
        self.severity = severity
        self.paths = paths
        self.estimatedBytes = estimatedBytes
        self.remeasuredBytes = remeasuredBytes
        self.freesNow = freesNow
        self.restore = restore
        self.trashPaths = trashPaths
        self.blacklistReason = blacklistReason
        self.requiredConfirm = requiredConfirm
        self.expectedPhrase = expectedPhrase
        self.error = error
    }
}

public struct DoctorActTotals: Codable, Equatable, Sendable {
    public var requested: Int
    public var ok: Int
    public var staged: Int
    public var skipped: Int
    public var failed: Int
    public var refused: Int
    public var estimatedBytes: Int64
    public var remeasuredBytes: Int64

    public init(requested: Int, ok: Int, staged: Int, skipped: Int, failed: Int, refused: Int, estimatedBytes: Int64,
                remeasuredBytes: Int64) {
        self.requested = requested
        self.ok = ok
        self.staged = staged
        self.skipped = skipped
        self.failed = failed
        self.refused = refused
        self.estimatedBytes = estimatedBytes
        self.remeasuredBytes = remeasuredBytes
    }
}

/// `tools doctor act <actionId> --analyzer <id> --id <finding>… --method trash|delete --json`, and the `result` of
/// `--ndjson`. A dry run (`dryRun`) changes nothing and writes no manifest.
public struct DoctorActResult: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var runId: String
    public var analyzerId: String
    public var actionId: String
    public var method: DoctorActMethod?
    public var dryRun: Bool
    public var startedAt: String
    public var endedAt: String
    public var volume: DoctorActVolume
    /// The JSON-lines manifest of what was removed; nil for a dry run or when nothing ran.
    public var manifestPath: String?
    public var items: [DoctorActItem]
    public var totals: DoctorActTotals
    public var followUps: [DoctorJSONValue]

    public init(schemaVersion: Int, runId: String, analyzerId: String, actionId: String, method: DoctorActMethod?,
                dryRun: Bool, startedAt: String, endedAt: String, volume: DoctorActVolume, manifestPath: String?,
                items: [DoctorActItem], totals: DoctorActTotals, followUps: [DoctorJSONValue] = []) {
        self.schemaVersion = schemaVersion
        self.runId = runId
        self.analyzerId = analyzerId
        self.actionId = actionId
        self.method = method
        self.dryRun = dryRun
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.volume = volume
        self.manifestPath = manifestPath
        self.items = items
        self.totals = totals
        self.followUps = followUps
    }
}

/// One line of `tools doctor act … --ndjson`: the plan, each item's start and end, the volume after, the result.
public enum DoctorActEvent: Equatable, Sendable {
    public struct PlanPath: Codable, Equatable, Sendable {
        public var path: String
        public var kind: String?
        public var allocatedBytes: Int64?
        public var apparentBytes: Int64?
        public var mtime: String?
        public var entries: Int64?

        public init(path: String, kind: String? = nil, allocatedBytes: Int64? = nil, apparentBytes: Int64? = nil,
                    mtime: String? = nil, entries: Int64? = nil) {
            self.path = path
            self.kind = kind
            self.allocatedBytes = allocatedBytes
            self.apparentBytes = apparentBytes
            self.mtime = mtime
            self.entries = entries
        }
    }

    public struct PlanItem: Codable, Equatable, Sendable {
        public var findingId: String
        public var severity: DoctorSeverity
        public var title: String?
        public var paths: [PlanPath]
        public var confirmedWith: String?
        public var restore: String?

        public init(findingId: String, severity: DoctorSeverity, title: String? = nil, paths: [PlanPath],
                    confirmedWith: String? = nil, restore: String? = nil) {
            self.findingId = findingId
            self.severity = severity
            self.title = title
            self.paths = paths
            self.confirmedWith = confirmedWith
            self.restore = restore
        }
    }

    public struct Plan: Codable, Equatable, Sendable {
        public var schemaVersion: Int?
        public var runId: String
        public var at: String?
        public var argv: [String]?
        public var analyzerId: String
        public var actionId: String
        public var method: DoctorActMethod?
        public var dryRun: Bool
        public var volume: DoctorActVolume?
        public var items: [PlanItem]
        public var refused: [DoctorActItem]

        public init(schemaVersion: Int? = nil, runId: String, at: String? = nil, argv: [String]? = nil,
                    analyzerId: String, actionId: String, method: DoctorActMethod? = nil, dryRun: Bool,
                    volume: DoctorActVolume? = nil, items: [PlanItem], refused: [DoctorActItem]) {
            self.schemaVersion = schemaVersion
            self.runId = runId
            self.at = at
            self.argv = argv
            self.analyzerId = analyzerId
            self.actionId = actionId
            self.method = method
            self.dryRun = dryRun
            self.volume = volume
            self.items = items
            self.refused = refused
        }
    }

    public struct ItemDone: Codable, Equatable, Sendable {
        public var findingId: String
        public var status: String
        public var error: String?
        public var trashPaths: [String]?
        public var at: String?

        public init(findingId: String, status: String, error: String? = nil, trashPaths: [String]? = nil,
                    at: String? = nil) {
            self.findingId = findingId
            self.status = status
            self.error = error
            self.trashPaths = trashPaths
            self.at = at
        }
    }

    case plan(Plan)
    case itemStarted(findingId: String)
    case itemDone(ItemDone)
    case volumeAfter(availableAfter: Int64?)
    case result(DoctorActResult)
    /// A line with a type this build does not know.
    case other(String)
    /// A line of a known type that did not decode (a contract change): `detail` says which key. After a `result`
    /// line that did not decode, read what was removed from the run's manifest; do not wait for `.result`.
    case undecodable(type: String, detail: String)

    private struct Envelope: Decodable {
        var type: String
        var findingId: String?
        var availableAfter: Int64?
    }

    private struct ResultLine: Decodable {
        var result: DoctorActResult
    }

    /// nil for a line that is not JSON.
    public static func parse(line: String) -> DoctorActEvent? {
        let data = Data(line.utf8)
        let decoder = JSONDecoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        do {
            switch envelope.type {
            case "plan": return .plan(try decoder.decode(Plan.self, from: data))
            case "item-start": return envelope.findingId.map { .itemStarted(findingId: $0) } ?? .other(envelope.type)
            case "item-done": return .itemDone(try decoder.decode(ItemDone.self, from: data))
            case "volume-after": return .volumeAfter(availableAfter: envelope.availableAfter)
            case "result": return .result(try decoder.decode(ResultLine.self, from: data).result)
            default: return .other(envelope.type)
            }
        } catch {
            return .undecodable(type: envelope.type, detail: DuIndexJSON.describe(error))
        }
    }
}

/// One file operation of a clones apply or rollback.
public struct ClonesApplyOp: Codable, Equatable, Sendable {
    public var seq: Int
    public var ts: String?
    /// `clone`, `skip`, `unshare`, …
    public var op: String
    /// `ok`, `already-cloned`, `changed`, `error`, …
    public var status: String
    public var bytes: Int64?
    public var keep: String?
    public var replace: String?
    public var modeBefore: Int?
    public var mtimeBeforeMs: Double?
    public var sha256Before: String?
    public var sha256After: String?
    public var privateBytes: Int64?
    public var error: String?

    public init(seq: Int, ts: String? = nil, op: String, status: String, bytes: Int64? = nil, keep: String? = nil,
                replace: String? = nil, modeBefore: Int? = nil, mtimeBeforeMs: Double? = nil, sha256Before: String? = nil,
                sha256After: String? = nil, privateBytes: Int64? = nil, error: String? = nil) {
        self.seq = seq
        self.ts = ts
        self.op = op
        self.status = status
        self.bytes = bytes
        self.keep = keep
        self.replace = replace
        self.modeBefore = modeBefore
        self.mtimeBeforeMs = mtimeBeforeMs
        self.sha256Before = sha256Before
        self.sha256After = sha256After
        self.privateBytes = privateBytes
        self.error = error
    }
}

public struct ClonesApplyTotals: Codable, Equatable, Sendable {
    public var cloned: Int
    public var skipped: Int
    public var errors: Int
    public var bytesReclaimed: Int64

    public init(cloned: Int, skipped: Int, errors: Int, bytesReclaimed: Int64) {
        self.cloned = cloned
        self.skipped = skipped
        self.errors = errors
        self.bytesReclaimed = bytesReclaimed
    }
}

public struct ClonesFreeBytes: Codable, Equatable, Sendable {
    public var before: Int64?
    public var after: Int64?

    public init(before: Int64?, after: Int64?) {
        self.before = before
        self.after = after
    }
}

public struct ClonesPlanCache: Codable, Equatable, Sendable {
    public var hit: Bool
    public var ageMs: Double?

    public init(hit: Bool, ageMs: Double?) {
        self.hit = hit
        self.ageMs = ageMs
    }
}

public struct ClonesApplyPlanTotals: Codable, Equatable, Sendable {
    public var runId: String?
    public var totalReclaimable: Int64?
    public var totalFreeable: Int64?
    public var totalFreeableUpTo: Int64?
    public var sets: Int?

    public init(runId: String?, totalReclaimable: Int64?, totalFreeable: Int64?, totalFreeableUpTo: Int64?,
                sets: Int?) {
        self.runId = runId
        self.totalReclaimable = totalReclaimable
        self.totalFreeable = totalFreeable
        self.totalFreeableUpTo = totalFreeableUpTo
        self.sets = sets
    }
}

/// The JSON of `tools macos clones reclaim apply` and `clones optimize --apply|--rollback` with `--format json`:
/// the process record. `state` is `applied` in the frozen contract; other runs (a rollback, a partial apply) carry
/// their own value, so it stays a string.
public struct ClonesApplyResult: Codable, Equatable, Identifiable, Sendable {
    /// The process id a rollback names (`--process <id>`).
    public var id: String
    public var state: String
    public var roots: [String]
    public var startedAt: String?
    public var endedAt: String?
    public var planCache: ClonesPlanCache?
    public var ops: [ClonesApplyOp]
    public var totals: ClonesApplyTotals
    public var freeBytes: ClonesFreeBytes?
    public var plan: ClonesApplyPlanTotals?

    public init(id: String, state: String, roots: [String], startedAt: String? = nil, endedAt: String? = nil,
                planCache: ClonesPlanCache? = nil, ops: [ClonesApplyOp], totals: ClonesApplyTotals,
                freeBytes: ClonesFreeBytes? = nil, plan: ClonesApplyPlanTotals? = nil) {
        self.id = id
        self.state = state
        self.roots = roots
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.planCache = planCache
        self.ops = ops
        self.totals = totals
        self.freeBytes = freeBytes
        self.plan = plan
    }
}

/// `{"error": {...}}` that a clones command prints with `--format json` instead of its result.
public struct ClonesCommandError: Codable, Equatable, Error, Sendable {
    /// `rollback-space`, `locked`, `not-found`, …
    public var kind: String
    public var message: String
    public var command: String?
    public var processId: String?
    public var required: Int64?
    public var available: Int64?
    /// `unknown-process`: the recorded process ids nearest the one asked for.
    public var closest: [String]?
    /// `unknown-preset`: the preset asked for and the saved ones.
    public var presetId: String?
    public var known: [String]?

    public init(kind: String, message: String, command: String? = nil, processId: String? = nil, required: Int64? = nil,
                available: Int64? = nil, closest: [String]? = nil, presetId: String? = nil, known: [String]? = nil) {
        self.closest = closest
        self.presetId = presetId
        self.known = known
        self.kind = kind
        self.message = message
        self.command = command
        self.processId = processId
        self.required = required
        self.available = available
    }

    private struct Envelope: Decodable {
        var error: ClonesCommandError
    }

    /// The error when `data` is an error envelope, else nil.
    public static func from(_ data: Data) -> ClonesCommandError? {
        try? JSONDecoder().decode(Envelope.self, from: data).error
    }
}

/// `tools macos clones reclaim apply --format json`: the clone run, or the plan when it found nothing to clone (the
/// CLI then prints the plan, told apart by its missing `ops`).
public enum ClonesReclaimApplyOutcome: Equatable, Sendable {
    case applied(ClonesApplyResult)
    case nothingToApply(ClonesReclaimPlan)
}

/// A saved reclaim selector (`tools macos clones reclaim presets`, `src/macos/lib/clones/presets.ts`).
public struct ClonesPreset: Codable, Equatable, Identifiable, Sendable {
    /// The limits of a plan the daily scan task runs on its own.
    public struct Auto: Codable, Equatable, Sendable {
        public var enabled: Bool
        public var maxBytes: Int64
        public var maxFiles: Int
        /// When the scan task first ran the plan as a dry run; until then it only reports.
        public var dryRunAt: String?

        public init(enabled: Bool, maxBytes: Int64, maxFiles: Int, dryRunAt: String? = nil) {
            self.enabled = enabled
            self.maxBytes = maxBytes
            self.maxFiles = maxFiles
            self.dryRunAt = dryRunAt
        }
    }

    public var id: String
    public var dirs: [String]
    public var worktreesOf: String?
    public var targets: [String]
    public var exclude: [String]
    public var minReal: Int64
    public var keepPartners: [ClonesKeepPartnerID]
    public var rewriteStores: [ClonesKeepPartnerID]?
    public var keepUnfreeable: Bool?
    public var createdAt: String
    public var lastRunAt: String?
    public var lastReclaimable: Int64?
    public var auto: Auto?

    public init(id: String, dirs: [String], worktreesOf: String? = nil, targets: [String], exclude: [String] = [],
                minReal: Int64, keepPartners: [ClonesKeepPartnerID] = [], rewriteStores: [ClonesKeepPartnerID]? = nil,
                keepUnfreeable: Bool? = nil, createdAt: String, lastRunAt: String? = nil, lastReclaimable: Int64? = nil,
                auto: Auto? = nil) {
        self.id = id
        self.dirs = dirs
        self.worktreesOf = worktreesOf
        self.targets = targets
        self.exclude = exclude
        self.minReal = minReal
        self.keepPartners = keepPartners
        self.rewriteStores = rewriteStores
        self.keepUnfreeable = keepUnfreeable
        self.createdAt = createdAt
        self.lastRunAt = lastRunAt
        self.lastReclaimable = lastReclaimable
        self.auto = auto
    }
}

/// The two daily clone tasks (`clones-scan`, `clones-prune`).
public struct ClonesDaemonTaskFlags: Codable, Equatable, Sendable {
    public var scan: Bool
    public var prune: Bool

    public init(scan: Bool, prune: Bool) {
        self.scan = scan
        self.prune = prune
    }
}

/// `tools macos clones daemon enable|disable --json`: what the call changed and the state after it.
public struct ClonesDaemonChange: Codable, Equatable, Sendable {
    public var enabled: Bool
    /// `enable`: the tasks this call registered (false for one that was already there).
    public var newlyRegistered: ClonesDaemonTaskFlags?
    /// `disable`: the tasks this call removed.
    public var removed: ClonesDaemonTaskFlags?
    /// The registered tasks after the call.
    public var registered: ClonesDaemonTaskFlags

    public init(enabled: Bool, newlyRegistered: ClonesDaemonTaskFlags? = nil, removed: ClonesDaemonTaskFlags? = nil,
                registered: ClonesDaemonTaskFlags) {
        self.enabled = enabled
        self.newlyRegistered = newlyRegistered
        self.removed = removed
        self.registered = registered
    }
}

/// One registered clone task with its effective settings (`tools daemon` task fields).
public struct ClonesDaemonTask: Codable, Equatable, Sendable {
    public struct MissedRun: Codable, Equatable, Sendable {
        /// `asap`, `on-wake`, `retry-at` or `skip`.
        public var mode: String
        public var times: [String]?

        public init(mode: String, times: [String]? = nil) {
            self.mode = mode
            self.times = times
        }
    }

    public var name: String
    public var command: String?
    public var every: String?
    /// `every` in words.
    public var schedule: String?
    public var enabled: Bool?
    public var retries: Int?
    public var description: String?
    public var timeoutMs: Int64?
    /// `true`, `false` or `"failure"`.
    public var notify: DoctorJSONValue?
    public var priority: String?
    public var missedRun: MissedRun?

    public init(name: String, command: String? = nil, every: String? = nil, schedule: String? = nil,
                enabled: Bool? = nil, retries: Int? = nil, description: String? = nil, timeoutMs: Int64? = nil,
                notify: DoctorJSONValue? = nil, priority: String? = nil, missedRun: MissedRun? = nil) {
        self.name = name
        self.command = command
        self.every = every
        self.schedule = schedule
        self.enabled = enabled
        self.retries = retries
        self.description = description
        self.timeoutMs = timeoutMs
        self.notify = notify
        self.priority = priority
        self.missedRun = missedRun
    }
}

/// `tools macos clones daemon status --json`.
public struct ClonesDaemonStatus: Codable, Equatable, Sendable {
    /// The `tools daemon` launchd agent.
    public struct Daemon: Codable, Equatable, Sendable {
        public var installed: Bool
        public var running: Bool
        public var pid: Int?
        public var needsMigration: Bool?

        public init(installed: Bool, running: Bool, pid: Int? = nil, needsMigration: Bool? = nil) {
            self.installed = installed
            self.running = running
            self.pid = pid
            self.needsMigration = needsMigration
        }
    }

    /// False after `daemon disable`: a finished plan no longer registers the tasks.
    public var enabled: Bool
    public var daemon: Daemon
    public var tasks: [ClonesDaemonTask]
    public var registered: ClonesDaemonTaskFlags

    public init(enabled: Bool, daemon: Daemon, tasks: [ClonesDaemonTask], registered: ClonesDaemonTaskFlags) {
        self.enabled = enabled
        self.daemon = daemon
        self.tasks = tasks
        self.registered = registered
    }
}

/// `tools macos clones config` (non-interactive): the watched folders and the scan defaults.
public struct ClonesConfig: Codable, Equatable, Sendable {
    public var watchedDirs: [String]
    public var minReal: Int64?
    public var exclude: [String]?
    public var nodeModules: Bool?
    /// False after `daemon disable`.
    public var daemon: Bool?

    public init(watchedDirs: [String], minReal: Int64? = nil, exclude: [String]? = nil, nodeModules: Bool? = nil,
                daemon: Bool? = nil) {
        self.watchedDirs = watchedDirs
        self.minReal = minReal
        self.exclude = exclude
        self.nodeModules = nodeModules
        self.daemon = daemon
    }
}
