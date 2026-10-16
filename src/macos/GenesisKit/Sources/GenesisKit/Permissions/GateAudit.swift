import Foundation

/// One audit trail for every gate a person answers: the vault key, an AI account's token, a link that runs a saved
/// command, Touch ID, and the privacy-permission dialogs. `~/.genesis-tools/audit/gates.jsonl` (under
/// `GENESIS_TOOLS_HOME` when set), one JSON object per line, readable only by its owner. Each line names the gate, the
/// event (`prompted`, `allowed`, `denied`, `remembered`, `granted`, `not-now`, `recorded`, ...), the process that wrote
/// it, and everything the gate showed, warnings included, so a decision can be audited later from the file alone
/// (Martin, 2026-10-16: "I want all permission gates to be audited"). Secrets are never written. The TypeScript side
/// writes the same file (`src/utils/audit/gates.ts`).
public enum GateAudit {
    public static var path: String {
        let override = ProcessInfo.processInfo.environment["GENESIS_TOOLS_HOME"]
        let home = override?.isEmpty == false ? override! : NSHomeDirectory()
        return (home as NSString).appendingPathComponent(".genesis-tools/audit/gates.jsonl")
    }

    private static let lock = NSLock()

    /// What an approval window showed: its title, why, every fact and detail with its full value, the warning.
    public static func shown(title: String, purpose: String, facts: [ApprovalFact], warning: String?,
                             onceOnly: String? = nil) -> [String: Any] {
        var shown: [String: Any] = [
            "title": title,
            "purpose": purpose,
            "facts": facts.map { ["label": $0.label, "value": $0.help ?? $0.value] },
        ]
        if let warning { shown["warning"] = warning }
        if let onceOnly { shown["onceOnly"] = onceOnly }
        return shown
    }

    /// Appends one line. A value that is not JSON (an optional left in, a custom type) is dropped from the line and
    /// logged, never thrown: an audit write must not stop a gate.
    public static func write(gate: String, event: String, _ fields: [String: Any] = [:]) {
        var entry = fields.filter { JSONSerialization.isValidJSONObject(["value": $0.value]) }
        if entry.count != fields.count {
            GenesisKit.log("gate audit \(gate) \(event): dropped non-JSON fields \(Set(fields.keys).subtracting(entry.keys).sorted())")
        }
        entry["at"] = ISO8601DateFormatter().string(from: Date())
        entry["gate"] = gate
        entry["event"] = event
        entry["writer"] = [
            "pid": Int(getpid()),
            "app": Bundle.main.bundleIdentifier ?? "",
            "executable": Bundle.main.executablePath ?? "",
        ]

        guard let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]) else {
            GenesisKit.log("gate audit \(gate) \(event): the entry is not JSON")
            return
        }

        lock.lock()
        defer { lock.unlock() }
        let file = path
        let directory = (file as NSString).deletingLastPathComponent
        do {
            try FileManager.default.createDirectory(atPath: directory, withIntermediateDirectories: true,
                                                    attributes: [.posixPermissions: 0o700])
            if !FileManager.default.fileExists(atPath: file) {
                FileManager.default.createFile(atPath: file, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            let handle = try FileHandle(forWritingTo: URL(fileURLWithPath: file))
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data + Data("\n".utf8))
        } catch {
            GenesisKit.log("gate audit \(gate) \(event): could not write \(file): \(error)")
        }
    }
}
