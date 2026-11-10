import SwiftUI

// MARK: - Transcript

/// The corrected transcript (renames, confirmed items, dictionary) as Riverside blocks (R39) that follow the playback
/// (R42): a click on a line plays from there, ⇧-click and ⌘-click select lines for a comment or a clip (R43). The filter
/// field narrows the blocks and keeps a hit's whole block (⌘F puts the keyboard in it, Esc clears it).
struct TranscriptTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var filter = ""
    @FocusState private var filterFocused: Bool

    var body: some View {
        LoadablePane(state: detail.transcript, reading: "Reading the transcript…", retry: detail.loadTranscript,
                     noSource: detail.noTranscriptSource("transcript")) { transcript in
            VStack(spacing: 0) {
                FilterField(text: $filter, prompt: "Filter the transcript", focused: $filterFocused)
                    .padding(.horizontal, 14).padding(.vertical, 8)
                Divider()
                if transcript.entries.isEmpty {
                    EmptyState(symbol: "text.alignleft", text: "This meeting has no transcript",
                               detail: "A transcript comes from its source (Wispr Flow) once the meeting is linked.")
                } else {
                    // A lazy stack inside, not a List: an accessibility client asked a List for every row, and AppKit
                    // then built and hosted each of the 274 rows (10 to 13 s of CPU per walk, 2026-11-06).
                    TranscriptBlocksPane(detail: detail, entries: transcript.entries, filter: filter)
                }
            }
        }
    }
}
