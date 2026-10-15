import Darwin
import Foundation

/// A known cause of a big file, with a one-sentence hint the UI shows.
public struct RadarCulprit: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var hint: String

    public init(id: String, title: String, hint: String) {
        self.id = id
        self.title = title
        self.hint = hint
    }

    public static let codeSignClone = RadarCulprit(
        id: "code-sign-clone", title: "Browser code-sign clone",
        hint: "Chrome, Brave, Edge and Teams copy their app here at every launch and remove the copy only on a clean quit; macOS clears this folder only at boot. Quit the browser instead of killing it.")
    public static let dockerImage = RadarCulprit(
        id: "docker-image", title: "Docker disk image",
        hint: "A sparse virtual disk that grows with images, containers and volumes and does not shrink by itself. Prune inside Docker or OrbStack.")
    public static let xcodeDerivedData = RadarCulprit(
        id: "xcode-derived-data", title: "Xcode DerivedData",
        hint: "Build products Xcode recreates on the next build. Safe to delete while Xcode is not building.")
    public static let simulatorRuntime = RadarCulprit(
        id: "simulator", title: "Simulator data",
        hint: "Simulator devices, runtimes or device support files. Remove unused ones with xcrun simctl delete unavailable.")
    public static let swiftPMBuild = RadarCulprit(
        id: "swiftpm-build", title: "SwiftPM .build folder",
        hint: "Build products of a Swift package. A worktree copy rebuilds from scratch; delete it when the worktree is idle.")
    public static let nodeModules = RadarCulprit(
        id: "node-modules", title: "node_modules",
        hint: "Installed packages; bun and npm install them again. Copies across worktrees are often APFS clones.")
    public static let jsonlLog = RadarCulprit(
        id: "jsonl-log", title: "JSONL log",
        hint: "An append-only log (agent sessions, traces) that grows while its writer runs.")
    public static let logFile = RadarCulprit(
        id: "log", title: "Log file",
        hint: "A log that is still being written. Check the writer before you delete it.")
    public static let temporaryFile = RadarCulprit(
        id: "temporary", title: "Temporary file",
        hint: "In a temporary folder: macOS removes files in /tmp and $TMPDIR after 3 days unchanged, but only nightly.")

    public static let all: [RadarCulprit] = [
        .codeSignClone, .dockerImage, .xcodeDerivedData, .simulatorRuntime, .swiftPMBuild, .nodeModules,
        .jsonlLog, .logFile, .temporaryFile,
    ]

    /// The first culprit whose pattern the path matches, in the order of `all`.
    public static func classify(path: String) -> RadarCulprit? {
        let name = (path as NSString).lastPathComponent
        if path.contains(".code_sign_clone") { return .codeSignClone }
        if name == "Docker.raw" || name == "data.img.raw" || path.contains("/com.docker.docker/Data/vms/")
            || path.contains("/Group Containers/HUAQ24HBR6.dev.orbstack/data/") {
            return .dockerImage
        }
        if path.contains("/Library/Developer/Xcode/DerivedData/") { return .xcodeDerivedData }
        if path.contains("/Library/Developer/CoreSimulator/") || path.contains("/Library/Developer/Xcode/iOS DeviceSupport/") {
            return .simulatorRuntime
        }
        if path.contains("/.build/") { return .swiftPMBuild }
        if path.contains("/node_modules/") { return .nodeModules }
        if name.hasSuffix(".jsonl") { return .jsonlLog }
        if name.hasSuffix(".log") { return .logFile }
        if path.hasPrefix("/tmp/") || path.hasPrefix("/private/tmp/") || isUserTemporary(path) { return .temporaryFile }
        return nil
    }

    private static func isUserTemporary(_ path: String) -> Bool {
        // /var/folders/<xx>/<id>/T/...
        let parts = path.split(separator: "/", omittingEmptySubsequences: true)
        let offset = parts.first == "private" ? 1 : 0
        guard parts.count > offset + 4, parts[offset] == "var", parts[offset + 1] == "folders" else { return false }
        return parts[offset + 4] == "T"
    }
}

