import AppKit
import AVFoundation
import CoreImage
import Foundation
import ScreenCaptureKit
import SnapshotSupport

// MARK: - screens

/// Displays in the order and coordinate convention `NSScreen` uses: index 0 is the primary,
/// `position` is Cocoa (bottom-left origin), `resolution` is points. The runner already converts
/// that convention to CoreGraphics. 🛑 Peekaboo's `screen list` does NOT match: it reports CG
/// already, so the two sources are parsed with different conventions (ScreenOriginConvention in
/// native-record.ts). `screensInfo()` in main.swift emits a pre-converted `originCG` instead;
/// this command stays raw so the flip lives in exactly one place.
func cmdScreens() {
    let rows: [[String: Any]] = NSScreen.screens.enumerated().map { index, screen in
        let displayID = (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        return [
            "index": index, "name": screen.localizedName, "isPrimary": index == 0, "displayID": displayID,
            "scaleFactor": screen.backingScaleFactor,
            "position": ["x": screen.frame.origin.x, "y": screen.frame.origin.y],
            "resolution": ["width": screen.frame.width, "height": screen.frame.height],
        ]
    }
    jsonOutput(["ok": true, "screens": rows])
}

// MARK: - record

struct RecordOptions {
    let selection: CaptureSelectionOptions
    let mode: String
    let screenIndex: Int?
    let app: String?
    let windowTitle: String?
    let windowIndex: Int?
    let windowID: CGWindowID?
    let region: CGRect?
    let duration: Double
    let activeFps: Double
    let idleFps: Double
    let threshold: Double
    let videoOut: String?
    let outDir: String
    let maxFrames: Int
    /// `--display-id`: the CGDirectDisplayID to record in screen mode; wins over `--screen-index`.
    let displayID: CGDirectDisplayID?
    /// `--follow-focus`: record the display holding the frontmost app's focused window, switching live.
    let followFocus: Bool
    /// `--max-long-side`: the longer side of a kept frame in pixels, at most.
    let maxLongSide: Int?
    /// `--quiet-ms`: calm time before the idle rate; nil keeps the eight-still-frames rule.
    let quietMs: Int?
    /// `--heartbeat-sec`: keep a frame at least this often while nothing changes; 0 is off.
    let heartbeatSec: Double
    /// `--max-mb`: stop keeping frames after this many megabytes were written.
    let maxMb: Double?
    /// `--control-stdin`: JSON-line commands on stdin, JSON-line events on stderr.
    let controlStdin: Bool
    /// `--audio system,mic`: the audio sources, each its own track.
    let audioSources: [CaptureAudioSource]
    /// `--mic-device <uid>` from `ax-tool audio-devices`; nil is the default input.
    let micDevice: String?
    /// `--audio-sidecar`: also write each source as `audio-<source>.m4a` next to the frames.
    let audioSidecar: Bool
    /// Warnings raised before the recorder existed; they open its warning list.
    let startWarnings: [String]
}

private func recordOptions(startWarnings: [String]) -> RecordOptions {
    let mode = argValue("--mode") ?? "window"
    guard ["screen", "window", "region", "isolated"].contains(mode) else {
        errorExit("--mode must be screen, window, region or isolated", code: "invalid-argument")
    }
    func number(_ flag: String, default fallback: Double, min lower: Double, max upper: Double) -> Double {
        guard let raw = argValue(flag) else { return fallback }
        guard let value = Double(raw), value.isFinite, value >= lower, value <= upper else {
            errorExit("\(flag) must be a number between \(lower) and \(upper)", code: "invalid-argument")
        }
        return value
    }
    func optionalNumber(_ flag: String, min lower: Double, max upper: Double) -> Double? {
        argValue(flag) == nil ? nil : number(flag, default: 0, min: lower, max: upper)
    }
    var region: CGRect?
    if let raw = argValue("--region") {
        let parts = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4, parts[2] > 0, parts[3] > 0 else {
            errorExit("--region must be x,y,w,h in global screen points", code: "invalid-argument")
        }
        region = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }
    var windowID: CGWindowID?
    if let raw = argValue("--window-id") {
        guard let id = UInt32(raw), id > 0 else { errorExit("--window-id must be a positive integer", code: "invalid-argument") }
        windowID = id
    }
    var displayID: CGDirectDisplayID?
    if let raw = argValue("--display-id") {
        guard let id = UInt32(raw), id > 0 else { errorExit("--display-id must be a positive CGDirectDisplayID; run `ax-tool screens`", code: "invalid-argument") }
        displayID = id
    }
    let followFocus = CommandLine.arguments.contains("--follow-focus")
    if (displayID != nil || followFocus) && mode != "screen" {
        errorExit("--display-id and --follow-focus require --mode screen", code: "invalid-argument")
    }
    if displayID != nil && followFocus {
        errorExit("--display-id and --follow-focus name different targets; pass one", code: "invalid-argument")
    }
    if followFocus {
        if #unavailable(macOS 14.0) {
            errorExit("--follow-focus needs macOS 14 or newer (SCStream.updateContentFilter)", code: "invalid-argument")
        }
    }
    let controlStdin = CommandLine.arguments.contains("--control-stdin")
    if controlStdin && mode == "isolated" {
        errorExit("--control-stdin applies to screen, window and region mode", code: "invalid-argument")
    }
    var audioSources: [CaptureAudioSource] = []
    if let raw = argValue("--audio") {
        switch parseAudioSources(raw) {
        case .success(let sources):
            audioSources = sources
        case .failure(let error):
            errorExit(error.message, code: "invalid-argument")
        }
    }
    let micDevice = argValue("--mic-device")
    let audioSidecar = CommandLine.arguments.contains("--audio-sidecar")
    if !audioSources.isEmpty {
        if mode == "isolated" {
            errorExit("--audio applies to screen, window and region mode", code: "invalid-argument")
        }
        if argValue("--video-out") == nil && !audioSidecar {
            errorExit("--audio needs --video-out (tracks in the movie) or --audio-sidecar (.m4a files)", code: "invalid-argument")
        }
    }
    if (micDevice != nil || audioSidecar) && audioSources.isEmpty {
        errorExit("--mic-device and --audio-sidecar need --audio", code: "invalid-argument")
    }
    if micDevice != nil && !audioSources.contains(.mic) {
        errorExit("--mic-device needs --audio mic", code: "invalid-argument")
    }
    if audioSources.contains(.mic) {
        if #unavailable(macOS 15.0) {
            errorExit("microphone capture needs macOS 15 or newer (SCStreamConfiguration.captureMicrophone)", code: "unsupported")
        }
    }
    if let micDevice, !audioDevices().contains(where: { $0.uid == micDevice && $0.inputChannels > 0 }) {
        errorExit("no input device \(micDevice); run `ax-tool audio-devices`", code: "device-missing")
    }
    let maxLongSide = optionalNumber("--max-long-side", min: 16, max: 16384).map { Int($0) }
    if maxLongSide != nil && mode == "isolated" {
        errorExit("--max-long-side applies to screen, window and region mode; isolated mode takes --output-size", code: "invalid-argument")
    }
    let outDir = argValue("--out") ?? FileManager.default.temporaryDirectory
        .appendingPathComponent("control-record-\(UUID().uuidString)").path
    // Clamp here rather than inside the rate policy, so `metadata.json` and `--help` report the
    // rate the recorder actually used. An idle rate above the active one would ask the stream
    // for MORE frames while nothing moves, which is the opposite of what the flag is for.
    // A movie keeps the active rate by default; an explicit idle rate remains an override.
    // The first frames of motion otherwise arrived at 2 fps until the stream switched back. PNGs alone keep 8 fps.
    let videoOut = argValue("--video-out")
    let activeFps = number("--active-fps", default: videoOut == nil ? 8 : 60, min: 0.5, max: 120)
    let idleFps = argValue("--idle-fps") == nil && videoOut != nil
        ? activeFps : min(number("--idle-fps", default: 2, min: 0.1, max: 5), activeFps)
    return RecordOptions(
        selection: captureSelectionOptions(mode: mode),
        mode: mode,
        screenIndex: argValue("--screen-index").flatMap { Int($0) },
        app: argValue("--app"),
        windowTitle: argValue("--window-title"),
        windowIndex: argValue("--window-index").flatMap { Int($0) },
        windowID: windowID,
        region: region,
        duration: number("--duration", default: 3, min: 0.1, max: 180),
        activeFps: activeFps,
        idleFps: idleFps,
        threshold: number("--threshold", default: 2.5, min: 0, max: 100),
        videoOut: videoOut,
        outDir: outDir,
        maxFrames: Int(number("--max-frames", default: 800, min: 1, max: 5000)),
        displayID: displayID,
        followFocus: followFocus,
        maxLongSide: maxLongSide,
        quietMs: optionalNumber("--quiet-ms", min: 0, max: 3_600_000).map { Int($0) },
        heartbeatSec: number("--heartbeat-sec", default: 0, min: 0, max: 3600),
        maxMb: optionalNumber("--max-mb", min: 0.01, max: 1_000_000),
        controlStdin: controlStdin,
        audioSources: audioSources,
        micDevice: micDevice,
        audioSidecar: audioSidecar,
        startWarnings: startWarnings
    )
}

