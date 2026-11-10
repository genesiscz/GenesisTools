import SwiftUI

/// One sign under a speaker's row: its sentence, and the stretches its chips play or show.
struct SpeakerHintLine: Equatable, Identifiable {
    /// What the sign says about the label.
    let sentence: String
    /// How much the sign weighs: "strong", "normal" or "weak"; nil when the engine gave none.
    let strength: String?
    let ranges: [SpeakerHint.Range]

    /// The sentence with its weight, as VoiceOver reads it: "May hold several people (weak sign)".
    var text: String { sentence + (strength.map { " (\($0) sign)" } ?? "") }
    var id: String { text }

    /// A weak sign is a note, not a warning: it draws in the secondary colour, so a strong one stands out beside it.
    var isWeak: Bool { strength == "weak" }
    var symbol: String { strength == "strong" ? "exclamationmark.triangle.fill" : isWeak ? "info.circle" : "exclamationmark.triangle" }
}

/// The signs about one speaker label ("May hold several people"), one line each under its row, each with the chips of
/// its own stretches right under it (G-SPK-1): chips after all the lines did not say which line they belong to.
struct SpeakerHints<Chips: View>: View {
    let hints: [SpeakerHintLine]
    @ViewBuilder let chips: (SpeakerHintLine) -> Chips

    var body: some View {
        ForEach(hints) { hint in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Image(systemName: hint.symbol).font(.system(size: 11)).frame(width: 16).accessibilityHidden(true)
                // The weight after the sentence, quieter than it: in brackets and in the warning colour, every weak
                // sign read as loud as a strong one.
                Text(verbatim: hint.sentence)
                    + Text(verbatim: hint.strength.map { "  \($0) sign" } ?? "").font(.system(size: 10.5)).foregroundColor(.secondary)
            }
            .font(.system(size: 11.5))
            .foregroundStyle(hint.isWeak ? AnyShapeStyle(.secondary) : AnyShapeStyle(KitPalette.modified))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(hint.text)
            chips(hint).padding(.leading, 22).padding(.bottom, 2)
        }
    }
}