/// A file over the radar's threshold that is new or grew.
public struct RadarHit: Codable, Equatable, Identifiable, Sendable {
    public var path: String
    /// Bytes the file occupies on disk (`st_blocks`); for a sparse disk image this is the real cost.
    public var allocatedBytes: Int64
    /// The file's length (`st_size`).
    public var logicalBytes: Int64
    /// Growth since the radar last reported it, or the whole size for a new file.
    public var delta: Int64
    public var culprit: RadarCulprit?
    public var firstSeen: Date
    public var lastSeen: Date
    /// True the first time the radar reports this path.
    public var isNew: Bool

    public var id: String { path }

    public init(path: String, allocatedBytes: Int64, logicalBytes: Int64, delta: Int64, culprit: RadarCulprit?,
                firstSeen: Date, lastSeen: Date, isNew: Bool) {
        self.path = path
        self.allocatedBytes = allocatedBytes
        self.logicalBytes = logicalBytes
        self.delta = delta
        self.culprit = culprit
        self.firstSeen = firstSeen
        self.lastSeen = lastSeen
        self.isNew = isNew
    }
}

/// Finds big new or growing files from `FileEventStream` batches. It `lstat`s only the paths a batch names (and the
/// direct entries of a folder event or a rescan root, bounded), so its cost follows the event rate, not the disk.
/// Work runs on its own serial utility queue; `onHits` gets each batch's new hits there.
///
/// - A file is reported when its allocated size first reaches `threshold`, and again each time it grew by
///   `growthStep` since the last report. Child processes' writes arrive too (`IgnoreSelf` does not hide them).
/// - A file that is removed, moved away (or sits in a removed or moved folder), or shrinks below `threshold` leaves
///   `hits` and is reported to `onRemove`; a listed file that changed less than a step shows its current size.
/// - `ignorePatterns` are `fnmatch` patterns in which `*` also crosses `/` (`*/node_modules/*`); `~` is the home. An
///   ignored folder's entries are not read.
/// - Tracked paths are capped at `maxTracked` (the least recently seen go first).
public final class BigFileRadar: @unchecked Sendable {
    public struct Configuration: Equatable, Sendable {
        public var threshold: Int64
        public var growthStep: Int64
        public var ignorePatterns: [String]
        public var maxTracked: Int
        public var maxHits: Int
        /// Entries read from one folder for a folder event or a rescan.
        public var maxDirectoryEntries: Int

        public init(threshold: Int64 = 500_000_000, growthStep: Int64 = 100_000_000, ignorePatterns: [String] = [],
                    maxTracked: Int = 20_000, maxHits: Int = 500, maxDirectoryEntries: Int = 2_000) {
            self.threshold = threshold
            self.growthStep = growthStep
            self.ignorePatterns = ignorePatterns
            self.maxTracked = maxTracked
            self.maxHits = maxHits
            self.maxDirectoryEntries = maxDirectoryEntries
        }
    }

    private struct Tracked {
        var reportedAllocated: Int64
        var firstSeen: Date
        var lastSeen: Date
    }

    private let queue = DispatchQueue(label: "genesis.disk.big-file-radar", qos: .utility)
    private let queueKey = DispatchSpecificKey<UInt8>()
    private let onHits: @Sendable ([RadarHit]) -> Void
    // Touched only on `queue`.
    private var config: Configuration
    private var expandedPatterns: [String]
    private var tracked: [String: Tracked] = [:]
    private var recent: [RadarHit] = []
    private var removalHandler: (@Sendable ([String]) -> Void)?
    private var stats = 0
    private var listings = 0

    public init(configuration: Configuration = Configuration(), onHits: @escaping @Sendable ([RadarHit]) -> Void) {
        config = configuration
        expandedPatterns = configuration.ignorePatterns.map(Self.expandTilde)
        self.onHits = onHits
        queue.setSpecific(key: queueKey, value: 1)
    }

    /// Runs on the radar's queue; called from `onHits` (already on it) it runs in place instead of deadlocking.
    private func onQueue<T>(_ body: () -> T) -> T {
        DispatchQueue.getSpecific(key: queueKey) != nil ? body() : queue.sync(execute: body)
    }

    public var configuration: Configuration {
        get { onQueue { config } }
        set {
            queue.async { [self] in
                config = newValue
                expandedPatterns = newValue.ignorePatterns.map(Self.expandTilde)
            }
        }
    }

    /// The latest hit per path that is still there at or above the threshold: the newest batch first, the biggest
    /// first within a batch. A file that was removed, moved away or shrank below the threshold leaves it.
    public var hits: [RadarHit] { onQueue { recent } }

