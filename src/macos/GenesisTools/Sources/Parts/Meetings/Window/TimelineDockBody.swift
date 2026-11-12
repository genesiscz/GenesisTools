import SwiftUI

// MARK: - The dock's body: buttons, the strip, the zoomed timeline and the breadcrumb (R47, R48, G-LAYOUT-1)

/// Which part of the meeting the zoomed timeline shows: the clip, a context window around it
/// (`meetings.playback.contextSec`), or the whole meeting. A view change only; the sound goes on (R4).
enum DockZoom: String, CaseIterable, Identifiable {
    case clip, context, meeting

    var id: String { rawValue }
    var title: String {
        switch self {
        case .clip: return "Clip"
        case .context: return "Context"
        case .meeting: return "Meeting"
        }
    }
}

/// What the dock shows: plain values the wiring reads from MomentPlayer, the detail model and `meeting.waveform`.
struct TimelineDockState: Equatable {
    var meetingTitle: String
    /// The context stack from the bottom (StackBreadcrumb).
    var moments: [StackBreadcrumb.Level]
    var isPlaying: Bool
    /// The top's span; nil in whole-meeting playback.
    var span: ZoomSpan?
    var zoom: DockZoom
    /// The seconds the zoomed timeline shows (the wiring computes it from `zoom`: `span.fitView`,
    /// `span.contextView(...)`, or the whole meeting, or a range the strip's lens was dragged to).
    var view: ClosedRange<Double>
    var durationSec: Double
    /// Whole-meeting peaks for the strip, and finer peaks for the zoomed view with the seconds they cover.
    var wholePeaks: [Double]
    var zoomPeaks: [Double]
    var zoomPeaksRange: ClosedRange<Double>
    var pins: [TimelinePin]
    /// `phase == .ended(offerMore: true)`.
    var offerMore: Bool
    /// `meetings.playback.moreSec`.
    var moreSec: Double = 30
    /// Skip length of the back and forward buttons.
    var skipSec: Double = 5
    /// The ranges the reader zoomed to while the top plays, the shown one last (TimelineDockModel's trail).
    var views: [ClosedRange<Double>] = []
    /// Who talks when (the waveform's colours) and the speakers for the legend; empty: one colour.
    var voices: [VoiceSpan] = []
    var legend: [VoiceLegend] = []
    /// Rows the pins have in whole-meeting mode.
    var pinLanes: Int = 2
    var toneEnabled = true

    /// A zoomed range in words: "48:46 to 1:27:00".
    static func viewTitle(_ range: ClosedRange<Double>) -> String {
        "\(MeetingsFormat.clock(range.lowerBound)) to \(MeetingsFormat.clock(range.upperBound))"
    }

    /// What "Back" goes to, in words: the range before the shown one, or the top's own view.
    var backTitle: String? {
        guard !views.isEmpty else { return nil }
        if views.count >= 2 { return Self.viewTitle(views[views.count - 2]) }
        return span == nil ? "the whole meeting" : "the clip"
    }
}

/// What the dock's controls do; each closure maps to one MomentPlayer method or one view change (see the lane's
/// Wiring section).
struct TimelineDockActions {
    var togglePause: () -> Void = {}
    var setToneEnabled: (Bool) -> Void = { _ in }
    /// Seek by a number of seconds (negative: back).
    var skip: (Double) -> Void = { _ in }
    /// Play from a second (a waveform click, a flag click with its G-PLAY-3 target).
    var seek: (Double) -> Void = { _ in }
    var flag: (Double) -> Void = { _ in }
    var playAgain: () -> Void = {}
    var playMore: () -> Void = {}
    var setZoom: (DockZoom) -> Void = { _ in }
    /// A new view range from the strip's lens or a merged pin.
    var setView: (ClosedRange<Double>) -> Void = { _ in }
    var popTo: (Int) -> Void = { _ in }
    /// Back to a zoomed range before the shown one (its index in `views`), or to the top's own view (nil).
    var popView: (Int?) -> Void = { _ in }
    var showMeeting: () -> Void = {}
    /// Ends every Moment; the dock goes.
    var stop: () -> Void = {}
    var pins: TimelinePinsRow.Actions = .init()
}

