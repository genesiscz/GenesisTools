import AppKit
import Foundation

public enum RecordingTargetKind: String, Codable, CaseIterable, Hashable, Sendable {
    case window, app, display, area, displays
    /// The display in use: the take follows the pointer and the focus from display to display.
    case follow
}

/// The existing window, app and display encodings are also the widget capture session's command format.
public enum RecordingTarget: Hashable, Sendable {
    case window(ids: [UInt32], app: String?, title: String?, pid: Int32?)
    case app(app: String, name: String?)
    case display(index: Int, name: String?)
    /// Cocoa screen points on the chosen display. The index remains a label and a fallback for old records.
    case area(rect: CGRect, display: Int, displayID: UInt32? = nil)
    case displays(indices: [Int])
    /// The display in use, followed live to another display when the pointer or the focus goes there. On the wire it
    /// is a display with `follow: true` (`tools control capture session`, the recorder's `target.switch`).
    case followDisplay

    public var kind: RecordingTargetKind {
        switch self {
        case .window: return .window
        case .app: return .app
        case .display: return .display
        case .area: return .area
        case .displays: return .displays
        case .followDisplay: return .follow
        }
    }

    public static var connectedDisplayIDs: [UInt32?] {
        NSScreen.screens.map { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
    }

    public func areaDisplayIndex(displayIDs: [UInt32?]) -> Int? {
        guard case let .area(_, index, id) = self else { return nil }
        if let id { return displayIDs.firstIndex(of: id) }
        return index
    }

    public func areaBounds(screens: [CGRect], displayIDs: [UInt32?]) -> CGRect? {
        guard case let .area(rect, _, _) = self, let index = areaDisplayIndex(displayIDs: displayIDs),
              screens.indices.contains(index) else { return nil }
        let frame = screens[index]
        let cocoa = rect.offsetBy(dx: frame.minX, dy: frame.minY)
        return frame.contains(cocoa) && !cocoa.isEmpty ? cocoa : nil
    }

    // CGRect gained Hashable in macOS 15. The kit also runs on macOS 14.
    public func hash(into hasher: inout Hasher) {
        hasher.combine(kind)
        switch self {
        case let .window(ids, app, title, pid):
            hasher.combine(ids)
            hasher.combine(app)
            hasher.combine(title)
            hasher.combine(pid)
        case let .app(app, name):
            hasher.combine(app)
            hasher.combine(name)
        case let .display(index, name):
            hasher.combine(index)
            hasher.combine(name)
        case let .area(rect, display, displayID):
            hasher.combine(display)
            hasher.combine(displayID)
            hasher.combine(rect.minX)
            hasher.combine(rect.minY)
            hasher.combine(rect.maxX)
            hasher.combine(rect.maxY)
        case let .displays(indices):
            hasher.combine(indices)
        case .followDisplay:
            break
        }
    }

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
        case let .area(_, display, _): return "Area on Display \(display + 1)"
        case let .displays(indices): return "Displays " + indices.map { String($0 + 1) }.joined(separator: ", ")
        case .followDisplay: return "Follow display"
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
        case .area: return "Selected area"
        case .displays: return "Selected displays"
        case .followDisplay: return "The display in use, following the pointer and the focus"
        }
    }

    public var symbol: String {
        switch self {
        case .window: return "macwindow"
        case .app: return "square.stack"
        case .display: return "display"
        case .area: return "rectangle.dashed"
        case .displays: return "display.2"
        case .followDisplay: return "rectangle.2.swap"
        }
    }

    /// The pid of the recorded app when the target names one, so a picker can show its icon.
    public var pid: Int32? {
        switch self {
        case let .window(_, _, _, pid): return pid
        case let .app(app, _): return Int32(app)
        case .display, .area, .displays, .followDisplay: return nil
        }
    }

    var wire: [String: Any] {
        guard let data = try? JSONEncoder().encode(self),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    /// The target as one line of JSON.
    public var json: String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(self) else { return "{}" }
        return String(decoding: data, as: UTF8.self)
    }
}

extension RecordingTarget: Codable {
    private enum Keys: String, CodingKey {
        case kind, windowIds, app, title, pid, name, screenIndex, rect, indices, displayID, follow
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: Keys.self)
        // A following display travels as a display with `follow`, the shape both engines read; its index is unused.
        try container.encode(self == .followDisplay ? .display : kind, forKey: .kind)
        switch self {
        case let .window(ids, app, title, pid):
            try container.encode(ids, forKey: .windowIds)
            try container.encodeIfPresent(app, forKey: .app)
            try container.encodeIfPresent(title, forKey: .title)
            try container.encodeIfPresent(pid, forKey: .pid)
        case let .app(app, name):
            try container.encode(app, forKey: .app)
            try container.encodeIfPresent(name, forKey: .name)
        case let .display(index, name):
            try container.encode(index, forKey: .screenIndex)
            try container.encodeIfPresent(name, forKey: .name)
        case let .area(rect, display, displayID):
            try container.encode(display, forKey: .screenIndex)
            try container.encodeIfPresent(displayID, forKey: .displayID)
            try container.encode(RecordingWindow.Bounds(x: rect.origin.x, y: rect.origin.y,
                                                       width: rect.size.width, height: rect.size.height), forKey: .rect)
        case let .displays(indices):
            try container.encode(indices, forKey: .indices)
        case .followDisplay:
            try container.encode(0, forKey: .screenIndex)
            try container.encode(true, forKey: .follow)
        }
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: Keys.self)
        let follows = try container.decodeIfPresent(Bool.self, forKey: .follow) == true
        switch try container.decode(RecordingTargetKind.self, forKey: .kind) {
        case .window:
            self = .window(
                ids: try container.decode([UInt32].self, forKey: .windowIds),
                app: try container.decodeIfPresent(String.self, forKey: .app),
                title: try container.decodeIfPresent(String.self, forKey: .title),
                pid: try container.decodeIfPresent(Int32.self, forKey: .pid))
        case .app:
            self = .app(app: try container.decode(String.self, forKey: .app),
                        name: try container.decodeIfPresent(String.self, forKey: .name))
        case .display where follows, .follow:
            self = .followDisplay
        case .display:
            self = .display(index: try container.decode(Int.self, forKey: .screenIndex),
                            name: try container.decodeIfPresent(String.self, forKey: .name))
        case .area:
            let bounds = try container.decode(RecordingWindow.Bounds.self, forKey: .rect)
            self = .area(rect: CGRect(x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height),
                         display: try container.decode(Int.self, forKey: .screenIndex),
                         displayID: try container.decodeIfPresent(UInt32.self, forKey: .displayID))
        case .displays:
            self = .displays(indices: try container.decode([Int].self, forKey: .indices))
        }
    }
}

/// One on-screen window, as `tools control capture targets --json` lists it (CG points, top-left origin).
public struct RecordingWindow: Decodable, Identifiable, Hashable, Sendable {
    public struct Bounds: Codable, Hashable, Sendable {
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

    /// The connected display with this CoreGraphics id, under the name a recorder gave it; nil once it is gone.
    @MainActor public static func connected(displayID: UInt32, name: String,
                                            screens: [NSScreen] = NSScreen.screens) -> RecordingDisplay? {
        guard let index = screens.firstIndex(where: {
            ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == displayID
        }) else { return nil }
        let frame = screens[index].frame
        return RecordingDisplay(index: index, name: name, isPrimary: index == 0, width: frame.width, height: frame.height)
    }
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
    /// The display a following take records now (`display` on a state event).
    let display: Display?

    struct Display: Decodable {
        let id: Double
        let name: String
    }
}
