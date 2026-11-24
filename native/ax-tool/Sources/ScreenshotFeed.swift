import CoreMedia
import Foundation
import ScreenCaptureKit
import SnapshotSupport

/// What a recording asks of its frame source. These are the calls ScreenCaptureKit's stream already has, so
/// `SCStream` is a feed as it is, and `ScreenshotFeed` is the other one.
protocol CaptureFeed: AnyObject {
    func startCapture() async throws
    func stopCapture() async throws
    func updateConfiguration(_ streamConfig: SCStreamConfiguration) async throws
    func updateContentFilter(_ contentFilter: SCContentFilter) async throws
    /// The pace of a feed that times its screenshots (`ScreenshotPace`); nil for the stream.
    var pace: ScreenshotPaceReport? { get }
}

extension CaptureFeed {
    var pace: ScreenshotPaceReport? { nil }
}

extension SCStream: CaptureFeed {}

private func screenshotError(_ message: String) -> NSError {
    NSError(domain: "ax-tool.screenshot-feed", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

/// Frames by screenshot, with no open stream: for a display where a stream is costly because a window is marked
/// never-capture (`NeverCaptureRule`). A screenshot makes WindowServer draw the display once, so the cost follows the
/// frame rate (`maxFps`) and not the screen's own updates. Measured 2026-11-21 with such a window on every display:
/// one screenshot a second on each of three displays left WindowServer's response where it was with no capture.
///
/// It feeds `NativeRecorder.consume` on the recorder's frame queue, like the stream: the keep policy, the rate
/// policy, the heartbeat, the events and the PNG files stay as they are. A screenshot's sample buffer carries a host
/// clock time (checked 2026-11-22: it is the moment the picture was made, 130 to 190 ms after the call).
///
/// It times each screenshot and stretches its interval while they are slow (`ScreenshotPace`), so it never keeps the
/// capture service busy for more than a tenth of the time; `onPace` hears the pace when it changes.
@available(macOS 14.0, *)
final class ScreenshotFeed: CaptureFeed {
    /// A screenshot takes 130 to 280 ms to arrive, and each one is a full draw of the display.
    static let maxFps = 2.0
    /// Failed screenshots in a row before the recording ends as a stream that stopped does.
    static let failuresToEnd = 5
    /// A screenshot that has not come back after this long counts as one that failed.
    static let stallSeconds = 10.0

    private let recorder: NativeRecorder
    private let queue = DispatchQueue(label: "ax-tool.record.screenshots")
    private var filter: SCContentFilter
    private var shot: SCStreamConfiguration
    /// The interval the frame rate asks for.
    private var interval: TimeInterval
    /// The interval the timer runs at: `interval`, stretched while screenshots are slow.
    private var paced: TimeInterval
    /// How long the newest screenshot took, from the call to its picture.
    private var took: TimeInterval?
    /// What `onPace` heard last; nil until the first screenshot was timed.
    private var reported: ScreenshotPaceReport?
    /// Hears the pace after the first screenshot and when its whole seconds change, on `queue`.
    private let onPace: (ScreenshotPaceReport) -> Void
    private var timer: DispatchSourceTimer?
    private var takingSince: Date?
    /// Which screenshot is on its way, so one that a tick gave up on cannot end a later one's turn.
    private var shotNumber = 0
    private var failures = 0
    /// Counts filter and size changes: a screenshot asked for before one and arriving after it shows the old display.
    private var generation = 0

    init(filter: SCContentFilter, configuration: SCStreamConfiguration, recorder: NativeRecorder,
         onPace: @escaping (ScreenshotPaceReport) -> Void) {
        self.filter = filter
        self.recorder = recorder
        self.onPace = onPace
        self.shot = Self.shotConfiguration(configuration)
        self.interval = Self.interval(configuration)
        self.paced = interval
    }

    var pace: ScreenshotPaceReport? {
        queue.sync { took.map { ScreenshotPace.report(interval: paced, asked: interval, took: $0) } }
    }

    /// The parts of the stream's configuration a screenshot takes: its size, its pixels and what it shows.
    private static func shotConfiguration(_ stream: SCStreamConfiguration) -> SCStreamConfiguration {
        let shot = SCStreamConfiguration()
        shot.width = stream.width
        shot.height = stream.height
        shot.pixelFormat = stream.pixelFormat
        shot.showsCursor = stream.showsCursor
        shot.backgroundColor = stream.backgroundColor
        shot.ignoreShadowsSingleWindow = stream.ignoreShadowsSingleWindow
        shot.preservesAspectRatio = stream.preservesAspectRatio
        return shot
    }

    /// The stream's frame interval, but never under `1 / maxFps`.
    private static func interval(_ stream: SCStreamConfiguration) -> TimeInterval {
        let asked = CMTimeGetSeconds(stream.minimumFrameInterval)
        return max(asked.isFinite ? asked : 0, 1 / maxFps)
    }

    /// Takes the first screenshot before it answers, so a start that cannot capture (no grant, a display that left)
    /// fails as a stream's start does.
    func startCapture() async throws {
        let first = queue.sync { (filter, shot, generation) }
        let started = Date()
        try await take(filter: first.0, shot: first.1, generation: first.2)
        queue.sync {
            took = Date().timeIntervalSince(started)
            repace(sinceLast: nil)
            schedule()
        }
    }

    func stopCapture() async throws {
        queue.sync {
            timer?.cancel()
            timer = nil
        }
    }

    func updateConfiguration(_ streamConfig: SCStreamConfiguration) async throws {
        queue.sync {
            if streamConfig.width != shot.width || streamConfig.height != shot.height {
                generation += 1
            }
            shot = Self.shotConfiguration(streamConfig)
            let next = Self.interval(streamConfig)
            guard next != interval else { return }
            interval = next
            repace(sinceLast: nil)
        }
    }

    func updateContentFilter(_ contentFilter: SCContentFilter) async throws {
        queue.sync {
            filter = contentFilter
            generation += 1
        }
    }

    /// On `queue`. The timer runs at `paced`; its first tick comes after `delay` (default: one interval from now).
    private func schedule(after delay: TimeInterval? = nil) {
        timer?.cancel()
        let next = DispatchSource.makeTimerSource(queue: queue)
        next.schedule(deadline: .now() + (delay ?? paced), repeating: paced, leeway: .milliseconds(20))
        next.setEventHandler { [weak self] in self?.tick() }
        next.resume()
        timer = next
    }

    /// On `queue`. One screenshot at a time: a tick that finds one still on its way waits for the next tick.
    private func tick() {
        if let takingSince {
            let waited = Date().timeIntervalSince(takingSince)
            guard waited > Self.stallSeconds else { return }
            // Give up on it: its picture is dropped if it ever comes, because the generation moves on.
            self.takingSince = nil
            generation += 1
            // The service is that slow: the pace stretches as after a screenshot of that length.
            took = waited
            repace(sinceLast: waited)
            failed(screenshotError("a screenshot did not arrive within \(Int(Self.stallSeconds)) s"))
            return
        }
        takingSince = Date()
        shotNumber += 1
        let number = shotNumber
        let filter = self.filter
        let shot = self.shot
        let generation = self.generation
        Task { [self] in
            var failure: Error?
            do {
                try await take(filter: filter, shot: shot, generation: generation)
            } catch {
                failure = error
            }
            queue.async { [self] in
                // A later tick gave up on this screenshot and counted it as failed.
                guard number == shotNumber, let since = takingSince else { return }
                takingSince = nil
                if let failure {
                    failed(failure)
                } else {
                    failures = 0
                    took = Date().timeIntervalSince(since)
                    repace(sinceLast: took)
                }
            }
        }
    }

    /// On `queue`. Sets the timer to the asked interval stretched by the newest screenshot's time, so the next
    /// screenshot starts one paced interval after the newest one started (`sinceLast` ago; nil: from now).
    private func repace(sinceLast: TimeInterval?) {
        let next = ScreenshotPace.interval(asked: interval, took: took)
        if let took {
            let report = ScreenshotPace.report(interval: next, asked: interval, took: took)
            if reported == nil || reported?.everySec != report.everySec {
                reported = report
                onPace(report)
            }
        }
        guard next != paced else { return }
        paced = next
        if timer != nil {
            schedule(after: sinceLast.map { max(0, next - $0) })
        }
    }

    /// On `queue`.
    private func failed(_ error: Error) {
        failures += 1
        guard failures >= Self.failuresToEnd else { return }
        timer?.cancel()
        timer = nil
        recorder.feedFailed(error)
    }

    private func take(filter: SCContentFilter, shot: SCStreamConfiguration, generation: Int) async throws {
        let sample = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: shot)
        guard let buffer = CMSampleBufferGetImageBuffer(sample) else {
            throw screenshotError("a screenshot came without a picture")
        }
        guard queue.sync(execute: { self.generation }) == generation else { return }
        let now = CMClockGetTime(CMClockGetHostTimeClock())
        let stamp = CMSampleBufferGetPresentationTimeStamp(sample)
        let onHostClock = stamp.isNumeric && abs(CMTimeGetSeconds(CMTimeSubtract(now, stamp))) < 5
        let time = onHostClock ? stamp : now
        recorder.frameQueue.async { [recorder] in
            recorder.consume(buffer, timestamp: time)
        }
    }
}
