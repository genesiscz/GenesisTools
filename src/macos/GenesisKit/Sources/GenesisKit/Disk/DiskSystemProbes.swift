import Darwin
import Foundation

public extension AlertPolicy {
    /// The free-space default: Watch under 10 GB (macOS's own low mark is 10 GiB), Low under 3 GB, Critical under
    /// 1 GB. A tier arms after two consecutive samples and ends only above 1.5 times its floor; Critical
    /// (`.emergency`) breaks through quiet hours and a snooze.
    static func freeSpace(watch: Int64 = 10_000_000_000, low: Int64 = 3_000_000_000, critical: Int64 = 1_000_000_000,
                          repeatInterval: TimeInterval? = 3600, quietHours: AlertQuietHours? = nil) -> AlertPolicy {
        AlertPolicy(direction: .below, tiers: [
            AlertTier(id: "watch", threshold: Double(watch), severity: .warning),
            AlertTier(id: "low", threshold: Double(low), severity: .critical),
            AlertTier(id: "critical", threshold: Double(critical), severity: .emergency),
        ], hysteresisFraction: 0.5, repeatInterval: repeatInterval, quietHours: quietHours,
        emergencyOverride: .emergency, confirmSamples: 2)
    }
}

/// `fseventsd`'s memory and CPU time, read through `ps` (libproc answers EPERM for this daemon). A disk walk waits
/// while it is hot: it grew to 13.5 GB once while a watcher covered all of `$HOME`.
public struct FseventsdHealth: Equatable, Sendable {
    public var pid: Int32
    public var rssBytes: Int64
    /// Total CPU time the daemon used since it started.
    public var cpuSeconds: Double
    public var date: Date

    public init(pid: Int32, rssBytes: Int64, cpuSeconds: Double, date: Date) {
        self.pid = pid
        self.rssBytes = rssBytes
        self.cpuSeconds = cpuSeconds
        self.date = date
    }

    /// One `ps` run (about 20 ms, blocking): call it off the main thread. nil when the daemon was not found.
    public static func read(now: Date = Date()) -> FseventsdHealth? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/ps")
        process.arguments = ["-axo", "pid=,rss=,time=,comm="]
        process.standardInput = FileHandle.nullDevice
        guard let capture = try? process.runCapturing(timeout: 5), capture.status == 0 else { return nil }
        return parse(psOutput: String(decoding: capture.stdout, as: UTF8.self), now: now)
    }

    /// The `fseventsd` line of `ps -axo pid=,rss=,time=,comm=` output.
    public static func parse(psOutput: String, now: Date) -> FseventsdHealth? {
        for line in psOutput.split(separator: "\n") {
            let fields = line.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
            guard fields.count == 4, fields[3].hasSuffix("fseventsd"),
                  fields[3] == "fseventsd" || fields[3].hasSuffix("/fseventsd"),
                  let pid = Int32(fields[0]), let rssKiB = Int64(fields[1]), let cpu = cpuSeconds(String(fields[2]))
            else { continue }
            return FseventsdHealth(pid: pid, rssBytes: rssKiB * 1024, cpuSeconds: cpu, date: now)
        }
        return nil
    }

    /// `ps` time: `MM:SS.ss`, `HH:MM:SS` or `D-HH:MM:SS`.
    static func cpuSeconds(_ text: String) -> Double? {
        var days = 0.0
        var rest = Substring(text)
        if let dash = rest.firstIndex(of: "-") {
            guard let value = Double(rest[..<dash]) else { return nil }
            days = value
            rest = rest[rest.index(after: dash)...]
        }
        let parts = rest.split(separator: ":").map { Double($0) }
        guard !parts.isEmpty, parts.allSatisfy({ $0 != nil }) else { return nil }
        let values = parts.compactMap { $0 }
        let seconds = values.reversed().enumerated().reduce(0.0) { sum, item in sum + item.element * pow(60, Double(item.offset)) }
        return days * 86_400 + seconds
    }
}

/// Decides whether `fseventsd` is hot from successive readings: resident memory at or above `rssLimit`, memory grown
/// by `growthLimit` within `growthWindow`, or CPU use at or above `cpuLimit` cores over at least `cpuWindow`.
/// Its normal load here is about 0.6 of a core, so CPU alone uses a high bar.
public struct FseventsdGate: Equatable, Sendable {
    public var rssLimit: Int64
    public var growthLimit: Int64
    public var growthWindow: TimeInterval
    public var cpuLimit: Double
    public var cpuWindow: TimeInterval
    public private(set) var history: [FseventsdHealth] = []