private var privateRecorderCopy: URL?

private var privateRecorderRoot: URL {
    FileManager.default.temporaryDirectory.appendingPathComponent("ax-tool-recorders", isDirectory: true)
}

/// Re-executes this recorder from its own clone of the binary, before any ScreenCaptureKit call:
/// replayd ends the streams of every process started from one path when any of them exits
/// (`RecorderExecutable` has the measurements). In the clone it returns no warning and removes the
/// clone at exit. When no clone can be made the recording runs from the shared path, and the
/// returned warning says that another recorder stopping can now end it.
private func runFromPrivateRecorderCopy() -> [String] {
    if let copy = ProcessInfo.processInfo.environment[RecorderExecutable.environmentKey] {
        unsetenv(RecorderExecutable.environmentKey)
        privateRecorderCopy = URL(fileURLWithPath: copy)
        atexit {
            guard let copy = privateRecorderCopy else { return }
            RecorderExecutable.removeCopy(copy, root: privateRecorderRoot, pid: getpid())
        }
        return []
    }
    let exposed = "another recording that stops can end this one (ScreenCaptureKit error -3805)"
    guard let source = Bundle.main.executableURL?.resolvingSymlinksInPath() else {
        return ["the recorder runs from the shared ax-tool path, because its executable path is unknown; \(exposed)"]
    }
    let copy: URL
    do {
        copy = try RecorderExecutable.makePrivateCopy(of: source, root: privateRecorderRoot, pid: getpid())
    } catch {
        return ["the recorder runs from the shared ax-tool path, because no private copy could be made (\(error.localizedDescription)); \(exposed)"]
    }
    setenv(RecorderExecutable.environmentKey, copy.path, 1)
    var argv = CommandLine.arguments.map { strdup($0) } + [nil]
    execv(copy.path, &argv)
    let reason = String(cString: strerror(errno))
    unsetenv(RecorderExecutable.environmentKey)
    RecorderExecutable.removeCopy(copy, root: privateRecorderRoot, pid: getpid())
    return ["the recorder runs from the shared ax-tool path, because it could not start from its private copy (\(reason)); \(exposed)"]
}

private struct DisplayGeometry {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let scale: CGFloat
}

/// `scale` is backing pixels per point. `CGDisplayPixelsWide` answers in points for a scaled (HiDPI) mode, so a 2x
/// display recorded at 1x; the display mode's `pixelWidth` is the backing size.
private func displayGeometry(_ id: CGDirectDisplayID) -> DisplayGeometry {
    let bounds = CGDisplayBounds(id)
    let pixels = CGDisplayCopyDisplayMode(id).map { CGFloat($0.pixelWidth) } ?? CGFloat(CGDisplayPixelsWide(id))
    return DisplayGeometry(id: id, bounds: bounds, scale: displayScale(pixelWidth: pixels, pointWidth: bounds.width))
}

private func activeDisplays() -> [DisplayGeometry] {
    var count: UInt32 = 0
    CGGetActiveDisplayList(0, nil, &count)
    var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
    CGGetActiveDisplayList(count, &ids, &count)
    return ids.prefix(Int(count)).map(displayGeometry)
}

private func displayContaining(_ point: CGPoint) -> DisplayGeometry? {
    activeDisplays().first { $0.bounds.contains(point) } ?? activeDisplays().first
}

private func displayForScreenIndex(_ index: Int) -> DisplayGeometry {
    let screens = NSScreen.screens
    guard screens.indices.contains(index),
          let id = (screens[index].deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else {
        errorExit("--screen-index outside the current display list; run `ax-tool screens`", code: "display-missing")
    }
    return displayGeometry(id)
}

private func displayForID(_ id: CGDirectDisplayID) -> DisplayGeometry {
    guard activeDisplays().contains(where: { $0.id == id }) else {
        let known = activeDisplays().map { String($0.id) }.joined(separator: ", ")
        errorExit("display \(id) is not connected (connected: \(known)); run `ax-tool screens`", code: "display-missing")
    }
    return displayGeometry(id)
}

private func displayIsActive(_ id: CGDirectDisplayID) -> Bool {
    activeDisplays().contains { $0.id == id }
}

/// The display `--follow-focus` should record now: the frontmost app's frontmost normal window (CGWindowList is
/// front to back, so its first layer-0 window of that pid), else the display under the mouse. Reads no AX state.
private func currentFocusDisplay() -> CGDirectDisplayID? {
    let displays = activeDisplays().map { DisplayFrame(id: $0.id, bounds: $0.bounds) }
    var window: CGRect?
    if let pid = NSWorkspace.shared.frontmostApplication?.processIdentifier,
       let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]],
       let row = rows.first(where: { ($0[kCGWindowOwnerPID] as? Int32) == pid && ($0[kCGWindowLayer] as? Int) == 0 }),
       let raw = row[kCGWindowBounds] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw), bounds.height > 50 {
        window = bounds
    }
    return focusDisplay(window: window, mouse: CGEvent(source: nil)?.location, displays: displays)
}

/// The display reconfiguration callback is a C function pointer and captures nothing; it reaches the recording here.
private var displayReconfigurationHandler: ((CGDirectDisplayID, CGDisplayChangeSummaryFlags) -> Void)?

private let displayReconfigurationCallback: CGDisplayReconfigurationCallBack = { display, flags, _ in
    displayReconfigurationHandler?(display, flags)
}

/// The CG window the recorder should follow: an explicit id, else the app's on-screen windows
/// filtered by title, picked by index or by largest area. Phantom strips under 50 points tall
/// (menu bars, title strips) never qualify, the same rule `capture preflight` uses.
private func resolveRecordWindow(_ options: RecordOptions) -> (id: CGWindowID, bounds: CGRect) {
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] ?? []
    func bounds(_ info: [CFString: Any]) -> CGRect? {
        guard let raw = info[kCGWindowBounds] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: raw)
    }
    if let id = options.windowID {
        guard let info = list.first(where: { ($0[kCGWindowNumber] as? CGWindowID) == id }), let frame = bounds(info) else {
            errorExit("window \(id) is not on screen; inspect again")
        }
        return (id, frame)
    }
    guard let app = options.app else {
        errorExit("window mode needs --app or --window-id")
    }
    // resolveAppPid, not resolveApp: the pid is used for the kCGWindowOwnerPID filter below
    // and nowhere else, and this recorder never reads the AX tree. Going through resolveApp
    // meant `capture --mode window --app "Brave Browser"` permanently flipped Brave into
    // manual-accessibility mode as a side effect of a screen recording.
    let pid = resolveAppPid(app)
    var candidates = list.filter { info in
        guard (info[kCGWindowOwnerPID] as? Int32) == pid, (info[kCGWindowLayer] as? Int) == 0,
              let frame = bounds(info), frame.height > 50 else { return false }
        if let title = options.windowTitle {
            let name = (info[kCGWindowName] as? String) ?? ""
            return name.lowercased().contains(title.lowercased())
        }
        return true
    }
    if let index = options.windowIndex {
        guard candidates.indices.contains(index) else {
            errorExit("--window-index outside the app's \(candidates.count) on-screen window(s)")
        }
        candidates = [candidates[index]]
    }
    guard let picked = candidates.max(by: { (bounds($0)?.width ?? 0) * (bounds($0)?.height ?? 0) < (bounds($1)?.width ?? 0) * (bounds($1)?.height ?? 0) }),
          let id = picked[kCGWindowNumber] as? CGWindowID, let frame = bounds(picked) else {
        errorExit("no on-screen window for \(app)\(options.windowTitle.map { " matching \"\($0)\"" } ?? "")")
    }
    return (id, frame)
}

