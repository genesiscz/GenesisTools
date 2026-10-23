import Foundation
import GenesisKit

// The JSON of `tools du index build|update|query|diff|schedule --format json|ndjson` (schema version 1). The CLI
// writes snake_case keys; `ToolsDiskProvider.decodeIndex` decodes them with `.convertFromSnakeCase`, so every
// property here is the camelCase form. Contract fixtures: Sources/GenesisKitFixtures/Disk/contract-du-index-*.

/// Bits of `dirs.flags`.
public struct DuIndexDirFlags: OptionSet, Codable, Hashable, Sendable {
    public let rawValue: Int

    public init(rawValue: Int) {
        self.rawValue = rawValue
    }

    /// The folder could not be read (EPERM or EACCES).
    public static let denied = DuIndexDirFlags(rawValue: 1)
    /// The listing stopped early (an error, an entry budget).
    public static let incomplete = DuIndexDirFlags(rawValue: 2)
    /// A cloud root that was not walked.
    public static let cloudSkipped = DuIndexDirFlags(rawValue: 4)
    /// Another volume mounted here, not walked.
    public static let mountSkipped = DuIndexDirFlags(rawValue: 8)
    /// The folder is gone (a tombstone until the next build).
    public static let gone = DuIndexDirFlags(rawValue: 16)
    /// The walk gave the folder up after it made no progress for the stall limit (usually a macOS privacy prompt);
    /// its totals are missing.
    public static let blocked = DuIndexDirFlags(rawValue: 32)
    /// The flags that need the user's attention: a folder with one carries no bytes, so a listing shows it whatever
    /// its size and the limit.
    public static let attention: DuIndexDirFlags = [.denied, .incomplete, .cloudSkipped, .mountSkipped, .blocked]
}

/// Which scan an answer reflects.
public struct DuIndexAsOf: Codable, Equatable, Sendable {
    public var scanId: Int64
    /// `build` or `update`.
    public var kind: String
    public var status: String?
    public var finishedAtMs: Int64?
    public var ageS: Int64?
    public var lastBuildScanId: Int64?
    public var lastBuildAtMs: Int64?

    public init(scanId: Int64, kind: String, status: String? = nil, finishedAtMs: Int64? = nil, ageS: Int64? = nil,
                lastBuildScanId: Int64? = nil, lastBuildAtMs: Int64? = nil) {
        self.scanId = scanId
        self.kind = kind
        self.status = status
        self.finishedAtMs = finishedAtMs
        self.ageS = ageS
        self.lastBuildScanId = lastBuildScanId
        self.lastBuildAtMs = lastBuildAtMs
    }
}

/// One stored folder. Sizes include everything below it; `privateBytes` is the unshared part (nil when the build
/// skipped it).
public struct DuIndexNode: Codable, Equatable, Identifiable, Sendable {
    public var id: Int64
    public var parentId: Int64
    public var name: String
    /// Absolute path; the reader fills it when it knows the parent's path.
    public var path: String?
    public var allocBytes: Int64
    public var logicalBytes: Int64
    public var privateBytes: Int64?
    public var files: Int64
    public var dirs: Int64
    public var maxFileBytes: Int64
    public var newestMtimeS: Int64
    public var dirMtimeMs: Int64
    public var flags: DuIndexDirFlags
    public var scanId: Int64
    /// How many children are stored rows (the rest are folded into this one).
    public var storedChildren: Int64?
    /// This child's part of its parent, 0...1 (`query --children`).
    public var share: Double?
    /// Bytes in this folder itself plus its folded subfolders (`query --largest dirs`).
    public var localAllocBytes: Int64?

