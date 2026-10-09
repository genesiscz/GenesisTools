import AppKit
import AVFoundation
import CoreImage
import QuartzCore
import ScreenCaptureKit
import SnapshotSupport

let captureClearColor = CGColor(gray: 0, alpha: 0)
let captureOpaqueColor = CGColor(gray: 0, alpha: 1)

struct CaptureSelectionOptions {
    let windowIDs: [CGWindowID]
    let apps: [String]
    let canvas: String
    let outputSize: CGSize?
    let outputScale: CGFloat?
    let transparent: Bool
    let codec: String
    let indicator: Bool

    func dimensions(points: CGSize, nativeScale: CGFloat, video: Bool) -> CGSize {
        let requested = outputSize ?? CGSize(width: (points.width * (outputScale ?? nativeScale)).rounded(),
                                              height: (points.height * (outputScale ?? nativeScale)).rounded())
        guard requested.width >= 2, requested.height >= 2, requested.width <= 16384, requested.height <= 16384 else {
            errorExit("output must be between 2 and 16384 pixels on each axis")
        }
        if video && codec == "h264" {
            if outputSize != nil && (Int(requested.width) % 2 != 0 || Int(requested.height) % 2 != 0) {
                errorExit("H.264 output dimensions must be even; choose ProRes 4444 MOV for odd sizes")
            }
            return CGSize(width: Int(requested.width) & ~1, height: Int(requested.height) & ~1)
        }
        return requested
    }
}

func captureSelectionOptions(mode: String) -> CaptureSelectionOptions {
    var ids: [CGWindowID] = []
    if let raw = argValue("--window-ids") {
        let parts = raw.split(separator: ",", omittingEmptySubsequences: false)
        ids = parts.compactMap { UInt32($0) }
        guard ids.count == parts.count, ids.allSatisfy({ $0 > 0 }) else {
            errorExit("--window-ids requires positive CG window IDs separated by commas")
        }
    }
    let args = CommandLine.arguments
    var apps: [String] = []
    for (index, value) in args.enumerated() where value == "--include-app" {
        guard index + 1 < args.count, !args[index + 1].hasPrefix("--") else {
            errorExit("--include-app needs an app name, bundle ID or PID")
        }
        apps.append(args[index + 1])
    }
    if mode == "isolated" {
        guard !ids.isEmpty || !apps.isEmpty else { errorExit("isolated mode needs --window-ids or --include-app") }
        let singular = ["--app", "--window-id", "--window-title", "--window-index", "--region"]
        guard singular.allSatisfy({ !CommandLine.arguments.contains($0) }) else {
            errorExit("isolated mode uses --window-ids/--include-app, not singular window selectors or --region")
        }
    } else if !ids.isEmpty || !apps.isEmpty || argValue("--canvas") != nil {
        errorExit("--window-ids, --include-app and --canvas require isolated mode")
    }
    let canvas = argValue("--canvas") ?? "crop"
    guard ["crop", "display"].contains(canvas) else { errorExit("--canvas must be crop or display") }
    var size: CGSize?
    if let raw = argValue("--output-size") {
        let raws = raw.split(separator: "x", omittingEmptySubsequences: false)
        let parts = raws.compactMap { Int($0) }
        guard raws.count == 2, parts.count == 2, parts.allSatisfy({ $0 >= 2 && $0 <= 16384 }) else {
            errorExit("--output-size must be WIDTHxHEIGHT in pixels, each from 2 to 16384")
        }
        size = CGSize(width: parts[0], height: parts[1])
    }
    var scale: CGFloat?
    if let raw = argValue("--output-scale") {
        guard size == nil, let number = Double(raw), number.isFinite, number > 0, number <= 8 else {
            errorExit("--output-scale must be greater than 0 and at most 8, and cannot accompany --output-size")
        }
        scale = CGFloat(number)
    }
    let transparent = args.contains("--transparent")
    let codec = argValue("--codec") ?? "h264"
    guard ["h264", "prores4444"].contains(codec) else { errorExit("--codec must be h264 or prores4444") }
    if transparent && !["window", "isolated"].contains(mode) {
        errorExit("--transparent requires window or isolated mode")
    }
    if let video = argValue("--video-out") {
        if transparent && codec != "prores4444" {
            errorExit("Transparent video needs --codec prores4444 and a .mov output; H.264/MP4 has no alpha")
        }
        if codec == "prores4444" && !video.lowercased().hasSuffix(".mov") {
            errorExit("ProRes 4444 needs a .mov output")
        }
    }
    return CaptureSelectionOptions(windowIDs: Array(Set(ids)).sorted(), apps: apps, canvas: canvas,
                                   outputSize: size, outputScale: scale, transparent: transparent,
                                   codec: codec, indicator: !args.contains("--no-indicator"))
}

