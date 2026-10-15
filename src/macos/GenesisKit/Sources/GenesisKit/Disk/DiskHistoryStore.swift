import Foundation

/// One stored free-space reading.
public struct DiskHistoryPoint: Codable, Equatable, Sendable {
    public var date: Date
    public var available: Int64
    public var free: Int64
    public var total: Int64

    public init(date: Date, available: Int64, free: Int64, total: Int64) {
        self.date = date
        self.available = available
        self.free = free
        self.total = total
    }

    public init(_ sample: VolumeSample) {
        self.init(date: sample.date, available: sample.available, free: sample.free, total: sample.total)
    }

    enum CodingKeys: String, CodingKey {
        case date = "t"
        case available = "a"
        case free = "f"
        case total = "T"
    }
}

/// Something that changed the disk on purpose, for markers on the history chart: a reclaim, a clone apply.
public struct DiskHistoryEvent: Codable, Equatable, Sendable {
    public var date: Date
    /// `reclaim`, `clones`, `trash` or the host's own word.
    public var kind: String
    public var label: String
    /// Bytes the action reported (or the settled gain).
    public var bytes: Int64
    public var availableBefore: Int64?
    public var availableAfter: Int64?

    public init(date: Date, kind: String, label: String, bytes: Int64, availableBefore: Int64? = nil,
                availableAfter: Int64? = nil) {
        self.date = date
        self.kind = kind
        self.label = label
        self.bytes = bytes
        self.availableBefore = availableBefore
        self.availableAfter = availableAfter
    }
}

