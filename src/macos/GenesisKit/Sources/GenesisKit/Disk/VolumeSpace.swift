import AppKit
import Darwin
import Foundation

/// macOS's own low-space level for the volumes, from the kernel's `EVFILT_FS` events (VQ_* flags). The kernel names
/// no volume, so the level is system-wide: a nearly full USB stick or disk image also reports `.low`, and the
/// sample of the Data volume carries it. It is `unknown` until the first event arrives (the per-volume query,
/// `VFS_CTL_QUERY`, needs root). Use the byte figures for decisions and the level as a hint.
public enum VolumeLowDiskLevel: String, Codable, Equatable, Sendable {
    case unknown
    /// Free space reached macOS's desired level again (VQ_DESIRED_DISK).
    case ok
    /// Above macOS's low mark but below its desired level (VQ_NEARLOWDISK).
    case nearLow
    /// Below macOS's low mark, 10 GiB on a large disk (VQ_LOWDISK). macOS starts purging.
    case low
    /// Very low (VQ_VERYLOWDISK): macOS purges at its highest urgency.
    case veryLow

    static let vqLowDisk: UInt32 = 0x0004
    static let vqVeryLowDisk: UInt32 = 0x0200
    static let vqNearLowDisk: UInt32 = 0x2000
    static let vqDesiredDisk: UInt32 = 0x4000

    /// The level an `EVFILT_FS` event's `fflags` report; nil for an event that names no level (a mount, an update).
    public static func from(fsEventFlags flags: UInt32) -> VolumeLowDiskLevel? {
        if flags & vqVeryLowDisk != 0 { return .veryLow }
        if flags & vqLowDisk != 0 { return .low }
        if flags & vqNearLowDisk != 0 { return .nearLow }
        if flags & vqDesiredDisk != 0 { return .ok }
        return nil
    }
}

/// One reading of a volume's space. `free` and `available` come from `statfs` (what `df` shows; on APFS both are the
/// container's unallocated space). `importantUsage` is Finder's "Available" (free plus purgeable), read only by
/// `VolumeSpaceMonitor.refreshDetailed()` because it costs about 10 ms of CPU and many log lines per read.
public struct VolumeSample: Codable, Equatable, Sendable {
    public var volumePath: String
    public var total: Int64
    public var free: Int64
    public var available: Int64
    public var importantUsage: Int64?
    public var lowDiskLevel: VolumeLowDiskLevel
    public var date: Date

    public init(volumePath: String, total: Int64, free: Int64, available: Int64, importantUsage: Int64? = nil,
                lowDiskLevel: VolumeLowDiskLevel = .unknown, date: Date) {
        self.volumePath = volumePath
        self.total = total
        self.free = free
        self.available = available
        self.importantUsage = importantUsage
        self.lowDiskLevel = lowDiskLevel
        self.date = date
    }

    /// Used bytes as a fraction of `total`, computed here because `df`'s percent is per volume on APFS.
    public var usedFraction: Double {
        total > 0 ? Double(total - available) / Double(total) : 0
    }

    /// Whether `other` differs by at least `minimumChange` bytes in a space figure, or in the level or the volume.
    public func differs(from other: VolumeSample, minimumChange: Int64) -> Bool {
        if volumePath != other.volumePath || total != other.total || lowDiskLevel != other.lowDiskLevel { return true }
        if abs(available - other.available) >= minimumChange || abs(free - other.free) >= minimumChange { return true }
        switch (importantUsage, other.importantUsage) {
        case let (mine?, theirs?): return abs(mine - theirs) >= minimumChange
        case (nil, nil): return false
        default: return true
        }
    }
}

/// A mounted volume for a volume picker.
public struct DiskVolume: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var path: String
    public var name: String
    public var total: Int64
    public var available: Int64
    public var isInternal: Bool
    public var isRoot: Bool

    public var id: String { path }

    public init(path: String, name: String, total: Int64, available: Int64, isInternal: Bool, isRoot: Bool) {
        self.path = path
        self.name = name
        self.total = total
        self.available = available
        self.isInternal = isInternal
        self.isRoot = isRoot
    }
}

/// The checks after a reclaim: APFS frees large deletes over several transactions and clone-shared blocks only with
/// their last copy, so free space keeps rising for minutes. `gained` is what returned so far.
public struct SpaceSettling: Equatable, Sendable {
    public var label: String
    public var started: Date
    public var baselineAvailable: Int64
    public var latestAvailable: Int64
    public var checksDone: Int
    public var checksTotal: Int
    public var finished: Bool

