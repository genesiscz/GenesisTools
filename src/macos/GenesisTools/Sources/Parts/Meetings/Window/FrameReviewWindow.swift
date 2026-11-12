import AppKit
import Observation
import SwiftUI

/// The shared frame browser opened from the Screen tab and the playback preview.
@MainActor
final class FrameReviewWindow: NSObject, NSWindowDelegate {
    private static var open: [String: FrameReviewWindow] = [:]
    private let model: FrameReviewModel
    private let window: NSWindow
    private var loadTask: Task<Void, Never>?

    static func show(meeting: String, file: String, at: Double, player: MomentPlayer?,
                     defaults: UserDefaults = .standard, timeline: ScreenTimeline? = nil, duration: Double? = nil, text: Bool = false) {
        if let existing = open[meeting] {
            existing.model.player = player
            existing.model.sourceDuration = duration ?? existing.model.sourceDuration
            existing.model.open(file: file, at: at)
            if text { existing.model.textVisible = true }
            existing.window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let controller = FrameReviewWindow(meeting: meeting, file: file, at: at, player: player,
                                           defaults: defaults, timeline: timeline, duration: duration, text: text)
        open[meeting] = controller
        controller.window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private init(meeting: String, file: String, at: Double, player: MomentPlayer?,
                 defaults: UserDefaults, timeline: ScreenTimeline?, duration: Double?, text: Bool) {
        model = FrameReviewModel(meeting: meeting, file: file, at: at, player: player, defaults: defaults, timeline: timeline)
        model.sourceDuration = duration ?? 0
        model.textVisible = text
        let visible = NSApp.keyWindow?.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? CGRect(x: 0, y: 0, width: 1440, height: 900)
        let size = CGSize(width: min(1400, visible.width * 0.9), height: min(950, visible.height * 0.9))
        window = NSWindow(contentRect: CGRect(origin: .zero, size: size),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        super.init()
        window.title = "Screen recording · \(meeting)"
        window.minSize = NSSize(width: 800, height: 520)
        window.isReleasedWhenClosed = false
        window.tabbingMode = .disallowed
        window.delegate = self
        window.contentView = NSHostingView(rootView: FrameReviewView(model: model) { [weak self] in self?.window.performClose(nil) })
        window.setFrameOrigin(NSPoint(x: visible.midX - size.width / 2, y: visible.midY - size.height / 2))
        if !window.setFrameUsingName("GenesisToolsFrameReview") { window.setContentSize(size) }
        window.setFrameAutosaveName("GenesisToolsFrameReview")
        loadTask = Task { await model.load() }
    }

    func windowWillClose(_ notification: Notification) {
        loadTask?.cancel()
        model.cancelPendingSeek()
        Self.open.removeValue(forKey: model.meeting)
    }
}

@Observable
@MainActor
final class FrameReviewModel {
    struct Match: Identifiable {
        let frame: TimelineFrame
        let line: OcrBox
        let lineIndex: Int
        var id: String { "\(frame.file)#\(lineIndex)" }
    }
    let meeting: String
    let defaults: UserDefaults
    weak var player: MomentPlayer?
    var timeline: Loadable<ScreenTimeline> = .idle
    var frame: TimelineFrame?
    var time: Double
    var display: Int?
    var textVisible = false
    var sourceDuration: Double = 0
    var query = "" { didSet { if oldValue != query { search() } } }
    private(set) var matches: [Match] = []
    private(set) var matchIndex = 0
    @ObservationIgnored private var requestedFile: String
    @ObservationIgnored private var seekTask: Task<Void, Never>?
    @ObservationIgnored private var index: [(folded: String, match: Match)] = []

    init(meeting: String, file: String, at: Double, player: MomentPlayer?, defaults: UserDefaults,
         timeline: ScreenTimeline? = nil) {
        self.meeting = meeting
        requestedFile = file
        time = at
        self.player = player
        self.defaults = defaults
        if let timeline { accept(timeline) }
    }

    var frames: [TimelineFrame] {
        (timeline.value?.frames ?? []).filter { display == nil || $0.displayId == display }
    }
    var duration: Double {
        max(1, sourceDuration, timeline.value?.frames.map(\.meetingSec).max() ?? 0,
            player?.timeline.durationSec(meeting, fallback: nil) ?? 0)
    }
    var selectedMatch: Match? { matches.indices.contains(matchIndex) ? matches[matchIndex] : nil }

    func open(file: String, at: Double) {
        requestedFile = file
        time = at
        if let selected = timeline.value?.frames.first(where: { $0.file == file }) {
            display = selected.displayId
            frame = selected
        }
    }

    func load() async {
        timeline = .loading(previous: timeline.value)
        do {
            let value = try await MeetingsRead.service(MeetingsAPI.MeetingTimeline.self, .init(meeting: meeting, all: true),
                                                       orRun: ["screen", meeting, "--timeline", "--all", "--json"], timeoutSeconds: 120).run()
            guard !Task.isCancelled else { return }
            accept(value)
        } catch {
            if !Task.isCancelled { timeline = .failed(asFailure(error), previous: timeline.value) }
        }
    }

    private func accept(_ value: ScreenTimeline) {
        timeline = .loaded(value)
        index = value.frames.flatMap { frame in
            (frame.lines ?? frame.changed).enumerated().map { offset, line in
                (Self.fold(line.text), Match(frame: frame, line: line, lineIndex: offset))
            }
        }
        if let selected = value.frames.first(where: { $0.file == requestedFile }) {
            frame = selected
            display = selected.displayId
        } else {
            frame = Self.nearest(in: frames, at: time)
        }
        search()
    }

    static func nearest(in frames: [TimelineFrame], at time: Double) -> TimelineFrame? {
        frames.last(where: { $0.meetingSec <= time }) ?? frames.first
    }

    static func fold(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }

    private func search() {
        seekTask?.cancel()
        let wanted = Self.fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        matches = wanted.isEmpty ? [] : index.filter { $0.folded.contains(wanted) }.map(\.match)
        matchIndex = 0
        if let match = matches.first { show(match) }
    }

    func nextMatch(_ delta: Int) {
        guard !matches.isEmpty else { return }
        matchIndex = (matchIndex + delta + matches.count) % matches.count
        show(matches[matchIndex])
    }

    func chooseMatch(_ match: Match) {
        matchIndex = matches.firstIndex(where: { $0.id == match.id }) ?? 0
        show(match)
    }

    private func show(_ match: Match) {
        display = match.frame.displayId
        frame = match.frame
        requestedFile = match.frame.file
        time = match.frame.meetingSec
    }

    func selectTime(_ next: Double) {
        time = min(max(0, next), duration)
        frame = Self.nearest(in: frames, at: time)
        if let frame { requestedFile = frame.file }
    }

    func step(_ delta: Int, seek: Bool) {
        guard let frame, let position = frames.firstIndex(where: { $0.file == frame.file }) else { return }
        let next = min(max(0, position + delta), frames.count - 1)
        selectTime(frames[next].meetingSec)
        if seek { seekPlayback() }
    }

    func cancelPendingSeek() {
        seekTask?.cancel()
        seekTask = nil
    }

    func scheduleSeek() {
        seekTask?.cancel()
        seekTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard !Task.isCancelled else { return }
            self?.seekPlayback()
        }
    }

    func seekPlayback() {
        seekTask?.cancel()
        guard let player, player.meeting == meeting, player.isActive else { return }
        let playing = player.phase == .playing
        if player.top?.contains(time) == true, playing || player.phase == .paused {
            player.seek(to: time)
        } else {
            player.playMeeting(meeting, at: time, from: .outside, paused: !playing)
        }
    }

    func playPause() {
        guard let player else { return }
        if player.meeting == meeting, player.phase == .playing {
            player.togglePause()
        } else {
            player.playMeeting(meeting, at: time, from: .outside)
        }
    }
}

private struct FrameReviewView: View {
    @Bindable var model: FrameReviewModel
    let close: () -> Void
    @State private var zoom = 1.0
    @State private var scope = MeetingsPreferences.TimelineLines.all
    @FocusState private var searchFocused: Bool
    @AppStorage(MeetingsPreferences.Panes.frameBoxes.key) private var boxes = true
    @AppStorage(MeetingsPreferences.Panes.frameSeek.key) private var seek = true

    init(model: FrameReviewModel, close: @escaping () -> Void) {
        self.model = model
        self.close = close
        _boxes = AppStorage(wrappedValue: MeetingsPreferences.Panes.frameBoxes.defaultValue,
                            MeetingsPreferences.Panes.frameBoxes.key, store: model.defaults)
        _seek = AppStorage(wrappedValue: MeetingsPreferences.Panes.frameSeek.defaultValue,
                           MeetingsPreferences.Panes.frameSeek.key, store: model.defaults)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar.padding(12)
            Divider()
            HStack(spacing: 0) {
                if let frame = model.frame {
                    FrameReviewImage(frame: frame, zoom: zoom, boxes: boxes ? (scope == .all ? frame.lines ?? frame.changed : frame.changed) : [],
                                     match: model.selectedMatch?.frame.file == frame.file ? model.selectedMatch?.line : nil)
                } else {
                    LoadablePane(state: model.timeline, reading: "Reading screen recording…", retry: { Task { await model.load() } }) { _ in
                        Text("This recording has no available frame.").foregroundStyle(.secondary)
                    }
                }
                if model.textVisible || !model.query.isEmpty {
                    Divider()
                    textPane.frame(width: 300)
                }
            }
            Divider()
            transport.padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .background { FrameReviewPlaybackFollower(model: model, enabled: seek) }
        .onExitCommand { if model.query.isEmpty { close() } else { model.query = "" } }
        .background {
            Button("Find OCR") { searchFocused = true }.keyboardShortcut("f", modifiers: .command).hidden()
        }
        .onAppear { searchFocused = model.textVisible }

    }

    private var toolbar: some View {
        VStack(alignment: .leading, spacing: 8) {
        HStack(spacing: 10) {
            Text(model.frame.map { "Frame at \(MeetingsFormat.clock($0.meetingSec))" } ?? "Screen recording").font(.headline)
            if let displays = model.timeline.value?.displays, displays.count > 1 {
                Picker("Display", selection: Binding(get: { model.display ?? -1 }, set: { model.display = $0 == -1 ? nil : $0; model.selectTime(model.time) })) {
                    Text("All displays").tag(-1)
                    ForEach(displays.indices, id: \.self) { index in
                        Text(displays[index].name ?? "Display \(displays[index].id ?? 0)").tag(displays[index].id ?? -1)
                    }
                }.frame(maxWidth: 180)
            }
            Toggle("Boxes", isOn: $boxes).toggleStyle(.checkbox).accessibilityIdentifier("meetings.frame-review.boxes")
            if boxes {
                Picker("Box scope", selection: $scope) { Text("Changed").tag(MeetingsPreferences.TimelineLines.changed); Text("All").tag(MeetingsPreferences.TimelineLines.all) }
                    .labelsHidden().frame(width: 100)
            }
            Spacer(minLength: 4)
            Picker("Zoom", selection: $zoom) { Text("Fit").tag(1.0); Text("150%").tag(1.5); Text("200%").tag(2.0); Text("400%").tag(4.0) }
                .frame(width: 115)
            Toggle("Text", isOn: $model.textVisible).toggleStyle(.button)
        }
        HStack(spacing: 8) {
            TextField("Search all OCR", text: $model.query).textFieldStyle(.roundedBorder).frame(minWidth: 160, maxWidth: 400)
                .focused($searchFocused).onSubmit { model.nextMatch(1) }.accessibilityIdentifier("meetings.frame-review.search")
            if !model.query.isEmpty {
                Text(model.matches.isEmpty ? "No matches" : "\(model.matchIndex + 1) / \(model.matches.count)").monospacedDigit().font(.caption)
                Button { model.nextMatch(-1) } label: { Image(systemName: "chevron.up") }.disabled(model.matches.isEmpty).help("Previous match")
                Button { model.nextMatch(1) } label: { Image(systemName: "chevron.down") }.disabled(model.matches.isEmpty).help("Next match")
            }
            Spacer(minLength: 0)
        }
        }
    }

    private var textPane: some View {
        ScrollViewReader { scroll in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                if model.query.isEmpty {
                    ForEach(Array((model.frame?.lines ?? model.frame?.changed ?? []).enumerated()), id: \.offset) { _, box in
                        Text(box.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                } else {
                    ForEach(model.matches) { match in
                        Button { model.chooseMatch(match) } label: {
                            VStack(alignment: .leading, spacing: 3) {
                                Text(MeetingsFormat.clock(match.frame.meetingSec)).font(.caption).foregroundStyle(.secondary)
                                Text(match.line.text).frame(maxWidth: .infinity, alignment: .leading)
                            }.padding(6).background(model.selectedMatch?.id == match.id ? Color.accentColor.opacity(0.16) : .clear)
                        }.buttonStyle(.plain).id(match.id)
                    }
                }
            }.padding(12)
        }
        .accessibilityLabel("OCR text and search results")
        .onChange(of: model.selectedMatch?.id) { _, id in
            if let id { scroll.scrollTo(id, anchor: .center) }
        }
        }
    }

    private var transport: some View {
        HStack(spacing: 10) {
            Button { model.step(-1, seek: seek) } label: { Image(systemName: "backward.end.fill") }.help("Previous frame")
                .accessibilityLabel("Previous frame").accessibilityIdentifier("meetings.frame-review.previous")
                .disabled(model.frame == nil || model.frame?.file == model.frames.first?.file)
            Button { model.playPause() } label: { Image(systemName: model.player?.phase == .playing ? "pause.fill" : "play.fill") }.help("Play or pause at this time")
                .accessibilityLabel(model.player?.phase == .playing ? "Pause playback" : "Play from this frame")
            Button { model.step(1, seek: seek) } label: { Image(systemName: "forward.end.fill") }.help("Next frame")
                .accessibilityLabel("Next frame").accessibilityIdentifier("meetings.frame-review.next")
                .disabled(model.frame == nil || model.frame?.file == model.frames.last?.file)
            Text(MeetingsFormat.clock(model.time)).font(.system(.body, design: .monospaced)).frame(width: 75)
            Slider(value: Binding(get: { model.time }, set: { model.selectTime($0); if seek { model.scheduleSeek() } }), in: 0...model.duration,
                   onEditingChanged: { editing in if !editing, seek { model.seekPlayback() } })
                .accessibilityLabel("Recording time").accessibilityIdentifier("meetings.frame-review.time")
            Text(MeetingsFormat.clock(model.duration)).font(.system(.body, design: .monospaced))
            Toggle("Seek playback", isOn: $seek).toggleStyle(.checkbox)
                .help("Moving time also seeks the active recording; a paused recording stays paused")
            if let frame = model.frame { Button("Show in Finder") { PathOpener.reveal(frame.path) } }
        }
    }
}

/// Isolates the player's frequent clock ticks from the image and OCR results.
private struct FrameReviewPlaybackFollower: View {
    let model: FrameReviewModel
    let enabled: Bool

    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onChange(of: model.player?.position.map { Int($0) }) { _, second in
                guard enabled, model.query.isEmpty, model.player?.meeting == model.meeting,
                      model.player?.phase == .playing, let second else { return }
                model.selectTime(Double(second))
            }
            .accessibilityHidden(true)
    }
}

private struct FrameReviewImage: View {
    let frame: TimelineFrame
    let zoom: Double
    let boxes: [OcrBox]
    let match: OcrBox?
    @State private var image: CGImage?
    @State private var failure: String?

