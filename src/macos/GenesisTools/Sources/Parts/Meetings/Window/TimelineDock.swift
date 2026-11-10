import AppKit
import SwiftUI

// MARK: - The dock under the Moment that plays (F9: R1 to R6, R38, R41, R47, R48)

/// The approved dock (R48) wired to the window: the context stack's breadcrumb, the controls, the whole-conversation
/// strip with the zoomed part in its lens (R47), the zoomed timeline with the pad shaded and the flag on the span's
/// boundary (R1, R2, R46), one pin per review row (R3, R6) with its hover card (R5, R37), and the screen of the moment
/// beside the sound (R41). Every value comes from the player (`MomentPlayer`), the player's `TimelineDockModel` and the
/// window's rows; every control calls the player or changes the view only (R4).
struct TimelineDock: View {
    let player: MomentPlayer
    /// The playing meeting's title, when the overview knows it.
    let title: String?
    let window: MeetingsWindowModel?
    var collapsed = false

    @AppStorage(MeetingsPreferences.Panes.screenBesidePlayback.key) private var screenBeside =
        MeetingsPreferences.Panes.screenBesidePlayback.defaultValue
    @AppStorage(MeetingsPreferences.Panes.hoverDelayMs.key) private var hoverDelayMs = MeetingsPreferences.Panes.hoverDelayMs.defaultValue
    @AppStorage(MeetingsPreferences.Playback.contextSec.key) private var contextSec = MeetingsPreferences.Playback.contextSec.defaultValue
    @AppStorage(MeetingsPreferences.Rows.decided.key) private var decided = MeetingsPreferences.Rows.decided.defaultValue.rawValue
    /// The last span that had a Moment: the view holds it while the next clip is cut, so the timeline does not jump to
    /// the whole meeting and back.
    @State private var lastSpan: ZoomSpan?
    @State private var width: CGFloat = 0

    /// The dock's horizontal padding (TimelineDockBody) and the screen pane beside the timeline.
    static let padding: CGFloat = 16
    static let screenWidth: CGFloat = 290

    var body: some View {
        if let top = player.top {
            let dock = player.timeline
            let meeting = top.meeting
            let span = Self.span(of: top) ?? (top.kind == .moment ? lastSpan : nil)
            let duration = dock.durationSec(meeting, fallback: window?.meeting(meeting)?.durationSec)
            let view = TimelineDockModel.view(zoom: dock.zoom, span: span, override: dock.viewOverride, layer: top.id,
                                              contextSec: contextSec, durationSec: duration)
            let peaks = dock.zoomPeaks(meeting, view: view, durationSec: duration)
            let rows = rows(of: meeting, dock: dock)
            let screen = screenBeside ? dock.screens[meeting].flatMap { $0.recorded && !$0.frames.isEmpty ? $0 : nil } : nil
            let state = TimelineDockState(
                meetingTitle: title ?? meeting,
                moments: player.stack.map(StackBreadcrumb.Level.init(layer:)),
                isPlaying: player.phase == .playing,
                span: span,
                zoom: TimelineDockModel.effectiveZoom(dock.zoom, span: span),
                view: view,
                durationSec: max(duration, view.upperBound),
                wholePeaks: dock.whole[meeting]?.peaks ?? [],
                zoomPeaks: peaks.peaks,
                zoomPeaksRange: peaks.range,
                pins: pins(rows, meeting: meeting, top: top),
                offerMore: player.phase == .ended(offerMore: true),
                moreSec: MeetingsPreferences.Playback.moreSec.value())
            dockBody(state: state, screen: screen, meeting: meeting, top: top)
                .onGeometryChange(for: CGFloat.self, of: { $0.size.width }) { width = $0 }
                .modifier(PinCardPresenter(hovered: dock.hoveredPin, openDelayMs: hoverDelayMs,
                                           anchorX: { anchorX(of: $0, rows: rows, view: view, duration: duration, screen: screen != nil) },
                                           arrowEdge: .bottom,
                                           card: { id in card(id, rows: rows, meeting: meeting) }))
                .task(id: meeting) {
                    dock.prepare(meeting)
                    if let detail = window?.detail, detail.id == meeting {
                        // The pins are the open meeting's rows, which its Items tab reads. A meeting that opened on
                        // another tab has none yet, and its timeline showed no pin until the reader visited Items.
                        if case .idle = detail.rows { detail.loadRows() }
                    } else {
                        dock.prepareRows(meeting)
                    }
                }
                .task(id: ZoomRead(meeting: meeting, view: view)) {
                    dock.ensureZoomPeaks(meeting, view: view, durationSec: duration)
                }
                .onChange(of: Self.span(of: top)) { _, next in if let next { lastSpan = next } }
        }
    }

