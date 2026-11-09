import SwiftUI

/// The Moment that plays: which meeting and which Moment (R18), where it is, the Moments under it on the context stack
/// (R38), and its controls: Pause or Play, Play again, Back to the Moment below, Stop. It floats over the whole window
/// (MeetingsRootView), so it stays while the reader opens another meeting, and it is gone while nothing plays.
/// b-swift-timeline builds the dock (the timeline and the strip) around it.
struct MeetingsPlayerBar: View {
    let player: MomentPlayer
    /// The playing meeting's title, when the overview knows it.
    let title: String?

    var body: some View {
        if player.isActive {
            VStack(spacing: 0) {
                Divider()
                VStack(alignment: .leading, spacing: 4) {
                    if player.stack.count > 1 { stackLine }
                    content
                }
                .padding(.horizontal, 14).padding(.vertical, 7)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            // It floats over the columns (MeetingsRootView), so it carries its own bar material.
            .background(.bar)
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Player")
            .accessibilityIdentifier("meetings.player")
            .transition(.opacity)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch player.phase {
        case .idle:
            EmptyView()
        case .cutting(let since):
            CuttingLine(since: since, name: name, cancel: { player.cancelCut() }, stop: { player.stop() })
        case .playing, .paused:
            HStack(spacing: 10) {
                playPause
                IconButton(systemName: "gobackward", tooltip: "Play this Moment again from its start, with its tone") { player.playAgain() }
                    .accessibilityIdentifier("meetings.player.again")
                PlayerClock(player: player)
                line(name)
                Spacer(minLength: 8)
                backButton
                stopButton
            }
        case .ended(let offerMore):
            HStack(spacing: 10) {
                IconButton(systemName: "play.fill", tooltip: "Play this Moment again from its start") { player.playAgain() }
                    .accessibilityIdentifier("meetings.player.again")
                line("Played \(name)")
                Spacer(minLength: 8)
                if offerMore {
                    GhostButton("Play \(Int(MeetingsPreferences.Playback.moreSec.value())) s more", symbol: "forward.end",
                                tooltip: "Play on after this Moment, as its own Moment",
                                identifier: "meetings.player.more") { player.playMore() }
                }
                backButton
                stopButton
            }
        case .failed(let failure):
            NoticePill(text: failure.sentence, more: failure.detail, tone: .error, dismiss: { player.dismissFailure() })
        }
    }

    /// "Design review · i12", or the Moment alone when the overview does not know the meeting.
    private var name: String {
        let moment = player.top?.label ?? ""
        guard let title else { return moment }
        return moment.isEmpty ? title : "\(title) · \(moment)"
    }

    /// The Moments under the top, oldest first: each comes back when the one above it ends (R38).
    private var stackLine: some View {
        let below = player.stack.dropLast().map(\.label)
        return Text(verbatim: "Then back to: \(below.reversed().joined(separator: " › "))")
            .font(.system(size: 11)).foregroundStyle(.secondary).lineLimit(1).truncationMode(.head)
            .accessibilityLabel("Then back to \(below.reversed().joined(separator: ", then "))")
    }

    @ViewBuilder
    private var playPause: some View {
        if player.phase == .playing {
            IconButton(systemName: "pause.fill", tooltip: "Pause") { player.pause() }
                .accessibilityIdentifier("meetings.player.pause")
        } else {
            IconButton(systemName: "play.fill",
                       tooltip: "Play on, \(MeetingsFormat.seconds(MeetingsPreferences.Playback.rewindSec.value())) earlier") { player.resume() }
                .accessibilityIdentifier("meetings.player.resume")
        }
    }

    @ViewBuilder
    private var backButton: some View {
        if player.stack.count > 1, let below = player.stack.dropLast().last {
            IconButton(systemName: "arrow.uturn.backward", tooltip: "Back to \(below.label), where it stopped") { player.pop() }
                .accessibilityIdentifier("meetings.player.back")
        }
    }

    private var stopButton: some View {
        IconButton(systemName: "stop.fill", tooltip: "Stop every Moment") { player.stop() }
            .accessibilityIdentifier("meetings.player.stop")
    }

    private func line(_ text: String) -> some View {
        Text(verbatim: text).font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
    }
}

/// "Cutting the clip" only after 200 ms (most clips are cut by then, G-PLAY-11), with Cancel from 5 s.
private struct CuttingLine: View {
    let since: Date
    let name: String
    let cancel: () -> Void
    let stop: () -> Void

    var body: some View {
        TimelineView(.periodic(from: since, by: 0.1)) { context in
            let shows = MomentPlayer.cuttingShows(elapsed: context.date.timeIntervalSince(since))
            HStack(spacing: 10) {
                if shows.words {
                    ProgressView().controlSize(.small)
                    Text(verbatim: "Cutting the clip of \(name)").font(.system(size: 12)).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                if shows.cancel {
                    GhostButton("Cancel", symbol: "xmark", tooltip: "Stop cutting this clip", identifier: "meetings.player.cancel", action: cancel)
                }
                IconButton(systemName: "stop.fill", tooltip: "Stop every Moment", action: stop)
                    .accessibilityIdentifier("meetings.player.stop")
            }
        }
    }
}

/// Where the top is on the meeting clock. Only this label reads the player's position, so the bar and the window above
/// it never draw again per tick.
private struct PlayerClock: View {
    let player: MomentPlayer

    var body: some View {
        Text(verbatim: MeetingsFormat.clock(player.position ?? player.top?.startSec ?? 0))
            .font(.system(size: 12).monospacedDigit())
            .accessibilityLabel("At \(MeetingsFormat.clock(player.position ?? 0))")
    }
}
