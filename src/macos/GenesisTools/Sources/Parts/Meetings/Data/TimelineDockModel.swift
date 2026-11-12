import Foundation
import Observation

/// The dock's timeline (F9): what it shows (the clip, a context window, the whole meeting, or a range the strip's lens
/// set) and what it draws for the playing meeting (the recording's length, the waveform peaks, the screen frames, and
/// the rows of a meeting that is not open, for its pins). One per window, held by the player, so the keys reach it
/// (⌘+, ⌘-, ⌘0, `[` and `]`). A view change never touches the sound (R4).
///
/// The reads go through the Meetings service only (`meeting.audio`, `meeting.waveform`, `meeting.screen` have no
/// command): without a service the dock draws a flat strip of the overview's length and no screen pane.
@Observable @MainActor
final class TimelineDockModel {
    /// The service calls behind the dock, replaceable in tests.
    struct Reads {
        var audio: @MainActor (String) async throws -> MeetingsAPI.MeetingAudio.Result
        var waveform: @MainActor (MeetingsAPI.MeetingWaveform.Params) async throws -> MeetingsAPI.MeetingWaveform.Result
        var screen: @MainActor (String) async throws -> MeetingsAPI.MeetingScreen.Result
        var rows: @MainActor (String) async throws -> ReviewRows
    }

    /// The ranges the reader zoomed to, for the layer that played then: a new top shows its own span again. The trail
    /// holds every range on the way, the shown one last: a merged pin or a "Show" adds or starts one, the lens moves
    /// the last one. The breadcrumb names them and a click goes back.
    struct ViewOverride: Equatable {
        let layer: UUID
        var trail: [ClosedRange<Double>]

        init(layer: UUID, trail: [ClosedRange<Double>]) {
            self.layer = layer
            self.trail = trail
        }

        init(layer: UUID, range: ClosedRange<Double>) {
            self.init(layer: layer, trail: [range])
        }

        /// The range the timeline shows.
        var range: ClosedRange<Double> { trail.last ?? 0...1 }
    }

    /// Peaks across the whole meeting (the strip), and across the zoomed view widened by one view length each side, so
    /// a lens drag does not wait for a read.
    static let wholeBuckets = 600
    static let zoomBuckets = 400

    var zoom: DockZoom
    private(set) var viewOverride: ViewOverride?
    /// The pin under the pointer or the keyboard (its row id): the hover card's row.
    var hoveredPin: String?
    /// The display the screen pane shows, per meeting; none means the one with the OCR hit, else the shared one.
    var displays: [String: Int] = [:]
    /// The screen pane follows the playhead; off, it holds its frame.
    var screenFollows = true

    private(set) var audio: [String: MeetingsAPI.MeetingAudio.Result] = [:]
    private(set) var whole: [String: MeetingsAPI.MeetingWaveform.Result] = [:]
    private(set) var zoomed: MeetingsAPI.MeetingWaveform.Result?
    private(set) var screens: [String: MeetingsAPI.MeetingScreen.Result] = [:]
    /// Rows of a playing meeting that is not the open one (the open one's rows come from its detail model).
    private(set) var otherRows: [String: [ReviewRow]] = [:]

    @ObservationIgnored private let reads: Reads
    @ObservationIgnored private let defaults: UserDefaults
    @ObservationIgnored private var asked: Set<String> = []
    @ObservationIgnored private var askedRows: Set<String> = []
    @ObservationIgnored private var zoomTask: Task<Void, Never>?
    @ObservationIgnored private var zoomAsked: ClosedRange<Double>?

    init(reads: Reads = .live, defaults: UserDefaults = .standard) {
        self.reads = reads
        self.defaults = defaults
        zoom = Self.defaultZoom(defaults)
    }

    /// `meetings.playback.view`: Moment opens on the clip, Meeting on the whole meeting.
    static func defaultZoom(_ defaults: UserDefaults = .standard) -> DockZoom {
        MeetingsPreferences.Playback.view.value(defaults) == .meeting ? .meeting : .clip
    }

