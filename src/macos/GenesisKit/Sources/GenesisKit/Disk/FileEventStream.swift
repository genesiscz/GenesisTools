import CoreServices
import Darwin
import Foundation

/// The FSEvents flags of one event, named.
public struct FileEventFlags: OptionSet, Hashable, Sendable {
    public let rawValue: UInt32

    public init(rawValue: UInt32) {
        self.rawValue = rawValue
    }

    public static let mustScanSubDirs = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagMustScanSubDirs))
    public static let userDropped = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagUserDropped))
    public static let kernelDropped = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagKernelDropped))
    public static let eventIdsWrapped = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagEventIdsWrapped))
    public static let historyDone = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagHistoryDone))
    public static let rootChanged = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagRootChanged))
    public static let mount = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagMount))
    public static let unmount = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagUnmount))
    public static let itemCreated = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemCreated))
    public static let itemRemoved = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemRemoved))
    public static let itemInodeMetaMod = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemInodeMetaMod))
    public static let itemRenamed = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemRenamed))
    public static let itemModified = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemModified))
    public static let itemFinderInfoMod = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemFinderInfoMod))
    public static let itemChangeOwner = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemChangeOwner))
    public static let itemXattrMod = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemXattrMod))
    public static let itemIsFile = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemIsFile))
    public static let itemIsDir = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemIsDir))
    public static let itemIsSymlink = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemIsSymlink))
    public static let ownEvent = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagOwnEvent))
    public static let itemIsHardlink = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemIsHardlink))
    public static let itemIsLastHardlink = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemIsLastHardlink))
    public static let itemCloned = FileEventFlags(rawValue: UInt32(kFSEventStreamEventFlagItemCloned))

    public static let dropped: FileEventFlags = [.userDropped, .kernelDropped]
}

/// One path that changed. In a batch, all events for a path are merged: the flags are OR-ed, the id is the latest.
public struct FileEvent: Equatable, Sendable {
    public var path: String
    public var flags: FileEventFlags
    public var id: UInt64

    public init(path: String, flags: FileEventFlags, id: UInt64) {
        self.path = path
        self.flags = flags
        self.id = id
    }
}

/// What one FSEvents callback delivered, cleaned up for a consumer.
public struct FileEventBatch: Equatable, Sendable {
    /// One per path, in the order the paths first appeared.
    public var events: [FileEvent]
    /// Folders whose contents must be checked again because events below them were lost or coalesced
    /// (MustScanSubDirs, a dropped buffer, wrapped ids, a moved root, or a saved cursor that cannot be replayed).
    public var rescanRoots: [String]
    /// Events were dropped (by this process or the kernel); `rescanRoots` names the watched roots.
    public var dropped: Bool
    /// The saved position could not be used (another volume UUID, an id from the future): no replay happened.
    public var historyInvalid: Bool
    /// The replay of saved history finished in this batch.
    public var historyDone: Bool
    /// The events came from history (before `historyDone`), not live.
    public var isReplay: Bool
    public var lastEventId: UInt64

    public init(events: [FileEvent] = [], rescanRoots: [String] = [], dropped: Bool = false,
                historyInvalid: Bool = false, historyDone: Bool = false, isReplay: Bool = false, lastEventId: UInt64 = 0) {
        self.events = events
        self.rescanRoots = rescanRoots
        self.dropped = dropped
        self.historyInvalid = historyInvalid
        self.historyDone = historyDone
        self.isReplay = isReplay
        self.lastEventId = lastEventId
    }

    public var isEmpty: Bool { events.isEmpty && rescanRoots.isEmpty && !historyDone }
}

/// Where a stream continues from after a restart: the last delivered event id and the FSEvents database UUID of
/// each watched volume. A different UUID means the volume's history was reset, and the id is meaningless there.
public struct FileEventCursor: Codable, Equatable, Sendable {
    public var eventId: UInt64
    public var deviceUUIDs: [String]
    public var savedAt: Date

    public init(eventId: UInt64, deviceUUIDs: [String], savedAt: Date) {
        self.eventId = eventId
        self.deviceUUIDs = deviceUUIDs
        self.savedAt = savedAt
    }
}

/// Keeps cursors for the host. Called on the stream's queue: an implementation must be thread-safe and quick.
public protocol FileEventCursorStore: Sendable {
    func loadCursor(forKey key: String) -> FileEventCursor?
    func saveCursor(_ cursor: FileEventCursor, forKey key: String)
}

