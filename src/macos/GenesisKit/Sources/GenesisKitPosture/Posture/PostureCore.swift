import Foundation
import GenesisKit

/// What the main actor hears about.
struct PostureSnapshot: Equatable, Sendable {
    var state: PostureState
    var healthPercent: Int
    var strength: Double
    var worst: PostureMetricKind?
}

/// The off-main half of the monitor: scoring, the state machine, health and history, under one lock.
/// Vision runs outside the lock on the camera's delivery queue.
///
/// The camera mode and the snapshot are handed on while the lock is held, so they leave in the order
/// they were decided: a frame scored just before a pause can no longer turn the camera back on after
/// the pause turned it off (`setMode` only takes the camera's own lock and queues work; it never calls
/// back into the core). History writes and calibration results leave after the lock is released.
final class PostureCore: @unchecked Sendable {
    typealias Publish = @Sendable (PostureSnapshot, [PostureEvent], PostureAlert?) -> Void

    var publish: Publish? {
        get { lock.withLock { publishHandler } }
        set { lock.withLock { publishHandler = newValue } }
    }

    private let lock = NSLock()
    private var publishHandler: Publish?
    private var configuration: PostureMonitor.Configuration
    private var engine: FramePoseEngine
    private weak var camera: CameraModeControlling?
    private var history: PostureHistoryStore?
    private let feed: PoseSampleFeed
    private let wallClock: () -> Date

    private var machine: PostureStateMachine
    private var baseline: PostureBaseline?
    private var smoother = PostureSmoother()
    private var shoulderGate = PostureShoulderGate()
    private var health: PostureHealth
    private var minutes = PostureMinuteAccumulator()
    private var lastScore: PostureScore?
    private var published: PostureSnapshot?
    private var mode: CameraCaptureMode?
    private var collector: Collector?
    private var scoringHeld = false
    private var shutDown = false
    /// Frames saved on request, for replaying real readings in tests.
    let shots = PostureShotTap()
    /// Dev mode's running debug recording, if any.
    private var debugRecorder: PostureDebugRecorder?

    /// A calibration collection in progress.
    private struct Collector {
        var id: Int
        var count: Int
        var samples: [PoseSample] = []
        var continuation: CheckedContinuation<[PoseSample], Error>
    }

    init(configuration: PostureMonitor.Configuration, engine: FramePoseEngine, camera: CameraModeControlling?,
         history: PostureHistoryStore?, feed: PoseSampleFeed, wallClock: @escaping () -> Date) {
        self.configuration = configuration
        self.engine = engine
        self.camera = camera
        self.history = history
        self.feed = feed
        self.wallClock = wallClock
        machine = PostureStateMachine(timing: Self.timing(for: configuration))
        health = PostureHealth(drainPerSecond: configuration.drainPerSecond, refillPerSecond: configuration.refillPerSecond)
    }

    /// The configured timing, with the credit gap stretched to cover a Battery-saver interval, so a
    /// 2-minute interval does not lose 30 s of every gap from health and history.
    static func timing(for configuration: PostureMonitor.Configuration) -> PostureTiming {
        var timing = configuration.timing
        if configuration.policy == .batterySaver {
            timing.maxCreditGap = max(timing.maxCreditGap, configuration.rates.intervalSeconds * 1.5 + 5)
        }
        return timing
    }

    var historyStore: PostureHistoryStore? { lock.withLock { history } }

    func configure(_ configuration: PostureMonitor.Configuration) {
        locked { () -> [PostureEvent] in
            self.configuration = configuration
            machine.timing = Self.timing(for: configuration)
            health.drainPerSecond = configuration.drainPerSecond
            health.refillPerSecond = configuration.refillPerSecond
            return []
        }
    }

    func setEngine(_ engine: FramePoseEngine) {
        lock.withLock {
            self.engine = engine
            smoother.reset()
            shoulderGate.reset()
        }
    }

    /// A new baseline judges from scratch: a slouch or a pending one measured against the old one ends.
    func setBaseline(_ baseline: PostureBaseline?, at time: TimeInterval) {
        let (store, rows) = locked { () -> [PostureEvent] in
            self.baseline = baseline
            smoother.reset()
            shoulderGate.reset()
            lastScore = nil
            return machine.restartPosture(at: time)
        }
        store?.append(rows)
    }

