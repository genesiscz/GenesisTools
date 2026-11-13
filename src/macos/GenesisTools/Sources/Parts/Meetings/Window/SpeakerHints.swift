import SwiftUI

/// The signs about one speaker label ("May hold several people"), one line each under its row. b-swift-timeline turns
/// a hint's ranges into chips that play them (G-SPK-1).
struct SpeakerHints: View {
    let hints: [String]

    var body: some View {
        ForEach(hints, id: \.self) { hint in
            Label(hint, systemImage: "exclamationmark.triangle").font(.system(size: 11.5)).foregroundStyle(KitPalette.modified)
        }
    }
}
