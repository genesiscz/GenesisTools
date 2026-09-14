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

private struct RecordOptions {
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
}

private func recordOptions() -> RecordOptions {
    let mode = argValue("--mode") ?? "window"
    guard ["screen", "window", "region"].contains(mode) else {
        errorExit("--mode must be screen, window or region")
    }
    func number(_ flag: String, default fallback: Double, min lower: Double, max upper: Double) -> Double {
        guard let raw = argValue(flag) else { return fallback }
        guard let value = Double(raw), value.isFinite, value >= lower, value <= upper else {
            errorExit("\(flag) must be a number between \(lower) and \(upper)")
        }
        return value
    }
    var region: CGRect?
    if let raw = argValue("--region") {
        let parts = raw.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        guard parts.count == 4, parts[2] > 0, parts[3] > 0 else {
            errorExit("--region must be x,y,w,h in global screen points")
        }
        region = CGRect(x: parts[0], y: parts[1], width: parts[2], height: parts[3])
    }
    var windowID: CGWindowID?
    if let raw = argValue("--window-id") {
        guard let id = UInt32(raw), id > 0 else { errorExit("--window-id must be a positive integer") }
        windowID = id
    }
    let outDir = argValue("--out") ?? FileManager.default.temporaryDirectory
        .appendingPathComponent("control-record-\(UUID().uuidString)").path
    // Clamp here rather than inside the rate policy, so `metadata.json` and `--help` report the
    // rate the recorder actually used. An idle rate above the active one would ask the stream
    // for MORE frames while nothing moves, which is the opposite of what the flag is for.
    let activeFps = number("--active-fps", default: 8, min: 0.5, max: 30)
    return RecordOptions(
        mode: mode,
        screenIndex: argValue("--screen-index").flatMap { Int($0) },
        app: argValue("--app"),
        windowTitle: argValue("--window-title"),
        windowIndex: argValue("--window-index").flatMap { Int($0) },
        windowID: windowID,
        region: region,
        duration: number("--duration", default: 3, min: 0.1, max: 180),
        activeFps: activeFps,
        idleFps: min(number("--idle-fps", default: 2, min: 0.1, max: 5), activeFps),
        threshold: number("--threshold", default: 2.5, min: 0, max: 100),
        videoOut: argValue("--video-out"),
        outDir: outDir,
        maxFrames: Int(number("--max-frames", default: 800, min: 1, max: 5000))
    )
}

private struct DisplayGeometry {
    let id: CGDirectDisplayID
    let bounds: CGRect
    let scale: CGFloat
}

private func displayGeometry(_ id: CGDirectDisplayID) -> DisplayGeometry {
    let bounds = CGDisplayBounds(id)
    let scale = bounds.width > 0 ? CGFloat(CGDisplayPixelsWide(id)) / bounds.width : 1
    return DisplayGeometry(id: id, bounds: bounds, scale: scale)
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
        errorExit("--screen-index outside the current display list; run `ax-tool screens`")
    }
    return displayGeometry(id)
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

/// Metadata only. Holding a thumbnail per kept frame retained about 122 MiB at the default
/// 800-frame cap and 763 MiB at the 5000 allowed, for pictures already on disk; the contact
/// sheet reloads each PNG when it needs it and lets it go again.
private struct KeptFrame {
    let index: Int
    let file: String
    let timestampMs: Int
    let changePercent: Double
    let reason: String
}

