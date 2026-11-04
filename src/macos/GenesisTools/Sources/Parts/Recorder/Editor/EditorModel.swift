import AVFoundation
import AppKit
import Observation
import UniformTypeIdentifiers

/// The playhead, kept apart from the model so that only the views that show the time re-render 30 times a second
/// while a movie plays (the transport's clock and the timeline's red line), never the inspector or the lanes.
@MainActor
@Observable
final class PlayheadClock {
    var outUs: Int64 = 0
}

/// One selection for the whole editor, so ⌫, Esc, the lanes and the inspector agree on what is selected.
enum EditorSelection: Equatable {
    case none
    case clip(String)
    case zoom(String)
    case redaction(String)
    case text(String)
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case zoom, clip, hide, text, style, cursor, captions, audio, export
    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .zoom: "plus.magnifyingglass"
        case .clip: "film"
        case .hide: "eye.slash"
        case .text: "textformat"
        case .style: "paintpalette"
        case .cursor: "cursorarrow.rays"
        case .captions: "captions.bubble"
        case .audio: "speaker.wave.2"
        case .export: "square.and.arrow.up"
        }
    }

    var title: String {
        switch self {
        case .zoom: "Zoom"
        case .clip: "Clips"
        case .hide: "Hide Parts"
        case .text: "Text"
        case .style: "Style"
        case .cursor: "Cursor and Clicks"
        case .captions: "Captions and Shortcuts"
        case .audio: "Audio"
        case .export: "Export"
        }
    }
}

@MainActor
@Observable
final class EditorModel {
    private(set) var project: EditProject
    let store: ProjectStore
    let clock = PlayheadClock()
    let filmstrip = Filmstrip()
    let waveform = Waveform()
    @ObservationIgnored let player = AVPlayer()
    @ObservationIgnored let zoom: ZoomState
    @ObservationIgnored private var asset: AVURLAsset
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var renderTask: Task<Void, Never>?
    @ObservationIgnored private var undoStack: [EditProject] = []
    @ObservationIgnored private var redoStack: [EditProject] = []
    @ObservationIgnored let cursor: CursorTrack?

    var selection: EditorSelection = .none
    var tab: InspectorTab = .zoom
    private(set) var isPlaying = false
    private(set) var canUndo = false
    private(set) var canRedo = false
    /// True after a change this window has not saved yet.
    private(set) var edited = false
    var exportProgress: Double?
    var notice: String?
    var noticeIsError = false
    /// A `tools recorder apply` step runs (Remove Still Parts); its button shows progress and does not start another.
    private(set) var isRemovingIdle = false
    /// `tools recorder apply` measures the loudness (Normalize).
    private(set) var isNormalizing = false
    /// `tools transcribe` runs for the captions.
    private(set) var isTranscribing = false
    /// The movie has a cached transcript, so captions can be drawn.
    private(set) var hasTranscript = false
    /// Pixels of the timeline per second; the transport's slider sets it.
    var pointsPerSecond: Double = 0

