import SwiftUI

/// The audio that plays from a transcript time: which meeting, where it is, Pause or Resume, and Stop. It sits under
/// the whole window, so it stays while the reader opens another meeting, and it is gone while nothing plays. Before it,
/// a time click started a player with sound and the window showed nothing and could not stop it.
struct MeetingsPlayerBar: View {
    let playback: MeetingsPlayback
    /// The playing meeting's title, when the overview knows it.
    let title: String?

    var body: some View {
        if playback.state != .idle {
            VStack(spacing: 0) {
                Divider()
                content
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Audio")
            .accessibilityIdentifier("meetings.player")
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch playback.state {
        case .idle:
            EmptyView()
        case .starting(let from):
            HStack(spacing: 10) {
                ProgressView().controlSize(.small)
                line("Starting the audio at \(MeetingsFormat.clock(from))")
                Spacer(minLength: 8)
                stopButton
            }
        case .playing(let session):
            HStack(spacing: 10) {
                Image(systemName: "speaker.wave.2.fill").foregroundStyle(.secondary).accessibilityHidden(true)
                PlaybackClock(session: session)
                line(title.map { "Playing \($0)" } ?? "Playing")
                Spacer(minLength: 8)
                if session.canPause {
                    IconButton(systemName: "pause.fill", tooltip: "Pause the audio") { playback.pause() }
                        .accessibilityIdentifier("meetings.player.pause")
                }
                stopButton
            }
        case .paused(_, let at):
            HStack(spacing: 10) {
                Image(systemName: "pause.circle").foregroundStyle(.secondary).accessibilityHidden(true)
                Text(verbatim: MeetingsFormat.clock(at)).font(.system(size: 12).monospacedDigit())
                line(title.map { "Paused: \($0)" } ?? "Paused")
                Spacer(minLength: 8)
                IconButton(systemName: "play.fill", tooltip: "Resume the audio") { playback.resume() }
                    .accessibilityIdentifier("meetings.player.resume")
                stopButton
            }
        case .failed(let failure, _):
            NoticePill(text: failure.sentence, more: failure.detail, tone: .error,
                       fixes: [.button("Retry", symbol: "arrow.clockwise") { playback.retry() }],
                       dismiss: { playback.dismiss() })
        }
    }

    private var stopButton: some View {
        IconButton(systemName: "stop.fill", tooltip: "Stop the audio") { playback.stop() }
            .accessibilityIdentifier("meetings.player.stop")
    }

    private func line(_ text: String) -> some View {
        Text(text).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
    }
}

/// Where the audio is, counted on the wall clock from its start. Only this label ticks, so the bar and the window
/// above it never draw again per second.
private struct PlaybackClock: View {
    let session: MeetingsPlayback.Session

    var body: some View {
        TimelineView(.periodic(from: session.resumedAt, by: 1)) { context in
            Text(verbatim: MeetingsFormat.clock(session.position(at: context.date)))
                .font(.system(size: 12).monospacedDigit())
        }
    }
}
