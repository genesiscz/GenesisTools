import Foundation
import GenesisKit

// Typed models for the JSON the GenesisTools `tools` CLI prints for disk work. Every top-level type
// names the command that prints it, and mirrors the TypeScript type behind that output field by field.
//
// - `tools du` prints snake_case keys (the C engine's format); those types map them through CodingKeys.
//   Every other command prints camelCase, which the property names match directly.
// - Byte counts are Int64 and counts are Int. A value the CLI can print with a fraction (a percentage,
//   a `performance.now()` duration, an epoch-ms from `stat`, a swap size parsed from text) is a Double.
// - Optional mirrors a TS field that is optional (`x?:`) or nullable (`x: T | null`).
// - Keys this file does not know are ignored, so a new CLI field never breaks a reader.
// - A string the CLI may grow new values for is a `RawRepresentable` struct with the known values as
//   static constants. An unknown value decodes as itself instead of throwing.

// MARK: - tools du

/// The engine `tools du clonesize --engine` scanned with (`src/du/lib/types.ts` `Engine`).
public struct DuScanEngine: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let c = DuScanEngine(rawValue: "c")
    public static let cFfi = DuScanEngine(rawValue: "c-ffi")
    public static let bun = DuScanEngine(rawValue: "bun")
}

/// One top-level child of a clonesize root (`GroupResult`).
public struct DuGroupResult: Codable, Equatable, Sendable {
    public var name: String
    public var naiveBytes: Int64
    public var files: Int
    public var crossGroupSharedBytes: Int64
    public var sharedPct: Double
    public var cloneCluster: Int
    public var cloneFlagged: Bool
    public var privateBytes: Int64?

    public init(
        name: String,
        naiveBytes: Int64,
        files: Int,
        crossGroupSharedBytes: Int64,
        sharedPct: Double,
        cloneCluster: Int,
        cloneFlagged: Bool,
        privateBytes: Int64? = nil
    ) {
        self.name = name
        self.naiveBytes = naiveBytes
        self.files = files
        self.crossGroupSharedBytes = crossGroupSharedBytes
        self.sharedPct = sharedPct
        self.cloneCluster = cloneCluster
        self.cloneFlagged = cloneFlagged
        self.privateBytes = privateBytes
    }

    enum CodingKeys: String, CodingKey {
        case name
        case naiveBytes = "naive_bytes"
        case files
        case crossGroupSharedBytes = "cross_group_shared_bytes"
        case sharedPct = "shared_pct"
        case cloneCluster = "clone_cluster"
        case cloneFlagged = "clone_flagged"
        case privateBytes = "private_bytes"
    }
}

/// One directory of the `--depth N` tree (`NodeResult`). The tree is flat: `parent` is an index into
/// the same `nodes` array, -1 for the root.
public struct DuNodeResult: Codable, Equatable, Sendable {
    public var path: String
    public var depth: Int
    public var parent: Int
    public var naiveBytes: Int64
    /// Clone-deduped unique mapped bytes in this subtree (no block slack).
    public var uniqueBytes: Int64
    /// The same dedup rounded to allocation blocks: what the volume spends.
    public var uniqueAllocatedBytes: Int64?
    /// Bytes this subtree shares with directories outside it.
    public var crossSharedBytes: Int64
    public var crossSharedAllocatedBytes: Int64?
    public var sharedPct: Double
    public var files: Int
    public var cloneFlagged: Bool
    public var privateBytes: Int64?
    /// Lower bound on what deleting this subtree frees.
    public var freeableFloorBytes: Int64?
    /// Upper bound on what deleting this subtree frees.
    public var freeableCeilingBytes: Int64?
    public var apparentBytes: Int64?
    public var sparseBytes: Int64?
    public var sparseFiles: Int?

    public init(
        path: String,
        depth: Int,
        parent: Int,
        naiveBytes: Int64,
        uniqueBytes: Int64,
        uniqueAllocatedBytes: Int64? = nil,
        crossSharedBytes: Int64,
        crossSharedAllocatedBytes: Int64? = nil,
        sharedPct: Double,
        files: Int,
        cloneFlagged: Bool,
        privateBytes: Int64? = nil,
        freeableFloorBytes: Int64? = nil,
        freeableCeilingBytes: Int64? = nil,
        apparentBytes: Int64? = nil,
        sparseBytes: Int64? = nil,
        sparseFiles: Int? = nil
    ) {
        self.path = path
        self.depth = depth
        self.parent = parent
        self.naiveBytes = naiveBytes
        self.uniqueBytes = uniqueBytes
        self.uniqueAllocatedBytes = uniqueAllocatedBytes
        self.crossSharedBytes = crossSharedBytes
        self.crossSharedAllocatedBytes = crossSharedAllocatedBytes
        self.sharedPct = sharedPct
        self.files = files
        self.cloneFlagged = cloneFlagged
        self.privateBytes = privateBytes
        self.freeableFloorBytes = freeableFloorBytes
        self.freeableCeilingBytes = freeableCeilingBytes
        self.apparentBytes = apparentBytes
        self.sparseBytes = sparseBytes
        self.sparseFiles = sparseFiles
    }

    enum CodingKeys: String, CodingKey {
        case path, depth, parent, files
        case naiveBytes = "naive_bytes"
        case uniqueBytes = "unique_bytes"
        case uniqueAllocatedBytes = "unique_allocated_bytes"
        case crossSharedBytes = "cross_shared_bytes"
        case crossSharedAllocatedBytes = "cross_shared_allocated_bytes"
        case sharedPct = "shared_pct"
        case cloneFlagged = "clone_flagged"
        case privateBytes = "private_bytes"
        case freeableFloorBytes = "freeable_floor_bytes"
        case freeableCeilingBytes = "freeable_ceiling_bytes"
        case apparentBytes = "apparent_bytes"
        case sparseBytes = "sparse_bytes"
        case sparseFiles = "sparse_files"
    }
}