    public init(rssLimit: Int64 = 1 << 30, growthLimit: Int64 = 500_000_000, growthWindow: TimeInterval = 600,
                cpuLimit: Double = 1.5, cpuWindow: TimeInterval = 60) {
        self.rssLimit = rssLimit
        self.growthLimit = growthLimit
        self.growthWindow = growthWindow
        self.cpuLimit = cpuLimit
        self.cpuWindow = cpuWindow
    }

    /// Adds a reading and returns whether the daemon is hot now. A restarted daemon (new pid) starts a new history.
    public mutating func update(_ reading: FseventsdHealth) -> Bool {
        if let last = history.last, last.pid != reading.pid { history = [] }
        history.append(reading)
        let horizon = max(growthWindow, cpuWindow)
        // Keep the newest predecessor too: uneven sampling rarely lands exactly on the cutoff.
        if let boundary = history.lastIndex(where: { reading.date.timeIntervalSince($0.date) >= horizon }) {
            history.removeFirst(boundary)
        }
        return isHot
    }

    public var isHot: Bool {
        guard let latest = history.last else { return false }
        if latest.rssBytes >= rssLimit { return true }
        if let lowest = history.filter({ latest.date.timeIntervalSince($0.date) <= growthWindow }).map(\.rssBytes).min(),
           latest.rssBytes - lowest >= growthLimit {
            return true
        }
        // The newest reading at least `cpuWindow` old: the pace over the last window, not since the oldest one.
        if let reference = history.last(where: { latest.date.timeIntervalSince($0.date) >= cpuWindow }) {
            let elapsed = latest.date.timeIntervalSince(reference.date)
            if elapsed > 0, (latest.cpuSeconds - reference.cpuSeconds) / elapsed >= cpuLimit { return true }
        }
        return false
    }
}

/// A temporary folder and the rule macOS cleans it by, for the Temp & Leaks page.
public struct TempLocation: Codable, Equatable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var path: String
    public var cleanedAtBoot: Bool
    /// Local time of the nightly clean, `HH:mm`; nil when nothing cleans it while the Mac runs.
    public var cleanTime: String?
    /// Files unchanged for longer than this are removed at `cleanTime`.
    public var maxAgeDays: Int?
    public var note: String

    public init(id: String, title: String, path: String, cleanedAtBoot: Bool, cleanTime: String?, maxAgeDays: Int?,
                note: String) {
        self.id = id
        self.title = title
        self.path = path
        self.cleanedAtBoot = cleanedAtBoot
        self.cleanTime = cleanTime
        self.maxAgeDays = maxAgeDays
        self.note = note
    }

    /// The current user's folders: `/tmp`, `/var/tmp`, `$TMPDIR` (`T`), the cache folder `C`, the user folder `0`
    /// and the `X` folder of the code-sign clones. Resolved with `confstr`, so it does not depend on `TMPDIR`.
    public static func standard() -> [TempLocation] {
        let temp = confstrPath(_CS_DARWIN_USER_TEMP_DIR)
        let cache = confstrPath(_CS_DARWIN_USER_CACHE_DIR)
        let user = confstrPath(_CS_DARWIN_USER_DIR)
        let base = (temp ?? cache ?? user).map { ($0 as NSString).deletingLastPathComponent }
        var result = [
            TempLocation(id: "tmp", title: "/tmp", path: "/private/tmp", cleanedAtBoot: true, cleanTime: "00:00",
                         maxAgeDays: 3,
                         note: "tmp_cleaner removes files unchanged for 3 days every night; a low-disk purge may remove younger files."),
            TempLocation(id: "var-tmp", title: "/var/tmp", path: "/private/var/tmp", cleanedAtBoot: false,
                         cleanTime: nil, maxAgeDays: nil, note: "Nothing cleans it; files stay until removed."),
        ]
        if let temp {
            result.append(TempLocation(id: "user-temp", title: "$TMPDIR", path: temp, cleanedAtBoot: true,
                                       cleanTime: "03:35", maxAgeDays: 3,
                                       note: "dirhelper removes files untouched for 3 days at 03:35 and at boot."))
        }
        if let cache {
            result.append(TempLocation(id: "user-cache", title: "User cache (C)", path: cache, cleanedAtBoot: false,
                                       cleanTime: nil, maxAgeDays: nil,
                                       note: "Cleaned only in a safe boot. Apps keep caches here."))
        }
        if let user {
            result.append(TempLocation(id: "user-dir", title: "User folder (0)", path: user, cleanedAtBoot: false,
                                       cleanTime: nil, maxAgeDays: nil, note: "Never cleaned by macOS."))
        }
        if let base {
            result.append(TempLocation(id: "user-x", title: "Translocation and clones (X)",
                                       path: (base as NSString).appendingPathComponent("X"), cleanedAtBoot: true,
                                       cleanTime: nil, maxAgeDays: nil,
                                       note: "Cleaned only at boot. Browser code-sign clones collect here."))
        }
        return result
    }

    static func confstrPath(_ name: Int32) -> String? {
        let length = confstr(name, nil, 0)
        guard length > 0 else { return nil }
        var buffer = [CChar](repeating: 0, count: length)
        guard confstr(name, &buffer, length) > 0 else { return nil }
        let path = String(cString: buffer)
        guard !path.isEmpty else { return nil }
        return path.hasSuffix("/") && path.count > 1 ? String(path.dropLast()) : path
    }
}

