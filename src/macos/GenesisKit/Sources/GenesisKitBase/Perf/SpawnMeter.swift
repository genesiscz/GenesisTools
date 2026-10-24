import Foundation

/// Counts the child processes this app starts and writes a `spawn.storm` line to the perf log when they come in a
/// burst, so `tools hub dev monitor` reports it. A burst that hurts the Mac can be invisible otherwise: Genesis
/// Markdown started about 9,300 `tools agents blame` an hour, 51 to 66 at once (2026-10-24, load average 380-580,
/// launchservicesd at 69-159%), and its log held one line per blame only when a single run was slow.
public enum SpawnMeter {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var storm = SpawnStorm()

    /// Records that a child started; call the returned closure once when it has ended.
    public static func started(executable: URL?, arguments: [String]) -> @Sendable () -> Void {
        let label = label(executable: executable, arguments: arguments)
        let line = lock.withLock { storm.start(label, at: CFAbsoluteTimeGetCurrent()) }
        if let line { PerfLog.mark(line) }
        return {
            let line = lock.withLock { storm.finish(at: CFAbsoluteTimeGetCurrent()) }
            if let line { PerfLog.mark(line) }
        }
    }

    /// What a child is, in two or three words: `git status`, `GenesisTools agents blame`. Paths and options are left out,
    /// except that a launcher argument `…/gt-agents` names the tool (`agents`).
    public static func label(executable: URL?, arguments: [String]) -> String {
        var words = [executable?.lastPathComponent ?? "?"]
        var skipValue = false
        for argument in arguments where words.count < 3 {
            if skipValue {
                skipValue = false
                continue
            }
            if argument == "-C" || argument == "-c" || argument == "--git-dir" {
                skipValue = true
                continue
            }
            let name = (argument as NSString).lastPathComponent
            if argument.contains("/"), name.hasPrefix("gt-") {
                words.append(String(name.dropFirst(3)))
            } else if !argument.contains("/"), !argument.hasPrefix("-"), !argument.isEmpty {
                words.append(argument)
            }
        }
        return words.joined(separator: " ")
    }
}

/// The burst rule, apart from the clock and the log: `burstStarts` starts within `window` seconds, or `burstRunning`
/// children at once. A burst is reported when it starts, every `reportEvery` seconds while it lasts, and when it ends.
/// The hub opening a pull request starts about 24 in 10 s with 5 running (2026-10-24 19:45), which is normal; the blame
/// waves had 51 to 66 running.
public struct SpawnStorm {
    public static let burstStarts = 40
    public static let burstRunning = 16
    public static let window: TimeInterval = 10
    public static let reportEvery: TimeInterval = 30

    private var starts: [(at: Double, label: String)] = []
    private var running = 0
    private var since: Double?
    private var lastReport = -Double.infinity
    private var counts: [String: Int] = [:]
    private var total = 0

    public init() {}

    public mutating func start(_ label: String, at now: Double) -> String? {
        running += 1
        starts.append((now, label))
        prune(now)
        if let since {
            total += 1
            counts[label, default: 0] += 1
            guard now - lastReport >= Self.reportEvery else { return nil }
            lastReport = now
            return "spawn.storm ongoing \(Int(now - since)) s: \(total) child processes started, \(running) running; \(top)"
        }
        guard starts.count >= Self.burstStarts || running >= Self.burstRunning else { return nil }
        since = now
        lastReport = now
        total = starts.count
        counts = starts.reduce(into: [:]) { $0[$1.label, default: 0] += 1 }
        return "spawn.storm \(starts.count) child processes started in \(Int(Self.window)) s, \(running) running; \(top)"
    }

    public mutating func finish(at now: Double) -> String? {
        running = max(0, running - 1)
        prune(now)
        guard let since, running < Self.burstRunning / 2, starts.count < Self.burstStarts / 2 else { return nil }
        self.since = nil
        defer { counts = [:]; total = 0 }
        return "spawn.storm over after \(Int(now - since)) s: \(total) child processes started; \(top)"
    }

    private mutating func prune(_ now: Double) {
        starts.removeAll { now - $0.at > Self.window }
    }

    /// The commonest children first: `GenesisTools agents blame ×51, git status ×3`.
    private var top: String {
        counts.sorted { $0.value == $1.value ? $0.key < $1.key : $0.value > $1.value }.prefix(3)
            .map { "\($0.key) ×\($0.value)" }.joined(separator: ", ")
    }
}