/// `tools du clonesize <dir> --format json` (`ClonesizeResult` plus the CLI's `engine` and `elapsed_ms`).
/// Also the `scan` of `tools du volume --format json`, which has no `engine` or `elapsed_ms`.
public struct DuClonesizeResult: Codable, Equatable, Sendable {
    public var path: String
    public var filesScanned: Int
    public var filesListed: Int
    /// Files actually opened and extent-scanned.
    public var filesOpened: Int?
    /// Shared files whose extent map came from the cache.
    public var filesCached: Int?
    /// Present with `--depth`.
    public var depth: Int?
    /// Present with `--depth`: the per-directory tree, flat and root-first.
    public var nodes: [DuNodeResult]?
    public var extents: Int
    public var threads: Int
    public var naiveBytes: Int64
    /// Clone-deduped mapped bytes (no block slack).
    public var uniqueBytes: Int64
    /// Clone-deduped allocated bytes: the figure the volume's used-space counter agrees with.
    public var uniqueAllocatedBytes: Int64?
    public var apparentBytes: Int64?
    public var sparseBytes: Int64?
    public var sparseFiles: Int?
    public var sharedBytes: Int64
    public var sharedPct: Double
    public var crossGroupSharedBytes: Int64
    /// Σ per-file private size: the conservative floor on what deleting frees (`--freeable`).
    public var privateSumBytes: Int64?
    /// Blocks inside the scan that files outside the scan root also reference.
    public var outsideSharedBytes: Int64?
    /// Directories the scan could not open; their bytes are missing from every total.
    public var deniedDirs: Int?
    public var deniedFiles: Int?
    /// The first 64 denied paths.
    public var deniedPaths: [String]?
    public var skippedMounts: [String]?
    public var skippedCloud: [String]?
    /// Epoch seconds cutoff of `--changed-within`.
    public var changedSince: Int64?
    public var groups: [DuGroupResult]
    /// Added by `clonesize --format json`; absent inside `du volume`.
    public var engine: DuScanEngine?
    /// Added by `clonesize --format json`; absent inside `du volume`.
    public var elapsedMs: Int?

    public init(
        path: String,
        filesScanned: Int,
        filesListed: Int,
        filesOpened: Int? = nil,
        filesCached: Int? = nil,
        depth: Int? = nil,
        nodes: [DuNodeResult]? = nil,
        extents: Int,
        threads: Int,
        naiveBytes: Int64,
        uniqueBytes: Int64,
        uniqueAllocatedBytes: Int64? = nil,
        apparentBytes: Int64? = nil,
        sparseBytes: Int64? = nil,
        sparseFiles: Int? = nil,
        sharedBytes: Int64,
        sharedPct: Double,
        crossGroupSharedBytes: Int64,
        privateSumBytes: Int64? = nil,
        outsideSharedBytes: Int64? = nil,
        deniedDirs: Int? = nil,
        deniedFiles: Int? = nil,
        deniedPaths: [String]? = nil,
        skippedMounts: [String]? = nil,
        skippedCloud: [String]? = nil,
        changedSince: Int64? = nil,
        groups: [DuGroupResult],
        engine: DuScanEngine? = nil,
        elapsedMs: Int? = nil
    ) {
        self.path = path
        self.filesScanned = filesScanned
        self.filesListed = filesListed
        self.filesOpened = filesOpened
        self.filesCached = filesCached
        self.depth = depth
        self.nodes = nodes
        self.extents = extents
        self.threads = threads
        self.naiveBytes = naiveBytes
        self.uniqueBytes = uniqueBytes
        self.uniqueAllocatedBytes = uniqueAllocatedBytes
        self.apparentBytes = apparentBytes
        self.sparseBytes = sparseBytes
        self.sparseFiles = sparseFiles
        self.sharedBytes = sharedBytes
        self.sharedPct = sharedPct
        self.crossGroupSharedBytes = crossGroupSharedBytes
        self.privateSumBytes = privateSumBytes
        self.outsideSharedBytes = outsideSharedBytes
        self.deniedDirs = deniedDirs
        self.deniedFiles = deniedFiles
        self.deniedPaths = deniedPaths
        self.skippedMounts = skippedMounts
        self.skippedCloud = skippedCloud
        self.changedSince = changedSince
        self.groups = groups
        self.engine = engine
        self.elapsedMs = elapsedMs
    }

    enum CodingKeys: String, CodingKey {
        case path, depth, nodes, extents, threads, groups, engine
        case filesScanned = "files_scanned"
        case filesListed = "files_listed"
        case filesOpened = "files_opened"
        case filesCached = "files_cached"
        case naiveBytes = "naive_bytes"
        case uniqueBytes = "unique_bytes"
        case uniqueAllocatedBytes = "unique_allocated_bytes"
        case apparentBytes = "apparent_bytes"
        case sparseBytes = "sparse_bytes"
        case sparseFiles = "sparse_files"
        case sharedBytes = "shared_bytes"
        case sharedPct = "shared_pct"
        case crossGroupSharedBytes = "cross_group_shared_bytes"
        case privateSumBytes = "private_sum_bytes"
        case outsideSharedBytes = "outside_shared_bytes"
        case deniedDirs = "denied_dirs"
        case deniedFiles = "denied_files"
        case deniedPaths = "denied_paths"
        case skippedMounts = "skipped_mounts"
        case skippedCloud = "skipped_cloud"
        case changedSince = "changed_since"
        case elapsedMs = "elapsed_ms"
    }
}

