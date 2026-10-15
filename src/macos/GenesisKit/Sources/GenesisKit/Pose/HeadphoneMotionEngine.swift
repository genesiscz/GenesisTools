import CoreMotion
import Foundation

/// The motion grant, read straight through `CMHeadphoneMotionManager` (not a `PermissionKind` case).
public enum HeadphoneMotionAuthorization: String, Sendable {
    case notDetermined, restricted, denied, authorized
}

/// AirPods head pitch as posture samples, with no camera (`CMHeadphoneMotionManager`, macOS 14).
///
/// - Samples carry `headphonePitch` in radians, positive when the head nods down (Core Motion's
///   `attitude.pitch` falls when the head goes down, so the engine flips the sign; Dorso reads the
///   same value). The calibrated baseline lives in `PostureBaseline`, like the camera measures.
/// - Updates arrive at about 25 Hz and cannot be slowed, so the engine forwards at most one sample per
///   `sampleInterval` (0.5 s) and does nothing else per update (Dorso #51: AirPods mode used a lot of
///   CPU until it skipped work).
/// - With Automatic Ear Detection, taking a bud out sends a disconnect and putting it back a connect
///   (WWDC23 10179). `isConnected` and `onConnectionChange` report it; the connection monitor keeps
///   running while motion updates are stopped, so re-insertion is seen.
/// - macOS ends a process that starts motion updates without `NSMotionUsageDescription`, so `start()`
///   refuses to run without it. The first start shows the motion prompt.
public final class HeadphoneMotionEngine: NSObject, PoseEngine, CMHeadphoneMotionManagerDelegate, @unchecked Sendable {
    public let kind: PoseEngineKind = .headphones
    public let usesCamera = false

    /// Each forwarded sample, on the engine's queue.
    public var onSample: (@Sendable (PoseSample) -> Void)? {
        get { lock.withLock { sampleHandler } }
        set { lock.withLock { sampleHandler = newValue } }
    }
    /// In-ear changes, on the main queue: true when a bud is in an ear and streams.
    public var onConnectionChange: ((Bool) -> Void)? {
        get { lock.withLock { connectionHandler } }
        set { lock.withLock { connectionHandler = newValue } }
    }
    public var sampleInterval: TimeInterval {
        didSet { lock.withLock { throttle = FrameThrottle(fps: 1 / max(sampleInterval, 0.05)) } }
    }

    public var isConnected: Bool { lock.withLock { connected } }
    /// The last pitch seen (positive down), for a calibration screen.
    public var latestPitch: Double? { lock.withLock { lastPitch } }

    /// Made on first use and only with a usage description: creating the manager already sends a
    /// privacy request, which ends a process without `NSMotionUsageDescription` (seen in `swift test`).
    private var manager: CMHeadphoneMotionManager?
    private let queue: OperationQueue
    private let lock = NSLock()
    private var throttle: FrameThrottle
    private var sampleHandler: (@Sendable (PoseSample) -> Void)?
    private var connectionHandler: ((Bool) -> Void)?
    private var connected = false
    private var lastPitch: Double?

    public init(sampleInterval: TimeInterval = 0.5, queue: DispatchQueue? = nil) {
        self.sampleInterval = sampleInterval
        throttle = FrameThrottle(fps: 1 / max(sampleInterval, 0.05))
        let operations = OperationQueue()
        operations.maxConcurrentOperationCount = 1
        operations.qualityOfService = .utility
        operations.underlyingQueue = queue ?? DispatchQueue(label: "genesiskit.headphones", qos: .utility)
        self.queue = operations
        super.init()
    }

    deinit {
        manager?.stopDeviceMotionUpdates()
        manager?.stopConnectionStatusUpdates()
    }

    private func motionManager() -> CMHeadphoneMotionManager? {
        if let manager { return manager }
        guard Self.hasUsageDescription else { return nil }
        let made = CMHeadphoneMotionManager()
        made.delegate = self
        manager = made
        return made
    }

    public static var authorization: HeadphoneMotionAuthorization {
        switch CMHeadphoneMotionManager.authorizationStatus() {
        case .authorized: .authorized
        case .denied: .denied
        case .restricted: .restricted
        case .notDetermined: .notDetermined
        @unknown default: .denied
        }
    }

