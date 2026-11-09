import SwiftUI

// MARK: - Speakers

/// Each label of the transcript with its turns and spoken time; a rename edits in place and commits on Return.
struct SpeakersTab: View {
    @Bindable var detail: MeetingDetailModel
    /// Below this width a speaker's rename field goes under its numbers: beside them, at the window's smallest size the
    /// field and the Play button left the numbers about 20 pt, one letter per line.
    static let stackWidth: CGFloat = 560
    @State private var stacked = false

    var body: some View {
        LoadablePane(state: detail.speakers, reading: "Reading the speakers…", retry: detail.loadSpeakers,
                     noSource: detail.noTranscriptSource("speakers")) { stats in
            if stats.speakers.isEmpty {
                EmptyState(symbol: "person.2", text: "No speaker yet", detail: "The speakers come from the transcript.")
            } else {
                let renames = detail.record.value?.speakers.labels ?? [:]
                // The most spoken first: in the CLI's order a label with 7 turns stood above one with 427.
                List(stats.speakers.sorted { $0.spokenSec > $1.spokenSec }) { speaker in
                    SpeakerRow(speaker: speaker, rename: renames[speaker.label], stacked: stacked,
                               hints: MeetingsWords.speakerHints(stats.hints ?? [], for: speaker.label),
                               play: speaker.firstSec.map { first in { detail.play(at: first) } }) {
                        detail.rename(label: speaker.label, to: $0)
                    }
                }
                .listStyle(.inset)
                .onGeometryChange(for: Bool.self, of: { $0.size.width < Self.stackWidth }) { stacked = $0 }
            }
        }
    }
}

