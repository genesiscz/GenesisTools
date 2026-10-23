import Foundation

/// The one record of every notification a GenesisTools or Genesis surface sent, or decided not to send:
/// `~/.genesis-tools/notifications/ledger.jsonl` (under `GENESIS_TOOLS_HOME` when set), one JSON object per line.
/// The TypeScript side writes the same file with the same fields (`src/utils/notifications/ledger.ts`), so "what
/// pinged me in the last 40 hours, and why" is one read (Martin, 2026-10-23). Before this, Genesis.app's cache
/// banners were logged nowhere, and the macOS unified log kept about 14 hours of them without titles.
///
/// Fields every line has: `at`, `source` (`monitor.cache`, `disk`, `hang`, ...), `channel` (`macos`, `in-app`),
/// `outcome` (`posted`, `failed`, `suppressed`), `writer`. A suppressed line names its `reason`.
public enum NotificationLedger {
    public enum Outcome: String, Sendable {
        case posted
        case failed
        case suppressed
    }

    public static var path: String {
        let override = ProcessInfo.processInfo.environment["GENESIS_TOOLS_HOME"]
        let home = override?.isEmpty == false ? override! : NSHomeDirectory()
        return (home as NSString).appendingPathComponent(".genesis-tools/notifications/ledger.jsonl")
    }

    /// Past this size the file moves to `ledger.jsonl.1` (replacing the older one) and a new file starts.
    public static let maxBytes: Int64 = 20 * 1024 * 1024

    /// Writes happen off the caller's thread, in order. A poster on the main actor never waits on the disk.
    private static let queue = DispatchQueue(label: "genesis.notification-ledger", qos: .utility)

    /// Appends one line. Values that are not JSON are dropped and logged, never thrown: a ledger write must not
    /// stop a notification.
    public static func record(
        source: String,
        channel: String,
        outcome: Outcome = .posted,
        title: String? = nil,
        subtitle: String? = nil,
        body: String? = nil,
        reason: String? = nil,
        fields: [String: Any] = [:],
        file: String? = nil
    ) {
        var entry = fields.filter { JSONSerialization.isValidJSONObject(["value": $0.value]) }
        if entry.count != fields.count {
            KitHost.log("notification ledger \(source): dropped non-JSON fields \(Set(fields.keys).subtracting(entry.keys).sorted())")
        }
        entry["at"] = ISO8601DateFormatter().string(from: Date())
        entry["source"] = source
        entry["channel"] = channel
        entry["outcome"] = outcome.rawValue
        if let title { entry["title"] = title }
        if let subtitle { entry["subtitle"] = subtitle }
        if let body { entry["body"] = body }
        if let reason { entry["reason"] = reason }
        entry["writer"] = [
            "app": Bundle.main.bundleIdentifier ?? ProcessInfo.processInfo.processName,
            "pid": Int(getpid()),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else {
            KitHost.log("notification ledger \(source): the entry is not JSON")
            return
        }
        // A test run must not write into the user's real ledger; a test that checks the ledger passes `file`.
        if file == nil, NSClassFromString("XCTestCase") != nil { return }
        let target = file ?? path
        queue.async {
            rotateIfFull(target)
            GateAudit.appendLine(data, to: target)
        }
    }

    /// Waits for the lines queued so far. Tests only: posters never wait.
    public static func flush() {
        queue.sync {}
    }

    private static func rotateIfFull(_ file: String) {
        guard let size = (try? FileManager.default.attributesOfItem(atPath: file)[.size] as? NSNumber)?.int64Value,
              size > maxBytes
        else { return }
        let older = file + ".1"
        try? FileManager.default.removeItem(atPath: older)
        try? FileManager.default.moveItem(atPath: file, toPath: older)
    }
}