/// The volume's own figures from the APFS layer (`VolumeInfo`). `usedBytes` matches
/// `diskutil info` "Volume Used Space".
public struct DuVolumeInfo: Codable, Equatable, Sendable {
    public var mount: String
    public var sizeBytes: Int64
    public var usedBytes: Int64
    public var freeBytes: Int64
    public var availableBytes: Int64

    public init(mount: String, sizeBytes: Int64, usedBytes: Int64, freeBytes: Int64, availableBytes: Int64) {
        self.mount = mount
        self.sizeBytes = sizeBytes
        self.usedBytes = usedBytes
        self.freeBytes = freeBytes
        self.availableBytes = availableBytes
    }

    enum CodingKeys: String, CodingKey {
        case mount
        case sizeBytes = "size_bytes"
        case usedBytes = "used_bytes"
        case freeBytes = "free_bytes"
        case availableBytes = "available_bytes"
    }
}

/// `tools du volume [mount] --format json`: the volume's used bytes against what a scan could see.
public struct DuVolumeReport: Codable, Equatable, Sendable {
    public var volume: DuVolumeInfo
    public var scan: DuClonesizeResult
    /// `volume.usedBytes` minus the scan's unique allocated bytes: what the walk could not see.
    /// Negative when the scan counted more than the volume reports.
    public var unaccountedBytes: Int64

    public init(volume: DuVolumeInfo, scan: DuClonesizeResult, unaccountedBytes: Int64) {
        self.volume = volume
        self.scan = scan
        self.unaccountedBytes = unaccountedBytes
    }

    enum CodingKeys: String, CodingKey {
        case volume, scan
        case unaccountedBytes = "unaccounted_bytes"
    }
}

/// One file or directory that holds blocks of the target (`PartnerEntry`).
public struct DuPartnerEntry: Codable, Equatable, Sendable {
    public var path: String
    public var sharedBytes: Int64
    /// Partner files under this directory; absent on a file entry.
    public var files: Int?

    public init(path: String, sharedBytes: Int64, files: Int? = nil) {
        self.path = path
        self.sharedBytes = sharedBytes
        self.files = files
    }

    enum CodingKeys: String, CodingKey {
        case path, files
        case sharedBytes = "shared_bytes"
    }
}

/// `tools du partners <dir> --format json`: where else the directory's blocks live
/// (`PartnersResult` plus the CLI's `elapsed_ms`).
public struct DuPartnersResult: Codable, Equatable, Sendable {
    public var target: String
    public var root: String
    /// Bytes of the target that live in blocks shared with something else.
    public var targetSharedBytes: Int64
    /// Σ over partner files; double-counts a block several partners hold.
    public var partnerBytes: Int64
    public var partnerFilesTotal: Int
    public var filesOpened: Int
    public var deniedDirs: Int
    public var deniedFiles: Int
    public var partnerDirs: [DuPartnerEntry]
    public var partnerFiles: [DuPartnerEntry]
    public var elapsedMs: Int?

    public init(
        target: String,
        root: String,
        targetSharedBytes: Int64,
        partnerBytes: Int64,
        partnerFilesTotal: Int,
        filesOpened: Int,
        deniedDirs: Int,
        deniedFiles: Int,
        partnerDirs: [DuPartnerEntry],
        partnerFiles: [DuPartnerEntry],
        elapsedMs: Int? = nil
    ) {
        self.target = target
        self.root = root
        self.targetSharedBytes = targetSharedBytes
        self.partnerBytes = partnerBytes
        self.partnerFilesTotal = partnerFilesTotal
        self.filesOpened = filesOpened
        self.deniedDirs = deniedDirs
        self.deniedFiles = deniedFiles
        self.partnerDirs = partnerDirs
        self.partnerFiles = partnerFiles
        self.elapsedMs = elapsedMs
    }

    enum CodingKeys: String, CodingKey {
        case target, root
        case targetSharedBytes = "target_shared_bytes"
        case partnerBytes = "partner_bytes"
        case partnerFilesTotal = "partner_files_total"
        case filesOpened = "files_opened"
        case deniedDirs = "denied_dirs"
        case deniedFiles = "denied_files"
        case partnerDirs = "partner_dirs"
        case partnerFiles = "partner_files"
        case elapsedMs = "elapsed_ms"
    }
}

// MARK: - tools macos clones

/// One directory row of a measure tree (`DirNode` in `src/macos/lib/clones/render/types.ts`).
public struct ClonesDirNode: Codable, Equatable, Sendable {
    public var path: String
    public var depth: Int
    /// Σ logical file sizes.
    public var logical: Int64
    /// Σ allocated blocks, every clone counted in full (what `du -sh` says).
    public var allocated: Int64
    /// Σ per-file private bytes: what deleting this directory frees. Null when not measured.
    public var real: Int64?
    /// `allocated ÷ real`. Null when `real` is null or zero.
    public var overcount: Double?
    public var children: [ClonesDirNode]
    public var sharedNote: String?

    public init(
        path: String,
        depth: Int,
        logical: Int64,
        allocated: Int64,
        real: Int64? = nil,
        overcount: Double? = nil,
        children: [ClonesDirNode] = [],
        sharedNote: String? = nil
    ) {
        self.path = path
        self.depth = depth
        self.logical = logical
        self.allocated = allocated
        self.real = real
        self.overcount = overcount
        self.children = children
        self.sharedNote = sharedNote
    }
}

