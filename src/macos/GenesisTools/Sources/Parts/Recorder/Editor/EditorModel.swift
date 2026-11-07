import AVFoundation
import AppKit
import Observation
import SwiftUI
import UniformTypeIdentifiers

/// The playhead, kept apart from the model so that only the views that show the time re-render 30 times a second
/// while a movie plays (the transport's clock and the timeline's red line), never the inspector or the lanes.
@MainActor
@Observable
final class PlayheadClock {
    var outUs: Int64 = 0
}

/// One step of the editor's undo: the edit as it was before a change, or a display switch, which changed the proxy
/// movie and not the edit file, so its undo is the recorder's display undo (proxy.undo.json).
enum UndoStep: Equatable {
    case edit(EditProject)
    case display(DisplaySwitchStep)
}

/// A display switch as an undo step: the frames recording's display plan before and after it.
struct DisplaySwitchStep: Equatable {
    let before: DisplayPlan
    let after: DisplayPlan
}

/// One selection for the whole editor, so ⌫, Esc, the lanes and the inspector agree on what is selected.
enum EditorSelection: Equatable {
    case none
    case clip(String)
    case zoom(String)
    case redaction(String)
    case text(String)
    case shape(String)
    /// A nil id identifies a recording marker, which the edit cannot remove.
    case marker(id: String?, atUs: Int64)
    /// A part where the camera bubble is hidden (Editor/EditorCamera.swift).
    case cameraHide(String)
}

extension InspectorTab {
    /// ⌘1 to ⌘9 in the rail's order; a tenth tab gets no key.
    var shortcutIndex: Int? {
        guard let index = Self.allCases.firstIndex(of: self), index < 9 else { return nil }
        return index + 1
    }
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case zoom, clip, hide, text, style, cursor, captions, audio, export, find
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
        case .find: "text.magnifyingglass"
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
        case .find: "Find on Screen"
        }
    }
}

@MainActor
@Observable
final class EditorModel {
    /// Set only by the edit path (EditorEdits.swift): what the recorder service answered, or the CLI saved.
    var project: EditProject
    let store: ProjectStore
    /// The edit session on the recorder service (EditorSession.swift); offline, edits run in `tools`.
    @ObservationIgnored let session: EditorSession
    /// The continuous change in progress (a slider, a drag), one undo step once it rests.
    @ObservationIgnored var gesture: EditGesture?
    @ObservationIgnored var savingGestures = 0
    @ObservationIgnored var gestureSaveFailed = false
    @ObservationIgnored var gestureWaiters: [(Bool) -> Void] = []
    @ObservationIgnored var exportWaiting = false
    /// Another writer changed the edit during a drag: it is fetched once the drag ends.
    @ObservationIgnored var refetchPending = false
    let clock = PlayheadClock()
    let filmstrip = Filmstrip()
    let waveform = Waveform()
    @ObservationIgnored let player = AVPlayer()
    @ObservationIgnored let zoom: ZoomState
    @ObservationIgnored private var asset: AVURLAsset
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var renderTask: Task<Void, Never>?
    @ObservationIgnored var rebuildSoon: DispatchWorkItem?
    /// What ⌘Z and ⇧⌘Z would take back or make again, for their names in the Edit menu: the service keeps the
    /// edit's real undo stack, and each step here mirrors one change this window made or took from outside.
    @ObservationIgnored var undoStack: [UndoStep] = []
    @ObservationIgnored var redoStack: [UndoStep] = []
    /// Undo steps the service kept from before this window opened (an edit's steps outlive a close): ⌘Z takes them
    /// once the window's own steps are used up, so an undo survives a reopen.
    @ObservationIgnored var earlierSteps = 0
    /// Counts the new steps (a change, an outside edit, a display switch); an undo or redo that fails puts its step
    /// back on the redo list only when no new step came since (a new step empties that list).
    @ObservationIgnored var historyGeneration = 0
    /// Starts a `tools` command for the window and answers on the main thread (`ToolsRunner.run`); a test answers
    /// for the CLI instead.
    @ObservationIgnored var runTools: (_ argv: [String], _ done: @escaping @MainActor (Int32, String, String) -> Void) -> Void = {
        ToolsRunner.run($0, done: $1)
    }
    @ObservationIgnored let cursor: CursorTrack?
    /// The review comments beside the recording (comments.jsonl), watched so an agent's comment shows at once.
    @ObservationIgnored let commentsStore: ReviewCommentsStore
    private(set) var reviewComments: [ReviewComment] = []
    /// The comment whose popover is open over the marks lane.
    var openComment: String?
    /// Which display a frames recording's proxy movie shows when (proxy.json); nil for any other movie.
    var displayPlan: DisplayPlan?
    /// `tools recorder proxy` makes the movie again for a display switch.
    var isSwitchingDisplay = false

