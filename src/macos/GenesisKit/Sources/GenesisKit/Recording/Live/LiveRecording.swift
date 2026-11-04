import Darwin
import Foundation

/// One entry of `<genesis-tools root>/recordings/live/<id>.json`: a recording some `tools` process runs now (a meeting
/// recorder, a control capture session). The recorder writes the file atomically on every change and deletes it when
/// it ends. It is controlled through the JSON-RPC socket the entry names (`LiveRecordingRPCClient`); what the socket
/// reports (state, frames, displays) is laid over the file's values by `LiveRecordingSession`.
public struct LiveRecording: Equatable, Identifiable, Sendable {
    public struct Display: Equatable, Sendable {
        public var id: Int64
        public var name: String

        public init(id: Int64, name: String) {
            self.id = id
            self.name = name
        }
    }

    public var id: String
    /// `meeting`, `control-session` or another recorder's own word.
    public var kind: String
    public var title: String
    public var pid: Int32
    public var startedAt: Date
    /// `recording`, `paused` or `stopping`; an unknown word is kept as it is.
    public var state: String
    public var displays: [Display]
    public var frames: Int
    public var lastFrameAt: Date?
    public var warning: String?
    public var folder: String?
    /// The commands this recorder obeys.
    public var controls: [String]
    /// The recorder's Unix domain socket (JSON-RPC 2.0, one message per line).
    public var socket: String?
    /// The recorder asked for its floating controls (`panel` in the entry); the host opens them once.
    public var panel = false
    /// Every connected display, `recorded` or not (`displays.list`); empty until the socket answered.
    public var connectedDisplays: [ConnectedDisplay] = []
    /// `all` or `follow-focus` (or the recorder's own word), from the socket.
    public var mode: String?
    /// The last control call that failed, as the recorder said it.
    public var lastError: String?
    /// False while there is no socket to send a command to.
    public var canControl = true

    public struct ConnectedDisplay: Equatable, Sendable {
        public var id: Int64
        public var name: String
        public var recorded: Bool

        public init(id: Int64, name: String, recorded: Bool) {
            self.id = id
            self.name = name
            self.recorded = recorded
        }
    }

    public init(id: String, kind: String, title: String, pid: Int32, startedAt: Date, state: String,
                displays: [Display] = [], frames: Int = 0, lastFrameAt: Date? = nil, warning: String? = nil,
                folder: String? = nil, controls: [String] = LiveRecordingCommand.allCases.map(\.rawValue),
                socket: String? = nil, panel: Bool = false) {
        self.id = id
        self.kind = kind
        self.title = title
        self.pid = pid
        self.startedAt = startedAt
        self.state = state
        self.displays = displays
        self.frames = frames
        self.lastFrameAt = lastFrameAt
        self.warning = warning
        self.folder = folder
        self.controls = controls
        self.socket = socket
        self.panel = panel
    }

    public var isRecording: Bool { state == "recording" }
    public var isPaused: Bool { state == "paused" }
    public var isStopping: Bool { state == "stopping" }

    /// Pause while it records, Resume while it is paused, nothing while it stops.
    public var toggleCommand: LiveRecordingCommand? {
        switch state {
        case "recording": return allows(.pause) ? .pause : nil
        case "paused": return allows(.resume) ? .resume : nil
        default: return nil
        }
    }

    public func allows(_ command: LiveRecordingCommand) -> Bool {
        canControl && !isStopping && controls.contains(command.rawValue)
    }

    public func elapsedMs(now: Date) -> Double {
        max(0, now.timeIntervalSince(startedAt) * 1000)
    }

    public var displayNames: String {
        displays.map(\.name).filter { !$0.isEmpty }.joined(separator: ", ")
    }
}

/// The control calls of the menu and the floating controls; the raw value is the RPC method.
public enum LiveRecordingCommand: String, CaseIterable, Sendable {
    case pause, resume, stop
}