    public init(id: Int64, parentId: Int64, name: String, path: String? = nil, allocBytes: Int64, logicalBytes: Int64,
                privateBytes: Int64? = nil, files: Int64, dirs: Int64, maxFileBytes: Int64, newestMtimeS: Int64,
                dirMtimeMs: Int64, flags: DuIndexDirFlags = [], scanId: Int64, storedChildren: Int64? = nil,
                share: Double? = nil, localAllocBytes: Int64? = nil) {
        self.id = id
        self.parentId = parentId
        self.name = name
        self.path = path
        self.allocBytes = allocBytes
        self.logicalBytes = logicalBytes
        self.privateBytes = privateBytes
        self.files = files
        self.dirs = dirs
        self.maxFileBytes = maxFileBytes
        self.newestMtimeS = newestMtimeS
        self.dirMtimeMs = dirMtimeMs
        self.flags = flags
        self.scanId = scanId
        self.storedChildren = storedChildren
        self.share = share
        self.localAllocBytes = localAllocBytes
    }
}

/// The part of a folder not in its stored children: its own files plus its folded subfolders.
public struct DuIndexLocal: Codable, Equatable, Sendable {
    public var allocBytes: Int64
    public var logicalBytes: Int64
    public var privateBytes: Int64?
    public var files: Int64
    public var dirs: Int64

    public init(allocBytes: Int64, logicalBytes: Int64, privateBytes: Int64? = nil, files: Int64, dirs: Int64) {
        self.allocBytes = allocBytes
        self.logicalBytes = logicalBytes
        self.privateBytes = privateBytes
        self.files = files
        self.dirs = dirs
    }
}

/// A file over the index's big-file floor.
public struct DuIndexFile: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    public var logicalBytes: Int64
    public var allocBytes: Int64
    public var mtimeMs: Int64
    public var nlink: Int64
    public var dirId: Int64?

    public var id: String { path }

    public init(path: String, logicalBytes: Int64, allocBytes: Int64, mtimeMs: Int64, nlink: Int64,
                dirId: Int64? = nil) {
        self.path = path
        self.logicalBytes = logicalBytes
        self.allocBytes = allocBytes
        self.mtimeMs = mtimeMs
        self.nlink = nlink
        self.dirId = dirId
    }
}

/// `tools du index query --path <p> --format json`. `found` is false for a path inside a folded region: then
/// `reason`, `foldedIn` (the stored ancestor) and `hint` (a `clonesize` command that measures it) are set.
public struct DuIndexQueryResult: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var found: Bool
    public var asOf: DuIndexAsOf?
    public var root: String?
    public var path: String?
    public var node: DuIndexNode?
    public var local: DuIndexLocal?
    public var children: [DuIndexNode]?
    public var topFiles: [DuIndexFile]?
    public var truncated: Bool?
    public var reason: String?
    public var foldedIn: String?
    public var hint: String?
    /// Blocked folders (flag 32) at or under `path`, whose totals are missing. The children list always carries a
    /// flagged child, whatever `--min-bytes` and `--limit` say.
    public var blockedBelow: Int64?

    public init(schemaVersion: Int, found: Bool, asOf: DuIndexAsOf? = nil, root: String? = nil, path: String? = nil,
                node: DuIndexNode? = nil, local: DuIndexLocal? = nil, children: [DuIndexNode]? = nil,
                topFiles: [DuIndexFile]? = nil, truncated: Bool? = nil, reason: String? = nil,
                foldedIn: String? = nil, hint: String? = nil, blockedBelow: Int64? = nil) {
        self.blockedBelow = blockedBelow
        self.schemaVersion = schemaVersion
        self.found = found
        self.asOf = asOf
        self.root = root
        self.path = path
        self.node = node
        self.local = local
        self.children = children
        self.topFiles = topFiles
        self.truncated = truncated
        self.reason = reason
        self.foldedIn = foldedIn
        self.hint = hint
    }
}