    var selection: EditorSelection = .none
    /// The banners of the last edits written from outside the window (EditorChangeFeed.swift).
    var changes: [EditChange] = []
    /// Each banner's removal, cancelled while the pointer rests on it (`holdBanner`).
    @ObservationIgnored var bannerTimers: [UUID: Task<Void, Never>] = [:]
    /// A counter per zoom, hidden part, text or shape id: its timeline segment flashes each time it rises.
    var flashes: [String: Int] = [:]
    /// Rises when an outside edit changed the whole picture, so the preview flashes.
    var previewFlash = 0
    var tab: InspectorTab = .zoom
    private(set) var isPlaying = false
    var canUndo = false
    var canRedo = false
    /// True while a continuous change is open (not one undo step yet).
    var edited = false
    var exportProgress: Double?
    var notice: String?
    var noticeIsError = false
    /// Why the preview has no picture (the movie cannot be read, the edit keeps nothing); the preview shows it in place
    /// of the picture with Try Again. Nil while the preview plays.
    var previewProblem: PreviewProblem?
    /// A `tools recorder apply` step runs (Remove Still Parts); its button shows progress and does not start another.
    private(set) var isRemovingIdle = false
    /// `tools recorder apply` measures the loudness (Normalize).
    private(set) var isNormalizing = false
    /// `tools transcribe` runs for the captions.
    private(set) var isTranscribing = false
    /// The movie has a cached transcript, so captions can be drawn.
    var hasTranscript = false
    /// Each transcript line's words as `tools recorder words` splits them, for the Captions tab's word pick; nil until
    /// read (EditorTranscriptCuts.swift).
    var lineWords: [TranscriptLineWords]?
    /// What `lineWords` were read from; another source makes them stale.
    @ObservationIgnored var lineWordsSource: TranscriptWordsSource?
    /// `tools recorder words` runs.
    var isReadingLineWords = false
    /// A cut by the transcript runs in `tools recorder apply`; its buttons wait for it.
    var isCuttingTranscript = false
    /// The Find tab's search of the text on the screen (EditorScreenFind.swift): the query, the moments it found (nil
    /// before a search), and why a search failed.
    var screenQuery = ""
    var screenHits: [ScreenHit]?
    var isSearchingScreen = false
    var screenSearchFailure: String?
    /// Whether the recording kept text off its screens (`hasScreenText`); nil until the Find tab first asks.
    var screenTextKnown: Bool?
    /// The moment last clicked in the Find tab.
    var selectedScreenHit: Int?
    @ObservationIgnored var screenSearchRevision = 0
    /// Edit ops this window runs through `tools recorder apply`: their saved edit is this window's own change, so it is
    /// adopted without the banner of an outside edit.
    @ObservationIgnored var ownOpsRunning = 0
    /// Pixels of the timeline per second; the transport's slider sets it.
    var pointsPerSecond: Double = 0

