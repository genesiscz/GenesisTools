import SwiftUI

// MARK: - Transcript

/// The corrected transcript (renames, confirmed items, dictionary) as Riverside blocks (R39) that follow the playback
/// (R42): a click on a line plays from there, ⇧-click and ⌘-click select lines for a comment or a clip (R43). The filter
/// field narrows the blocks and keeps a hit's whole block (⌘F puts the keyboard in it, Esc clears it).
struct TranscriptTab: View {
    @Bindable var detail: MeetingDetailModel
    @State private var filter = ""
    /// The one threshold: the blocks pane's "Apply above" picker and Settings set it. A second picker here kept its own
    /// value, so its preview and the pane's marks disagreed (90 % here still showed 80 % voices as plain names).
    @AppStorage(MeetingsPreferences.Transcript.applyAbove.key) private var applyAbove = MeetingsPreferences.Transcript.applyAbove.defaultValue
    @FocusState private var filterFocused: Bool

    /// The service's preview nearest the threshold (`applyAbove` in percent), or the plain entries without previews.
    static func shown(_ transcript: MeetingTranscript, applyAbove: Int) -> [TranscriptLine] {
        let threshold = Double(applyAbove) / 100
        return transcript.previews?.min { abs($0.threshold - threshold) < abs($1.threshold - threshold) }?.entries ?? transcript.entries
    }

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
                TranscriptBlocksPane(detail: detail, entries: Self.shown(transcript, applyAbove: applyAbove), filter: filter,
                                     headerField: AnyView(FilterField(text: $filter, prompt: "Filter the transcript", focused: $filterFocused)))
            }
        }
    }
}
