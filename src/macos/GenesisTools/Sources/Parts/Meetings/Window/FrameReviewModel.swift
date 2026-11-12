import Foundation
import Observation

/// The viewer's saved-data index. A drag only looks up in memory; it never runs OCR or asks the service.
@Observable
@MainActor
final class FrameReviewModel {
    enum SearchSource: String, CaseIterable { case both, transcript, ocr
        var title: String { switch self { case .both: "Both"; case .transcript: "Transcript"; case .ocr: "Screen text" } }
    }
    struct Match: Identifiable, Sendable {
        enum Source: Sendable { case ocr, transcript }
        enum Content: Sendable { case ocr(TimelineFrame), transcript(speaker: String) }
        let id: String
        let content: Content
        let text: String
        let fromSec: Double
        var toSec: Double
        var occurrences = 1
        var seenAt: [Double] = []
        var source: Source { switch content { case .ocr: .ocr; case .transcript: .transcript } }
        var frame: TimelineFrame? { if case .ocr(let frame) = content { frame } else { nil } }
        var speaker: String? { if case .transcript(let speaker) = content { speaker } else { nil } }
    }
    private struct Indexed: Sendable {
        var match: Match
        let folded: String
    }

    let meeting: String
    let defaults: UserDefaults
    weak var player: MomentPlayer?
    var timeline: Loadable<ScreenTimeline> = .idle
    var transcript: Loadable<MeetingTranscript> = .idle
    private(set) var frame: TimelineFrame?
    private(set) var time: Double
    var display: Int?
    var followsFocus: Bool
    var textVisible = true
    var sourceDuration: Double = 0
    var query = "" { didSet { if oldValue != query { search() } } }
    var searchSource = SearchSource.both { didSet { if oldValue != searchSource { search() } } }
    private(set) var matches: [Match] = []
    var hoveredMatch: Match?
    private(set) var matchIndex = 0
    private(set) var appearanceIndex = 0
    private(set) var context: [TranscriptLine] = []
    private(set) var isScrubbing = false
    private(set) var indexing = false
    @ObservationIgnored private var indexTask: Task<Void, Never>?
    @ObservationIgnored private var requestedFile: String
    @ObservationIgnored private var seekTask: Task<Void, Never>?
    @ObservationIgnored private var allFrames: [TimelineFrame] = []
    @ObservationIgnored private var focusFrames: [TimelineFrame] = []
    @ObservationIgnored private var automaticFrames: [TimelineFrame] = []
    @ObservationIgnored private var displayFrames: [Int: [TimelineFrame]] = [:]
    private var lastFrameTime = 0.0
    private var transcriptEnd = 0.0
    @ObservationIgnored private var ocrIndex: [Indexed] = []
    @ObservationIgnored private var transcriptIndex: [Indexed] = []
    @ObservationIgnored private var words: [TranscriptLine] = []
    @ObservationIgnored private var contextIndex: Int?

    init(meeting: String, file: String, at: Double, player: MomentPlayer?, defaults: UserDefaults,
         timeline: ScreenTimeline? = nil, transcript: MeetingTranscript? = nil) {
        self.meeting = meeting
        requestedFile = file
        time = at
        self.player = player
        self.defaults = defaults
        followsFocus = MeetingsPreferences.Panes.frameAutoDisplay.value(defaults)
        if let timeline { accept(timeline) }
        if let transcript { accept(transcript) }
    }

    var frames: [TimelineFrame] { followsFocus && hasFocusHistory ? automaticFrames : frames(on: display) }
    var displayChoice: Int { followsFocus ? -2 : (display ?? -1) }
    var hasFocusHistory: Bool { !focusFrames.isEmpty }
    var automaticDisplayName: String? {
        guard followsFocus, let id = frame?.displayId else { return nil }
        return timeline.value?.displays.first(where: { $0.id == id })?.name ?? "Display \(id)"
    }

    func chooseDisplay(_ choice: Int) {
        followsFocus = choice == -2
        if !followsFocus { display = choice == -1 ? nil : choice }
        defaults.set(followsFocus, forKey: MeetingsPreferences.Panes.frameAutoDisplay.key)
        selectTime(time)
    }

    private func selectedFrames(at time: Double) -> [TimelineFrame] {
        if followsFocus, let marker = Self.nearest(in: allFrames, at: time), marker.meetingSec <= time,
           let focused = marker.focusedDisplayId, let frames = displayFrames[focused], !frames.isEmpty { return frames }
        return frames(on: display)
    }
    func frames(on display: Int?) -> [TimelineFrame] { display.map { displayFrames[$0] ?? [] } ?? allFrames }
    var previewFrame: TimelineFrame? {
        guard let hoveredMatch else { return frame }
        return hoveredMatch.frame ?? Self.nearest(in: selectedFrames(at: hoveredMatch.fromSec), at: hoveredMatch.fromSec)
    }
    var previewText: String? { (hoveredMatch ?? selectedMatch)?.text }
    var duration: Double { max(1, sourceDuration, lastFrameTime, transcriptEnd) }
    var selectedMatch: Match? { matches.indices.contains(matchIndex) ? matches[matchIndex] : nil }
    var isPlaying: Bool { player?.meeting == meeting && player?.phase == .playing }

