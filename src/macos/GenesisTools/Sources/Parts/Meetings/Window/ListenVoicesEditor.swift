import SwiftUI

struct ListenVoicesEditor: View {
    let row: ReviewRow
    @Bindable var detail: MeetingDetailModel
    var close: () -> Void
    @State private var first = ""
    @State private var second = ""
    @State private var cut = 1
    @State private var words: [String] = []
    @State private var people: [String] = []
    @State private var search: PeopleSearch?
    @State private var showEverybody = false
    @State private var unavailable: [PersonSourceState] = []

    private var sourceLines: [QuestionDetails.Line] {
        detail.rows.value?.questionDetailsByID[row.id]?.decidedLines ?? []
    }

    private func updateWords() {
        words = Self.splitWords(sourceLines, at: row.startSec ?? 0)
        cut = min(max(1, cut), max(1, words.count - 1))
    }

    /// The words a split offset counts: the question's original line, which the journal splits. The displayed
    /// transcript is never used, since a spelling edit there changes how many words come before the boundary; without
    /// an original line there is no split, and the voices save as the ordered two-person mark.
    static func splitWords(_ sourceLines: [QuestionDetails.Line], at time: Double) -> [String] {
        let source = sourceLines.last { ($0.startSec ?? .infinity) <= time } ?? sourceLines.first
        return (source?.text ?? "").split(whereSeparator: \.isWhitespace).map(String.init)
    }
    static func offeredPeople(_ known: [KnownPerson], row: ReviewRow, everybody: Bool) -> [String] {
        PeopleText.questionPeople(known, choices: row.choices.filter { $0.action.kind == "answer" && ["earlier", "suggested", "candidate", "presumed"].contains($0.role) }.map(\.value),
                                 query: "", hideAbsent: row.startSec != nil && !everybody).map(\.name)
    }
    private func updatePeople() {
        people = Self.offeredPeople(search?.people ?? [], row: row, everybody: showEverybody)
        if !people.contains(first) { first = "" }
        if !people.contains(second) { second = "" }
    }
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Two voices, in speaking order").font(.headline)
            ForEach(unavailable, id: \.kind) { source in
                InfoStrip("\(source.kind.title): \(source.reason ?? "not available")", tone: .info)
            }
            Picker("First", selection: $first) { Text("Choose").tag(""); ForEach(people, id: \.self) { Text($0).tag($0) } }
            Picker("Then", selection: $second) { Text("Choose").tag(""); ForEach(people, id: \.self) { Text($0).tag($0) } }
            if !showEverybody {
                Button("Show everybody") { showEverybody = true }.buttonStyle(.genHoverPlain())
                    .instantTooltip("Include people who were outside the call at this time")
            }
            if words.count > 2 {
                Slider(value: Binding(get: { Double(cut) }, set: { cut = Int($0.rounded()) }), in: 1...Double(words.count - 1), step: 1) {
                    Text("Second voice starts at")
                }
                .accessibilityValue(Self.boundary(words, cut: cut))
            }
            if words.count > 1 {
                Text(words.prefix(cut).joined(separator: " ") + " | " + words.dropFirst(cut).joined(separator: " ")).font(.caption)
                    .accessibilityHidden(words.count > 2)
            } else if words.isEmpty, let failure = detail.rows.failure {
                NoticePill(text: failure.sentence, more: failure.detail, tone: .error)
                Button("Retry") { detail.loadRows() }
            } else if words.isEmpty, detail.rows.value == nil {
                ProgressView("Reading the words…").controlSize(.small)
            } else {
                Text("No word boundary is available. The ordered voices will remain an unclear two-person mark.").font(.caption)
            }
            Button("Save voices") {
                let segments: [DecisionAction.VoiceSegment]? = words.count > 1 ? [.init(fromWord: 0, speaker: first), .init(fromWord: cut, speaker: second)] : nil
                detail.decide(row, .answer(row.id, first + ", then " + second, segments: segments), askReach: false)
                close()
            }.buttonStyle(.genHoverPlain()).disabled(first.isEmpty || second.isEmpty || first == second
                                                    || (words.isEmpty && detail.rows.value == nil))
        }.padding().frame(width: 430)
        .onAppear {
            detail.window?.player.pause()
            updateWords()
            let next = detail.peopleSearch(atSec: row.startSec); search = next; next.ask("", after: .zero)
        }
        .onChange(of: sourceLines) { _, _ in updateWords() }
        .onChange(of: search?.people, initial: true) { _, _ in updatePeople() }
        .onChange(of: search?.sources, initial: true) { _, sources in unavailable = PeopleText.unavailable(sources ?? []) }
        .onChange(of: row) { _, _ in updateWords(); updatePeople() }
        .onChange(of: showEverybody) { _, _ in updatePeople() }
        .onDisappear { search?.cancel() }
    }

    /// What VoiceOver reads for the split: "Word 4 of 9, “the”: after “we moved”, before “the button”".
    static func boundary(_ words: [String], cut: Int) -> String {
        guard words.indices.contains(cut) else { return "No word boundary" }
        let before = words[max(0, cut - 2)..<cut].joined(separator: " ")
        let after = words[cut..<min(words.count, cut + 2)].joined(separator: " ")
        return "Word \(cut + 1) of \(words.count), “\(words[cut])”: after “\(before)”, before “\(after)”"
    }
}

struct ListenCommentEditor: View {
    let row: ReviewRow
    @Bindable var detail: MeetingDetailModel
    var close: () -> Void
    @State private var text = ""
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
        .onAppear { focused = true }
        .modifier(PauseQuestionPlayback(player: detail.window?.player, editing: true))
    }
}

/// A pending cut or repeat can start after the field gained focus. Resume only the clip this editor paused.
struct PauseQuestionPlayback: ViewModifier {
    let player: MomentPlayer?
    let editing: Bool
    @State private var pausedLayer: UUID?

    func body(content: Content) -> some View {
        content
            .onChange(of: editing && player?.phase == .playing, initial: true) { _, shouldPause in
                if shouldPause, let player, let id = player.top?.id {
                    pausedLayer = id
                    player.pause()
                }
            }
            .onChange(of: editing) { _, active in if !active { resume() } }
            .onDisappear { resume() }
    }

    private func resume() {
        if let pausedLayer, player?.top?.id == pausedLayer, player?.phase == .paused { player?.resume() }
        pausedLayer = nil
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
