import AVFoundation
import AppKit
import Observation

/// The playhead, kept apart from the model so that only the views that show the time re-render 30 times a second
/// while a movie plays (the transport's clock and the timeline's red line), never the inspector or the lanes.
@MainActor
@Observable
final class PlayheadClock {
    var outUs: Int64 = 0
}

enum EditorSelection: Equatable {
    case none
    case clip(String)
    case zoom(String)
}

enum InspectorTab: String, CaseIterable, Identifiable {
    case zoom, clip, hide, style, audio, export
    var id: String { rawValue }

    var symbol: String {
        switch self {
        case .zoom: "plus.magnifyingglass"
        case .clip: "scissors"
        case .hide: "eye.slash"
        case .style: "paintpalette"
        case .audio: "speaker.wave.2"
        case .export: "square.and.arrow.up"
        }
    }

    var title: String {
        switch self {
        case .zoom: "Zoom"
        case .clip: "Clip and speed"
        case .hide: "Hide parts"
        case .style: "Style"
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

    var title: String { URL(fileURLWithPath: project.source.video).lastPathComponent }
    var durationUs: Int64 { project.outputDurationUs }

    // MARK: - Playback

    func togglePlay() {
        if player.rate != 0 {
            player.pause()
            logPlayback()
        } else {
            if clock.outUs >= durationUs - 20_000 { seek(0) }
            player.play()
        }
        isPlaying = player.rate != 0
    }

    /// The preview's own frame counts for the run that just paused (the player item's access log): how smooth the
    /// zoomed preview played, read with `rg recorder.editor.playback ~/.genesis-tools/logs/app-perf.log`.
    private func logPlayback() {
        guard let event = player.currentItem?.accessLog()?.events.last else { return }
        HubPerf.log("recorder.editor.playback watched \(String(format: "%.1f", event.durationWatched)) s, dropped \(event.numberOfDroppedVideoFrames) frames, stalls \(event.numberOfStalls), \(project.source.width)×\(project.source.height) source, \(project.zooms.count) zooms")
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

    /// The redaction the Hide tab edits.
    var selectedRedaction: String?

    /// Hides the middle of the picture for 3 s from the playhead; the Hide tab then moves and sizes it.
    func addRedaction() {
        let start = TimelineMap.sourceTime(atOutput: clock.outUs, in: project)
        let end = min(project.source.durationUs, start + 3_000_000)
        guard end - start >= 100_000 else {
            show("The playhead is at the end of the recording; move it back to hide a part.", error: false)
            return
        }
        let id = "r" + UUID().uuidString.prefix(8).lowercased()
        var next = project
        next.redactions = (next.redactions ?? []) + [EditProject.Redaction(id: id, startUs: start, endUs: end, x: 0.35, y: 0.42,
                                                                           width: 0.3, height: 0.16)]
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

    /// The drawn cursor's settings; a project without them starts from the defaults.
    func setCursor(_ change: (inout EditProject.Cursor) -> Void) {
        setLooks { project in
            var cursor = project.cursor ?? EditProject.Cursor()
            change(&cursor)
            project.cursor = cursor
        }
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

    func removeIdle() {
        guard !isRemovingIdle else { return }
        saveTask?.cancel()
        saveNow()
        isRemovingIdle = true
        show("Looking for parts where nothing moves and nothing is heard…", error: false)
        let before = durationUs
        ToolsRunner.run(["recorder", "apply", store.url.path, #"{"op":"removeIdle"}"#]) { [weak self] status, _, stderr in
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
            self.show(saved > 0 ? "Removed \(formatClock(saved, tenths: true)) of still, silent parts; ⌘Z brings them back."
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
        let url = EditExporter.outputURL(for: project)
        exportProgress = 0
        Task { [weak self] in
            do {
                let result = try await EditExporter.export(project: project, to: url) { progress in
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

    private func reveal(_ url: URL) {
        let reveal = UserDefaults.standard.object(forKey: Self.revealAfterExportKey) as? Bool ?? true
        if reveal { NSWorkspace.shared.activateFileViewerSelecting([url]) }
    }

    /// A GIF or WebM: the CLI renders with this same renderer and converts with ffmpeg, then prints `{ ok, path }`.
    private func exportThroughTools(_ format: EditProject.ExportFormat) {
        exportProgress = 0
        show("Exporting a \(format.rawValue.uppercased())…", error: false)
        ToolsRunner.run(["recorder", "export", store.url.path, "--format", format.rawValue, "--json"]) { [weak self] status, stdout, stderr in
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
