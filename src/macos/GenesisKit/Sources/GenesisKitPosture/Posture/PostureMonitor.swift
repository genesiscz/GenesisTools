import Combine
import Foundation
import GenesisKit

/// Where posture readings come from.
public enum PostureSource: String, CaseIterable, Codable, Sendable {
    case camera
    case headphones
    /// AirPods while a bud is in an ear, the camera otherwise.
    case auto

    public var title: String {
        switch self {
        case .camera: "Camera"
        case .headphones: "AirPods"
        case .auto: "Auto"
        }
    }
}

/// Runs PostureWatcher: camera (or AirPods) readings in, a posture state, a health bar and an effect
/// strength out.
///
/// - Every reading is scored off the main thread, on the camera's delivery queue (or the AirPods
///   queue). The main actor hears only changes: `state`, `healthPercent` (whole percent), `strength`
///   (in 5% steps) and `worst`. A frame that changes none of them costs the main thread nothing.
/// - The live skeleton goes to `feed`, and only while `feed.isWatched` is true.
/// - The monitor sets the camera's mode from its state and the frame-rate policy: off while disabled,
///   paused or not calibrated (the light goes dark), bursts or a low rate while upright, a high rate
///   while a slouch is pending, on or recovering.
/// - A timed pause ends on one wall-clock timer; nothing else runs while paused: the camera is off and
///   AirPods motion stops (their in-ear monitor stays on, so putting a bud back is seen).
/// - History rows go to the `PostureHistoryStore`, which writes off the main thread.
/// - Releasing the monitor turns the camera off, stops AirPods motion and cancels a calibration, even
///   without `disable()`.
@MainActor
public final class PostureMonitor: ObservableObject {
    public struct Configuration: Equatable, Sendable {
        public var scorer: PostureScorer
        public var timing: PostureTiming
        public var policy: PostureFrameRatePolicy
        public var rates: PostureCaptureRates
        /// The activity-gate reasons that pause watching; the gate's other reasons are ignored.
        public var pauseReasons: Set<ActivityPauseReason>
        public var drainPerSecond: Double
        public var refillPerSecond: Double

        /// Lock, sleep, screen sleep, screen saver and another user's session always make sense; the
        /// battery, laptop-only, call and idle pauses are opt-in (Dorso has them as options).
        public static let defaultPauseReasons: Set<ActivityPauseReason> = [
            .systemSleep, .screensAsleep, .screenLocked, .screenSaver, .sessionInactive, .headphonesRemoved,
        ]

        public init(scorer: PostureScorer = PostureScorer(), timing: PostureTiming = PostureTiming(),
                    policy: PostureFrameRatePolicy = .default, rates: PostureCaptureRates = PostureCaptureRates(),
                    pauseReasons: Set<ActivityPauseReason> = defaultPauseReasons,
                    drainPerSecond: Double = PostureHealth.defaultDrainPerSecond,
                    refillPerSecond: Double = PostureHealth.defaultRefillPerSecond) {
            self.scorer = scorer
            self.timing = timing
            self.policy = policy
            self.rates = rates
            self.pauseReasons = pauseReasons
            self.drainPerSecond = drainPerSecond
            self.refillPerSecond = refillPerSecond
        }
    }

    @Published public private(set) var state: PostureState = .disabled
    @Published public private(set) var healthPercent = 100
    /// What a screen effect should show, 0...1 in 5% steps (`severity ^ (1 / sensitivity)`).
    @Published public private(set) var strength: Double = 0
    /// The fault behind the current slouch, nil while upright.
    @Published public private(set) var worst: PostureMetricKind?
    /// The camera's own state, every change (starting, running and waiting change at each burst).
    @Published public private(set) var cameraState: CameraSourceState = .stopped
    @Published public private(set) var source: PostureSource = .camera
    /// The alert of the latest slouch episode: the fault, its drift and severity. Set when an episode
    /// starts, kept after it ends.
    @Published public private(set) var lastAlert: PostureAlert?

    public let feed: PoseSampleFeed
    /// Events (state changes, slouch started, recovery, streak reset) on the main actor.
    public var onEvent: ((PostureEvent) -> Void)?
    /// Each new slouch episode's alert, on the main actor, right after its `.slouchStarted` event.
    public var onAlert: ((PostureAlert) -> Void)?

    public var configuration: Configuration {
        didSet {
            guard configuration != oldValue else { return }
            core.configure(configuration)
            push()
        }
    }

