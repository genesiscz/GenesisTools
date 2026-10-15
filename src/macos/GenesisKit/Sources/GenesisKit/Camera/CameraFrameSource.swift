import AppKit
import AVFoundation
import CoreVideo
import Foundation

/// Something that runs a camera in a mode. `CameraFrameSource` is the real one; tests use a recorder.
public protocol CameraModeControlling: AnyObject {
    func setMode(_ mode: CameraCaptureMode)
}

/// What a `CameraFrameSource` is doing.
public enum CameraSourceState: Equatable, Sendable {
    /// Mode off; the session is stopped and the light is dark.
    case stopped
    case starting
    case running
    /// Interval mode between bursts: stopped, light dark, next burst scheduled.
    case waiting
    /// macOS stopped the session (sleep, lock, another app) while it should run.
    case interrupted
    case failed(String)
    case unauthorized
    case noDevice

    /// The posture issue this state means, nil when the camera is fine or simply off.
    public var issue: PostureCameraIssue? {
        switch self {
        case .stopped, .starting, .running, .waiting: nil
        case .interrupted: .interrupted
        case let .failed(message): .failed(message)
        case .unauthorized: .unauthorized
        case .noDevice: .noDevice
        }
    }
}

/// One camera, run as cheaply as the mode allows.
///
/// - The session uses the 640x480 preset (a new session defaults to High; Dorso found smaller presets
///   broke capture cards) and 32BGRA pixels, and drops late frames.
/// - A continuous mode sets the device's own minimum frame duration when the active format supports the
///   rate, so the sensor slows down, and drops extra frames in software otherwise. A rate of zero or
///   less is the same as `.off`.
/// - Interval mode starts the session for a burst, discards frames until the exposure settles
///   (`CameraWarmup`), delivers a few frames about 0.2 s apart and stops, so the light is off between
///   bursts. A `DispatchSourceTimer` with 10% leeway schedules the bursts. Each burst has a number, so
///   a burst that ends after a newer mode began (a slouch seen on its last frame) changes nothing.
/// - Frames are delivered on `deliveryQueue` (utility QoS by default). Do the pose work there: while it
///   runs, late frames are dropped, which is the back-pressure.
/// - It recovers by itself from a runtime error, from macOS stopping the session, from a wake, and from
///   the camera being unplugged and plugged back. A watchdog restarts a continuous session that delivered
///   no frame for 10 s. Restarts stop after three in a row without a delivered frame; the state is then
///   `.failed` and the light is off until the next `setMode` or `refresh()`.
///
/// It never asks for camera access: the host calls `CameraAuthorization.request()` and then `refresh()`.
/// Thread-safe: every method may be called from any thread.
public final class CameraFrameSource: NSObject, CameraModeControlling, @unchecked Sendable {
    /// The capture session, for a preview layer (`CameraPreviewView`). Do not reconfigure it.
    public var session: AVCaptureSession { driver.session }
    /// Each delivered frame, on `deliveryQueue`.
    public var onFrame: (@Sendable (CameraFrame) -> Void)? {
        get { lock.withLock { frameHandler } }
        set { lock.withLock { frameHandler = newValue } }
    }
    /// Each state change, on the main queue.
    public var onStateChange: ((CameraSourceState) -> Void)? {
        get { lock.withLock { stateHandler } }
        set { lock.withLock { stateHandler = newValue } }
    }

    /// The current state (any thread).
    public var state: CameraSourceState { lock.withLock { currentState } }
    /// The unique id of the camera in use, nil before one was found.
    public var activeDeviceID: String? { driver.activeDeviceID }
    public var mode: CameraCaptureMode { lock.withLock { desiredMode } }

    public let deliveryQueue: DispatchQueue
    private let sessionQueue = DispatchQueue(label: "genesiskit.camera.session", qos: .utility)
    private let driver: CameraSessionDriving
    private let warmupTemplate: CameraWarmup
    private let lock = NSLock()
    /// Reads the camera grant; tests pass a fixed answer so no camera is ever opened.
    private let authorization: @Sendable () -> CameraAuthorizationStatus