/// `--control-stdin` events: one JSON object per line on stderr, so a supervisor can stream them while the final
/// result stays on stdout. Silent without the flag.
enum CaptureEvents {
    static var enabled = false
    private static let lock = NSLock()

    static func emit(_ event: [String: Any]) {
        guard enabled, var data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
        data.append(0x0a)
        lock.lock()
        FileHandle.standardError.write(data)
        lock.unlock()
    }

    static func error(_ code: String, _ message: String) {
        emit(["event": "error", "code": code, "message": message])
    }
}

/// Metadata only. Holding a thumbnail per kept frame retained about 122 MiB at the default
/// 800-frame cap and 763 MiB at the 5000 allowed, for pictures already on disk; the contact
/// sheet reloads each PNG when it needs it and lets it go again.
struct KeptFrame {
    let index: Int
    let file: String
    let timestampMs: Int
    let changePercent: Double
    let reason: String
    let displayID: CGDirectDisplayID?
    let motionBoxes: [MotionBox]

    var motionBoxesJSON: [[Int]] { motionBoxes.map(\.json) }
}

/// One ScreenCaptureKit stream, the keep policy, PNG output and the optional MP4. Frames arrive
/// on a serial queue, so the policy and the counters need no locking.
@available(macOS 13.0, *)
final class NativeRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let options: RecordOptions
    private let queue = DispatchQueue(label: "ax-tool.record.frames")
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var policy: KeepPolicy
    private var rate: FrameRatePolicy
    /// Set once the stream exists, so the recorder can ask it for a different rate. The stream
    /// owns the recorder as its delegate and its output, hence weak.
    weak var stream: SCStream?
    var rateChanged: ((Double) -> Void)?
    private let configuration: SCStreamConfiguration
    private var firstTimestamp: CMTime?
    private var lastTimestamp: CMTime?
    private(set) var kept: [KeptFrame] = []
    /// PNG encoding runs here, off `queue` (`consume`). At most `maxPendingEncodes` frames wait, each a full-size
    /// image in memory; a changed frame past that is counted in `encoderBehind` and stays in the movie only.
    private let encodeQueue = DispatchQueue(label: "ax-tool.record.encode", qos: .utility)
    private static let maxPendingEncodes = 6
    private var pendingEncodes = 0
    private var reservedFrames = 0
    private var encoderBehind = 0
    private(set) var captured = 0
    private(set) var warnings: [String] = []
    private var writer: AVAssetWriter?
    /// The audio receiver, told when the movie session starts so its tracks begin at the same moment.
    var audio: NativeAudio?
    /// Movie tracks per audio source, added before the writer starts.
    private(set) var audioInputs: [CaptureAudioSource: AVAssetWriterInput] = [:]
    /// `set-fps` and `set-threshold` change these while recording.
    private var activeFps: Double
    private var idleFps: Double
    private var writerInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var videoAppendFailed = false
    private var rateChangeWarned = false
    private var byteCapWarned = false
    private var streamError: Error?
    private let heartbeat: HeartbeatPolicy
    private var heartbeatTimer: DispatchSourceTimer?
    /// The newest complete frame, held only while a heartbeat is on: a still screen delivers no new frames, so the
    /// heartbeat keeps this one. One retained buffer out of the stream's queue depth of five.
    private var latestBuffer: CVPixelBuffer?
    private var lastKeptMs: Int?
    /// The display the frames come from, `nil` for isolated captures. Changed on this queue by `displayChanged`.
    private var currentDisplayID: CGDirectDisplayID?
    private(set) var displaySwitches = 0
    private(set) var heartbeatFrames = 0
    /// `pause`: frames are counted but neither sampled, kept nor written to the movie.
    private var paused = false
    let stopped = DispatchSemaphore(value: 0)

    init(options: RecordOptions, configuration: SCStreamConfiguration, displayID: CGDirectDisplayID? = nil) {
        self.options = options
        self.configuration = configuration
        self.policy = KeepPolicy(thresholdPercent: options.threshold, maxFrames: options.maxFrames,
                                 maxBytes: maxBytes(megabytes: options.maxMb))
        self.rate = FrameRatePolicy(activeFps: options.activeFps, idleFps: options.idleFps, quietMs: options.quietMs)
        self.heartbeat = HeartbeatPolicy(seconds: options.heartbeatSec)
        self.activeFps = options.activeFps
        self.idleFps = options.idleFps
        self.currentDisplayID = displayID
        self.warnings = options.startWarnings
    }

    var bytesWritten: Int { queue.sync { policy.bytesWritten } }

    /// The display a running switch moves to and the frame size it delivers. The stream delivers new-size frames
    /// before the switch call returns, so the first frame of that size is already the new display.
    private var pendingDisplay: (id: CGDirectDisplayID, width: Int, height: Int)?

    /// The frames now come from another display: tag them with it, and keep the next one as its first frame.
    func displayChanged(to id: CGDirectDisplayID) {
        queue.async { [self] in
            applyDisplayChange(id)
        }
    }

    private func applyDisplayChange(_ id: CGDirectDisplayID) {
        pendingDisplay = nil
        guard id != currentDisplayID else { return }
        var event: [String: Any] = ["event": "display-switch", "to": id]
        if let currentDisplayID {
            event["from"] = currentDisplayID
        }
        currentDisplayID = id
        displaySwitches += 1
        policy.restart(reason: "display-switch")
        CaptureEvents.emit(event)
    }

    /// A new output size, set on the frame queue that also changes the frame rate. The caller hands the returned
    /// configuration to the stream.
    func setOutputSize(width: Int, height: Int, for display: CGDirectDisplayID) -> SCStreamConfiguration {
        queue.sync {
            if width != configuration.width || height != configuration.height {
                pendingDisplay = (display, width, height)
            }
            configuration.width = width
            configuration.height = height
            return configuration
        }
    }

    func cancelPendingDisplay() {
        queue.sync { pendingDisplay = nil }
    }

    /// A warning from outside the frame queue; a repeat of the same text is dropped.
    func warn(_ text: String) {
        queue.async { [self] in
            if !warnings.contains(text) {
                warnings.append(text)
            }
        }
    }

    func setPaused(_ value: Bool) {
        queue.async { [self] in
            if paused && !value {
                policy.restart(reason: "resume")
                latestBuffer = nil
            }
            paused = value
        }
    }

    /// The `status` answer, read on the frame queue.
    func status() -> [String: Any] {
        queue.sync {
            var row: [String: Any] = ["state": paused ? "paused" : "recording", "frames": kept.count,
                                      "capturedFrames": captured, "bytesWritten": policy.bytesWritten]
            if let currentDisplayID {
                row["displayId"] = currentDisplayID
            }
            if let lastTimestamp {
                row["elapsedMs"] = elapsedMs(lastTimestamp)
            }
            return row
        }
    }

    /// A stream restarted after its display went away starts without the old stream's error.
    func clearFailure() {
        queue.sync { streamError = nil }
    }

    func startHeartbeat() {
        guard heartbeat.enabled else { return }
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + .milliseconds(250), repeating: .milliseconds(250))
        timer.setEventHandler { [weak self] in self?.heartbeatTick() }
        timer.resume()
        heartbeatTimer = timer
    }

    func stopHeartbeat() {
        heartbeatTimer?.cancel()
        heartbeatTimer = nil
        queue.sync { latestBuffer = nil }
    }

    private func elapsedMs(_ timestamp: CMTime) -> Int {
        let elapsed = CMTimeSubtract(timestamp, firstTimestamp ?? timestamp)
        return Int((CMTimeGetSeconds(elapsed) * 1000).rounded())
    }

    private func heartbeatTick() {
        guard !paused, let buffer = latestBuffer, firstTimestamp != nil else { return }
        let nowMs = elapsedMs(CMClockGetTime(CMClockGetHostTimeClock()))
        guard heartbeat.due(nowMs: nowMs, lastKeptMs: lastKeptMs), let signature = signature(of: buffer) else { return }
        var candidate = policy
        guard let beat = candidate.heartbeat(signature) else { return }
        if keep(buffer, timestampMs: nowMs, decision: beat, candidate: candidate) {
            heartbeatFrames += 1
        }
    }

    private func signature(of pixelBuffer: CVPixelBuffer) -> FrameSignature? {
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return nil }
        return FrameSignature(bgra: UnsafeRawPointer(base), width: CVPixelBufferGetWidth(pixelBuffer),
                              height: CVPixelBufferGetHeight(pixelBuffer),
                              bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), stride: 4)
    }

    /// Asks the live stream for a new delivery rate. Frames arrive on `queue`, so this is called
    /// from there; `updateConfiguration` is async, and a refusal simply leaves the current rate
    /// in place, which is the behaviour a recorder without rate switching already had.
    private func applyRate(_ fps: Double) {
        let interval = frameInterval(fps: fps)
        configuration.minimumFrameInterval = CMTime(value: interval.value, timescale: interval.timescale)
        rateChanged?(fps)
        guard let stream else { return }
        let configuration = self.configuration
        Task { [weak stream, weak self] in
            do {
                try await stream?.updateConfiguration(configuration)
            } catch {
                self?.noteRateChangeRefused(error)
            }
        }
    }

    private func noteRateChangeRefused(_ error: Error) {
        queue.async { [self] in
            guard !rateChangeWarned else { return }
            rateChangeWarned = true
            warnings.append("the stream refused a frame-rate change, recording continues at the previous rate: \(error.localizedDescription)")
        }
    }

    func prepareVideo(width: Int, height: Int) throws {
        guard let path = options.videoOut else { return }
        let url = URL(fileURLWithPath: path)
        guard !FileManager.default.fileExists(atPath: path) else {
            throw NSError(domain: "ax-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "video already exists; choose a new output path"])
        }
        let writer = try AVAssetWriter(outputURL: url, fileType: options.selection.codec == "prores4444" ? .mov : .mp4)
        var settings: [String: Any] = [
            AVVideoCodecKey: options.selection.codec == "prores4444" ? AVVideoCodecType.proRes4444 : AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ]
        if options.selection.codec != "prores4444" {
            settings[AVVideoCompressionPropertiesKey] = h264Compression(width: width, height: height, fps: options.activeFps)
        }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        for source in options.audioSources {
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: aacSettings(channels: audioChannelCount(source)))
            audioInput.expectsMediaDataInRealTime = true
            guard writer.canAdd(audioInput) else {
                throw NSError(domain: "ax-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "the movie cannot take a \(source.rawValue) audio track"])
            }
            writer.add(audioInput)
            audioInputs[source] = audioInput
        }
        guard writer.startWriting() else {
            throw writer.error ?? NSError(domain: "ax-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "video writer refused to start"])
        }
        self.writer = writer
        self.writerInput = input
        self.adaptor = adaptor
    }

    private func h264Compression(width: Int, height: Int, fps: Double) -> [String: Any] {
        [
            AVVideoAverageBitRateKey: screenMovieBitRate(width: width, height: height, fps: fps),
            AVVideoExpectedSourceFrameRateKey: Int(fps.rounded()),
            AVVideoMaxKeyFrameIntervalKey: max(1, Int((fps * 2).rounded())),
            AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
        ]
    }

    var frameQueue: DispatchQueue { queue }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[String: Any]],
              let rawStatus = attachments.first?[SCStreamFrameInfo.status.rawValue] as? Int,
              SCFrameStatus(rawValue: rawStatus) == .complete,
              let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }
        consume(pixelBuffer, timestamp: CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
    }

    /// Called on frameQueue by either the desktop stream or the isolated-window compositor.
    func consume(_ pixelBuffer: CVPixelBuffer, timestamp: CMTime) {
        if firstTimestamp == nil {
            firstTimestamp = timestamp
            writer?.startSession(atSourceTime: timestamp)
            audio?.movieStarted(at: timestamp)
        }
        lastTimestamp = timestamp
        captured += 1
        guard !paused else { return }
        // Configuration can deliver the new size before the content filter succeeds.
        guard pendingDisplay == nil else { return }
        if let adaptor, let writerInput, writerInput.isReadyForMoreMediaData {
            // A refused append is how a dimension or format mismatch shows itself. Warn once:
            // the rest of the recording would repeat it on every frame.
            if !adaptor.append(pixelBuffer, withPresentationTime: timestamp), !videoAppendFailed {
                videoAppendFailed = true
                warnings.append("the video writer refused a frame: \(writer?.error?.localizedDescription ?? "no writer error reported")")
            }
        }
        if heartbeat.enabled {
            latestBuffer = pixelBuffer
        }
        guard let signature = signature(of: pixelBuffer) else { return }
        let timestampMs = elapsedMs(timestamp)
        var candidate = policy
        let decision = candidate.consider(signature)
        if let fps = rate.observe(kept: decision.moved, atMs: timestampMs) {
            applyRate(fps)
        }

        guard decision.keep else {
            policy = candidate
            return
        }
        keep(pixelBuffer, timestampMs: timestampMs, decision: decision, candidate: candidate)
    }

    /// Writes one kept frame and commits `candidate`. False when the frame was not admitted.
    @discardableResult
    private func keep(_ pixelBuffer: CVPixelBuffer, timestampMs: Int, decision: KeepPolicy.Decision,
                      candidate: KeepPolicy) -> Bool {
        // A full-size PNG takes longer to encode than a frame lasts (a retina window: 150 to 400 ms). Encoded here, it
        // held this queue, so the stream and the movie fell to about 6 fps (2026-10-26). The encoder has its own queue;
        // only the pixels are copied out here, because the stream reuses its few buffers.
        guard admitPNG(videoConfigured: options.videoOut != nil, pending: pendingEncodes, maximum: Self.maxPendingEncodes) else {
            encoderBehind += 1
            return false
        }
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(image, from: image.extent) else {
            warnings.append("frame at \(timestampMs) ms could not be rendered")
            return false
        }
        policy = candidate
        lastKeptMs = timestampMs
        reservedFrames += 1
        let index = reservedFrames
        let file = String(format: "keep-%04d.png", index)
        let url = URL(fileURLWithPath: options.outDir).appendingPathComponent(file)
        let frame = KeptFrame(index: index, file: file, timestampMs: timestampMs, changePercent: decision.changePercent,
                              reason: decision.reason, displayID: currentDisplayID, motionBoxes: decision.motionBoxes)
        let encode = { () -> (failure: String?, bytes: Int) in
            guard let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else {
                return ("frame at \(timestampMs) ms could not be encoded", 0)
            }
            do {
                try png.write(to: url, options: .atomic)
                return (nil, png.count)
            } catch {
                return ("frame at \(timestampMs) ms could not be written: \(error.localizedDescription)", 0)
            }
        }
        // On this queue: the frame is kept, or its failure is a warning.
        func land(_ result: (failure: String?, bytes: Int)) {
            if let failure = result.failure {
                warnings.append(failure)
                return
            }

            kept.append(frame)
            policy.noteWritten(bytes: result.bytes)
            var event: [String: Any] = ["event": "frame", "index": frame.index - 1, "file": frame.file, "path": url.path,
                                        "timestampMs": frame.timestampMs, "reason": frame.reason]
            if let id = frame.displayID {
                event["displayId"] = id
            }
            CaptureEvents.emit(event)
            if let maxMb = options.maxMb, policy.capReached, policy.keptCount < policy.maxFrames, !byteCapWarned {
                byteCapWarned = true
                warnings.append("--max-mb \(maxMb) reached after \(kept.count) frames; later frames were measured, not kept")
            }
        }
        if options.videoOut == nil {
            land(encode())
        } else {
            pendingEncodes += 1
            encodeQueue.async { [self] in
                let result = encode()
                queue.async { [self] in
                    pendingEncodes -= 1
                    land(result)
                }
            }
        }

        return true
    }

    /// Waits until every kept frame is on disk and in `kept`. Call it after the stream stopped.
    func drainFrames() {
        queue.sync {}
        encodeQueue.sync {}
        queue.sync {
            if encoderBehind > 0 {
                warnings.append("\(encoderBehind) changed frames were not saved as PNG because the encoder fell behind")
            }
        }
    }

    // Delegate callbacks are NOT bound to sampleHandlerQueue, so this runs on some other queue.
    // `stopped.wait` can also return on its timeout rather than on this signal, and a
    // `frameQueue.sync {}` cannot order a write made elsewhere — so both the write and the read
    // go through the frame queue, and the signal stays inside the block that did the write.
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { [self] in
            streamError = error
            stopped.signal()
        }
    }

    var failure: Error? { queue.sync { streamError } }

    /// The first frame's host time: the origin of every timestamp in the result, audio included.
    var origin: CMTime? { queue.sync { firstTimestamp } }

    /// `set-fps`: a new rate pair, applied at once at the new active rate.
    func setFrameRates(active: Double?, idle: Double?) -> (active: Double, idle: Double) {
        queue.sync {
            activeFps = active ?? activeFps
            idleFps = min(idle ?? idleFps, activeFps)
            rate = FrameRatePolicy(activeFps: activeFps, idleFps: idleFps,
                                   quietMs: options.quietMs)
            applyRate(activeFps)
            return (activeFps, idleFps)
        }
    }

    /// `set-threshold`.
    func setThreshold(_ percent: Double) {
        queue.sync { policy.setThreshold(percent) }
    }

    /// The next frame is kept as the first one at a new output size.
    func noteResize() {
        queue.async { [self] in policy.restart(reason: "resize") }
    }

    /// A change to the live configuration, made on the frame queue; the caller hands the result to the stream.
    func changeConfiguration(_ change: (SCStreamConfiguration) -> Void) -> SCStreamConfiguration {
        queue.sync {
            change(configuration)
            return configuration
        }
    }

    var rateSettings: (active: Double, idle: Double, threshold: Double) {
        queue.sync { (activeFps, idleFps, policy.thresholdPercent) }
    }

    var videoSucceeded: Bool { options.videoOut == nil || (writer?.status == .completed && !videoAppendFailed) }

    /// `stop` is the host-clock moment recording stopped. Frames carry host-clock timestamps and
    /// the session started at the first one, so the end needs no duration from another origin.
    func finishVideo(stoppedAt stop: CMTime) {
        guard let writer, let writerInput else { return }
        if firstTimestamp != nil {
            writer.endSession(atSourceTime: movieSessionEnd(stop: stop, lastFrame: lastTimestamp))
        }
        writerInput.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        // A writer that never calls back used to hold this thread forever, after the capture had
        // already succeeded. Ten seconds is generous for finalising a file; past that, warn and go on.
        if done.wait(timeout: .now() + 10) == .timedOut {
            warnings.append("video writer did not finish within 10s; the file may be truncated")
        }
        if writer.status != .completed {
            warnings.append("video writer ended with status \(writer.status.rawValue): \(writer.error?.localizedDescription ?? "unknown")")
        }
    }
}