    func open(file: String, at: Double) {
        requestedFile = file
        time = at
        if let selected = allFrames.first(where: { $0.file == file }) {
            display = selected.displayId
            frame = selected
        }
        selectTime(at)
    }

    func load() async {
        if let ready = timeline.value, ready.frames.allSatisfy({ $0.lines != nil }) {
            await loadTranscript()
            return
        }
        async let screenRead: Void = loadScreen()
        async let transcriptRead: Void = loadTranscript()
        _ = await (screenRead, transcriptRead)
    }

    private func loadScreen() async {
        timeline = .loading(previous: timeline.value)
        do {
            let value = try await MeetingsRead.service(MeetingsAPI.MeetingTimeline.self, .init(meeting: meeting, all: true),
                                                       orRun: ["screen", meeting, "--timeline", "--all", "--json"], timeoutSeconds: 120).run()
            if !Task.isCancelled { accept(value) }
        } catch {
            if !Task.isCancelled { timeline = .failed(asFailure(error), previous: timeline.value) }
        }
    }

    private func loadTranscript() async {
        transcript = .loading(previous: transcript.value)
        do {
            let value = try await MeetingDetailModel.transcriptRead(meeting).run()
            if !Task.isCancelled { accept(value) }
        } catch {
            if !Task.isCancelled { transcript = .failed(asFailure(error), previous: transcript.value) }
        }
    }

    private func accept(_ value: ScreenTimeline) {
        timeline = .loaded(value)
        allFrames = value.frames.sorted { $0.meetingSec < $1.meetingSec }
        displayFrames = Dictionary(grouping: allFrames, by: { $0.displayId ?? -1 })
        focusFrames = allFrames.filter { $0.focusedDisplayId != nil }
        automaticFrames = allFrames.filter { $0.focusedDisplayId == nil || $0.focusedDisplayId == $0.displayId }
        lastFrameTime = allFrames.last?.meetingSec ?? 0
        indexTask?.cancel()
        indexing = true
        let capturedFrames = displayFrames
        let work = Task.detached(priority: .userInitiated) { Self.makeOCRIndex(capturedFrames) }
        indexTask = Task { [weak self] in
            let index = await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
            guard let self, !Task.isCancelled else { return }
            self.ocrIndex = index
            self.indexing = false
            self.search()
        }
        open(file: requestedFile, at: time)
        if frame == nil { frame = Self.nearest(in: frames, at: time) }
        search()
    }

    private nonisolated static func makeOCRIndex(_ displayFrames: [Int: [TimelineFrame]]) -> [Indexed] {
        var result: [Indexed] = []
        for key in displayFrames.keys.sorted() {
            let frames = displayFrames[key] ?? []
            var groups: [String: Int] = [:]
            for (offset, frame) in frames.enumerated() {
                guard !Task.isCancelled else { return [] }
                var seen = Set<String>()
                let until = frames.indices.contains(offset + 1) ? frames[offset + 1].meetingSec : frame.meetingSec
                for (lineIndex, line) in (frame.lines ?? frame.changed).enumerated() {
                    let folded = Self.fold(line.text.split(whereSeparator: \.isWhitespace).joined(separator: " "))
                    guard !folded.isEmpty, seen.insert(folded).inserted else { continue }
                    if let index = groups[folded] {
                        result[index].match.toSec = until
                        result[index].match.occurrences += 1
                        result[index].match.seenAt.append(frame.meetingSec)
                    } else {
                        groups[folded] = result.count
                        result.append(Indexed(match: Match(id: "ocr:\(key):\(frame.file):\(lineIndex)", content: .ocr(frame),
                            text: line.text, fromSec: frame.meetingSec, toSec: until,
                            seenAt: [frame.meetingSec]), folded: folded))
                    }
                }
            }
        }
        return result
    }

    func waitForIndex() async { await indexTask?.value }

    func cancelWork() {
        cancelPendingSeek()
        indexTask?.cancel()
    }

    private func accept(_ value: MeetingTranscript) {
        transcript = .loaded(value)
        words = value.entries.filter { $0.startSec != nil }.sorted { ($0.startSec ?? 0) < ($1.startSec ?? 0) }
        transcriptEnd = words.last?.endSec ?? words.last?.startSec ?? 0
        transcriptIndex = words.enumerated().map { index, line in
            Indexed(match: Match(id: "transcript:\(index)", content: .transcript(speaker: line.speaker), text: line.text,
                fromSec: line.startSec ?? 0, toSec: line.endSec ?? line.startSec ?? 0), folded: Self.fold(line.text))
        }
        contextIndex = nil
        updateContext()
        search()
    }