    // Guarded by `lock` (touched from the frame queue and the session queue).
    private var frameHandler: (@Sendable (CameraFrame) -> Void)?
    private var stateHandler: ((CameraSourceState) -> Void)?
    private var currentState: CameraSourceState = .stopped
    private var desiredMode: CameraCaptureMode = .off
    private var phase: Phase = .idle
    private var throttle = FrameThrottle(fps: 1)
    private var warmup: CameraWarmup
    private var burstRemaining = 0
    /// The burst in progress, 0 for none. `apply` clears it, so an older burst's end is ignored.
    private var burstID = 0
    private var nextBurstID = 0
    /// When the last frame was delivered (not merely received), for the watchdog.
    private var lastDelivered: TimeInterval = 0
    /// Restarts since the last delivered frame.
    private var restartAttempts = 0

    // Session queue only.
    private var selection: CameraSelection
    private var intervalTimer: DispatchSourceTimer?
    private var watchdog: DispatchSourceTimer?
    private var burstDeadline: DispatchWorkItem?
    private var observers: [NSObjectProtocol] = []
    private var workspaceObservers: [NSObjectProtocol] = []

    private enum Phase: Equatable {
        case idle
        case continuous
        case burstWarmup
        case burstCapture
    }

    /// Frames of a burst are spaced this far apart (SpineSpy and the PoseEngines research: 3 frames
    /// about 200 ms apart).
    public static let burstSpacing: TimeInterval = 0.2
    /// A burst that delivers nothing in this long gives up until the next one.
    public static let burstTimeout: TimeInterval = 5
    /// A continuous session with no delivered frame for this long is restarted.
    public static let watchdogInterval: TimeInterval = 10
    /// Restarts in a row, without a delivered frame between them, before the source gives up.
    public static let maximumRestarts = 3

    public convenience init(selection: CameraSelection = .systemDefault, preset: AVCaptureSession.Preset = .vga640x480,
                            deliveryQueue: DispatchQueue? = nil, warmup: CameraWarmup = CameraWarmup()) {
        self.init(selection: selection, deliveryQueue: deliveryQueue, warmup: warmup,
                  authorization: { CameraAuthorization.status }, driver: AVCameraSessionDriver(preset: preset))
    }

    init(selection: CameraSelection, deliveryQueue: DispatchQueue?, warmup: CameraWarmup,
         authorization: @escaping @Sendable () -> CameraAuthorizationStatus, driver: CameraSessionDriving) {
        self.authorization = authorization
        self.selection = selection
        self.driver = driver
        self.deliveryQueue = deliveryQueue ?? DispatchQueue(label: "genesiskit.camera.frames", qos: .utility)
        warmupTemplate = warmup
        self.warmup = warmup
        super.init()
        driver.attach(delegate: self, queue: self.deliveryQueue)
        driver.onEvent = { [weak self] event in
            guard let self else { return }
            sessionQueue.async { self.driverEvent(event) }
        }
        installObservers()
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        workspaceObservers.forEach { NSWorkspace.shared.notificationCenter.removeObserver($0) }
        intervalTimer?.cancel()
        watchdog?.cancel()
        burstDeadline?.cancel()
        // Stopping blocks for a moment; do it on the session queue, not on the thread that let go.
        let driver = driver
        sessionQueue.async { driver.stop() }
    }

    // MARK: - Control

    public func setMode(_ mode: CameraCaptureMode) {
        let changed = lock.withLock { () -> Bool in
            guard desiredMode != mode else { return false }
            desiredMode = mode
            return true
        }
        guard changed else { return }
        sessionQueue.async { self.apply(mode) }
    }

    /// Switches camera. Takes effect at once when the camera runs.
    public func select(_ selection: CameraSelection) {
        sessionQueue.async {
            guard self.selection != selection else { return }
            self.selection = selection
            self.driver.removeInput()
            self.apply(self.mode)
        }
    }

    /// Reads authorization and devices again and applies the mode (call after a grant). Also clears a
    /// `.failed` state the restart cap left.
    public func refresh() {
        sessionQueue.async {
            self.lock.withLock { self.restartAttempts = 0 }
            self.apply(self.mode)
        }
    }

    /// Mode off.
    public func stop() { setMode(.off) }

    /// The frame duration to ask the device for: 1 / (the lowest supported rate at or above `fps`).
    /// Nil when no range reaches `fps`. Pure, for tests.
    public static func frameDuration(for fps: Double, ranges: [(min: Double, max: Double)]) -> Double? {
        guard fps > 0 else { return nil }
        let rates = ranges.compactMap { range -> Double? in
            guard range.max >= fps else { return nil }
            return max(range.min, fps)
        }
        guard let rate = rates.min(), rate > 0 else { return nil }
        return 1 / rate
    }

    /// Runs `body` on the session queue and waits (tests).
    func syncOnSessionQueue(_ body: () -> Void = {}) {
        sessionQueue.sync(execute: body)
    }