/// Cursors as small JSON files in one folder (`<key>.json`), written atomically.
public struct FileEventCursorFileStore: FileEventCursorStore {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    private func url(_ key: String) -> URL {
        let safe = key.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" || $0 == "." ? $0 : "_" }
        return directory.appendingPathComponent(String(safe) + ".json")
    }

    public func loadCursor(forKey key: String) -> FileEventCursor? {
        guard let data = try? Data(contentsOf: url(key)) else { return nil }
        return try? JSONDecoder().decode(FileEventCursor.self, from: data)
    }

    public func saveCursor(_ cursor: FileEventCursor, forKey key: String) {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(cursor).write(to: url(key), options: .atomic)
        } catch {
            GenesisKit.log("file event cursor not saved: \(error.localizedDescription)")
        }
    }
}

/// An FSEvents stream on its own serial queue that can continue where it stopped.
///
/// - Watch narrow roots (`$TMPDIR`, `/tmp`, a project folder). A file-level stream over all of `$HOME` makes
///   `fseventsd` grow; use `.directory` granularity there (it still sends one event per change, which this type
///   merges by path within a batch).
/// - `ignoreSelf` hides this process's own writes, not those of its child processes (a `tools` run).
/// - With a `cursorKey` and a store, the last event id and the volumes' FSEvents UUIDs are saved (at most every
///   `cursorSaveInterval`, and on `stop()`), and the next `start()` replays everything since then. A cursor that does
///   not fit the volume (another UUID, an id ahead of the system's) is dropped, and the first batch asks for a
///   rescan of every root with `historyInvalid`.
/// - Dropped events, wrapped ids and a moved root become `rescanRoots`; a consumer re-checks those folders instead
///   of trusting the event list, which Apple calls advisory.
/// - Batches are delivered on the stream's queue, off the main thread.
public final class FileEventStream: @unchecked Sendable {
    public enum Granularity: String, Codable, Equatable, Sendable {
        case file
        case directory
    }

    public struct Configuration: Equatable, Sendable {
        public var paths: [String]
        public var granularity: Granularity
        /// Seconds FSEvents gathers events before one callback.
        public var latency: TimeInterval
        public var ignoreSelf: Bool
        /// Reports a watched root that is moved or deleted.
        public var watchRoot: Bool
        /// Subfolders to leave out (FSEvents takes at most 8).
        public var excludedPaths: [String]
        /// Saves and replays the position under this key; nil starts from now every time.
        public var cursorKey: String?
        public var cursorSaveInterval: TimeInterval

        public init(paths: [String], granularity: Granularity = .file, latency: TimeInterval = 2, ignoreSelf: Bool = true,
                    watchRoot: Bool = true, excludedPaths: [String] = [], cursorKey: String? = nil,
                    cursorSaveInterval: TimeInterval = 30) {
            self.paths = paths
            self.granularity = granularity
            self.latency = latency
            self.ignoreSelf = ignoreSelf
            self.watchRoot = watchRoot
            self.excludedPaths = excludedPaths
            self.cursorKey = cursorKey
            self.cursorSaveInterval = cursorSaveInterval
        }
    }

    private final class Box {
        weak var stream: FileEventStream?

        init(_ stream: FileEventStream) {
            self.stream = stream
        }
    }

    public let configuration: Configuration
    private let cursorStore: FileEventCursorStore?
    private let onBatch: @Sendable (FileEventBatch) -> Void
    private let queue: DispatchQueue
    private let queueKey = DispatchSpecificKey<UInt8>()
    // Touched only on `queue`.
    private var stream: FSEventStreamRef?
    private var lastId: UInt64 = 0
    private var replaying = false
    private var lastCursorSave: Date?
    private var deviceUUIDs: [String] = []

    public init(configuration: Configuration, cursorStore: FileEventCursorStore? = nil,
                onBatch: @escaping @Sendable (FileEventBatch) -> Void) {
        self.configuration = configuration
        self.cursorStore = cursorStore
        self.onBatch = onBatch
        queue = DispatchQueue(label: "genesis.disk.file-events", qos: .utility)
        queue.setSpecific(key: queueKey, value: 1)
    }

    deinit {
        onQueue { stopOnQueue() }
    }

