import Foundation

public struct MicrophoneSetup: Equatable, Codable, Sendable {
    public var enabled: Bool
    public var muted: Bool
    public var deviceID: String?

    public init(enabled: Bool = false, muted: Bool = false, deviceID: String? = nil) {
        self.enabled = enabled
        self.muted = muted
        self.deviceID = deviceID
    }
}

public struct SystemAudioSetup: Equatable, Codable, Sendable {
    public var enabled: Bool
    public var muted: Bool

    public init(enabled: Bool = false, muted: Bool = false) {
        self.enabled = enabled
        self.muted = muted
    }
}

/// Whose sound the system track of a window or app take keeps (Settings → Recorder → What the movie keeps). A display
/// or area take keeps everything the Mac plays whatever it says. ScreenCaptureKit filters sound per app, never per
/// window, so `.app` keeps the recorded window's whole app.
public enum SystemAudioScope: String, CaseIterable, Sendable {
    case all, app

    public static let key = "recorder.capture.audio.systemScope"

    public static func load(_ defaults: UserDefaults = .standard) -> Self {
        defaults.string(forKey: key).flatMap(Self.init(rawValue:)) ?? .all
    }

    /// `--system-audio-scope app` for a window or app take that keeps its system sound; nothing for the default.
    public func arguments(target: RecordingTarget?, recordsSystemAudio: Bool) -> [String] {
        guard self == .app, recordsSystemAudio else { return [] }
        switch target {
        case .window, .app: return ["--system-audio-scope", rawValue]
        default: return []
        }
    }
}

public struct CameraSetup: Equatable, Codable, Sendable {
    public var enabled: Bool
    public var size: Int
    public var shape: String

    public init(enabled: Bool = false, size: Int = 200, shape: String = "circle") {
        self.enabled = enabled
        self.size = size
        self.shape = shape
    }
}

public enum RecordingQuality: String, Codable, CaseIterable, Sendable { case standard, high, max }

/// The choices for one take. Editing this value never writes preferences.
public struct RecordingSetup: Equatable, Codable, Sendable {
    public static let frameRates = [5, 10, 15, 24, 30, 60]
    public static let stillFrameRates: [Double] = [0, 0.5, 1, 2, 5]
    public static let framesDefaultStillRate: Double = 0.5

    public static func supportsStillRate(_ still: Double, at active: Int) -> Bool {
        stillFrameRates.contains(still) || still == Double(active)
    }

    static func framesQuality(_ defaults: UserDefaults) -> RecordingQuality {
        defaults.string(forKey: Key.quality).flatMap(RecordingQuality.init(rawValue:)) ?? .standard
    }

    public var target: RecordingTarget?
    public var microphone: MicrophoneSetup
    public var systemAudio: SystemAudioSetup
    public var camera: CameraSetup
    public var frameRate: Int
    public var stillFrameRate: Double
    public var quality: RecordingQuality
    public var countdownSeconds: Int?
    public var drawsCursor: Bool

    public init(target: RecordingTarget? = nil, microphone: MicrophoneSetup = .init(),
                systemAudio: SystemAudioSetup = .init(), camera: CameraSetup = .init(), frameRate: Int = 60,
                stillFrameRate: Double = 0, quality: RecordingQuality = .standard, countdownSeconds: Int? = 3,
                drawsCursor: Bool = true) {
        self.target = target
        self.microphone = microphone
        self.systemAudio = systemAudio
        self.camera = camera
        self.frameRate = frameRate
        self.stillFrameRate = stillFrameRate
        self.quality = quality
        self.countdownSeconds = countdownSeconds
        self.drawsCursor = drawsCursor
    }

