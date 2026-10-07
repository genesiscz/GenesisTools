import Foundation

/// What the link relay did, one line per event in `~/.genesis-tools/app/link-relay.log`, so a link that went
/// to the wrong process, a relay that died or hung, and a window face that started its own relay can be read
/// back later. Window faces write here too when a delivery reaches them instead of the relay.
enum RelayJournal {
    static var directory: URL {
        URL(fileURLWithPath: genesisHome()).appendingPathComponent(".genesis-tools/app")
    }

    static var logFile: URL { directory.appendingPathComponent("link-relay.log") }

    /// `pid`, start time, last heartbeat and whether it ended cleanly: how the next relay tells a crash or a
    /// kill from a normal end.
    static var stateFile: URL { directory.appendingPathComponent("link-relay.json") }

    /// "relay" in the relay, else the face's first argument ("--review"), or "bare".
    nonisolated(unsafe) static var role = CommandLine.arguments.dropFirst().first ?? "bare"

    private static let stamp: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.timeZone = .current
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let lock = NSLock()

    static func write(_ message: String) {
        let line = "\(stamp.string(from: Date())) pid=\(getpid()) \(role) \(message)\n"
        lock.lock()
        defer { lock.unlock() }
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        guard let handle = FileHandle(forWritingAtPath: logFile.path) else {
            try? line.write(to: logFile, atomically: true, encoding: .utf8)
            return
        }
        defer { try? handle.close() }
        _ = try? handle.seekToEnd()
        try? handle.write(contentsOf: Data(line.utf8))
    }

    /// A link's scheme, host and path, without the query (it can carry tokens).
    static func describe(_ raw: String) -> String {
        guard let components = URLComponents(string: raw), let scheme = components.scheme else {
            return String(raw.prefix(60))
        }
        let rest = "\(components.host ?? "")\(components.path)"
        return "\(scheme)://\(rest.prefix(120))\(components.query == nil ? "" : "?…")"
    }

    struct State: Codable, Equatable {
        var pid: Int32
        var startedAt: Date
        var heartbeatAt: Date
        var cleanExit: Bool
    }

    static func readState(_ file: URL = stateFile) -> State? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        return try? JSONDecoder().decode(State.self, from: data)
    }

    static func writeState(_ state: State, to file: URL = stateFile) {
        guard let data = try? JSONEncoder().encode(state) else { return }
        try? data.write(to: file, options: .atomic)
    }

    /// The line the next relay writes about the one before it, nil when that one ended cleanly or still runs.
    static func previousEnd(_ previous: State?, isAlive: (Int32) -> Bool, crashReport: (Date) -> String?) -> String? {
        guard let previous, !previous.cleanExit, !isAlive(previous.pid) else { return nil }
        let silent = Date().timeIntervalSince(previous.heartbeatAt)
        var line = "previous relay pid=\(previous.pid) ended without a clean exit; started \(stamp.string(from: previous.startedAt)),"
            + " last heartbeat \(stamp.string(from: previous.heartbeatAt)) (\(Int(silent)) s ago)"
        if let report = crashReport(previous.startedAt) {
            line += "; crash report \(report)"
        } else {
            line += "; no crash report after its start (killed, or the Mac restarted)"
        }
        return line
    }

    /// The newest `GenesisTools-*.ips` written after `since`.
    static func crashReport(since: Date) -> String? {
        let folder = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Logs/DiagnosticReports")
        let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: [.contentModificationDateKey])) ?? []
        return files
            .filter { $0.lastPathComponent.hasPrefix("GenesisTools") && $0.pathExtension == "ips" }
            .compactMap { file -> (URL, Date)? in
                guard let date = try? file.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate,
                      date > since
                else { return nil }
                return (file, date)
            }
            .max { $0.1 < $1.1 }?.0.path
    }
}