    // MARK: - Session queue

    private func apply(_ mode: CameraCaptureMode) {
        intervalTimer?.cancel()
        intervalTimer = nil
        watchdog?.cancel()
        watchdog = nil
        burstDeadline?.cancel()
        burstDeadline = nil
        // Whatever ran before is over: a burst that ends from here on is ignored.
        lock.withLock { burstID = 0 }
        switch mode {
        case .off:
            turnOff()
        case let .continuous(fps) where !(fps > 0):
            turnOff()
        case let .continuous(fps):
            guard prepare() else { return }
            lock.withLock {
                throttle = FrameThrottle(fps: fps)
                phase = .continuous
                lastDelivered = ProcessInfo.processInfo.systemUptime
            }
            startSession()
            // After the start: starting can apply the preset's format, which resets the frame duration.
            driver.setFrameRate(fps)
            armWatchdog(fps: fps)
        case let .interval(every, frames):
            guard prepare() else { return }
            let timer = DispatchSource.makeTimerSource(queue: sessionQueue)
            let period = max(every, 1)
            timer.schedule(deadline: .now() + period, repeating: period,
                           leeway: .milliseconds(Int(period * 100)))
            timer.setEventHandler { [weak self] in self?.startBurst(frames: frames) }
            timer.resume()
            intervalTimer = timer
            startBurst(frames: frames)
        }
    }

    private func turnOff() {
        lock.withLock { phase = .idle }
        driver.stop()
        publish(.stopped)
    }

    /// Checks the grant and the device. False (with the state published) when the camera cannot run.
    private func prepare() -> Bool {
        guard authorization() == .authorized else {
            driver.stop()
            publish(.unauthorized)
            return false
        }
        if let problem = driver.prepare(selection: selection) {
            driver.stop()
            publish(problem)
            return false
        }
        return true
    }

    private func startSession() {
        if driver.isRunning {
            publish(.running)
            return
        }
        publish(.starting)
        if driver.start() {
            publish(.running)
        } else {
            publish(.failed("The camera did not start."))
            scheduleRestart(after: 2)
        }
    }

    private func startBurst(frames: Int) {
        guard mode.usesCamera, prepare() else { return }
        let id = lock.withLock { () -> Int in
            nextBurstID += 1
            burstID = nextBurstID
            warmup = warmupTemplate
            throttle = FrameThrottle(fps: 1 / Self.burstSpacing)
            burstRemaining = max(1, frames)
            phase = .burstWarmup
            return burstID
        }
        startSession()
        // The device's default (full) rate during a burst: auto exposure converges per frame, so more
        // frames settle it sooner; the throttle spaces the frames that are kept. Reset after the start,
        // which can apply the preset's format.
        driver.resetFrameRate()
        let deadline = DispatchWorkItem { [weak self] in self?.endBurst(id) }
        burstDeadline = deadline
        sessionQueue.asyncAfter(deadline: .now() + Self.burstTimeout, execute: deadline)
    }

    /// Ends burst `id`; does nothing when a newer mode or burst began since.
    private func endBurst(_ id: Int) {
        let current = lock.withLock { () -> Bool in
            guard burstID == id else { return false }
            burstID = 0
            phase = .idle
            return true
        }
        guard current else { return }
        burstDeadline?.cancel()
        burstDeadline = nil
        guard case .interval = mode else { return }
        driver.stop()
        publish(.waiting)
    }

    private func armWatchdog(fps: Double) {
        let timer = DispatchSource.makeTimerSource(queue: sessionQueue)
        let period = max(Self.watchdogInterval, 3 / fps)
        timer.schedule(deadline: .now() + period, repeating: period, leeway: .seconds(2))
        timer.setEventHandler { [weak self] in
            self?.checkWatchdog(now: ProcessInfo.processInfo.systemUptime, silence: period)
        }
        timer.resume()
        watchdog = timer
    }

    /// One watchdog tick: restart a continuous session that delivered nothing for `silence` seconds, at
    /// most `maximumRestarts` times in a row; then give up with the light off.
    func checkWatchdog(now: TimeInterval, silence: TimeInterval = CameraFrameSource.watchdogInterval) {
        guard case .continuous = mode else { return }
        let silent = now - lock.withLock { lastDelivered }
        guard silent >= silence else { return }
        GenesisKit.log("camera: no frame for \(Int(silent)) s, restarting the session")
        restart(reason: "The camera delivers no frames.")
    }