    // MARK: What the timeline shows

    /// The zoom that applies: a whole-meeting play has no clip, so it shows the meeting.
    static func effectiveZoom(_ zoom: DockZoom, span: ZoomSpan?) -> DockZoom {
        span == nil ? .meeting : zoom
    }

    /// The seconds the zoomed timeline shows: a lens range of this layer first, else the zoom's own range.
    static func view(zoom: DockZoom, span: ZoomSpan?, override: ViewOverride?, layer: UUID?, contextSec: Double,
                     durationSec: Double) -> ClosedRange<Double> {
        if let override, override.layer == layer { return override.range }
        let whole = 0...max(durationSec, 1)
        guard let span else { return whole }
        switch effectiveZoom(zoom, span: span) {
        case .clip: return span.fitView
        case .context: return span.contextView(contextSec: contextSec, durationSec: durationSec)
        case .meeting: return whole
        }
    }

    /// Clip, Context or Meeting; the lens range goes with the old zoom.
    func setZoom(_ next: DockZoom) {
        zoom = next
        viewOverride = nil
    }

    /// ⌘- zooms out (clip, context, meeting), ⌘+ in; the ends hold.
    func stepZoom(out: Bool) {
        let all = DockZoom.allCases
        guard let index = all.firstIndex(of: zoom) else { return }
        setZoom(all[min(max(index + (out ? 1 : -1), 0), all.count - 1)])
    }

    /// A range from the strip's lens, kept while the same layer is on top: the shown range moves, no level is added.
    func setView(_ range: ClosedRange<Double>, layer: UUID?) {
        guard let layer else { return }
        var trail = trail(of: layer)
        if trail.isEmpty { trail = [range] } else { trail[trail.count - 1] = range }
        viewOverride = ViewOverride(layer: layer, trail: trail)
    }

    /// A merged pin's range: one level deeper, so the reader can go back to the range before it.
    func pushView(_ range: ClosedRange<Double>, layer: UUID?) {
        guard let layer else { return }
        var trail = trail(of: layer)
        if trail.last != range { trail.append(range) }
        viewOverride = ViewOverride(layer: layer, trail: trail)
    }

    /// "Show" on a stretch: that range alone, whatever was zoomed to before.
    func showView(_ range: ClosedRange<Double>, layer: UUID?) {
        guard let layer else { return }
        viewOverride = ViewOverride(layer: layer, trail: [range])
    }

    /// Back to level `index` of the trail; nil shows the layer's own view again.
    func popView(to index: Int?) {
        guard let held = viewOverride else { return }
        guard let index, index >= 0, index < held.trail.count else {
            viewOverride = nil
            return
        }
        viewOverride = ViewOverride(layer: held.layer, trail: Array(held.trail.prefix(index + 1)))
    }

    /// One level back: the range before this one, or the layer's own view from the first level.
    func backView() {
        guard let held = viewOverride else { return }
        popView(to: held.trail.count >= 2 ? held.trail.count - 2 : nil)
    }

    /// The ranges zoomed to while `layer` is on top, the shown one last; none for another layer.
    func trail(of layer: UUID?) -> [ClosedRange<Double>] {
        guard let held = viewOverride, held.layer == layer else { return [] }
        return held.trail
    }

    /// A layer that takes the place of `old` in the same play (the next stretch of a whole meeting, a click in it)
    /// keeps the zoomed range.
    func moveView(from old: UUID, to next: UUID) {
        guard let held = viewOverride, held.layer == old else { return }
        viewOverride = ViewOverride(layer: next, trail: held.trail)
    }

    // MARK: Reads

