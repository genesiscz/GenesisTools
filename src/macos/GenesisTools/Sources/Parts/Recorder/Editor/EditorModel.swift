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
    case shape(String)
}

extension InspectorTab {
    /// ⌘1 to ⌘9 in the rail's order; a tenth tab gets no key.
    var shortcutIndex: Int? {
        guard let index = Self.allCases.firstIndex(of: self), index < 9 else { return nil }
        return index + 1
    }
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case zoom, clip, hide, text, style, cursor, captions, audio, export
    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .zoom: "plus.magnifyingglass"
        case .clip: "film"
        case .hide: "eye.slash"
        case .text: "pencil.and.outline"
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
        case .hide: "Hide and Spotlight"
        case .text: "Annotate"
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
    @ObservationIgnored private var rebuildSoon: DispatchWorkItem?
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
        Task { [weak self] in
            let count = (try? await AVURLAsset(url: video).loadTracks(withMediaType: .audio).count) ?? 0
            self?.audioTrackCount = count
        }
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

    /// The arrow keys: with a shape selected they nudge it by 0.2 % of the picture (⇧: 2 %); otherwise ← and → step
    /// a frame (⇧: a second) and ↑ ↓ do nothing. Esc deselects, which gives the keys back to the frame steps.
    func arrowKey(dx: Int, dy: Int, shift: Bool) {
        if let id = selectedShape {
            let amount = shift ? 0.02 : 0.002
            nudgeShape(id, dx: Double(dx) * amount, dy: Double(dy) * amount)
            return
        }

        if dx != 0 { step(frames: dx * (shift ? 60 : 1)) }
    }

    /// Moves a whole shape, or only its start (`point: 1`) or end (`point: 2`), held inside the picture.
    func nudgeShape(_ id: String, dx: Double, dy: Double, point: Int? = nil) {
        guard let shape = project.shapes?.first(where: { $0.id == id }) else { return }
        let xs = point == 1 ? [shape.x1] : point == 2 ? [shape.x2] : [shape.x1, shape.x2]
        let ys = point == 1 ? [shape.y1] : point == 2 ? [shape.y2] : [shape.y1, shape.y2]
        let mx = min(max(dx, -(xs.min() ?? 0)), 1 - (xs.max() ?? 1))
        let my = min(max(dy, -(ys.min() ?? 0)), 1 - (ys.max() ?? 1))
        updateShape(id) {
            if point != 2 { $0.x1 += mx; $0.y1 += my }
            if point != 1 { $0.x2 += mx; $0.y2 += my }
        }
    }

    // MARK: - Edits

    /// Every change goes through here: one undo step, the zoom filter told, the movie rebuilt when clips or
    /// audio changed (zooms need no rebuild), and a save a moment later.
    func apply(_ next: EditProject, rebuildMovie: Bool) {
        guard next != project else { return }
        // A slider or a drag sends a change per step: steps that change the same parts of the edit less than 0.6 s
        // apart are one undo step, so ⌘Z takes back the whole drag.
        let parts = Self.changedParts(project, next)
        let now = Date()
        let continues = !parts.contains("count") && parts == lastChange.parts
            && now.timeIntervalSince(lastChange.at) < 0.6 && !undoStack.isEmpty
        lastChange = (parts, now)
        if !continues {
            undoStack.append(project)
            if undoStack.count > 200 { undoStack.removeFirst() }
        }
        redoStack.removeAll()
        commit(next, rebuildMovie: rebuildMovie)
    }

    @ObservationIgnored private var lastChange: (parts: [String], at: Date) = ([], .distantPast)