/// `tools du index query --largest dirs|files --format json`: one of `dirs` and `files` is filled.
public struct DuIndexLargestResult: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var asOf: DuIndexAsOf?
    public var root: String?
    /// `dirs` or `files`.
    public var largest: String
    public var dirs: [DuIndexNode]
    public var files: [DuIndexFile]
    public var truncated: Bool

    public init(schemaVersion: Int, asOf: DuIndexAsOf?, root: String?, largest: String, dirs: [DuIndexNode],
                files: [DuIndexFile], truncated: Bool) {
        self.schemaVersion = schemaVersion
        self.asOf = asOf
        self.root = root
        self.largest = largest
        self.dirs = dirs
        self.files = files
        self.truncated = truncated
    }

    enum CodingKeys: String, CodingKey {
        case schemaVersion, asOf, root, largest, rows, truncated, dirs, files
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        asOf = try container.decodeIfPresent(DuIndexAsOf.self, forKey: .asOf)
        root = try container.decodeIfPresent(String.self, forKey: .root)
        largest = try container.decode(String.self, forKey: .largest)
        truncated = try container.decodeIfPresent(Bool.self, forKey: .truncated) ?? false
        if largest == "files" {
            files = try container.decodeIfPresent([DuIndexFile].self, forKey: .rows) ?? []
            dirs = []
        } else {
            dirs = try container.decodeIfPresent([DuIndexNode].self, forKey: .rows) ?? []
            files = []
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encodeIfPresent(asOf, forKey: .asOf)
        try container.encodeIfPresent(root, forKey: .root)
        try container.encode(largest, forKey: .largest)
        try container.encode(truncated, forKey: .truncated)
        if largest == "files" {
            try container.encode(files, forKey: .rows)
        } else {
            try container.encode(dirs, forKey: .rows)
        }
    }
}

/// The `meta` table, as `query --info` prints it (every value is text).
public struct DuIndexMeta: Codable, Equatable, Sendable {
    public var schemaVersion: String?
    public var toolVersion: String?
    public var createdAtMs: String?
    public var root: String?
    public var volumeFsid: String?
    /// `1` when private bytes were measured.
    public var `private`: String?
    public var minDirBytes: String?
    public var bigFileFloor: String?
    public var snapshotFloor: String?
    public var lastBuildScanId: String?
    public var lastUpdateScanId: String?
    public var fseventsDeviceUuid: String?
    public var fseventsLastId: String?
    /// Folders the last walk gave up on (a count, as text like every meta value).
    public var blockedDirs: String?

    public init(schemaVersion: String? = nil, toolVersion: String? = nil, createdAtMs: String? = nil, root: String? = nil,
                volumeFsid: String? = nil, private: String? = nil, minDirBytes: String? = nil, bigFileFloor: String? = nil,
                snapshotFloor: String? = nil, lastBuildScanId: String? = nil, lastUpdateScanId: String? = nil,
                fseventsDeviceUuid: String? = nil, fseventsLastId: String? = nil, blockedDirs: String? = nil) {
        self.blockedDirs = blockedDirs
        self.schemaVersion = schemaVersion
        self.toolVersion = toolVersion
        self.createdAtMs = createdAtMs
        self.root = root
        self.volumeFsid = volumeFsid
        self.private = `private`
        self.minDirBytes = minDirBytes
        self.bigFileFloor = bigFileFloor
        self.snapshotFloor = snapshotFloor
        self.lastBuildScanId = lastBuildScanId
        self.lastUpdateScanId = lastUpdateScanId
        self.fseventsDeviceUuid = fseventsDeviceUuid
        self.fseventsLastId = fseventsLastId
    }
}

public struct DuIndexCounts: Codable, Equatable, Sendable {
    public var dirs: Int64
    public var tombstones: Int64
    public var bigFiles: Int64
    public var snapshots: Int64
    public var snapshotDirs: Int64
    public var dirtyQueue: Int64
    /// Rows with the blocked flag (not gone).
    public var blocked: Int64?

