import AppKit
import GenesisKitCamera
import SwiftUI

/// The camera bubble beside a recording. With "Camera bubble" on in the capture picker, a round live preview floats
/// where the bubble will sit; it can be dragged before and while recording. A recording that asked for the camera
/// (`settings.camera.requested` in its recording.json, from `--camera`) gets `camera.mov` beside `screen.mp4`, and at
/// its end `camera.json` with where the bubble was, which a new edit takes as its camera bubble.
///
/// The preview shows while it records only when its window id reached the recorder's `--exclude-window-ids` before
/// the movie started: ScreenCaptureKit ignores the panel's sharing type, so a preview the movie did not leave out is
/// baked into it, and every frame, zoom or bubble change then shows two faces. The picker and the Start shortcut put
/// the preview up before the start and pass its id (`previewForStart()`); the recorder service starts the camera with
/// `start(folder:)` (`camera.start`) before the movie's first segment, and its answer names the preview's window,
/// which the recording leaves out. Settings → Recorder → "Show the camera preview" (`CameraPreviewPolicy`) decides
/// whether a start outside the picker (the CLI, an agent) shows it. `stop(folder:)` (`camera.stop`) ends it;
/// `camera.requested` stays the way for a recording that starts while no service host is connected, and such a
/// recording shows no preview unless the picker left it out.
@MainActor
final class CameraBubble {
    static let shared = CameraBubble()

    /// What `start(folder:)` did.
    enum StartAnswer: Equatable {
        /// It records. `windowIDs` is the preview's window while it shows (empty when it does not), which the caller
        /// leaves out of the screen movie with `--exclude-window-ids` from its first segment.
        case started(windowIDs: [Int])
        /// Camera access is off; the alert that explains it follows the answer.
        case denied
        /// The camera already records the folder named.
        case busy(String)
    }

    /// The recording the camera writes for. `byService` ones end on `stop(folder:)`, or when their live entry,
    /// once seen, ends; until it shows up, its absence from the live list means nothing.
    private struct Session {
        let id: String
        let folder: URL
        let target: [String: Any]?
        var byService = false
        var seenLive = false
        /// The capture picker or the Start shortcut started it ("Picker recordings" shows the preview for these).
        var fromPicker = false
        /// The preview's window reached the movie's `--exclude-window-ids`, so the preview may show while it records.
        var previewLeftOut = false
    }

    /// A start the picker or the Start shortcut made, and whether its arguments left the preview out.
    struct PickerStart: Equatable {
        var started = false
        var previewLeftOut = false
    }

    enum Key {
        static let size = "recorder.camera.bubbleSize"
        static let shape = "recorder.camera.shape"
        static let center = "recorder.camera.bubbleCenter"
    }

    static let sizes: [Int] = [140, 200, 260]

    /// The preview's side in points; 200 by default.
    static var bubbleSide: Int {
        let stored = UserDefaults.standard.integer(forKey: Key.size)
        return sizes.contains(stored) ? stored : 200
    }

    static var shape: EditProject.CameraShape {
        UserDefaults.standard.string(forKey: Key.shape).flatMap(EditProject.CameraShape.init(rawValue:)) ?? .circle
    }

    private var source: CameraFrameSource?
    private var panel: CameraBubblePanel?
    private var writer: CameraMovieWriter?
    private var recording: Session?
    /// When the face saw the recording start, before the screen's first frame: camera.json's offset until the
    /// recording replaces it with that frame's time (camera.ts `alignCameraMovie`).
    private var screenStartedAt: Date?
    /// The picker started a camera recording at this time: the next one that asks for the camera is that one.
    private var pickerStart: (at: Date, previewLeftOut: Bool)?
    /// Live recordings already looked at, by id: whether each asked for the camera.
    private var asked: [String: Bool] = [:]
    /// The live entries whose skip is logged already: one line per entry and reason, not one per update.
    private var skipsLogged = Set<String>()

    /// The preview's window, for `--exclude-window-ids`; empty while it is not on screen.
    var windowIDs: [Int] {
        guard let panel, panel.isVisible else { return [] }
        return [panel.windowNumber]
    }

    /// When the preview shows (Settings → Recorder → Camera); read at each use, so a change applies at once.
    var previewPolicy: CameraPreviewPolicy { CameraPreviewPolicy.load() }