    public private(set) var baseline: PostureBaseline?
    public private(set) var isEnabled = false
    public var health: PostureHealth { core.healthSnapshot() }
    /// Where per-minute rows go; nil keeps no history. Change it with `setHistory(_:)`.
    public var history: PostureHistoryStore? { core.historyStore }
    public let camera: CameraFrameSource?

    private let core: PostureCore
    private var userPause: PosturePause?
    nonisolated(unsafe) private var pauseTimer: DispatchSourceTimer?
    private var gateReasons: Set<ActivityPauseReason> = []
    nonisolated(unsafe) private var headphones: HeadphoneMotionEngine?
    private var headphonesConnected = false
    private var motionRunning = false
    private var connectionMonitorRunning = false
    private var collecting = false
    private var nextCollectionID = 0
    private var gateSubscription: AnyCancellable?
    private weak var gate: ActivityGate?
    private let clock: () -> TimeInterval

    /// - Parameters:
    ///   - camera: the camera to drive; nil for an AirPods-only monitor. The monitor takes over its
    ///     `onFrame` and `onStateChange`.
    ///   - engine: the camera pose engine; Vision body pose by default.
    ///   - history: where per-minute rows go; nil keeps no history.
    public convenience init(configuration: Configuration = Configuration(), camera: CameraFrameSource?,
                            engine: FramePoseEngine = VisionBodyPoseEngine(), history: PostureHistoryStore? = nil) {
        self.init(configuration: configuration, camera: camera, cameraControl: camera, engine: engine, history: history,
                  clock: { ProcessInfo.processInfo.systemUptime }, wallClock: Date.init)
    }

    init(configuration: Configuration, camera: CameraFrameSource?, cameraControl: CameraModeControlling?,
         engine: FramePoseEngine, history: PostureHistoryStore?, clock: @escaping () -> TimeInterval,
         wallClock: @escaping () -> Date) {
        self.configuration = configuration
        self.camera = camera
        self.clock = clock
        let feed = PoseSampleFeed()
        self.feed = feed
        core = PostureCore(configuration: configuration, engine: engine, camera: cameraControl, history: history,
                           feed: feed, wallClock: wallClock)
        core.publish = { @Sendable [weak self] snapshot, events, alert in
            DispatchQueue.main.async {
                MainActor.assumeIsolated { self?.apply(snapshot, events: events, alert: alert) }
            }
        }
        let core = self.core
        if let camera {
            camera.onFrame = { @Sendable [weak core] frame in core?.process(frame) }
            camera.onStateChange = { [weak self] state in
                MainActor.assumeIsolated { self?.cameraChanged(state) }
            }
        }
    }

    deinit {
        core.shutdown()
        pauseTimer?.cancel()
        if let headphones {
            headphones.onSample = nil
            headphones.onConnectionChange = nil
            headphones.stop()
        }
    }

    // MARK: - Control

    public func enable() {
        guard !isEnabled else { return }
        isEnabled = true
        push()
    }

    /// Stops watching; the camera turns off and a running effect clears.
    public func disable() {
        guard isEnabled else { return }
        isEnabled = false
        push()
    }

    /// Sets the baseline readings are judged against. A different one starts the posture afresh: a slouch
    /// measured against the old baseline ends.
    public func setBaseline(_ baseline: PostureBaseline?) {
        guard baseline != self.baseline else { return }
        self.baseline = baseline
        core.setBaseline(baseline, at: clock())
        push()
    }

    /// Whether `holdScoring(true)` is in force.
    public private(set) var isScoringHeld = false

    /// Holds scoring while a calibration sheet is open. Readings still reach `feed` (the sheet's live
    /// skeleton) and a collection, but none is judged, so the slouch the sheet asks for never starts an
    /// episode or an alert. Holding and releasing both start the posture afresh, with the resume grace.
    public func holdScoring(_ hold: Bool) {
        guard hold != isScoringHeld else { return }
        isScoringHeld = hold
        core.holdScoring(hold, at: clock())
    }

    /// Swaps the history store without touching the rest of the pipeline ("Keep history" off is nil).
    /// The open minute is written to the old store first.
    public func setHistory(_ store: PostureHistoryStore?) {
        core.setHistory(store)
    }

    /// Pauses for `seconds` (the "Pause 10 min" button).
    public func pause(for seconds: TimeInterval) {
        pause(until: Date().addingTimeInterval(seconds))
    }

