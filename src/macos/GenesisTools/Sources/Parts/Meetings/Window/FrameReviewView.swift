import AppKit
import SwiftUI

struct FrameReviewView: View {
    @Bindable var model: FrameReviewModel
    let close: () -> Void
    @State private var zoom = 1.0
    @State private var scope = MeetingsPreferences.TimelineLines.all
    @FocusState private var searchFocused: Bool
    @AppStorage(MeetingsPreferences.Panes.frameBoxes.key) private var boxes = true
    @AppStorage(MeetingsPreferences.Panes.frameSeek.key) private var seek = true
    @AppStorage(MeetingsPreferences.Panes.frameFocusSingle.key) private var focusSingle = true

    init(model: FrameReviewModel, close: @escaping () -> Void) {
        self.model = model
        self.close = close
        _boxes = AppStorage(wrappedValue: MeetingsPreferences.Panes.frameBoxes.defaultValue,
                            MeetingsPreferences.Panes.frameBoxes.key, store: model.defaults)
        _focusSingle = AppStorage(wrappedValue: MeetingsPreferences.Panes.frameFocusSingle.defaultValue,
                                  MeetingsPreferences.Panes.frameFocusSingle.key, store: model.defaults)
        _seek = AppStorage(wrappedValue: MeetingsPreferences.Panes.frameSeek.defaultValue,
                           MeetingsPreferences.Panes.frameSeek.key, store: model.defaults)
    }

    var body: some View {
        VStack(spacing: 0) {
            toolbar.padding(12)
            Divider()
            FrameReviewCoverage(model: model)
            HStack(spacing: 0) {
                if let frame = model.previewFrame {
                    FrameReviewImage(frame: frame, neighbors: model.frames(on: frame.displayId), zoom: zoom, scrubbing: model.isScrubbing,
                                     boxes: boxes ? (scope == .all ? frame.lines ?? frame.changed : frame.changed) : [],
                                     query: model.query, highlightedText: model.previewText,
                                     autoFocus: focusSingle && model.matches.count == 1 && model.hoveredMatch == nil)
                } else {
                    LoadablePane(state: model.timeline, reading: "Reading screen recording…", retry: { Task { await model.load() } }) { _ in
                        Text("This recording has no available frame.").foregroundStyle(.secondary)
                    }
                }
                if model.textVisible || !model.query.isEmpty {
                    Divider()
                    FrameReviewDetails(model: model).frame(minWidth: 320, idealWidth: 360, maxWidth: 420)
                        .layoutPriority(-1)
                }
            }
            Divider()
            FrameReviewTransport(model: model, seek: $seek).padding(12)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.background)
        .background { FrameReviewPlaybackFollower(model: model, enabled: seek) }
        .onExitCommand { if model.query.isEmpty { close() } else { model.query = "" } }
        .background { Button("Find text") { searchFocused = true }.keyboardShortcut("f", modifiers: .command).hidden() }
        .onAppear { searchFocused = model.textVisible }
    }

    private var toolbar: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Text(model.previewFrame.map { "\(model.hoveredMatch == nil ? "Frame" : "Preview") at \(MeetingsFormat.clock($0.meetingSec))" } ?? "Screen recording").font(.headline)
                if let displays = model.timeline.value?.displays, displays.count > 1 {
                    Picker("Display", selection: Binding(get: { model.displayChoice }, set: { model.chooseDisplay($0) })) {
                        Text(model.automaticDisplayName.map { "Auto: \($0)" } ?? "Auto").tag(-2)
                        Text("All displays").tag(-1)
                        ForEach(displays.indices, id: \.self) { index in
                            Text(displays[index].name ?? "Display \(displays[index].id ?? 0)").tag(displays[index].id ?? -1)
                        }
                    }.frame(maxWidth: 180)
                        .accessibilityIdentifier("meetings.frame-review.display")
                        .help(model.hasFocusHistory ? "Auto follows the display that had focus during recording."
                                  : "This recording has no display-focus history. Auto keeps the current display.")
                }
                Toggle("Boxes", isOn: $boxes).toggleStyle(.checkbox).accessibilityIdentifier("meetings.frame-review.boxes")
                if boxes {
                    Picker("Box scope", selection: $scope) {
                        Text("Changed").tag(MeetingsPreferences.TimelineLines.changed)
                        Text("All").tag(MeetingsPreferences.TimelineLines.all)
                    }.labelsHidden().frame(width: 100)
                }
                Spacer(minLength: 4)
                Picker("Zoom", selection: $zoom) {
                    Text("Fit").tag(1.0); Text("150%").tag(1.5); Text("200%").tag(2.0); Text("400%").tag(4.0)
                }.frame(width: 115)
                Toggle("Details", isOn: $model.textVisible).toggleStyle(.button)
            }
            HStack(spacing: 8) {
                TextField("Search transcript and screen", text: $model.query).textFieldStyle(.roundedBorder)
                    .frame(minWidth: 150, maxWidth: 400).focused($searchFocused)
                    .onSubmit { model.nextMatch(1) }.accessibilityIdentifier("meetings.frame-review.search")
                Picker("Search in", selection: $model.searchSource) {
                    ForEach(FrameReviewModel.SearchSource.allCases, id: \.self) { source in Text(source.title).tag(source) }
                }.labelsHidden().frame(width: 130).accessibilityIdentifier("meetings.frame-review.source")
                Toggle("Auto-zoom", isOn: $focusSingle).toggleStyle(.checkbox)
                    .help("Zoom to the screen text when a search has one result")
                if model.indexing { ProgressView().controlSize(.small).help("Indexing saved screen text") }
                if !model.query.isEmpty {
                    Text(model.matches.isEmpty ? (model.indexing ? "Indexing…" : "No matches") : "\(model.matchIndex + 1) / \(model.matches.count)")
                        .monospacedDigit().font(.caption).fixedSize()
                    Button { model.nextMatch(-1) } label: { Image(systemName: "chevron.up") }
                        .disabled(model.matches.isEmpty).help("Previous match")
                    Button { model.nextMatch(1) } label: { Image(systemName: "chevron.down") }
                        .disabled(model.matches.isEmpty).help("Next match")
                }
                Spacer(minLength: 0)
            }
        }
    }
}