    public init(label: String, started: Date, baselineAvailable: Int64, latestAvailable: Int64, checksDone: Int,
                checksTotal: Int, finished: Bool) {
        self.label = label
        self.started = started
        self.baselineAvailable = baselineAvailable
        self.latestAvailable = latestAvailable
        self.checksDone = checksDone
        self.checksTotal = checksTotal
        self.finished = finished
    }

    public var gained: Int64 { latestAvailable - baselineAvailable }
}

/// Watches one volume's free space at near-zero idle cost.
///
/// - Every sample is one `statfs` (about half a microsecond), on a private utility queue, never on the main thread.
/// - It wakes on events first: the kernel's low-disk events (`EVFILT_FS`, unprivileged), wake from sleep, a mount
///   or unmount, and `poke()` (an FSEvents burst). A `DispatchSourceTimer` with 10% leeway is the backstop: every
///   `farInterval` (300 s) far from the floor, every `nearInterval` (30 s) within `nearBand` of it.
/// - It publishes on the main actor only when a figure moved by `minimumChange` or the level changed.
/// - `refreshDetailed()` adds the important-usage figure on demand (while a page is visible), never on the timer.
/// - `beginSettling(label:)` re-reads after 5 s, 30 s, 2, 5, 15 and 20 minutes after a reclaim and publishes
///   `settling`, so the UI can say "space returning" instead of "0 bytes freed".
@MainActor
public final class VolumeSpaceMonitor: ObservableObject {
    public struct Configuration: Equatable, Sendable {
        public var volumePath: String
        /// The free-space floor the cadence adapts to (the app's warning tier).
        public var floor: Int64
        /// Within this many bytes above `floor` the timer runs at `nearInterval`.
        public var nearBand: Int64
        public var farInterval: TimeInterval
        public var nearInterval: TimeInterval
        /// A change smaller than this in every figure is not published.
        public var minimumChange: Int64
        /// Two pokes closer than this become one sample.
        public var pokeSpacing: TimeInterval
        /// Seconds after `beginSettling` at which the volume is read again.
        public var settleSchedule: [TimeInterval]
        public var watchesLowDiskEvents: Bool
        public var watchesWorkspace: Bool

        public init(volumePath: String = VolumeSpaceMonitor.defaultVolumePath, floor: Int64 = 10_000_000_000,
                    nearBand: Int64 = 5_000_000_000, farInterval: TimeInterval = 300, nearInterval: TimeInterval = 30,
                    minimumChange: Int64 = 1_000_000, pokeSpacing: TimeInterval = 2,
                    settleSchedule: [TimeInterval] = [5, 30, 120, 300, 900, 1200],
                    watchesLowDiskEvents: Bool = true, watchesWorkspace: Bool = true) {
            self.volumePath = volumePath
            self.floor = floor
            self.nearBand = nearBand
            self.farInterval = farInterval
            self.nearInterval = nearInterval
            self.minimumChange = minimumChange
            self.pokeSpacing = pokeSpacing
            self.settleSchedule = settleSchedule
            self.watchesLowDiskEvents = watchesLowDiskEvents
            self.watchesWorkspace = watchesWorkspace
        }

        /// The timer interval for a reading of `available` bytes.
        public func interval(forAvailable available: Int64) -> TimeInterval {
            available < floor + nearBand ? max(1, nearInterval) : max(1, farInterval)
        }
    }

    /// The APFS data volume when it exists (its `statfs` is the container's free space and the volume's total),
    /// else `/`.
    nonisolated public static var defaultVolumePath: String {
        FileManager.default.fileExists(atPath: "/System/Volumes/Data") ? "/System/Volumes/Data" : "/"
    }

    @Published public private(set) var sample: VolumeSample?
    @Published public private(set) var settling: SpaceSettling?
    /// Called on the main actor with every published sample (alerts, history).
    public var onSample: ((VolumeSample) -> Void)?

    /// Applies at once, `watchesWorkspace` included.
    public var configuration: Configuration {
        didSet {
            guard configuration != oldValue else { return }
            if configuration.volumePath != oldValue.volumePath {
                volumeGeneration &+= 1
                sample = nil
                endSettling()
            }
            sampler.update(configuration, generation: volumeGeneration)
            if running, configuration.watchesWorkspace != oldValue.watchesWorkspace {
                if configuration.watchesWorkspace { observeWorkspace() } else { observers.removeAll() }
            }
        }
    }