    /// Pauses until a date, or until `resume()` when nil.
    public func pause(until date: Date?) {
        userPause = PosturePause(reasons: [.user], until: date)
        pauseTimer?.cancel()
        pauseTimer = nil
        if let date {
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(wallDeadline: .now() + max(date.timeIntervalSinceNow, 0), leeway: .seconds(1))
            timer.setEventHandler { [weak self] in
                MainActor.assumeIsolated { self?.resume() }
            }
            timer.resume()
            pauseTimer = timer
        }
        push()
    }

    public func resume() {
        pauseTimer?.cancel()
        pauseTimer = nil
        guard userPause != nil else { return }
        userPause = nil
        push()
    }

    /// Follows an activity gate: its reasons (filtered by `configuration.pauseReasons`) pause watching,
    /// and it watches the chosen camera for use by another app.
    public func observe(gate: ActivityGate) {
        self.gate = gate
        gateSubscription = gate.$reasons.sink { [weak self] reasons in
            MainActor.assumeIsolated { self?.gateChanged(reasons) }
        }
        gate.observeCamera(uniqueID: camera?.activeDeviceID)
    }

    /// Switches the camera's pose engine (Vision body or face).
    public func setEngine(_ engine: FramePoseEngine) {
        core.setEngine(engine)
    }

    /// Chooses the reading source. `headphones` is the AirPods engine to use for `.headphones` and `.auto`.
    public func setSource(_ source: PostureSource, headphones: HeadphoneMotionEngine?) {
        if self.headphones !== headphones {
            if let old = self.headphones {
                old.onSample = nil
                old.onConnectionChange = nil
                old.stop()
            }
            motionRunning = false
            connectionMonitorRunning = false
            self.headphones = headphones
            let core = self.core
            headphones?.onSample = { @Sendable [weak core] sample in core?.ingest(sample) }
            headphones?.onConnectionChange = { [weak self] connected in
                MainActor.assumeIsolated {
                    self?.headphonesConnected = connected
                    self?.push()
                }
            }
        }
        headphonesConnected = headphones?.isConnected ?? false
        self.source = source
        push()
    }

