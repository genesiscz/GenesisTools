// Copied from /Users/Martin/Tresors/Projects/GenesisPlayground/Genesis/apps/Genesis/Sources/Genesis/Flow/FlowEvents.swift at 2026-10-08T05:04:08+02:00 at commit hash 7bd89a24c79510fb90ab0c2a0701c1d085f2023e
import Foundation

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
/// The file is a **log, not a mailbox**: it is append-only and callers are
/// expected to follow it. That keeps the writer trivial and means a crashed
/// consumer cannot lose events it never read.
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

    /// Append one JSON line. Best effort: a dictation must never fail because
    /// a log write did.
    private static func append(_ payload: Payload) {
        guard var data = try? encoder.encode(payload) else { return }
        data.append(0x0A) // \n

        let url = logURL
        let fm = FileManager.default
        do {
            try fm.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )
        } catch {
            // Directory may already exist; only a real failure matters below.
        }

        if !fm.fileExists(atPath: url.path) {
            fm.createFile(atPath: url.path, contents: data, attributes: [.posixPermissions: 0o600])
            return
        }
        guard let handle = try? FileHandle(forWritingTo: url) else { return }
        defer { try? handle.close() }
        do {
            try handle.seekToEnd()
            try handle.write(contentsOf: data)
        } catch {
            FlowFocusLog.flow.error("events: append failed: \(error.localizedDescription)")
        }
    }
}
