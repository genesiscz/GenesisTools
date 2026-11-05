import AppKit
import SwiftUI

/// One transcript line as `tools recorder words` prints it: the words as the `cutWords` op splits, folds and times them
/// (src/recorder/lib/edit.ts `transcriptWords`), so the window never splits a line itself.
struct TranscriptLineWords: Decodable, Equatable {
    struct Word: Decodable, Equatable {
        let word: String
        /// The form `cutWords` matches: lowercase, without the punctuation around it.
        let fold: String
        /// Source seconds.
        let start: Double
        let end: Double
        /// Timed from where its letters sit in the line, not by the transcriber.
        let estimated: Bool
    }

    /// Source seconds.
    let start: Double
    let end: Double
    let text: String
    let words: [Word]
}

/// Which filler words "Cut Fillers" takes: the sounds only (ehm, hm, um), or also the fillers that are real words
/// (jako, like). The `cutFillers` op's `level`.
enum FillerLevel: String, CaseIterable, Identifiable {
    case sounds, all
    var id: String { rawValue }

    var title: String {
        switch self {
        case .sounds: "Sounds"
        case .all: "Sounds and words"
        }
    }

    /// The noun of a notice: "filler sounds", "filler sounds and words".
    var noun: String {
        switch self {
        case .sounds: "filler sounds"
        case .all: "filler sounds and words"
        }
    }
}

/// Cut by the transcript: words picked in a caption line, or every filler at once. Both run the TypeScript op through
/// `tools recorder apply` (`cutWords`, `cutFillers`), the same as `tools recorder cut-words|cut-fillers` and the REPL.
extension EditorModel {
    /// Opinionated, so a setting: what Cut Fillers takes. The sounds by default, because "jako" and "like" are also
    /// real words; the Captions tab sets it.
    nonisolated static let fillerLevelKey = "recorder.captions.fillerLevel"
    nonisolated static var fillerLevel: FillerLevel {
        UserDefaults.standard.string(forKey: fillerLevelKey).flatMap(FillerLevel.init(rawValue:)) ?? .sounds
    }

    /// Reads every line's words once (and again after a transcription), off the main thread.
    func readLineWords() {
        guard hasTranscript, !isReadingLineWords else { return }
        isReadingLineWords = true
        let target = FileManager.default.fileExists(atPath: store.url.path) ? store.url.path : project.source.video
        ask("lineWords", recording: target, argv: ["recorder", "words", target]) { [weak self] result in
            guard let self else { return }
            self.isReadingLineWords = false
            let decoded = result.flatMap { data in
                Result { try JSONDecoder().decode([TranscriptLineWords].self, from: data) }.mapError { ApplyFailure(reason: $0.localizedDescription) }
            }
            switch decoded {
            case let .success(lines): self.lineWords = lines
            case let .failure(failure): self.show("The transcript's words did not load: \(failure.reason)", error: true)
            }
        }
    }

    /// The words of a caption line, found by its start (the caption track keeps whole microseconds).
    func words(of line: CaptionTrack.Line) -> TranscriptLineWords? {
        lineWords?.first { abs(Int64(($0.start * 1_000_000).rounded()) - line.fromUs) <= 1_000 }
    }

    /// Which place in the line the picked words are, as `cutWords` numbers them: it cuts every run of the same folded
    /// words, so the place is one more than the earlier runs. The folds come from `tools recorder words`.
    nonisolated static func occurrence(of picked: ClosedRange<Int>, in words: [TranscriptLineWords.Word]) -> Int {
        let wanted = words[picked].map(\.fold)
        let earlier = (0..<picked.lowerBound).filter { start in
            start + wanted.count <= words.count && words[start..<(start + wanted.count)].map(\.fold) == wanted
        }
        return earlier.count + 1
    }

    /// The `cutWords` op for the picked words of a line: only that place, so a word the line says twice stays once.
    nonisolated static func cutWordsOp(_ line: TranscriptLineWords, picked: ClosedRange<Int>) -> String {
        let op: [String: Any] = [
            "op": "cutWords", "at": line.start,
            "words": line.words[picked].map(\.word).joined(separator: " "),
            "occurrence": occurrence(of: picked, in: line.words),
        ]
        return (try? JSONSerialization.data(withJSONObject: op, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
    }

    func cutWords(_ line: TranscriptLineWords, picked: ClosedRange<Int>) {
        guard !isCuttingTranscript, picked.upperBound < line.words.count else { return }
        let text = line.words[picked].map(\.word).joined(separator: " ")
        isCuttingTranscript = true
        applyOps(Self.cutWordsOp(line, picked: picked)) { [weak self] result in
            guard let self else { return }
            self.isCuttingTranscript = false
            switch result {
            case let .success(saved):
                self.show("Cut “\(text)” (\(String(format: "%.1f s", Double(saved) / 1_000_000))). ⌘Z brings it back.", error: false)
            case let .failure(failure):
                self.show("“\(text)” was not cut: \(failure.reason)", error: true)
            }
        }
    }

    /// Cuts every filler of the transcript in one undo step, at the level the Captions tab sets.
    func cutFillers() {
        guard !isCuttingTranscript else { return }
        let level = Self.fillerLevel
        isCuttingTranscript = true
        applyOps(#"{"op":"cutFillers","level":"\#(level.rawValue)"}"#) { [weak self] result in
            guard let self else { return }
            self.isCuttingTranscript = false
            switch result {
            case let .success(saved) where saved > 0:
                self.show("Cut \(String(format: "%.1f s", Double(saved) / 1_000_000)) of \(level.noun). ⌘Z brings them back.", error: false)
            case .success:
                self.show("No \(level.noun) were found in the kept movie.", error: false)
            case let .failure(failure):
                self.show("No fillers were cut: \(failure.reason)", error: true)
            }
        }
    }
}

/// The fillers row of the Captions tab: which fillers, and the button that cuts them all.
struct FillerCutRow: View {
    @Bindable var model: EditorModel
    @AppStorage(EditorModel.fillerLevelKey) private var level: FillerLevel = .sounds

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionLabel(text: "Cut filler words")
            GenSegmentedTabs("Fillers", items: FillerLevel.allCases.map { .init($0, $0.title) }, selection: $level,
                             minSegmentWidth: 60, identifier: "recorder.captions.fillerLevel", fillsWidth: true)
                .instantTooltip("Sounds: ehm, hm, um, uh. Sounds and words: also jako, jakože and like, which are real words too")
            GhostButton(model.isCuttingTranscript ? "Cutting…" : "Cut Fillers", symbol: "scissors",
                        tooltip: "Cut every \(level == .sounds ? "filler sound" : "filler sound and word") of the transcript in one step; ⌘Z brings them back",
                        fullWidth: true, identifier: "recorder.captions.cutFillers") { model.cutFillers() }
                .disabled(model.isCuttingTranscript)
        }
        .padding(.bottom, 4)
    }
}