    /// These keys are shared with the recorder menu and Settings. Window IDs and display indices belong to one take.
    public static func load(_ defaults: UserDefaults = .standard) -> Self {
        var setup = Self()
        func read<T>(_ key: String, _ fallback: T) -> T { defaults.object(forKey: key) as? T ?? fallback }
        let fps = read(Key.fps, setup.frameRate)
        if frameRates.contains(fps) { setup.frameRate = fps }
        let idle = read(Key.idleFps, setup.stillFrameRate)
        if supportsStillRate(idle, at: setup.frameRate) { setup.stillFrameRate = idle }
        setup.countdownSeconds = read(Key.countdown, true) ? min(10, max(1, read(Key.seconds, 3))) : nil
        setup.microphone = .init(enabled: read(Key.microphone, false), muted: read(Key.micMuted, false),
                                 deviceID: defaults.string(forKey: Key.device))
        setup.systemAudio = .init(enabled: read(Key.systemAudio, false), muted: read(Key.systemMuted, false))
        setup.camera.enabled = read(Key.camera, false)
        let size = read(Key.cameraSize, setup.camera.size)
        if [140, 200, 260].contains(size) { setup.camera.size = size }
        let shape = read(Key.cameraShape, setup.camera.shape)
        if ["circle", "rounded", "square"].contains(shape) { setup.camera.shape = shape }
        setup.drawsCursor = read(Key.cursor, true)
        return setup
    }

    public func save(_ defaults: UserDefaults = .standard) {
        defaults.set(frameRate, forKey: Key.fps)
        defaults.set(stillFrameRate, forKey: Key.idleFps)
        defaults.set(countdownSeconds != nil, forKey: Key.countdown)
        if let countdownSeconds { defaults.set(countdownSeconds, forKey: Key.seconds) }
        defaults.set(microphone.enabled, forKey: Key.microphone)
        defaults.set(microphone.muted, forKey: Key.micMuted)
        defaults.set(microphone.deviceID, forKey: Key.device)
        defaults.set(systemAudio.enabled, forKey: Key.systemAudio)
        defaults.set(systemAudio.muted, forKey: Key.systemMuted)
        defaults.set(camera.enabled, forKey: Key.camera)
        defaults.set(camera.size, forKey: Key.cameraSize)
        defaults.set(camera.shape, forKey: Key.cameraShape)
        if target?.kind == .displays { defaults.set(quality.rawValue, forKey: Key.quality) }
        defaults.set(drawsCursor, forKey: Key.cursor)
    }

    private enum Key {
        static let fps = "recorder.capture.fps"
        static let idleFps = "recorder.capture.idleFps"
        static let countdown = "recorder.capture.countdown"
        static let seconds = "recorder.capture.countdownSeconds"
        static let microphone = "recorder.capture.audio.mic"
        static let micMuted = "recorder.capture.audio.micMuted"
        static let device = "recorder.capture.audio.micDevice"
        static let systemAudio = "recorder.capture.audio.system"
        static let systemMuted = "recorder.capture.audio.systemMuted"
        static let camera = "recorder.capture.camera"
        static let cameraSize = "recorder.camera.bubbleSize"
        static let cameraShape = "recorder.camera.shape"
        static let quality = "recorder.capture.quality"
        static let cursor = "recorder.record.drawCursor"
    }
}

public enum RecordingSetupChange: Equatable, Sendable {
    case target(RecordingTarget), microphone(MicrophoneSetup), systemAudio(SystemAudioSetup), camera(CameraSetup)
    case frameRate(Int, still: Double), quality(RecordingQuality), drawsCursor(Bool)

    public var controlID: String {
        switch self {
        case .target: return "target"
        case .microphone: return "microphone"
        case .systemAudio: return "systemAudio"
        case .camera: return "camera"
        case .frameRate: return "frameRate"
        case .quality: return "quality"
        case .drawsCursor: return "drawsCursor"
        }
    }

    func edit(_ setup: inout RecordingSetup) {
        switch self {
        case let .target(value): setup.target = value
        case let .microphone(value): setup.microphone = value
        case let .systemAudio(value): setup.systemAudio = value
        case let .camera(value): setup.camera = value
        case let .frameRate(active, still):
            setup.frameRate = active
            setup.stillFrameRate = still
        case let .quality(value): setup.quality = value
        case let .drawsCursor(value): setup.drawsCursor = value
        }
    }
}