/// Same nonactivating panel contract as CursorOverlay. Core Animation supplies the pulse;
/// geometry refresh is bounded by the recording session, not a permanent overlay daemon.
private final class RecordingPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class RecordingIndicator {
    private var panels: [NSPanel] = []
    private let enabled: Bool
    init(enabled: Bool) {
        self.enabled = enabled
        _ = NSApplication.shared
        NSApp.setActivationPolicy(.accessory)
    }
    var windowIDs: Set<CGWindowID> { Set(panels.map { CGWindowID($0.windowNumber) }) }
    func update(_ rectangles: [CGRect]) {
        guard enabled else { return }
        while panels.count < rectangles.count {
            let panel = RecordingPanel(contentRect: .zero, styleMask: [.borderless, .nonactivatingPanel],
                                       backing: .buffered, defer: false)
            panel.level = .screenSaver
            panel.isOpaque = false
            panel.backgroundColor = .clear
            panel.hasShadow = false
            panel.ignoresMouseEvents = true
            panel.hidesOnDeactivate = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
            // Exclude by content filter, not sharingType: a separate desktop screenshot can
            // then verify that the visible indicator exists while the movie excludes it.
            panel.sharingType = .readOnly
            let view = NSView()
            view.setAccessibilityElement(false)
            view.wantsLayer = true
            let border = CALayer()
            border.borderColor = NSColor.systemRed.cgColor
            border.borderWidth = 3
            border.cornerRadius = 9
            let pulse = CABasicAnimation(keyPath: "opacity")
            pulse.fromValue = 0.4
            pulse.toValue = 1
            pulse.duration = 0.75
            pulse.autoreverses = true
            pulse.repeatCount = .infinity
            border.add(pulse, forKey: "recording")
            view.layer = border
            panel.contentView = view
            panels.append(panel)
        }
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 0
        for (index, panel) in panels.enumerated() {
            guard index < rectangles.count else { panel.orderOut(nil); continue }
            let rect = rectangles[index].insetBy(dx: -3, dy: -3)
            let frame = CGRect(x: rect.minX, y: primaryTop - rect.maxY, width: rect.width, height: rect.height)
            panel.setFrame(frame, display: true)
            panel.orderFrontRegardless()
        }
    }
    func close() { panels.forEach { $0.orderOut(nil); $0.close() }; panels = [] }
}

/// NSApplication owns real event sources throughout this bounded session. SIGINT/SIGTERM
/// finalize the movie and tear down panels instead of leaving an orphaned recorder.
func runRecordingLoop(duration: Double, refresh: @escaping () -> Bool) -> Bool {
    _ = NSApplication.shared
    var cancelled = false
    func stop() {
        NSApp.stop(nil)
        if let event = NSEvent.otherEvent(with: .applicationDefined, location: .zero, modifierFlags: [],
                                          timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0) {
            NSApp.postEvent(event, atStart: true)
        }
    }
    let deadline = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { _ in stop() }
    let geometry = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in
        if !refresh() { stop() }
    }
    let sources = [SIGINT, SIGTERM].map { value -> DispatchSourceSignal in
        signal(value, SIG_IGN)
        let source = DispatchSource.makeSignalSource(signal: value, queue: .main)
        source.setEventHandler { cancelled = true; stop() }
        source.resume()
        return source
    }
    defer {
        deadline.invalidate()
        geometry.invalidate()
        sources.forEach { $0.cancel() }
    }
    NSApp.run()
    return cancelled
}

private struct SelectedWindow {
    let id: CGWindowID
    let pid: pid_t
    var bounds: CGRect
    let scale: CGFloat
}

private func captureWindowRows() -> [[CFString: Any]] {
    CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] ?? []
}