    /// Holds scoring while a calibration sheet is open: readings still reach the feed and a collection,
    /// but none is judged. Both edges start the posture afresh, so the slouch the sheet asks for never
    /// becomes an episode, and one in progress when the sheet opened does not outlive it.
    func holdScoring(_ hold: Bool, at time: TimeInterval) {
        let (store, rows) = locked { () -> [PostureEvent] in
            guard hold != scoringHeld else { return [] }
            scoringHeld = hold
            smoother.reset()
            shoulderGate.reset()
            lastScore = nil
            return machine.restartPosture(at: time)
        }
        store?.append(rows)
    }

    /// Swaps the history store; the open minute goes to the old one first.
    func setHistory(_ store: PostureHistoryStore?) {
        let (old, rows) = lock.withLock { () -> (PostureHistoryStore?, [PostureMinute]) in
            let old = history
            history = store
            return (old, minutes.flush())
        }
        old?.append(rows)
    }

    func control(enabled: Bool, hasBaseline: Bool, userPause: PosturePause?, gateReasons: Set<ActivityPauseReason>,
                 cameraIssue: PostureCameraIssue?, usesCamera: Bool, at time: TimeInterval) {
        var failed: (Collector, PostureCameraIssue)?
        let (store, rows) = locked { () -> [PostureEvent] in
            let events = machine.setControl(enabled: enabled, hasBaseline: hasBaseline, userPause: .some(userPause),
                                            gateReasons: gateReasons, cameraIssue: .some(cameraIssue),
                                            usesCamera: usesCamera, at: time)
            if !machine.state.isPosturePhase {
                smoother.reset()
                shoulderGate.reset()
                lastScore = nil
                pendingRows += minutes.flush()
            }
            if usesCamera, let cameraIssue, let collector, Self.endsCollection(cameraIssue) {
                self.collector = nil
                failed = (collector, cameraIssue)
            }
            return events
        }
        store?.append(rows)
        if let (collector, issue) = failed {
            collector.continuation.resume(throwing: PostureCalibrationError.cameraUnavailable(issue, collected: collector.samples))
        }
    }

    /// A missing grant or camera ends a calibration at once; an interruption may still recover.
    private static func endsCollection(_ issue: PostureCameraIssue) -> Bool {
        switch issue {
        case .unauthorized, .noDevice: true
        case .interrupted, .failed: false
        }
    }

    /// One camera frame: Vision outside the lock, then the reading. While calibrating, a Vision body
    /// engine also runs the face request, so the baseline holds the face measures, and its 3D shoulder
    /// request on every frame, so the baseline holds the shoulders. Face sampling continues when the
    /// baseline needs face measures, including face growth to corroborate a shoulder-based Forward head.
    func process(_ frame: CameraFrame) {
        let (engine, alwaysFace, calibrating) = lock.withLock { () -> (FramePoseEngine?, Bool, Bool) in
            guard machine.usesCamera, !shutDown else { return (nil, false, false) }
            let watching = machine.state.isWatching && machine.state != .needsCalibration
            return (watching || collector != nil ? self.engine : nil,
                    Self.needsFaceOnEveryFrame(calibrating: collector != nil, baseline: baseline,
                                               liveShoulders: Self.shoulderSource(of: self.engine)),
                    collector != nil)
        }
        guard let engine else { return }
        let body = engine as? VisionBodyPoseEngine
        let saved = body.map { ($0.faceDetection, $0.body3D) }
        if alwaysFace, let body { body.faceDetection = .always }
        if calibrating, let body, body.body3D != .never { body.body3D = .always }
        let sample = engine.analyze(frame)
        if let body, let saved { (body.faceDetection, body.body3D) = saved }
        if let slot = shots.take() { shots.write(frame, sample: sample, to: slot) }
        if let sample, ingest(sample) { body?.readShouldersOnNextFrame() }
        let (recorder, score, state) = lock.withLock { (debugRecorder, lastScore, machine.state) }
        if let recorder, !recorder.append(frame: frame, sample: sample, score: sample == nil ? nil : score, state: state) {
            lock.withLock { if debugRecorder === recorder { debugRecorder = nil } }
        }
    }