/// Totals of a measure report (`MeasureTotals`).
public struct ClonesMeasureTotals: Codable, Equatable, Sendable {
    public var logical: Int64
    public var allocated: Int64
    /// Σ per-file private bytes: the floor, what deleting frees while everything else stays.
    public var real: Int64?
    /// Clone-deduped allocated bytes from the du extent engine. Null when the engine could not run
    /// (or `--no-unique`).
    public var uniqueAllocated: Int64?
    public var overcount: Double?

    public init(
        logical: Int64,
        allocated: Int64,
        real: Int64? = nil,
        uniqueAllocated: Int64? = nil,
        overcount: Double? = nil
    ) {
        self.logical = logical
        self.allocated = allocated
        self.real = real
        self.uniqueAllocated = uniqueAllocated
        self.overcount = overcount
    }
}

/// Clone-family summary of a measure report (`CloneAnalysis`).
public struct ClonesCloneAnalysis: Codable, Equatable, Sendable {
    public var families: Int
    public var clonedFiles: Int
    public var sharedBytes: Int64
    public var crossTreePartners: [String]
    public var notes: [String]

    public init(families: Int, clonedFiles: Int, sharedBytes: Int64, crossTreePartners: [String], notes: [String]) {
        self.families = families
        self.clonedFiles = clonedFiles
        self.sharedBytes = sharedBytes
        self.crossTreePartners = crossTreePartners
        self.notes = notes
    }
}

/// statfs figures of the measured volume (`MeasureFreeSpace`).
public struct ClonesFreeSpace: Codable, Equatable, Sendable {
    public var total: Int64
    public var free: Int64
    public var available: Int64

    public init(total: Int64, free: Int64, available: Int64) {
        self.total = total
        self.free = free
        self.available = available
    }
}

/// A path the measure walk could not read (`MeasureError`).
public struct ClonesMeasureError: Codable, Equatable, Sendable {
    public var path: String
    /// The errno name, e.g. `EACCES`.
    public var errno: String

    public init(path: String, errno: String) {
        self.path = path
        self.errno = errno
    }
}

/// `tools macos clones measure [roots...] --format json` and `tools macos clones du [folder] --format json`
/// (`MeasureReport`).
public struct ClonesMeasureReport: Codable, Equatable, Sendable {
    public var roots: [String]
    public var nodeModulesMode: Bool
    public var minReal: Int64
    public var tree: [ClonesDirNode]
    public var totals: ClonesMeasureTotals
    public var cloneAnalysis: ClonesCloneAnalysis
    public var freeSpace: ClonesFreeSpace
    public var errors: [ClonesMeasureError]

    public init(
        roots: [String],
        nodeModulesMode: Bool,
        minReal: Int64,
        tree: [ClonesDirNode],
        totals: ClonesMeasureTotals,
        cloneAnalysis: ClonesCloneAnalysis,
        freeSpace: ClonesFreeSpace,
        errors: [ClonesMeasureError]
    ) {
        self.roots = roots
        self.nodeModulesMode = nodeModulesMode
        self.minReal = minReal
        self.tree = tree
        self.totals = totals
        self.cloneAnalysis = cloneAnalysis
        self.freeSpace = freeSpace
        self.errors = errors
    }
}

/// Whether a duplicate set is a file or a whole folder (`DuplicateSet.kind`).
public struct ClonesDuplicateKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let file = ClonesDuplicateKind(rawValue: "file")
    public static let dir = ClonesDuplicateKind(rawValue: "dir")
}

/// Content-identical copies that are not clones of each other yet (`DuplicateSet`).
public struct ClonesDuplicateSet: Codable, Equatable, Sendable {
    public var kind: ClonesDuplicateKind
    /// The set's label: the keep copy's path relative to its root.
    public var what: String
    public var copies: Int
    public var eachBytes: Int64
    /// Naive: `(copies - 1) * eachBytes`, as if every replaced copy were fully private.
    public var reclaimable: Int64
    public var members: [String]
    public var keep: String
    /// Store copies that stay keep-only.
    public var storeMembers: [String]?
    /// Bytes the volume really gains when apply rewrites this set. Absent when not measured.
    public var freeable: Int64?
    /// `freeable` plus shared store blocks that may come back. An upper bound.
    public var freeableUpTo: Int64?

    public init(
        kind: ClonesDuplicateKind,
        what: String,
        copies: Int,
        eachBytes: Int64,
        reclaimable: Int64,
        members: [String],
        keep: String,
        storeMembers: [String]? = nil,
        freeable: Int64? = nil,
        freeableUpTo: Int64? = nil
    ) {
        self.kind = kind
        self.what = what
        self.copies = copies
        self.eachBytes = eachBytes
        self.reclaimable = reclaimable
        self.members = members
        self.keep = keep
        self.storeMembers = storeMembers
        self.freeable = freeable
        self.freeableUpTo = freeableUpTo
    }
}

/// Scan statistics of a duplicates run (`FindDuplicatesStats` in `src/utils/fs/disk-usage.ts`).
public struct ClonesDuplicatesStats: Codable, Equatable, Sendable {
    public var walkedFiles: Int
    public var walkedDirs: Int
    public var walkMs: Double
    public var bucketsTotal: Int
    public var bucketsDroppedByClone: Int
    public var bucketsHashed: Int
    public var cloneIdCalls: Int
    public var sha256Calls: Int
    public var sha256Bytes: Int64
    public var byteCompareCalls: Int
    public var hashMs: Double
    public var cacheHits: Int
    public var cacheMisses: Int
    public var prefixHashCalls: Int
    public var prefixHashDrops: Int
    /// Directories the walk could not open.
    public var deniedDirs: Int