    static func nearest(in frames: [TimelineFrame], at time: Double) -> TimelineFrame? {
        guard !frames.isEmpty else { return nil }
        var lower = 0, upper = frames.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if frames[middle].meetingSec <= time { lower = middle + 1 } else { upper = middle }
        }
        return frames[max(0, lower - 1)]
    }

    nonisolated static func fold(_ value: String) -> String {
        value.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: Locale(identifier: "en_US_POSIX"))
    }

    static func highlightRanges(in text: String, query: String) -> [NSRange] {
        let wanted = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !wanted.isEmpty else { return [] }
        let source = text as NSString
        var remaining = NSRange(location: 0, length: source.length)
        var result: [NSRange] = []
        while remaining.length > 0 {
            let range = source.range(of: wanted, options: [.caseInsensitive, .diacriticInsensitive], range: remaining)
            guard range.location != NSNotFound, range.length > 0 else { break }
            result.append(range)
            let next = NSMaxRange(range)
            remaining = NSRange(location: next, length: source.length - next)
        }
        return result
    }

    private func search() {
        hoveredMatch = nil
        cancelPendingSeek()
        let wanted = Self.fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
        let index = (searchSource == .transcript ? [] : ocrIndex) + (searchSource == .ocr ? [] : transcriptIndex)
        matches = wanted.isEmpty ? [] : index.filter { $0.folded.contains(wanted) }.map(\.match).sorted {
            if $0.fromSec != $1.fromSec { return $0.fromSec < $1.fromSec }
            return $0.id < $1.id
        }
        matchIndex = 0
        if let match = matches.first { show(match) }
    }

    func nextMatch(_ delta: Int) {
        guard !matches.isEmpty else { return }
        matchIndex = (matchIndex + delta + matches.count) % matches.count
        show(matches[matchIndex])
    }

    func chooseMatch(_ match: Match) {
        hoveredMatch = nil
        matchIndex = matches.firstIndex(where: { $0.id == match.id }) ?? 0
        show(match)
    }

    private func show(_ match: Match) {
        appearanceIndex = 0
        if let frame = match.frame {
            followsFocus = false
            display = frame.displayId
        }
        selectTime(match.fromSec)
    }

    func nextAppearance(_ delta: Int) {
        guard let match = selectedMatch, match.seenAt.count > 1 else { return }
        appearanceIndex = (appearanceIndex + delta + match.seenAt.count) % match.seenAt.count
        selectTime(match.seenAt[appearanceIndex])
    }

    func selectTime(_ next: Double) {
        time = min(max(0, next), duration)
        let selected = Self.nearest(in: selectedFrames(at: time), at: time)
        if frame?.file != selected?.file { frame = selected }
        if let frame { requestedFile = frame.file }
        updateContext()
    }

    private func updateContext() {
        guard !words.isEmpty else { return }
        var lower = 0, upper = words.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if (words[middle].startSec ?? 0) <= time { lower = middle + 1 } else { upper = middle }
        }
        let selected = max(0, lower - 1)
        guard contextIndex != selected else { return }
        contextIndex = selected
        context = Array(words[max(0, selected - 1)...min(words.count - 1, selected + 2)])
    }

    func step(_ delta: Int, seek: Bool) {
        guard let frame, let position = frames.firstIndex(where: { $0.file == frame.file }) else { return }
        let next = min(max(0, position + delta), frames.count - 1)
        selectTime(frames[next].meetingSec)
        if seek { seekPlayback() }
    }

    func cancelPendingSeek() { seekTask?.cancel(); seekTask = nil }
    func beginScrub() { cancelPendingSeek(); isScrubbing = true }
    func scrub(to time: Double, seek: Bool) {
        selectTime(time)
        if seek, !isScrubbing { scheduleSeek() }
    }
    func endScrub(seek: Bool) {
        isScrubbing = false
        if seek { seekPlayback() }
    }
    private func scheduleSeek() {
        cancelPendingSeek()
        seekTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            if !Task.isCancelled { self?.seekPlayback() }
        }
    }
    func seekPlayback() {
        cancelPendingSeek()
        guard let player, player.meeting == meeting, player.isActive else { return }
        let playing = player.phase == .playing
        if player.top?.contains(time) == true, playing || player.phase == .paused { player.seek(to: time) }
        else { player.playMeeting(meeting, at: time, from: .outside, paused: !playing) }
    }
    func playPause() {
        guard let player else { return }
        if isPlaying { player.togglePause() }
        else { player.playMeeting(meeting, at: time, from: .outside) }
    }
}