    public var isRunning: Bool { onQueue { stream != nil } }
    /// The last event id delivered (or replayed from); 0 before the first.
    public var lastEventId: UInt64 { onQueue { lastId } }

    /// The system's newest event id.
    public static var currentEventId: UInt64 { FSEventsGetCurrentEventId() }

    /// The FSEvents database UUID of the volume holding `path`; nil when the volume keeps no history.
    public static func deviceUUID(forPath path: String) -> String? {
        var info = stat()
        guard stat(path, &info) == 0, let uuid = FSEventsCopyUUIDForDevice(info.st_dev) else { return nil }
        return CFUUIDCreateString(nil, uuid) as String?
    }

    /// Starts the stream. False when FSEvents refused it (no existing path, too many streams).
    @discardableResult
    public func start() -> Bool {
        onQueue { startOnQueue() }
    }

    /// Stops the stream and saves the cursor. Safe from any thread, also from the batch callback.
    public func stop() {
        onQueue { stopOnQueue() }
    }

    /// Saves the cursor now.
    public func saveCursor() {
        onQueue { persistCursor(force: true) }
    }

    private func onQueue<T>(_ body: () -> T) -> T {
        DispatchQueue.getSpecific(key: queueKey) != nil ? body() : queue.sync(execute: body)
    }

    // MARK: - Queue side

    private func startOnQueue() -> Bool {
        guard stream == nil else { return true }
        let paths = configuration.paths.filter { !$0.isEmpty }
        guard !paths.isEmpty else { return false }
        deviceUUIDs = Array(Set(paths.compactMap(Self.deviceUUID(forPath:)))).sorted()
        var since = FSEventStreamEventId(kFSEventStreamEventIdSinceNow)
        var invalid = false
        if let key = configuration.cursorKey, let store = cursorStore, let cursor = store.loadCursor(forKey: key) {
            if Self.canReplay(cursor, deviceUUIDs: deviceUUIDs, currentId: Self.currentEventId) {
                since = FSEventStreamEventId(cursor.eventId)
                lastId = cursor.eventId
                replaying = true
            } else {
                invalid = true
            }
        }

        var flags = kFSEventStreamCreateFlagUseCFTypes
        if configuration.granularity == .file { flags |= kFSEventStreamCreateFlagFileEvents }
        if configuration.ignoreSelf { flags |= kFSEventStreamCreateFlagIgnoreSelf }
        if configuration.watchRoot { flags |= kFSEventStreamCreateFlagWatchRoot }
        let box = Unmanaged.passRetained(Box(self))
        var context = FSEventStreamContext(
            version: 0,
            info: box.toOpaque(),
            retain: nil,
            release: { info in
                if let info { Unmanaged<Box>.fromOpaque(info).release() }
            },
            copyDescription: nil
        )
        let callback: FSEventStreamCallback = { _, info, count, rawPaths, rawFlags, rawIds in
            guard let info, let owner = Unmanaged<Box>.fromOpaque(info).takeUnretainedValue().stream else { return }
            let list = unsafeBitCast(rawPaths, to: NSArray.self) as? [String] ?? []
            var raw: [(String, UInt32, UInt64)] = []
            raw.reserveCapacity(count)
            for index in 0 ..< min(count, list.count) {
                raw.append((list[index], rawFlags[index], rawIds[index]))
            }
            owner.deliver(raw)
        }
        guard let created = FSEventStreamCreate(nil, callback, &context, paths as CFArray, since,
                                                max(0.1, configuration.latency), FSEventStreamCreateFlags(flags))
        else {
            // No stream owns the context, so its release callback never runs.
            box.release()
            return false
        }
        let excluded = Array(configuration.excludedPaths.prefix(8))
        if !excluded.isEmpty { FSEventStreamSetExclusionPaths(created, excluded as CFArray) }
        FSEventStreamSetDispatchQueue(created, queue)
        guard FSEventStreamStart(created) else {
            FSEventStreamInvalidate(created)
            FSEventStreamRelease(created)
            return false
        }
        stream = created
        // Live from now: the position to save is the system's current id until the first event arrives.
        if !replaying, lastId == 0 { lastId = Self.currentEventId }
        if invalid {
            lastId = Self.currentEventId
            persistCursor(force: true)
            // On the stream's queue, after `start()` returned, never on the caller's thread.
            let batch = FileEventBatch(rescanRoots: Self.collapse(paths.map(DirectoryWatcher.normalizedEventPath)),
                                       historyInvalid: true, lastEventId: lastId)
            let onBatch = self.onBatch
            queue.async { onBatch(batch) }
        }
        return true
    }

