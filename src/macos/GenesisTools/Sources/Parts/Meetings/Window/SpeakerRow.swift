import SwiftUI

/// One label of the Speakers tab: its numbers and signs, a Play button, and its rename field.
struct SpeakerRow<Chips: View>: View {
    let speaker: SpeakerStat
    let rename: String?
    /// The rename field under the numbers (a narrow column) instead of beside them.
    let stacked: Bool
    /// Signs about the label ("May hold several people"), each a line under it.
    let hints: [SpeakerHintLine]
    /// Plays the label from its first line, to hear whose voice it is.
    let play: (() -> Void)?
    /// The chips of one sign's stretches, drawn under its line.
    let chips: (SpeakerHintLine) -> Chips
    let commit: (String) -> Void

    init(speaker: SpeakerStat, rename: String?, stacked: Bool = false, hints: [SpeakerHintLine], play: (() -> Void)?,
         @ViewBuilder chips: @escaping (SpeakerHintLine) -> Chips, commit: @escaping (String) -> Void) {
        self.speaker = speaker
        self.rename = rename
        self.stacked = stacked
        self.hints = hints
        self.play = play
        self.chips = chips
        self.commit = commit
    }

    var body: some View {
        // The play button stands before the name it plays. At the row's trailing end it was a window's width from the
        // name, and in a narrow column it sat with the field under the last sign.
        HStack(alignment: .top, spacing: 8) {
            playButton.frame(width: Self.playWidth, height: 17)
            if stacked {
                labels(fieldUnderNumbers: true).frame(maxWidth: .infinity, alignment: .leading)
            } else {
                labels(fieldUnderNumbers: false)
                Spacer()
                field.frame(width: 220).frame(height: Self.nameBlockHeight)
            }
        }
        .padding(.vertical, 3)
    }

    /// The height of the name and the numbers under it, which the play button and the field centre on.
    static var nameBlockHeight: CGFloat { 32 }
    /// The play button's column: a label that cannot play keeps it, so every name starts on one line.
    static var playWidth: CGFloat { 20 }

    private func labels(fieldUnderNumbers: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: speaker.label).font(.system(size: 13, weight: .medium))
            Text(verbatim: MeetingsWords.factsLine([Plural.count(speaker.turns, "turn"), MeetingsFormat.length(speaker.spokenSec).map { "\($0) spoken" },
                                                    speaker.words.map { Plural.count($0, "word") }, MeetingsWords.speakerSpan(speaker),
                                                    MeetingsWords.origin(speaker.origin)].compactMap { $0 }))
                .font(.system(size: 11.5)).foregroundStyle(.secondary)
            if fieldUnderNumbers { field.frame(maxWidth: 260).padding(.vertical, 4) }
            SpeakerHints(hints: hints, chips: chips)
        }
        .frameProbe("meetings.speaker.labels")
    }

    @ViewBuilder
    private var playButton: some View {
        if let play, let first = speaker.firstSec {
            IconButton(systemName: "play.fill", tooltip: "Play \(speaker.label) from the first line, at \(MeetingsFormat.clock(first))", action: play)
        } else {
            Color.clear
        }
    }

    private var field: some View {
        SpeakerNameField(label: speaker.label, rename: rename, atSec: speaker.firstSec, commit: commit)
    }
}

extension SpeakerRow where Chips == EmptyView {
    /// A row whose signs have no chips.
    init(speaker: SpeakerStat, rename: String?, stacked: Bool = false, hints: [SpeakerHintLine], play: (() -> Void)?,
         commit: @escaping (String) -> Void) {
        self.init(speaker: speaker, rename: rename, stacked: stacked, hints: hints, play: play, chips: { _ in EmptyView() },
                  commit: commit)
    }
}
