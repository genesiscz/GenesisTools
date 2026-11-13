import SwiftUI

struct ListenVoicesEditor: View {
    let row: ReviewRow
    @Bindable var detail: MeetingDetailModel
    var close: () -> Void
    @State private var first = ""
    @State private var second = ""
    @State private var cut = 1

    private var words: [String] {
        let time = row.startSec ?? 0
        let line = detail.transcript.value?.entries.last { ($0.startSec ?? .infinity) <= time }
        return (line?.text ?? "").split(whereSeparator: \.isWhitespace).map(String.init)
    }
    private var people: [String] {
        Array(Set((detail.record.value?.participants ?? []).map(\.name) + row.choices.filter { ["suggested", "candidate", "presumed"].contains($0.role) }.map(\.value))).sorted()
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Two voices, in speaking order").font(.headline)
            Picker("First", selection: $first) { Text("Choose").tag(""); ForEach(people, id: \.self) { Text($0).tag($0) } }
            Picker("Then", selection: $second) { Text("Choose").tag(""); ForEach(people, id: \.self) { Text($0).tag($0) } }
            if words.count > 1 {
                Slider(value: Binding(get: { Double(cut) }, set: { cut = Int($0.rounded()) }), in: 1...Double(words.count - 1), step: 1)
                Text(words.prefix(cut).joined(separator: " ") + " | " + words.dropFirst(cut).joined(separator: " ")).font(.caption)
            } else {
                Text("No word boundary is available. The ordered voices will remain an unclear two-person mark.").font(.caption)
            }
            Button("Save voices") {
                let segments: [DecisionAction.VoiceSegment]? = words.count > 1 ? [.init(fromWord: 0, speaker: first), .init(fromWord: cut, speaker: second)] : nil
                detail.decide(row, .answer(row.id, first + ", then " + second, segments: segments), askReach: false)
                close()
            }.disabled(first.isEmpty || second.isEmpty || first == second)
        }.padding().frame(width: 430)
        .onAppear { detail.window?.player.pause() }
    }
}

struct ListenCommentEditor: View {
    let row: ReviewRow
    @Bindable var detail: MeetingDetailModel
    var close: () -> Void
    @State private var text = ""
    @State private var resume = false
    @FocusState private var focused: Bool
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Something else, for \(row.label)").font(.headline)
            TextField("Search or own comment:", text: $text).focused($focused).frame(width: 340)
            Text("This keeps the question open.").font(.caption).foregroundStyle(.secondary)
            HStack {
                Button("Cancel") { close() }
                Button("Save comment") { detail.decide(row, .answer(row.id, "", comment: text), askReach: false); close() }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }.padding()
        .onAppear { resume = detail.window?.player.phase == .playing; detail.window?.player.pause(); focused = true }
        .onDisappear { if resume { detail.window?.player.resume() } }
    }
}

struct ListenVoiceScores: View {
    let match: MeetingRecordView.Evidence.Voice.Match
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Remote voice scores").font(.headline)
            ForEach(match.candidates, id: \.person) { candidate in
                HStack { Text(candidate.person); Spacer(); Text(candidate.score.formatted(.number.precision(.fractionLength(3)))).monospacedDigit() }
            }
            Text("Cosine similarity, not a probability").font(.caption).foregroundStyle(.secondary)
            if match.quality == "unknown" { Text(match.reason).font(.caption).foregroundStyle(.secondary) }
        }.padding(8)
    }
}