    func optionChanged(_ on: Bool) {
        if on, previewPolicy.showsWhilePicking {
            showPreview()
        } else if recording == nil {
            hidePreview()
        }
    }

    /// The preview setting changed in Settings: a running camera recording shows or hides its preview to match.
    func previewPolicyChanged() {
        guard let current = recording else {
            if !previewPolicy.showsWhilePicking { hidePreview() }
            return
        }
        // A preview the movie did not leave out stays off whatever the setting says now: it would be in the movie.
        if previewPolicy.showsPreview(startedByPicker: current.fromPicker, previewLeftOut: current.previewLeftOut) {
            if panel?.isVisible != true { showPreview() }
        } else {
            panel?.orderOut(nil)
        }
    }

    /// The picker closed. `started`: it started a camera recording, whose arguments left the preview's window out
    /// when `previewLeftOut`.
    func pickerClosed(started: Bool, previewLeftOut: Bool = false) {
        if started {
            pickerStart = (Date(), previewLeftOut)
        } else if recording == nil {
            hidePreview()
        }
    }

    func appearanceChanged() {
        panel?.apply(side: CGFloat(Self.bubbleSide), shape: Self.shape)
    }

    func liveRecordingsChanged(_ recordings: [LiveRecording]) {
        if let current = recording {
            let entry = recordings.first { $0.id == current.id || (current.byService && Self.sameFolder($0.folder, current.folder)) }
            guard let entry, !entry.isStopping else {
                if current.byService, !current.seenLive { return }
                finish()
                return
            }
            if current.byService, !current.seenLive {
                recording?.seenLive = true
                // Looked at: when the service stops the camera, this recording does not start it again.
                asked[entry.id] = true
            }
            // The camera keeps recording through a pause and every gap between screen segments: the live state reads
            // "recording" while the next segment still arms, so pausing on it kept up to two seconds per gap. The
            // recording cuts camera.mov to the screen's own spans after it stops (camera.ts `alignCameraMovie`).
            return
        }
        for entry in recordings where asked[entry.id] == nil {
            // Each skip says why, so a recording that asked for the camera and got none can be traced in the log.
            guard entry.isRecording else {
                if skipsLogged.insert("\(entry.id) state").inserted {
                    HubPerf.log("recorder: camera skips \(entry.id) for now: it is not recording yet")
                }
                continue
            }
            guard let folder = entry.folder.map({ URL(fileURLWithPath: $0, isDirectory: true) }) else {
                if skipsLogged.insert("\(entry.id) folder").inserted {
                    HubPerf.log("recorder: camera skips \(entry.id): the live entry names no folder")
                }
                continue
            }
            let manifest = Self.manifestSettings(folder)
            let wants = (manifest?["camera"] as? [String: Any])?["requested"] as? Bool == true
            asked[entry.id] = wants
            if wants {
                begin(entry: entry, folder: folder, target: manifest?["target"] as? [String: Any])
                return
            }
        }
    }

    // MARK: Preview

    private var previewGeneration = 0
    private var recordingGeneration = 0

    private func showPreview() {
        previewGeneration += 1
        let generation = previewGeneration
        Task {
            guard await ensureCameraAccess(), generation == previewGeneration else { return }
            orderPreviewFront()
        }
    }

    /// Puts the preview on screen (camera access is on) and answers its window, for `--exclude-window-ids`.
    @discardableResult
    private func orderPreviewFront() -> [Int] {
        if let panel, panel.isVisible { return [panel.windowNumber] }
        startCamera()
        let panel = panel ?? CameraBubblePanel(source: source!)
        self.panel = panel
        panel.apply(side: CGFloat(Self.bubbleSide), shape: Self.shape)
        panel.place(center: Self.savedCenter() ?? Self.defaultCenter(side: CGFloat(Self.bubbleSide)))
        panel.onMoved = { center in
            UserDefaults.standard.set("\(Int(center.x)),\(Int(center.y))", forKey: Key.center)
        }
        panel.orderFrontRegardless()
        return [panel.windowNumber]
    }

    /// The preview for a start from the picker or the Start shortcut, which opens no picker, so the preview is hidden
    /// then: brought up and answered as its window once it is on screen, so the start leaves it out of the movie.
    /// Empty when the setting is "Never" or camera access is off; such a start shows no preview. The start's own
    /// `camera.start` explains a refusal, so this asks macOS once and shows no alert.
    func previewForStart() async -> [Int] {
        guard previewPolicy.showsPreview(startedByPicker: true, previewLeftOut: true) else { return [] }
        if !windowIDs.isEmpty { return windowIDs }
        previewGeneration += 1
        let generation = previewGeneration
        guard await cameraAccess(), generation == previewGeneration else { return [] }
        return orderPreviewFront()
    }