/// At most this many cells on one sheet. 5000 kept frames would otherwise ask for a
/// 1200x181812 bitmap (about 832 MiB, and past what CoreGraphics will allocate); the sheet is
/// something a human looks at in one glance, so beyond this it samples evenly and says which
/// frames it took under `sampledFrameIndexes`.
private let contactSheetMaxCells = 200

/// Picks up to `contactSheetMaxCells` frames, evenly spaced, keeping the first and the last.
private func contactSheetSelection(_ count: Int) -> [Int] {
    guard count > contactSheetMaxCells else { return Array(0..<count) }
    return (0..<contactSheetMaxCells).map { slot in
        Int((Double(slot) * Double(count - 1) / Double(contactSheetMaxCells - 1)).rounded())
    }
}

/// Kept frames tiled six per row at 200 px thumbnails with a timestamp label, the shape the
/// capture review discipline expects: one PNG that shows the whole motion in one look. Each
/// thumbnail is read back from its own PNG and released again, so the sheet costs one frame of
/// memory at a time rather than one per kept frame.
func writeContactSheet(_ frames: [KeptFrame], in directory: URL, to url: URL) -> (rows: Int, columns: Int, sampled: [Int])? {
    guard !frames.isEmpty else { return nil }
    let selection = contactSheetSelection(frames.count)
    let cell = 200
    let label = 18
    let columns = min(6, selection.count)
    let rows = (selection.count + columns - 1) / columns
    let width = columns * cell
    let height = rows * (cell + label)
    guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height, bitsPerSample: 8,
                                        samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                        bytesPerRow: 0, bitsPerPixel: 0),
          let graphics = NSGraphicsContext(bitmapImageRep: bitmap) else {
        return nil
    }
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = graphics
    let cg = graphics.cgContext
    cg.setFillColor(CGColor(gray: 0.12, alpha: 1))
    cg.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedSystemFont(ofSize: 11, weight: .regular),
        .foregroundColor: NSColor.white,
    ]
    for (position, frameIndex) in selection.enumerated() {
        let frame = frames[frameIndex]
        let column = position % columns
        let row = position / columns
        // Bitmap contexts are bottom-left origin; lay rows out from the top.
        let originY = height - (row + 1) * (cell + label)
        let originX = column * cell
        // autoreleasepool: the decoded frame is full screen resolution, so without it every
        // image read here would stay alive until the whole loop ends, which is the retention
        // this function was changed to avoid.
        autoreleasepool {
            let source = CGImageSourceCreateWithURL(directory.appendingPathComponent(frame.file) as CFURL, nil)
            let options: [CFString: Any] = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceThumbnailMaxPixelSize: cell,
            ]
            if let source, let thumb = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) {
                let fit = min(CGFloat(cell) / CGFloat(thumb.width), CGFloat(cell) / CGFloat(thumb.height), 1)
                let drawWidth = CGFloat(thumb.width) * fit
                let drawHeight = CGFloat(thumb.height) * fit
                cg.draw(thumb, in: CGRect(x: CGFloat(originX) + (CGFloat(cell) - drawWidth) / 2,
                                          y: CGFloat(originY + label) + (CGFloat(cell) - drawHeight) / 2,
                                          width: drawWidth, height: drawHeight))
            }
        }
        let text = String(format: "#%d  +%dms  %.1f%%", frame.index, frame.timestampMs, frame.changePercent) as NSString
        text.draw(at: NSPoint(x: CGFloat(originX) + 4, y: CGFloat(originY) + 3), withAttributes: attributes)
    }
    NSGraphicsContext.restoreGraphicsState()
    guard let png = bitmap.representation(using: .png, properties: [:]) else { return nil }
    do {
        try png.write(to: url, options: .atomic)
    } catch {
        return nil
    }
    return (rows, columns, selection)
}