    /// `link` is the connection to the recorder service: the recorder host's, or a test's.
    init(project: EditProject, store: ProjectStore, link: @escaping @MainActor () -> RecorderServiceLink? = { RecorderServiceHost.shared }) {
        self.project = project
        self.store = store
        session = EditorSession(path: store.url.path, host: link)
        cursor = CursorTrack.load(project.source.cursor)
        zoom = ZoomState(project: project, cursor: cursor)
        hasTranscript = zoom.hasCaptions
        recordingMarkers = Self.readMarkers(video: project.source.video)
        commentsStore = ReviewCommentsStore(video: project.source.video)
        reviewComments = commentsStore.comments
        displayPlan = DisplayPlan.read(video: project.source.video)
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
        store.onExternalChange = { [weak self] next in self?.fileChanged(next) }
        store.watch()
        session.onOpened = { [weak self] next in self?.sessionOpened(next) }
        session.onOutsideChange = { [weak self] changed in self?.outsideChanged(action: changed.action) }
        session.start()
        commentsStore.onChange = { [weak self] comments in self?.reviewComments = comments }
        commentsStore.watch()
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

    /// ⌥← and ⌥→: the selected zoom, hidden part, text, shape or camera part starts `byUs` earlier or later, its
    /// length kept (the `retime` op's `by`, which holds it inside the recording; a zoom stays clear of the others).
    /// Key repeats are one move and one undo step. A clip or no selection says what to select.
    func moveSelectionInTime(byUs delta: Int64) {
        let id: String
        switch selection {
        case let .zoom(item), let .redaction(item), let .text(item), let .shape(item), let .cameraHide(item): id = item
        case .clip, .marker, .none:
            show("Select a zoom, hidden part, text or shape to move it in time.", error: false)
            return
        }
        let key = "move:\(id)"
        let offset = (gesture?.key == key ? gesture?.offsetUs ?? 0 : 0) + delta
        continuous(key, [.retime(EditOp.Retime(id: id, by: EditOpDiff.seconds(offset)))])
        gesture?.offsetUs = offset
    }

    /// One zoom, hidden part, text or shape on the timeline, for walking them in time order.
    struct TimelineItem: Equatable {
        let selection: EditorSelection
        /// Where it starts in the output, so a part inside a cut sorts where its first shown frame plays.
        let startUs: Int64
    }

    /// Every zoom, hidden part, text and shape, ordered by output start (ties keep the lane order, top lane first).
    var timelineItems: [TimelineItem] {
        func at(_ sourceUs: Int64) -> Int64 { TimelineMap.outputTime(ofSource: sourceUs, in: project) ?? sourceUs }
        let items: [TimelineItem] =
            project.zooms.map { TimelineItem(selection: .zoom($0.id), startUs: at($0.startUs)) }
            + (project.redactions ?? []).map { TimelineItem(selection: .redaction($0.id), startUs: at($0.startUs)) }
            + (project.texts ?? []).map { TimelineItem(selection: .text($0.id), startUs: at($0.startUs)) }
            + (project.shapes ?? []).map { TimelineItem(selection: .shape($0.id), startUs: at($0.startUs)) }
        return items.enumerated().sorted { ($0.element.startUs, $0.offset) < ($1.element.startUs, $1.offset) }.map(\.element)
    }

    /// The item after (or before) `current` in `items`; with nothing of the timeline selected, the first item that
    /// starts at or after the playhead (or the last one that starts before it). Nil at either end, with no wrap.
    nonisolated static func adjacent(in items: [TimelineItem], current: EditorSelection, playheadUs: Int64, forward: Bool) -> TimelineItem? {
        if let index = items.firstIndex(where: { $0.selection == current }) {
            let next = index + (forward ? 1 : -1)
            return items.indices.contains(next) ? items[next] : nil
        }
        return forward ? items.first { $0.startUs >= playheadUs } : items.last { $0.startUs < playheadUs }
    }

    /// ⌥↓ and ⌥↑: select the next or previous zoom, hidden part, text or shape in time order, open its inspector tab
    /// and move the playhead to its start, so the keyboard alone can walk every edit.
    func selectAdjacentItem(forward: Bool) {
        let items = timelineItems
        guard !items.isEmpty else {
            show("There is no zoom, hidden part, text or shape to select.", error: false)
            return
        }
        guard let item = Self.adjacent(in: items, current: selection, playheadUs: clock.outUs, forward: forward) else {
            show(forward ? "This is the last item on the timeline." : "This is the first item on the timeline.", error: false)
            return
        }
        selection = item.selection
        switch item.selection {
        case .zoom: tab = .zoom
        case .redaction: tab = .hide
        case .text, .shape: tab = .text
        case .cameraHide: tab = .style
        case .clip, .marker, .none: break
        }
        player.pause()
        seek(item.startUs)
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

    // MARK: - Edits (EditorEdits.swift sends them)

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
        if a.lanes != b.lanes { parts.append("lanes") }
        if a.camera != b.camera { parts.append("camera") }
        if a.markers != b.markers { parts.append("markers") }
        // A count change (an add or a delete) is its own step, never part of a drag.
        if (a.zooms.count, a.redactions?.count, a.texts?.count, a.shapes?.count, a.clips.count, a.markers?.count)
            != (b.zooms.count, b.redactions?.count, b.texts?.count, b.shapes?.count, b.clips.count, b.markers?.count)
            || (a.camera == nil, a.camera?.hidden.count) != (b.camera == nil, b.camera?.hidden.count) { parts.append("count") }
        return parts
    }

    /// What ⌘Z would take back ("Move Text", "Delete Zoom"), for the Edit menu and the notice; nil when nothing.
    var undoName: String? { undoStack.last.map { name(of: $0, undoing: true).name } }
    var redoName: String? { redoStack.last.map { name(of: $0, undoing: false).name } }

    func name(of step: UndoStep, undoing: Bool) -> (name: String, tab: InspectorTab?) {
        switch step {
        case let .edit(other): undoing ? Self.changeName(from: other, to: project) : Self.changeName(from: project, to: other)
        case .display: ("Display Switch", nil)
        }
    }

    /// A name for the change from `a` to `b`, and the tab that shows it. An add or a delete says so; several kinds of
    /// change at once are "Changes".
    nonisolated static func changeName(from a: EditProject, to b: EditProject) -> (name: String, tab: InspectorTab?) {
        let parts = changedParts(a, b).filter { $0 != "count" }
        // A lane change pins items to their lanes too, so it touches several parts at once.
        if parts.contains("lanes") { return ("Lane Change", nil) }
        guard parts.count == 1, let part = parts.first else { return ("Changes", nil) }
        let counts: (Int, Int)
        let named: (String, InspectorTab?)
        switch part {
        case "clips": named = ("Cut", .clip); counts = (a.clips.count, b.clips.count)
        case "zooms": named = ("Zoom", .zoom); counts = (a.zooms.count, b.zooms.count)
        case "redactions": named = ("Hidden Part", .hide); counts = (a.redactions?.count ?? 0, b.redactions?.count ?? 0)
        case "texts": named = ("Text", .text); counts = (a.texts?.count ?? 0, b.texts?.count ?? 0)
        case "shapes": named = ("Shape", .text); counts = (a.shapes?.count ?? 0, b.shapes?.count ?? 0)
        case "markers": named = ("Marker", nil); counts = (a.markers?.count ?? 0, b.markers?.count ?? 0)
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
    func announce(_ verb: String, _ change: (name: String, tab: InspectorTab?)) {
        if let tab = change.tab, tab != self.tab { self.tab = tab }
        show("\(verb): \(change.name)", error: false)
    }

    /// ⌘Z on a display switch: the movie is made again with the plan from before. The step moves to the redo list at
    /// once, so an edit made while the movie is made lands above it; a failed remake moves it back.
    func undoDisplaySwitch(_ step: UndoStep, change: (name: String, tab: InspectorTab?)) {
        guard !isSwitchingDisplay else {
            show("The movie is still being made; undo again once it is ready.", error: false)
            return
        }
        guard let move = beginMove(undoing: true, counterpart: step) else { return }
        stepDisplaySwitch(undo: true, doing: "Undoing the display switch") { [weak self] made in
            guard let self else { return }
            if made { self.announce("Undid", change) } else { self.failMove(move) }
        }
    }

    func redoDisplaySwitch(_ step: UndoStep, change: (name: String, tab: InspectorTab?)) {
        guard !isSwitchingDisplay else {
            show("The movie is still being made; redo again once it is ready.", error: false)
            return
        }
        guard let move = beginMove(undoing: false, counterpart: step) else { return }
        stepDisplaySwitch(undo: false, doing: "Redoing the display switch") { [weak self] made in
            guard let self else { return }
            if made { self.announce("Redid", change) } else { self.failMove(move) }
        }
    }

    /// A display switch that made the proxy movie again: one undo step among the edit's own, so ⌘Z takes back the
    /// changes in the order they were made.
    func recordDisplaySwitch(before: DisplayPlan, after: DisplayPlan) {
        guard before != after else { return }
        undoStack.append(.display(DisplaySwitchStep(before: before, after: after)))
        if undoStack.count > 200 { undoStack.removeFirst() }
        redoStack.removeAll()
        historyGeneration += 1
        refreshUndoState()
    }

    func refreshUndoState() {
        canUndo = !undoStack.isEmpty || earlierSteps > 0
        canRedo = !redoStack.isEmpty
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

    /// Source seconds of the playhead, as the ops take them.
    var playheadSourceSeconds: Double { EditOpDiff.seconds(TimelineMap.sourceTime(atOutput: clock.outUs, in: project)) }

    func splitAtPlayhead() {
        guard TimelineMap.canSplit(project, atOutput: clock.outUs) else {
            show("Nothing to split here: the playhead is at the edge of a clip.", error: false)
            return
        }
        edit([.split(EditOp.Split(at: playheadSourceSeconds))])
    }

    /// `[` / `]`: cuts the clip under the playhead from its start to here, or from here to its end.
    /// [ and ]: with a zoom, hidden part, text or shape selected, its start or end moves to the playhead; otherwise the
    /// clip under the playhead is trimmed there.
    func trimToPlayhead(_ side: TimelineMap.TrimSide) {
        let at = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        if let (id, span) = selectedSpan {
            // The playhead must be inside the selection, so [ and ] only ever shorten it.
            guard at > span.start, at < span.end else {
                show("Put the playhead inside the selection to trim it there.", error: false)
                return
            }
            let seconds = EditOpDiff.seconds(at)
            edit([.retime(side == .start ? EditOp.Retime(id: id, from: seconds) : EditOp.Retime(id: id, to: seconds))])
            return
        }
        guard TimelineMap.canSplit(project, atOutput: clock.outUs), let placed = TimelineMap.clip(atOutput: clock.outUs, in: project) else {
            show("Nothing to trim here: the playhead is at the edge of a clip.", error: false)
            return
        }
        let range = side == .start ? (placed.clip.fromUs, at) : (at, placed.clip.toUs)
        let playhead = side == .start ? placed.outStartUs : clock.outUs
        edit([.cut(EditOp.Cut(from: EditOpDiff.seconds(range.0), to: EditOpDiff.seconds(range.1)))]) { [weak self] _, _ in
            self?.seek(playhead)
        }
    }

    /// The id, start and end of the selected zoom, hidden part, text, shape or camera part; nil for a clip or nothing.
    private var selectedSpan: (String, (start: Int64, end: Int64))? {
        switch selection {
        case let .zoom(id): return project.zooms.first { $0.id == id }.map { (id, ($0.startUs, $0.endUs)) }
        case let .redaction(id): return project.redactions?.first { $0.id == id }.map { (id, ($0.startUs, $0.endUs)) }
        case let .text(id): return project.texts?.first { $0.id == id }.map { (id, ($0.startUs, $0.endUs)) }
        case let .shape(id): return project.shapes?.first { $0.id == id }.map { (id, ($0.startUs, $0.endUs)) }
        case let .cameraHide(id): return project.camera?.hidden.first { $0.id == id }.map { (id, ($0.startUs, $0.endUs)) }
        case .clip, .marker, .none: return nil
        }
    }

    func selectMarker(id: String?, atUs: Int64) {
        selection = .marker(id: id, atUs: atUs)
        if let out = TimelineMap.outputTime(ofSource: atUs, in: project) { seek(out) }
    }

    func deleteSelection() {
        let op: EditOp
        switch selection {
        case let .clip(id): op = .deleteClip(EditOp.DeleteClip(clip: id))
        case let .zoom(id): op = .unzoom(EditOp.Unzoom(id: id))
        case let .redaction(id): op = .unredact(EditOp.Unredact(id: id))
        case let .text(id): op = .untext(EditOp.Untext(id: id))
        case let .shape(id): op = .unshape(EditOp.Unshape(id: id))
        case let .cameraHide(id): op = .cameraShow(EditOp.CameraShow(id: id))
        case let .marker(id, _):
            guard let id else {
                show("This marker belongs to the recording and cannot be deleted here.", error: false)
                return
            }
            deleteMarker(id)
            return
        case .none: return
        }
        let deleted = selection
        edit([op]) { [weak self] _, _ in
            if self?.selection == deleted { self?.selection = .none }
        }
    }

    /// A zoom from the playhead, two seconds long by default; the service places it after any zoom it would meet.
    func addZoom(atOutput outUs: Int64? = nil, durationUs: Int64 = 2_000_000, lane: String? = nil) {
        let start = TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project)
        edit([.zoom(EditOp.Zoom(from: EditOpDiff.seconds(start), to: EditOpDiff.seconds(start + durationUs), lane: lane))]) { [weak self] before, after in
            guard let self, let id = Self.addedID(before, after, { $0.zooms.map(\.id) }) else { return }
            self.selection = .zoom(id)
            self.tab = .zoom
        }
    }

    /// Corrects a caption line's words (nil drops the fix, "" hides the line): the `fixLine` op.
    func fixCaption(_ line: CaptionTrack.Line, text: String?) {
        let from = EditOpDiff.seconds(line.fromUs)
        if let text {
            edit([.fixLine(EditOp.FixLine(from: from, text: String(text.prefix(300)).trimmingCharacters(in: .whitespacesAndNewlines)))])
        } else {
            edit([.unfixLine(EditOp.UnfixLine(from: from))])
        }
    }

    /// A copy of the selected zoom, hidden part, text, shape or camera part right after the original, selected (⌘D).
    func duplicateSelection() {
        let id: String
        switch selection {
        case let .zoom(item), let .redaction(item), let .text(item), let .shape(item), let .cameraHide(item): id = item
        case .clip, .marker, .none:
            show("Select a zoom, a hidden part or a text to duplicate it.", error: false)
            return
        }
        let kind = selection
        edit([.duplicate(EditOp.Duplicate(id: id))]) { [weak self] before, after in
            guard let self else { return }
            switch kind {
            case .zoom: Self.addedID(before, after, { $0.zooms.map(\.id) }).map { self.selection = .zoom($0) }
            case .redaction: Self.addedID(before, after, { ($0.redactions ?? []).map(\.id) }).map { self.selection = .redaction($0) }
            case .text: Self.addedID(before, after, { ($0.texts ?? []).map(\.id) }).map { self.selection = .text($0) }
            case .shape: Self.addedID(before, after, { ($0.shapes ?? []).map(\.id) }).map { self.selection = .shape($0) }
            case .cameraHide: Self.addedID(before, after, { ($0.camera?.hidden ?? []).map(\.id) }).map { self.selection = .cameraHide($0) }
            case .clip, .marker, .none: break
            }
        }
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
    func addText(_ text: String = "Title", atOutput outUs: Int64? = nil, durationUs: Int64 = 3_000_000, lane: String? = nil) {
        // A text fades in from its start (`ZoomState.texts`): it starts that much earlier, so the paused frame at the
        // playhead shows it whole.
        let start = max(0, TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project) - ZoomState.textFadeUs(lengthUs: durationUs))
        let op = EditOp.Text(from: EditOpDiff.seconds(start), to: EditOpDiff.seconds(start + durationUs), text: text, lane: lane)
        edit([.text(op)]) { [weak self] before, after in
            guard let self, let id = Self.addedID(before, after, { ($0.texts ?? []).map(\.id) }) else { return }
            self.selectedText = id
            self.tab = .text
        }
    }

    /// Each recording marker in the kept movie as a 2.5 s step title, "1. Open the settings", in one undo step: the
    /// REPL's titleMarkers() on the service.
    func titleMarkers() {
        if !session.isOnline {
            let kept = markers.filter { TimelineMap.outputTime(ofSource: $0.us, in: project) != nil }
            let ops = kept.enumerated().compactMap { index, marker -> EditOp? in
                guard !(project.texts ?? []).contains(where: { abs($0.startUs - marker.us) <= 100_000 }) else { return nil }
                return .text(EditOp.Text(from: EditOpDiff.seconds(marker.us),
                    to: EditOpDiff.seconds(min(project.source.durationUs, marker.us + 2_500_000)),
                    text: String("\(index + 1). \(marker.label)".prefix(200))))
            }
            guard !ops.isEmpty else {
                show("No new marker titles in the kept movie.", error: false)
                return
            }
            edit(ops) { [weak self] _, _ in self?.tab = .text }
            return
        }
        movie("titleMarkers", argv: []) { [weak self] result, _ in
            guard let self else { return }
            switch result {
            case .success:
                self.tab = .text
                self.show("Added the step titles; ⌘Z takes them back.", error: false)
            case let .failure(failure): self.show(failure.reason, error: false)
            }
        }
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

    /// A 3 s arrow, box or circle from the playhead; the service places it where the pointer is then (an arrow
    /// points at it, a box or circle goes round it), else in the middle.
    func addShape(_ kind: EditProject.ShapeKind, atOutput outUs: Int64? = nil, durationUs: Int64 = 3_000_000, lane: String? = nil) {
        let start = TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project)
        let op = EditOp.Shape(from: EditOpDiff.seconds(start), to: EditOpDiff.seconds(start + durationUs), kind: kind, lane: lane)
        edit([.shape(op)]) { [weak self] before, after in
            guard let self, let id = Self.addedID(before, after, { ($0.shapes ?? []).map(\.id) }) else { return }
            self.selectedShape = id
            self.tab = .text
        }
    }

    func updateShape(_ id: String, _ change: (inout EditProject.Shape) -> Void) {
        self.change { project in
            guard var list = project.shapes, let index = list.firstIndex(where: { $0.id == id }) else { return }
            change(&list[index])
            project.shapes = list
        }
    }

    /// The shape starts at the playhead and keeps its length.
    func moveShapeStart(_ id: String) {
        edit([.retime(EditOp.Retime(id: id, at: playheadSourceSeconds))])
    }

    func deleteShape(_ id: String) {
        if selectedShape == id { selectedShape = nil }
        edit([.unshape(EditOp.Unshape(id: id))])
    }

    func updateText(_ id: String, _ change: (inout EditProject.TextNote) -> Void) {
        self.change { project in
            guard var list = project.texts, let index = list.firstIndex(where: { $0.id == id }) else { return }
            change(&list[index])
            project.texts = list
        }
    }

    func deleteText(_ id: String) {
        if selectedText == id { selectedText = nil }
        edit([.untext(EditOp.Untext(id: id))])
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
    private(set) var recordingMarkers: [(us: Int64, label: String)] = []

    /// Every marker, the recording's and the edit's own (`markers` in edit.json), in source order: the marks lane, the
    /// step titles and the chapters read both, as `markersOf` does.
    var markers: [(us: Int64, label: String, id: String?)] {
        let recorded = recordingMarkers.map { (us: $0.us, label: $0.label, id: Optional<String>.none) }
        let edited = (project.markers ?? []).map { (us: $0.atUs, label: $0.label, id: Optional($0.id)) }
        return edited.isEmpty ? recorded : (recorded + edited).sorted { $0.us < $1.us }
    }

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
    /// The range dragged on the frames lane (output microseconds); its popover offers what to do with it.
    var timelineRange: TimelineRange?

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
        let op = EditOp.RangeAction(from: EditOpDiff.seconds(part.fromUs), to: EditOpDiff.seconds(part.toUs), action: "cut")
        edit([.range(op)], then: { [weak self] _, _ in
            guard let self else { return }
            self.clearPart()
            self.seek(part.fromUs)
            self.show("Cut \(formatClock(part.toUs - part.fromUs, tenths: true)); ⌘Z puts it back.", error: false)
        }, failed: { [weak self] reason in
            self?.show("Nothing was cut: \(reason)", error: false)
        })
    }

    /// Keeps only what plays between I and O.
    func keepPart() {
        guard let part = exportPart else {
            show("Set a part with I and O first.", error: false)
            return
        }
        let op = EditOp.RangeAction(from: EditOpDiff.seconds(part.fromUs), to: EditOpDiff.seconds(part.toUs), action: "keep")
        edit([.range(op)]) { [weak self] _, _ in
            self?.clearPart()
            self?.seek(0)
        }
    }

    /// A 3 s spotlight from the playhead: on the pointer when the recording has a cursor track, else in the middle.
    func addSpotlight(atOutput outUs: Int64? = nil, durationUs: Int64 = 3_000_000, lane: String? = nil) {
        addRedaction(rect: CGRect(x: 0.4, y: 0.4, width: 0.2, height: 0.2), style: .spotlight, follow: cursor != nil,
                     atOutput: outUs, durationUs: durationUs, lane: lane)
    }

    /// Hides a part of the picture (the middle, or a rectangle drawn on the preview, 0...1 of the source) for 3 s from
    /// the playhead; the Hide tab then moves and sizes it.
    func addRedaction(rect: CGRect = CGRect(x: 0.35, y: 0.42, width: 0.3, height: 0.16), style: EditProject.RedactionStyle = .blur,
                      follow: Bool = false, atOutput outUs: Int64? = nil, durationUs: Int64 = 3_000_000, lane: String? = nil) {
        let start = TimelineMap.sourceTime(atOutput: outUs ?? clock.outUs, in: project)
        let from = EditOpDiff.seconds(start), to = EditOpDiff.seconds(start + durationUs)
        let op: EditOp = style == .spotlight
            ? .spotlight(EditOp.Spotlight(from: from, to: to, rect: EditOp.Rect(rect), follow: follow ? true : nil, lane: lane))
            : .redact(EditOp.Redact(from: from, to: to, rect: EditOp.Rect(rect), style: style, follow: follow ? true : nil, lane: lane))
        edit([op]) { [weak self] before, after in
            guard let self, let id = Self.addedID(before, after, { ($0.redactions ?? []).map(\.id) }) else { return }
            self.selectedRedaction = id
            self.tab = .hide
        }
    }

    func updateRedaction(_ id: String, _ change: (inout EditProject.Redaction) -> Void) {
        self.change { project in
            guard var list = project.redactions, let index = list.firstIndex(where: { $0.id == id }) else { return }
            change(&list[index])
            project.redactions = list
        }
    }

    func deleteRedaction(_ id: String) {
        if selectedRedaction == id { selectedRedaction = nil }
        edit([.unredact(EditOp.Unredact(id: id))])
    }

    func updateZoom(_ id: String, _ change: (inout EditProject.Zoom) -> Void) {
        self.change { project in
            guard let index = project.zooms.firstIndex(where: { $0.id == id }) else { return }
            change(&project.zooms[index])
        }
    }

    func applyScaleToAll(_ scale: Double) {
        change { project in
            for index in project.zooms.indices { project.zooms[index].scale = scale }
        }
    }

    /// A zoom moved or resized in time (a drag, ⌥← and ⌥→); the service keeps it clear of its neighbours.
    func moveZoom(_ id: String, startUs: Int64, endUs: Int64) {
        continuous("zoom-time:\(id)", [.retime(EditOp.Retime(id: id, from: EditOpDiff.seconds(startUs), to: EditOpDiff.seconds(endUs)))])
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

    /// A clip edge dragged (source microseconds); the service holds it inside the movie and a frame long.
    func trimClip(_ id: String, fromUs: Int64? = nil, toUs: Int64? = nil) {
        continuous("clip-edge:\(id)", [.trim(EditOp.Trim(clip: id, from: fromUs.map(EditOpDiff.seconds), to: toUs.map(EditOpDiff.seconds)))])
    }

    func setSpeed(_ id: String, _ speed: Double) {
        edit([.clipSpeed(EditOp.ClipSpeed(clip: id, factor: speed))])
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
        self.change { change(&$0.audio) }
    }

    /// The looks (frame and click highlight): drawn per frame from the project, so no movie rebuild.
    func setLooks(_ change: (inout EditProject) -> Void) {
        self.change(change)
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
        self.change { change(&$0.export) }
    }

    /// One zoom on every click of the cursor track (the `autoZoom` op): clicks closer than 3 s share a zoom, which
    /// starts 0.6 s before its first click and holds 1.6 s after its last; the manual zooms stay.
    func autoZoom() {
        let clicks = cursor?.clicks.count ?? 0
        edit([.autoZoom(EditOp.AutoZoom())], then: { [weak self] _, after in
            let added = after.zooms.filter { $0.mode == .follow }.count
            self?.show("Added \(Plural.count(added, "zoom")) from \(Plural.count(clicks, "click")).", error: false)
        }, failed: { [weak self] reason in
            self?.show(reason, error: false)
        })
    }

    // MARK: - Movie

    func rebuild() {
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
                self.previewProblem = nil
                self.seek(min(keep, self.durationUs))
            } catch {
                span.end()
                guard !(error is CancellationError), !Task.isCancelled, let self else { return }
                self.previewFailed(error)
            }
        }
    }

    /// Reads the movie again after something wrote a new one in its place (a display switch makes a new proxy).
    func reloadMovie() {
        let video = URL(fileURLWithPath: project.source.video)
        asset = AVURLAsset(url: video)
        filmstrip.load(video: video, durationUs: project.source.durationUs)
        waveform.load(video: video)
        rebuild()
    }

    /// A paused player draws a changed zoom only when asked for the frame again.
    func refreshFrame() {
        guard player.rate == 0 else { return }
        player.seek(to: EditRenderer.us(clock.outUs), toleranceBefore: .zero, toleranceAfter: .zero)
    }

    struct ApplyFailure: Error {
        let reason: String
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
        movie("transcript", argv: ["transcribe", project.source.video, "--format", "json", "-o", cache], timeout: 60 * 60) { [weak self] result, _ in
            guard let self else { return }
            self.isTranscribing = false
            if case let .failure(failure) = result {
                self.show("The transcription failed: \(failure.reason)", error: true)
                return
            }
            guard self.zoom.reloadCaptions() else {
                self.show("The transcription failed: no transcript was written", error: true)
                return
            }
            self.hasTranscript = true
            self.lineWords = nil
            self.setLooks { $0.captions = $0.captions ?? EditProject.Captions() }
            self.show("Captions are on.", error: false)
        }
    }

    private(set) var isMarkingClicks = false

    /// The circles Circle Every Click made: a circle that starts within 0.1 s of a recorded click (whether the Remove
    /// button shows; the `removeClickCircles` op decides what goes).
    var clickCircles: [EditProject.Shape] {
        let clicks = (cursor?.clicks ?? []).map { Int64(($0.ms * 1000).rounded()) }
        return (project.shapes ?? []).filter { shape in
            shape.kind == .circle && clicks.contains { abs($0 - shape.startUs) <= 100_000 }
        }
    }

    /// Takes every click circle out in one undo step; other shapes stay.
    func removeClickCircles() {
        edit([.removeClickCircles(EditOp.RemoveClickCircles())]) { [weak self] before, after in
            guard let self else { return }
            let removed = (before.shapes?.count ?? 0) - (after.shapes?.count ?? 0)
            if let selected = self.selectedShape, !(after.shapes ?? []).contains(where: { $0.id == selected }) { self.selection = .none }
            self.show("Removed \(Plural.count(removed, "click circle")); ⌘Z puts them back.", error: false)
        }
    }

    /// A circle at every recorded click (the `annotateClicks` op, the REPL's annotateClicks), one ⌘Z away.
    func markClicks() {
        guard !isMarkingClicks else { return }
        isMarkingClicks = true
        edit([.annotateClicks(EditOp.AnnotateClicks())], then: { [weak self] before, after in
            guard let self else { return }
            self.isMarkingClicks = false
            let added = (after.shapes?.count ?? 0) - (before.shapes?.count ?? 0)
            self.tab = .text
            let both = after.clicks?.highlight == true
                ? " Click rings are on too (Cursor and Clicks), so each click shows two rings." : ""
            self.show(added > 0 ? "Circled \(Plural.count(added, "click")); ⌘Z takes them back.\(both)" : "Every click has its circle already.",
                      error: false)
        }, failed: { [weak self] reason in
            self?.isMarkingClicks = false
            self?.show(reason, error: true)
        })
    }

    /// Replaces a word or phrase in every caption line (the REPL's replaceWords on the service, else
    /// `tools recorder replace-words`), one ⌘Z away.
    func replaceWords(find: String, replace: String) {
        let find = find.trimmingCharacters(in: .whitespaces)
        guard !find.isEmpty else { return }
        movie("replaceWords", ["find": find, "replace": replace],
              argv: ["recorder", "replace-words", store.url.path, "--find", find, "--replace", replace]) { [weak self] result, _ in
            guard let self else { return }
            switch result {
            case let .success(value):
                let count = ((value as? [String: Any])?["replaced"] as? [Any])?.count
                self.show("“\(find)” → “\(replace)”: \(count.map { Plural.count($0, "line") + " changed" } ?? "replaced").", error: false)
            case let .failure(failure): self.show(failure.reason, error: true)
            }
        }
    }

    /// The loudness `normalize` measured at volume 1, in LUFS; nil until it ran in this window.
    var measuredLufs: Double?

    /// Sets the volume so the export reaches -16 LUFS (the `normalize` op measures the movie).
    func normalizeLoudness() {
        guard !isNormalizing else { return }
        isNormalizing = true
        show("Measuring the loudness…", error: false)
        applyOps(EditOp.json([.normalize(EditOp.Normalize())])) { [weak self] result in
            guard let self else { return }
            self.isNormalizing = false
            if case let .failure(failure) = result {
                self.show("The volume is unchanged: \(failure.reason)", error: true)
                return
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
        isRemovingIdle = true
        show("Looking for parts where nothing moves and nothing is heard…", error: false)
        let minSeconds = UserDefaults.standard.object(forKey: Self.idleMinKey) as? Double ?? 2
        let op = EditOp.RemoveIdle(minSeconds: minSeconds, speed: speed.map(Double.init))
        applyOps(EditOp.json([.removeIdle(op)])) { [weak self] result in
            guard let self else { return }
            self.isRemovingIdle = false
            switch result {
            case let .success(saved):
                let verb = speed.map { "Sped up the still, silent parts \($0)×, saving" } ?? "Removed"
                self.show(saved > 0 ? "\(verb) \(formatClock(saved, tenths: true)) of still, silent parts; ⌘Z brings them back."
                                    : "No still, silent part of \(Int(minSeconds)) s or more was found.", error: false)
            case let .failure(failure): self.show("Nothing was cut: \(failure.reason)", error: true)
            }
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

    /// Where an export renders: an MP4 here (fast, with progress and Cancel), unless the sound is cleaned, which only
    /// `tools recorder export` does (`withDenoisedSource` in src/recorder/lib/edit.ts); a GIF or WebM always there.
    enum ExportRoute: Equatable {
        case window
        case tools(EditProject.ExportFormat)
    }

    nonisolated static func exportRoute(_ project: EditProject) -> ExportRoute {
        let format = project.export.format ?? .mp4
        return format != .mp4 || project.audio.denoise != nil ? .tools(format) : .window
    }

    func export() {
        guard exportProgress == nil, !exportWaiting else { return }
        exportWaiting = true
        afterGesturesSaved { [weak self] saved in
            guard let self else { return }
            self.exportWaiting = false
            if saved { self.exportSavedProject() }
        }
    }

    private func exportSavedProject() {
        let project = project
        if case let .tools(format) = Self.exportRoute(project) {
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
    /// step the CLI and the REPL run); an export through `tools recorder export` (a GIF, a WebM, an MP4 with cleaned
    /// sound) gets it from that command itself.
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
        let action: Action?
        /// The action's ops as JSON for `tools recorder apply`, kept from the check's answer as it came.
        var actionOps: String?
        var id: String { item + message }
        var mustFix: Bool { severity == "fix" }

        enum CodingKeys: String, CodingKey {
            case severity, item, message, fix, at, target, action
        }

        struct Action: Decodable, Equatable {
            let label: String
        }

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
    /// Runs every fix the check offers in one save and one undo step (`tools recorder fix`, the REPL's movie.fix()).
    func fixAll() {
        movie("fix", argv: ["recorder", "fix", store.url.path]) { [weak self] result, stdout in
            guard let self else { return }
            switch result {
            case let .success(value):
                // The answer counts what it fixed, a fix that made a new issue and its fix included.
                let fixed = ((value as? [String: Any])?["fixed"] as? [Any])?.count
                    ?? stdout.split(separator: "\n").last.flatMap { line in
                        (try? JSONSerialization.jsonObject(with: Data(line.utf8)) as? [String: Any])?["fixed"] as? [Any]
                    }?.count
                self.show(Self.fixAllNotice(fixed: fixed), error: false)
            case let .failure(failure): self.show("Fix All did not work: \(failure.reason)", error: true)
            }
        }
    }

    /// What Fix All says: the count it fixed, or that no fix changed the edit (nothing was saved, so ⌘Z has nothing).
    nonisolated static func fixAllNotice(fixed: Int?) -> String {
        switch fixed {
        case 0?: "Nothing to fix: no fix the check offers changes the edit."
        case let count?: "Fixed \(Plural.count(count, "thing")). ⌘Z undoes them all."
        case nil: "Fixed. ⌘Z undoes it."
        }
    }

    /// What an issue's action says once it ran: done, or that the edit stayed the same (no new undo step).
    nonisolated static func actionNotice(label: String, changed: Bool) -> String {
        changed ? "\(label): done. ⌘Z undoes it." : "\(label) changed nothing."
    }

    /// Runs the edit ops the check gave an issue (`tools recorder apply`, the REPL's fix), then takes the saved edit,
    /// so ⌘Z undoes it as one step.
    func runAction(_ issue: EditIssue) {
        guard let ops = issue.actionOps, let label = issue.action?.label else { return }
        let revision = project.revision
        applyOps(ops) { [weak self] result in
            guard let self else { return }
            if case let .failure(failure) = result {
                self.show("\(label) did not work: \(failure.reason)", error: true)
                return
            }
            if let selection = issue.selection { self.selection = selection }
            self.show(Self.actionNotice(label: label, changed: self.project.revision != revision), error: false)
        }
    }

    func remove(_ issue: EditIssue) {
        guard let selection = issue.selection else { return }
        self.selection = selection
        deleteSelection()
    }

    nonisolated private struct CheckAnswer: Decodable {
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
        movie("check", argv: ["recorder", "check", store.url.path], timeout: 60) { [weak self] result, stdout in
            guard let self, self.project.revision == revision else { return }
            let data: Data? = switch result {
            case let .success(value?) where JSONSerialization.isValidJSONObject(value): try? JSONSerialization.data(withJSONObject: value)
            case .success: stdout.split(separator: "\n").last.flatMap { $0.data(using: .utf8) }
            case .failure: nil
            }
            guard let data, let issues = Self.issues(fromCheck: data) else {
                if case let .failure(failure) = result { HubPerf.log("recorder.check failed: \(failure.reason)") }
                self.checkedRevision = nil
                return
            }
            self.issues = issues
            self.issuesRevision = revision
        }
    }

    /// The issues of a `tools recorder check` answer. Each action's ops go back to `tools recorder apply` as they
    /// came, so they are kept as raw JSON beside the decoded issue.
    nonisolated static func issues(fromCheck data: Data) -> [EditIssue]? {
        guard let answer = try? JSONDecoder().decode(CheckAnswer.self, from: data) else { return nil }
        let raw = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["issues"] as? [[String: Any]]
        return answer.issues.enumerated().map { index, issue in
            var issue = issue
            let entry = raw.flatMap { index < $0.count ? $0[index] : nil }
            if let ops = (entry?["action"] as? [String: Any])?["ops"],
               let opsData = try? JSONSerialization.data(withJSONObject: ops, options: [.sortedKeys]) {
                issue.actionOps = String(data: opsData, encoding: .utf8)
            }
            return issue
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

    /// A GIF, a WebM or an MP4 with cleaned sound: the CLI renders with this same renderer (from the cleaned copy of
    /// the movie when noise reduction is on) and converts with ffmpeg, then prints `{ ok, path }`.
    private func exportThroughTools(_ format: EditProject.ExportFormat) {
        exportProgress = 0
        show(format == .mp4 ? "Exporting an MP4 with the cleaned sound…" : "Exporting a \(format.title)…", error: false)
        var argv = ["recorder", "export", store.url.path, "--format", format.rawValue, "--json"]
        var params: [String: Any] = ["format": format.rawValue]
        if let part = exportPart {
            argv += ["--from", String(format: "%.3f", Double(part.fromUs) / 1_000_000), "--to", String(format: "%.3f", Double(part.toUs) / 1_000_000)]
            params["from"] = EditOpDiff.seconds(part.fromUs)
            params["to"] = EditOpDiff.seconds(part.toUs)
        }
        movie("export", params, argv: argv, timeout: 60 * 60) { [weak self] result, stdout in
            guard let self else { return }
            self.exportProgress = nil
            let answer: [String: Any]? = switch result {
            case let .success(value?): value as? [String: Any]
            default: (stdout.split(separator: "\n").last.flatMap { $0.data(using: .utf8) })
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            }
            guard let path = answer?["path"] as? String else {
                let reason: String = if case let .failure(failure) = result { failure.reason } else { (answer?["error"] as? String) ?? "no movie was written" }
                self.show("The \(format.title) export failed: \(reason)", error: true)
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
        finishGesture()
        session.stop()
        store.stopWatching()
        commentsStore.stopWatching()
        player.pause()
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
    }
}

// MARK: - Preview problem

/// Why the preview shows no picture, in the editor's words: what happened, what to do, and the system's own text for
/// the Details disclosure.
struct PreviewProblem: Equatable {
    let title: String
    let advice: String
    let detail: String
}

extension EditorModel {
    /// The preview could not be built: the old picture goes, the reason shows in its place, and VoiceOver hears it.
    func previewFailed(_ error: Error) {
        HubPerf.log("recorder.editor.render failed: \(error.localizedDescription)")
        player.pause()
        player.replaceCurrentItem(with: nil)
        let problem = Self.previewProblem(error, video: project.source.video,
                                          fileExists: FileManager.default.fileExists(atPath: project.source.video))
        previewProblem = problem
        AccessibilityNotification.Announcement("\(problem.title). \(problem.advice)").post()
    }

    /// Reads the movie again and builds the preview anew (the Try Again button).
    func retryPreview() {
        previewProblem = nil
        reloadMovie()
    }

    /// Each cause its own sentence. AVFoundation answers a cut-short or damaged file with "Cannot Open" (-11829) or
    /// "unknown error" (-11800), which say nothing to a person, so they go to Details only.
    nonisolated static func previewProblem(_ error: Error, video: String, fileExists: Bool) -> PreviewProblem {
        let name = URL(fileURLWithPath: video).lastPathComponent
        let nsError = error as NSError
        var detail = "\(error.localizedDescription) (\(nsError.domain) \(nsError.code))"
        if let reason = nsError.localizedFailureReason { detail += "\n\(reason)" }
        if let underlying = nsError.userInfo[NSUnderlyingErrorKey] as? NSError {
            detail += "\n\(underlying.localizedDescription) (\(underlying.domain) \(underlying.code))"
        }
        detail += "\n\(video)"
        guard fileExists else {
            return PreviewProblem(title: "The movie file is missing", advice: "\(name) was moved or deleted. Put it back, then try again.",
                                  detail: detail)
        }
        switch error as? EditRenderer.RenderError {
        case .noVideoTrack:
            return PreviewProblem(title: "This movie has no picture", advice: "\(name) holds no video track, so there is nothing to show.",
                                  detail: detail)
        case .emptyEdit:
            return PreviewProblem(title: "The edit keeps nothing of the movie", advice: "Every part is cut. ⌘Z brings the last cut back.",
                                  detail: detail)
        case .badComposition:
            return PreviewProblem(title: "The preview cannot show this movie",
                                  advice: "Its frame rate or picture size is not one the preview can play.", detail: detail)
        case nil:
            return PreviewProblem(title: "This movie cannot be read",
                                  advice: "\(name) may be cut short, damaged or still being written. Try again once it is complete.",
                                  detail: detail)
        }
    }
}