    init(project: EditProject, store: ProjectStore) {
        self.project = project
        self.store = store
        cursor = CursorTrack.load(project.source.cursor)
        zoom = ZoomState(project: project, cursor: cursor)
        hasTranscript = zoom.hasCaptions
        markers = Self.readMarkers(video: project.source.video)
        asset = AVURLAsset(url: URL(fileURLWithPath: project.source.video))
        player.actionAtItemEnd = .pause
        let interval = CMTime(value: 1, timescale: 30)
        timeObserver = player.addPeriodicTimeObserver(forInterval: interval, queue: .main) { [weak self] time in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.clock.outUs = Int64((time.seconds * 1_000_000).rounded())
                self.isPlaying = self.player.rate != 0
            }
        }
        store.onExternalChange = { [weak self] next in self?.adoptExternal(next) }
        store.watch()
        let video = URL(fileURLWithPath: project.source.video)
        filmstrip.load(video: video, durationUs: project.source.durationUs)
        waveform.load(video: video)
        rebuild()
    }

    /// The recording's title from its manifest (the name the library shows), else its folder's name, else the file's.
    var title: String { Self.readTitle(video: project.source.video) }

    static func readTitle(video: String) -> String {
        let url = URL(fileURLWithPath: video)
        let folder = url.deletingLastPathComponent()
        guard let data = try? Data(contentsOf: folder.appendingPathComponent("recording.json")) else { return url.lastPathComponent }
        let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let title = root?["title"] as? String, !title.trimmingCharacters(in: .whitespaces).isEmpty { return title }
        return folder.lastPathComponent
    }
    var durationUs: Int64 { project.outputDurationUs }

    // MARK: - Playback

    func togglePlay() {
        if player.rate != 0 {
            player.pause()
            logPlayback()
        } else {
            if clock.outUs >= durationUs - 20_000 { seek(0) }
            playStart = (Date(), clock.outUs, zoom.framesDrawn)
            player.play()
        }
        isPlaying = player.rate != 0
    }

    /// J, K and L, as in every editor: L plays and each press doubles the speed (up to 4×), K pauses, J plays backwards
    /// when the movie can (each press doubles too) and otherwise steps back a second.
    func shuttle(_ key: Character) {
        switch key {
        case "k":
            if player.rate != 0 { togglePlay() }
        case "l":
            if player.rate <= 0 {
                if player.rate < 0 { player.pause() }
                togglePlay()
            } else {
                player.rate = min(4, player.rate * 2)
            }
        case "j":
            if player.currentItem?.canPlayReverse == true {
                player.rate = player.rate < 0 ? max(-4, player.rate * 2) : -1
            } else {
                player.pause()
                seek(max(0, clock.outUs - 1_000_000))
            }
        default:
            return
        }
        isPlaying = player.rate != 0
    }

    /// When the current playback started: the wall clock, the output time and the renderer's frame count.
    @ObservationIgnored private var playStart: (date: Date, outUs: Int64, frames: Int)?

    /// How smooth the run that just paused played: the frames the renderer drew against the frames its stretch of
    /// the edit holds at the composition's rate, and how far the playhead ran against the wall clock. A composition
    /// item has no access log, so the counts are the renderer's own. Read with
    /// `rg recorder.editor.playback ~/.genesis-tools/logs/app-perf.log`.
    private func logPlayback() {
        guard let start = playStart else { return }
        playStart = nil
        let wall = Date().timeIntervalSince(start.date)
        let played = Double(clock.outUs - start.outUs) / 1_000_000
        guard wall > 0.2, played > 0 else { return }
        let frame = player.currentItem?.videoComposition?.frameDuration.seconds ?? 0
        let fps = frame > 0 ? 1 / frame : 60
        let drawn = zoom.framesDrawn - start.frames
        let expected = Int((played * fps).rounded())
        let looks = [project.frame != nil ? "frame" : nil, project.cursor?.show != false ? "cursor" : nil,
                     project.captions?.show == true ? "captions" : nil, project.keys?.show == true ? "keys" : nil,
                     (project.redactions?.isEmpty == false) ? "\(project.redactions?.count ?? 0) redactions" : nil].compactMap { $0 }
        HubPerf.log("recorder.editor.playback played \(String(format: "%.1f", played)) s in \(String(format: "%.1f", wall)) s, drew \(drawn) of \(expected) frames (\(String(format: "%.0f", Double(drawn) / max(0.1, wall))) fps), \(project.source.width)×\(project.source.height) source, \(project.zooms.count) zooms, looks: \(looks.isEmpty ? "none" : looks.joined(separator: ", "))")
    }

    func seek(_ outUs: Int64) {
        let clamped = min(max(0, outUs), durationUs)
        clock.outUs = clamped
        player.seek(to: EditRenderer.us(clamped), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    func step(frames: Int) {
        player.pause()
        seek(clock.outUs + Int64(frames) * 16_667)
    }

    // MARK: - Edits

    /// Every change goes through here: one undo step, the zoom filter told, the movie rebuilt when clips or
    /// audio changed (zooms need no rebuild), and a save a moment later.
    func apply(_ next: EditProject, rebuildMovie: Bool) {
        guard next != project else { return }
        undoStack.append(project)
        if undoStack.count > 200 { undoStack.removeFirst() }
        redoStack.removeAll()
        commit(next, rebuildMovie: rebuildMovie)
    }

    private func commit(_ next: EditProject, rebuildMovie: Bool) {
        project = next
        zoom.update(next)
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
        edited = true
        if rebuildMovie {
            rebuild()
        } else {
            refreshFrame()
        }
        scheduleSave()
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        redoStack.append(project)
        commit(previous, rebuildMovie: previous.clips != project.clips || previous.audio != project.audio)
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        undoStack.append(project)
        commit(next, rebuildMovie: next.clips != project.clips || next.audio != project.audio)
    }

    /// The scale at which the whole edit fits the timeline's width; the timeline keeps it current.
    @ObservationIgnored var fittedPointsPerSecond: Double = 100

    /// The timeline's scale times `factor`, from the fitted scale when it is at Fit (0); back below Fit is Fit.
    func zoomTimeline(by factor: Double) {
        let fitted = fittedPointsPerSecond
        let current = pointsPerSecond > 0 ? pointsPerSecond : fitted
        let next = min(400, max(10, current * factor))
        pointsPerSecond = factor < 1 && next <= fitted ? 0 : next
    }

    func splitAtPlayhead() {
        guard let next = TimelineMap.split(project, atOutput: clock.outUs) else {
            show("Nothing to split here: the playhead is at the edge of a clip.", error: false)
            return
        }
        apply(next, rebuildMovie: true)
    }

    func deleteSelection() {
        switch selection {
        case let .clip(id):
            guard let next = TimelineMap.delete(project, clip: id) else {
                show("The last clip cannot be deleted.", error: false)
                return
            }
            selection = .none
            apply(next, rebuildMovie: true)
        case let .zoom(id):
            var next = project
            next.zooms.removeAll { $0.id == id }
            selection = .none
            apply(next, rebuildMovie: false)
        case let .redaction(id):
            deleteRedaction(id)
        case let .text(id):
            deleteText(id)
        case .none:
            break
        }
    }

    /// A zoom from the playhead, two seconds long by default, at the last zoom's scale.
    func addZoom(atOutput outUs: Int64? = nil, durationUs: Int64 = 2_000_000) {
        let start = TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project)
        let scale = project.zooms.last?.scale ?? 1.5
        guard let (next, id) = TimelineMap.addZoom(project, startUs: start, endUs: start + durationUs, scale: scale) else {
            show("No room for a zoom here; zooms cannot overlap.", error: false)
            return
        }
        selection = .zoom(id)
        tab = .zoom
        apply(next, rebuildMovie: false)
    }

    /// Corrects a caption line's words (nil drops the fix, "" hides the line), as the `fixLine` op does.
    func fixCaption(_ line: CaptionTrack.Line, text: String?) {
        var next = project
        var settings = next.transcript ?? EditProject.TranscriptSettings()
        let key = EditProject.TranscriptSettings.key(line)
        if let text {
            settings.fixes[key] = String(text.prefix(300)).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            settings.fixes[key] = nil
        }
        next.transcript = settings.fixes.isEmpty ? nil : settings
        apply(next, rebuildMovie: false)
    }

    /// A copy of the selected zoom, hidden part or text right after the original, selected (⌘D).
    func duplicateSelection() {
        var next = project
        switch selection {
        case let .zoom(id):
            guard let zoom = project.zooms.first(where: { $0.id == id }),
                  let (added, newID) = TimelineMap.addZoom(project, startUs: zoom.endUs, endUs: zoom.endUs + (zoom.endUs - zoom.startUs), scale: zoom.scale) else {
                show("No room after this zoom for a copy; zooms cannot overlap.", error: false)
                return
            }
            next = added
            if let index = next.zooms.firstIndex(where: { $0.id == newID }) {
                next.zooms[index].mode = zoom.mode
                next.zooms[index].focusX = zoom.focusX
                next.zooms[index].focusY = zoom.focusY
                next.zooms[index].easeInMs = zoom.easeInMs
                next.zooms[index].easeOutMs = zoom.easeOutMs
            }
            selection = .zoom(newID)
        case let .redaction(id):
            guard var copy = project.redactions?.first(where: { $0.id == id }) else { return }
            let length = copy.endUs - copy.startUs
            copy.id = "r" + UUID().uuidString.prefix(8).lowercased()
            copy.startUs = min(copy.endUs, project.source.durationUs - 100_000)
            copy.endUs = min(project.source.durationUs, copy.startUs + length)
            next.redactions = (next.redactions ?? []) + [copy]
            selection = .redaction(copy.id)
        case let .text(id):
            guard var copy = project.texts?.first(where: { $0.id == id }) else { return }
            let length = copy.endUs - copy.startUs
            copy.id = "t" + UUID().uuidString.prefix(8).lowercased()
            copy.startUs = min(copy.endUs, project.source.durationUs - 100_000)
            copy.endUs = min(project.source.durationUs, copy.startUs + length)
            next.texts = (next.texts ?? []) + [copy]
            selection = .text(copy.id)
        case .clip, .none:
            show("Select a zoom, a hidden part or a text to duplicate it.", error: false)
            return
        }
        apply(next, rebuildMovie: false)
    }

    /// The redaction the Hide tab edits: the `.redaction` case of the one selection.
    var selectedRedaction: String? {
        get { if case let .redaction(id) = selection { id } else { nil } }
        set {
            if let newValue {
                selection = .redaction(newValue)
            } else if selectedRedaction != nil {
                selection = .none
            }
        }
    }

    /// The text the Text tab edits: the `.text` case of the one selection.
    var selectedText: String? {
        get { if case let .text(id) = selection { id } else { nil } }
        set {
            if let newValue {
                selection = .text(newValue)
            } else if selectedText != nil {
                selection = .none
            }
        }
    }

    /// A text at the top middle for 3 s from the playhead; the Text tab then writes and places it.
    func addText(_ text: String = "Title") {
        let start = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        let end = min(project.source.durationUs, start + 3_000_000)
        guard end - start >= 100_000 else {
            show("The playhead is at the end of the recording; move it back to add a text.", error: false)
            return
        }
        let id = "t" + UUID().uuidString.prefix(8).lowercased()
        var next = project
        next.texts = (next.texts ?? []) + [EditProject.TextNote(id: id, startUs: start, endUs: end, text: text)]
        selectedText = id
        tab = .text
        apply(next, rebuildMovie: false)
    }

    func updateText(_ id: String, _ change: (inout EditProject.TextNote) -> Void) {
        guard var list = project.texts, let index = list.firstIndex(where: { $0.id == id }) else { return }
        change(&list[index])
        list[index].x = min(max(0, list[index].x), 1)
        list[index].y = min(max(0, list[index].y), 1)
        list[index].size = min(max(0.02, list[index].size), 0.15)
        list[index].endUs = max(list[index].startUs + 100_000, min(project.source.durationUs, list[index].endUs))
        var next = project
        next.texts = list
        apply(next, rebuildMovie: false)
    }

    func deleteText(_ id: String) {
        var next = project
        next.texts = (next.texts ?? []).filter { $0.id != id }
        if next.texts?.isEmpty == true { next.texts = nil }
        if selectedText == id { selectedText = nil }
        apply(next, rebuildMovie: false)
    }

    /// How the source picture maps onto the canvas at the playhead: the zoom there and the frame (for the preview's
    /// hidden-part handles).
    func sourceToCanvas(atOutput outUs: Int64) -> Looks.SourceToCanvas {
        let sourceUs = TimelineMap.sourceTime(atOutput: outUs, in: project)
        let view = ZoomCurve.view(atSource: sourceUs, zooms: project.zooms, cursor: cursor)
        let sizes = EditRenderer.outputSizes(source: CGSize(width: project.source.width, height: project.source.height),
                                             maxHeight: 0, aspect: project.frame?.aspect)
        let focus = ZoomState.coverFocus(atSourceUs: sourceUs, project: project, track: cursor, view: view)
        return Looks.sourceToCanvas(view: view, frame: project.frame, picture: sizes.picture, canvas: sizes.canvas, coverFocus: focus)
    }

    /// The moments marked while it recorded (`recording.json` settings.markers), at source microseconds.
    private(set) var markers: [(us: Int64, label: String)] = []

    /// Reads the markers the recorder wrote into the recording's manifest; a plain movie has none.
    static func readMarkers(video: String) -> [(us: Int64, label: String)] {
        let manifest = URL(fileURLWithPath: video).deletingLastPathComponent().appendingPathComponent("recording.json")
        guard let data = try? Data(contentsOf: manifest),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let list = (root["settings"] as? [String: Any])?["markers"] as? [[String: Any]] else { return [] }
        return list.compactMap { row in
            guard let ms = (row["atMs"] as? NSNumber)?.doubleValue, let label = row["label"] as? String else { return nil }
            return (Int64(ms * 1000), label)
        }
    }

    /// The part to export, in output microseconds (I and O at the playhead); not saved, so the edit stays whole.
    var partInUs: Int64?
    var partOutUs: Int64?

    /// The marked part, the missing end being the edit's start or end; nil when no mark is set or it is empty.
    var exportPart: (fromUs: Int64, toUs: Int64)? {
        guard partInUs != nil || partOutUs != nil else { return nil }
        let from = min(partInUs ?? 0, durationUs), to = min(partOutUs ?? durationUs, durationUs)
        return to - from >= TimelineMap.minimumClipUs ? (from, to) : nil
    }

    func markIn() {
        partInUs = clock.outUs
        if let out = partOutUs, out <= clock.outUs { partOutUs = nil }
        show("The part starts at \(formatClock(clock.outUs, tenths: true)); O sets its end.", error: false)
    }

    func markOut() {
        partOutUs = clock.outUs
        if let start = partInUs, start >= clock.outUs { partInUs = nil }
        show("The part ends at \(formatClock(clock.outUs, tenths: true)); the export writes only the part.", error: false)
    }

    func clearPart() {
        partInUs = nil
        partOutUs = nil
    }

    /// Hides a part of the picture (the middle, or a rectangle drawn on the preview, 0...1 of the source) for 3 s from
    /// the playhead; the Hide tab then moves and sizes it.
    func addRedaction(rect: CGRect = CGRect(x: 0.35, y: 0.42, width: 0.3, height: 0.16)) {
        let start = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        let end = min(project.source.durationUs, start + 3_000_000)
        guard end - start >= 100_000 else {
            show("The playhead is at the end of the recording; move it back to hide a part.", error: false)
            return
        }
        let id = "r" + UUID().uuidString.prefix(8).lowercased()
        var next = project
        let clamped = rect.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
        guard !clamped.isNull, clamped.width >= 0.01, clamped.height >= 0.01 else { return }
        next.redactions = (next.redactions ?? []) + [EditProject.Redaction(id: id, startUs: start, endUs: end, x: clamped.minX, y: clamped.minY,
                                                                           width: clamped.width, height: clamped.height)]
        selectedRedaction = id
        tab = .hide
        apply(next, rebuildMovie: false)
    }

    func updateRedaction(_ id: String, _ change: (inout EditProject.Redaction) -> Void) {
        guard var list = project.redactions, let index = list.firstIndex(where: { $0.id == id }) else { return }
        change(&list[index])
        let item = list[index]
        list[index].width = min(max(0.01, item.width), 1)
        list[index].height = min(max(0.01, item.height), 1)
        list[index].x = min(max(0, item.x), 1 - list[index].width)
        list[index].y = min(max(0, item.y), 1 - list[index].height)
        list[index].endUs = max(list[index].startUs + 100_000, min(project.source.durationUs, list[index].endUs))
        var next = project
        next.redactions = list
        apply(next, rebuildMovie: false)
    }

    func deleteRedaction(_ id: String) {
        var next = project
        next.redactions = (next.redactions ?? []).filter { $0.id != id }
        if next.redactions?.isEmpty == true { next.redactions = nil }
        if selectedRedaction == id { selectedRedaction = nil }
        apply(next, rebuildMovie: false)
    }

    func updateZoom(_ id: String, _ change: (inout EditProject.Zoom) -> Void) {
        guard let index = project.zooms.firstIndex(where: { $0.id == id }) else { return }
        var next = project
        change(&next.zooms[index])
        next.zooms[index].scale = min(4, max(1, next.zooms[index].scale))
        next.zooms[index].focusX = min(1, max(0, next.zooms[index].focusX))
        next.zooms[index].focusY = min(1, max(0, next.zooms[index].focusY))
        apply(next, rebuildMovie: false)
    }

    func applyScaleToAll(_ scale: Double) {
        var next = project
        for index in next.zooms.indices { next.zooms[index].scale = scale }
        apply(next, rebuildMovie: false)
    }

    func moveZoom(_ id: String, startUs: Int64, endUs: Int64) {
        guard let next = TimelineMap.moveZoom(project, zoom: id, startUs: startUs, endUs: endUs) else { return }
        apply(next, rebuildMovie: false)
    }

    func trimClip(_ id: String, fromUs: Int64? = nil, toUs: Int64? = nil) {
        guard let next = TimelineMap.trim(project, clip: id, fromUs: fromUs, toUs: toUs) else { return }
        apply(next, rebuildMovie: true)
    }

    func setSpeed(_ id: String, _ speed: Double) {
        guard let next = TimelineMap.setSpeed(project, clip: id, speed: speed) else { return }
        apply(next, rebuildMovie: true)
    }

    func setAudio(_ change: (inout EditProject.AudioSettings) -> Void) {
        var next = project
        change(&next.audio)
        next.audio.volume = min(2, max(0, next.audio.volume))
        apply(next, rebuildMovie: true)
    }

    /// The looks (frame and click highlight): drawn per frame from the project, so no movie rebuild.
    func setLooks(_ change: (inout EditProject) -> Void) {
        var next = project
        change(&next)
        apply(next, rebuildMovie: false)
    }

    /// The frame on a picture: the file must decode as an image, or the frame keeps its background.
    func setBackgroundImage(_ url: URL) {
        guard CIImage(contentsOf: url) != nil else {
            show("\(url.lastPathComponent) is not a picture this Mac can read.", error: true)
            return
        }
        setLooks { project in
            var frame = project.frame ?? EditProject.Frame()
            frame.background.kind = .image
            frame.background.image = url.path
            project.frame = frame
        }
    }

    func useDesktopPicture() {
        guard let screen = NSScreen.main, let url = NSWorkspace.shared.desktopImageURL(for: screen) else {
            show("The desktop picture is not available.", error: true)
            return
        }
        // A dynamic desktop can be a folder; its first picture stands in for it.
        var isFolder: ObjCBool = false
        if FileManager.default.fileExists(atPath: url.path, isDirectory: &isFolder), isFolder.boolValue {
            let pictures = (try? FileManager.default.contentsOfDirectory(at: url, includingPropertiesForKeys: nil)) ?? []
            guard let first = pictures.sorted(by: { $0.lastPathComponent < $1.lastPathComponent })
                .first(where: { ["heic", "jpg", "jpeg", "png"].contains($0.pathExtension.lowercased()) }) else {
                show("The desktop picture is a folder without pictures.", error: true)
                return
            }
            setBackgroundImage(first)
            return
        }
        setBackgroundImage(url)
    }

    func chooseBackgroundImage() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.image]
        panel.canChooseDirectories = false
        panel.message = "A picture for the frame's background"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        setBackgroundImage(url)
    }

    /// The drawn cursor's settings; a project without them starts from the defaults.
    func setCursor(_ change: (inout EditProject.Cursor) -> Void) {
        setLooks { project in
            var cursor = project.cursor ?? EditProject.Cursor()
            change(&cursor)
            project.cursor = cursor
        }
    }

    /// A save panel for the export's file, starting at the current one; the choice goes into `export.output`.
    func chooseExportFile() {
        let format = project.export.format ?? .mp4
        let current = EditExporter.outputURL(for: project, format: format)
        let panel = NSSavePanel()
        panel.title = "Export to"
        panel.nameFieldStringValue = current.lastPathComponent
        panel.directoryURL = current.deletingLastPathComponent()
        panel.allowedContentTypes = [UTType(filenameExtension: format.rawValue) ?? .movie]
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let url = panel.url else { return }
        setExport { $0.output = url.path }
        HubPerf.log("recorder.export: output set to \(url.path)")
    }

    func setExport(_ change: (inout EditProject.ExportSettings) -> Void) {
        var next = project
        change(&next.export)
        apply(next, rebuildMovie: false)
    }

    /// One zoom on every click of the cursor track: clicks closer than 3 s share a zoom, which starts 0.6 s before
    /// its first click and holds 1.6 s after its last. Replaces earlier auto zooms and keeps the manual ones.
    func autoZoom() {
        guard let cursor, !cursor.clicks.isEmpty else {
            show("This recording has no clicks to zoom on (no cursor track).", error: false)
            return
        }
        var groups: [[CursorTrack.Sample]] = []
        for click in cursor.clicks {
            if let last = groups.last?.last, click.ms - last.ms < 3000 {
                groups[groups.count - 1].append(click)
            } else {
                groups.append([click])
            }
        }
        // Auto zoom replaces the zooms an earlier auto zoom made and keeps the manual ones; a group that would overlap a
        // manual zoom is left out (the same rule as src/utils/recording-editor/project.ts).
        let manual = project.zooms.filter { $0.mode == .manual }
        var next = project
        let added = groups.map { group in
            let first = group.first!.ms, last = group.last!.ms
            return EditProject.Zoom(
                id: EditProject.newID("z"),
                startUs: Int64(max(0, first - 600) * 1000),
                endUs: min(project.source.durationUs, Int64((last + 1600) * 1000)),
                scale: project.zooms.first?.scale ?? 1.6, mode: .follow,
                focusX: group.map(\.x).reduce(0, +) / Double(group.count),
                focusY: group.map(\.y).reduce(0, +) / Double(group.count)
            )
        }
        let free = added.filter { zoom in !manual.contains { zoom.startUs < $0.endUs && zoom.endUs > $0.startUs } }
        next.zooms = (manual + free).sorted { $0.startUs < $1.startUs }
        apply(next, rebuildMovie: false)
        let skipped = added.count - free.count
        show("Added \(Plural.count(free.count, "zoom")) from \(Plural.count(cursor.clicks.count, "click"))"
            + (skipped > 0 ? "; \(skipped) overlapped a manual zoom and were left out." : "."), error: false)
    }

    // MARK: - Movie

    private func rebuild() {
        renderTask?.cancel()
        let project = project
        let asset = asset
        let zoom = zoom
        let keep = clock.outUs
        renderTask = Task { [weak self] in
            let span = HubPerf.begin("recorder.editor.render", "\(project.clips.count) clips")
            do {
                // The preview renders at most 1440 pixels high: a 4K source costs a quarter of the work per frame.
                let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: zoom, maxHeight: 1440)
                span.end()
                guard !Task.isCancelled, let self else { return }
                let item = AVPlayerItem(asset: rendered.composition)
                item.videoComposition = rendered.videoComposition
                item.audioMix = rendered.audioMix
                self.player.replaceCurrentItem(with: item)
                self.seek(min(keep, self.durationUs))
            } catch {
                span.end()
                self?.show("The preview could not be built: \(error.localizedDescription)", error: true)
            }
        }
    }

    /// A paused player draws a changed zoom only when asked for the frame again.
    private func refreshFrame() {
        guard player.rate == 0 else { return }
        player.seek(to: EditRenderer.us(clock.outUs), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    // MARK: - Saving

    private func scheduleSave() {
        saveTask?.cancel()
        saveTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            self?.saveNow()
        }
    }

    func saveNow() {
        do {
            project = try store.save(project)
            edited = false
        } catch {
            show("The edit was not saved: \(error.localizedDescription)", error: true)
        }
    }

    /// An agent changed the edit file: its version replaces this one, and this one stays one undo away.
    private func adoptExternal(_ next: EditProject) {
        guard next != project else { return }
        undoStack.append(project)
        redoStack.removeAll()
        let rebuildMovie = next.clips != project.clips || next.audio != project.audio
        project = next
        zoom.update(next)
        // An agent that transcribed the movie and turned captions on: read the transcript it cached.
        if next.captions != nil, !hasTranscript { hasTranscript = zoom.reloadCaptions() }
        canUndo = true
        canRedo = false
        if rebuildMovie { rebuild() } else { refreshFrame() }
        show("The edit changed on disk (\(next.updatedBy ?? "another process")); ⌘Z brings this version back.", error: false)
    }

    /// Cuts every still and silent stretch with `tools recorder apply … removeIdle` (ffmpeg's freeze and silence
    /// detection run there); the file watcher brings the result in, one ⌘Z away like any agent edit.
    /// Transcribes the movie once into `<stem>.transcript.json` (the cache the REPL's transcript() reads too) and
    /// turns the captions on. The first run may ask for the AI vault key in this app.
    func transcribe() {
        guard !isTranscribing else { return }
        isTranscribing = true
        show("Transcribing the movie…", error: false)
        let cache = CaptionTrack.cacheURL(video: project.source.video).path
        ToolsRunner.run(["transcribe", project.source.video, "--format", "json", "-o", cache]) { [weak self] status, _, stderr in
            guard let self else { return }
            self.isTranscribing = false
            guard status == 0, self.zoom.reloadCaptions() else {
                let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                self.show("The transcription failed: \(reason)", error: true)
                return
            }
            self.hasTranscript = true
            self.setLooks { $0.captions = $0.captions ?? EditProject.Captions() }
            self.show("Captions are on.", error: false)
        }
    }

    /// Sets the volume so the export reaches -16 LUFS, measured by `tools recorder apply {"op":"normalize"}`.
    func normalizeLoudness() {
        guard !isNormalizing else { return }
        saveTask?.cancel()
        saveNow()
        isNormalizing = true
        show("Measuring the loudness…", error: false)
        ToolsRunner.run(["recorder", "apply", store.url.path, #"{"op":"normalize"}"#]) { [weak self] status, _, stderr in
            guard let self else { return }
            self.isNormalizing = false
            guard status == 0 else {
                let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                self.show("The volume is unchanged: \(reason)", error: true)
                return
            }
            if let data = try? Data(contentsOf: self.store.url), let next = try? EditProject.decode(data) { self.adoptExternal(next) }
            let volume = Int((self.project.audio.volume * 100).rounded())
            self.show(volume >= 200 ? "The volume is at its 200 % limit; the movie is still quieter than -16 LUFS."
                                    : "The volume is \(volume) %, so the export plays at -16 LUFS. ⌘Z undoes it.", error: false)
        }
    }

    /// Cuts the still, silent parts, or with `speed` plays them that much faster (so time is seen to pass).
    func removeIdle(speed: Int? = nil) {
        guard !isRemovingIdle else { return }
        saveTask?.cancel()
        saveNow()
        isRemovingIdle = true
        show("Looking for parts where nothing moves and nothing is heard…", error: false)
        let before = durationUs
        let op = speed.map { #"{"op":"removeIdle","speed":\#($0)}"# } ?? #"{"op":"removeIdle"}"#
        ToolsRunner.run(["recorder", "apply", store.url.path, op]) { [weak self] status, _, stderr in
            guard let self else { return }
            self.isRemovingIdle = false
            guard status == 0 else {
                let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                self.show("Nothing was cut: \(reason)", error: true)
                return
            }
            // The watcher may not have delivered the file yet; read it now so the message has the new length.
            if let data = try? Data(contentsOf: self.store.url), let next = try? EditProject.decode(data) { self.adoptExternal(next) }
            let saved = before - self.durationUs
            let verb = speed.map { "Sped up the still, silent parts \($0)×, saving" } ?? "Removed"
            self.show(saved > 0 ? "\(verb) \(formatClock(saved, tenths: true)) of still, silent parts; ⌘Z brings them back."
                                : "No still, silent part of 2 s or more was found.", error: false)
        }
    }

    // MARK: - Export

    func export() {
        guard exportProgress == nil else { return }
        saveNow()
        let project = project
        if let format = project.export.format, format != .mp4 {
            exportThroughTools(format)
            return
        }
        // A marked part exports a trimmed copy; the edit itself stays whole.
        var rendered = project
        if let part = exportPart, let trimmed = TimelineMap.part(project, fromOut: part.fromUs, toOut: part.toUs) { rendered = trimmed }
        let url = EditExporter.outputURL(for: project)
        exportProgress = 0
        Task { [weak self] in
            do {
                let result = try await EditExporter.export(project: rendered, to: url) { progress in
                    self?.exportProgress = progress
                }
                self?.exportProgress = nil
                HubPerf.log("recorder.export: \(result.url.path) \(ByteFormat.file(result.bytes)) in \(String(format: "%.1f", result.seconds)) s")
                self?.show("Exported \(result.url.lastPathComponent) (\(ByteFormat.file(result.bytes)), \(String(format: "%.1f", result.seconds)) s).", error: false)
                self?.reveal(result.url)
            } catch {
                self?.exportProgress = nil
                HubPerf.log("recorder.export failed: \(error.localizedDescription)")
                self?.show(error.localizedDescription, error: true)
            }
        }
    }

    static let revealAfterExportKey = "recorder.export.revealInFinder"

    /// Off by default: an export puts its file on the clipboard (to paste into a chat or a mail) only when asked.
    static let copyAfterExportKey = "recorder.export.copyToClipboard"

    private func reveal(_ url: URL) {
        if UserDefaults.standard.object(forKey: Self.copyAfterExportKey) as? Bool ?? false {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.writeObjects([url as NSURL])
            HubPerf.log("recorder.export: copied \(url.lastPathComponent) to the clipboard")
        }
        let reveal = UserDefaults.standard.object(forKey: Self.revealAfterExportKey) as? Bool ?? true
        if reveal { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    /// A GIF or WebM: the CLI renders with this same renderer and converts with ffmpeg, then prints `{ ok, path }`.
    private func exportThroughTools(_ format: EditProject.ExportFormat) {
        exportProgress = 0
        show("Exporting a \(format.rawValue.uppercased())…", error: false)
        var argv = ["recorder", "export", store.url.path, "--format", format.rawValue, "--json"]
        if let part = exportPart {
            argv += ["--from", String(format: "%.3f", Double(part.fromUs) / 1_000_000), "--to", String(format: "%.3f", Double(part.toUs) / 1_000_000)]
        }
        ToolsRunner.run(argv) { [weak self] status, stdout, stderr in
            guard let self else { return }
            self.exportProgress = nil
            let answer = (stdout.split(separator: "\n").last.flatMap { $0.data(using: .utf8) })
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            guard status == 0, let path = answer?["path"] as? String else {
                let reason = (answer?["error"] as? String) ?? stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                self.show("The \(format.rawValue.uppercased()) export failed: \(reason)", error: true)
                return
            }
            let bytes = (answer?["bytes"] as? NSNumber)?.int64Value ?? 0
            HubPerf.log("recorder.export: \(path) \(ByteFormat.file(bytes)) as \(format.rawValue)")
            self.show("Exported \(URL(fileURLWithPath: path).lastPathComponent) (\(ByteFormat.file(bytes))).", error: false)
            self.reveal(URL(fileURLWithPath: path))
        }
    }

    func show(_ text: String, error: Bool) {
        notice = text
        noticeIsError = error
    }

    func close() {
        saveTask?.cancel()
        if edited { saveNow() }
        store.stopWatching()
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
    }
}