    /// The recording's length, its whole peaks and its screen frames, read once per meeting.
    func prepare(_ meeting: String) {
        guard asked.insert(meeting).inserted else { return }
        Task { [weak self] in
            guard let self else { return }
            if let audio = try? await self.reads.audio(meeting) { self.audio[meeting] = audio }
        }
        Task { [weak self] in
            guard let self else { return }
            let params = MeetingsAPI.MeetingWaveform.Params(meeting: meeting, buckets: Self.wholeBuckets)
            if let peaks = try? await self.reads.waveform(params) { self.whole[meeting] = peaks }
        }
        Task { [weak self] in
            guard let self else { return }
            if let screen = try? await self.reads.screen(meeting) { self.screens[meeting] = screen }
        }
    }

    /// The rows of a playing meeting that is not open, for its pins; read once.
    func prepareRows(_ meeting: String) {
        guard askedRows.insert(meeting).inserted else { return }
        Task { [weak self] in
            guard let self else { return }
            if let rows = try? await self.reads.rows(meeting) { self.otherRows[meeting] = rows.rows }
        }
    }

    /// The meeting's length: the recording's, else the whole waveform's end, else `fallback` (the overview's length).
    func durationSec(_ meeting: String, fallback: Double?) -> Double {
        audio[meeting]?.durationSec ?? whole[meeting]?.toSec ?? fallback ?? 0
    }

    /// Finer peaks for `view`, unless the ones held cover it at about the same scale.
    func ensureZoomPeaks(_ meeting: String, view: ClosedRange<Double>, durationSec: Double) {
        guard zoom != .meeting || viewOverride != nil else { return }
        if let zoomed, zoomed.meeting == meeting, Self.covers(zoomed.fromSec...zoomed.toSec, view) { return }
        if let zoomAsked, Self.covers(zoomAsked, view) { return }
        let wide = Self.widened(view, durationSec: durationSec)
        zoomAsked = wide
        zoomTask?.cancel()
        zoomTask = Task { [weak self] in
            guard let self else { return }
            let params = MeetingsAPI.MeetingWaveform.Params(meeting: meeting, fromSec: wide.lowerBound, toSec: wide.upperBound,
                                                            buckets: Self.zoomBuckets)
            let peaks = try? await self.reads.waveform(params)
            guard !Task.isCancelled else { return }
            if let peaks, peaks.cannot == nil { self.zoomed = peaks }
            self.zoomAsked = nil
        }
    }

    /// The peaks the zoomed timeline draws and the seconds they cover: the finer ones when they cover the view, else the
    /// whole meeting's.
    func zoomPeaks(_ meeting: String, view: ClosedRange<Double>, durationSec: Double) -> (peaks: [Double], range: ClosedRange<Double>) {
        if let zoomed, zoomed.meeting == meeting, Self.covers(zoomed.fromSec...zoomed.toSec, view) {
            return (zoomed.peaks, zoomed.fromSec...max(zoomed.toSec, zoomed.fromSec + 1))
        }
        return (whole[meeting]?.peaks ?? [], 0...max(durationSec, 1))
    }

    /// Finest cached peaks at one playhead position. An activity glyph needs no new read or viewport-scale test.
    func activityPeaks(_ meeting: String, at second: Double) -> (peaks: [Double], range: ClosedRange<Double>) {
        if let zoomed, zoomed.meeting == meeting, (zoomed.fromSec...zoomed.toSec).contains(second) {
            return (zoomed.peaks, zoomed.fromSec...max(zoomed.toSec, zoomed.fromSec + 1))
        }
        return (whole[meeting]?.peaks ?? [], 0...max(durationSec(meeting, fallback: nil), 1))
    }

    /// True when `held` holds `view` and is at most four view lengths long (else its bars are too coarse).
    static func covers(_ held: ClosedRange<Double>, _ view: ClosedRange<Double>) -> Bool {
        let length = view.upperBound - view.lowerBound
        return held.lowerBound <= view.lowerBound && held.upperBound >= view.upperBound
            && held.upperBound - held.lowerBound <= max(length, 1) * 4
    }

    /// `view` widened by one view length each side, inside the meeting.
    static func widened(_ view: ClosedRange<Double>, durationSec: Double) -> ClosedRange<Double> {
        let length = max(view.upperBound - view.lowerBound, 1)
        let end = max(durationSec, view.upperBound)
        return max(0, view.lowerBound - length)...min(end, view.upperBound + length)
    }