    /// Restarts the session, counting the attempt; past the cap it stops and reports `.failed`.
    private func restart(reason: String) {
        let attempt = lock.withLock { () -> Int in
            restartAttempts += 1
            return restartAttempts
        }
        guard attempt <= Self.maximumRestarts else {
            watchdog?.cancel()
            watchdog = nil
            intervalTimer?.cancel()
            intervalTimer = nil
            lock.withLock { phase = .idle }
            driver.stop()
            publish(.failed(reason))
            return
        }
        driver.removeInput()
        apply(mode)
    }

    private func scheduleRestart(after seconds: TimeInterval) {
        sessionQueue.asyncAfter(deadline: .now() + seconds) { [weak self] in
            guard let self, mode.usesCamera else { return }
            restart(reason: "The camera did not start.")
        }
    }

    private func driverEvent(_ event: CameraDriverEvent) {
        switch event {
        case let .runtimeError(message):
            GenesisKit.log("camera: runtime error: \(message)")
            publish(.failed(message))
            scheduleRestart(after: 1)
        case .stoppedUnexpectedly:
            guard !driver.isRunning, case .continuous = mode else { return }
            publish(.interrupted)
            scheduleRestart(after: 2)
        }
    }

    private func publish(_ state: CameraSourceState) {
        let changed = lock.withLock { () -> Bool in
            guard currentState != state else { return false }
            currentState = state
            return true
        }
        guard changed else { return }
        DispatchQueue.main.async { [weak self] in self?.onStateChange?(state) }
    }

    private func installObservers() {
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureDevice.wasDisconnectedNotification, object: nil, queue: nil) { [weak self] note in
            guard let self, let device = note.object as? AVCaptureDevice else { return }
            let id = device.uniqueID
            sessionQueue.async {
                guard id == self.driver.activeDeviceID else { return }
                self.driver.removeInput()
                self.apply(self.mode)
            }
        })
        observers.append(center.addObserver(forName: AVCaptureDevice.wasConnectedNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            sessionQueue.async {
                guard self.driver.activeDeviceID == nil, self.mode.usesCamera else { return }
                self.lock.withLock { self.restartAttempts = 0 }
                self.apply(self.mode)
            }
        })
        workspaceObservers.append(NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didWakeNotification, object: nil, queue: nil
        ) { [weak self] _ in
            guard let self else { return }
            sessionQueue.async {
                self.lock.withLock { self.restartAttempts = 0 }
                guard case .continuous = self.mode else { return }
                self.driver.removeInput()
                self.apply(self.mode)
            }
        })
    }

    // MARK: - Frames

    /// One frame from the camera at `now` (uptime seconds): dropped, or delivered to `onFrame`. Runs on
    /// the delivery queue; tests call it with a synthetic buffer.
    func handleFrame(_ pixelBuffer: CVPixelBuffer, at now: TimeInterval) {
        enum Action { case drop, deliver(burst: Int?, last: Bool) }
        var luma: Double?
        let adjusting = driver.isAdjustingExposure
        let action: Action = lock.withLock {
            switch phase {
            case .idle:
                return .drop
            case .continuous:
                guard throttle.admit(now) else { return .drop }
                lastDelivered = now
                restartAttempts = 0
                return .deliver(burst: nil, last: false)
            case .burstWarmup:
                luma = PixelLuma.mean(pixelBuffer)
                guard warmup.settled(at: now, luma: luma, adjustingExposure: adjusting) else { return .drop }
                phase = .burstCapture
                throttle.reset()
                fallthrough
            case .burstCapture:
                guard throttle.admit(now) else { return .drop }
                lastDelivered = now
                restartAttempts = 0
                burstRemaining -= 1
                let last = burstRemaining <= 0
                if last { phase = .idle }
                return .deliver(burst: burstID, last: last)
            }
        }
        guard case let .deliver(burst, last) = action else { return }
        if luma == nil { luma = PixelLuma.mean(pixelBuffer) }
        let frame = CameraFrame(pixelBuffer: pixelBuffer, time: now, meanLuma: luma, isBurst: burst != nil)
        lock.withLock { frameHandler }?(frame)
        if last, let burst { sessionQueue.async { self.endBurst(burst) } }
    }
}

extension CameraFrameSource: AVCaptureVideoDataOutputSampleBufferDelegate {
    public func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer,
                              from connection: AVCaptureConnection) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        handleFrame(pixelBuffer, at: ProcessInfo.processInfo.systemUptime)
    }
}