    public init(dirs: Int64, tombstones: Int64, bigFiles: Int64, snapshots: Int64, snapshotDirs: Int64,
                dirtyQueue: Int64, blocked: Int64? = nil) {
        self.blocked = blocked
        self.dirs = dirs
        self.tombstones = tombstones
        self.bigFiles = bigFiles
        self.snapshots = snapshots
        self.snapshotDirs = snapshotDirs
        self.dirtyQueue = dirtyQueue
    }
}

/// One row of the `scans` table.
public struct DuIndexScan: Codable, Equatable, Identifiable, Sendable {
    public var id: Int64
    public var kind: String
    public var status: String
    public var startedAtMs: Int64
    public var finishedAtMs: Int64?
    public var files: Int64?
    public var dirs: Int64?
    public var allocBytes: Int64?
    public var walkMs: Int64?
    public var threads: Int64?

    public init(id: Int64, kind: String, status: String, startedAtMs: Int64, finishedAtMs: Int64? = nil,
                files: Int64? = nil, dirs: Int64? = nil, allocBytes: Int64? = nil, walkMs: Int64? = nil,
                threads: Int64? = nil) {
        self.id = id
        self.kind = kind
        self.status = status
        self.startedAtMs = startedAtMs
        self.finishedAtMs = finishedAtMs
        self.files = files
        self.dirs = dirs
        self.allocBytes = allocBytes
        self.walkMs = walkMs
        self.threads = threads
    }
}

/// `tools du index query --info --format json`.
public struct DuIndexInfo: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var db: String
    public var dbBytes: Int64
    public var root: String?
    public var asOf: DuIndexAsOf?
    public var meta: DuIndexMeta
    public var counts: DuIndexCounts
    public var scans: [DuIndexScan]

    public init(schemaVersion: Int, db: String, dbBytes: Int64, root: String?, asOf: DuIndexAsOf?, meta: DuIndexMeta,
                counts: DuIndexCounts, scans: [DuIndexScan]) {
        self.schemaVersion = schemaVersion
        self.db = db
        self.dbBytes = dbBytes
        self.root = root
        self.asOf = asOf
        self.meta = meta
        self.counts = counts
        self.scans = scans
    }
}

/// One end of a diff: a snapshot, or the live tree (`live`).
public struct DuIndexDiffEnd: Codable, Equatable, Sendable {
    public var snapshotId: Int64?
    public var scanId: Int64?
    public var takenAtMs: Int64?
    public var live: Bool?

    public init(snapshotId: Int64?, scanId: Int64?, takenAtMs: Int64?, live: Bool? = nil) {
        self.snapshotId = snapshotId
        self.scanId = scanId
        self.takenAtMs = takenAtMs
        self.live = live
    }
}

public struct DuIndexDiffRow: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    /// nil when the old side is not known exactly (`approx`).
    public var before: Int64?
    /// nil when the folder fell below the storage floor or out of the index (`approx`): the CLI keeps
    /// that side unknown rather than inventing zero bytes. Required before 2026-10-23, so one such row
    /// failed the whole Radar "Fast-growing folders" card ("no value for Int64 at rows.Index 21.after").
    public var after: Int64?
    public var delta: Int64
    /// `grown`, `shrunk`, `new` or `gone`.
    public var status: String
    public var filesDelta: Int64?
    public var approx: Bool?

    public var id: String { path }

    public init(path: String, before: Int64?, after: Int64?, delta: Int64, status: String, filesDelta: Int64? = nil,
                approx: Bool? = nil) {
        self.path = path
        self.before = before
        self.after = after
        self.delta = delta
        self.status = status
        self.filesDelta = filesDelta
        self.approx = approx
    }
}

public struct DuIndexDiffTotal: Codable, Equatable, Sendable {
    public var allocBytes: Int64
    public var files: Int64?

    public init(allocBytes: Int64, files: Int64?) {
        self.allocBytes = allocBytes
        self.files = files
    }
}