/// The dock under the Moment that plays: breadcrumb and buttons, the whole-conversation strip with its lens, the
/// connector, the zoomed timeline, and an optional trailing pane (the screen beside the sound, R41). `collapsed` is the
/// form for the smallest window or `meetings.timeline.shown` off (G-LAYOUT-1): one line with the buttons, the
/// breadcrumb and a mini bar of the clip.
struct TimelineDockBody<Trailing: View>: View {
    let state: TimelineDockState
    /// The player's position, read only by the playheads and the clock.
    let position: () -> Double?
    var actions: TimelineDockActions = .init()
    var collapsed: Bool = false
    /// The trailing pane's width when there is one.
    var trailingWidth: CGFloat = 290
    @ViewBuilder var trailing: () -> Trailing

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if collapsed {
                collapsedLine
            } else {
                HStack(spacing: 10) {
                    StackBreadcrumb(meeting: state.meetingTitle, moments: state.moments,
                                    views: state.views.map(TimelineDockState.viewTitle), isPlaying: state.isPlaying,
                                    onMeeting: actions.showMeeting, onPop: actions.popTo, onView: actions.popView)
                    Spacer(minLength: 8)
                }
                buttons
                HStack(alignment: .top, spacing: 16) {
                    VStack(spacing: 0) {
                        // In the Meeting view the zoomed timeline is the whole meeting already: no second strip.
                        if state.zoom != .meeting {
                            ConversationStrip(durationSec: state.durationSec, peaks: state.wholePeaks, zoom: state.view,
                                              position: position, pins: state.pins, voices: state.voices,
                                              onZoom: actions.setView, pinActions: actions.pins)
                            ZoomConnector(zoom: state.view, durationSec: state.durationSec)
                        }
                        MomentTimeline(span: state.zoom == .meeting ? nil : state.span, view: state.view,
                                       peaks: state.zoomPeaks, peaksRange: state.zoomPeaksRange, position: position,
                                       pins: state.pins, offerMore: state.offerMore, moreSec: state.moreSec,
                                       zoomedOut: state.zoom != .clip, voices: state.voices, legend: state.legend,
                                       pinLanes: state.pinLanes, onFlag: actions.flag, onSeek: actions.seek,
                                       onZoom: { out in actions.setZoom(out ? .context : .clip) },
                                       onPlayMore: actions.playMore, pinActions: actions.pins)
                    }
                    if Trailing.self != EmptyView.self {
                        trailing().frame(width: trailingWidth)
                    }
                }
            }
        }
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 12)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Timeline")
        .accessibilityIdentifier("meetings.dock")
    }

    /// The one main action of the dock. With its word in the open dock, one glyph in the one-line dock; the word
    /// changes with the state, so the button keeps one width.
    @ViewBuilder
    private func playPause(words: Bool) -> some View {
        let symbol = state.isPlaying ? "pause.fill" : "play.fill"
        let tooltip = state.isPlaying ? "Pause (Space)" : "Play (Space)"
        if words {
            KitButton(state.isPlaying ? "Pause" : "Play", symbol: symbol, kind: .primary, hue: .play, minWidth: 84,
                      tooltip: tooltip, identifier: "meetings.dock.playPause", action: actions.togglePause)
        } else {
            KitButton(symbol: symbol, tooltip: tooltip, kind: .primary, hue: .play, identifier: "meetings.dock.playPause",
                      action: actions.togglePause)
        }
    }

    /// Back and forward by the skip setting. The open dock writes the seconds as text beside the glyph; the one-line
    /// dock keeps the two glyphs.
    @ViewBuilder
    private func skipButtons(words: Bool) -> some View {
        let seconds = Int(state.skipSec)
        HStack(spacing: 4) {
            if words {
                KitButton("\(seconds) s", symbol: "gobackward", tooltip: "Back \(seconds) s (←)", identifier: "meetings.dock.back") {
                    actions.skip(-state.skipSec)
                }
                .accessibilityLabel("Back \(seconds) seconds")
                KitButton("\(seconds) s", trailingSymbol: "goforward", tooltip: "Forward \(seconds) s (→)", identifier: "meetings.dock.forward") {
                    actions.skip(state.skipSec)
                }
                .accessibilityLabel("Forward \(seconds) seconds")
            } else {
                IconButton(systemName: "gobackward.5", tooltip: "Back \(seconds) s (←)") { actions.skip(-state.skipSec) }
                    .accessibilityIdentifier("meetings.dock.back")
                IconButton(systemName: "goforward.5", tooltip: "Forward \(seconds) s (→)") { actions.skip(state.skipSec) }
                    .accessibilityIdentifier("meetings.dock.forward")
            }
        }
    }

    private var buttons: some View {
        HStack(spacing: 8) {
            playPause(words: true)
            skipButtons(words: true)
            if let span = state.span {
                GhostButton("Asked point", symbol: "flag.fill", tooltip: "Play from the asked spot, with its tone",
                            hue: .play, identifier: "meetings.dock.asked") { actions.flag(span.flagSeekTarget) }
                GhostButton("Replay clip", symbol: "arrow.counterclockwise", tooltip: "Play this clip again from its start",
                            identifier: "meetings.dock.replay", action: actions.playAgain)
            }
            KitToggleChip("Tone", isOn: Binding(get: { state.toneEnabled }, set: actions.setToneEnabled),
                          hue: .play, size: .small, tooltip: "Play a tone before the asked spot in the next clip",
                          identifier: "meetings.dock.tone")
            PositionClock(position: position)
            Spacer(minLength: 8)
            // Only while a zoomed range shows; it stands in the free room before the view choice, so nothing moves.
            if let back = state.backTitle {
                GhostButton("Back", symbol: "arrow.uturn.backward", tooltip: "Show \(back) on the timeline again; the sound goes on",
                            identifier: "meetings.dock.viewBack") {
                    actions.popView(state.views.count >= 2 ? state.views.count - 2 : nil)
                }
            }
            GenSegmentedTabs("Zoom", items: DockZoom.allCases.map { zoom in
                                 GenSegmentedTabs.Item(zoom, zoom.title, isEnabled: zoom == .meeting || state.span != nil)
                             },
                             selection: Binding(get: { state.zoom }, set: { actions.setZoom($0) }), minSegmentWidth: 58,
                             identifier: "meetings.dock.zoom")
                .instantTooltip("What the timeline shows; the sound goes on (⌘+ ⌘- ⌘0)")
            stopButton
        }
    }

    private var stopButton: some View {
        IconButton(systemName: "stop.fill", tooltip: "Stop every Moment", size: 13, action: actions.stop)
            .accessibilityIdentifier("meetings.dock.stop")
    }

    private var collapsedLine: some View {
        HStack(spacing: 10) {
            playPause(words: false)
            skipButtons(words: false)
            StackBreadcrumb(meeting: state.meetingTitle, moments: state.moments, isPlaying: state.isPlaying,
                            onMeeting: actions.showMeeting, onPop: actions.popTo)
                .frame(maxWidth: 340, alignment: .leading)
                .layoutPriority(1)
            if let span = state.span {
                PlayingRowBar(span: span, position: position, onFlag: actions.flag, onSeek: actions.seek)
                    .frame(minWidth: 160, maxWidth: .infinity)
            } else {
                Spacer(minLength: 8)
                PositionClock(position: position)
            }
            stopButton
        }
    }
}

extension TimelineDockBody where Trailing == EmptyView {
    init(state: TimelineDockState, position: @escaping () -> Double?, actions: TimelineDockActions = .init(), collapsed: Bool = false) {
        self.init(state: state, position: position, actions: actions, collapsed: collapsed, trailing: { EmptyView() })
    }
}

/// The position as a clock; only this label reads it.
private struct PositionClock: View {
    let position: () -> Double?

    var body: some View {
        Text(verbatim: MeetingsFormat.clock(position() ?? 0))
            .font(.system(size: 12).monospacedDigit())
            .foregroundStyle(.secondary)
            .accessibilityLabel("At \(MeetingsFormat.clock(position() ?? 0))")
    }
}
