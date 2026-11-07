import AppKit
import CoreImage
import Foundation

// R4 6 animated captions and texts (agent fx-overlay): the karaoke caption's words said so far and a text's way in.

/// How far a text's `animate` has come `sinceUs` after its start: the letters a typewriter has typed, and a slide-up's
/// fade and how far below its place it still is (a share of its height).
enum TextMotion {
    struct State: Equatable {
        var characters: Int
        var opacity: Double
        var drop: CGFloat
    }

    static func at(sinceUs: Int64?, note: EditProject.TextNote) -> State {
        let full = State(characters: note.text.count, opacity: 1, drop: 0)
        guard let sinceUs, let animate = note.animate else { return full }
        let progress = min(1, max(0, Double(sinceUs) / Double(max(1, animate.ms) * 1000)))
        switch animate.kind {
        case .fade:
            return full
        case .typewriter:
            return State(characters: Int((Double(note.text.count) * progress).rounded(.up)), opacity: 1, drop: 0)
        case .slideUp:
            let eased = 1 - pow(1 - progress, 3)
            return State(characters: note.text.count, opacity: eased, drop: CGFloat(1 - eased) * 0.6)
        }
    }
}

/// The karaoke caption: the characters of a line up to the end of the last word that has started by a source time.
/// A word's start is the transcription's own (`segments[].words`) when it timed as many words as the line shows,
/// else it is estimated from where the word's letters sit in the line, as cut-words estimates (transcript-cuts.ts).
enum Karaoke {
    static func spokenCharacters(line: CaptionTrack.Line, atSourceUs us: Int64) -> Int {
        var words: [(start: Int, end: Int)] = []
        var open: Int?
        for (index, character) in line.text.enumerated() {
            if character.isWhitespace {
                if let start = open { words.append((start, index)) }
                open = nil
            } else if open == nil {
                open = index
            }
        }
        if let start = open { words.append((start, line.text.count)) }
        guard !words.isEmpty else { return 0 }
        let starts: [Int64]
        if line.wordStartsUs.count == words.count {
            starts = line.wordStartsUs
        } else {
            let length = Int64(max(1, line.text.count))
            starts = words.map { line.fromUs + (line.toUs - line.fromUs) * Int64($0.start) / length }
        }
        var spoken = 0
        for (word, startUs) in zip(words, starts) where startUs <= us { spoken = word.end }
        return spoken
    }
}