/// A browser's code-sign clone in the `X` folder.
public struct CodeSignClone: Codable, Equatable, Hashable, Identifiable, Sendable {
    public enum State: String, Codable, Equatable, Sendable {
        /// Its main executable is a hard link of the installed app: it shares nearly all blocks.
        case current
        /// It holds an older version's blocks alone: deleting it frees real space.
        case stale
        case unknown
    }

    public var path: String
    /// The app's bundle id from the folder name (`com.google.Chrome`).
    public var bundleID: String
    public var created: Date?
    public var state: State

    public var id: String { path }

    public init(path: String, bundleID: String, created: Date?, state: State) {
        self.path = path
        self.bundleID = bundleID
        self.created = created
        self.state = state
    }

    /// Lists `<X>/*.code_sign_clone/*` at fixed depth (no walk). `xFolder` defaults to the user's `X` folder.
    public static func scan(xFolder: String? = nil) -> [CodeSignClone] {
        guard let folder = xFolder ?? TempLocation.standard().first(where: { $0.id == "user-x" })?.path else { return [] }
        let manager = FileManager.default
        guard let groups = try? manager.contentsOfDirectory(atPath: folder) else { return [] }
        var result: [CodeSignClone] = []
        for group in groups where group.hasSuffix(".code_sign_clone") {
            let bundleID = String(group.dropLast(".code_sign_clone".count))
            let groupPath = (folder as NSString).appendingPathComponent(group)
            guard let clones = try? manager.contentsOfDirectory(atPath: groupPath) else { continue }
            for clone in clones where !clone.hasPrefix(".") {
                let path = (groupPath as NSString).appendingPathComponent(clone)
                let attributes = try? manager.attributesOfItem(atPath: path)
                result.append(CodeSignClone(path: path, bundleID: bundleID,
                                            created: attributes?[.creationDate] as? Date,
                                            state: state(ofClone: path)))
            }
        }
        return result.sorted { ($0.created ?? .distantPast) < ($1.created ?? .distantPast) }
    }

    /// `current` when the clone's main executable has more than one link (Chromium replaces it with a hard link
    /// of the installed app's), `stale` when it has one.
    static func state(ofClone path: String) -> State {
        let manager = FileManager.default
        // Chromium names the copied bundle `<App>.app.bundle` (seen 2026-10-13); a plain `.app` is accepted too.
        guard let apps = try? manager.contentsOfDirectory(atPath: path),
              let app = apps.first(where: { $0.hasSuffix(".app.bundle") || $0.hasSuffix(".app") }) else { return .unknown }
        let macOS = ((path as NSString).appendingPathComponent(app) as NSString).appendingPathComponent("Contents/MacOS")
        guard let executables = try? manager.contentsOfDirectory(atPath: macOS) else { return .unknown }
        let name = app.hasSuffix(".app.bundle") ? String(app.dropLast(".app.bundle".count)) : String(app.dropLast(".app".count))
        guard let executable = executables.first(where: { $0 == name }) ?? executables.first else { return .unknown }
        var info = stat()
        guard lstat((macOS as NSString).appendingPathComponent(executable), &info) == 0 else { return .unknown }
        return info.st_nlink > 1 ? .current : .stale
    }
}