    private func hidePreview() {
        previewGeneration += 1
        panel?.orderOut(nil)
        if writer == nil { source?.stop() }
    }

    private func startCamera() {
        if source == nil {
            // 720p is plenty for a bubble at most 60% of a 1080p canvas's height, and keeps the encoder light.
            source = CameraFrameSource(preset: .hd1280x720, outputMaxSide: nil)
            // A camera movie with no frames said nothing about why (review 2026-11-06); each state change does now.
            source?.onStateChange = { state in HubPerf.log("recorder: camera source is \(state)") }
        }
        source?.setMode(.continuous(fps: 30))
    }

    private func ensureCameraAccess() async -> Bool {
        if await cameraAccess() { return true }
        explainCameraDenied()
        return false
    }

    /// Asks once when macOS has not asked yet; never shows the alert.
    private func cameraAccess() async -> Bool {
        switch CameraAuthorization.status {
        case .authorized:
            return true
        case .notDetermined:
            NSApp.activate(ignoringOtherApps: true)
            return await CameraAuthorization.request()
        default:
            return false
        }
    }

    private func explainCameraDenied() {
        HubPerf.log("recorder: camera access is \(CameraAuthorization.status.rawValue); no camera bubble")
        let alert = NSAlert()
        alert.messageText = "The camera is off for GenesisTools"
        alert.informativeText = "The camera bubble needs Camera access. Turn it on in System Settings → Privacy & Security → Camera, then turn the bubble on again."
        alert.addButton(withTitle: "Open Camera Settings")
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        if alert.runModal() == .alertFirstButtonReturn { NSWorkspace.shared.open(CameraAuthorization.settingsURL) }
    }

    // MARK: Recording

    /// The face's own watch found a recording that asked for the camera, with no `camera.start` for it yet. Its movie
    /// runs already, so the preview shows only when the picker's arguments left it out.
    private func begin(entry: LiveRecording, folder: URL, target: [String: Any]?) {
        let picker = consumePickerStart()
        recordingGeneration += 1
        let generation = recordingGeneration
        recording = Session(id: entry.id, folder: folder, target: target, fromPicker: picker.started,
                            previewLeftOut: picker.previewLeftOut)
        screenStartedAt = Date()
        let shows = previewPolicy.showsPreview(startedByPicker: picker.started, previewLeftOut: picker.previewLeftOut)
        if !shows { panel?.orderOut(nil) }
        Task {
            let allowed = await ensureCameraAccess()
            guard generation == recordingGeneration else { return }
            guard allowed else {
                recording = nil
                return
            }
            startWriting(id: entry.id, folder: folder, preview: shows)
        }
    }

    /// `camera.start { folder }` from the recorder service, before the recording's first segment: the camera records
    /// `camera.mov` into the folder, as for a recording that asked for it, and the answer names the preview's window,
    /// which the recording leaves out of every segment. The same folder again answers `started`; another folder
    /// `busy`. A refusal answers first and shows the alert after it, so the caller is not held by a modal dialog.
    func start(folder: URL) async -> StartAnswer {
        guard await cameraAccess() else {
            DispatchQueue.main.async { self.explainCameraDenied() }
            return .denied
        }
        if let answer = startedAlready(folder) { return answer }
        let picker = consumePickerStart()
        let target = Self.manifestSettings(folder)?["target"] as? [String: Any]
        let shows = previewPolicy.showsPreview(startedByPicker: picker.started, previewLeftOut: true)
        if !shows { panel?.orderOut(nil) }
        let windowIDs = shows ? orderPreviewFront() : []
        recording = Session(id: "service:\(folder.path)", folder: folder, target: target, byService: true,
                            fromPicker: picker.started, previewLeftOut: !windowIDs.isEmpty)
        screenStartedAt = Date()
        startWriting(id: folder.lastPathComponent, folder: folder, preview: !windowIDs.isEmpty)
        return .started(windowIDs: windowIDs)
    }