func cmdCaptureScreen() {
    defaultErrorCode = "failed"
    guard #available(macOS 13.0, *) else {
        errorExit("capture needs macOS 13 or newer")
    }
    let startWarnings = runFromPrivateRecorderCopy()
    requireScreenRecording()
    let options = recordOptions(startWarnings: startWarnings)
    do {
        try FileManager.default.createDirectory(atPath: options.outDir, withIntermediateDirectories: true)
    } catch {
        errorExit("cannot create --out directory: \(error.localizedDescription)")
    }

    if options.mode == "isolated" {
        captureIsolatedWindows(options)
        return
    }

    // Resolve what to capture before touching ScreenCaptureKit, so every refusal names its cause.
    var windowTarget: (id: CGWindowID, bounds: CGRect)?
    var display: DisplayGeometry?
    var sourceRect: CGRect?
    switch options.mode {
    case "window":
        let target = resolveRecordWindow(options)
        do {
            try validateRecordingWindow(target.id, excluding: options.selection.excludedWindowIDs)
        } catch {
            errorExit(error.localizedDescription)
        }
        windowTarget = target
        display = displayContaining(CGPoint(x: target.bounds.midX, y: target.bounds.midY))
    case "region":
        guard let region = options.region else { errorExit("region mode needs --region x,y,w,h", code: "invalid-argument") }
        guard let found = displayContaining(CGPoint(x: region.midX, y: region.midY)) else {
            errorExit("no display contains the region", code: "display-missing")
        }
        display = found
        sourceRect = CGRect(x: region.minX - found.bounds.minX, y: region.minY - found.bounds.minY,
                            width: region.width, height: region.height)
    default:
        if let id = options.displayID {
            display = displayForID(id)
        } else if options.followFocus, let id = currentFocusDisplay() {
            display = displayGeometry(id)
        } else {
            display = displayForScreenIndex(options.screenIndex ?? 0)
        }
    }
    guard let display else { errorExit("no display for the capture target", code: "display-missing") }

    let indicator = RecordingIndicator(enabled: options.selection.indicator)
    indicator.update([windowTarget?.bounds ?? options.region ?? display.bounds])
    defer { indicator.close() }

    let content: SCShareableContent
    do {
        content = try awaitResult { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    } catch {
        errorExit("ScreenCaptureKit refused to enumerate content: \(error.localizedDescription)", code: captureErrorCode(error))
    }
    let filter: SCContentFilter
    let pointSize: CGSize
    if let windowTarget {
        guard let window = content.windows.first(where: { $0.windowID == windowTarget.id }) else {
            errorExit("window \(windowTarget.id) is not shareable; inspect again")
        }
        filter = SCContentFilter(desktopIndependentWindow: window)
        pointSize = window.frame.size
    } else {
        guard let scDisplay = content.displays.first(where: { $0.displayID == display.id }) else {
            errorExit("display \(display.id) is not shareable", code: "display-missing")
        }
        let excluded = indicator.windowIDs.union(options.selection.excludedWindowIDs)
        filter = SCContentFilter(display: scDisplay, excludingWindows: content.windows.filter { excluded.contains($0.windowID) })
        pointSize = sourceRect?.size ?? display.bounds.size
    }
    let configuration = SCStreamConfiguration()
    // Round DOWN to even here, not later in prepareVideo: h264 needs even dimensions, and an
    // odd capture size used to mean SCStream delivered an odd CVPixelBuffer while the writer had
    // been configured one pixel smaller. The adaptor then refused every append and only a
    // generic writer-status warning said so.
    let output = recordOutputSize(options, points: pointSize, scale: display.scale)
    let width = Int(output.width)
    let height = Int(output.height)
    configuration.width = width
    configuration.height = height
    if let sourceRect {
        configuration.sourceRect = sourceRect
    }
    configuration.pixelFormat = kCVPixelFormatType_32BGRA
    let activeInterval = frameInterval(fps: options.activeFps)
    configuration.minimumFrameInterval = CMTime(value: activeInterval.value, timescale: activeInterval.timescale)
    configuration.queueDepth = 5
    configuration.showsCursor = true
    configuration.backgroundColor = options.selection.transparent ? captureClearColor : captureOpaqueColor
    if #available(macOS 14.0, *) {
        configuration.ignoreShadowsSingleWindow = true
        configuration.preservesAspectRatio = true
    }
    configureAudio(configuration, options)

    let recorder = NativeRecorder(options: options, configuration: configuration, displayID: display.id)
    do {
        try recorder.prepareVideo(width: width, height: height)
    } catch {
        errorExit("cannot open --video-out: \(error.localizedDescription)")
    }
    let audio = options.audioSources.isEmpty ? nil : NativeAudio(
        sources: options.audioSources, movieInputs: recorder.audioInputs,
        sidecarDirectory: options.audioSidecar ? URL(fileURLWithPath: options.outDir) : nil)
    recorder.audio = audio
    let stream = SCStream(filter: filter, configuration: configuration, delegate: recorder)
    recorder.stream = stream
    do {
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.frameQueue)
        if let audio {
            try addAudioOutputs(audio, to: stream)
        }
        try awaitResult { try await stream.startCapture() }
    } catch {
        errorExit("recording never started: \(error.localizedDescription)", code: captureErrorCode(error))
    }
    recorder.startHeartbeat()
    let host = ScreenStreamHost(options: options, recorder: recorder, configuration: configuration, indicator: indicator,
                                stream: stream, display: display, pointSize: pointSize, audio: audio)
    if options.controlStdin {
        CaptureEvents.enabled = true
        host.startControlChannel()
        CaptureEvents.emit(["event": "state", "state": "recording", "displayId": display.id])
    }
    if options.mode == "screen" {
        displayReconfigurationHandler = { changed, flags in
            DispatchQueue.main.async {
                switch displayChangeAction(changed: changed, flags: flags, recorded: host.display.id,
                                           followFocus: options.followFocus) {
                case .ignore:
                    break
                case .switchToFocus:
                    host.displayLost = true
                case .end:
                    host.displayRemoved = true
                }
            }
        }
        CGDisplayRegisterReconfigurationCallback(displayReconfigurationCallback, nil)
    }
    let started = Date()
    let cancelled = runRecordingLoop(duration: options.duration) {
        if let target = windowTarget,
           let rows = CGWindowListCopyWindowInfo([.optionIncludingWindow], target.id) as? [[CFString: Any]],
           let raw = rows.first?[kCGWindowBounds] as? NSDictionary, let bounds = CGRect(dictionaryRepresentation: raw) {
            indicator.update([bounds])
        }
        guard options.mode == "screen" else { return recorder.failure == nil && !host.stopRequested }

        return host.tick()
    }
    if options.mode == "screen" {
        CGDisplayRemoveReconfigurationCallback(displayReconfigurationCallback, nil)
        displayReconfigurationHandler = nil
    }
    indicator.close()
    recorder.stopHeartbeat()
    let streamFailure = recorder.failure
    if streamFailure == nil {
        do {
            try awaitResult(timeoutSeconds: host.displayRemoved ? 5 : 30) { try await host.stream.stopCapture() }
        } catch {
            if !host.displayRemoved {
                recorder.warn("the stream did not stop cleanly: \(error.localizedDescription)")
            }
        }
    }
    let stoppedAt = CMClockGetTime(CMClockGetHostTimeClock())
    let durationMs = Int((Date().timeIntervalSince(started) * 1000).rounded())
    if let streamFailure, !host.displayRemoved {
        recorder.warn("recording stopped early: \(streamFailure.localizedDescription)")
    }
    // Drain the frame and encode queues so the last kept frame is on disk before the sheet is built.
    recorder.drainFrames()
    audio?.close()
    recorder.finishVideo(stoppedAt: stoppedAt)
    let endedEarly = captureEarlyEnd(cancelled: cancelled || host.stopRequested, displayRemoved: host.displayRemoved,
                                     streamFailed: streamFailure != nil)

    let outURL = URL(fileURLWithPath: options.outDir)
    let frames: [[String: Any]] = recorder.kept.map { frame in
        var row: [String: Any] = [
            "index": frame.index - 1, "file": frame.file, "path": outURL.appendingPathComponent(frame.file).path,
            "timestampMs": frame.timestampMs, "changePercent": (frame.changePercent * 100).rounded() / 100,
            "reason": frame.reason, "captureEngine": "ScreenCaptureKit", "motionBoxes": frame.motionBoxesJSON,
        ]
        if let id = frame.displayID {
            row["displayId"] = id
        }
        return row
    }
    var sheet: [String: Any] = [:]
    let sheetURL = outURL.appendingPathComponent("contact.png")
    if let layout = writeContactSheet(recorder.kept, in: outURL, to: sheetURL) {
        sheet = ["path": sheetURL.path, "file": "contact.png", "rows": layout.rows, "columns": layout.columns,
                 "thumbSize": [200, 200], "sampledFrameIndexes": layout.sampled]
    }
    var recordedOptions: [String: Any] = [
        "mode": options.mode, "duration": options.duration, "activeFps": options.activeFps,
        "idleFps": options.idleFps, "changeThresholdPercent": options.threshold, "maxFrames": options.maxFrames,
        "width": width, "height": height, "scaleFactor": display.scale,
        "transparent": options.selection.transparent, "codec": options.selection.codec,
        "indicator": options.selection.indicator, "indicatorCaptured": false,
        "displayId": display.id, "followFocus": options.followFocus, "heartbeatSec": options.heartbeatSec,
        "quietMs": options.quietMs ?? FrameRatePolicy.defaultQuietMs(activeFps: options.activeFps),
        "audio": options.audioSources.map(\.rawValue), "audioSidecar": options.audioSidecar,
    ]
    if let micDevice = options.micDevice {
        recordedOptions["micDevice"] = micDevice
    }
    if let maxLongSide = options.maxLongSide {
        recordedOptions["maxLongSide"] = maxLongSide
    }
    if let maxMb = options.maxMb {
        recordedOptions["maxMb"] = maxMb
    }
    var data: [String: Any] = [
        "source": "native", "captureEngine": "ScreenCaptureKit", "scope": options.mode, "cancelled": cancelled || host.stopRequested,
        "options": recordedOptions,
        "frames": frames,
        "stats": ["durationMs": durationMs, "capturedFrames": recorder.captured, "keptFrames": recorder.kept.count,
                  "droppedFrames": recorder.captured - recorder.kept.count, "bytesWritten": recorder.bytesWritten,
                  "displaySwitches": recorder.displaySwitches, "heartbeatFrames": recorder.heartbeatFrames],
        "warnings": recorder.warnings,
        "sessionDir": options.outDir,
        "display": ["id": host.display.id],
        "displays": host.displaysUsed,
    ]
    if let audio {
        data["tracks"] = audio.summaries(origin: recorder.origin)
    }
    if let endedEarly {
        data["endedEarly"] = endedEarly.rawValue
    }
    if let streamFailure {
        data["streamError"] = streamFailure.localizedDescription
    }
    if !sheet.isEmpty {
        data["contactSheet"] = sheet
    }
    if let videoOut = options.videoOut {
        data["videoOut"] = videoOut
    }
    if let windowTarget {
        data["window"] = ["id": windowTarget.id, "x": windowTarget.bounds.minX, "y": windowTarget.bounds.minY,
                          "width": windowTarget.bounds.width, "height": windowTarget.bounds.height]
    }
    let metadataURL = outURL.appendingPathComponent("metadata.json")
    if let metadata = try? JSONSerialization.data(withJSONObject: data, options: [.sortedKeys, .prettyPrinted]) {
        try? metadata.write(to: metadataURL, options: .atomic)
        data["metadataFile"] = metadataURL.path
    }
    jsonOutput(["success": recorder.videoSucceeded, "ok": recorder.videoSucceeded, "data": data])
    if !recorder.videoSucceeded { exit(1) }
}