    private let sampler: VolumeSampler
    private let observers = WorkspaceObservers()
    private var settleGeneration = 0
    private var volumeGeneration = 0
    /// The main actor's own copy, so no main-actor call waits on the queue that runs `statfs` (a network volume
    /// whose server went away can hold it for tens of seconds).
    private var running = false

    public init(configuration: Configuration = Configuration()) {
        self.configuration = configuration
        sampler = VolumeSampler(configuration: configuration)
        sampler.publish = { [weak self] reading, generation in
            Task { @MainActor [weak self] in
                guard let self, self.running else { return }
                self.receive(reading, generation: generation)
            }
        }
    }

    public var isRunning: Bool { running }

    /// Starts sampling: one read now, then on events and the backstop timer.
    public func start() {
        guard !running else { return }
        running = true
        sampler.start()
        if configuration.watchesWorkspace { observeWorkspace() }
    }

    /// Stops sampling. It never waits for a read in progress.
    public func stop() {
        running = false
        sampler.stop()
        observers.removeAll()
        settleGeneration &+= 1
    }

    private func observeWorkspace() {
        observers.removeAll()
        let center = NSWorkspace.shared.notificationCenter
        for name in [NSWorkspace.didWakeNotification, NSWorkspace.didMountNotification,
                     NSWorkspace.didUnmountNotification] {
            observers.add(center.addObserver(forName: name, object: nil, queue: nil) { [weak self] _ in
                Task { @MainActor [weak self] in self?.poke() }
            })
        }
    }

    /// Asks for a sample soon (an FSEvents burst, a finished command). Pokes closer than `pokeSpacing` coalesce.
    public func poke() {
        sampler.poke()
    }

    /// Reads now with the important-usage figure (Finder's "Available"). Call it while a page that shows the
    /// figure is visible, not on a timer. nil when the volume cannot be read.
    @discardableResult
    public func refreshDetailed() async -> VolumeSample? {
        await refreshDetailed { path, level in
            await Task.detached(priority: .utility) { () -> VolumeSample? in
                guard var reading = try? Self.read(path: path, level: level) else { return nil }
                reading.importantUsage = Self.readImportantUsage(path: path)
                return reading
            }.value
        }
    }

    func refreshDetailed(read: @Sendable (String, VolumeLowDiskLevel) async -> VolumeSample?) async -> VolumeSample? {
        let generation = volumeGeneration
        let reading = await read(configuration.volumePath, sample?.lowDiskLevel ?? .unknown)
        guard generation == volumeGeneration else { return nil }
        if let reading { receive(reading, generation: generation, force: true) }
        return reading
    }

    /// Starts the checks after a reclaim. `baseline` is the reading before the reclaim; nil uses the last sample.
    public func beginSettling(label: String, baseline: VolumeSample? = nil) {
        guard let base = baseline ?? sample else { return }
        settleGeneration &+= 1
        let generation = settleGeneration
        let volumeGeneration = volumeGeneration
        let schedule = configuration.settleSchedule.sorted()
        settling = SpaceSettling(label: label, started: Date(), baselineAvailable: base.available,
                                 latestAvailable: base.available, checksDone: 0, checksTotal: schedule.count,
                                 finished: schedule.isEmpty)
        sampler.settle(after: schedule) { [weak self] reading, index in
            Task { @MainActor [weak self] in
                guard let self, self.settleGeneration == generation, var progress = self.settling else { return }
                progress.latestAvailable = reading.available
                progress.checksDone = index + 1
                progress.finished = index + 1 >= schedule.count
                if self.settling != progress { self.settling = progress }
                self.receive(reading, generation: volumeGeneration)
            }
        }
    }

    /// Clears a finished or abandoned settling state.
    public func endSettling() {
        settleGeneration &+= 1
        if settling != nil { settling = nil }
    }

    func receive(_ reading: VolumeSample, generation: Int, force: Bool = false) {
        guard generation == volumeGeneration, reading.volumePath == configuration.volumePath else { return }
        var next = reading
        if next.importantUsage == nil, let sample, sample.volumePath == next.volumePath,
           let important = sample.importantUsage {
            // The last detailed read's purgeable part rides along, so Finder's figure stays shown between reads.
            next.importantUsage = next.available + max(0, important - sample.available)
        }
        if !force, let sample, !next.differs(from: sample, minimumChange: configuration.minimumChange) { return }
        if sample != next { sample = next }
        onSample?(next)
    }

