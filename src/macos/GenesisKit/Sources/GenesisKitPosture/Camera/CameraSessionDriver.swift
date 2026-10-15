import AVFoundation
import CoreVideo
import Foundation
import GenesisKit

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

    /// `canAdd` false is a failure. The session does not hold the input, so storing it and returning
    /// success used to report a device the session had refused.
    static func refusedInput(canAdd: Bool, deviceName: String) -> CameraSourceState? {
        guard canAdd else {
            return .failed("\(deviceName) cannot be used by this session.")
        }
        return nil
    }

    func prepare(selection: CameraSelection) -> CameraSourceState? {
        guard input == nil else { return nil }
        guard let device = selection.resolve() else { return .noDevice }
        do {
            let newInput = try AVCaptureDeviceInput(device: device)
            session.beginConfiguration()
            if let refused = Self.refusedInput(canAdd: session.canAddInput(newInput), deviceName: device.localizedName) {
                session.commitConfiguration()
                return refused
            }
            session.addInput(newInput)
            if !outputAdded, session.canAddOutput(output) {
                session.addOutput(output)
                outputAdded = true
            }
            for candidate in [preset, .vga640x480, .medium, .low] where session.canSetSessionPreset(candidate) {
                session.sessionPreset = candidate
                break
            }
            session.commitConfiguration()
            // A camera without the VGA preset (the Studio Display's) delivers 1920×1080: every Vision request then
            // ran on 6.75 times the pixels, 22% of a core at Balanced (2026-10-14). The output scales down instead.
            let full = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
            var settings: [String: Any] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA]
            if let size = Self.analysisSize(width: Int(full.width), height: Int(full.height)) {
                settings[kCVPixelBufferWidthKey as String] = size.width
                settings[kCVPixelBufferHeightKey as String] = size.height
            }
            output.videoSettings = settings
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

    /// The longest side the analyzed frames get.
    static let analysisMaxSide = 640

    /// The frame size to scale a `width`×`height` camera format to, keeping its aspect ratio, even sides; nil when
    /// it is already small enough (or unknown). Pure, for tests.
    static func analysisSize(width: Int, height: Int, maxSide: Int = analysisMaxSide) -> (width: Int, height: Int)? {
        let longest = max(width, height)
        guard width > 0, height > 0, longest > maxSide else { return nil }
        let scale = Double(maxSide) / Double(longest)
        let even = { (value: Int) -> Int in max(2, Int((Double(value) * scale).rounded()) & ~1) }
        return (even(width), even(height))
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