private func captureWindowBounds(_ row: [CFString: Any]) -> CGRect? {
    guard let bounds = row[kCGWindowBounds] as? NSDictionary else { return nil }
    return CGRect(dictionaryRepresentation: bounds)
}

private struct SourceFrame {
    let buffer: CVPixelBuffer
    /// Surface pixels with a top-left origin, as ScreenCaptureKit reports it.
    let contentRect: CGRect?
}

@available(macOS 14.0, *)
// Stream samples, frames, geometry and resize completion are serialized on compositor.queue.
private final class IsolatedWindowSource: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let target: SelectedWindow
    private let filter: SCContentFilter
    private let fps: Double
    lazy var stream = SCStream(filter: filter, configuration: Self.configuration(size: pixelSize, fps: fps), delegate: self)
    weak var compositor: IsolatedCompositor?
    var contentRect: CGRect?
    var nativeScale: CGFloat
    var pixelSize: CGSize
    private var updating = false
    private var configuredFps: Double

    init(target: SelectedWindow, window: SCWindow, fps: Double) {
        self.target = target
        self.nativeScale = target.scale
        self.pixelSize = CGSize(width: max(2, (target.bounds.width * target.scale).rounded()),
                                height: max(2, (target.bounds.height * target.scale).rounded()))
        self.filter = SCContentFilter(desktopIndependentWindow: window)
        self.fps = fps
        self.configuredFps = fps
        super.init()
    }
    static func configuration(size: CGSize, fps: Double) -> SCStreamConfiguration {
        let configuration = SCStreamConfiguration()
        configuration.width = Int(size.width)
        configuration.height = Int(size.height)
        configuration.pixelFormat = kCVPixelFormatType_32BGRA
        configuration.backgroundColor = captureClearColor
        configuration.ignoreShadowsSingleWindow = true
        configuration.scalesToFit = true
        configuration.preservesAspectRatio = false
        configuration.showsCursor = false
        configuration.queueDepth = 3
        configuration.minimumFrameInterval = CMTime(seconds: 1 / fps, preferredTimescale: 600)
        return configuration
    }
    func updateSize(bounds: CGRect, fps: Double) {
        let size = CGSize(width: max(2, (bounds.width * nativeScale).rounded()),
                          height: max(2, (bounds.height * nativeScale).rounded()))
        guard size != pixelSize || fps != configuredFps, !updating else { return }
        updating = true
        let configuration = Self.configuration(size: size, fps: fps)
        Task { [weak self] in
            guard let self else { return }
            do {
                try await stream.updateConfiguration(configuration)
                compositor?.queue.async { self.pixelSize = size; self.configuredFps = fps; self.updating = false }
            } catch {
                compositor?.queue.async { self.compositor?.error = error; self.updating = false }
            }
        }
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[String: Any]],
              let status = attachments.first?[SCStreamFrameInfo.status.rawValue] as? Int,
              SCFrameStatus(rawValue: status) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sample) else { return }
        contentRect = frameInfoRect(attachments.first?[SCStreamFrameInfo.contentRect.rawValue])
        if let scale = attachments.first?[SCStreamFrameInfo.scaleFactor.rawValue] as? CGFloat, scale > 0 {
            nativeScale = scale
        }
        compositor?.receive(SourceFrame(buffer: buffer, contentRect: contentRect), from: target.id)
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        compositor?.queue.async { [weak self] in
            guard let self, let compositor = self.compositor else { return }
            let present = captureWindowRows().contains { ($0[kCGWindowNumber] as? CGWindowID) == self.target.id &&
                ($0[kCGWindowOwnerPID] as? pid_t) == self.target.pid }
            if compositor.layers.streamEnded(id: self.target.id, windowPresent: present) {
                compositor.error = error
            } else {
                compositor.render(force: true)
            }
        }
    }
}