    var body: some View {
        GeometryReader { proxy in
            let fit = min(proxy.size.width / max(1, frame.width), proxy.size.height / max(1, frame.height))
            let scale = fit * zoom
            ScrollView([.horizontal, .vertical]) {
                ZStack(alignment: .topLeading) {
                    if let image {
                        Image(decorative: image, scale: 1).resizable().frame(width: frame.width * scale, height: frame.height * scale)
                    } else {
                        Text(failure ?? "Reading frame…").foregroundStyle(.secondary).frame(width: frame.width * scale, height: frame.height * scale)
                    }
                    ForEach(Array(boxes.enumerated()), id: \.offset) { _, box in outline(box, scale: scale, color: .accentColor, width: 1) }
                    if let match { outline(match, scale: scale, color: .orange, width: 3) }
                }
                .frame(width: frame.width * scale, height: frame.height * scale)
                .frame(minWidth: proxy.size.width, minHeight: proxy.size.height)
            }
        }
        .background(.black.opacity(0.9))
        .task(id: frame.path) {
            image = nil
            failure = nil
            let result = await MediaThumbnailCache.shared.thumbnail(path: frame.path, maxPixels: 4096, kind: .image, ceiling: 4096)
            guard !Task.isCancelled else { return }
            switch result {
            case .ready(let thumbnail): image = thumbnail.image; failure = nil
            case .failed(let message): image = nil; failure = message
            }
        }
    }

    private func outline(_ box: OcrBox, scale: Double, color: Color, width: CGFloat) -> some View {
        Rectangle().strokeBorder(color, lineWidth: width)
            .frame(width: max(1, box.width * scale), height: max(1, box.height * scale))
            .offset(x: box.x * scale, y: box.y * scale)
            .accessibilityLabel(box.text)
            .allowsHitTesting(false)
    }
}
