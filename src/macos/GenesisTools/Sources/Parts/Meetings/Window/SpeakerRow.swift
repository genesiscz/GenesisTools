import SwiftUI

/// One label of the Speakers tab: its numbers and signs, a Play button, and its rename field.
struct SpeakerRow: View {
    let speaker: SpeakerStat
    let rename: String?
    /// The rename field under the numbers (a narrow column) instead of beside them.
    var stacked = false
    /// Signs about the label ("May hold several people"), each a line under it.
    let hints: [String]
    /// Plays the label from its first line, to hear whose voice it is.
    let play: (() -> Void)?
    let commit: (String) -> Void

    var body: some View {
        Group {
            if stacked {
                VStack(alignment: .leading, spacing: 6) {
                    labels.frame(maxWidth: .infinity, alignment: .leading)
                    HStack(spacing: 8) {
                        playButton
                        field.frame(maxWidth: 260)
                    }
                }
            } else {
                HStack(spacing: 12) {
                    labels
                    Spacer()
                    playButton
                    field.frame(width: 220)
                }
            }
        }
        .padding(.vertical, 3)
    }

    private var labels: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: speaker.label).font(.system(size: 13, weight: .medium))
            Text(verbatim: [Plural.count(speaker.turns, "turn"), MeetingsFormat.length(speaker.spokenSec).map { "\($0) spoken" },
                            speaker.words.map { Plural.count($0, "word") }, MeetingsWords.speakerSpan(speaker),
                            MeetingsWords.origin(speaker.origin)].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 11.5)).foregroundStyle(.secondary)
            SpeakerHints(hints: hints)
        }
        .frameProbe("meetings.speaker.labels")
    }

    @ViewBuilder
    private var playButton: some View {
        if let play, let first = speaker.firstSec {
            IconButton(systemName: "play.fill", tooltip: "Play \(speaker.label) from the first line, at \(MeetingsFormat.clock(first))", action: play)
        }
    }

    private var field: some View {
        SpeakerNameField(label: speaker.label, rename: rename, commit: commit)
    }
}