@available(macOS 14.0, *)
private final class IsolatedCompositor {
    let recorder: NativeRecorder
    let options: RecordOptions
    let output: CGSize
    let initialCanvas: CGRect
    let displayCanvas: CGRect?
    let context = CIContext(options: [.cacheIntermediates: false])
    var sources: [IsolatedWindowSource] = []
    var layers: IsolatedLayers<SourceFrame>
    var error: Error?
    var currentFps: Double
    var geometryHistory: [[String: Any]] = []
    private var throttle = RenderThrottle()
    /// Set once the streams have stopped and the last pending content is in the movie.
    private var finished = false
    private var previousCanvas: CGRect?
    private var previousPlacements: [IsolatedLayerPlacement] = []
    private let epoch = CMClockGetTime(CMClockGetHostTimeClock())
    private var pool: CVPixelBufferPool?
    var queue: DispatchQueue { recorder.frameQueue }
    /// Session time of the first composite frame: stream startup before it is not movie time.
    var firstFrameAfterStartMs: Int? { throttle.firstRender.map { Int($0 * 1000) } }

    init(recorder: NativeRecorder, options: RecordOptions, selected: [SelectedWindow], canvas: CGRect, displayCanvas: CGRect?, output: CGSize) {
        self.recorder = recorder
        self.options = options
        self.currentFps = options.activeFps
        self.output = output
        self.initialCanvas = canvas
        self.displayCanvas = displayCanvas
        self.layers = IsolatedLayers(selected.map { IsolatedLayer(id: $0.id, pid: $0.pid, bounds: $0.bounds) })
        CVPixelBufferPoolCreate(nil, nil, [kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                                          kCVPixelBufferWidthKey: Int(output.width), kCVPixelBufferHeightKey: Int(output.height),
                                          kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pool)
    }
    func source(_ id: CGWindowID) -> IsolatedWindowSource? { sources.first { $0.target.id == id } }
    func receive(_ frame: SourceFrame, from id: CGWindowID) {
        layers.receive(frame, for: id)
        render()
    }
    func updateSizes() {
        for layer in layers.layers where layer.visible && !layer.ended {
            source(layer.id)?.updateSize(bounds: layer.bounds, fps: currentFps)
        }
    }
    func render(force: Bool = false) {
        guard error == nil, !finished, layers.readyToRender else { return }
        let timestamp = CMClockGetTime(CMClockGetHostTimeClock())
        let elapsed = CMTimeGetSeconds(CMTimeSubtract(timestamp, epoch))
        switch throttle.request(at: elapsed, interval: 1 / currentFps, force: force) {
        case .coalesced:
            return
        case .schedule(let delay):
            queue.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self, self.throttle.trailingFired() else { return }
                self.render()
            }
            return
        case .render:
            break
        }
        let visible = layers.layers.filter(\.visible)
        let union = visible.reduce(CGRect.null) { $0.union($1.bounds) }
        let canvas = displayCanvas ?? (union.isNull ? initialCanvas : union)
        let geometry = CaptureCanvasGeometry(canvas: canvas, output: output)
        let paints = layers.paintOrder.compactMap { layer -> IsolatedPaint? in
            guard let frame = layer.frame else { return nil }
            return IsolatedPaint(image: CIImage(cvPixelBuffer: frame.buffer), contentRect: frame.contentRect, bounds: layer.bounds)
        }
        let image = composeIsolatedFrame(paints, geometry: geometry, transparent: options.selection.transparent)
        let outputRect = CGRect(origin: .zero, size: output)
        guard let pool else { return }
        var buffer: CVPixelBuffer?
        guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess, let buffer else { return }
        context.render(image, to: buffer, bounds: outputRect, colorSpace: CGColorSpaceCreateDeviceRGB())
        recorder.consume(buffer, timestamp: timestamp)
        layers.markRendered()
        let movieSeconds = throttle.rendered(at: elapsed)
        let placements = layers.geometry
        if canvas != previousCanvas || placements != previousPlacements {
            previousCanvas = canvas
            previousPlacements = placements
            geometryHistory.append([
                // Movie time: the origin kept frames use, so a geometry entry names the frame it describes.
                "timestampMs": Int((movieSeconds * 1000).rounded()), "canvas": captureRectJSON(canvas), "pixelsPerPoint": geometry.scale,
                "windows": visible.map { layer -> [String: Any] in
                    let source = self.source(layer.id)
                    let nativeScale = source?.nativeScale ?? 1
                    let pixelSize = source?.pixelSize ?? .zero
                    return ["id": layer.id, "bounds": captureRectJSON(layer.bounds),
                            "nativeScale": nativeScale, "interpolatedUpscale": geometry.scale > nativeScale,
                            "sourcePixels": ["width": pixelSize.width, "height": pixelSize.height],
                            "sourceContentRect": captureRectJSON(layer.frame?.contentRect ?? CGRect(origin: .zero, size: pixelSize))]
                },
            ])
        }
    }
    /// Runs on the queue after every stream stopped: content that waited for its throttled
    /// frame goes into the movie, and nothing renders after the writer finishes.
    func finish() {
        if throttle.pending {
            render(force: true)
        }
        finished = true
    }
    func refresh(_ rows: [[CFString: Any]]) {
        let windows = rows.compactMap { row -> IsolatedWindowRow? in
            guard let id = row[kCGWindowNumber] as? CGWindowID, let pid = row[kCGWindowOwnerPID] as? pid_t,
                  let bounds = captureWindowBounds(row) else { return nil }
            return IsolatedWindowRow(id: id, pid: pid, bounds: bounds)
        }
        queue.async { [self] in
            let changed = layers.refresh(windows)
            updateSizes()
            render(force: changed)
        }
    }
}

