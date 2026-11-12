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
                ListVariantLoadFailure(failure) { timeline.loadOlder() }
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

/// The existing stack uses error strings; unified carries structured reports. Both retain retry here.
struct ListVariantLoadFailure: View {
    let message: String
    let retry: () -> Void

    init(_ message: String, retry: @escaping () -> Void) {
        self.message = message
        self.retry = retry
    }

    init(_ report: FailureReport, retry: @escaping () -> Void) {
        self.message = report.headline
        self.retry = retry
    }

    var body: some View {
        HStack {
            Text(message).foregroundStyle(.secondary).textSelection(.enabled)
            Button("Try again", action: retry)
                .buttonStyle(.genHoverPlain())
                .instantTooltip("Repeat the failed activity load")
        }
        .font(.system(size: 12))
        .padding(8)
    }
}
