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
        switch self {
        case let .target(.window(ids, _, title, _)):
            var args = ["--window", ids.map(String.init).joined(separator: ",")]
            if let title, !title.isEmpty { args += ["--title", title] }
            return args
        case let .target(.app(app, _)):
            return ["--app", app]
        case let .target(.display(index, _)):
            return ["--display", String(index)]
        case let .area(rect):
            let parts = [rect.minX, rect.minY, rect.width, rect.height].map { String(Int($0.rounded())) }
            return ["--region", parts.joined(separator: ",")]
        case .followPointer:
            return []
        }
    }

    /// A display, an area or the screen in use; not a window or an app, whose movie has no audio track.
    var recordsAudio: Bool {
        switch self {
        case .target(.window), .target(.app): false
        case .target(.display), .area, .followPointer: true
        }
    }

    /// Cocoa screen rect (bottom-left origin) to CoreGraphics global points, given the primary display's height.
    static func coreGraphicsRect(cocoa rect: CGRect, primaryHeight: CGFloat) -> CGRect {
        CGRect(x: rect.minX, y: primaryHeight - rect.maxY, width: rect.width, height: rect.height)
    }
}

/// The capture picker's options, each its own key in the app's defaults so the menu's toggles and the picker share
/// them. Every value applies to the next recording.
struct CaptureOptions: Equatable {
    /// What a choice on `tab` does not record, said beside the options; nil on the Displays tab. "Select an area…"
    /// sits on every tab and records all of them, so the rows stay usable and only this line explains.
    static func notRecorded(on tab: RecordingPickerTab) -> String? {
        switch tab {
        case .windows: "A window movie has no audio, no cursor track and no shortcuts. Choose a display or an area for those."
        case .apps: "An app movie has no audio, no cursor track and no shortcuts. Choose a display or an area for those."
        case .displays: nil
        }
    }

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
        defaults.set(drawCursor, forKey: Key.drawCursor)
        defaults.set(shortcutsOverlay, forKey: Key.shortcuts)
        defaults.set(camera, forKey: Key.camera)
    }

    var audioSources: [String] {
        (systemAudio ? ["system"] : []) + (microphone ? ["mic"] : [])
    }

    /// The whole `tools recorder start` command line for `choice`. `excludeWindowIds` are windows of this app the
    /// movie must not show (the camera bubble's preview).
    func startArguments(_ choice: CaptureChoice, excludeWindowIds: [Int] = []) -> [String] {
        var args = ["recorder", "start"] + choice.arguments
        args += ["--fps", String(fps)]
        if idleFps > 0 { args += ["--idle-fps", Self.number(idleFps)] }
        if threshold != 0.5 { args += ["--threshold", Self.number(threshold)] }
        // A window or app movie is made from those windows alone and has no audio track; `start` refuses --audio there.
        if !audioSources.isEmpty, choice.recordsAudio { args += ["--audio", audioSources.joined(separator: ",")] }
        if !drawCursor { args.append("--system-cursor") }
        if !shortcutsOverlay { args.append("--no-shortcuts") }
        if camera { args.append("--camera") }
        if !excludeWindowIds.isEmpty { args += ["--exclude-window-ids", excludeWindowIds.map(String.init).joined(separator: ",")] }
        return args
    }

    private static func number(_ value: Double) -> String {
        value == value.rounded() ? String(Int(value)) : String(value)
    }
}