    @ViewBuilder
    private func dockBody(state: TimelineDockState, screen: MeetingsAPI.MeetingScreen.Result?, meeting: String,
                          top: MomentLayer) -> some View {
        let actions = actions(meeting: meeting, top: top)
        if let screen, !collapsed {
            TimelineDockBody(state: state, position: { player.position }, actions: actions, collapsed: collapsed,
                             trailingWidth: Self.screenWidth) {
                DockScreen(screen: screen, moment: top.moment, meeting: meeting, dock: player.timeline,
                           position: { player.position })
            }
        } else {
            TimelineDockBody(state: state, position: { player.position }, actions: actions, collapsed: collapsed)
        }
    }

    // MARK: Values

    /// The zoomed span of a Moment layer; none for the whole meeting (a file or 60 s stretches).
    static func span(of layer: MomentLayer) -> ZoomSpan? {
        guard layer.kind == .moment, let moment = layer.moment else { return nil }
        return ZoomSpan(moment: moment)
    }

    /// The pins' rows: the open meeting's (as its Items tab holds them), else the ones the dock read for the meeting.
    private func rows(of meeting: String, dock: TimelineDockModel) -> [ReviewRow] {
        if let detail = window?.detail, detail.id == meeting { return detail.rows.value?.rows ?? [] }
        return dock.otherRows[meeting] ?? []
    }

    /// One pin per row with a time; a row the Items tab hides (decided rows hidden) is dimmed (G-PLAY-5).
    private func pins(_ rows: [ReviewRow], meeting: String, top: MomentLayer) -> [TimelinePin] {
        let hidden = (MeetingsPreferences.Rows.Decided(rawValue: decided) ?? .inPlace) == .hidden
        return rows.compactMap { row in
            TimelinePin(row: row, playing: top.kind == .moment && row.target == top.target, dimmed: hidden && !row.isOpen)
        }
    }

    // MARK: Actions

    private func actions(meeting: String, top: MomentLayer) -> TimelineDockActions {
        let dock = player.timeline
        var actions = TimelineDockActions()
        actions.togglePause = { player.togglePause() }
        actions.skip = { delta in player.skip(by: delta) }
        // A click inside the loaded clip seeks; outside it the Moment at that time takes the top's place (G-PLAY-1).
        actions.seek = { second in player.playTime(second, in: meeting, from: .outside) }
        actions.flag = { second in player.playTime(second, in: meeting, from: .outside) }
        actions.playAgain = { player.playAgain() }
        actions.playMore = { player.playMore() }
        actions.setZoom = { dock.setZoom($0) }
        actions.setView = { dock.setView($0, layer: top.id) }
        actions.popTo = { player.pop(to: $0) }
        actions.showMeeting = { dock.setZoom(.meeting) }
        actions.stop = { player.stop() }
        actions.pins = TimelinePinsRow.Actions(
            select: { id in window?.revealRow(id, in: meeting) },
            expand: { range in dock.setView(Self.widened(range), layer: top.id) },
            hover: { id in dock.hoveredPin = id })
        return actions
    }

    /// A merged pin's seconds with 10 % room each side, at least 10 s wide.
    static func widened(_ range: ClosedRange<Double>) -> ClosedRange<Double> {
        let length = max(range.upperBound - range.lowerBound, 10)
        let middle = (range.lowerBound + range.upperBound) / 2
        let half = length * 0.6
        return max(0, middle - half)...(middle + half)
    }

    // MARK: The hover card

    @ViewBuilder
    private func card(_ id: String, rows: [ReviewRow], meeting: String) -> some View {
        if let row = rows.first(where: { $0.id == id }) {
            PinCard(row: row,
                    onPlay: { player.play(row.target, in: meeting, from: .pin) },
                    onSelect: { window?.revealRow(row.id, in: meeting) },
                    onShowSource: { source in Self.show(source, meeting: meeting, player: player) },
                    reference: { id in rows.first { $0.id == id }.map(ReviewRowView.reference) })
        }
    }