    /// Called on the radar's queue with the paths that left `hits` (removed, moved away, shrunk below the
    /// threshold, or inside a removed folder), so a host that keeps its own list can drop them.
    public var onRemove: (@Sendable ([String]) -> Void)? {
        get { onQueue { removalHandler } }
        set { onQueue { removalHandler = newValue } }
    }

    /// Handles a batch on the radar's queue.
    public func consume(_ batch: FileEventBatch) {
        queue.async { [self] in
            let result = process(batch, now: Date())
            if !result.found.isEmpty { onHits(result.found) }
            if !result.removed.isEmpty { removalHandler?(result.removed) }
        }
    }

    /// Checks one path now (a file the user named, a known big file after a reclaim).
    public func check(paths: [String]) {
        consume(FileEventBatch(events: paths.map { FileEvent(path: $0, flags: [], id: 0) }))
    }

    public func forget(_ path: String) {
        queue.async { [self] in
            tracked.removeValue(forKey: path)
            recent.removeAll { $0.path == path }
        }
    }

    public func reset() {
        queue.async { [self] in
            tracked = [:]
            recent = []
        }
    }

    /// Synchronous core for tests: the hits this batch produced.
    func processNow(_ batch: FileEventBatch, now: Date = Date()) -> [RadarHit] {
        onQueue { process(batch, now: now).found }
    }

    /// Synchronous core for tests: the hits and the removed paths of this batch.
    func processResultNow(_ batch: FileEventBatch, now: Date = Date()) -> (found: [RadarHit], removed: [String]) {
        onQueue { process(batch, now: now) }
    }

    /// `lstat` calls and folder listings so far, for tests.
    var statCount: Int { onQueue { stats } }
    var folderReads: Int { onQueue { listings } }

    private func process(_ batch: FileEventBatch, now: Date) -> (found: [RadarHit], removed: [String]) {
        var candidates: [String] = []
        var seen = Set<String>()
        var removed: [String] = []
        func add(_ path: String) {
            if seen.insert(path).inserted { candidates.append(path) }
        }
        func drop(_ path: String, subtree: Bool) {
            let prefix = path == "/" ? "/" : path + "/"
            let inside: (String) -> Bool = { $0 == path || (subtree && $0.hasPrefix(prefix)) }
            for key in tracked.keys where inside(key) { tracked.removeValue(forKey: key) }
            let leaving = recent.filter { inside($0.path) }.map(\.path)
            if !leaving.isEmpty {
                recent.removeAll { inside($0.path) }
                removed.append(contentsOf: leaving)
            }
        }
        for event in batch.events {
            let mayBeGone = !event.flags.contains(.itemIsFile) || event.flags.contains(.itemRemoved)
                || event.flags.contains(.itemRenamed)
            if mayBeGone, !Self.exists(event.path) {
                // Removed, or moved away (a rename reports the old path): a folder takes its files along.
                drop(event.path, subtree: true)
                continue
            }
            if event.flags.contains(.itemIsDir) || (!event.flags.contains(.itemIsFile) && isDirectory(event.path)) {
                guard !isIgnored(event.path), !isIgnored(event.path + "/") else { continue }
                // Known files under the folder are checked too: one removed with a subfolder is not in its listing.
                let prefix = event.path == "/" ? "/" : event.path + "/"
                for path in tracked.keys where path.hasPrefix(prefix) { add(path) }
                for path in recent.map(\.path) where path.hasPrefix(prefix) { add(path) }
                for child in entries(of: event.path) { add(child) }
            } else {
                add(event.path)
            }
        }
        for root in batch.rescanRoots {
            for path in tracked.keys where path.hasPrefix(root == "/" ? "/" : root + "/") { add(path) }
            for path in recent.map(\.path) where path.hasPrefix(root == "/" ? "/" : root + "/") { add(path) }
            for child in entries(of: root) { add(child) }
        }

        var found: [RadarHit] = []
        for path in candidates where !isIgnored(path) {
            stats += 1
            guard let size = Self.fileSize(path) else {
                drop(path, subtree: false)
                continue
            }
            switch evaluate(path: path, allocated: size.allocated, logical: size.logical, now: now) {
            case .hit(let hit): found.append(hit)
            case .belowThreshold: drop(path, subtree: false)
            case .unchanged: refresh(path: path, allocated: size.allocated, logical: size.logical, now: now)
            }
        }
        if tracked.count > config.maxTracked {
            let overflow = tracked.count - config.maxTracked
            for key in tracked.sorted(by: { $0.value.lastSeen < $1.value.lastSeen }).prefix(overflow).map(\.key) {
                tracked.removeValue(forKey: key)
            }
        }
        if !found.isEmpty {
            let paths = Set(found.map(\.path))
            recent = (found.sorted { $0.allocatedBytes > $1.allocatedBytes } + recent.filter { !paths.contains($0.path) })
            if recent.count > config.maxHits { recent.removeLast(recent.count - config.maxHits) }
        }
        return (found, removed)
    }