/// The stream output size: the selection's size at the display scale, then capped by `--max-long-side`.
private func recordOutputSize(_ options: RecordOptions, points: CGSize, scale: CGFloat,
                              maxLongSide: Int?? = nil) -> CGSize {
    let video = options.videoOut != nil
    let size = options.selection.dimensions(points: points, nativeScale: scale, video: video)
    return capLongSide(size, maxLongSide: maxLongSide ?? options.maxLongSide, even: video && options.selection.codec == "h264")
}

/// `no-permission` when ScreenCaptureKit says the user declined, else `failed`.
private func captureErrorCode(_ error: Error) -> String {
    let error = error as NSError
    return error.domain == SCStreamErrorDomain && error.code == SCStreamError.userDeclined.rawValue ? "no-permission" : "failed"
}

/// System audio and the microphone on the stream configuration. The caller checked the OS version for the microphone.
private func configureAudio(_ configuration: SCStreamConfiguration, _ options: RecordOptions) {
    guard !options.audioSources.isEmpty else { return }
    configuration.sampleRate = 48_000
    configuration.channelCount = 2
    if options.audioSources.contains(.system) {
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
    }
    if options.audioSources.contains(.mic), #available(macOS 15.0, *) {
        switch AVCaptureDevice.authorizationStatus(for: .audio) {
        case .denied, .restricted:
            errorExit("microphone access is not granted to the app that started ax-tool (GenesisTools.app when it is the launcher)",
                      code: "no-permission")
        default:
            break
        }
        configuration.captureMicrophone = true
        configuration.microphoneCaptureDeviceID = options.micDevice
    }
}