    /// The answer for a folder the camera records already, or nil when it records none. The face's watch can begin a
    /// recording just before its `camera.start` arrives; that start still comes before the movie's first segment, so
    /// the preview it held back may show now, and its window goes into the answer.
    private func startedAlready(_ folder: URL) -> StartAnswer? {
        guard let current = recording else { return nil }
        guard Self.sameFolder(current.folder.path, folder) else { return .busy(current.folder.path) }
        guard previewPolicy.showsPreview(startedByPicker: current.fromPicker, previewLeftOut: true) else {
            return .started(windowIDs: windowIDs)
        }
        let shown = orderPreviewFront()
        recording?.previewLeftOut = true
        return .started(windowIDs: shown)
    }

    /// `camera.stop { folder }`: ends the camera of that folder and writes its `camera.json`; false when the camera
    /// did not record it.
    func stop(folder: URL) -> Bool {
        guard let current = recording, Self.sameFolder(current.folder.path, folder) else { return false }
        finish()
        return true
    }

    /// The picker started a camera recording less than two minutes ago: the one starting now is that one.
    private func consumePickerStart() -> PickerStart {
        defer { pickerStart = nil }
        guard let start = pickerStart, Date().timeIntervalSince(start.at) < 120 else { return PickerStart() }
        return PickerStart(started: true, previewLeftOut: start.previewLeftOut)
    }

    /// `preview`: the preview shows while it records; the caller checked that the movie leaves it out.
    private func startWriting(id: String, folder: URL, preview: Bool) {
        startCamera()
        let writer = CameraMovieWriter(url: folder.appendingPathComponent("camera.mov"))
        self.writer = writer
        source?.onFrame = { frame in writer.append(frame) }
        if preview, panel?.isVisible != true { showPreview() }
        let fromPicker = recording?.fromPicker == true
        let leftOut = recording?.previewLeftOut == true
        HubPerf.log("recorder: camera recording for \(id) (preview \(preview ? "on screen" : "off"), "
            + "\(leftOut ? "left out of the movie" : "not left out"), \(fromPicker ? "from the picker" : "started elsewhere"))")
    }

    private static func sameFolder(_ path: String?, _ folder: URL) -> Bool {
        guard let path else { return false }
        return URL(fileURLWithPath: path).standardizedFileURL.path == folder.standardizedFileURL.path
    }

    private func finish() {
        recordingGeneration += 1
        previewGeneration += 1
        guard let current = recording else { return }
        recording = nil
        source?.onFrame = nil
        // A hidden preview still carries the picked shape, size and place into the edit.
        let bubble = panel.flatMap { $0.isVisible ? $0.frame : nil } ?? Self.savedBubble()
        let placement = Self.placement(bubble: bubble, target: current.target)
        let screenStarted = screenStartedAt
        panel?.orderOut(nil)
        guard let writer else {
            source?.stop()
            return
        }
        self.writer = nil
        writer.finish { [weak self] startedAt, frames in
            MainActor.assumeIsolated {
                // The stop answered before this movie finished writing; a recording that started since uses the same
                // camera, so only a camera nobody records with goes off.
                if self?.recording == nil { self?.source?.stop() }
                guard let startedAt else {
                    HubPerf.log("recorder: camera movie for \(current.id) has no frames")
                    return
                }
                Self.writeSidecar(folder: current.folder, startedAt: startedAt, screenStartedAt: screenStarted,
                                  placement: placement)
                HubPerf.log("recorder: camera movie for \(current.id): \(frames) frames")
            }
        }
    }

    // MARK: Files and geometry

