import AppKit
import Foundation

/// What the capture picker records: a target the picker lists (a window, an app or a display), an area drawn on the
/// screen, or nothing chosen (the recorder's default: the display in use, following the pointer and the focus).
enum CaptureChoice: Equatable {
    case target(RecordingTarget)
    /// An area in global CoreGraphics points (top-left origin of the primary display), as `--region` takes it.
    case area(CGRect)
    case followPointer

    /// The `tools recorder start` flags that name it.
    var arguments: [String] {
        // A window or an app keeps its ids or pid as the target (two apps can share a name) and starts with the
        // picker's line as its title.
        switch self {
        case let .target(.window(ids, _, _, _)):
            return ["--window", ids.map(String.init).joined(separator: ",")] + titleArguments
        case let .target(.app(app, _)):
            return ["--app", app] + titleArguments
        case let .target(.display(index, _)):
            return ["--display", String(index)]
        case .target(.area), .target(.displays):
            return (try? resolvedArguments(screens: NSScreen.screens.map(\.frame), displayIDs: Self.screenIDs)) ?? []
        case let .area(rect):
            let parts = [rect.minX, rect.minY, rect.width, rect.height].map { String(Int($0.rounded())) }
            return ["--region", parts.joined(separator: ",")]
        case .followPointer, .target(.followDisplay):
            // No target flag: `tools recorder start` follows the display in use (`--display follow` names it too, but
            // an older CLI reads only an index there).
            return []
        }
    }

    private var titleArguments: [String] {
        guard case let .target(target) = self, let title = Self.startTitle(of: target) else { return [] }
        return ["--title", title]
    }

    /// The `--title` a window or an app starts with: the line the picker shows (`RecordingTarget.title`) without its
    /// "Window N" fallback, so the library, the menu and the export name never show a pid or a window id. Nil for a
    /// display and for a target with no name: the recorder titles those itself.
    static func startTitle(of target: RecordingTarget) -> String? {
        switch target {
        case let .window(_, app, title, _):
            if let title, !title.isEmpty { return title }
            return app.flatMap { $0.isEmpty ? nil : $0 }
        case let .app(_, name):
            return name.flatMap { $0.isEmpty ? nil : $0 }
        case .display, .area, .displays, .followDisplay:
            return nil
        }
    }

    /// The target the picker listed; nil for a drawn area and for the screen in use.
    var listedTarget: RecordingTarget? {
        if case let .target(target) = self { target } else { nil }
    }

    /// Cocoa screen rect (bottom-left origin) to CoreGraphics global points, given the primary display's height.
    static func coreGraphicsRect(cocoa rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }

    static var screenIDs: [UInt32?] {
        NSScreen.screens.map { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value }
    }

    static func region(_ rect: CGRect, on display: Int, screens: [CGRect]) -> CGRect? {
        guard screens.indices.contains(display), let primary = screens.first else { return nil }
        let screen = screens[display]
        return coreGraphicsRect(cocoa: rect.offsetBy(dx: screen.minX, dy: screen.minY), primaryHeight: primary.maxY)
    }

    func resolvedArguments(screens: [CGRect], displayIDs: [UInt32?]) throws -> [String] {
        let missing = RecordingEngineError.unsupported("A selected display disconnected. Choose the target again.")
        switch self {
        case let .target(.area(rect, index)):
            guard let region = Self.region(rect, on: index, screens: screens) else { throw missing }
            return CaptureChoice.area(region).arguments
        case let .target(.displays(indices)):
            let ids = try indices.map { index -> UInt32 in
                guard displayIDs.indices.contains(index), let id = displayIDs[index] else { throw missing }
                return id
            }
            guard Set(ids).count >= 2 else { throw missing }
            return ["--frames", "--displays", ids.map(String.init).joined(separator: ",")]
        default: return arguments
        }
    }
}

/// The capture picker's options, each its own key in the app's defaults so the menu's toggles and the picker share
/// them. Every value applies to the next recording.
struct CaptureOptions: Equatable {
    static let frameRates = [15, 24, 30, 60]
    /// 0 is "the same as the frame rate" (a movie keeps one rate).
    static let idleRates: [Double] = [0, 0.5, 1, 2, 5]
    static let thresholds: [Double] = [0.5, 1, 2.5, 5]

    enum Key {
        static let countdown = "recorder.capture.countdown"
        static let countdownSeconds = "recorder.capture.countdownSeconds"
        static let fps = "recorder.capture.fps"
        static let idleFps = "recorder.capture.idleFps"
        static let threshold = "recorder.capture.threshold"
        static let systemAudio = "recorder.capture.audio.system"
        static let microphone = "recorder.capture.audio.mic"
        static let camera = "recorder.capture.camera"
        /// Shared with the menu's "Draw the Cursor in the Editor" and "Record ⌘/⌃ Shortcuts".
        static let drawCursor = "recorder.record.drawCursor"
        static let shortcuts = "recorder.record.shortcuts"
    }

    /// On by default: three seconds to switch to what is recorded after a click on Start.
    var countdown = true
    var countdownSeconds = 3
    var fps = 60
    var idleFps: Double = 0
    var threshold: Double = 0.5
    var systemAudio = false
    var microphone = false
    /// Whose sound a window or app movie's system track keeps; shared with the widget through GenesisKit's key.
    var systemAudioScope = SystemAudioScope.all
    var drawCursor = true
    var shortcutsOverlay = true
    var camera = false

