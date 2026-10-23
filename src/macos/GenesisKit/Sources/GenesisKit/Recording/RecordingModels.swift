import AppKit
import Foundation

/// What a screen recording records: exact windows, every visible window of an app, or a whole display. The JSON is
/// the `--target` of `tools control capture session` and the `target` of its `switch` command.
public enum RecordingTarget: Hashable, Sendable {
    case window(ids: [UInt32], app: String?, title: String?, pid: Int32?)
    case app(app: String, name: String?)
    case display(index: Int, name: String?)

    /// The line a person reads: the window's title (or its app), the app's name, the display's name.
    public var title: String {
        switch self {
        case let .window(ids, app, title, _):
            if let title, !title.isEmpty { return title }
            return app ?? "Window \(ids.map(String.init).joined(separator: ", "))"
        case let .app(app, name):
            return name ?? app
        case let .display(index, name):
            return name ?? "Display \(index + 1)"
        }
    }

    /// The smaller line under the title: whose window it is, or what kind of target it is.
    public var subtitle: String {
        switch self {
        case let .window(_, app, title, _):
            return (title?.isEmpty == false ? app : nil) ?? "Window"
        case .app:
            return "Every window of the app"
        case .display:
            return "The whole display"
        }
    }

    public var symbol: String {
        switch self {
        case .window: return "macwindow"
        case .app: return "square.stack"
        case .display: return "display"
        }
    }

    /// The pid of the recorded app when the target names one, so a picker can show its icon.
    public var pid: Int32? {
        switch self {
        case let .window(_, _, _, pid): return pid
        case let .app(app, _): return Int32(app)
        case .display: return nil
        }
    }

    var wire: [String: Any] {
        switch self {
        case let .window(ids, app, title, pid):
            var object: [String: Any] = ["kind": "window", "windowIds": ids.map(Int.init)]
            if let app { object["app"] = app }
            if let title { object["title"] = title }
            if let pid { object["pid"] = Int(pid) }
            return object
        case let .app(app, name):
            var object: [String: Any] = ["kind": "app", "app": app]
            if let name { object["name"] = name }
            return object
        case let .display(index, name):
            var object: [String: Any] = ["kind": "display", "screenIndex": index]
            if let name { object["name"] = name }
            return object
        }
    }

    /// The target as one line of JSON.
    public var json: String {
        guard let data = try? JSONSerialization.data(withJSONObject: wire, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

extension RecordingTarget: Decodable {
    private enum Keys: String, CodingKey { case kind, windowIds, app, title, pid, name, screenIndex }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        switch try container.decode(String.self, forKey: .kind) {
        case "window":
            self = .window(
                ids: try container.decode([UInt32].self, forKey: .windowIds),
                app: try container.decodeIfPresent(String.self, forKey: .app),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                pid: try container.decodeIfPresent(Int32.self, forKey: .pid))
        case "app":
            self = .app(app: try container.decode(String.self, forKey: .app),
                        name: try container.decodeIfPresent(String.self, forKey: .name))
        case "display":
            self = .display(index: try container.decode(Int.self, forKey: .screenIndex),
                            name: try container.decodeIfPresent(String.self, forKey: .name))
        case let other:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container,
                                                   debugDescription: "unknown recording target kind \(other)")
        }
    }
}

/// One on-screen window, as `tools control capture targets --json` lists it (CG points, top-left origin).
public struct RecordingWindow: Decodable, Identifiable, Hashable, Sendable {
    public struct Bounds: Decodable, Hashable, Sendable {
        public let x: Double
        public let y: Double
        public let width: Double
        public let height: Double

        public init(x: Double, y: Double, width: Double, height: Double) {
            self.x = x
            self.y = y
            self.width = width
            self.height = height
        }
    }

    public let id: UInt32
    public let pid: Int32
    public let app: String
    public let title: String
    public let bounds: Bounds

    public init(id: UInt32, pid: Int32, app: String, title: String, bounds: Bounds) {
        self.id = id
        self.pid = pid
        self.app = app
        self.title = title
        self.bounds = bounds
    }

    public var target: RecordingTarget { .window(ids: [id], app: app, title: title, pid: pid) }
}

public struct RecordingApp: Decodable, Identifiable, Hashable, Sendable {
    public let pid: Int32
    public let name: String
    public let windowCount: Int
    public var id: Int32 { pid }

    public init(pid: Int32, name: String, windowCount: Int) {
        self.pid = pid
        self.name = name
        self.windowCount = windowCount
    }

    public var target: RecordingTarget { .app(app: String(pid), name: name) }
}

public struct RecordingDisplay: Decodable, Identifiable, Hashable, Sendable {
    public let index: Int
    public let name: String
    public let isPrimary: Bool
    public let width: Double
    public let height: Double
    public var id: Int { index }

    public init(index: Int, name: String, isPrimary: Bool, width: Double, height: Double) {
        self.index = index
        self.name = name
        self.isPrimary = isPrimary
        self.width = width
        self.height = height
    }

    public var target: RecordingTarget { .display(index: index, name: name) }
}

/// Everything a picker offers.
public struct RecordingTargets: Decodable, Hashable, Sendable {
    public let windows: [RecordingWindow]
    public let apps: [RecordingApp]
    public let displays: [RecordingDisplay]
    public let frontmostPid: Int32?

    public init(windows: [RecordingWindow], apps: [RecordingApp], displays: [RecordingDisplay], frontmostPid: Int32? = nil) {
        self.windows = windows
        self.apps = apps
        self.displays = displays
        self.frontmostPid = frontmostPid
    }

    /// The same lists without the windows and apps of `pids` (a host's own process).
    public func excluding(pids: Set<Int32>) -> RecordingTargets {
        RecordingTargets(windows: windows.filter { !pids.contains($0.pid) }, apps: apps.filter { !pids.contains($0.pid) },
                         displays: displays, frontmostPid: frontmostPid)
    }

    /// The front window of the app the person was in (`preferredPid`, else the frontmost app), else the main display.
    public func defaultTarget(preferredPid: Int32? = nil) -> RecordingTarget? {
        for pid in [preferredPid, frontmostPid].compactMap({ $0 }) {
            if let window = windows.first(where: { $0.pid == pid }) { return window.target }
        }
        if let window = windows.first { return window.target }
        return (displays.first(where: \.isPrimary) ?? displays.first)?.target
    }
}

/// Where a recording is: arming (no frame yet), recording, paused, saving, or over.
public enum RecordingPhase: String, Sendable {
    case idle, starting, recording, paused, finishing, done, discarded, failed

    public var isActive: Bool { [.starting, .recording, .paused, .finishing].contains(self) }
}

/// One JSON line of `tools control capture session --json`.
struct RecordingSessionLine: Decodable {
    let event: String
    let state: String?
    let reason: String?
    let target: RecordingTarget?
    let elapsedMs: Double?
    let limitMs: Double?
    let segments: Int?
    let path: String?
    let durationMs: Double?
    let message: String?
    let code: String?
    let fatal: Bool?
}