    private enum Verdict {
        case hit(RadarHit)
        case belowThreshold
        case unchanged
    }

    private func evaluate(path: String, allocated: Int64, logical: Int64, now: Date) -> Verdict {
        if var entry = tracked[path] {
            entry.lastSeen = now
            if allocated < config.threshold {
                return .belowThreshold
            }
            let grown = allocated - entry.reportedAllocated
            if grown < max(1, config.growthStep) {
                if allocated < entry.reportedAllocated { entry.reportedAllocated = allocated }
                tracked[path] = entry
                return .unchanged
            }
            entry.reportedAllocated = allocated
            tracked[path] = entry
            return .hit(RadarHit(path: path, allocatedBytes: allocated, logicalBytes: logical, delta: grown,
                                 culprit: RadarCulprit.classify(path: path), firstSeen: entry.firstSeen, lastSeen: now,
                                 isNew: false))
        }
        guard allocated >= config.threshold else {
            return recent.contains { $0.path == path } ? .belowThreshold : .unchanged
        }
        tracked[path] = Tracked(reportedAllocated: allocated, firstSeen: now, lastSeen: now)
        return .hit(RadarHit(path: path, allocatedBytes: allocated, logicalBytes: logical, delta: allocated,
                             culprit: RadarCulprit.classify(path: path), firstSeen: now, lastSeen: now, isNew: true))
    }

    /// A listed file that changed less than a step keeps its place but shows its current size.
    private func refresh(path: String, allocated: Int64, logical: Int64, now: Date) {
        guard let index = recent.firstIndex(where: { $0.path == path }) else { return }
        if recent[index].allocatedBytes != allocated || recent[index].logicalBytes != logical {
            recent[index].allocatedBytes = allocated
            recent[index].logicalBytes = logical
            recent[index].lastSeen = now
        }
    }

    private static func exists(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0
    }

    private func isIgnored(_ path: String) -> Bool {
        expandedPatterns.contains { fnmatch($0, path, 0) == 0 }
    }

    private func isDirectory(_ path: String) -> Bool {
        var info = stat()
        return lstat(path, &info) == 0 && (info.st_mode & S_IFMT) == S_IFDIR
    }

    private func entries(of folder: String) -> [String] {
        listings += 1
        guard let directory = opendir(folder) else { return [] }
        defer { closedir(directory) }
        var result: [String] = []
        let base = folder.hasSuffix("/") ? folder : folder + "/"
        while result.count < config.maxDirectoryEntries, let entry = readdir(directory) {
            let name = withUnsafePointer(to: entry.pointee.d_name) {
                $0.withMemoryRebound(to: CChar.self, capacity: Int(entry.pointee.d_namlen) + 1) { String(cString: $0) }
            }
            if name == "." || name == ".." { continue }
            if Int32(entry.pointee.d_type) == DT_REG || Int32(entry.pointee.d_type) == DT_UNKNOWN {
                result.append(base + name)
            }
        }
        return result
    }

    /// The allocated and logical size of a regular file (no symlinks followed); nil for anything else.
    static func fileSize(_ path: String) -> (allocated: Int64, logical: Int64)? {
        var info = stat()
        guard lstat(path, &info) == 0, (info.st_mode & S_IFMT) == S_IFREG else { return nil }
        return (Int64(info.st_blocks) * 512, Int64(info.st_size))
    }

    static func expandTilde(_ pattern: String) -> String {
        pattern.hasPrefix("~/") ? FileManager.default.homeDirectoryForCurrentUser.path + pattern.dropFirst() : pattern
    }
}