    // MARK: - Readers (any thread)

    /// One `statfs` of `path`. Cheap enough for any cadence.
    nonisolated public static func read(path: String, level: VolumeLowDiskLevel = .unknown,
                                        date: Date = Date()) throws -> VolumeSample {
        var info = statfs()
        guard statfs(path, &info) == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
        }
        let block = Int64(info.f_bsize)
        return VolumeSample(volumePath: path, total: Int64(info.f_blocks) * block, free: Int64(info.f_bfree) * block,
                            available: Int64(info.f_bavail) * block, lowDiskLevel: level, date: date)
    }

    /// Finder's "Available": free plus what macOS can purge. Costs about 10 ms of CPU and many unified-log lines,
    /// so call it on demand only. Never the opportunistic figure, which is far below free and unusable as a floor.
    nonisolated public static func readImportantUsage(path: String) -> Int64? {
        let values = try? URL(fileURLWithPath: path).resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    /// The mounted, browsable volumes. Reads each volume's capacity, so call it off the main thread. Network
    /// volumes are left out unless `includingNetwork`: reading one whose server went away blocks for tens of seconds.
    nonisolated public static func mountedVolumes(includingNetwork: Bool = false) -> [DiskVolume] {
        let keys: [URLResourceKey] = [.volumeNameKey, .volumeTotalCapacityKey, .volumeAvailableCapacityKey,
                                      .volumeIsInternalKey, .volumeIsRootFileSystemKey, .volumeIsLocalKey]
        let urls = FileManager.default.mountedVolumeURLs(includingResourceValuesForKeys: [.volumeIsLocalKey],
                                                         options: [.skipHiddenVolumes]) ?? []
        return urls.compactMap { url in
            if !includingNetwork, (try? url.resourceValues(forKeys: [.volumeIsLocalKey]))?.volumeIsLocal == false {
                return nil
            }
            guard let values = try? url.resourceValues(forKeys: Set(keys)) else { return nil }
            let isRoot = values.volumeIsRootFileSystem ?? false
            // The sealed system volume reports its own small total; the data volume carries the user's numbers.
            let path = isRoot ? defaultVolumePath : url.path
            let reading = try? read(path: path)
            return DiskVolume(path: path, name: values.volumeName ?? url.lastPathComponent,
                              total: reading?.total ?? Int64(values.volumeTotalCapacity ?? 0),
                              available: reading?.available ?? Int64(values.volumeAvailableCapacity ?? 0),
                              isInternal: values.volumeIsInternal ?? false, isRoot: isRoot)
        }
    }
}

/// The workspace observer tokens; removed on `removeAll()` and when the monitor goes away.
final class WorkspaceObservers: @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [NSObjectProtocol] = []

    func add(_ token: NSObjectProtocol) {
        lock.lock()
        tokens.append(token)
        lock.unlock()
    }

    func removeAll() {
        lock.lock()
        let current = tokens
        tokens = []
        lock.unlock()
        let center = NSWorkspace.shared.notificationCenter
        for token in current { center.removeObserver(token) }
    }

    deinit { removeAll() }
}

/// The queue side of `VolumeSpaceMonitor`: the timer, the kqueue source and the reads. Every mutable field is
/// touched only on `queue`.
final class VolumeSampler: @unchecked Sendable {
    private let queue = DispatchQueue(label: "genesis.disk.volume-sampler", qos: .utility)
    private var configuration: VolumeSpaceMonitor.Configuration
    private var timer: DispatchSourceTimer?
    private var lowDiskSource: DispatchSourceRead?
    private var currentInterval: TimeInterval = 0
    private var lastRead: Date?
    private var pokePending = false
    private var running = false
    private var level: VolumeLowDiskLevel = .unknown
    private var settleToken = 0
    private var generation = 0
    var publish: (@Sendable (VolumeSample, Int) -> Void)?

    init(configuration: VolumeSpaceMonitor.Configuration) {
        self.configuration = configuration
    }

    /// A monitor released without `stop()` still leaves no timer or kqueue source behind.
    deinit {
        timer?.cancel()
        lowDiskSource?.cancel()
    }

    func start() {
        queue.async { [self] in
            guard !running else { return }
            running = true
            if configuration.watchesLowDiskEvents { startLowDiskSource() }
            sampleNow()
        }
    }

    func stop() {
        queue.async { [self] in
            running = false
            timer?.cancel()
            timer = nil
            lowDiskSource?.cancel()
            lowDiskSource = nil
            currentInterval = 0
            settleToken &+= 1
        }
    }