    // MARK: Screen

    /// The frame to show at `second`: on the chosen display (else every display), the last one at or before it, else
    /// the first after it. The frames are in time order.
    static func frame(in screen: MeetingsAPI.MeetingScreen.Result, at second: Double, display: Int?) -> MeetingsAPI.MeetingScreen.Frame? {
        let frames = display.map { id in screen.frames.filter { $0.displayId == id } } ?? screen.frames
        guard !frames.isEmpty else { return nil }
        var low = 0, high = frames.count - 1, found: Int?
        while low <= high {
            let middle = (low + high) / 2
            if frames[middle].meetingSec <= second {
                found = middle
                low = middle + 1
            } else {
                high = middle - 1
            }
        }
        return frames[found ?? 0]
    }

    /// How far the shown frame is from `second` when the capture does not cover that time: positive when `frame` is
    /// the capture's last frame and `second` is more than `limit` after it (the capture ended earlier), negative when
    /// it is the first frame and `second` is more than `limit` before it. Nil inside the capture, where an older frame
    /// means the screen did not change. The pane then says that its picture is from another time.
    static func apart(_ frame: MeetingsAPI.MeetingScreen.Frame, in screen: MeetingsAPI.MeetingScreen.Result, at second: Double,
                      display: Int?, limit: Double = 30) -> Double? {
        let frames = display.map { id in screen.frames.filter { $0.displayId == id } } ?? screen.frames
        let gap = second - frame.meetingSec
        if frame == frames.last, gap > limit { return gap }
        if frame == frames.first, gap < -limit { return gap }
        return nil
    }

    /// The display the pane shows by itself (G-SCR-1): the one with the Moment's OCR hit, else the one most frames show.
    static func autoDisplay(screen: MeetingsAPI.MeetingScreen.Result, moment: Moment?, at second: Double? = nil) -> Int? {
        if let second, let focused = screen.frames.last(where: { $0.meetingSec <= second && $0.focusedDisplayId != nil })?.focusedDisplayId,
           screen.frames.contains(where: { $0.displayId == focused }) { return focused }
        if let hit = moment?.screen?.first(where: { $0.hit != nil }), let id = hit.displayId { return id }
        let counts = Dictionary(grouping: screen.frames.compactMap(\.displayId), by: { $0 }).mapValues(\.count)
        return counts.max { $0.value < $1.value }?.key
    }
}

extension TimelineDockModel.Reads {
    /// Through the Meetings service; without one each read fails and the dock draws what it has.
    static let live = TimelineDockModel.Reads(
        audio: { meeting in
            try await Self.service().call(MeetingsAPI.MeetingAudio.self, .init(meeting: meeting))
        },
        waveform: { params in
            try await Self.service().call(MeetingsAPI.MeetingWaveform.self, params)
        },
        screen: { meeting in
            try await Self.service().call(MeetingsAPI.MeetingScreen.self, .init(meeting: meeting))
        },
        rows: { meeting in
            try await MeetingDetailModel.rowsRead(meeting, lowPriority: MeetingsPreferences.Rows.lowPriority.value()).run()
        })

    @MainActor private static func service() throws -> MeetingsService {
        guard let service = MeetingsService.shared else {
            throw MeetingsService.Unavailable(reason: "the timeline's peaks, length and frames are read by the Meetings service only")
        }
        return service
    }
}

extension MeetingsWindowModel {
    /// A pin's click (R3, G-PLAY-5, G-PLAY-6): the pin's meeting opens on Items when another one is open, and its row is
    /// selected and scrolled into view; a decided row that `meetings.rows.decided` hides shows again, with an Undo.
    func revealRow(_ id: String, in meeting: String) {
        if detail?.id != meeting { select(meeting, tab: .items) }
        detail?.reveal(row: id)
    }
}