/// `tools du index diff --format json`: what grew and shrank between two snapshots (folders at or above `floor`).
public struct DuIndexDiff: Codable, Equatable, Sendable {
    public var schemaVersion: Int
    public var root: String?
    public var from: DuIndexDiffEnd
    public var to: DuIndexDiffEnd
    public var floor: Int64?
    /// `leaf` drops a folder whose growth one subfolder already explains; `all` keeps every row.
    public var attribute: String?
    public var totalDelta: DuIndexDiffTotal
    public var rows: [DuIndexDiffRow]
    public var truncated: Bool?

    public init(schemaVersion: Int, root: String?, from: DuIndexDiffEnd, to: DuIndexDiffEnd, floor: Int64?,
                attribute: String?, totalDelta: DuIndexDiffTotal, rows: [DuIndexDiffRow], truncated: Bool?) {
        self.schemaVersion = schemaVersion
        self.root = root
        self.from = from
        self.to = to
        self.floor = floor
        self.attribute = attribute
        self.totalDelta = totalDelta
        self.rows = rows
        self.truncated = truncated
    }
}

/// The `result` of `tools du index build`.
public struct DuIndexBuildResult: Codable, Equatable, Sendable {
    public var command: String
    public var schemaVersion: Int
    public var scanId: Int64
    public var snapshotId: Int64?
    public var root: String
    public var db: String?
    public var threads: Int?
    public var `private`: Bool?
    public var minDirBytes: Int64?
    public var bigFileFloor: Int64?
    public var files: Int64
    public var dirs: Int64
    public var storedDirs: Int64?
    public var foldedDirs: Int64?
    public var bigFiles: Int64?
    public var allocBytes: Int64
    public var logicalBytes: Int64
    public var privateBytes: Int64?
    public var deniedDirs: Int64?
    public var vanishedDirs: Int64?
    public var readErrors: Int64?
    public var skippedCloud: [String]?
    public var skippedMounts: [String]?
    /// Folders the walk gave up on because they made no progress (usually a privacy prompt); their bytes are missing.
    public var blockedDirs: Int64?
    public var blockedPaths: [String]?
    /// Why the database was reset, when it was; free-form.
    public var reset: DoctorJSONValue?
    public var walkMs: Int64?
    public var ingestMs: Int64?
    public var elapsedMs: Int64?
    public var dbBytes: Int64?

    public init(command: String = "build", schemaVersion: Int, scanId: Int64, snapshotId: Int64? = nil, root: String,
                db: String? = nil, threads: Int? = nil, private: Bool? = nil, minDirBytes: Int64? = nil,
                bigFileFloor: Int64? = nil, files: Int64, dirs: Int64, storedDirs: Int64? = nil,
                foldedDirs: Int64? = nil, bigFiles: Int64? = nil, allocBytes: Int64, logicalBytes: Int64,
                privateBytes: Int64? = nil, deniedDirs: Int64? = nil, vanishedDirs: Int64? = nil,
                readErrors: Int64? = nil, skippedCloud: [String]? = nil, skippedMounts: [String]? = nil,
                blockedDirs: Int64? = nil, blockedPaths: [String]? = nil, reset: DoctorJSONValue? = nil, walkMs: Int64? = nil, ingestMs: Int64? = nil, elapsedMs: Int64? = nil,
                dbBytes: Int64? = nil) {
        self.command = command
        self.schemaVersion = schemaVersion
        self.scanId = scanId
        self.snapshotId = snapshotId
        self.root = root
        self.db = db
        self.threads = threads
        self.private = `private`
        self.minDirBytes = minDirBytes
        self.bigFileFloor = bigFileFloor
        self.files = files
        self.dirs = dirs
        self.storedDirs = storedDirs
        self.foldedDirs = foldedDirs
        self.bigFiles = bigFiles
        self.allocBytes = allocBytes
        self.logicalBytes = logicalBytes
        self.privateBytes = privateBytes
        self.deniedDirs = deniedDirs
        self.vanishedDirs = vanishedDirs
        self.readErrors = readErrors
        self.skippedCloud = skippedCloud
        self.skippedMounts = skippedMounts
        self.blockedDirs = blockedDirs
        self.blockedPaths = blockedPaths
        self.reset = reset
        self.walkMs = walkMs
        self.ingestMs = ingestMs
        self.elapsedMs = elapsedMs
        self.dbBytes = dbBytes
    }
}