/// The scissors of a caption line: a popover with the line's words to pick and cut.
struct CaptionLineCutButton: View {
    let model: EditorModel
    let line: CaptionTrack.Line
    @State private var open = false

    var body: some View {
        IconButton(systemName: "scissors", tooltip: "Cut words of this line", size: 10) {
            if model.lineWords == nil { model.readLineWords() }
            open = true
        }
        .popover(isPresented: $open, arrowEdge: .leading) {
            TranscriptWordPicker(model: model, line: line) { open = false }
        }
    }
}

/// A line's words as chips: a click picks a word, a Shift-click picks every word up to it; Cut sends `cutWords` for
/// that place of the words only.
struct TranscriptWordPicker: View {
    let model: EditorModel
    let line: CaptionTrack.Line
    let close: () -> Void
    @State private var anchor: Int?
    @State private var picked: ClosedRange<Int>?

    init(model: EditorModel, line: CaptionTrack.Line, picked: ClosedRange<Int>? = nil, close: @escaping () -> Void) {
        self.model = model
        self.line = line
        self.close = close
        _picked = State(initialValue: picked)
        _anchor = State(initialValue: picked?.lowerBound)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Cut words of this line").font(.system(size: 13, weight: .semibold))
                Text(verbatim: TimelineMap.outputTime(ofSource: line.fromUs, in: model.project).map { "At \(formatClock($0, tenths: true)). Click a word; Shift-click picks every word up to it." }
                     ?? "This line is in a part that was cut.")
                    .font(.system(size: 11)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if let words = model.words(of: line) {
                WrapLayout(spacing: 4, lineSpacing: 4) {
                    ForEach(Array(words.words.enumerated()), id: \.offset) { index, word in
                        chip(word.word, index: index)
                    }
                }
                if let picked, words.words[picked].contains(where: \.estimated) {
                    Text("These times are estimated from the letters of the line; play the cut to check it.")
                        .font(.system(size: 10.5)).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                HStack {
                    Spacer()
                    Button("Cancel") { close() }
                        .keyboardShortcut(.cancelAction)
                    Button(role: .destructive) {
                        if let picked { model.cutWords(words, picked: picked) }
                        close()
                    } label: {
                        Text(verbatim: picked.map { "Cut “\(words.words[$0].map(\.word).joined(separator: " "))”" } ?? "Cut")
                            .lineLimit(1)
                    }
                    .disabled(picked == nil || model.isCuttingTranscript)
                    .accessibilityIdentifier("recorder.captions.cutWords")
                }
            } else if model.isReadingLineWords || model.lineWords == nil {
                HStack(spacing: 6) {
                    ProgressView().controlSize(.small)
                    Text("Reading the line's words…").font(.system(size: 11.5)).foregroundStyle(.secondary)
                }
            } else {
                Text("The transcript has no words for this line; transcribe the movie again.")
                    .font(.system(size: 11.5)).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(width: 320, alignment: .leading)
    }

    private func chip(_ word: String, index: Int) -> some View {
        let on = picked?.contains(index) == true
        return Button {
            pick(index, extending: NSEvent.modifierFlags.contains(.shift))
        } label: {
            Text(verbatim: word)
                .font(.system(size: 12))
                .padding(.horizontal, 6).padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.red.opacity(0.32) : Color.white.opacity(0.07)))
                .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(on ? Color.red.opacity(0.7) : Color.clear))
                .strikethrough(on)
                .contentShape(RoundedRectangle(cornerRadius: 5))
        }
        .buttonStyle(.genHoverPlain())
        .accessibilityLabel(word)
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityHint("Picks this word to cut; with Shift, every word up to it")
    }

    private func pick(_ index: Int, extending: Bool) {
        if extending, let anchor {
            picked = min(anchor, index)...max(anchor, index)
        } else if picked == index...index {
            picked = nil
            anchor = nil
        } else {
            picked = index...index
            anchor = index
        }
    }
}