/// The live recordings folder: reading its entries and dropping the ones whose recorder process is gone.
/// No state of its own, so a test points it at a scratch folder with its own liveness check and clock.
public struct LiveRecordingStore: Sendable {
    public let folder: URL
    private let isAlive: @Sendable (Int32) -> Bool

    public init(folder: URL, isAlive: @escaping @Sendable (Int32) -> Bool = { LiveRecordingStore.processIsAlive($0) }) {
        self.folder = folder
        self.isAlive = isAlive
    }

    /// `${GENESIS_TOOLS_HOME:-$HOME}/.genesis-tools/recordings/live`, the TypeScript side's root.
    public static func folder(environment: [String: String] = ProcessInfo.processInfo.environment,
                              home: String = NSHomeDirectory()) -> URL {
        let override = environment["GENESIS_TOOLS_HOME"].flatMap { $0.isEmpty ? nil : $0 }
        return URL(fileURLWithPath: override ?? home)
            .appendingPathComponent(".genesis-tools/recordings/live", isDirectory: true)
    }

    public static let live = LiveRecordingStore(folder: folder())

    /// `kill(pid, 0)`: a process that exists but belongs to someone else (EPERM) is alive too.
    public static func processIsAlive(_ pid: Int32) -> Bool {
        guard pid > 0 else { return false }
        return kill(pid, 0) == 0 || errno == EPERM
    }

    /// Every readable entry whose recorder still runs, oldest first. A missing folder is no recording.
    public func load() -> [LiveRecording] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []
        let entries = names.filter { $0.hasSuffix(".json") && !$0.hasPrefix(".") }.compactMap { name -> LiveRecording? in
            guard let data = FileManager.default.contents(atPath: folder.appendingPathComponent(name).path) else {
                return nil
            }
            return Self.decode(data, fallbackID: String(name.dropLast(".json".count)))
        }

        return Self.alive(entries, isAlive: isAlive)
    }

    public static func alive(_ entries: [LiveRecording], isAlive: (Int32) -> Bool) -> [LiveRecording] {
        entries.filter { isAlive($0.pid) }.sorted { ($0.startedAt, $0.id) < ($1.startedAt, $1.id) }
    }

    /// Lenient on purpose: a recorder written in another language may send a number where a string was expected.
    /// `pid` and `startedAt` are required; the rest has defaults.
    public static func decode(_ data: Data, fallbackID: String? = nil) -> LiveRecording? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let id = (object["id"] as? String).flatMap({ $0.isEmpty ? nil : $0 }) ?? fallbackID,
              let pid = (object["pid"] as? NSNumber)?.int32Value,
              let startedAt = date(object["startedAt"])
        else { return nil }

        let displays = (object["displays"] as? [[String: Any]] ?? []).compactMap { display -> LiveRecording.Display? in
            guard let id = (display["id"] as? NSNumber)?.int64Value else { return nil }
            return LiveRecording.Display(id: id, name: display["name"] as? String ?? "Display \(id)")
        }
        let controls = (object["controls"] as? [String]) ?? LiveRecordingCommand.allCases.map(\.rawValue)
        let title = (object["title"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? id

        return LiveRecording(
            id: id, kind: object["kind"] as? String ?? "recording", title: title, pid: pid, startedAt: startedAt,
            state: object["state"] as? String ?? "recording", displays: displays,
            frames: (object["frames"] as? NSNumber)?.intValue ?? 0, lastFrameAt: date(object["lastFrameAt"]),
            warning: (object["warning"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            folder: (object["folder"] as? String).flatMap { $0.isEmpty ? nil : $0 }, controls: controls,
            socket: (object["socket"] as? String).flatMap { $0.isEmpty ? nil : $0 },
            panel: object["panel"] as? Bool ?? false)
    }

    /// An ISO 8601 string, with or without fractional seconds, or epoch milliseconds.
    static func date(_ value: Any?) -> Date? {
        if let number = value as? NSNumber {
            return Date(timeIntervalSince1970: number.doubleValue / 1000)
        }

        guard let text = value as? String else { return nil }

        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

        return fractional.date(from: text) ?? ISO8601DateFormatter().date(from: text)
    }
}
