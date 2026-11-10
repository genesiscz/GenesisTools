import SwiftUI

/// One sign under a speaker's row: its sentence, and the stretches its chips play or show.
struct SpeakerHintLine: Equatable, Identifiable {
    let text: String
    let ranges: [SpeakerHint.Range]

    var id: String { text }
}

/// The signs about one speaker label ("May hold several people"), one line each under its row, each with the chips of
/// its own stretches right under it (G-SPK-1): chips after all the lines did not say which line they belong to.
struct SpeakerHints<Chips: View>: View {
    let hints: [SpeakerHintLine]
    @ViewBuilder let chips: (SpeakerHintLine) -> Chips

    var body: some View {
        ForEach(hints) { hint in
            Label(hint.text, systemImage: "exclamationmark.triangle").font(.system(size: 11.5)).foregroundStyle(KitPalette.modified)
            chips(hint).padding(.leading, 22).padding(.bottom, 2)
        }
    }
}
