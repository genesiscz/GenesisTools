import AVFoundation
import CoreVideo
import XCTest
@testable import GenesisKit

/// A camera driver with no camera: it records what the source asks for.
final class FakeCameraDriver: CameraSessionDriving, @unchecked Sendable {
    private let lock = NSLock()
    private var running = false
    private var starts = 0
    private var stops = 0
    let session = AVCaptureSession()
    var onEvent: ((CameraDriverEvent) -> Void)?

    var isRunning: Bool { lock.withLock { running } }
    var startCount: Int { lock.withLock { starts } }
    var activeDeviceID: String? { "fake-camera" }
    var isAdjustingExposure: Bool { false }

    func attach(delegate: AVCaptureVideoDataOutputSampleBufferDelegate, queue: DispatchQueue) {}
    func prepare(selection: CameraSelection) -> CameraSourceState? { nil }
    func start() -> Bool {
        lock.withLock {
            starts += 1
            running = true
        }
        return true
    }
    func stop() { lock.withLock { running = false } }
    func removeInput() { stop() }
    func setFrameRate(_ fps: Double) {}
    func resetFrameRate() {}
}

final class CameraSourceTests: XCTestCase {
    private func pixelBuffer() throws -> CVPixelBuffer {
        var buffer: CVPixelBuffer?
        CVPixelBufferCreate(nil, 64, 48, kCVPixelFormatType_32BGRA, nil, &buffer)
        let made = try XCTUnwrap(buffer)
        CVPixelBufferLockBaseAddress(made, [])
        memset(CVPixelBufferGetBaseAddress(made), 0x80, CVPixelBufferGetDataSize(made))
        CVPixelBufferUnlockBaseAddress(made, [])
        return made
    }

    /// A source on a fake driver whose warm-up settles on the first frame.
    private func makeSource(_ driver: FakeCameraDriver, authorization: CameraAuthorizationStatus = .authorized) -> CameraFrameSource {
        CameraFrameSource(selection: .systemDefault, deliveryQueue: nil,
                          warmup: CameraWarmup(minimumWait: 0, minimumFrames: 0, maximumWait: 0),
                          authorization: { authorization }, driver: driver)
    }

    final class Frames: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func add() { lock.withLock { count += 1 } }
    }

    /// C1: a slouch seen on the last frame of a Battery-saver burst switches the camera to continuous.
    /// The burst's end, queued after that switch, must not reset the new mode: frames keep coming.
    func testASwitchToContinuousOnTheLastBurstFrameKeepsFramesFlowing() throws {
        let driver = FakeCameraDriver()
        let source = makeSource(driver)
        let frames = Frames()
        source.onFrame = { frame in
            frames.add()
            // The monitor's reaction to a bad reading on the burst's last frame.
            if frame.isBurst { source.setMode(.continuous(fps: 10)) }
        }
        source.setMode(.interval(every: 30, frames: 1))
        source.syncOnSessionQueue()
        XCTAssertTrue(driver.isRunning)
        let buffer = try pixelBuffer()
        source.handleFrame(buffer, at: 100)
        XCTAssertEqual(frames.value, 1)
        // Let the queued mode change and the queued burst end both run.
        source.syncOnSessionQueue()
        source.syncOnSessionQueue()
        XCTAssertEqual(source.mode, .continuous(fps: 10))
        XCTAssertTrue(driver.isRunning, "the light stays on for the confirmation")
        for step in 1...5 { source.handleFrame(buffer, at: 100 + Double(step) * 0.1) }
        XCTAssertEqual(frames.value, 6, "every continuous frame at 10 fps is delivered, none dropped")
    }

    /// M14: a camera that starts but never delivers is restarted three times, then the source gives up
    /// with the light off instead of restarting every 10 s forever.
    func testTheWatchdogStopsAfterThreeRestartsWithoutAFrame() {
        let driver = FakeCameraDriver()
        let source = makeSource(driver)
        source.setMode(.continuous(fps: 2))
        source.syncOnSessionQueue()
        XCTAssertEqual(driver.startCount, 1)
        var now = ProcessInfo.processInfo.systemUptime
        for _ in 0..<6 {
            now += 60
            source.syncOnSessionQueue { source.checkWatchdog(now: now) }
        }
        XCTAssertEqual(driver.startCount, 1 + CameraFrameSource.maximumRestarts)
        XCTAssertFalse(driver.isRunning)
        guard case .failed = source.state else { return XCTFail("state \(source.state)") }
        // A grant or a new device later: refresh() clears the cap and starts again.
        source.refresh()
        source.syncOnSessionQueue()
        XCTAssertTrue(driver.isRunning)
    }

    func testADeliveredFrameResetsTheRestartCount() throws {
        let driver = FakeCameraDriver()
        let source = makeSource(driver)
        source.setMode(.continuous(fps: 2))
        source.syncOnSessionQueue()
        let buffer = try pixelBuffer()
        var now = ProcessInfo.processInfo.systemUptime
        for _ in 0..<10 {
            now += 60
            source.syncOnSessionQueue { source.checkWatchdog(now: now) }
            source.handleFrame(buffer, at: now + 1)
        }
        XCTAssertTrue(driver.isRunning, "a camera that recovers after each restart is never given up")
    }

    func testAZeroRateIsOff() {
        var throttle = FrameThrottle(fps: 0)
        XCTAssertFalse(throttle.admit(0))
        XCTAssertFalse(throttle.admit(10))
        let driver = FakeCameraDriver()
        let source = makeSource(driver)
        source.setMode(.continuous(fps: 0))
        source.syncOnSessionQueue()
        XCTAssertFalse(driver.isRunning)
        XCTAssertEqual(source.state, .stopped)
    }

    /// The source never touches a device without the grant: with a denied answer it reports
    /// `.unauthorized` and leaves the session stopped. (The real grant is never read here, since a
    /// granted terminal would let a test open the camera.)
    func testTheSourceRefusesToStartWithoutTheGrant() {
        let driver = FakeCameraDriver()
        let source = makeSource(driver, authorization: .denied)
        let reported = expectation(description: "state")
        source.onStateChange = { state in
            if state == .unauthorized { reported.fulfill() }
        }
        source.setMode(.continuous(fps: 2))
        wait(for: [reported], timeout: 5)
        XCTAssertEqual(source.state, .unauthorized)
        XCTAssertEqual(source.mode, .continuous(fps: 2))
        XCTAssertEqual(driver.startCount, 0)
        source.stop()
    }
}