/// Makes the difference between an audio timeline and its shorter screen capture explicit.
private struct FrameReviewCoverage: View {
    let model: FrameReviewModel
    var body: some View {
        if let last = model.frames.last, model.time > last.meetingSec + 1 {
            Label("Screen capture ends at \(MeetingsFormat.clock(last.meetingSec)). Showing its last available frame.", systemImage: "photo")
                .font(.caption).foregroundStyle(.secondary).padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if let first = model.frames.first, model.time < first.meetingSec {
            Label("Screen capture starts at \(MeetingsFormat.clock(first.meetingSec)). Showing its first available frame.", systemImage: "photo")
                .font(.caption).foregroundStyle(.secondary).padding(8)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Separate from the image and toolbar: a clock change cannot rebuild every search result.
private struct FrameReviewDetails: View {
    let model: FrameReviewModel

    var body: some View {
        VSplitView {
            ScrollViewReader { scroll in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        if model.query.isEmpty {
                            Text("Screen text").font(.headline)
                            ForEach(Array((model.detailsFrame?.lines ?? model.detailsFrame?.changed ?? []).enumerated()), id: \.offset) { _, box in
                                Text(box.text).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        } else {
                            Text("Search results").font(.headline)
                            if let match = model.selectedMatch, match.seenAt.count > 1 {
                                HStack {
                                    Button { model.nextAppearance(-1) } label: { Image(systemName: "chevron.left") }
                                        .help("Previous appearance of this screen text")
                                    Text("Appearance \(model.appearanceIndex + 1) of \(match.seenAt.count)").font(.caption).monospacedDigit()
                                    Button { model.nextAppearance(1) } label: { Image(systemName: "chevron.right") }
                                        .help("Next appearance of this screen text")
                                }
                            }
                            ForEach(model.matches) { match in
                                Button { model.chooseMatch(match) } label: {
                                    VStack(alignment: .leading, spacing: 5) {
                                        HStack {
                                            Image(systemName: match.source == .ocr ? "text.viewfinder" : "quote.bubble")
                                            Text(Self.when(match)).monospacedDigit()
                                            Spacer(minLength: 0)
                                        }.font(.caption).foregroundStyle(.secondary)
                                        if let speaker = match.speaker { Text(speaker).font(.caption.weight(.semibold)) }
                                        FrameReviewHighlightedText(text: match.text, query: model.query)
                                            .frame(maxWidth: .infinity, alignment: .leading)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }.padding(8)
                                        .background(model.selectedMatch?.id == match.id ? Color.accentColor.opacity(0.16) : .clear,
                                                    in: RoundedRectangle(cornerRadius: 5))
                                        .contentShape(Rectangle())
                                }.buttonStyle(.plain).id(match.id)
                                    .onHover { inside in
                                        if inside { model.hoveredMatch = match }
                                        else if model.hoveredMatch?.id == match.id { model.hoveredMatch = nil }
                                    }
                                    .onDisappear { if model.hoveredMatch?.id == match.id { model.hoveredMatch = nil } }
                            }
                        }
                    }.padding(12)
                }
                .onChange(of: model.selectedMatch?.id) { _, id in if let id { scroll.scrollTo(id, anchor: .center) } }
            }
            .frame(minHeight: 100)
            FrameReviewTranscriptContext(model: model).frame(minHeight: 110, idealHeight: 230)
        }
        .accessibilityLabel("Search results and nearby transcript")
    }

    private static func when(_ match: FrameReviewModel.Match) -> String {
        let first = MeetingsFormat.clock(match.fromSec)
        if match.source == .ocr, match.occurrences > 1 {
            return "\(first)–\(MeetingsFormat.clock(match.toSec)) · \(match.occurrences) frames"
        }
        return first
    }
}

private struct FrameReviewTranscriptContext: View {
    let model: FrameReviewModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                Text("Nearby transcript").font(.headline)
                if model.context.isEmpty {
                    LoadablePane(state: model.transcript, reading: "Reading transcript…",
                                 retry: { Task { await model.load() } },
                                 noSource: .init(what: "transcript", showScreen: nil)) { _ in
                        Text("There is no timed transcript for this recording.").foregroundStyle(.secondary)
                    }
                } else {
                    ForEach(model.context, id: \.rowID) { line in
                        VStack(alignment: .leading, spacing: 4) {
                            HStack(alignment: .firstTextBaseline) {
                                Text(line.startSec.map(MeetingsFormat.clock) ?? "").monospacedDigit()
                                Text(line.speaker).fontWeight(.semibold)
                            }.font(.caption).foregroundStyle(.secondary)
                            FrameReviewHighlightedText(text: line.text, query: model.query)
                                .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
                        }.frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }.padding(12)
        }
    }
}

private struct FrameReviewHighlightedText: View {
    let text: String
    let query: String

    var body: some View { Text(highlighted) }

    private var highlighted: AttributedString {
        var result = AttributedString(text)
        for found in FrameReviewModel.highlightRanges(in: text, query: query) {
            guard let range = Range(found, in: text),
                  let lower = AttributedString.Index(range.lowerBound, within: result),
                  let upper = AttributedString.Index(range.upperBound, within: result) else { continue }
            result[lower..<upper].foregroundColor = .orange
            result[lower..<upper].backgroundColor = .orange.opacity(0.16)
            result[lower..<upper].font = .body.bold()
        }
        return result
    }
}

private struct FrameReviewTransport: View {
    let model: FrameReviewModel
    @Binding var seek: Bool

    var body: some View {
        HStack(spacing: 10) {
            Button { model.step(-1, seek: seek) } label: { Image(systemName: "backward.end.fill") }
                .help("Previous frame").accessibilityLabel("Previous frame").accessibilityIdentifier("meetings.frame-review.previous")
                .disabled(model.stepTarget(-1) == nil)
            Button { model.playPause() } label: { Image(systemName: model.isPlaying ? "pause.fill" : "play.fill") }
                .help("Play or pause at this time").accessibilityLabel(model.isPlaying ? "Pause playback" : "Play from this frame")
            Button { model.step(1, seek: seek) } label: { Image(systemName: "forward.end.fill") }
                .help("Next frame").accessibilityLabel("Next frame").accessibilityIdentifier("meetings.frame-review.next")
                .disabled(model.stepTarget(1) == nil)
            Text(MeetingsFormat.clock(model.time)).font(.system(.body, design: .monospaced)).frame(width: 75)
            Slider(value: Binding(get: { model.time }, set: { model.scrub(to: $0, seek: seek) }), in: 0...model.duration,
                   onEditingChanged: { editing in if editing { model.beginScrub() } else { model.endScrub(seek: seek) } })
                .accessibilityLabel("Recording time").accessibilityIdentifier("meetings.frame-review.time")
            Text(MeetingsFormat.clock(model.duration)).font(.system(.body, design: .monospaced))
            Toggle("Seek playback", isOn: $seek).toggleStyle(.checkbox)
                .help("Dragging previews saved frames. Releasing seeks the recording; paused audio stays paused.")
            if let frame = model.frame { Button("Show in Finder") { PathOpener.reveal(frame.path) } }
        }
    }
}

private struct FrameReviewPlaybackFollower: View {
    let model: FrameReviewModel
    let enabled: Bool
    var body: some View {
        Color.clear.frame(width: 0, height: 0)
            .onChange(of: model.player?.position.map { Int($0) }) { _, second in
                guard enabled, !model.isScrubbing, model.query.isEmpty, model.isPlaying, let second else { return }
                model.selectTime(Double(second))
            }.accessibilityHidden(true)
    }
}