    /// Starts a debug recording; one already running ends first.
    func startDebugRecording(_ recorder: PostureDebugRecorder) {
        let previous: PostureDebugRecorder? = lock.withLock {
            let previous = debugRecorder
            debugRecorder = recorder
            recorder.writeStart(baseline: baseline, scorer: configuration.scorer, engine: engine.kind)
            return previous
        }
        previous?.stop()
    }

    func stopDebugRecording() {
        let recorder: PostureDebugRecorder? = lock.withLock {
            let recorder = debugRecorder
            debugRecorder = nil
            return recorder
        }
        recorder?.stop()
    }

    /// Calibration, a face-only baseline, a body baseline whose Forward head ratio is capped by face
    /// growth, or a baseline that cannot judge the live shoulders (`PostureBaseline.shoulderSourceDiffers`, so the
    /// face is all that is left) needs the face on every frame. A body-only baseline still uses fallback face detection.
    static func needsFaceOnEveryFrame(calibrating: Bool, baseline: PostureBaseline?,
                                      liveShoulders: PoseShoulderSource? = nil) -> Bool {
        if calibrating { return true }
        guard let baseline else { return false }
        let metrics = baseline.metrics
        if metrics[.shoulderWidth] == nil || baseline.shoulderSourceDiffers(from: liveShoulders) { return true }
        let hasForwardRatio = metrics[.eyeSpanRatio] != nil || metrics[.faceWidthRatio] != nil
        return hasForwardRatio && (metrics[.faceWidth] ?? 0) > 0
    }

    /// The request a body engine takes the shoulders from, as configured; nil for an engine without shoulders.
    static func shoulderSource(of engine: FramePoseEngine) -> PoseShoulderSource? {
        guard let body = engine as? VisionBodyPoseEngine else { return nil }
        return body.body3D == .never ? .body2D : .body3D
    }

    /// Scores one sample and steps the state machine. Returns true when a shoulder fault waits for a fresh 3D
    /// reading (`PostureShoulderGate`), so the caller asks the engine for one on the next frame.
    @discardableResult
    func ingest(_ sample: PoseSample) -> Bool {
        var readAgain = false
        var finished: Collector?
        var good = false
        var score: PostureScore?
        let (store, rows) = locked { () -> [PostureEvent] in
            if var collecting = collector {
                if sample.hasPerson, !sample.lowLight { collecting.samples.append(sample) }
                if collecting.samples.count >= collecting.count {
                    collector = nil
                    finished = collecting
                } else {
                    collector = collecting
                }
                return []
            }
            if scoringHeld { return [] }
            let metrics = PostureMetrics(sample: sample)
            if let baseline, !metrics.isEmpty, !sample.lowLight {
                let smoothed = smoother.add(metrics, at: sample.time)
                var scorer = configuration.scorer
                // The face engine never sees shoulders: the face width is its own Forward head measure.
                if sample.engine == .visionFace { scorer.forwardHeadWithoutShoulders = nil }
                let source = sample.shoulderSource
                let smoothedScore = scorer.score(smoothed, against: baseline, shoulderSource: source)
                let fresh = sample.hasFreshShoulders && source == .body3D
                    ? scorer.score(metrics, against: baseline, shoulderSource: source) : nil
                (score, readAgain) = shoulderGate.apply(smoothedScore, fresh: fresh, source: source, scorer: scorer)
            }
            lastScore = score
            let step = machine.observe(PostureReading(sample: sample, score: score), at: sample.time)
            health.advance(step.creditedActivity, seconds: step.credited)
            let now = wallClock()
            if step.credited > 0, let activity = step.historyActivity {
                pendingRows += minutes.add(activity, seconds: step.credited, endingAt: now)
            }
            if step.events.contains(.slouchStarted) {
                pendingRows += minutes.addAlert(at: now)
                if let score, let baseline { pendingAlert = PostureAlert(score: score, baseline: baseline, date: now) }
            }
            good = machine.state == .monitoring && !machine.isConfirming && (score?.isClear ?? false)
            return step.events
        }
        store?.append(rows)
        if let finished { finished.continuation.resume(returning: finished.samples) }
        if feed.wantsSamples {
            DispatchQueue.main.async { [feed] in
                MainActor.assumeIsolated { feed.publish(sample, score: score, good: good) }
            }
        }
        return readAgain
    }