    func update(_ configuration: VolumeSpaceMonitor.Configuration, generation: Int) {
        queue.async { [self] in
            self.generation = generation
            let restartEvents = configuration.watchesLowDiskEvents != self.configuration.watchesLowDiskEvents
            self.configuration = configuration
            guard running else { return }
            if restartEvents {
                lowDiskSource?.cancel()
                lowDiskSource = nil
                if configuration.watchesLowDiskEvents { startLowDiskSource() }
            }
            currentInterval = 0
            sampleNow()
        }
    }

    func poke() {
        queue.async { [self] in
            guard running, !pokePending else { return }
            let spacing = max(0, configuration.pokeSpacing)
            let wait = lastRead.map { spacing - Date().timeIntervalSince($0) } ?? 0
            if wait <= 0 {
                sampleNow()
            } else {
                pokePending = true
                queue.asyncAfter(deadline: .now() + wait) { [weak self] in
                    guard let self else { return }
                    pokePending = false
                    if running { sampleNow() }
                }
            }
        }
    }

    func settle(after schedule: [TimeInterval], _ onReading: @escaping @Sendable (VolumeSample, Int) -> Void) {
        queue.async { [self] in
            settleToken &+= 1
            let token = settleToken
            for (index, delay) in schedule.enumerated() {
                // Weak, so a monitor released while settling does not keep the sampler for 20 minutes.
                queue.asyncAfter(deadline: .now() + max(0, delay)) { [weak self] in
                    guard let self, settleToken == token,
                          let reading = try? VolumeSpaceMonitor.read(path: configuration.volumePath, level: level)
                    else { return }
                    lastRead = reading.date
                    onReading(reading, index)
                }
            }
        }
    }

    /// One read, then the timer is set for the cadence the reading calls for.
    private func sampleNow() {
        lastRead = Date()
        guard let reading = try? VolumeSpaceMonitor.read(path: configuration.volumePath, level: level) else {
            schedule(interval: configuration.farInterval)
            return
        }
        publish?(reading, generation)
        schedule(interval: configuration.interval(forAvailable: reading.available))
    }

    private func schedule(interval: TimeInterval) {
        if timer == nil {
            let source = DispatchSource.makeTimerSource(queue: queue)
            source.setEventHandler { [weak self] in self?.sampleNow() }
            source.resume()
            timer = source
        }
        currentInterval = interval
        // Rescheduled after every read, so an event-driven read pushes the backstop out by a full interval.
        timer?.schedule(deadline: .now() + interval, repeating: interval,
                        leeway: .milliseconds(Int(max(1, interval * 0.1) * 1000)))
    }

    /// The kernel's file-system events: low-disk level changes, mounts, unmounts. A kqueue descriptor becomes
    /// readable when an event is queued; the handler drains it without blocking.
    private func startLowDiskSource() {
        let kq = kqueue()
        guard kq >= 0 else { return }
        var change = kevent(ident: 0, filter: Int16(EVFILT_FS), flags: UInt16(EV_ADD | EV_ENABLE | EV_CLEAR),
                            fflags: 0, data: 0, udata: nil)
        guard kevent(kq, &change, 1, nil, 0, nil) == 0 else {
            close(kq)
            return
        }
        let source = DispatchSource.makeReadSource(fileDescriptor: kq, queue: queue)
        source.setEventHandler { [weak self] in
            guard let self else { return }
            var event = kevent()
            var zero = timespec(tv_sec: 0, tv_nsec: 0)
            var sawEvent = false
            while kevent(kq, nil, 0, &event, 1, &zero) > 0 {
                sawEvent = true
                if let next = VolumeLowDiskLevel.from(fsEventFlags: event.fflags) { self.level = next }
            }
            if sawEvent, self.running { self.sampleNow() }
        }
        source.setCancelHandler { close(kq) }
        source.resume()
        lowDiskSource = source
    }

    /// Whether the kernel accepts an `EVFILT_FS` registration from this process (no privileges needed).
    static func canWatchLowDiskEvents() -> Bool {
        let kq = kqueue()
        guard kq >= 0 else { return false }
        defer { close(kq) }
        var change = kevent(ident: 0, filter: Int16(EVFILT_FS), flags: UInt16(EV_ADD | EV_ENABLE | EV_CLEAR),
                            fflags: 0, data: 0, udata: nil)
        return kevent(kq, &change, 1, nil, 0, nil) == 0
    }
}