    /// "Show source" (R5): a document opens at its line, a transcript line plays, a link opens.
    static func show(_ source: RowSource, meeting: String, player: MomentPlayer) {
        switch source {
        case .document(let path, let line): PathOpener.primary(path, line: line)
        case .line(let at, _, _): player.playTime(at.sec, in: meeting, from: .transcript)
        case .url(let url): if let link = URL(string: url) { NSWorkspace.shared.open(link) }
        case .commit(let sha): PathOpener.copy(sha, what: "The commit")
        case .workItem(let id): PathOpener.copy(id, what: "The work item")
        case .other: break
        }
    }

    /// The pin's x in the dock: on the zoomed timeline when the view holds it, else on the strip.
    private func anchorX(of id: String, rows: [ReviewRow], view: ClosedRange<Double>, duration: Double, screen: Bool) -> CGFloat? {
        guard let row = rows.first(where: { $0.id == id }), let pin = TimelinePin(row: row) else { return nil }
        let column = max(1, width - Self.padding * 2 - (screen ? Self.screenWidth + 16 : 0))
        let range = view.contains(pin.sec) ? view : 0...max(duration, 1)
        return Self.padding + TimelineGeometry.x(pin.sec, in: range, width: column)
    }
}

/// The zoomed peaks' read key: a new view of the same meeting asks again (the model skips a covered one).
private struct ZoomRead: Equatable {
    let meeting: String
    let view: ClosedRange<Double>
}

// MARK: - The screen beside the sound (R41)

/// The frame at the playhead from the display the pane follows (G-SCR-1): the old frame stays until the new one is
/// read, and it changes at most once a second (G-SCR-3). Only this view reads the position for the screen.
private struct DockScreen: View {
    let screen: MeetingsAPI.MeetingScreen.Result
    let moment: Moment?
    let meeting: String
    let dock: TimelineDockModel
    let position: () -> Double?

    @AppStorage(MeetingsPreferences.Panes.screenHeight.key) private var screenHeight = MeetingsPreferences.Panes.screenHeight.defaultValue
    @State private var throttle = ScreenFrameThrottle()
    @State private var image: NSImage?
    @State private var held: Double?

    var body: some View {
        let chosen = dock.displays[meeting]
        let display = chosen ?? TimelineDockModel.autoDisplay(screen: screen, moment: moment)
        let at = dock.screenFollows ? (position() ?? moment?.spotSec ?? 0) : (held ?? position() ?? 0)
        let frame = TimelineDockModel.frame(in: screen, at: at, display: display)
        ScreenBesidePlayback(recorded: true, image: image, atSec: frame?.meetingSec,
                             apartSec: frame.flatMap { TimelineDockModel.apart($0, in: screen, at: at, display: display) },
                             hit: hit(for: frame),
                             displays: screen.displays.compactMap { display in
                                 display.id.map { ScreenDisplayChoice(id: $0, name: display.name ?? "Display \($0)", frames: display.frames) }
                             },
                             selectedDisplay: chosen,
                             height: CGFloat(screenHeight > 0 ? screenHeight : MeetingsPreferences.Panes.screenHeight.defaultValue),
                             follows: dock.screenFollows,
                             pickDisplay: { dock.displays[meeting] = $0 },
                             toggleFollows: {
                                 held = position()
                                 dock.screenFollows.toggle()
                             },
                             openFrame: frame.map { frame in { PathOpener.primary(frame.path) } })
            .task(id: frame?.path) { await show(frame) }
    }

    /// The Moment's OCR hit, on the frame that carries it.
    private func hit(for frame: MeetingsAPI.MeetingScreen.Frame?) -> MomentFrame.Hit? {
        guard let frame else { return nil }
        return moment?.screen?.first { $0.file == frame.file }?.hit
    }

    /// Reads the frame off the main thread, at most one change a second; a frame asked too soon waits its turn.
    private func show(_ frame: MeetingsAPI.MeetingScreen.Frame?) async {
        guard let frame else { return }
        var file = throttle.offer(frame.path, at: Self.now())
        while file == nil, throttle.pending == frame.path {
            try? await Task.sleep(for: .milliseconds(200))
            if Task.isCancelled { return }
            file = throttle.due(at: Self.now())
        }
        guard let file else { return }
        let url = URL(fileURLWithPath: file)
        let data = await Task.detached(priority: .userInitiated) { try? Data(contentsOf: url) }.value
        guard !Task.isCancelled else {
            throttle.failed(file)
            return
        }
        if let data, let decoded = NSImage(data: data), throttle.decoded(file, at: Self.now()) {
            image = decoded
        } else {
            throttle.failed(file)
        }
    }

    private static func now() -> Double { ProcessInfo.processInfo.systemUptime }
}