    /// Which parts of the edit differ, for telling one continuous change from the next.
    nonisolated static func changedParts(_ a: EditProject, _ b: EditProject) -> [String] {
        var parts: [String] = []
        if a.clips != b.clips { parts.append("clips") }
        if a.zooms != b.zooms { parts.append("zooms") }
        if a.audio != b.audio { parts.append("audio") }
        if a.export != b.export { parts.append("export") }
        if a.clicks != b.clicks { parts.append("clicks") }
        if a.frame != b.frame { parts.append("frame") }
        if a.cursor != b.cursor { parts.append("cursor") }
        if a.captions != b.captions { parts.append("captions") }
        if a.keys != b.keys { parts.append("keys") }
        if a.redactions != b.redactions { parts.append("redactions") }
        if a.texts != b.texts { parts.append("texts") }
        if a.shapes != b.shapes { parts.append("shapes") }
        if a.transcript != b.transcript { parts.append("transcript") }
        if a.motion != b.motion { parts.append("motion") }
        // A count change (an add or a delete) is its own step, never part of a drag.
        if (a.zooms.count, a.redactions?.count, a.texts?.count, a.shapes?.count, a.clips.count)
            != (b.zooms.count, b.redactions?.count, b.texts?.count, b.shapes?.count, b.clips.count) { parts.append("count") }
        return parts
    }

