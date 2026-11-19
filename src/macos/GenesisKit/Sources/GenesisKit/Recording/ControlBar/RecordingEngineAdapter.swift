import Foundation

/// A sound or picture source beside the screen that a recorder's movie can hold.
public enum RecordingSource: String, CaseIterable, Sendable {
    case microphone, systemAudio, camera

    var title: String {
        switch self {
        case .microphone: "microphone"
        case .systemAudio: "system audio"
        case .camera: "camera"
        }
    }
}

public struct RecordingCapabilities: Equatable, Sendable {
    public var targets: Set<RecordingTargetKind>
    /// The sources the recorder's movie holds at all. A source outside it is drawn off and disabled with its reason
    /// in setup too (the widget's movie has no camera).
    public var sources: Set<RecordingSource>
    public var liveTargetSwitch: Bool
    public var liveMicrophoneMute: Bool
    public var liveMicrophoneDevice: Bool
    public var liveSystemAudioMute: Bool
    public var liveFrameRate: Bool
    public var liveRestart: Bool
    public var liveCamera: Bool
    public var liveDisplaysAddRemove: Bool
    public var maxDurationMs: Double?
    /// The movie preset this recorder always records, whatever the setup saved; nil when it records the setup's
    /// preset. The widget records at the target's native size, so its bar shows Standard, not the full recorder's pick.
    public var fixedMovieQuality: MovieQuality?
    public var reasonUnavailable: [String: String]

    public init(targets: Set<RecordingTargetKind> = [], liveTargetSwitch: Bool = false,
                liveMicrophoneMute: Bool = false, liveMicrophoneDevice: Bool = false,
                liveSystemAudioMute: Bool = false, liveFrameRate: Bool = false,
                liveCamera: Bool = false, liveDisplaysAddRemove: Bool = false, liveRestart: Bool = true, maxDurationMs: Double? = nil,
                sources: Set<RecordingSource> = Set(RecordingSource.allCases), fixedMovieQuality: MovieQuality? = nil,
                reasonUnavailable: [String: String] = [:]) {
        self.targets = targets
        self.fixedMovieQuality = fixedMovieQuality
        self.sources = sources
        self.liveTargetSwitch = liveTargetSwitch
        self.liveMicrophoneMute = liveMicrophoneMute
        self.liveMicrophoneDevice = liveMicrophoneDevice
        self.liveSystemAudioMute = liveSystemAudioMute
        self.liveFrameRate = liveFrameRate
        self.liveRestart = liveRestart
        self.liveCamera = liveCamera
        self.liveDisplaysAddRemove = liveDisplaysAddRemove
        self.maxDurationMs = maxDurationMs
        self.reasonUnavailable = reasonUnavailable
    }

    /// Why a source's control does nothing for this recorder, before a take as well as during one; nil when its
    /// movie holds the source. The reason is `reasonUnavailable["no.<source>"]`.
    public func missingSourceReason(_ controlID: String) -> String? {
        let source: RecordingSource
        switch controlID {
        case "microphone", "microphoneDevice", "micMenu": source = .microphone
        case "systemAudio": source = .systemAudio
        case "camera", "cameraSize", "cameraShape": source = .camera
        default: return nil
        }
        guard !sources.contains(source) else { return nil }
        return reasonUnavailable["no.\(source.rawValue)"] ?? "This recorder's movie has no \(source.title)."
    }

    public func unavailableReason(for change: RecordingSetupChange, in setup: RecordingSetup) -> String? {
        if let missing = missingSourceReason(change.controlID) { return missing }
        let supported: Bool
        switch change {
        case let .target(target):
            guard targets.contains(target.kind) else { return reasonUnavailable[target.kind.rawValue] ?? "This target is unavailable." }
            switch (setup.target?.kind, target.kind) {
            case (.display, .displays), (.displays, .display), (.displays, .displays): supported = liveDisplaysAddRemove
            default: supported = liveTargetSwitch
            }
        case let .microphone(mic):
            if mic.enabled != setup.microphone.enabled { return reasonUnavailable["microphone"] ?? "Choose the microphone source before recording." }
            if mic.deviceID != setup.microphone.deviceID && !liveMicrophoneDevice {
                return reasonUnavailable["microphoneDevice"] ?? "Choose the microphone device before recording."
            }
            supported = mic.muted == setup.microphone.muted || liveMicrophoneMute
        case let .systemAudio(audio):
            if audio.enabled != setup.systemAudio.enabled { return reasonUnavailable["systemAudio"] ?? "Choose system audio before recording." }
            supported = liveSystemAudioMute
        case .camera: supported = liveCamera
        case .frameRate: supported = liveFrameRate
        case .quality, .movieQuality, .drawsCursor: supported = false
        }
        return supported ? nil : (reasonUnavailable[change.controlID] ?? "Choose this setting before recording.")
    }
}

public struct RecordingAudioDevice: Equatable, Codable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var channels: Int
    public var isDefault: Bool

    public init(id: String, name: String, channels: Int = 0, isDefault: Bool = false) {
        self.id = id
        self.name = name
        self.channels = channels
        self.isDefault = isDefault
    }

    private enum CodingKeys: String, CodingKey { case id, name, channels, isDefault = "default" }
}

public enum RecordingEngineError: LocalizedError, Equatable, Sendable {
    case unsupported(String)
    case partialTargetSwitch(RecordingTarget, String)
    case restartEnded(RecordingEngineEvent.Value)

    public var errorDescription: String? {
        switch self {
        case let .unsupported(reason), let .partialTargetSwitch(_, reason), let .restartEnded(.failed(reason)): return reason
        case .restartEnded: return "The recording ended before Restart was confirmed."
        }
    }
}

public struct RecordingEngineEvent: Equatable, Sendable {
    public enum Value: Equatable, Sendable {
        case firstFrame, paused, resumed, stopped(URL?), discarded, failed(String)
        case elapsed(milliseconds: Double), warning(String), audioLevels(microphone: Double, systemAudio: Double)
        /// The display a following take records now; nil while the engine has not said.
        case liveDisplay(RecordingDisplay?)
    }

    public let take: String
    public let value: Value

    public init(take: String, value: Value) {
        self.take = take
        self.value = value
    }
}

@MainActor
public protocol RecordingEngineAdapter: AnyObject {
    var capabilities: RecordingCapabilities { get }
    /// Stable until the next start or restart consumes it. Each take, including a restart, gets a fresh ID.
    /// Even callbacks delivered after that take ends must retain its original ID.
    var nextTakeID: String { get }
    var events: AsyncStream<RecordingEngineEvent> { get }
    /// Returns when the engine accepts the start. Only its first frame signals that the take is recording.
    func start(_ setup: RecordingSetup, excludeWindowIDs: [Int]) async throws
    func pause() async throws
    func resume() async throws
    /// Returns after the engine confirms it stopped. A confirmed stop may have no movie URL.
    func stop() async throws -> URL?
    func discard() async throws
    func restart() async throws
    /// Acknowledges the change, preserving the current pause. A rejected change throws its reason.
    func apply(_ change: RecordingSetupChange) async throws
    func audioDevices() async throws -> (inputs: [RecordingAudioDevice], outputs: [RecordingAudioDevice])
}