/// One ScreenCaptureKit stream, the keep policy, PNG output and the optional MP4. Frames arrive
/// on a serial queue, so the policy and the counters need no locking.
@available(macOS 13.0, *)
private final class NativeRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
    private let options: RecordOptions
    private let queue = DispatchQueue(label: "ax-tool.record.frames")
    private let context = CIContext(options: [.cacheIntermediates: false])
    private var policy: KeepPolicy
    private var rate: FrameRatePolicy
    /// Set once the stream exists, so the recorder can ask it for a different rate. The stream
    /// owns the recorder as its delegate and its output, hence weak.
    weak var stream: SCStream?
    private let configuration: SCStreamConfiguration
    private var firstTimestamp: CMTime?
    private(set) var kept: [KeptFrame] = []
    private(set) var captured = 0
    private(set) var warnings: [String] = []
    private var writer: AVAssetWriter?
    private var writerInput: AVAssetWriterInput?
    private var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    private var videoAppendFailed = false
    private var rateChangeWarned = false
    private var streamError: Error?
    let stopped = DispatchSemaphore(value: 0)

    init(options: RecordOptions, configuration: SCStreamConfiguration) {
        self.options = options
        self.configuration = configuration
        self.policy = KeepPolicy(thresholdPercent: options.threshold, maxFrames: options.maxFrames)
        self.rate = FrameRatePolicy(activeFps: options.activeFps, idleFps: options.idleFps)
    }

    /// Asks the live stream for a new delivery rate. Frames arrive on `queue`, so this is called
    /// from there; `updateConfiguration` is async, and a refusal simply leaves the current rate
    /// in place, which is the behaviour a recorder without rate switching already had.
    private func applyRate(_ fps: Double) {
        let interval = frameInterval(fps: fps)
        configuration.minimumFrameInterval = CMTime(value: interval.value, timescale: interval.timescale)
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
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
        ])
        input.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? NSError(domain: "ax-tool", code: 1, userInfo: [NSLocalizedDescriptionKey: "video writer refused to start"])
        }
        self.writer = writer
        self.writerInput = input
        self.adaptor = adaptor
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
        let timestamp = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        if firstTimestamp == nil {
            firstTimestamp = timestamp
            writer?.startSession(atSourceTime: timestamp)
        }
        captured += 1
        if let adaptor, let writerInput, writerInput.isReadyForMoreMediaData {
            // A refused append is how a dimension or format mismatch shows itself. Warn once:
            // the rest of the recording would repeat it on every frame.
            if !adaptor.append(pixelBuffer, withPresentationTime: timestamp), !videoAppendFailed {
                videoAppendFailed = true
                warnings.append("the video writer refused a frame: \(writer?.error?.localizedDescription ?? "no writer error reported")")
            }
        }
        CVPixelBufferLockBaseAddress(pixelBuffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(pixelBuffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(pixelBuffer) else { return }
        let width = CVPixelBufferGetWidth(pixelBuffer)
        let height = CVPixelBufferGetHeight(pixelBuffer)
        let signature = FrameSignature(bgra: UnsafeRawPointer(base), width: width, height: height,
                                       bytesPerRow: CVPixelBufferGetBytesPerRow(pixelBuffer), stride: 4)
        let decision = policy.consider(signature)
        if let fps = rate.observe(kept: decision.keep) {
            applyRate(fps)
        }

        guard decision.keep else { return }
        let elapsed = CMTimeSubtract(timestamp, firstTimestamp ?? timestamp)
        let timestampMs = Int((CMTimeGetSeconds(elapsed) * 1000).rounded())
        let image = CIImage(cvPixelBuffer: pixelBuffer)
        guard let cgImage = context.createCGImage(image, from: image.extent) else {
            warnings.append("frame at \(timestampMs) ms could not be rendered")
            return
        }
        let index = kept.count + 1
        let file = String(format: "keep-%04d.png", index)
        let url = URL(fileURLWithPath: options.outDir).appendingPathComponent(file)
        guard let png = NSBitmapImageRep(cgImage: cgImage).representation(using: .png, properties: [:]) else {
            warnings.append("frame at \(timestampMs) ms could not be encoded")
            return
        }
        do {
            try png.write(to: url, options: .atomic)
        } catch {
            warnings.append("frame at \(timestampMs) ms could not be written: \(error.localizedDescription)")
            return
        }
        kept.append(KeptFrame(index: index, file: file, timestampMs: timestampMs, changePercent: decision.changePercent,
                              reason: decision.reason))
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

    func finishVideo() {
        guard let writer, let writerInput else { return }
        writerInput.markAsFinished()
        let done = DispatchSemaphore(value: 0)
        writer.finishWriting { done.signal() }
        done.wait()
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
private func writeContactSheet(_ frames: [KeptFrame], in directory: URL, to url: URL) -> (rows: Int, columns: Int, sampled: [Int])? {
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
    guard #available(macOS 13.0, *) else {
        errorExit("capture needs macOS 13 or newer")
    }
    guard CGPreflightScreenCaptureAccess() else {
        errorExit("Screen Recording permission is required for capture; grant it to the responsible app and retry")
    }
    let options = recordOptions()
    do {
        try FileManager.default.createDirectory(atPath: options.outDir, withIntermediateDirectories: true)
    } catch {
        errorExit("cannot create --out directory: \(error.localizedDescription)")
    }

    // Resolve what to capture before touching ScreenCaptureKit, so every refusal names its cause.
    var windowTarget: (id: CGWindowID, bounds: CGRect)?
    var display: DisplayGeometry?
    var sourceRect: CGRect?
    switch options.mode {
    case "window":
        let target = resolveRecordWindow(options)
        windowTarget = target
        display = displayContaining(CGPoint(x: target.bounds.midX, y: target.bounds.midY))
    case "region":
        guard let region = options.region else { errorExit("region mode needs --region x,y,w,h") }
        guard let found = displayContaining(CGPoint(x: region.midX, y: region.midY)) else {
            errorExit("no display contains the region")
        }
        display = found
        sourceRect = CGRect(x: region.minX - found.bounds.minX, y: region.minY - found.bounds.minY,
                            width: region.width, height: region.height)
    default:
        display = displayForScreenIndex(options.screenIndex ?? 0)
    }
    guard let display else { errorExit("no display for the capture target") }

    let content: SCShareableContent
    do {
        content = try awaitResult { try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
    } catch {
        errorExit("ScreenCaptureKit refused to enumerate content: \(error.localizedDescription)")
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
            errorExit("display \(display.id) is not shareable")
        }
        filter = SCContentFilter(display: scDisplay, excludingWindows: [])
        pointSize = sourceRect?.size ?? display.bounds.size
    }
    let configuration = SCStreamConfiguration()
    // Round DOWN to even here, not later in prepareVideo: h264 needs even dimensions, and an
    // odd capture size used to mean SCStream delivered an odd CVPixelBuffer while the writer had
    // been configured one pixel smaller. The adaptor then refused every append and only a
    // generic writer-status warning said so.
    let width = max(2, Int((pointSize.width * display.scale).rounded()) & ~1)
    let height = max(2, Int((pointSize.height * display.scale).rounded()) & ~1)
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

    let recorder = NativeRecorder(options: options, configuration: configuration)
    do {
        try recorder.prepareVideo(width: width, height: height)
    } catch {
        errorExit("cannot open --video-out: \(error.localizedDescription)")
    }
    let stream = SCStream(filter: filter, configuration: configuration, delegate: recorder)
    recorder.stream = stream
    do {
        try stream.addStreamOutput(recorder, type: .screen, sampleHandlerQueue: recorder.frameQueue)
        try awaitResult { try await stream.startCapture() }
    } catch {
        errorExit("recording never started: \(error.localizedDescription)")
    }
    let started = Date()
    _ = recorder.stopped.wait(timeout: .now() + options.duration)
    do {
        try awaitResult { try await stream.stopCapture() }
    } catch {
        recorder.frameQueue.sync {}
    }
    // Drain the frame queue so the last kept frame is on disk before the sheet is built.
    recorder.frameQueue.sync {}
    let durationMs = Int((Date().timeIntervalSince(started) * 1000).rounded())
    recorder.finishVideo()
    if let failure = recorder.failure {
        errorExit("recording stopped early: \(failure.localizedDescription)")
    }

    let outURL = URL(fileURLWithPath: options.outDir)
    let frames: [[String: Any]] = recorder.kept.map { frame in
        ["index": frame.index - 1, "file": frame.file, "path": outURL.appendingPathComponent(frame.file).path,
         "timestampMs": frame.timestampMs, "changePercent": (frame.changePercent * 100).rounded() / 100,
         "reason": frame.reason, "captureEngine": "ScreenCaptureKit"]
    }
    var sheet: [String: Any] = [:]
    let sheetURL = outURL.appendingPathComponent("contact.png")
    if let layout = writeContactSheet(recorder.kept, in: outURL, to: sheetURL) {
        sheet = ["path": sheetURL.path, "file": "contact.png", "rows": layout.rows, "columns": layout.columns,
                 "thumbSize": [200, 200], "sampledFrameIndexes": layout.sampled]
    }
    var data: [String: Any] = [
        "source": "native", "captureEngine": "ScreenCaptureKit", "scope": options.mode,
        "options": ["mode": options.mode, "duration": options.duration, "activeFps": options.activeFps,
                    "idleFps": options.idleFps, "changeThresholdPercent": options.threshold, "maxFrames": options.maxFrames,
                    "width": width, "height": height, "scaleFactor": display.scale],
        "frames": frames,
        "stats": ["durationMs": durationMs, "capturedFrames": recorder.captured, "keptFrames": recorder.kept.count,
                  "droppedFrames": recorder.captured - recorder.kept.count],
        "warnings": recorder.warnings,
        "sessionDir": options.outDir,
    ]
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
    jsonOutput(["success": true, "ok": true, "data": data])
}

/// Runs one async throwing call to completion from a plain command-line entry point.
private func awaitResult<T>(_ operation: @escaping () async throws -> T) throws -> T {
    let done = DispatchSemaphore(value: 0)
    var outcome: Result<T, Error>?
    Task {
        do {
            outcome = .success(try await operation())
        } catch {
            outcome = .failure(error)
        }
        done.signal()
    }
    done.wait()
    return try outcome!.get()
}
