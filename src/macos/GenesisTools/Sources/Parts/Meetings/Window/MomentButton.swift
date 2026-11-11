import SwiftUI

/// The one play control of a Moment (R13, G15): the row's Play and its time link are this one button, in the accent
/// colour (G65). A click plays the Moment through the window's player; on the Moment that plays it pauses, and on a
/// paused one it plays on (R14: a second click no longer starts over). When the player knows why the Moment cannot play
/// (no audio on this Mac, still recording, no ffmpeg, too long), the button is disabled and says why (G-STATE-1).
struct MomentButton: View {
    let player: MomentPlayer
    let meeting: String
    let target: MomentTarget
    /// The time it shows ("05:09", "05:09–05:31"); nil shows the glyph alone.
    var label: String?
    /// Where the click comes from: it decides push or replace on the context stack.
    var source: MomentSource = .row
    /// What the button shows, handed in by a list that computed it once per row (`MomentPlay`); nil reads the player
    /// here, which makes the button re-run on every play, pause and stop of any Moment.
    var shown: Shown?

    /// The player's state as one button shows it.
    struct Shown: Equatable {
        var reason: MomentCannot?
        var top = false
        var playing = false
    }

    var body: some View {
        let shown = self.shown ?? Shown(reason: player.reason(target, in: meeting), top: player.isTop(target, in: meeting),
                                        playing: player.isPlaying(target, in: meeting))
        let reason = shown.reason, top = shown.top, playing = shown.playing
        // Pressable at rest: inside a resting row (`.liveRow`) a plain LiveButton draws only its label, so a pointer
        // already over the row, VoiceOver and `tools control` could not press it.
        LiveButton(tooltip: reason?.message ?? tooltip(top: top, playing: playing), enabled: reason == nil, pressable: true, action: press) {
            HStack(spacing: 4) {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 8.5, weight: .bold))
                    .accessibilityHidden(true)
                if let label {
                    // One line at its own width: in a squeezed header a range wrapped at its dash.
                    Text(verbatim: label).font(.system(size: 11.5, design: .monospaced)).lineLimit(1).fixedSize()
                }
            }
            .foregroundStyle(reason == nil ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.tertiary))
            .padding(.horizontal, 6).padding(.vertical, 2)
            .background(Color.accentColor.opacity(top ? 0.2 : 0.08), in: Capsule())
            .contentShape(Capsule())
        }
        .accessibilityLabel(accessibilityLabel(playing: playing))
        .accessibilityHint(reason?.message ?? "")
        .accessibilityIdentifier("meetings.moment")
    }

    private func press() {
        if player.isTop(target, in: meeting), player.phase != .idle, !isCutting {
            player.togglePause()
        } else {
            player.play(target, in: meeting, from: source)
        }
    }

    private var isCutting: Bool {
        if case .cutting = player.phase { return true }
        if case .failed = player.phase { return true }
        return false
    }

    private func tooltip(top: Bool, playing: Bool) -> String {
        if playing { return "Pause" }
        if top { return "Play on" }
        return "Play \(label ?? "this Moment"): a short clip with the tone at the asked spot"
    }

    private func accessibilityLabel(playing: Bool) -> String {
        let what = label.map { "the Moment at \($0)" } ?? "this Moment"
        return playing ? "Pause \(what)" : "Play \(what)"
    }
}

/// The player's state as one review row's play controls and header see it (cause 6 of the 2026-11-11 lag report). The
/// Items list computes it once per row and hands it in as a value, so a play, a pause or a stop re-runs only the rows
/// whose Moments it concerns, not every MomentButton on screen.
struct MomentPlay: Equatable {
    /// The top layer, while it plays one of the row's targets in this meeting.
    var top: MomentLayer?
    /// The player's phase while `top` is set; idle otherwise.
    var phase: MomentPlayer.Phase = .idle
    /// Why no Moment of the meeting can play (no audio on this Mac, still recording, no ffmpeg).
    var meetingCannot: MomentCannot?
    /// Why one of the row's targets cannot play (too long).
    var targetCannot: [MomentTarget: MomentCannot] = [:]

    static let none = MomentPlay()

    /// `player`'s state for `targets` of `meeting`.
    @MainActor
    static func of(_ player: MomentPlayer, meeting: String, targets: [MomentTarget]) -> MomentPlay {
        var play = MomentPlay(meetingCannot: player.cannot[meeting])
        if let top = player.top, top.meeting == meeting, targets.contains(top.target) {
            play.top = top
            play.phase = player.phase
        }
        if play.meetingCannot == nil {
            for target in targets {
                if let reason = player.reason(target, in: meeting) { play.targetCannot[target] = reason }
            }
        }
        return play
    }

    /// What the button of `target` shows.
    func button(_ target: MomentTarget) -> MomentButton.Shown {
        let top = self.top?.target == target
        return MomentButton.Shown(reason: meetingCannot ?? targetCannot[target], top: top, playing: top && phase == .playing)
    }
}