private func addAudioOutputs(_ audio: NativeAudio, to stream: SCStream) throws {
    if audio.sources.contains(.system) {
        try stream.addStreamOutput(audio, type: .audio, sampleHandlerQueue: audio.queue)
    }
    if audio.sources.contains(.mic), #available(macOS 15.0, *) {
        try stream.addStreamOutput(audio, type: .microphone, sampleHandlerQueue: audio.queue)
    }
}

/// Owns the stream of a screen, window or region recording. In screen mode it also moves the stream between
/// displays: `--follow-focus` switches the content filter live, and a stream whose display went away starts again
/// on the display that now holds focus. Everything here runs on the main thread.
@available(macOS 13.0, *)
private final class ScreenStreamHost {
    let options: RecordOptions
    let recorder: NativeRecorder
    let configuration: SCStreamConfiguration
    let indicator: RecordingIndicator
    private(set) var stream: SCStream
    private(set) var display: DisplayGeometry
    private(set) var displaysUsed: [CGDirectDisplayID]
    /// The recorded display is gone and the recording ends with `display-removed`.
    var displayRemoved = false
    /// The reconfiguration callback saw the recorded display leave while following focus.
    var displayLost = false
    /// A `stop` command or the end of stdin: end like SIGINT.
    var stopRequested = false
    private var switching = false
    private var failedSwitch: (id: CGDirectDisplayID, at: Date)?
    /// Ticks since the stream reported an error; a removed display can report it before the display list changes.
    private var deadTicks = 0

    let audio: NativeAudio?
    /// `set-max-long-side` replaces `--max-long-side`.
    private var maxLongSide: Int?
    /// The size in points the stream records: the display in screen mode, else the window or region.
    private var pointSize: CGSize
    private var micDevice: String?

    init(options: RecordOptions, recorder: NativeRecorder, configuration: SCStreamConfiguration,
         indicator: RecordingIndicator, stream: SCStream, display: DisplayGeometry, pointSize: CGSize, audio: NativeAudio?) {
        self.audio = audio
        self.maxLongSide = options.maxLongSide
        self.pointSize = pointSize
        self.micDevice = options.micDevice
        self.options = options
        self.recorder = recorder
        self.configuration = configuration
        self.indicator = indicator
        self.stream = stream
        self.display = display
        self.displaysUsed = [display.id]
    }

    private var excludedWindowIDs: Set<CGWindowID> { indicator.windowIDs.union(options.selection.excludedWindowIDs) }

    /// One 250 ms check of a screen recording. False ends the recording.
    func tick() -> Bool {
        if displayRemoved || stopRequested {
            return false
        }

        if options.followFocus, #available(macOS 14.0, *) {
            follow()
        }
        guard recorder.failure != nil else {
            deadTicks = 0
            return !displayRemoved
        }

        deadTicks += 1
        if !displayIsActive(display.id) {
            if options.followFocus && (switching || deadTicks < 4) { return true }
            displayRemoved = true
            return false
        }