    public init(
        walkedFiles: Int,
        walkedDirs: Int,
        walkMs: Double,
        bucketsTotal: Int,
        bucketsDroppedByClone: Int,
        bucketsHashed: Int,
        cloneIdCalls: Int,
        sha256Calls: Int,
        sha256Bytes: Int64,
        byteCompareCalls: Int,
        hashMs: Double,
        cacheHits: Int,
        cacheMisses: Int,
        prefixHashCalls: Int,
        prefixHashDrops: Int,
        deniedDirs: Int
    ) {
        self.walkedFiles = walkedFiles
        self.walkedDirs = walkedDirs
        self.walkMs = walkMs
        self.bucketsTotal = bucketsTotal
        self.bucketsDroppedByClone = bucketsDroppedByClone
        self.bucketsHashed = bucketsHashed
        self.cloneIdCalls = cloneIdCalls
        self.sha256Calls = sha256Calls
        self.sha256Bytes = sha256Bytes
        self.byteCompareCalls = byteCompareCalls
        self.hashMs = hashMs
        self.cacheHits = cacheHits
        self.cacheMisses = cacheMisses
        self.prefixHashCalls = prefixHashCalls
        self.prefixHashDrops = prefixHashDrops
        self.deniedDirs = deniedDirs
    }
}

/// `tools macos clones duplicates [roots...] --format json` (`DuplicatesReport`). JSON always carries
/// every set; `--top` caps only the human formats.
public struct ClonesDuplicatesReport: Codable, Equatable, Sendable {
    public var roots: [String]
    public var sets: [ClonesDuplicateSet]
    public var totalReclaimable: Int64
    public var grouped: Bool
    public var hardStop: [String]
    public var stats: ClonesDuplicatesStats?

    public init(
        roots: [String],
        sets: [ClonesDuplicateSet],
        totalReclaimable: Int64,
        grouped: Bool,
        hardStop: [String],
        stats: ClonesDuplicatesStats? = nil
    ) {
        self.roots = roots
        self.sets = sets
        self.totalReclaimable = totalReclaimable
        self.grouped = grouped
        self.hardStop = hardStop
        self.stats = stats
    }
}

/// A package-manager store id (`KeepPartnerId` in `src/macos/lib/clones/keep-partners.ts`).
public struct ClonesKeepPartnerID: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let bun = ClonesKeepPartnerID(rawValue: "bun")
    public static let npm = ClonesKeepPartnerID(rawValue: "npm")
    public static let pnpm = ClonesKeepPartnerID(rawValue: "pnpm")
    public static let yarn = ClonesKeepPartnerID(rawValue: "yarn")
    public static let composer = ClonesKeepPartnerID(rawValue: "composer")
}

/// Why discovery left a root out (`SkipReason` in `src/macos/lib/clones/targets.ts`).
public struct ClonesSkipReason: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let noComposer = ClonesSkipReason(rawValue: "no-composer")
    public static let notIgnored = ClonesSkipReason(rawValue: "not-ignored")
    public static let checkIgnoreFailed = ClonesSkipReason(rawValue: "check-ignore-failed")
    public static let notAPFS = ClonesSkipReason(rawValue: "not-apfs")
    public static let missing = ClonesSkipReason(rawValue: "missing")
}

/// What a reclaim plan searched (`ReclaimSelector` in `src/macos/lib/clones/reclaim.ts`).
public struct ClonesReclaimSelector: Codable, Equatable, Sendable {
    public var dirs: [String]
    public var worktreesOf: String?
    /// Target kinds (`gitignored`, `node_modules`, `vendor`, `Pods`, `.cxx`) or `find -name` patterns.
    public var targets: [String]
    public var exclude: [String]
    public var minReal: Int64
    public var keepPartners: [ClonesKeepPartnerID]
    public var rewriteStores: [ClonesKeepPartnerID]?
    public var keepUnfreeable: Bool?

    public init(
        dirs: [String],
        worktreesOf: String? = nil,
        targets: [String],
        exclude: [String],
        minReal: Int64,
        keepPartners: [ClonesKeepPartnerID],
        rewriteStores: [ClonesKeepPartnerID]? = nil,
        keepUnfreeable: Bool? = nil
    ) {
        self.dirs = dirs
        self.worktreesOf = worktreesOf
        self.targets = targets
        self.exclude = exclude
        self.minReal = minReal
        self.keepPartners = keepPartners
        self.rewriteStores = rewriteStores
        self.keepUnfreeable = keepUnfreeable
    }
}

/// A root's mtime taken right after discovery (`RootStamp`).
public struct ClonesRootStamp: Codable, Equatable, Sendable {
    public var path: String
    /// Epoch ms from `stat`, with a fraction.
    public var mtimeMs: Double

    public init(path: String, mtimeMs: Double) {
        self.path = path
        self.mtimeMs = mtimeMs
    }
}

/// A root discovery left out, with the reason (`SkippedRoot`).
public struct ClonesSkippedRoot: Codable, Equatable, Sendable {
    public var path: String
    public var reason: ClonesSkipReason

    public init(path: String, reason: ClonesSkipReason) {
        self.path = path
        self.reason = reason
    }
}

/// A package-manager store a plan keeps (`ResolvedKeepPartner`).
public struct ClonesKeepRoot: Codable, Equatable, Sendable {
    public var id: ClonesKeepPartnerID
    public var root: String

    public init(id: ClonesKeepPartnerID, root: String) {
        self.id = id
        self.root = root
    }
}

/// Sets a plan left out because they free nothing.
public struct ClonesDroppedSets: Codable, Equatable, Sendable {
    public var sets: Int
    public var naiveBytes: Int64