    static func load(_ defaults: UserDefaults = .standard) -> CaptureOptions {
        var options = CaptureOptions()
        func bool(_ key: String, _ fallback: Bool) -> Bool { defaults.object(forKey: key) as? Bool ?? fallback }
        options.countdown = bool(Key.countdown, options.countdown)
        if let seconds = defaults.object(forKey: Key.countdownSeconds) as? Int { options.countdownSeconds = min(max(seconds, 1), 10) }
        if let fps = defaults.object(forKey: Key.fps) as? Int, frameRates.contains(fps) { options.fps = fps }
        if let idle = defaults.object(forKey: Key.idleFps) as? Double, idleRates.contains(idle) { options.idleFps = idle }
        if let threshold = defaults.object(forKey: Key.threshold) as? Double, thresholds.contains(threshold) {
            options.threshold = threshold
        }
        options.systemAudio = bool(Key.systemAudio, options.systemAudio)
        options.microphone = bool(Key.microphone, options.microphone)
        options.systemAudioScope = SystemAudioScope.load(defaults)
        options.drawCursor = bool(Key.drawCursor, options.drawCursor)
        options.shortcutsOverlay = bool(Key.shortcuts, options.shortcutsOverlay)
        options.camera = bool(Key.camera, options.camera)
        return options
    }

    func save(_ defaults: UserDefaults = .standard) {
        defaults.set(countdown, forKey: Key.countdown)
        defaults.set(countdownSeconds, forKey: Key.countdownSeconds)
        defaults.set(fps, forKey: Key.fps)
        defaults.set(idleFps, forKey: Key.idleFps)
        defaults.set(threshold, forKey: Key.threshold)
        defaults.set(systemAudio, forKey: Key.systemAudio)
        defaults.set(microphone, forKey: Key.microphone)
        defaults.set(systemAudioScope.rawValue, forKey: SystemAudioScope.key)
        defaults.set(drawCursor, forKey: Key.drawCursor)
        defaults.set(shortcutsOverlay, forKey: Key.shortcuts)
        defaults.set(camera, forKey: Key.camera)
    }

    var audioSources: [String] {
        (systemAudio ? ["system"] : []) + (microphone ? ["mic"] : [])
    }

    /// The whole `tools recorder start` command line for `choice`. `excludeWindowIds` are windows of this app the
    /// movie must not show (the camera bubble's preview).
    func startArguments(_ choice: CaptureChoice, excludeWindowIds: [Int] = [], targetArguments: [String]? = nil) -> [String] {
        var args = ["recorder", "start"] + (targetArguments ?? choice.arguments)
        args += ["--fps", String(fps)]
        if idleFps > 0 { args += ["--idle-fps", Self.number(idleFps)] }
        if threshold != 0.5 { args += ["--threshold", Self.number(threshold)] }
        // Every target records sound, each source its own track.
        if !audioSources.isEmpty { args += ["--audio", audioSources.joined(separator: ",")] }
        args += systemAudioScope.arguments(target: choice.listedTarget, recordsSystemAudio: systemAudio)
        if !drawCursor { args.append("--system-cursor") }
        if !shortcutsOverlay { args.append("--no-shortcuts") }
        if camera { args.append("--camera") }
        if !excludeWindowIds.isEmpty { args += ["--exclude-window-ids", excludeWindowIds.map(String.init).joined(separator: ",")] }
        return args
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }

    /// The bar owns the draft. The shortcuts and change threshold retain their existing preference keys.
    static func barArguments(_ setup: RecordingSetup, threshold: Double, shortcuts: Bool, excluding ids: [Int],
                             screens: [CGRect], displayIDs: [UInt32?],
                             systemAudioScope: SystemAudioScope = .all) throws -> [String] {
        var options = CaptureOptions()
        options.systemAudioScope = systemAudioScope
        options.fps = setup.frameRate
        options.idleFps = setup.stillFrameRate == Double(setup.frameRate) ? 0 : setup.stillFrameRate
        options.threshold = threshold
        options.systemAudio = setup.systemAudio.enabled && !setup.systemAudio.muted
        options.microphone = setup.microphone.enabled && !setup.microphone.muted
        options.camera = setup.camera.enabled
        options.drawCursor = setup.drawsCursor
        options.shortcutsOverlay = shortcuts
        let choice = setup.target.map(CaptureChoice.target) ?? .followPointer
        var targetArguments = try choice.resolvedArguments(screens: screens, displayIDs: displayIDs)
        if case .displays = setup.target {
            guard !options.camera else { throw RecordingEngineError.unsupported("Several displays record frames without a camera. Turn the camera off or choose one display.") }
            options.drawCursor = true
            options.shortcutsOverlay = true
            switch setup.quality {
            case .standard: break
            case .high: targetArguments += ["--max-long-side", "3840"]
            case .max: targetArguments += ["--max-long-side", "16384"]
            }
        } else if setup.quality != .standard {
            throw RecordingEngineError.unsupported("The movie recorder uses the target’s native size. Choose Standard quality to record.")
        }
        var arguments = options.startArguments(choice, excludeWindowIds: ids, targetArguments: targetArguments)
        if options.microphone, let device = setup.microphone.deviceID {
            arguments += ["--mic-device", device]
        }
        if !targetArguments.contains("--frames") { arguments.append("--no-controls") }
        arguments.append("--json")
        return arguments
    }
}