        // About a second for the display list to catch up with a stream that died with its display.
        return deadTicks < 4
    }

    /// One `--control-stdin` command, on the main thread.
    func handle(_ command: CaptureCommand) {
        switch command {
        case .pause, .resume:
            let paused = command == .pause
            recorder.setPaused(paused)
            audio?.setPaused(paused)
            CaptureEvents.emit(["event": "state", "state": paused ? "paused" : "recording"])
        case .mute(let source), .unmute(let source):
            let muted: Bool
            if case .mute = command { muted = true } else { muted = false }
            guard let audio, audio.setMuted(source, muted) else {
                CaptureEvents.error("invalid-argument", "\(source.rawValue) audio is not recorded; start with --audio \(source.rawValue)")
                return
            }
            CaptureEvents.emit(["event": "state", "state": recorder.status()["state"] ?? "recording", "muted": audio.mutedState])
        case .setMic(let deviceId):
            setMic(deviceId)
        case .setFps(let active, let idle):
            _ = recorder.setFrameRates(active: active, idle: idle)
            emitSettings()
        case .setThreshold(let percent):
            recorder.setThreshold(percent)
            emitSettings()
        case .setMaxLongSide(let px):
            setMaxLongSide(px)
        case .stop:
            stopRequested = true
        case .status:
            CaptureEvents.emit(["event": "state"].merging(recorder.status()) { first, _ in first })
        case .switchDisplay(let id):
            guard options.mode == "screen", !options.followFocus else {
                CaptureEvents.error("invalid-argument", "switch needs --mode screen without --follow-focus")
                return
            }
            guard displayIsActive(id) else {
                let known = activeDisplays().map { String($0.id) }.joined(separator: ", ")
                CaptureEvents.error("display-missing", "display \(id) is not connected (connected: \(known))")
                return
            }
            guard id != display.id else { return }
            guard #available(macOS 14.0, *) else {
                CaptureEvents.error("failed", "switching a live stream needs macOS 14 or newer")
                return
            }
            guard !switching else {
                CaptureEvents.error("failed", "a display switch is still in progress; send it again")
                return
            }
            switchLive(to: id)
        }
    }

    func emitSettings() {
        let rates = recorder.rateSettings
        var event: [String: Any] = ["event": "settings", "activeFps": rates.active, "idleFps": rates.idle,
                                    "threshold": rates.threshold, "maxLongSide": maxLongSide ?? NSNull()]
        if let audio {
            event["muted"] = audio.mutedState
            event["micDevice"] = micDevice ?? NSNull()
        }
        CaptureEvents.emit(event)
    }

    private func setMic(_ deviceId: String) {
        guard let audio, audio.sources.contains(.mic) else {
            CaptureEvents.error("invalid-argument", "the microphone is not recorded; start with --audio mic")
            return
        }
        guard audioDevices().contains(where: { $0.uid == deviceId && $0.inputChannels > 0 }) else {
            CaptureEvents.error("device-missing", "no input device \(deviceId); run `ax-tool audio-devices`")
            return
        }
        guard #available(macOS 15.0, *) else {
            CaptureEvents.error("unsupported", "microphone capture needs macOS 15 or newer")
            return
        }
        let stream = self.stream
        Task { @MainActor in
            let configuration = recorder.changeConfiguration { _ in }
            let previous = configuration.microphoneCaptureDeviceID
            do {
                try await updateCaptureConfiguration(from: previous, to: deviceId, set: { value in
                    _ = self.recorder.changeConfiguration { $0.microphoneCaptureDeviceID = value }
                }, apply: { try await stream.updateConfiguration(configuration) })
                DispatchQueue.main.async {
                    self.micDevice = deviceId
                    self.emitSettings()
                }
            } catch {
                CaptureEvents.error("failed", "the stream refused the microphone \(deviceId): \(error.localizedDescription)")
            }
        }
    }

    private func setMaxLongSide(_ px: Int?) {
        guard options.videoOut == nil else {
            CaptureEvents.error("unsupported", "a movie keeps one size; set-max-long-side works only without --video-out")
            return
        }
        let size = recordOutputSize(options, points: pointSize, scale: display.scale, maxLongSide: px)
        let stream = self.stream
        Task { @MainActor in
            let configuration = recorder.changeConfiguration { _ in }
            let previous = (configuration.width, configuration.height)
            do {
                try await updateCaptureConfiguration(from: previous, to: (Int(size.width), Int(size.height)), set: { value in
                    _ = self.recorder.changeConfiguration { $0.width = value.0; $0.height = value.1 }
                }, apply: { try await stream.updateConfiguration(configuration) })
                self.maxLongSide = px
                self.recorder.noteResize()
                self.emitSettings()
            } catch {
                CaptureEvents.error("failed", "the stream refused the new size: \(error.localizedDescription)")
            }
        }
    }

    /// Reads one command per stdin line on a background thread; the end of stdin stops the recording.
    func startControlChannel() {
        Thread.detachNewThread { [self] in
            while let line = readLine(strippingNewline: true) {
                guard let parsed = parseCaptureCommand(line) else { continue }
                DispatchQueue.main.async { [self] in
                    switch parsed {
                    case .success(let command):
                        handle(command)
                    case .failure(let error):
                        CaptureEvents.error("invalid-argument", error.message)
                    }
                }
            }
            DispatchQueue.main.async { [self] in
                stopRequested = true
            }
        }
    }

    @available(macOS 14.0, *)
    private func follow() {
        guard !switching, let target = currentFocusDisplay() else { return }
        let lost = displayLost || !displayIsActive(display.id)
        if recorder.failure != nil {
            if lost {
                restart(on: target)
            }
            return
        }

        guard !lost, target != display.id else { return }
        if let failedSwitch, failedSwitch.id == target, Date().timeIntervalSince(failedSwitch.at) < 5 {
            return
        }

        switchLive(to: target)
    }

    private func adopt(_ geometry: DisplayGeometry) {
        display = geometry
        pointSize = geometry.bounds.size
        displayLost = false
        if !displaysUsed.contains(geometry.id) {
            displaysUsed.append(geometry.id)
        }
        indicator.update([geometry.bounds])
    }

    private func outputSize(for geometry: DisplayGeometry) -> CGSize? {
        // A movie keeps one size from start to end; the stream letterboxes another display into it.
        options.videoOut == nil
            ? recordOutputSize(options, points: geometry.bounds.size, scale: geometry.scale, maxLongSide: maxLongSide) : nil
    }

    @available(macOS 14.0, *)
    private func switchLive(to target: CGDirectDisplayID) {
        switching = true
        let geometry = displayGeometry(target)
        let size = outputSize(for: geometry)
        let previousDisplay = display
        let previousSize = outputSize(for: display)
        let excluded = excludedWindowIDs
        let stream = self.stream
        let recorder = self.recorder
        Task {
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let scDisplay = content.displays.first(where: { $0.displayID == target }) else {
                    throw NSError(domain: "ax-tool", code: 2, userInfo: [NSLocalizedDescriptionKey: "display \(target) is not shareable"])
                }
                let filter = SCContentFilter(display: scDisplay, excludingWindows: content.windows.filter { excluded.contains($0.windowID) })
                if let size {
                    try await stream.updateConfiguration(recorder.setOutputSize(width: Int(size.width), height: Int(size.height), for: target))
                }
                try await stream.updateContentFilter(filter)
                recorder.displayChanged(to: target)
                DispatchQueue.main.async {
                    self.adopt(geometry)
                    self.switching = false
                }
            } catch {
                if let previousSize {
                    do {
                        let configuration = recorder.setOutputSize(width: Int(previousSize.width), height: Int(previousSize.height), for: previousDisplay.id)
                        try await stream.updateConfiguration(configuration)
                    } catch {
                        recorder.warn("could not restore the recording size: \(error.localizedDescription)")
                    }
                }
                recorder.cancelPendingDisplay()
                recorder.warn("could not switch the recording to display \(target): \(error.localizedDescription)")
                CaptureEvents.error("failed", "could not switch the recording to display \(target): \(error.localizedDescription)")
                DispatchQueue.main.async {
                    self.failedSwitch = (target, Date())
                    self.switching = false
                }
            }
        }
    }

    /// A new stream on `target`, after the recorded display went away and took the stream with it.
    private func restart(on target: CGDirectDisplayID) {
        let geometry = displayGeometry(target)
        do {
            let content = try awaitResult(timeoutSeconds: 10) {
                try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            }
            guard let scDisplay = content.displays.first(where: { $0.displayID == target }) else { return }
            indicator.update([geometry.bounds])
            let excluded = excludedWindowIDs
            let filter = SCContentFilter(display: scDisplay, excludingWindows: content.windows.filter { excluded.contains($0.windowID) })
            if let size = outputSize(for: geometry) {
                _ = recorder.setOutputSize(width: Int(size.width), height: Int(size.height), for: target)
            }
            let next = SCStream(filter: filter, configuration: configuration, delegate: recorder)
            try next.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.frameQueue)
            if let audio {
                try addAudioOutputs(audio, to: next)
            }
            try awaitResult { try await next.startCapture() }
            stream = next
            recorder.stream = next
            recorder.clearFailure()
            recorder.displayChanged(to: target)
            adopt(geometry)
            deadTicks = 0
        } catch {
            recorder.warn("could not restart the recording on display \(target): \(error.localizedDescription)")
            CaptureEvents.error("failed", "could not restart the recording on display \(target): \(error.localizedDescription)")
            displayRemoved = true
        }
    }
}

/// Runs one async throwing call to completion from a plain command-line entry point.
/// Blocks the main thread on an async operation, for at most `timeoutSeconds`.
///
/// The wait is a kernel sleep, so it costs nothing while it waits; the point of the deadline is
/// that ScreenCaptureKit's start and stop are XPC calls, and an XPC call that never answers used to
/// hold this process forever. The caller's own grace kill exists too, but a timeout here reports a
/// real error to the user instead of a silent kill.
func awaitResult<T>(timeoutSeconds: Double = 30, _ operation: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var outcome: Result<T, Error>?
    let task = Task {
        do {
            outcome = .success(try await operation())
        } catch {
            outcome = .failure(error)
        }
        done.signal()
    }
    if done.wait(timeout: .now() + timeoutSeconds) == .timedOut {
        task.cancel()
        throw NSError(
            domain: "ax-tool",
            code: 75,
            userInfo: [NSLocalizedDescriptionKey: "screen capture did not answer within \(Int(timeoutSeconds))s"]
        )
    }
    return try outcome!.get()
}
