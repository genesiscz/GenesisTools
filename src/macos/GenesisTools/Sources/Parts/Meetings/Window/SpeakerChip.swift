import SwiftUI

/// A speaker's name, and the time when one is given, on a transcript block. Today a transcript row shows only the name
/// (its time sits in the row's own column); b-swift-timeline places it in the Riverside blocks and
/// b-swift-settings-contacts gives it its menu (Rename, Assign this stretch, Play), so both change one view.
struct SpeakerChip: View {
    let speaker: String
    /// When the block starts; nil shows the name alone.
    var startSec: Double? = nil
    /// Plays from `startSec`; nil shows the time as text.
    var play: ((Double) -> Void)? = nil

    var body: some View {
        HStack(spacing: 6) {
            Text(verbatim: name)
                .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
            if let startSec {
                if let play {
                    LiveButton(tooltip: "Play from \(MeetingsFormat.clock(startSec))", action: { play(startSec) }) {
                        time(startSec)
                    }
                    .accessibilityLabel("Play from \(MeetingsFormat.clock(startSec))")
                } else {
                    time(startSec)
                }
            }
        }
    }

    /// An empty label is a voice the source did not name.
    var name: String { speaker.isEmpty ? "Unknown voice" : speaker }

    private func time(_ seconds: Double) -> some View {
        Text(verbatim: MeetingsFormat.clock(seconds)).font(.system(size: 11, design: .monospaced))
            .foregroundStyle(KitPalette.renamed)
    }
}
