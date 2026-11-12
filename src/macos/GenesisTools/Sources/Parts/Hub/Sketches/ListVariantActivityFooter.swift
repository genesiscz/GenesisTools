import SwiftUI

/// Loading and diagnostics stay reachable in either Activity layout.
struct ListVariantActivityFooter: View {
    @ObservedObject var timeline: HubTimelineModel

    var body: some View {
        HStack(spacing: 10) {
            if timeline.hasMore {
                Button(timeline.loadingOlder ? "Reading older activity…" : "Load older") { timeline.loadOlder() }
                    .disabled(timeline.loadingOlder)
                    .buttonStyle(.genHoverPlain())
            }
            if let failure = timeline.olderError {
                FailureInline(failure, form: .compact) { timeline.loadOlder() }
            }
            if !timeline.warnings.isEmpty {
                Image(systemName: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
                    .instantTooltip(timeline.warnings.joined(separator: "\n"))
            }
            Spacer()
        }
        .font(.system(size: 12))
        .padding(10)
        .hubSurface(.bar)
    }
}
