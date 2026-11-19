import SwiftUI

// MARK: - A question answered where it is seen (U2, U7)
//
// The "?" banners of the Speakers tab and the open speaker chip of the transcript both answer a question in place:
// one click on a choice decides it in the journal with an Undo, as the Items tab does (`detail.choose`).

/// A question row's menu: its answers (every choice but Skip), a divider and "Show in Items".
@MainActor func reviewChoiceItems(for row: ReviewRow, detail: MeetingDetailModel) -> [MenuButtonItem] {
    let answers = reviewAnswerItems(for: row, detail: detail)
    let show = MenuButtonItem.action("Show in Items") { detail.reveal(row: row.id) }
    return answers.isEmpty ? [show] : answers + [MenuButtonItem.divider, show]
}

/// A row's choices without Skip, each one click that decides the row (`detail.choose`).
@MainActor func reviewAnswerItems(for row: ReviewRow, detail: MeetingDetailModel) -> [MenuButtonItem] {
    row.choices.filter { $0.role != "skip" }.map { choice in
        .action(choice.label) { detail.choose(choice, on: row) }
    }
}

/// What an open speaker chip offers when no open question covers its block (U7). The 00:10 line of the owner's
/// meeting asked "Who is this?" with nothing under it, while an open suggestion (Speaker 5 is Alice Example, 85 %) covered
/// the line and the seats named six people.
enum OpenSpeakerOffer {
    /// The most confident open suggestion that covers this source label at `sec`.
    static func suggestion(label: String, at sec: Double, in items: [MeetingItem]) -> MeetingItem? {
        items.filter { item in
            item.kind == "speaker-range" && item.label == label && item.status == "suggested" && item.speaker?.isEmpty == false
                && (item.fromSec ?? .infinity) <= sec && sec <= (item.toSec ?? -.infinity)
        }
        .max { ($0.confidence ?? 0) < ($1.confidence ?? 0) }
    }

    /// "Alice Example (suggested, 85 % sure)". A voice model's suggestion reads "Alice Example (by voice 0.61)": the cosine of two
    /// voices from its evidence, never a percent (`VoiceScore`). Its confidence can be the rule's gate (0.8, "cosine is
    /// not probability" in suggest.ts), so the confidence is never shown as its score.
    static func title(_ item: MeetingItem) -> String? {
        guard let person = item.speaker, !person.isEmpty else { return nil }
        if item.rules?.contains("voice-embedding") == true {
            return voiceScore(item).map { "\(person) (by voice \(VoiceScore.text($0)))" } ?? "\(person) (by voice)"
        }
        return item.confidence.map { "\(person) (suggested, \(Int(($0 * 100).rounded())) % sure)" } ?? "\(person) (suggested)"
    }

    /// The cosine of a voice model's suggestion: `evidence.score`, else its person's candidate in `evidence.voice`.
    static func voiceScore(_ item: MeetingItem) -> Double? {
        if case .number(let score)? = item.evidence?["score"] { return score }
        guard case .object(let voice)? = item.evidence?["voice"], case .array(let candidates)? = voice["candidates"],
              let person = item.speaker else { return nil }
        for case .object(let candidate) in candidates {
            if case .string(let name)? = candidate["person"], PeopleText.personKey(name) == PeopleText.personKey(person),
               case .number(let score)? = candidate["score"] {
                return score
            }
        }
        return nil
    }

    /// The people to offer, each once: the transcript mark's own candidates, the seats in their order (room, remote,
    /// microphones), then the people who spoke, the longest first. The call's roster only when all three are empty. A
    /// transcript label ("Speaker 5") or an unclear mark is no person, and `leaving` (the suggestion, already offered)
    /// stays out.
    static func people(candidates: [String] = [], seats: MeetingSeats?, spoken: [String], roster: [String],
                       leaving: [String] = []) -> [String] {
        let room = seats?.room ?? []
        let remote = seats?.remote.map(\.name) ?? []
        let microphones = (seats?.microphones ?? []).flatMap(\.people)
        let named = (candidates + room + remote + microphones + spoken).filter(isPerson)
        var seen = Set(leaving.map(PeopleText.personKey))
        return (named.isEmpty ? roster.filter(isPerson) : named).filter { seen.insert(PeopleText.personKey($0)).inserted }
    }

    /// A name a person can have: not empty, not an unclear mark ("[unclear: …]"), not a source label of the transcript
    /// ("Speaker 5", "S5"; the rule `MeetingDetailModel.isSourceLabel` ends with).
    static func isPerson(_ name: String) -> Bool {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        return !trimmed.isEmpty && !trimmed.hasPrefix("[")
            && trimmed.range(of: #"^(Speaker|S)\s?\d+$"#, options: .regularExpression) == nil
    }

    /// The open chip's entries without a covering question: the suggestion (a click confirms it), a divider, then the
    /// mark's candidates and the meeting's people (a click gives them the block's stretch).
    @MainActor static func items(speaker: String, sourceLabel: String?, startSec: Double,
                                 candidates: [String], detail: MeetingDetailModel) -> [MenuButtonItem] {
        let record = detail.record.value
        let labels = detail.speakerLabels(forShown: speaker)
        let label = sourceLabel ?? (labels.count > 1 ? nil : (labels.first ?? speaker))
        let suggested = label.flatMap { suggestion(label: $0, at: startSec, in: record?.items ?? []) }
        let names = record?.speakers.labels ?? [:]
        let spoken = (detail.speakers.value?.speakers ?? []).sorted { $0.spokenSec > $1.spokenSec }
            .map { names[$0.label] ?? $0.label }
        let offered = people(candidates: candidates, seats: record?.seats, spoken: spoken,
                             roster: record?.participants?.map(\.name) ?? [], leaving: [suggested?.speaker].compactMap { $0 })
        var items: [MenuButtonItem] = []
        if let suggested, let words = title(suggested) {
            items.append(.action(words) { detail.decide(suggested, confirm: true) })
            if !offered.isEmpty { items.append(.divider) }
        }
        items += offered.map { person in
            .action(person) {
                detail.startAssign(detail.blockStretch(speaker: speaker, startSec: startSec), to: person, email: nil)
            }
        }
        return items
    }
}