public struct DuIndexDelta: Codable, Equatable, Sendable {
    public var allocBytes: Int64
    public var logicalBytes: Int64
    public var privateBytes: Int64?
    public var files: Int64
    public var dirs: Int64

    public init(allocBytes: Int64, logicalBytes: Int64, privateBytes: Int64?, files: Int64, dirs: Int64) {
        self.allocBytes = allocBytes
        self.logicalBytes = logicalBytes
        self.privateBytes = privateBytes
        self.files = files
        self.dirs = dirs
    }
}

/// One re-walked region of an update: the stored folder that owns the changed paths.
public struct DuIndexRegion: Codable, Equatable, Sendable {
    public var owner: String
    public var ownerId: Int64?
    public var files: Int64?
    public var dirs: Int64?
    public var kept: Int64?
    public var walkMs: Int64?
    public var delta: DuIndexDelta

    public init(owner: String, ownerId: Int64?, files: Int64?, dirs: Int64?, kept: Int64?, walkMs: Int64?,
                delta: DuIndexDelta) {
        self.owner = owner
        self.ownerId = ownerId
        self.files = files
        self.dirs = dirs
        self.kept = kept
        self.walkMs = walkMs
        self.delta = delta
    }
}

/// The `result` of `tools du index update`. `deferred` with `queued` paths means a build held the lock and the
/// paths wait in the queue.
public struct DuIndexUpdateResult: Codable, Equatable, Sendable {
    public var command: String
    public var schemaVersion: Int
    public var scanId: Int64?
    public var root: String?
    public var deferred: Bool
    public var queued: Int64
    public var regions: [DuIndexRegion]
    public var promoted: Int64?
    public var removed: Int64?
    /// Dirty paths the update did not take because they are outside the index root (another volume, an excluded path).
    public var ignored: [String]?
    public var elapsedMs: Int64?

    public init(command: String = "update", schemaVersion: Int, scanId: Int64?, root: String?, deferred: Bool,
                queued: Int64, regions: [DuIndexRegion], promoted: Int64?, removed: Int64?, ignored: [String]? = nil,
                elapsedMs: Int64?) {
        self.command = command
        self.schemaVersion = schemaVersion
        self.scanId = scanId
        self.root = root
        self.deferred = deferred
        self.queued = queued
        self.regions = regions
        self.promoted = promoted
        self.removed = removed
        self.ignored = ignored
        self.elapsedMs = elapsedMs
    }
}

/// An `error` line or document. `code` is `locked`, `schema_newer`, `volume_changed`, `walk_failed`, `aborted`,
/// `disk_low` or `inconsistent` (the index contradicts itself; rebuild it); `exitCode` is 3 for `locked`, 4 for
/// `schema_newer`, 1 for `inconsistent`.
public struct DuIndexError: Codable, Equatable, Error, Sendable {
    public var command: String?
    public var code: String
    public var message: String
    public var exitCode: Int?

    public init(command: String?, code: String, message: String, exitCode: Int?) {
        self.command = command
        self.code = code
        self.message = message
        self.exitCode = exitCode
    }
}

/// `tools du index schedule --status --format json`.
public struct DuIndexSchedule: Codable, Equatable, Sendable {
    public var task: String
    public var registered: Bool
    public var every: String?
    public var command: String?

    public init(task: String, registered: Bool, every: String?, command: String?) {
        self.task = task
        self.registered = registered
        self.every = every
        self.command = command
    }
}