    public init(sets: Int, naiveBytes: Int64) {
        self.sets = sets
        self.naiveBytes = naiveBytes
    }
}

/// `tools macos clones reclaim plan [dirs...] --format json` (`ReclaimPlan`): what apply would
/// rewrite. Planning rewrites nothing.
public struct ClonesReclaimPlan: Codable, Equatable, Sendable {
    /// The run log id under the reclaim run-log directory.
    public var runId: String
    public var selector: ClonesReclaimSelector
    public var roots: [String]
    public var rootStamps: [ClonesRootStamp]
    public var skipped: [ClonesSkippedRoot]
    public var keepRoots: [ClonesKeepRoot]
    public var sets: [ClonesDuplicateSet]
    /// Naive bytes of `sets`.
    public var totalReclaimable: Int64
    /// Measured bytes the volume gains when `sets` are applied.
    public var totalFreeable: Int64
    /// Upper bound of `totalFreeable`.
    public var totalFreeableUpTo: Int64
    public var dropped: ClonesDroppedSets
    /// True when the sets came from a fresh plan snapshot instead of a scan.
    public var fromSnapshot: Bool
    public var deniedDirs: Int

    public init(
        runId: String,
        selector: ClonesReclaimSelector,
        roots: [String],
        rootStamps: [ClonesRootStamp],
        skipped: [ClonesSkippedRoot],
        keepRoots: [ClonesKeepRoot],
        sets: [ClonesDuplicateSet],
        totalReclaimable: Int64,
        totalFreeable: Int64,
        totalFreeableUpTo: Int64,
        dropped: ClonesDroppedSets,
        fromSnapshot: Bool,
        deniedDirs: Int
    ) {
        self.runId = runId
        self.selector = selector
        self.roots = roots
        self.rootStamps = rootStamps
        self.skipped = skipped
        self.keepRoots = keepRoots
        self.sets = sets
        self.totalReclaimable = totalReclaimable
        self.totalFreeable = totalFreeable
        self.totalFreeableUpTo = totalFreeableUpTo
        self.dropped = dropped
        self.fromSnapshot = fromSnapshot
        self.deniedDirs = deniedDirs
    }
}

// MARK: - tools doctor

/// How risky a finding's fix is (`Severity` in `src/doctor/lib/types.ts`).
public struct DoctorSeverity: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let safe = DoctorSeverity(rawValue: "safe")
    public static let cautious = DoctorSeverity(rawValue: "cautious")
    public static let dangerous = DoctorSeverity(rawValue: "dangerous")
    public static let blocked = DoctorSeverity(rawValue: "blocked")
}

/// Any JSON value: an analyzer's free-form `metadata` (`Record<string, unknown>`).
public enum DoctorJSONValue: Codable, Equatable, Sendable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case array([DoctorJSONValue])
    case object([String: DoctorJSONValue])
    case null

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([DoctorJSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: DoctorJSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        case .null: try container.encodeNil()
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
}

/// One finding of a doctor run, as `--json` prints it (`src/doctor/ui/json.ts`).
public struct DoctorFinding: Codable, Equatable, Sendable {
    public var id: String
    public var analyzerId: String
    public var title: String
    public var detail: String?
    public var severity: DoctorSeverity
    public var reclaimableBytes: Int64?
    public var blacklistReason: String?
    /// The ids of the fixes the interactive doctor offers. `--json` never runs one.
    public var availableActionIds: [String]
    /// The fixes `tools doctor act` can run on this finding, with their confirmation kind.
    public var actions: [DoctorActionInfo]?
    /// True when the finding came from the analyzer cache rather than a fresh scan.
    public var fromCache: Bool?
    public var metadata: [String: DoctorJSONValue]?
    /// `sha256:` of the sorted `metadata.paths` (nil without paths). Pass it back as
    /// `doctor act --expect-paths <id>=<hash>` (`expectPaths`), so a changed path set is refused as stale.
    public var pathsHash: String?

    public init(
        id: String,
        analyzerId: String,
        title: String,
        detail: String? = nil,
        severity: DoctorSeverity,
        reclaimableBytes: Int64? = nil,
        blacklistReason: String? = nil,
        availableActionIds: [String] = [],
        actions: [DoctorActionInfo]? = nil,
        fromCache: Bool? = nil,
        metadata: [String: DoctorJSONValue]? = nil,
        pathsHash: String? = nil
    ) {
        self.pathsHash = pathsHash
        self.id = id
        self.analyzerId = analyzerId
        self.title = title
        self.detail = detail
        self.severity = severity
        self.reclaimableBytes = reclaimableBytes
        self.blacklistReason = blacklistReason
        self.availableActionIds = availableActionIds
        self.actions = actions
        self.fromCache = fromCache
        self.metadata = metadata
    }
}

/// An analyzer that threw during the run.
public struct DoctorAnalyzerError: Codable, Equatable, Sendable {
    public var analyzerId: String
    public var error: String

    public init(analyzerId: String, error: String) {
        self.analyzerId = analyzerId
        self.error = error
    }
}

/// `tools doctor --json` (`src/doctor/ui/json.ts`): findings only, no fix is executed.
public struct DoctorReport: Codable, Equatable, Sendable {
    public var runId: String
    /// ISO 8601 with milliseconds.
    public var startedAt: String
    /// ISO 8601 with milliseconds.
    public var endedAt: String
    /// The analyzer ids that ran.
    public var analyzers: [String]
    public var findings: [DoctorFinding]
    public var errors: [DoctorAnalyzerError]
    /// 1 since the Disk Manager contract; nil from an older CLI.
    public var schemaVersion: Int?
    /// Set when walking analyzers were skipped (low space, a hot `fseventsd`).
    public var scanGate: DoctorScanGate?

    public init(
        runId: String,
        startedAt: String,
        endedAt: String,
        analyzers: [String],
        findings: [DoctorFinding],
        errors: [DoctorAnalyzerError],
        schemaVersion: Int? = nil,
        scanGate: DoctorScanGate? = nil
    ) {
        self.runId = runId
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.analyzers = analyzers
        self.findings = findings
        self.errors = errors
        self.schemaVersion = schemaVersion
        self.scanGate = scanGate
    }
}

// MARK: - tools hub worktrees

/// `tools git merged` verdict of a worktree's branch (`Verdict` in `src/git/lib/merged/verdict.ts`).
public struct HubWorktreeVerdict: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let merged = HubWorktreeVerdict(rawValue: "MERGED")
    public static let empty = HubWorktreeVerdict(rawValue: "EMPTY")
    public static let stale = HubWorktreeVerdict(rawValue: "STALE")
    public static let unmerged = HubWorktreeVerdict(rawValue: "UNMERGED")
}