/// Free-space history and reclaim markers in two append-only NDJSON files in a host-given folder
/// (`samples.ndjson`, `events.ndjson`). An append writes one short line; every `compactEvery` appends, or when the
/// file outgrows `maxSampleBytes`, the samples are rewritten downsampled (full resolution for a day, the lowest
/// reading per hour for `hourlyFor`, per day up to `keepFor`) through a temporary file and a rename.
///
/// A file it cannot read, or cannot parse (more than a tenth of its lines broken, or no readable line at all), is
/// never rewritten: `health` turns `.unreadable`, appends stop and the original bytes stay for the user to repair or
/// remove. Only a missing file starts an empty history. A broken last line (a write cut short) is dropped quietly at
/// the next compaction, and the next append starts on a new line.
///
/// One store per folder: two processes appending to and compacting the same folder can drop each other's lines.
public actor DiskHistoryStore {
    public struct Limits: Equatable, Sendable {
        /// A reading closer than this to the last stored one is skipped, unless free space moved `minimumChange`.
        public var minimumSpacing: TimeInterval
        public var minimumChange: Int64
        public var fullResolution: TimeInterval
        public var hourlyFor: TimeInterval
        public var keepFor: TimeInterval
        public var maxSampleBytes: Int
        public var maxEvents: Int
        public var compactEvery: Int

        public init(minimumSpacing: TimeInterval = 60, minimumChange: Int64 = 100_000_000,
                    fullResolution: TimeInterval = 86_400, hourlyFor: TimeInterval = 30 * 86_400,
                    keepFor: TimeInterval = 400 * 86_400, maxSampleBytes: Int = 1_000_000, maxEvents: Int = 1000,
                    compactEvery: Int = 240) {
            self.minimumSpacing = minimumSpacing
            self.minimumChange = minimumChange
            self.fullResolution = fullResolution
            self.hourlyFor = hourlyFor
            self.keepFor = keepFor
            self.maxSampleBytes = maxSampleBytes
            self.maxEvents = maxEvents
            self.compactEvery = compactEvery
        }
    }

    public enum Health: Equatable, Sendable {
        case ok
        /// The file named could not be parsed; nothing is written to it.
        case unreadable(String)
    }

    public let directory: URL
    public let limits: Limits
    public private(set) var health: Health = .ok

    private var loaded = false
    private var points: [DiskHistoryPoint] = []
    private var events: [DiskHistoryEvent] = []
    private var appendsSinceCompaction = 0
    private var samplesBroken = false
    private var eventsBroken = false
    private var compactionFailed = false

    public init(directory: URL, limits: Limits = Limits()) {
        self.directory = directory
        self.limits = limits
    }

    private var samplesURL: URL { directory.appendingPathComponent("samples.ndjson") }
    private var eventsURL: URL { directory.appendingPathComponent("events.ndjson") }

    /// Stores a reading unless it is too close to the last one. Returns whether it was stored.
    @discardableResult
    public func append(_ sample: VolumeSample) throws -> Bool {
        try load()
        guard !samplesBroken else { return false }
        let point = DiskHistoryPoint(sample)
        if let last = points.last, point.date.timeIntervalSince(last.date) < limits.minimumSpacing,
           abs(point.available - last.available) < limits.minimumChange {
            return false
        }
        try appendLine(point, to: samplesURL)
        points.append(point)
        appendsSinceCompaction += 1
        let oversized = !compactionFailed && fileSize(samplesURL) > limits.maxSampleBytes
        if appendsSinceCompaction >= limits.compactEvery || oversized {
            // A failed rewrite (a full disk) waits for the next `compactEvery` appends instead of retrying on each.
            appendsSinceCompaction = 0
            do {
                try compact(now: point.date)
                compactionFailed = false
            } catch {
                compactionFailed = true
                throw error
            }
        }
        return true
    }

    public func record(_ event: DiskHistoryEvent) throws {
        try load()
        guard !eventsBroken else { return }
        try appendLine(event, to: eventsURL)
        events.append(event)
        if events.count > limits.maxEvents + limits.maxEvents / 10 {
            events = Array(events.suffix(limits.maxEvents))
            try rewrite(events, to: eventsURL)
        }
    }

    public func points(since: Date? = nil) throws -> [DiskHistoryPoint] {
        try load()
        guard let since else { return points }
        return points.filter { $0.date >= since }
    }

    public func events(since: Date? = nil) throws -> [DiskHistoryEvent] {
        try load()
        guard let since else { return events }
        return events.filter { $0.date >= since }
    }

    /// Rewrites the samples downsampled. A no-op while the file is unreadable.
    public func compact(now: Date = Date()) throws {
        try load()
        guard !samplesBroken else { return }
        points = Self.downsample(points, now: now, limits: limits)
        try rewrite(points, to: samplesURL)
        appendsSinceCompaction = 0
    }

    /// Full resolution inside `fullResolution`, then the lowest reading per hour, then per day; older ones go.
    public static func downsample(_ points: [DiskHistoryPoint], now: Date, limits: Limits) -> [DiskHistoryPoint] {
        var kept: [DiskHistoryPoint] = []
        var bucketKey: Int64?
        var bucketBest: DiskHistoryPoint?
        func flush() {
            if let best = bucketBest { kept.append(best) }
            bucketBest = nil
            bucketKey = nil
        }
        for point in points.sorted(by: { $0.date < $1.date }) {
            let age = now.timeIntervalSince(point.date)
            if age > limits.keepFor { continue }
            if age <= limits.fullResolution {
                flush()
                kept.append(point)
                continue
            }
            let daily = age > limits.hourlyFor
            let width: TimeInterval = daily ? 86_400 : 3600
            // The bucket index, tagged with its width, so an hour and a day starting at the same second differ.
            let key = Int64((point.date.timeIntervalSince1970 / width).rounded(.down)) * 2 + (daily ? 1 : 0)
            if key != bucketKey { flush() }
            bucketKey = key
            if bucketBest == nil || point.available < bucketBest!.available { bucketBest = point }
        }
        flush()
        return kept
    }

    // MARK: - Files

    private func load() throws {
        guard !loaded else { return }
        loaded = true
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let samples: (values: [DiskHistoryPoint], broken: Bool) = parse(samplesURL)
        points = samples.values
        samplesBroken = samples.broken
        let marks: (values: [DiskHistoryEvent], broken: Bool) = parse(eventsURL)
        events = marks.values
        eventsBroken = marks.broken
        if samplesBroken {
            health = .unreadable(samplesURL.path)
        } else if eventsBroken {
            health = .unreadable(eventsURL.path)
        }
    }

    /// Only a missing file is an empty history. A read error (permissions, I/O, a file not downloaded) and a
    /// non-empty file without one readable line count as broken, so they are never overwritten.
    private func parse<Value: Decodable>(_ url: URL) -> (values: [Value], broken: Bool) {
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            let cocoa = error as NSError
            let missing = cocoa.domain == NSCocoaErrorDomain && cocoa.code == NSFileReadNoSuchFileError
            return ([], !missing)
        }
        guard let text = String(data: data, encoding: .utf8) else { return ([], true) }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .secondsSince1970
        var values: [Value] = []
        var bad = 0
        let lines = text.split(separator: "\n", omittingEmptySubsequences: true)
        for (index, line) in lines.enumerated() {
            if let value = try? decoder.decode(Value.self, from: Data(line.utf8)) {
                values.append(value)
            } else if index != lines.count - 1 {
                bad += 1
            }
        }
        let unreadable = values.isEmpty && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return (values, unreadable || (bad > 0 && bad * 10 > lines.count))
    }

    private func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .secondsSince1970
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }

    /// Appends one line. A file whose last write was cut short (no final newline) gets a newline first, so the
    /// fragment stays one bad line instead of swallowing the new one.
    private func appendLine<Value: Encodable>(_ value: Value, to url: URL) throws {
        var line = try encoder().encode(value)
        line.append(0x0A)
        if !FileManager.default.fileExists(atPath: url.path) {
            try line.write(to: url)
            return
        }
        let handle = try FileHandle(forUpdating: url)
        defer { try? handle.close() }
        let end = try handle.seekToEnd()
        if end > 0 {
            try handle.seek(toOffset: end - 1)
            if handle.readData(ofLength: 1) != Data([0x0A]) { line.insert(0x0A, at: 0) }
            try handle.seekToEnd()
        }
        try handle.write(contentsOf: line)
    }

    private func rewrite<Value: Encodable>(_ values: [Value], to url: URL) throws {
        let encoder = encoder()
        var data = Data()
        for value in values {
            data.append(try encoder.encode(value))
            data.append(0x0A)
        }
        try data.write(to: url, options: .atomic)
    }

    private func fileSize(_ url: URL) -> Int {
        ((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
    }
}