    /// Gathers `count` samples with a person in them from the running pipeline, for a calibration. The
    /// camera (or AirPods) runs at the active rate while it collects, whatever the state, and a Vision
    /// body engine adds the face request so the baseline holds the face measures too. Readings are not
    /// scored meanwhile. Throws `PostureCalibrationError`: `.busy` while another collection runs,
    /// `.timedOut` (with what it gathered) after `timeout` seconds, `.cameraUnavailable` without a grant
    /// or a camera, `.cancelled` when the task is cancelled or the monitor goes away.
    public func collectCalibrationSamples(count: Int, timeout: TimeInterval) async throws -> [PoseSample] {
        if Task.isCancelled { throw PostureCalibrationError.cancelled }
        nextCollectionID += 1
        let id = nextCollectionID
        let core = self.core
        if case .unauthorized = cameraState, !usesHeadphones {
            throw PostureCalibrationError.cameraUnavailable(.unauthorized, collected: [])
        }
        collecting = true
        push()
        defer {
            collecting = false
            push()
        }
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                guard core.beginCollecting(id: id, count: count, continuation: continuation) else {
                    continuation.resume(throwing: PostureCalibrationError.busy)
                    return
                }
                DispatchQueue.global(qos: .utility).asyncAfter(deadline: .now() + max(timeout, 0)) {
                    core.endCollecting(id: id, timedOut: true)
                }
            }
        } onCancel: {
            core.endCollecting(id: id, timedOut: false)
        }
    }

    /// Saves the next `count` camera frames to `<directory>/<label>/` as PNG, each with the sample the
    /// engine read from it as JSON, for replaying in tests. Only frames the monitor analyzes count: it
    /// must be watching (or calibrating). The frames show the user, so keep `directory` out of git.
    public nonisolated func captureShots(count: Int, label: String, into directory: URL) {
        core.shots.start(count: count, label: label, directory: directory)
    }

    /// Dev mode's "Record for debug": the analyzed camera frames go to `<folder>/movie.mp4` and every
    /// reading (sample, measures, score with each signal, state) to `<folder>/log.ndjson`, after a `start`
    /// line with the baseline and the scorer. It ends after `maxDuration` seconds of frames or at
    /// `stopDebugRecording()`; `completion` then runs once, off the main thread. Only frames the monitor
    /// analyzes are recorded, so it must be watching or calibrating. The movie shows the user: keep
    /// `folder` private.
    public nonisolated func startDebugRecording(into folder: URL, maxDuration: TimeInterval = 10,
                                                completion: @escaping @Sendable (PostureDebugRecording) -> Void) {
        core.startDebugRecording(PostureDebugRecorder(folder: folder, maxDuration: maxDuration, completion: completion))
    }

    public nonisolated func stopDebugRecording() {
        core.stopDebugRecording()
    }

    /// Feeds a sample from any source, from any thread (tests, a custom engine).
    public nonisolated func ingest(_ sample: PoseSample) {
        core.ingest(sample)
    }

    /// Full bar, no streaks (a new day).
    public func resetHealth() {
        core.resetHealth()
    }

    /// Writes the open history minute and waits until it is on disk (call it before quit).
    public func flushHistory() {
        core.flushHistory()
    }

    // MARK: - Internals

    /// AirPods drive the monitor when chosen, or in Auto while a bud is in and the baseline has an
    /// AirPods pitch (otherwise Auto keeps the camera rather than stopping for a calibration).
    private var usesHeadphones: Bool {
        Self.readsHeadphones(source: source, hasEngine: headphones != nil, connected: headphonesConnected, baseline: baseline)
    }

    static func readsHeadphones(source: PostureSource, hasEngine: Bool, connected: Bool, baseline: PostureBaseline?) -> Bool {
        switch source {
        case .camera: false
        case .headphones: true
        case .auto: hasEngine && connected && covers(baseline, headphones: true)
        }
    }

    func gateChanged(_ reasons: Set<ActivityPauseReason>) {
        gateReasons = reasons
        push()
    }

    private func cameraChanged(_ state: CameraSourceState) {
        let issueChanged = cameraState.issue != state.issue
        if cameraState != state { cameraState = state }
        if state == .running, let gate { gate.observeCamera(uniqueID: camera?.activeDeviceID) }
        // A burst changes the state three times; only a change of issue changes the posture state.
        if issueChanged { push() }
    }

    /// Hands every control input to the core in one step, and runs AirPods motion only while it is read.
    private func push() {
        var reasons = gateReasons.intersection(configuration.pauseReasons)
        reasons.remove(.headphonesRemoved)
        if source == .headphones, !headphonesConnected, configuration.pauseReasons.contains(.headphonesRemoved) {
            reasons.insert(.headphonesRemoved)
        }
        let headphones = usesHeadphones
        let hasBaseline = Self.covers(baseline, headphones: headphones)
        core.control(enabled: isEnabled, hasBaseline: hasBaseline,
                     userPause: userPause, gateReasons: reasons, cameraIssue: cameraState.issue,
                     usesCamera: !headphones, at: clock())
        let watching = isEnabled && hasBaseline && userPause == nil && reasons.isEmpty
        updateHeadphones(motion: (watching || collecting) && headphones,
                         monitor: (isEnabled || collecting) && source != .camera)
    }

    /// Starts or stops AirPods motion and the in-ear monitor to match what is needed.
    private func updateHeadphones(motion: Bool, monitor: Bool) {
        guard let headphones else { return }
        if motion, !motionRunning {
            motionRunning = headphones.start()
            connectionMonitorRunning = motionRunning
            if !motionRunning { headphonesConnected = false }
        } else if !motion, motionRunning {
            headphones.stop(keepConnectionMonitor: monitor)
            motionRunning = false
            connectionMonitorRunning = monitor
        }
        if monitor, !connectionMonitorRunning {
            connectionMonitorRunning = headphones.startConnectionMonitor()
        } else if !monitor, connectionMonitorRunning, !motionRunning {
            headphones.stop()
            connectionMonitorRunning = false
        }
    }

    /// Whether the baseline has measures for the active source.
    static func covers(_ baseline: PostureBaseline?, headphones: Bool) -> Bool {
        guard let baseline else { return false }
        if headphones { return baseline.metrics[.headphonePitch] != nil }
        return baseline.metrics.values.keys.contains { $0 != .headphonePitch }
    }

    private func apply(_ snapshot: PostureSnapshot, events: [PostureEvent], alert: PostureAlert?) {
        if state != snapshot.state { state = snapshot.state }
        if healthPercent != snapshot.healthPercent { healthPercent = snapshot.healthPercent }
        if strength != snapshot.strength { strength = snapshot.strength }
        if worst != snapshot.worst { worst = snapshot.worst }
        if let alert, lastAlert != alert { lastAlert = alert }
        events.forEach { onEvent?($0) }
        if let alert { onAlert?(alert) }
    }
}