/// How the verdict was reached (`How` in `src/git/lib/merged/verdict.ts`).
public struct HubWorktreeHow: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let ancestor = HubWorktreeHow(rawValue: "ancestor")
    public static let cherry = HubWorktreeHow(rawValue: "cherry")
    public static let content = HubWorktreeHow(rawValue: "content")
    public static let superseded = HubWorktreeHow(rawValue: "superseded")
    public static let none = HubWorktreeHow(rawValue: "none")
    /// The CLI's `-`: no route applies.
    public static let notApplicable = HubWorktreeHow(rawValue: "-")
}

/// Why a worktree is not removable (`BlockerKind` in `src/hub/lib/worktrees.ts`).
public struct HubWorktreeBlockerKind: RawRepresentable, Codable, Hashable, Sendable {
    public let rawValue: String

    public init(rawValue: String) { self.rawValue = rawValue }

    public static let unmerged = HubWorktreeBlockerKind(rawValue: "unmerged")
    public static let verdictError = HubWorktreeBlockerKind(rawValue: "verdict-error")
    public static let statusError = HubWorktreeBlockerKind(rawValue: "status-error")
    public static let changed = HubWorktreeBlockerKind(rawValue: "changed")
    public static let untracked = HubWorktreeBlockerKind(rawValue: "untracked")
    public static let stash = HubWorktreeBlockerKind(rawValue: "stash")
    public static let process = HubWorktreeBlockerKind(rawValue: "process")
    public static let session = HubWorktreeBlockerKind(rawValue: "session")
    public static let locked = HubWorktreeBlockerKind(rawValue: "locked")
    public static let missing = HubWorktreeBlockerKind(rawValue: "missing")
    public static let recent = HubWorktreeBlockerKind(rawValue: "recent")
}

/// One reason a worktree stays (`Blocker`).
public struct HubWorktreeBlocker: Codable, Equatable, Sendable {
    public var kind: HubWorktreeBlockerKind
    /// One sentence for the row and the refusal.
    public var text: String

    public init(kind: HubWorktreeBlockerKind, text: String) {
        self.kind = kind
        self.text = text
    }
}

/// A process whose working directory is inside the worktree (`LiveProcess`).
public struct HubWorktreeProcess: Codable, Equatable, Sendable {
    public var pid: Int32
    public var name: String

    public init(pid: Int32, name: String) {
        self.pid = pid
        self.name = name
    }
}

/// An agent session that wrote in the worktree recently (`LiveSession`).
public struct HubWorktreeSession: Codable, Equatable, Sendable {
    public var provider: String
    public var sessionId: String
    public var title: String?
    /// Epoch ms of the session file's last write.
    public var mtime: Double

    public init(provider: String, sessionId: String, title: String? = nil, mtime: Double) {
        self.provider = provider
        self.sessionId = sessionId
        self.title = title
        self.mtime = mtime
    }
}

/// The base one repository was judged against.
public struct HubWorktreeBase: Codable, Equatable, Sendable {
    public var repoRoot: String
    public var base: String
    public var source: String
    public var detail: String

    public init(repoRoot: String, base: String, source: String, detail: String) {
        self.repoRoot = repoRoot
        self.base = base
        self.source = source
        self.detail = detail
    }
}

/// One linked worktree with the removal rules' answer (`WorktreeCleanupRow`).
public struct HubWorktreeRow: Codable, Equatable, Sendable {
    public var path: String
    /// The main checkout of its repository.
    public var repoRoot: String
    public var repo: String
    /// Nil on a detached HEAD.
    public var branch: String?
    public var head: String
    /// The folder exists on disk.
    public var present: Bool
    public var locked: String?
    public var prunable: String?
    /// Nil when the verdict could not be computed.
    public var verdict: HubWorktreeVerdict?
    public var how: HubWorktreeHow?
    public var verdictError: String?
    /// `git status` failed: nothing is known about uncommitted work.
    public var statusError: String?
    public var base: String?
    public var changedCount: Int
    /// The first few changed paths.
    public var changed: [String]
    public var untrackedCount: Int
    public var untracked: [String]
    /// Ignored top-level entries `git worktree remove` deletes with the folder.
    public var ignored: [String]
    public var stashes: [String]
    public var stashError: String?
    public var processes: [HubWorktreeProcess]
    public var sessions: [HubWorktreeSession]
    public var sessionsError: String?
    /// Epoch ms of the HEAD commit.
    public var lastCommitAt: Double?
    /// Epoch ms of the newest of the HEAD commit, the reflog and the index (fractional from `stat`).
    public var lastActivityAt: Double?
    public var removable: Bool
    public var blockers: [HubWorktreeBlocker]

