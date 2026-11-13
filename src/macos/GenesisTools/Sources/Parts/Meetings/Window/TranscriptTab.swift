import SwiftUI

// MARK: - Transcript

/// The corrected transcript (renames, confirmed items, dictionary) as Riverside blocks (R39) that follow the playback
/// (R42): a click on a line plays from there, ⇧-click and ⌘-click select lines for a comment or a clip (R43). The filter
/// field narrows the blocks and keeps a hit's whole block (⌘F puts the keyboard in it, Esc clears it).
struct TranscriptTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var filter = ""
    @AppStorage("meetings.transcript.previewThreshold") private var previewThreshold = 0.7
    @FocusState private var filterFocused: Bool

    var body: some View {
        LoadablePane(state: detail.transcript, reading: "Reading the transcript…", retry: detail.loadTranscript,
                     noSource: detail.noTranscriptSource("transcript")) { transcript in
            if transcript.entries.isEmpty {
                EmptyState(symbol: "text.alignleft", text: "This meeting has no transcript",
                           detail: "A transcript comes from its source (Wispr Flow) once the meeting is linked.")
            } else {
                // A lazy stack inside, not a List: an accessibility client asked a List for every row, and AppKit
                // then built and hosted each of the 274 rows (10 to 13 s of CPU per walk, 2026-11-06).
                // The filter field is the pane's header line, beside "Follows playback": as a line of its own it
                // left that one switch alone on a second line.
                VStack(spacing: 0) {
                    if let previews = transcript.previews, !previews.isEmpty {
                        Picker("Apply suggestions at", selection: $previewThreshold) {
                            ForEach(previews, id: \.threshold) { preview in
                                Text("\(Int(preview.threshold * 100)) %").tag(preview.threshold)
                            }
                        }.pickerStyle(.segmented).padding(.horizontal, 16).padding(.vertical, 6)
                            .accessibilityIdentifier("meetings.transcript.threshold")
                    }
                    let shown = transcript.previews?.min { abs($0.threshold - previewThreshold) < abs($1.threshold - previewThreshold) }?.entries ?? transcript.entries
                    TranscriptBlocksPane(detail: detail, entries: shown, filter: filter,
                                         headerField: AnyView(FilterField(text: $filter, prompt: "Filter the transcript", focused: $filterFocused)))
                }
            }
        }
    }
}
