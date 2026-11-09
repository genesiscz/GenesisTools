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

    var body: some View {
        let reason = player.reason(target, in: meeting)
        let top = player.isTop(target, in: meeting)
        let playing = player.isPlaying(target, in: meeting)
        LiveButton(tooltip: reason?.message ?? tooltip(top: top, playing: playing), enabled: reason == nil, action: press) {
            HStack(spacing: 4) {
                Image(systemName: playing ? "pause.fill" : "play.fill")
                    .font(.system(size: 8.5, weight: .bold))
                    .accessibilityHidden(true)
                if let label {
                    Text(verbatim: label).font(.system(size: 11.5, design: .monospaced))
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