    public init(
        path: String,
        repoRoot: String,
        repo: String,
        branch: String? = nil,
        head: String,
        present: Bool,
        locked: String? = nil,
        prunable: String? = nil,
        verdict: HubWorktreeVerdict? = nil,
        how: HubWorktreeHow? = nil,
        verdictError: String? = nil,
        statusError: String? = nil,
        base: String? = nil,
        changedCount: Int = 0,
        changed: [String] = [],
        untrackedCount: Int = 0,
        untracked: [String] = [],
        ignored: [String] = [],
        stashes: [String] = [],
        stashError: String? = nil,
        processes: [HubWorktreeProcess] = [],
        sessions: [HubWorktreeSession] = [],
        sessionsError: String? = nil,
        lastCommitAt: Double? = nil,
        lastActivityAt: Double? = nil,
        removable: Bool,
        blockers: [HubWorktreeBlocker] = []
    ) {
        self.path = path
        self.repoRoot = repoRoot
        self.repo = repo
        self.branch = branch
        self.head = head
        self.present = present
        self.locked = locked
        self.prunable = prunable
        self.verdict = verdict
        self.how = how
        self.verdictError = verdictError
        self.statusError = statusError
        self.base = base
        self.changedCount = changedCount
        self.changed = changed
        self.untrackedCount = untrackedCount
        self.untracked = untracked
        self.ignored = ignored
        self.stashes = stashes
        self.stashError = stashError
        self.processes = processes
        self.sessions = sessions
        self.sessionsError = sessionsError
        self.lastCommitAt = lastCommitAt
        self.lastActivityAt = lastActivityAt
        self.removable = removable
        self.blockers = blockers
    }
}

/// `tools hub worktrees list [repos...] --json` (`WorktreeCleanupReport`). Read-only.
public struct HubWorktreeReport: Codable, Equatable, Sendable {
    public var rows: [HubWorktreeRow]
    public var bases: [HubWorktreeBase]
    public var warnings: [String]
    public var elapsedMs: Int

    public init(rows: [HubWorktreeRow], bases: [HubWorktreeBase], warnings: [String], elapsedMs: Int) {
        self.rows = rows
        self.bases = bases
        self.warnings = warnings
        self.elapsedMs = elapsedMs
    }
}

/// One element of `tools hub worktrees size <paths...> --json`, which prints a top-level array
/// (`WorktreeSize`).
public struct HubWorktreeSize: Codable, Equatable, Sendable {
    public var path: String
    /// Clone-deduplicated allocated bytes inside the worktree.
    public var bytes: Int64
    /// The floor of what removing it frees. Nil when not measured.
    public var freeableBytes: Int64?
    public var files: Int
    public var elapsedMs: Int
    /// Set instead of a measurement, e.g. "The folder does not exist".
    public var error: String?

    public init(
        path: String,
        bytes: Int64,
        freeableBytes: Int64? = nil,
        files: Int,
        elapsedMs: Int,
        error: String? = nil
    ) {
        self.path = path
        self.bytes = bytes
        self.freeableBytes = freeableBytes
        self.files = files
        self.elapsedMs = elapsedMs
        self.error = error
    }
}

// MARK: - tools macos swap

/// `sysctl vm.swapusage` (`SystemSwap`). Parsed from text like `512.00M`, so a value can have a fraction.
public struct SwapSystemUsage: Codable, Equatable, Sendable {
    public var totalBytes: Double
    public var usedBytes: Double
    public var freeBytes: Double

    public init(totalBytes: Double, usedBytes: Double, freeBytes: Double) {
        self.totalBytes = totalBytes
        self.usedBytes = usedBytes
        self.freeBytes = freeBytes
    }
}

/// One process with swapped-out memory (`ProcessSwap`).
public struct SwapProcess: Codable, Equatable, Sendable {
    public var pid: Int32
    public var name: String
    public var rssBytes: Int64
    /// From `vmmap -summary` text, so it can have a fraction.
    public var swapBytes: Double
    public var uptimeMs: Int64

    public init(pid: Int32, name: String, rssBytes: Int64, swapBytes: Double, uptimeMs: Int64) {
        self.pid = pid
        self.name = name
        self.rssBytes = rssBytes
        self.swapBytes = swapBytes
        self.uptimeMs = uptimeMs
    }
}

/// `tools macos swap --json` (`ScanResult` in `src/macos/lib/swap/types.ts`), processes sorted by swap.
public struct SwapReport: Codable, Equatable, Sendable {
    public var system: SwapSystemUsage
    /// Only processes with swap above zero.
    public var processes: [SwapProcess]
    public var scannedCount: Int
    public var totalProcesses: Int
    public var cacheHits: Int
    public var freshScans: Int
    /// Processes `vmmap` could not read.
    public var inaccessibleCount: Int
    public var wasAllMode: Bool

    public init(
        system: SwapSystemUsage,
        processes: [SwapProcess],
        scannedCount: Int,
        totalProcesses: Int,
        cacheHits: Int,
        freshScans: Int,
        inaccessibleCount: Int,
        wasAllMode: Bool
    ) {
        self.system = system
        self.processes = processes
        self.scannedCount = scannedCount
        self.totalProcesses = totalProcesses
        self.cacheHits = cacheHits
        self.freshScans = freshScans
        self.inaccessibleCount = inaccessibleCount
        self.wasAllMode = wasAllMode
    }
}