    private static func manifestSettings(_ folder: URL) -> [String: Any]? {
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("recording.json")),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return root["settings"] as? [String: Any]
    }

    /// `camera.json` beside the recording (src/utils/recording-editor/camera.ts `cameraSidecarSchema`). `clock` "wall":
    /// the movie runs on, pauses included, so the recording may cut it to the screen's spans.
    static func writeSidecar(folder: URL, startedAt: Date, screenStartedAt: Date?, placement: [String: Any]?) {
        var object: [String: Any] = [
            "version": 1, "file": "camera.mov", "startedAt": ISO8601DateFormatter.withFraction.string(from: startedAt),
            "clock": "wall",
        ]
        if let screenStartedAt { object["screenStartedAt"] = ISO8601DateFormatter.withFraction.string(from: screenStartedAt) }
        if let placement { object["placement"] = placement }
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys]) else { return }
        try? data.write(to: folder.appendingPathComponent("camera.json"), options: .atomic)
    }

    /// Where the bubble sat in what was recorded, as camera.ts's fractions: the centre from the top left and the side
    /// over the short side, plus the shape. Only the shape when the recorded rectangle is not known (an app with no
    /// window on screen); camera.ts takes each key on its own.
    static func placement(bubble: CGRect, target: [String: Any]?) -> [String: Any] {
        let screens = NSScreen.screens
        let primaryHeight = screens.first?.frame.height ?? 0
        let recorded: CGRect?
        switch target?["kind"] as? String {
        case "display" where target?["follow"] as? Bool != true:
            let index = (target?["screenIndex"] as? NSNumber)?.intValue ?? 0
            recorded = screens.indices.contains(index) ? screens[index].frame : nil
        case "region":
            let n = { (key: String) in CGFloat((target?[key] as? NSNumber)?.doubleValue ?? 0) }
            recorded = CGRect(x: n("x"), y: primaryHeight - n("y") - n("height"), width: n("width"), height: n("height"))
        case "window":
            recorded = ((target?["windowIds"] as? [NSNumber])?.first).flatMap { windowFrame(CGWindowID($0.uint32Value), primaryHeight: primaryHeight) }
        case "app":
            let app = (target?["app"] as? String) ?? (target?["app"] as? NSNumber)?.stringValue
            let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
            recorded = app.flatMap { appCanvas(windows: windows ?? [], app: $0, primaryHeight: primaryHeight) }
        default:
            recorded = screens.first { $0.frame.contains(CGPoint(x: bubble.midX, y: bubble.midY)) }?.frame
        }
        return placement(bubble: bubble, recorded: recorded, shape: shape)
    }

    /// Pure, for tests: both rects in Cocoa points (bottom-left origin). Only the shape without a recorded rect.
    nonisolated static func placement(bubble: CGRect, recorded: CGRect?, shape: EditProject.CameraShape) -> [String: Any] {
        guard let recorded, recorded.width > 0, recorded.height > 0 else { return ["shape": shape.rawValue] }
        let clamp = { (value: CGFloat, low: CGFloat, high: CGFloat) in Double(min(high, max(low, value))) }
        return [
            "x": clamp((bubble.midX - recorded.minX) / recorded.width, 0, 1),
            "y": clamp((recorded.maxY - bubble.midY) / recorded.height, 0, 1),
            "size": clamp(bubble.width / min(recorded.width, recorded.height), 0.08, 0.6),
            "shape": shape.rawValue,
        ]
    }

    private static func windowFrame(_ id: CGWindowID, primaryHeight: CGFloat) -> CGRect? {
        guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
              let bounds = list.first?[kCGWindowBounds as String] as? [String: CGFloat],
              let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"], let height = bounds["Height"] else { return nil }
        return CGRect(x: x, y: primaryHeight - y - height, width: width, height: height)
    }

    /// What an app recording records: the union of the app's on-screen windows (layer 0), matched by pid when `app`
    /// is a number, else by owner name as `--app` takes it, flipped into Cocoa points as `windowFrame` does.
    nonisolated static func appCanvas(windows: [[String: Any]], app: String, primaryHeight: CGFloat) -> CGRect? {
        let pid = Int(app)
        let frames = windows.compactMap { window -> CGRect? in
            guard (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0 == 0 else { return nil }
            let owner = pid.map { (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue == $0 }
                ?? ((window[kCGWindowOwnerName as String] as? String)?.caseInsensitiveCompare(app) == .orderedSame)
            guard owner, let bounds = window[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = bounds["X"], let y = bounds["Y"], let width = bounds["Width"], let height = bounds["Height"],
                  width > 0, height > 0 else { return nil }
            return CGRect(x: x, y: primaryHeight - y - height, width: width, height: height)
        }
        return frames.dropFirst().reduce(frames.first) { $0?.union($1) }
    }

    /// The preview's frame from Settings when it is not on screen: the saved side at the saved or default centre.
    private static func savedBubble() -> CGRect {
        let side = CGFloat(bubbleSide)
        let center = savedCenter() ?? defaultCenter(side: side)
        return CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side)
    }

    private static func savedCenter() -> CGPoint? {
        guard let parts = UserDefaults.standard.string(forKey: Key.center)?.split(separator: ",").compactMap({ Double($0) }),
              parts.count == 2 else { return nil }
        let point = CGPoint(x: parts[0], y: parts[1])
        return NSScreen.screens.contains { $0.frame.contains(point) } ? point : nil
    }

    /// The bottom-right corner of the pointer's screen, 40 pt in.
    private static func defaultCenter(side: CGFloat) -> CGPoint {
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        let visible = screen?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        return CGPoint(x: visible.maxX - 40 - side / 2, y: visible.minY + 40 + side / 2)
    }
}

/// The preview's window: borderless, over every app and Space, never the keyboard; a drag anywhere on it moves it.
final class CameraBubblePanel: NSPanel {
    var onMoved: ((CGPoint) -> Void)?
    private let host: CameraBubbleDragView

    init(source: CameraFrameSource) {
        host = CameraBubbleDragView(source: source)
        super.init(contentRect: CGRect(x: 0, y: 0, width: 200, height: 200), styleMask: [.borderless, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        title = "Camera bubble"
        identifier = NSUserInterfaceItemIdentifier("recorder.camera.bubble")
        isFloatingPanel = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        backgroundColor = .clear
        isOpaque = false
        hasShadow = true
        sharingType = .none
        contentView = host
        host.onMoved = { [weak self] in
            guard let self else { return }
            onMoved?(CGPoint(x: frame.midX, y: frame.midY))
        }
    }

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    func apply(side: CGFloat, shape: EditProject.CameraShape) {
        let center = CGPoint(x: frame.midX, y: frame.midY)
        setFrame(CGRect(x: center.x - side / 2, y: center.y - side / 2, width: side, height: side), display: true)
        host.apply(cornerRadius: CameraFeed.cornerRadius(shape, side: side))
        invalidateShadow()
    }

    func place(center: CGPoint) {
        let size = frame.size
        setFrameOrigin(CGPoint(x: (center.x - size.width / 2).rounded(), y: (center.y - size.height / 2).rounded()))
    }
}

/// Holds the live preview and moves its window from each drag event's own location (a `performDrag` moved it only on
/// the first drag of a show); saves the place on mouse-up.
final class CameraBubbleDragView: NSView {
    var onMoved: (() -> Void)?
    private let hosting: NSHostingView<CameraBubblePreview>
    private var grab: CGPoint?

    init(source: CameraFrameSource) {
        hosting = NSHostingView(rootView: CameraBubblePreview(source: source, cornerRadius: 100))
        super.init(frame: CGRect(x: 0, y: 0, width: 200, height: 200))
        hosting.frame = bounds
        hosting.autoresizingMask = [.width, .height]
        addSubview(hosting)
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel("Camera bubble preview. Drag to place it.")
        // The drag view takes every hit, so the hint lives here rather than on the SwiftUI preview.
        toolTip = "Drag to place the camera bubble; the editor draws it here in the movie"
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    func apply(cornerRadius: CGFloat) {
        hosting.rootView = CameraBubblePreview(source: hosting.rootView.source, cornerRadius: cornerRadius)
    }

    override func hitTest(_ point: NSPoint) -> NSView? { frame.contains(point) ? self : nil }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override func resetCursorRects() { addCursorRect(bounds, cursor: .openHand) }

    override func mouseDown(with event: NSEvent) {
        guard let window else { return }
        let pointer = NSEvent.mouseLocation
        grab = CGPoint(x: pointer.x - window.frame.minX, y: pointer.y - window.frame.minY)
        NSCursor.closedHand.push()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let window, let grab else { return }
        let pointer = NSEvent.mouseLocation
        window.setFrameOrigin(CGPoint(x: (pointer.x - grab.x).rounded(), y: (pointer.y - grab.y).rounded()))
    }

    override func mouseUp(with event: NSEvent) {
        guard grab != nil else { return }
        grab = nil
        NSCursor.pop()
        onMoved?()
    }
}

/// The live camera picture in the bubble's shape, mirrored as the person sees themselves, with a thin ring.
struct CameraBubblePreview: View {
    let source: CameraFrameSource
    let cornerRadius: CGFloat

    var body: some View {
        CameraPreviewView(source: source, mirrored: true, cornerRadius: cornerRadius)
            .overlay(RoundedRectangle(cornerRadius: cornerRadius, style: .continuous).strokeBorder(.white.opacity(0.35), lineWidth: 1.5))
    }
}