/// One line of `tools du index build|update --format ndjson`, for a caller that feeds `ToolsLineStream` lines.
public enum DuIndexEvent: Equatable, Sendable {
    public struct Start: Codable, Equatable, Sendable {
        public var command: String
        public var scanId: Int64?
        public var root: String?
        public var threads: Int?
        public var startedAtMs: Int64?

        public init(command: String, scanId: Int64? = nil, root: String? = nil, threads: Int? = nil,
                    startedAtMs: Int64? = nil) {
            self.command = command
            self.scanId = scanId
            self.root = root
            self.threads = threads
            self.startedAtMs = startedAtMs
        }
    }

    public struct Progress: Codable, Equatable, Sendable {
        public var phase: String
        public var files: Int64?
        public var dirs: Int64?
        public var bytes: Int64?
        public var elapsedMs: Int64?
        public var filesPerS: Double?
        public var dir: String?

        public init(phase: String, files: Int64? = nil, dirs: Int64? = nil, bytes: Int64? = nil,
                    elapsedMs: Int64? = nil, filesPerS: Double? = nil, dir: String? = nil) {
            self.phase = phase
            self.files = files
            self.dirs = dirs
            self.bytes = bytes
            self.elapsedMs = elapsedMs
            self.filesPerS = filesPerS
            self.dir = dir
        }
    }

    public struct Phase: Codable, Equatable, Sendable {
        public var phase: String
        public var rows: Int64?
        public var elapsedMs: Int64?

        public init(phase: String, rows: Int64? = nil, elapsedMs: Int64? = nil) {
            self.phase = phase
            self.rows = rows
            self.elapsedMs = elapsedMs
        }
    }

    /// A folder the walk gave up on after it made no progress for `waitedMs` (usually a macOS privacy prompt).
    public struct Blocked: Codable, Equatable, Sendable {
        public var phase: String?
        public var path: String
        public var waitedMs: Int64?

        public init(phase: String? = nil, path: String, waitedMs: Int64? = nil) {
            self.phase = phase
            self.path = path
            self.waitedMs = waitedMs
        }
    }

    case start(Start)
    case progress(Progress)
    case phase(Phase)
    case blocked(Blocked)
    case built(DuIndexBuildResult)
    case updated(DuIndexUpdateResult)
    case failed(DuIndexError)
    /// A line with a type this build does not know.
    case other(String)
    /// A line of a known type that did not decode (a contract change): `detail` says which key. A caller that waits
    /// for `.built` or `.updated` should stop waiting on one with type `result` or `error`.
    case undecodable(type: String, detail: String)

    private struct Envelope: Decodable {
        var type: String
        var command: String?
    }

    /// nil for a line that is not JSON.
    public static func parse(line: String) -> DuIndexEvent? {
        let data = Data(line.utf8)
        let decoder = DuIndexJSON.decoder()
        guard let envelope = try? decoder.decode(Envelope.self, from: data) else { return nil }
        do {
            switch envelope.type {
            case "start": return .start(try decoder.decode(Start.self, from: data))
            case "progress": return .progress(try decoder.decode(Progress.self, from: data))
            case "phase": return .phase(try decoder.decode(Phase.self, from: data))
            case "blocked": return .blocked(try decoder.decode(Blocked.self, from: data))
            case "error": return .failed(try decoder.decode(DuIndexError.self, from: data))
            case "result":
                return envelope.command == "update"
                    ? .updated(try decoder.decode(DuIndexUpdateResult.self, from: data))
                    : .built(try decoder.decode(DuIndexBuildResult.self, from: data))
            default: return .other(envelope.type)
            }
        } catch {
            return .undecodable(type: envelope.type, detail: DuIndexJSON.describe(error))
        }
    }
}

enum DuIndexJSON {
    static func describe(_ error: Error) -> String {
        if let decoding = error as? DecodingError { return MonitorJSON.describe(decoding) }
        return error.localizedDescription
    }

    static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}