func captureRectJSON(_ rect: CGRect) -> [String: CGFloat] {
    ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height]
}

@available(macOS 13.0, *)
func captureIsolatedWindows(_ options: RecordOptions) {
    guard #available(macOS 14.0, *) else { errorExit("isolated capture requires macOS 14 or newer") }
    let content: SCShareableContent
    do {
        content = try awaitResult { try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true) }
    } catch { errorExit("ScreenCaptureKit cannot enumerate windows: \(error.localizedDescription)") }
    let pids = Set(options.selection.apps.map { resolveAppPid($0) })
    let explicit = Set(options.selection.windowIDs)
    let rows = captureWindowRows()
    let selected = rows.compactMap { row -> SelectedWindow? in
        guard let id = row[kCGWindowNumber] as? CGWindowID, let pid = row[kCGWindowOwnerPID] as? pid_t,
              explicit.contains(id) || pids.contains(pid),
              let bounds = captureWindowBounds(row), bounds.width > 0, bounds.height > 0 else { return nil }
        let shareable = content.windows.first { $0.windowID == id }
        guard let shareable else { return nil }
        let scale = CGFloat(SCContentFilter(desktopIndependentWindow: shareable).pointPixelScale)
        return SelectedWindow(id: id, pid: pid, bounds: bounds, scale: max(1, scale))
    }
    let missing = explicit.subtracting(selected.map(\.id))
    guard missing.isEmpty else { errorExit("selected window IDs are not visible/shareable: \(missing.sorted())") }
    for pid in pids where !selected.contains(where: { $0.pid == pid }) {
        errorExit("selected app PID \(pid) has no visible shareable windows")
    }
    guard !selected.isEmpty, selected.count <= 16 else { errorExit("isolated capture requires 1 to 16 visible selected windows") }
    var displayCanvas: CGRect?
    if options.selection.canvas == "display" {
        let index = options.screenIndex ?? 0
        guard NSScreen.screens.indices.contains(index),
              let id = (NSScreen.screens[index].deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value else {
            errorExit("--screen-index outside the current display list")
        }
        displayCanvas = CGDisplayBounds(id)
    }
    let canvas = displayCanvas ?? selected.reduce(CGRect.null) { $0.union($1.bounds) }
    let nativeScale = selected.map(\.scale).max() ?? 1
    let output = options.selection.dimensions(points: canvas.size, nativeScale: nativeScale, video: options.videoOut != nil)
    let recorder = NativeRecorder(options: options, configuration: SCStreamConfiguration())
    let compositor = IsolatedCompositor(recorder: recorder, options: options, selected: selected, canvas: canvas,
                                        displayCanvas: displayCanvas, output: output)
    recorder.rateChanged = { [weak compositor] fps in
        guard let compositor else { return }
        compositor.currentFps = fps
        compositor.updateSizes()
    }
    let indicator = RecordingIndicator(enabled: options.selection.indicator)
    indicator.update(displayCanvas.map { [$0] } ?? selected.map(\.bounds))
    defer { indicator.close() }
    var startedStreams: [SCStream] = []
    do {
        try recorder.prepareVideo(width: Int(output.width), height: Int(output.height))
        for target in selected {
            guard let window = content.windows.first(where: { $0.windowID == target.id }) else { continue }
            let source = IsolatedWindowSource(target: target, window: window, fps: options.activeFps)
            source.compositor = compositor
            compositor.sources.append(source)
        }
        for source in compositor.sources {
            try source.stream.addStreamOutput(source, type: .screen, sampleHandlerQueue: compositor.queue)
            try awaitResult { try await source.stream.startCapture() }
            startedStreams.append(source.stream)
        }
    } catch {
        for stream in startedStreams { try? awaitResult { try await stream.stopCapture() } }
        indicator.close()
        errorExit("isolated recording never started: \(error.localizedDescription)")
    }
    let started = Date()
    let cancelled = runRecordingLoop(duration: options.duration) {
        let rows = captureWindowRows()
        let bounds = selected.compactMap { target -> CGRect? in
            guard let row = rows.first(where: { ($0[kCGWindowNumber] as? CGWindowID) == target.id &&
                ($0[kCGWindowOwnerPID] as? pid_t) == target.pid }) else { return nil }
            return captureWindowBounds(row)
        }
        indicator.update(displayCanvas.map { [$0] } ?? bounds)
        compositor.refresh(rows)
        return compositor.queue.sync { compositor.error == nil }
    }
    indicator.close()
    for source in compositor.sources {
        if compositor.queue.sync(execute: { compositor.layers.layer(source.target.id)?.ended ?? false }) { continue }
        do { try awaitResult { try await source.stream.stopCapture() } }
        catch { compositor.queue.sync { compositor.error = error } }
    }
    compositor.queue.sync { compositor.finish() }
    let duration = Date().timeIntervalSince(started)
    recorder.finishVideo(stoppedAt: CMClockGetTime(CMClockGetHostTimeClock()))
    if let error = compositor.error { errorExit("isolated recording stopped early: \(error.localizedDescription)") }
    guard !recorder.kept.isEmpty else { errorExit("isolated recording produced no frames") }
    let directory = URL(fileURLWithPath: options.outDir)
    var data: [String: Any] = [
        "source": "native", "captureEngine": "ScreenCaptureKit", "scope": "isolated", "sessionDir": options.outDir,
        "cancelled": cancelled,
        "options": ["canvas": options.selection.canvas, "initialCanvas": captureRectJSON(canvas),
                    "width": Int(output.width), "height": Int(output.height), "nativeScale": nativeScale,
                    "transparent": options.selection.transparent, "codec": options.selection.codec,
                    "indicator": options.selection.indicator, "indicatorCaptured": false,
                    "selectionPolicy": "visible windows pinned at start", "resizePolicy": "follow canvas; aspect fit into fixed output",
                    "windowIds": selected.map(\.id)] as [String: Any],
        "geometry": compositor.geometryHistory,
        "frames": recorder.kept.map { ["index": $0.index - 1, "file": $0.file, "path": directory.appendingPathComponent($0.file).path,
                                       "timestampMs": $0.timestampMs, "changePercent": $0.changePercent, "reason": $0.reason] as [String: Any] },
        "stats": ["durationMs": Int(duration * 1000), "capturedFrames": recorder.captured, "keptFrames": recorder.kept.count,
                  "firstFrameAfterStartMs": compositor.firstFrameAfterStartMs ?? -1] as [String: Any],
        "warnings": recorder.warnings + compositor.queue.sync { compositor.layers.warnings },
    ]
    let contact = directory.appendingPathComponent("contact.png")
    if let layout = writeContactSheet(recorder.kept, in: directory, to: contact) {
        data["contactSheet"] = ["path": contact.path, "rows": layout.rows, "columns": layout.columns, "sampledFrameIndexes": layout.sampled]
    }
    if let video = options.videoOut { data["videoOut"] = video }
    do {
        let file = directory.appendingPathComponent("metadata.json")
        try JSONSerialization.data(withJSONObject: data, options: [.sortedKeys, .prettyPrinted]).write(to: file, options: .atomic)
        data["metadataFile"] = file.path
    } catch { errorExit("cannot write recording metadata: \(error.localizedDescription)") }
    jsonOutput(["success": recorder.videoSucceeded, "ok": recorder.videoSucceeded, "data": data])
    if !recorder.videoSucceeded { exit(1) }
}