    /// Whether the running bundle declares `NSMotionUsageDescription`.
    public static var hasUsageDescription: Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSMotionUsageDescription") != nil
    }

    /// Privacy & Security → Motion & Fitness.
    public static var settingsURL: URL { PermissionKind.settingsURL(anchor: "Privacy_Motion") }

    /// Whether a head-tracking headset is paired (AirPods 3 and later, Pro, Max). It reads the motion
    /// manager only once the grant is given (or after `start()`), because making the manager can raise the
    /// Motion prompt; before that it is false. Call it from the main thread.
    public var isAvailable: Bool {
        guard manager != nil || Self.authorization == .authorized else { return false }
        return motionManager()?.isDeviceMotionAvailable ?? false
    }

    /// Starts the in-ear monitor and the motion updates. False, with nothing started, when the bundle has
    /// no usage description, the grant was refused, or no supported headset is paired.
    @discardableResult
    public func start() -> Bool {
        guard Self.hasUsageDescription, let manager = motionManager(),
              Self.canStart(hasUsageDescription: true, authorization: Self.authorization,
                            available: manager.isDeviceMotionAvailable) else { return false }
        lock.withLock { throttle.reset() }
        manager.startConnectionStatusUpdates()
        manager.startDeviceMotionUpdates(to: queue) { [weak self] motion, _ in
            guard let self, let motion else { return }
            self.receive(attitudePitch: motion.attitude.pitch, at: ProcessInfo.processInfo.systemUptime)
        }
        return true
    }

    /// Starts only the in-ear monitor (connect and disconnect), without motion updates: what a paused
    /// monitor or Auto on the camera needs to learn that a bud went in. Same refusals as `start()`.
    @discardableResult
    public func startConnectionMonitor() -> Bool {
        guard Self.hasUsageDescription, let manager = motionManager(),
              Self.canStart(hasUsageDescription: true, authorization: Self.authorization,
                            available: manager.isDeviceMotionAvailable) else { return false }
        manager.startConnectionStatusUpdates()
        return true
    }

    /// Whether `start()` may start Core Motion: never without a usage description (macOS ends the process)
    /// or after a refusal, and only with a supported headset paired.
    static func canStart(hasUsageDescription: Bool, authorization: HeadphoneMotionAuthorization, available: Bool) -> Bool {
        guard hasUsageDescription, available else { return false }
        switch authorization {
        case .denied, .restricted: return false
        case .notDetermined, .authorized: return true
        }
    }

    /// Stops the motion updates. `keepConnectionMonitor` leaves the in-ear monitor on, so a paused
    /// monitor still learns when the buds go back in. Without it nothing reports the buds any more, so
    /// `isConnected` turns false.
    public func stop(keepConnectionMonitor: Bool = false) {
        manager?.stopDeviceMotionUpdates()
        guard !keepConnectionMonitor else { return }
        manager?.stopConnectionStatusUpdates()
        setConnected(false)
    }

    /// One Core Motion update. `attitudePitch` is Core Motion's pitch, which falls when the head nods
    /// down; the sample carries it flipped, positive down.
    func receive(attitudePitch: Double, at time: TimeInterval) {
        let pitch = -attitudePitch
        let (forward, handler, announce): (Bool, (@Sendable (PoseSample) -> Void)?, Bool) = lock.withLock {
            lastPitch = pitch
            // Motion data means a bud is in; the connect callback can lag the first samples.
            let announce = !connected
            connected = true
            return (throttle.admit(time), sampleHandler, announce)
        }
        if announce { DispatchQueue.main.async { [weak self] in self?.onConnectionChange?(true) } }
        guard forward, let handler else { return }
        handler(PoseSample(time: time, engine: .headphones, headphonePitch: pitch, imageAspect: 1))
    }

    public func headphoneMotionManagerDidConnect(_ manager: CMHeadphoneMotionManager) {
        setConnected(true)
    }

    public func headphoneMotionManagerDidDisconnect(_ manager: CMHeadphoneMotionManager) {
        setConnected(false)
    }

    private func setConnected(_ value: Bool) {
        let changed: Bool = lock.withLock {
            guard connected != value else { return false }
            connected = value
            if !value { lastPitch = nil }
            return true
        }
        guard changed else { return }
        DispatchQueue.main.async { [weak self] in self?.onConnectionChange?(value) }
    }
}
