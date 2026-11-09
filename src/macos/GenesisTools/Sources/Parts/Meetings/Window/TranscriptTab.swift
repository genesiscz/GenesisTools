import SwiftUI

// MARK: - Transcript

/// The corrected transcript (renames, confirmed items, dictionary), one line per row; the time plays the audio from
/// there. The filter field narrows the lines (⌘F puts the keyboard in it, Esc clears it).
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
                let lines = visible(transcript.entries)
                if transcript.entries.isEmpty {
                    EmptyState(symbol: "text.alignleft", text: "This meeting has no transcript",
                               detail: "A transcript comes from its source (Wispr Flow) once the meeting is linked.")
                } else if lines.isEmpty {
                    EmptyState(symbol: "magnifyingglass", text: "No line holds “\(filter)”", actionTitle: "Clear the filter") { filter = "" }
                } else {
                    // A lazy stack, not a List: an accessibility client asked a List for every row, and AppKit then
                    // built and hosted each of the 274 rows (10 to 13 s of CPU per walk, 2026-11-06). The stack
                    // realizes only the rows near the viewport, as the Screen tab's does (0.8 s for 258 frames).
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(lines, id: \.rowID) { line in
                                TranscriptRow(line: line, play: { detail.play(at: $0) }).equatable()
                                    .padding(.horizontal, 14)
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
        }
    }

    private func visible(_ lines: [TranscriptLine]) -> [TranscriptLine] {
        let query = filter.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return lines }
        return lines.filter { $0.text.localizedStandardContains(query) || $0.speaker.localizedStandardContains(query) }
    }
}

private struct TranscriptRow: View, Equatable {
    let line: TranscriptLine
    let play: (Double) -> Void

    nonisolated static func == (a: TranscriptRow, b: TranscriptRow) -> Bool { a.line == b.line }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            if let start = line.startSec {
                LiveButton(tooltip: "Play from \(MeetingsFormat.clock(start))", action: { play(start) }) {
                    Text(verbatim: MeetingsFormat.clock(start)).font(.system(size: 11, design: .monospaced))
                        .foregroundStyle(KitPalette.renamed)
                }
                .frame(width: 58, alignment: .trailing)
                .accessibilityLabel("Play from \(MeetingsFormat.clock(start))")
            } else {
                Color.clear.frame(width: 58)
            }
            VStack(alignment: .leading, spacing: 2) {
                SpeakerChip(speaker: line.speaker)
                LineText(text: line.text)
            }
        }
        .padding(.vertical, 3)
        .contentShape(Rectangle())
        .liveRow()
        // One element per line (time, voice, text) with Play, instead of a node per text and button.
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "Play") { if let start = line.startSec { play(start) } }
    }
}

/// A transcript line's text, selectable while its row is live (under the pointer). A resting row holds plain text:
/// selectable text on all 274 lines gave an accessibility client a text node with links and paths to walk per line.
private struct LineText: View {
    let text: String
    @Environment(\.rowLive) private var live

    var body: some View {
        if live {
            plain.textSelection(.enabled)
        } else {
            plain
        }
    }

    private var plain: some View {
        Text(verbatim: text).font(.system(size: 13)).fixedSize(horizontal: false, vertical: true)
    }
}
