import AVFoundation
import CoreVideo
import Foundation

/// The AVFoundation half of a `CameraFrameSource`: the session, its input and output, and the device's
/// frame rate. The source keeps the scheduling (modes, bursts, watchdog, recovery), so tests drive that
/// with a fake driver and never open a camera. Every method runs on the source's session queue.
protocol CameraSessionDriving: AnyObject {
    /// The session a preview layer shows.
    var session: AVCaptureSession { get }
    var isRunning: Bool { get }
    /// The opened camera's unique id (any thread).
    var activeDeviceID: String? { get }
    /// Whether the opened camera is adjusting its exposure (any thread).
    var isAdjustingExposure: Bool { get }
    /// Events the session reports by itself, on any thread.
    var onEvent: ((CameraDriverEvent) -> Void)? { get set }

    /// Sends frames to `delegate` on `queue`.
    func attach(delegate: AVCaptureVideoDataOutputSampleBufferDelegate, queue: DispatchQueue)
    /// Opens the selected camera when none is open. Nil on success, else the state that says why not.
    func prepare(selection: CameraSelection) -> CameraSourceState?
    /// Starts the session; true when it runs afterwards.
    func start() -> Bool
    func stop()
    /// Closes the camera (it was unplugged, or another one was chosen).
    func removeInput()
    func setFrameRate(_ fps: Double)
    func resetFrameRate()
}

enum CameraDriverEvent: Equatable, Sendable {
    case runtimeError(String)
    /// macOS stopped the session without being asked (sleep, lock, another app).
    case stoppedUnexpectedly
}

/// The real driver: a 32BGRA `AVCaptureVideoDataOutput` that drops late frames, the preset the source
/// asks for (falling back to VGA, medium, low), and the device's minimum frame duration.
final class AVCameraSessionDriver: CameraSessionDriving, @unchecked Sendable {
    let session = AVCaptureSession()
    var onEvent: ((CameraDriverEvent) -> Void)? {
        get { lock.withLock { eventHandler } }
        set { lock.withLock { eventHandler = newValue } }
    }

    private let output = AVCaptureVideoDataOutput()
    private let preset: AVCaptureSession.Preset
    private let lock = NSLock()
    private var eventHandler: ((CameraDriverEvent) -> Void)?
    private var device: AVCaptureDevice?
    private var input: AVCaptureDeviceInput?
    private var outputAdded = false
    /// Stops this driver asked for and whose `didStopRunning` has not arrived yet. A counter, not a flag:
    /// the notification can come after the stop returned, and a flag reset by then let an unplug or a
    /// revoked grant read as an interruption.
    private var stopsAsked = 0
    private var observers: [NSObjectProtocol] = []

    init(preset: AVCaptureSession.Preset) {
        self.preset = preset
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
        let center = NotificationCenter.default
        observers.append(center.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] note in
            let error = note.userInfo?[AVCaptureSessionErrorKey] as? NSError
            self?.onEvent?(.runtimeError(error?.localizedDescription ?? "The camera stopped with an error."))
        })
        observers.append(center.addObserver(forName: AVCaptureSession.didStopRunningNotification, object: session, queue: nil) { [weak self] _ in
            guard let self else { return }
            let asked = lock.withLock { () -> Bool in
                guard self.stopsAsked > 0 else { return false }
                self.stopsAsked -= 1
                return true
            }
            if !asked { onEvent?(.stoppedUnexpectedly) }
        })
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    var isRunning: Bool { session.isRunning }
    var activeDeviceID: String? { lock.withLock { device?.uniqueID } }
    var isAdjustingExposure: Bool { lock.withLock { device }?.isAdjustingExposure ?? false }

    func attach(delegate: AVCaptureVideoDataOutputSampleBufferDelegate, queue: DispatchQueue) {
        output.setSampleBufferDelegate(delegate, queue: queue)
    }

    func prepare(selection: CameraSelection) -> CameraSourceState? {
        guard input == nil else { return nil }
        guard let device = selection.resolve() else { return .noDevice }
        do {
            let newInput = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            if session.canAddInput(newInput) { session.addInput(newInput) }
            if !outputAdded, session.canAddOutput(output) {
                session.addOutput(output)
                outputAdded = true
            }
            for candidate in [preset, .vga640x480, .medium, .low] where session.canSetSessionPreset(candidate) {
                session.sessionPreset = candidate
                break
            }
            session.commitConfiguration()
            input = newInput
            lock.withLock { self.device = device }
            return nil
        } catch {
            GenesisKit.log("camera: cannot open \(device.localizedName): \(error.localizedDescription)")
            return .failed(error.localizedDescription)
        }
    }

    func start() -> Bool {
        if !session.isRunning { session.startRunning() }
        return session.isRunning
    }

    func stop() {
        guard session.isRunning else { return }
        lock.withLock { stopsAsked += 1 }
        session.stopRunning()
    }

    func removeInput() {
        guard let input else { return }
        stop()
        session.beginConfiguration()
        session.removeInput(input)
        session.commitConfiguration()
        self.input = nil
        lock.withLock { device = nil }
    }

    /// The slowest rate the active format allows at or above `fps`; values outside every supported range
    /// are never set (AVFoundation raises an exception for them).
    func setFrameRate(_ fps: Double) {
        guard let device = lock.withLock({ device }) else { return }
        let ranges = device.activeFormat.videoSupportedFrameRateRanges
        guard let duration = CameraFrameSource.frameDuration(for: fps, ranges: ranges.map { ($0.minFrameRate, $0.maxFrameRate) })
        else { return }
        let time = CMTime(seconds: duration, preferredTimescale: 600)
        guard ranges.contains(where: { CMTimeCompare(time, $0.minFrameDuration) >= 0 && CMTimeCompare(time, $0.maxFrameDuration) <= 0 })
        else { return }
        configure(device) { $0.activeVideoMinFrameDuration = time }
    }

    func resetFrameRate() {
        guard let device = lock.withLock({ device }) else { return }
        configure(device) { $0.activeVideoMinFrameDuration = .invalid }
    }

    private func configure(_ device: AVCaptureDevice, _ change: (AVCaptureDevice) -> Void) {
        do {
            try device.lockForConfiguration()
            change(device)
            device.unlockForConfiguration()
        } catch {
            GenesisKit.log("camera: frame rate not changed: \(error.localizedDescription)")
        }
    }
}
