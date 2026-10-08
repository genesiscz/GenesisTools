// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowEvents.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation
import Darwin

extension Notification.Name {
    /// Posted on the main queue after a dictation turn lands. `userInfo`
    /// carries a `FlowEvents.Payload` under `FlowEvents.payloadKey`.
    public static let genesisFlowTranscript = Notification.Name("genesis.flow.transcript")
}

/// The completion hook other tools can listen to.
///
/// This exists because it is the single most specific complaint users make
/// about Wispr Flow: *"Wispr Flow does not currently expose a native hook,
/// local API, or any event that third-party tools can listen to in order to
/// detect when a transcription completes."* People end up polling the
/// clipboard, which corrupts their own input buffer.
///
/// Two surfaces, both cheap:
///
/// 1. **In-process** — `NSNotification`, for the rest of the Swift app.
/// 2. **Out-of-process** — a JSON line appended to
///    `~/.genesis/flow/events.jsonl`, which anything can `tail -f`.
///
/// Consumers can follow appended events. The log shares history's retention:
/// deleting or trimming turns removes their raw and final transcripts here too.
@MainActor
public enum FlowEvents {

    public static let payloadKey = "payload"

    public struct Payload: Codable, Equatable {
        public var id: UUID
        public var text: String
        /// The transcript before dictionary, snippets and any transform —
        /// so a consumer can tell what was said from what was written.
        public var rawText: String
        public var targetBundleId: String?
        public var targetAppName: String?
        public var injected: Bool
        public var wordCount: Int
        public var durationSeconds: Double
        public var createdAt: Date
    }

    private static let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.dateEncodingStrategy = .iso8601
        // One line per event: pretty-printing would break `tail -f | jq -c`.
        e.outputFormatting = [.sortedKeys]
        return e
    }()

    static var logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent(".genesis/flow/events.jsonl")

    /// Announce a completed turn.
    public static func publish(_ entry: FlowEntry) {
        let payload = Payload(
            id: entry.id,
            text: entry.text,
            rawText: entry.rawText,
            targetBundleId: entry.targetBundleId,
            targetAppName: entry.targetAppName,
            injected: entry.injected,
            wordCount: entry.wordCount,
            durationSeconds: entry.durationSeconds,
            createdAt: entry.createdAt
        )

        NotificationCenter.default.post(
            name: .genesisFlowTranscript,
            object: nil,
            userInfo: [payloadKey: payload]
        )

        append(payload)
    }

    /// A best-effort notification log must never make a completed dictation fail.
    private static func append(_ payload: Payload) {
        do {
            var data = try encoder.encode(payload)
            data.append(0x0A)
            let parent = logURL.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: parent, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: parent.path)
            let descriptor = open(logURL.path, O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
            guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
            defer { try? handle.close() }
            guard fchmod(descriptor, 0o600) == 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            try handle.write(contentsOf: data)
        } catch {
            FlowFocusLog.flow.error("events: append failed: \(error.localizedDescription)")
        }
    }

    static func retain(entryIDs: Set<UUID>, at url: URL) throws {
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        try PerfLog.span("flow.events.retain") {
            var retained = Data()
            if !entryIDs.isEmpty {
                let descriptor = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
                guard descriptor >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
                let handle = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
                defer { try? handle.close() }
                let contents = try handle.readToEnd() ?? Data()
                for line in contents.split(separator: 0x0A) {
                    guard let raw = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any],
                          let textID = raw["id"] as? String, let id = UUID(uuidString: textID), entryIDs.contains(id) else { continue }
                    retained.append(contentsOf: line)
                    retained.append(0x0A)
                }
            }
            try FlowFocusLease.writePrivate(retained, to: url)
        }
    }
}