    // MARK: - Calibration

    /// Starts collecting `count` samples with a person in them; false when one is already running. The
    /// camera runs at the active rate meanwhile, whatever the state.
    func beginCollecting(id: Int, count: Int, continuation: CheckedContinuation<[PoseSample], Error>) -> Bool {
        var accepted = false
        locked { () -> [PostureEvent] in
            guard collector == nil, !shutDown else { return [] }
            collector = Collector(id: id, count: max(1, count), continuation: continuation)
            accepted = true
            return []
        }
        return accepted
    }

    /// Ends collection `id` with an error (timeout, cancel); nothing when it already ended.
    func endCollecting(id: Int, timedOut: Bool) {
        var ended: Collector?
        locked { () -> [PostureEvent] in
            guard let collector, collector.id == id else { return [] }
            self.collector = nil
            ended = collector
            return []
        }
        guard let ended else { return }
        ended.continuation.resume(throwing: timedOut ? PostureCalibrationError.timedOut(collected: ended.samples)
                                                     : PostureCalibrationError.cancelled)
    }

    var isCollecting: Bool { lock.withLock { collector != nil } }

    // MARK: - Health and history

    func healthSnapshot() -> PostureHealth {
        lock.withLock { health }
    }

    func resetHealth() {
        locked { () -> [PostureEvent] in
            health.reset()
            return []
        }
    }

    /// Writes the open minute and waits until the store has it on disk.
    func flushHistory() {
        let (store, rows) = lock.withLock { (history, minutes.flush()) }
        store?.append(rows)
        store?.flush()
    }

    /// The monitor is gone: camera off, calibration cancelled, the open minute written.
    func shutdown() {
        var ended: Collector?
        let (store, rows) = lock.withLock { () -> (PostureHistoryStore?, [PostureMinute]) in
            shutDown = true
            ended = collector
            collector = nil
            if mode != .off {
                mode = .off
                camera?.setMode(.off)
            }
            publishHandler = nil
            return (history, minutes.flush())
        }
        store?.append(rows)
        ended?.continuation.resume(throwing: PostureCalibrationError.cancelled)
    }

    // MARK: - Output

    private var pendingRows: [PostureMinute] = []
    private var pendingAlert: PostureAlert?

    /// Runs `body` under the lock, then, still under the lock, hands the changed camera mode to the
    /// camera and the changed snapshot (with `body`'s events) to `publish`. Returns the history rows
    /// `body` produced together with their destination, for the caller to write after the unlock.
    @discardableResult
    private func locked(_ body: () -> [PostureEvent]) -> (PostureHistoryStore?, [PostureMinute]) {
        lock.lock()
        defer { lock.unlock() }
        let events = body()
        guard !shutDown else {
            pendingRows = []
            return (history, [])
        }
        let state = machine.state
        let slouching = state == .slouching
        let strength = slouching ? ((lastScore?.strength ?? 0) * 20).rounded() / 20 : 0
        let snapshot = PostureSnapshot(state: state, healthPercent: health.percent, strength: strength,
                                       worst: slouching || state == .recovery ? lastScore?.worst : nil)
        let wanted: CameraCaptureMode
        if !machine.usesCamera {
            wanted = .off
        } else if collector != nil {
            wanted = .continuous(fps: configuration.rates.activeFPS)
        } else {
            wanted = PostureStateMachine.captureMode(state: state, confirming: machine.isConfirming,
                                                     policy: configuration.policy, rates: configuration.rates)
        }
        if wanted != mode {
            mode = wanted
            camera?.setMode(wanted)
        }
        let alert = pendingAlert
        pendingAlert = nil
        if snapshot != published || !events.isEmpty || alert != nil {
            published = snapshot
            publishHandler?(snapshot, events, alert)
        }
        let rows = pendingRows
        pendingRows = []
        return (history, rows)
    }
}