    private func commit(_ next: EditProject, rebuildMovie: Bool) {
        project = next
        zoom.update(next)
        canUndo = !undoStack.isEmpty
        canRedo = !redoStack.isEmpty
        edited = true
        if rebuildMovie {
            // A sound slider sends a change per step; the movie is built again once it rests for 0.2 s.
            if lastChange.parts == ["audio"] {
                rebuildSoon?.cancel()
                let work = DispatchWorkItem { [weak self] in self?.rebuild() }
                rebuildSoon = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: work)
            } else {
                rebuild()
            }
        } else {
            refreshFrame()
        }
        scheduleSave()
    }

    /// What ⌘Z would take back ("Move Text", "Delete Zoom"), for the Edit menu and the notice; nil when nothing.
    var undoName: String? { undoStack.last.map { Self.changeName(from: $0, to: project).name } }
    var redoName: String? { redoStack.last.map { Self.changeName(from: project, to: $0).name } }

    /// A name for the change from `a` to `b`, and the tab that shows it. An add or a delete says so; several kinds of
    /// change at once are "Changes".
    nonisolated static func changeName(from a: EditProject, to b: EditProject) -> (name: String, tab: InspectorTab?) {
        let parts = changedParts(a, b).filter { $0 != "count" }
        guard parts.count == 1, let part = parts.first else { return ("Changes", nil) }
        let counts: (Int, Int)
        let named: (String, InspectorTab)
        switch part {
        case "clips": named = ("Cut", .clip); counts = (a.clips.count, b.clips.count)
        case "zooms": named = ("Zoom", .zoom); counts = (a.zooms.count, b.zooms.count)
        case "redactions": named = ("Hidden Part", .hide); counts = (a.redactions?.count ?? 0, b.redactions?.count ?? 0)
        case "texts": named = ("Text", .text); counts = (a.texts?.count ?? 0, b.texts?.count ?? 0)
        case "shapes": named = ("Shape", .text); counts = (a.shapes?.count ?? 0, b.shapes?.count ?? 0)
        case "audio": return ("Sound Change", .audio)
        case "export": return ("Export Settings", .export)
        case "clicks": return ("Click Style", .style)
        case "frame": return ("Background", .style)
        case "motion": return ("Motion Blur", .zoom)
        case "cursor": return ("Cursor Style", .cursor)
        case "captions": return ("Captions", .captions)
        case "keys": return ("Shortcuts", .captions)
        case "transcript": return ("Caption Fix", .captions)
        default: return ("Changes", nil)
        }
        if part == "clips" { return (counts.1 > counts.0 ? "Split" : counts.1 < counts.0 ? "Delete Clip" : "Clip Change", .clip) }
        if counts.1 > counts.0 { return ("Add \(named.0)", named.1) }
        if counts.1 < counts.0 { return ("Delete \(named.0)", named.1) }
        return ("\(named.0) Change", named.1)
    }

    /// An undo or a redo names what it changed and opens the tab that shows it, so a change on a tab that is not
    /// open is never silent.
    private func announce(_ verb: String, _ change: (name: String, tab: InspectorTab?)) {
        if let tab = change.tab, tab != self.tab { self.tab = tab }
        show("\(verb): \(change.name)", error: false)
    }

    func undo() {
        guard let previous = undoStack.popLast() else { return }
        let change = Self.changeName(from: previous, to: project)
        lastChange = ([], .distantPast)
        redoStack.append(project)
        commit(previous, rebuildMovie: previous.clips != project.clips || previous.audio != project.audio)
        announce("Undid", change)
    }

    func redo() {
        guard let next = redoStack.popLast() else { return }
        let change = Self.changeName(from: project, to: next)
        undoStack.append(project)
        commit(next, rebuildMovie: next.clips != project.clips || next.audio != project.audio)
        announce("Redid", change)
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

    /// `[` / `]`: cuts the clip under the playhead from its start to here, or from here to its end.
    func trimToPlayhead(_ side: TimelineMap.TrimSide) {
        guard let (next, playhead) = TimelineMap.trimToPlayhead(project, atOutput: clock.outUs, side: side) else {
            show("Nothing to trim here: the playhead is at the edge of a clip.", error: false)
            return
        }
        clock.outUs = playhead
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
        case let .shape(id):
            deleteShape(id)
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
        case let .shape(id):
            guard var copy = project.shapes?.first(where: { $0.id == id }) else { return }
            let length = copy.endUs - copy.startUs
            copy.id = "s" + UUID().uuidString.prefix(8).lowercased()
            copy.startUs = min(copy.endUs, project.source.durationUs - 100_000)
            copy.endUs = min(project.source.durationUs, copy.startUs + length)
            next.shapes = (next.shapes ?? []) + [copy]
            selection = .shape(copy.id)
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

    /// Each recording marker in the kept movie as a 2.5 s step title, "1. Open the settings", in one undo step, as the
    /// REPL's titleMarkers() does; a marker that has a text starting within 0.1 s keeps it.
    func titleMarkers() {
        let kept = markers.filter { TimelineMap.outputTime(ofSource: $0.us, in: project) != nil }
        guard !kept.isEmpty else {
            show("No marker is in the kept movie; mark moments while recording (the menu bar item's Add Marker).", error: false)
            return
        }
        let taken = (project.texts ?? []).map(\.startUs)
        var next = project
        var added = 0
        for (index, marker) in kept.enumerated() where !taken.contains(where: { abs($0 - marker.us) <= 100_000 }) {
            let id = "t" + UUID().uuidString.prefix(8).lowercased()
            let end = min(project.source.durationUs, marker.us + 2_500_000)
            next.texts = (next.texts ?? []) + [EditProject.TextNote(id: id, startUs: marker.us, endUs: end,
                                                                     text: String("\(index + 1). \(marker.label)".prefix(200)))]
            added += 1
        }
        guard added > 0 else {
            show("Every marker has its title already.", error: false)
            return
        }
        tab = .text
        apply(next, rebuildMovie: false)
        show("Added \(Plural.count(added, "step title")); ⌘Z takes them back.", error: false)
    }

    var selectedShape: String? {
        get { if case let .shape(id) = selection { id } else { nil } }
        set {
            if let newValue {
                selection = .shape(newValue)
            } else if selectedShape != nil {
                selection = .none
            }
        }
    }

    /// A 3 s arrow, box or circle from the playhead in the middle of the picture; the preview's handles place it.
    func addShape(_ kind: EditProject.ShapeKind) {
        let start = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        let end = min(project.source.durationUs, start + 3_000_000)
        guard end - start >= 100_000 else {
            show("The playhead is at the end of the recording; move it back to add a shape.", error: false)
            return
        }
        let id = "s" + UUID().uuidString.prefix(8).lowercased()
        // Where the pointer is at the playhead (the cursor track has it): an arrow points at it from towards the
        // middle, a box or circle goes round it. Without a track, the middle of the picture.
        let at = cursor?.point(atMs: Double(start) / 1000) ?? (x: 0.5, y: 0.5)
        let toward = (x: at.x > 0.5 ? -1.0 : 1.0, y: at.y > 0.5 ? -1.0 : 1.0)
        let clamp = { (value: Double) in min(max(0, value), 1) }
        let corners = kind == .arrow
            ? (clamp(at.x + toward.x * 0.09), clamp(at.y + toward.y * 0.09), at.x, at.y)
            : (clamp(at.x - 0.08), clamp(at.y - 0.06), clamp(at.x + 0.08), clamp(at.y + 0.06))
        var next = project
        next.shapes = (next.shapes ?? []) + [EditProject.Shape(id: id, startUs: start, endUs: end, kind: kind,
                                                                x1: corners.0, y1: corners.1, x2: corners.2, y2: corners.3)]
        selectedShape = id
        tab = .text
        apply(next, rebuildMovie: false)
    }

    func updateShape(_ id: String, _ change: (inout EditProject.Shape) -> Void) {
        guard var list = project.shapes, let index = list.firstIndex(where: { $0.id == id }) else { return }
        change(&list[index])
        for key in [\EditProject.Shape.x1, \.y1, \.x2, \.y2] { list[index][keyPath: key] = min(max(0, list[index][keyPath: key]), 1) }
        list[index].width = min(max(0.002, list[index].width), 0.03)
        list[index].endUs = max(list[index].startUs + 100_000, min(project.source.durationUs, list[index].endUs))
        var next = project
        next.shapes = list
        apply(next, rebuildMovie: false)
    }

    /// The shape starts at the playhead and keeps its length (cut short at the end of the recording).
    func moveShapeStart(_ id: String) {
        let start = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        updateShape(id) { shape in
            let length = shape.endUs - shape.startUs
            shape.startUs = min(start, project.source.durationUs - 100_000)
            shape.endUs = min(project.source.durationUs, shape.startUs + length)
        }
    }

    func deleteShape(_ id: String) {
        var next = project
        next.shapes = (next.shapes ?? []).filter { $0.id != id }
        if next.shapes?.isEmpty == true { next.shapes = nil }
        if selectedShape == id { selectedShape = nil }
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

    /// ⇧⌫: cuts the part between I and O out of the edit and puts the playhead where it was.
    func cutPart() {
        guard let part = exportPart else {
            show("Set a part with I and O first; ⇧⌫ cuts what plays between them.", error: false)
            return
        }
        guard let next = TimelineMap.cut(project, fromOut: part.fromUs, toOut: part.toUs) else {
            show("The part is the whole edit; at least one frame has to stay.", error: false)
            return
        }
        clearPart()
        clock.outUs = part.fromUs
        apply(next, rebuildMovie: true)
        show("Cut \(formatClock(part.toUs - part.fromUs, tenths: true)); ⌘Z puts it back.", error: false)
    }

    /// Keeps only what plays between I and O.
    func keepPart() {
        guard let part = exportPart, let next = TimelineMap.part(project, fromOut: part.fromUs, toOut: part.toUs) else {
            show("Set a part with I and O first.", error: false)
            return
        }
        clearPart()
        clock.outUs = 0
        apply(next, rebuildMovie: true)
    }

    /// Hides a part of the picture (the middle, or a rectangle drawn on the preview, 0...1 of the source) for 3 s from
    /// the playhead; the Hide tab then moves and sizes it.
    /// A 3 s spotlight from the playhead: on the pointer when the recording has a cursor track, else in the middle.
    func addSpotlight() {
        addRedaction(rect: CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.2), style: .spotlight, follow: cursor != nil)
    }

    func addRedaction(rect: CGRect = CGRect(x: 0.35, y: 0.42, width: 0.3, height: 0.16), style: EditProject.RedactionStyle = .blur,
                      follow: Bool = false) {
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
                                                                           width: clamped.width, height: clamped.height, style: style,
                                                                           follow: follow ? true : nil)]
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

    /// On by default: a dragged zoom, hidden part, text or clip edge snaps to the playhead, the clip edges, the
    /// markers and the other items' edges within `snapPoints`. View → Snap While Dragging turns it off.
    static let snapKey = "recorder.timeline.snap"
    /// On by default: the trackpad taps once each time a dragged edge lands on a target. View → Tap When Snapping.
    static let snapHapticKey = "recorder.timeline.snapHaptic"
    static let snapPoints = 7.0

    /// Where the last drag snapped, in source microseconds, for the guide line; nil while nothing snaps.
    var snapGuideUs: Int64?

    /// Every source time a drag can snap to, but the dragged item's own edges.
    private func snapTargets(excluding id: String?) -> [Int64] {
        var targets = [TimelineMap.sourceTime(atOutput: clock.outUs, in: project)]
        targets += project.clips.filter { $0.id != id }.flatMap { [$0.fromUs, $0.toUs] }
        targets += markers.map(\.us)
        targets += project.zooms.filter { $0.id != id }.flatMap { [$0.startUs, $0.endUs] }
        targets += (project.redactions ?? []).filter { $0.id != id }.flatMap { [$0.startUs, $0.endUs] }
        targets += (project.texts ?? []).filter { $0.id != id }.flatMap { [$0.startUs, $0.endUs] }
        targets += (project.shapes ?? []).filter { $0.id != id }.flatMap { [$0.startUs, $0.endUs] }
        return targets
    }

    /// A dragged edge at `us` (source), moved onto a target close enough on screen; the guide shows where.
    /// ⌘ held during the drag places the edge freely, as in Final Cut and Keynote.
    func snapped(_ us: Int64, excluding id: String?) -> Int64 {
        guard UserDefaults.standard.object(forKey: Self.snapKey) as? Bool ?? true,
              !NSEvent.modifierFlags.contains(.command) else {
            snapGuideUs = nil
            return us
        }
        let pointsPerSecond = pointsPerSecond > 0 ? pointsPerSecond : fittedPointsPerSecond
        let tolerance = Int64(Self.snapPoints / max(1, pointsPerSecond) * 1_000_000)
        let target = TimelineMap.snap(us, to: snapTargets(excluding: id), toleranceUs: tolerance)
        if let target, target != snapGuideUs, UserDefaults.standard.object(forKey: Self.snapHapticKey) as? Bool ?? true {
            NSHapticFeedbackManager.defaultPerformer.perform(.alignment, performanceTime: .now)
        }
        snapGuideUs = target
        return target ?? us
    }

    /// A dragged item from `start` to `end` (source), moved so the edge nearer a target lands on it.
    func snappedMove(start: Int64, end: Int64, excluding id: String?) -> Int64 {
        let movedStart = snapped(start, excluding: id)
        if movedStart != start { return movedStart - start }
        let movedEnd = snapped(end, excluding: id)
        return movedEnd - end
    }

    func endSnap() {
        snapGuideUs = nil
    }

    func trimClip(_ id: String, fromUs: Int64? = nil, toUs: Int64? = nil) {
        guard let next = TimelineMap.trim(project, clip: id, fromUs: fromUs, toUs: toUs) else { return }
        apply(next, rebuildMovie: true)
    }

    func setSpeed(_ id: String, _ speed: Double) {
        guard let next = TimelineMap.setSpeed(project, clip: id, speed: speed) else { return }
        apply(next, rebuildMovie: true)
    }

    /// The movie's sound tracks (a recording with the system sound and the microphone has two).
    private(set) var audioTrackCount = 0

    func setTrackMuted(_ index: Int, _ muted: Bool) {
        setAudio { audio in
            audio.mutedTracks.removeAll { $0 == index }
            if muted { audio.mutedTracks.append(index) }
            audio.mutedTracks.sort()
        }
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

    /// A sound file under the movie, looped to its length.
    func chooseMusic() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = [.audio]
        panel.canChooseDirectories = false
        panel.message = "Music to play under the movie"
        guard panel.runModal() == .OK, let url = panel.url else { return }
        setAudio { audio in
            var music = audio.music ?? EditProject.Music(file: url.path)
            music.file = url.path
            audio.music = music
        }
    }

    func setMusic(_ change: (inout EditProject.Music) -> Void) {
        setAudio { audio in
            guard var music = audio.music else { return }
            change(&music)
            audio.music = music
        }
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

    /// ⌥⌘S: the frame at the playhead at the export's full size, every look drawn, as a PNG (a thumbnail, a README
    /// picture). The same frame `movie.poster()` and `--still --full` write.
    func saveFrame() {
        let at = clock.outUs
        let panel = NSSavePanel()
        panel.title = "Save Frame as Picture"
        panel.allowedContentTypes = [.png]
        panel.nameFieldStringValue = "\(EditExporter.defaultName(for: project))-\(formatClock(at).replacingOccurrences(of: ":", with: "."))-poster.png"
        panel.directoryURL = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let snapshot = project
        Task { [weak self] in
            guard let self else { return }
            do {
                let image = try await stillFrame(project: snapshot, atOutput: at, zoom: self.zoom, maxHeight: snapshot.export.maxHeight)
                guard let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else {
                    throw NSError(domain: "recorder", code: 70, userInfo: [NSLocalizedDescriptionKey: "the frame could not be encoded"])
                }
                try png.write(to: url)
                HubPerf.log("recorder.frame: \(url.path) \(image.width)×\(image.height)")
                self.show("Saved \(url.lastPathComponent) (\(image.width) × \(image.height)).", error: false)
                NSWorkspace.shared.activateFileViewerSelecting([url])
            } catch {
                self.show("The frame could not be saved: \(error.localizedDescription)", error: true)
            }
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

    private(set) var isMarkingClicks = false

    /// The circles Circle Every Click made: a circle that starts within 0.1 s of a recorded click.
    var clickCircles: [EditProject.Shape] {
        let clicks = (cursor?.clicks ?? []).map { Int64(($0.ms * 1000).rounded()) }
        return (project.shapes ?? []).filter { shape in
            shape.kind == .circle && clicks.contains { abs($0 - shape.startUs) <= 100_000 }
        }
    }

    /// Takes every click circle out in one undo step; other shapes stay.
    func removeClickCircles() {
        let ids = Set(clickCircles.map(\.id))
        guard !ids.isEmpty else { return }
        var next = project
        let rest = (next.shapes ?? []).filter { !ids.contains($0.id) }
        next.shapes = rest.isEmpty ? nil : rest
        if let selected = selectedShape, ids.contains(selected) { selection = .none }
        apply(next, rebuildMovie: false)
        show("Removed \(Plural.count(ids.count, "click circle")); ⌘Z puts them back.", error: false)
    }

    /// A circle at every recorded click with `tools recorder apply … annotateClicks` (the REPL's annotateClicks); the
    /// file watcher brings the shapes in, one ⌘Z away.
    func markClicks() {
        guard !isMarkingClicks else { return }
        isMarkingClicks = true
        let before = project.shapes?.count ?? 0
        ToolsRunner.run(["recorder", "apply", store.url.path, #"{"op":"annotateClicks"}"#]) { [weak self] status, _, stderr in
            guard let self else { return }
            self.isMarkingClicks = false
            guard status == 0 else {
                self.show(stderr.split(separator: "\n").last.map(String.init) ?? "No click was marked (exit \(status))", error: true)
                return
            }
            if let data = try? Data(contentsOf: self.store.url), let next = try? EditProject.decode(data, at: self.store.url) {
                self.adoptExternal(next)
            }
            let added = (self.project.shapes?.count ?? 0) - before
            self.tab = .text
            let both = self.project.clicks?.highlight == true
                ? " Click rings are on too (Cursor and Clicks), so each click shows two rings." : ""
            self.show(added > 0 ? "Circled \(Plural.count(added, "click")); ⌘Z takes them back.\(both)" : "Every click has its circle already.",
                      error: false)
        }
    }

    /// Replaces a word or phrase in every caption line with `tools recorder replace-words` (the REPL's replaceWords);
    /// the file watcher brings the result in, one ⌘Z away.
    func replaceWords(find: String, replace: String) {
        let find = find.trimmingCharacters(in: .whitespaces)
        guard !find.isEmpty else { return }
        ToolsRunner.run(["recorder", "replace-words", store.url.path, "--find", find, "--replace", replace]) { [weak self] status, stdout, stderr in
            guard let self else { return }
            guard status == 0 else {
                self.show(stderr.split(separator: "\n").last.map(String.init) ?? "The replace failed (exit \(status))", error: true)
                return
            }
            let summary = stderr.split(separator: "\n").last.map(String.init) ?? "replaced"
            HubPerf.log("recorder.replaceWords: \(summary) \(stdout.count) bytes")
            self.show("“\(find)” → “\(replace)”: \(summary).", error: false)
        }
    }

    /// Sets the volume so the export reaches -16 LUFS, measured by `tools recorder apply {"op":"normalize"}`.
    /// The loudness `normalize` measured at volume 1, in LUFS; nil until it ran in this window.
    private(set) var measuredLufs: Double?

    func normalizeLoudness() {
        guard !isNormalizing else { return }
        saveTask?.cancel()
        saveNow()
        isNormalizing = true
        show("Measuring the loudness…", error: false)
        ToolsRunner.run(["recorder", "apply", store.url.path, #"{"op":"normalize"}"#]) { [weak self] status, stdout, stderr in
            guard let self else { return }
            self.isNormalizing = false
            let answer = (stdout.split(separator: "\n").last.flatMap { $0.data(using: .utf8) })
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            if let measured = (answer?["loudness"] as? [String: Any])?["measuredLufs"] as? NSNumber {
                self.measuredLufs = measured.doubleValue
            }
            guard status == 0 else {
                let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                self.show("The volume is unchanged: \(reason)", error: true)
                return
            }
            if let data = try? Data(contentsOf: self.store.url), let next = try? EditProject.decode(data, at: self.store.url) {
                self.adoptExternal(next)
            }
            let volume = Int((self.project.audio.volume * 100).rounded())
            self.show(volume >= 200 ? "The volume is at its 200 % limit; the movie is still quieter than -16 LUFS."
                                    : "The volume is \(volume) %, so the export plays at -16 LUFS. ⌘Z undoes it.", error: false)
        }
    }

    /// Cuts the still, silent parts, or with `speed` plays them that much faster (so time is seen to pass).
    /// Opinionated, so settings: how long a still, silent stretch must be (2 s), and what happens to it (cut, or
    /// played 4×, 8× or 16× faster). The Clip tab sets both.
    static let idleMinKey = "recorder.idle.minSeconds"
    static let idleSpeedKey = "recorder.idle.speed"

    func removeIdle(speed: Int? = nil) {
        guard !isRemovingIdle else { return }
        saveTask?.cancel()
        saveNow()
        isRemovingIdle = true
        show("Looking for parts where nothing moves and nothing is heard…", error: false)
        let before = durationUs
        let minSeconds = UserDefaults.standard.object(forKey: Self.idleMinKey) as? Double ?? 2
        let op = speed.map { #"{"op":"removeIdle","minSeconds":\#(minSeconds),"speed":\#($0)}"# }
            ?? #"{"op":"removeIdle","minSeconds":\#(minSeconds)}"#
        ToolsRunner.run(["recorder", "apply", store.url.path, op]) { [weak self] status, _, stderr in
            guard let self else { return }
            self.isRemovingIdle = false
            guard status == 0 else {
                let reason = stderr.split(separator: "\n").last.map(String.init) ?? "exit \(status)"
                self.show("Nothing was cut: \(reason)", error: true)
                return
            }
            // The watcher may not have delivered the file yet; read it now so the message has the new length.
            if let data = try? Data(contentsOf: self.store.url), let next = try? EditProject.decode(data, at: self.store.url) {
                self.adoptExternal(next)
            }
            let saved = before - self.durationUs
            let verb = speed.map { "Sped up the still, silent parts \($0)×, saving" } ?? "Removed"
            self.show(saved > 0 ? "\(verb) \(formatClock(saved, tenths: true)) of still, silent parts; ⌘Z brings them back."
                                : "No still, silent part of \(Int(minSeconds)) s or more was found.", error: false)
        }
    }

    // MARK: - Export

    /// The window's MP4 export while it runs; a GIF or WebM runs in `tools` and cannot be stopped from here.
    private var exportTask: Task<Void, Never>?
    private var exportCancelled = false
    var canCancelExport: Bool { exportTask != nil }

    func cancelExport() {
        exportCancelled = true
    }

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
        let part = exportPart
        if let part, let trimmed = TimelineMap.part(project, fromOut: part.fromUs, toOut: part.toUs) { rendered = trimmed }
        let url = EditExporter.outputURL(for: project)
        exportProgress = 0
        exportCancelled = false
        exportTask = Task { [weak self] in
            defer { self?.exportTask = nil }
            do {
                let result = try await EditExporter.export(project: rendered, to: url, isCancelled: { self?.exportCancelled ?? true }) { progress in
                    self?.exportProgress = progress
                }
                self?.exportProgress = nil
                HubPerf.log("recorder.export: \(result.url.path) \(ByteFormat.file(result.bytes)) in \(String(format: "%.1f", result.seconds)) s")
                self?.show("Exported \(result.url.lastPathComponent) (\(ByteFormat.file(result.bytes)), \(String(format: "%.1f", result.seconds)) s).", error: false)
                self?.finishExport(result.url, part: part)
                self?.reveal(result.url)
            } catch is CancellationError {
                self?.exportProgress = nil
                HubPerf.log("recorder.export cancelled: \(url.path)")
                self?.show("Export cancelled; no file was written.", error: false)
            } catch {
                self?.exportProgress = nil
                HubPerf.log("recorder.export failed: \(error.localizedDescription)")
                self?.show(error.localizedDescription, error: true)
            }
        }
    }

    /// After the window's export: the subtitle file and the markers as chapters, by `tools recorder finish` (the same
    /// step the CLI and the REPL run); a GIF or WebM gets it from `tools recorder export` itself.
    private func finishExport(_ movie: URL, part: (fromUs: Int64, toUs: Int64)?) {
        guard project.export.subtitles != nil || (project.export.chapters != false && !markers.isEmpty) else { return }
        var argv = ["recorder", "finish", store.url.path, movie.path]
        if let part {
            argv += ["--from", String(format: "%.3f", Double(part.fromUs) / 1_000_000), "--to", String(format: "%.3f", Double(part.toUs) / 1_000_000)]
        }
        ToolsRunner.run(argv) { [weak self] status, stdout, stderr in
            let warning = stderr.split(separator: "\n").last.map(String.init)
            HubPerf.log("recorder.export: finish exit \(status) \(stdout.split(separator: "\n").last.map(String.init) ?? "")")
            if status != 0 || warning != nil {
                self?.show("Exported, but: \(warning ?? "exit \(status)")", error: true)
            }
        }
    }

    /// One finding of `tools recorder check` (the same check as the REPL's movie.check()).
    struct EditIssue: Decodable, Equatable, Identifiable {
        let severity: String
        let item: String
        let message: String
        let fix: String?
        /// Source seconds.
        let at: Double?
        let target: Target?
        var id: String { item + message }
        var mustFix: Bool { severity == "fix" }

        struct Target: Decodable, Equatable {
            let list: String
            let id: String
        }

        /// The editor's selection for the item it names.
        var selection: EditorSelection? {
            guard let target else { return nil }
            switch target.list {
            case "zooms": return .zoom(target.id)
            case "redactions": return .redaction(target.id)
            case "texts": return .text(target.id)
            case "shapes": return .shape(target.id)
            default: return nil
            }
        }
    }

    /// Removes the item an issue names (one undo step), as its fix does in the REPL.
    func remove(_ issue: EditIssue) {
        guard let selection = issue.selection else { return }
        self.selection = selection
        deleteSelection()
    }

    private struct CheckAnswer: Decodable {
        let ok: Bool
        let issues: [EditIssue]
    }

    /// What the Export tab lists before an export, for the edit as saved at `checkedRevision`.
    private(set) var issues: [EditIssue] = []
    private var checkedRevision: Int?
    /// The revision the shown issues belong to, once the check answered (a snapshot waits for it).
    private(set) var issuesRevision: Int?

    /// Runs the check once per saved revision; the Export tab calls it after the edit has rested for a moment.
    func refreshIssues() {
        let revision = project.revision
        guard checkedRevision != revision else { return }
        checkedRevision = revision
        ToolsRunner.run(["recorder", "check", store.url.path]) { [weak self] status, stdout, stderr in
            guard let self, self.project.revision == revision else { return }
            guard status == 0, let line = stdout.split(separator: "\n").last, let data = line.data(using: .utf8),
                  let answer = try? JSONDecoder().decode(CheckAnswer.self, from: data) else {
                HubPerf.log("recorder.check failed: exit \(status) \(stderr.split(separator: "\n").last.map(String.init) ?? "")")
                self.checkedRevision = nil
                return
            }
            self.issues = answer.issues
            self.issuesRevision = revision
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
