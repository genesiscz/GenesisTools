import SwiftUI

/// The transcript beside the review rows, in the meeting's trailing pane slot (`MeetingDetailView.trailingPane`). For
/// now it lists the Transcript tab's lines; b-swift-timeline (F9) makes it the Riverside blocks that follow playback.
struct TranscriptPane: View {
    @Bindable var detail: MeetingDetailModel

    var body: some View {
        TranscriptTab(detail: detail)
            .onAppear { detail.ensureTranscript() }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Transcript")
    }
}
