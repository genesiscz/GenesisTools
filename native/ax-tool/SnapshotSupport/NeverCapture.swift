import CoreGraphics

/// One on-screen window as the never-capture rule sees it: what the window list gives without any grant.
public struct SharingWindowFacts: Equatable {
    public let ownerPID: Int32
    /// `kCGWindowSharingState`: 0 none, 1 read only, 2 read and write.
    public let sharingState: Int
    /// In global points, like `CGDisplayBounds`.
    public let bounds: CGRect

    public init(ownerPID: Int32, sharingState: Int, bounds: CGRect) {
        self.ownerPID = ownerPID
        self.sharingState = sharingState
        self.bounds = bounds
    }
}

/// A process that keeps windows marked never-capture, and the displays those windows sit on.
public struct NeverCaptureOwner: Equatable {
    public let pid: Int32
    public let windows: Int
    public let displays: [CGDirectDisplayID]

    public init(pid: Int32, windows: Int, displays: [CGDirectDisplayID]) {
        self.pid = pid
        self.windows = windows
        self.displays = displays
    }
}

/// Finds the processes that keep a window with `NSWindow.sharingType = .none` ("never capture") on a display.
///
/// While such a window is on a display, WindowServer cannot hand a capture stream the finished picture of that
/// display: it draws every window again for each open stream at every screen update. Measured 2026-11-22 on one Mac
/// (median time of a trivial WindowServer request): 2.3 to 2.9 ms with or without a stream on a clean display; with
/// HazeOver running 4.8 to 5.6 ms without a stream and 8.5 to 8.9 ms with one; 13.5 to 18.3 ms during a recording of
/// three displays. The window can be invisible: HazeOver keeps one of 2 x 2 points with alpha 0 on every display. The
/// stream's frame rate, size and content filter do not change the cost.
public enum NeverCaptureRule {
    /// `kCGWindowSharingNone`.
    public static let neverShared = 0

    /// The owners of never-capture windows that sit on a display, by pid, each with its displays in the order of
    /// `displays`. `own` is this process, whose windows never count.
    public static func owners(_ windows: [SharingWindowFacts], displays: [DisplayFrame], own: Int32? = nil) -> [NeverCaptureOwner] {
        var counts: [Int32: Int] = [:]
        var seen: [Int32: Set<CGDirectDisplayID>] = [:]
        for window in windows where window.sharingState == neverShared && window.ownerPID != own {
            let on = displays.filter { sits(window.bounds, on: $0.bounds) }.map(\.id)
            guard !on.isEmpty else { continue }
            counts[window.ownerPID, default: 0] += 1
            seen[window.ownerPID, default: []].formUnion(on)
        }
        return counts.keys.sorted().map { pid in
            NeverCaptureOwner(pid: pid, windows: counts[pid] ?? 0,
                              displays: displays.map(\.id).filter { seen[pid]?.contains($0) ?? false })
        }
    }

    /// The owners with a window on `display`; `nil` asks for any display (a recording that follows the focus).
    public static func blocking(_ owners: [NeverCaptureOwner], display: CGDirectDisplayID?) -> [NeverCaptureOwner] {
        guard let display else { return owners }
        return owners.filter { $0.displays.contains(display) }
    }

    /// A window with no area still sits on the display that holds its origin.
    static func sits(_ window: CGRect, on display: CGRect) -> Bool {
        window.isEmpty ? display.contains(window.origin) : window.intersects(display)
    }
}

/// Where a recording's frames come from: ScreenCaptureKit's stream, or one screenshot per frame with no open stream.
public enum FrameSource: String, Equatable {
    case stream
    case screenshot
}

/// `--frame-source`: `auto` takes screenshots only where a stream is costly (`NeverCaptureRule`).
public enum FrameSourceRequest: String, Equatable {
    case stream
    case screenshot
    case auto
}

public struct FrameSourceFacts: Equatable {
    /// A display recording (`--mode screen`); a window, an area and an isolated capture keep the stream.
    public let screenMode: Bool
    /// `--video-out`: a movie needs every frame of the stream.
    public let movie: Bool
    /// `--audio`: the sound comes through the stream.
    public let audio: Bool
    /// macOS 14 or newer (`SCScreenshotManager`).
    public let screenshotsAvailable: Bool
    /// A never-capture window is on a display the recording can show.
    public let blocked: Bool

    public init(screenMode: Bool, movie: Bool, audio: Bool, screenshotsAvailable: Bool, blocked: Bool) {
        self.screenMode = screenMode
        self.movie = movie
        self.audio = audio
        self.screenshotsAvailable = screenshotsAvailable
        self.blocked = blocked
    }

    /// Why this recording cannot take its frames by screenshot, or nil when it can.
    var screenshotObstacle: String? {
        if !screenMode { return "frames by screenshot work for a display recording (--mode screen) only" }
        if movie { return "a movie (--video-out) needs the stream" }
        if audio { return "sound in the capture (--audio) needs the stream" }
        if !screenshotsAvailable { return "frames by screenshot need macOS 14 or newer" }
        return nil
    }
}

public enum FrameSourceDecision: Equatable {
    /// `note` says why the stream stays although a never-capture window makes it costly.
    case use(FrameSource, note: String?)
    case refuse(String)
}

public func chooseFrameSource(_ request: FrameSourceRequest, _ facts: FrameSourceFacts) -> FrameSourceDecision {
    switch request {
    case .stream:
        return .use(.stream, note: nil)
    case .screenshot:
        if let obstacle = facts.screenshotObstacle {
            return .refuse("--frame-source screenshot: \(obstacle)")
        }
        return .use(.screenshot, note: nil)
    case .auto:
        guard facts.blocked else { return .use(.stream, note: nil) }
        if let obstacle = facts.screenshotObstacle {
            return .use(.stream, note: "a never-capture window is on the recorded display, which slows the screen while the stream is open; the stream stays because \(obstacle)")
        }
        return .use(.screenshot, note: nil)
    }
}