    private func stopOnQueue() {
        guard let stream else { return }
        FSEventStreamStop(stream)
        FSEventStreamInvalidate(stream)
        FSEventStreamRelease(stream)
        self.stream = nil
        replaying = false
        persistCursor(force: true)
    }

    /// A cursor replays only on the same volumes and with an id the system has reached.
    static func canReplay(_ cursor: FileEventCursor, deviceUUIDs: [String], currentId: UInt64) -> Bool {
        !deviceUUIDs.isEmpty && cursor.deviceUUIDs.sorted() == deviceUUIDs && cursor.eventId > 0
            && cursor.eventId <= currentId
    }

    private func deliver(_ raw: [(String, UInt32, UInt64)]) {
        let batch = Self.makeBatch(raw, roots: configuration.paths, replaying: replaying)
        if batch.historyDone { replaying = false }
        if raw.contains(where: { FileEventFlags(rawValue: $0.1).contains(.eventIdsWrapped) }) {
            // Older ids are meaningless after a wrap; continue from the system's current one.
            lastId = Self.currentEventId
        } else if batch.lastEventId > lastId {
            lastId = batch.lastEventId
        }
        persistCursor(force: false)
        if !batch.isEmpty { onBatch(batch) }
    }

    private func persistCursor(force: Bool) {
        guard let key = configuration.cursorKey, let store = cursorStore, lastId > 0, !deviceUUIDs.isEmpty else { return }
        let now = Date()
        if !force, let lastCursorSave, now.timeIntervalSince(lastCursorSave) < configuration.cursorSaveInterval { return }
        lastCursorSave = now
        store.saveCursor(FileEventCursor(eventId: lastId, deviceUUIDs: deviceUUIDs, savedAt: now), forKey: key)
    }

    /// Turns one callback's raw events into a batch: paths normalized (`/private/var` is `/var`), merged per path,
    /// and every flag that means "the list is incomplete" turned into folders to rescan.
    static func makeBatch(_ raw: [(path: String, flags: UInt32, id: UInt64)], roots: [String],
                          replaying: Bool) -> FileEventBatch {
        var batch = FileEventBatch(isReplay: replaying)
        var index: [String: Int] = [:]
        var rescan: [String] = []
        let normalizedRoots = roots.map(DirectoryWatcher.normalizedEventPath)
        for (rawPath, rawFlags, id) in raw {
            let flags = FileEventFlags(rawValue: rawFlags)
            let path = DirectoryWatcher.normalizedEventPath(rawPath)
            if id > batch.lastEventId { batch.lastEventId = id }
            if flags.contains(.historyDone) {
                batch.historyDone = true
                continue
            }
            if !flags.isDisjoint(with: .dropped) {
                batch.dropped = true
                rescan.append(contentsOf: normalizedRoots)
                continue
            }
            if flags.contains(.eventIdsWrapped) {
                rescan.append(contentsOf: normalizedRoots)
                continue
            }
            if flags.contains(.rootChanged) {
                rescan.append(path)
                continue
            }
            if flags.contains(.mustScanSubDirs) || flags.contains(.mount) || flags.contains(.unmount) {
                rescan.append(path)
                continue
            }
            if let at = index[path] {
                batch.events[at].flags.formUnion(flags)
                batch.events[at].id = max(batch.events[at].id, id)
            } else {
                index[path] = batch.events.count
                batch.events.append(FileEvent(path: path, flags: flags, id: id))
            }
        }
        batch.rescanRoots = collapse(rescan)
        return batch
    }

    /// Unique folders with any folder inside another one left out.
    static func collapse(_ paths: [String]) -> [String] {
        var result: [String] = []
        for path in paths.sorted() where !path.isEmpty {
            let trimmed = path.count > 1 && path.hasSuffix("/") ? String(path.dropLast()) : path
            // Every kept root, not only the last: "/a/b.old" sorts between "/a/b" and "/a/b/c".
            if result.contains(where: { trimmed == $0 || trimmed.hasPrefix($0 == "/" ? "/" : $0 + "/") }) { continue }
            result.append(trimmed)
        }
        return result
    }
}
