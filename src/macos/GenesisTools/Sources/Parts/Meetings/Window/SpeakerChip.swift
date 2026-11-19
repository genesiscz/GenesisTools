import SwiftUI

/// A speaker's name, and the time when one is given, on a transcript block. Inside a meeting (`meetingDetail` in the
/// environment) the name is a menu (R44, Amie's "Jamie ▾ · 00:03"): Rename the label for this meeting, Assign this
/// stretch to someone, Play. Both picks open the person picker (`PersonPicker`).
///
/// The three states look different (window audit H2a, ux genesiscz.md 12a): a name in the window's ink; a guess as the
/// name with a percent chip in the tentative hue and a question-mark glyph, whose menu confirms it in one click; an open
/// question as "Who is this?" in the ask hue, whose menu lists the answers on offer.
struct SpeakerChip: View {
    /// The speaker the engine sent: the label a rename or an assignment acts on. Never drawn when `who` is given.
    let speaker: String
    /// What the chip draws; nil draws `speaker` as a name.
    var who: TranscriptSpeaker? = nil
    /// When the block starts; nil shows the name alone.
    var startSec: Double? = nil
    /// Plays from `startSec`; nil shows the time as text.
    var play: ((Double) -> Void)? = nil
    @Environment(\.meetingDetail) private var detail
    @State private var picking: PickerMode?
    @State private var query = ""
    @State private var search: PeopleSearch?

    /// What the person picker does with its pick.
    enum PickerMode: String, Identifiable {
        case rename, assign
        var id: String { rawValue }
    }

    var body: some View {
        HStack(spacing: 6) {
            nameView
            if let startSec {
                if let play {
                    LiveButton(tooltip: "Play from \(MeetingsFormat.clock(startSec))", pressable: true, action: { play(startSec) }) {
                        time(startSec)
                    }
                    .accessibilityLabel("Play from \(MeetingsFormat.clock(startSec))")
                } else {
                    time(startSec)
                }
            }
        }
    }

    private var shown: TranscriptSpeaker { who ?? .name(speaker) }

    /// An empty label is a voice the source did not name; an open question reads "Who is this?".
    var name: String { shown.title }

    @ViewBuilder
    private var nameView: some View {
        if let detail, !speaker.isEmpty || shown.isOpen {
            MenuButton(items: { menuItems(detail) }) {
                HStack(spacing: 4) {
                    face
                    Image(systemName: "chevron.down").font(.system(size: 7.5, weight: .bold)).foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                .frame(minHeight: 20)
                .contentShape(Rectangle())
            }
            .instantTooltip(tooltip)
            .accessibilityLabel(accessibilityName + ", speaker menu")
            .popover(item: $picking, arrowEdge: .bottom) { mode in picker(mode, detail: detail) }
        } else {
            face
        }
    }

    /// The chip's look per state: plain name; name plus "63 %" in the care hue with a question mark; "Who is this?"
    /// in the ask hue.
    @ViewBuilder
    private var face: some View {
        switch shown {
        case .name:
            Text(verbatim: name).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
        case .guess(let guessed, let percent):
            HStack(spacing: 4) {
                Text(verbatim: guessed).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                Badge(percent.map { "\($0) %" } ?? "guess", color: KitHue.care.ink, look: .tone, symbol: "questionmark")
            }
        case .voice(let named):
            HStack(spacing: 4) {
                Text(verbatim: named).font(.system(size: 11.5, weight: .semibold)).foregroundStyle(.secondary)
                Badge("by voice", color: KitHue.play.ink, look: .tone, symbol: "waveform")
            }
        case .open:
            Badge("Who is this?", color: KitHue.ask.ink, look: .tone, symbol: "person.fill.questionmark")
        }
    }

    private var tooltip: String {
        switch shown {
        case .name: return "Rename \(name), give this stretch to someone, or play it"
        case .guess(let guessed, let percent):
            return "A guess\(percent.map { ", \($0) % sure" } ?? ""): confirm \(guessed), give the stretch to someone else, or play it"
        case .voice(let named):
            return "Named by the voice model: confirm \(named) by ear, say it is not \(named), give the stretch to someone else, or play it"
        case .open(_, let candidates):
            return candidates.isEmpty ? "Nobody is named for these lines yet: give the stretch to someone, or play it"
                                      : "Not settled between \(candidates.joined(separator: ", ")): pick who it is, or play it"
        }
    }

    private var accessibilityName: String {
        switch shown {
        case .name: return name
        case .guess(let guessed, let percent): return "\(guessed), a guess\(percent.map { ", \($0) percent" } ?? "")"
        case .voice(let named): return "\(named), named by the voice model"
        case .open: return "Who is this?"
        }
    }

    /// The label a rename acts on: an open question names its source label, a name or a guess the label it stands for.
    private func actingLabel(_ detail: MeetingDetailModel) -> String {
        if case .open(let label?, _) = shown { return label }
        return detail.speakerLabel(forShown: speaker)
    }

    /// Built at the click (`MenuButton`): the question that covers the block is looked up then, never in a body.
    private func menuItems(_ detail: MeetingDetailModel) -> [MenuButtonItem] {
        var items: [MenuButtonItem] = []
        switch shown {
        case .guess(let guessed, _):
            if let startSec {
                items.append(.action("It is \(guessed)") {
                    detail.startAssign(detail.blockStretch(speaker: speaker, startSec: startSec), to: guessed, email: nil)
                })
                items.append(.divider)
            }
        case .voice(let named):
            if let startSec {
                let stretch = detail.blockStretch(speaker: speaker, startSec: startSec)
                items.append(.note("Named by the voice model"))
                items.append(.action("Confirm \(named)") {
                    detail.voices.decide(detail.voices.items(named: named, in: stretch), confirm: true)
                })
                items.append(.action("Not \(named)") {
                    detail.voices.decide(detail.voices.items(named: named, in: stretch), confirm: false)
                })
                items.append(.divider)
            }
        case .open(_, let candidates):
            items += answers(detail, candidates: candidates)
        case .name:
            break
        }
        items.append(.action("Rename \(actingLabel(detail)) for this meeting…") { open(.rename, detail: detail) })
        if startSec != nil {
            items.append(.action("Assign this stretch…") { open(.assign, detail: detail) })
        }
        if let startSec, let play {
            items.append(.divider)
            items.append(.action("Play from \(MeetingsFormat.clock(startSec))") { play(startSec) })
        }
        return items
    }

    /// The answers of an open block: the choices of the question that covers its start, which answer it in the
    /// journal with an Undo; without one, the candidates of the transcript's mark, each given the stretch.
    private func answers(_ detail: MeetingDetailModel, candidates: [String]) -> [MenuButtonItem] {
        guard let startSec else { return [] }
        let question = Self.speakerQuestion(in: detail.record.value?.items ?? [], at: startSec, label: actingLabel(detail))
        var items: [MenuButtonItem] = [.note("Who said this?")]
        if let question, let row = detail.rows.value?.rows.first(where: { $0.id == question.id }) {
            items += row.choices.filter { $0.role != "skip" }.map { choice in
                .action(choice.label) { detail.choose(choice, on: row) }
            }
        } else {
            items += candidates.map { candidate in
                .action(candidate) {
                    detail.startAssign(detail.blockStretch(speaker: speaker, startSec: startSec), to: candidate, email: nil)
                }
            }
        }
        items.append(.divider)
        return items
    }

    /// The open speaker question a block starting at `startSec` answers. A question covers the half-open range from
    /// its start to its end, so at a boundary shared by two questions the later one answers, never the one that ended
    /// there; a zero-length question covers its one instant. When several still cover the start, the one about the
    /// block's source label (`evidence.labels`) wins.
    static func speakerQuestion(in items: [MeetingItem], at startSec: Double, label: String) -> MeetingItem? {
        let covering = items.filter { item in
            guard item.kind == "question", item.status == "suggested", item.about == "speaker",
                  let from = item.fromSec, let to = item.toSec else { return false }
            return from <= startSec && (startSec < to || (from == to && startSec == to))
        }
        return covering.first { item in
            if case .array(let labels) = item.evidence?["labels"] ?? .null { return labels.contains(.string(label)) }
            return false
        } ?? covering.first
    }

    private func open(_ mode: PickerMode, detail: MeetingDetailModel) {
        let label = actingLabel(detail)
        let next = detail.peopleSearch(atSec: startSec, renaming: mode == .rename ? label : nil)
        search?.cancel()
        search = next
        query = ""
        next.ask("", after: .zero)
        picking = mode
    }

    private func picker(_ mode: PickerMode, detail: MeetingDetailModel) -> some View {
        let label = actingLabel(detail)
        return PersonPicker(
            people: search?.people ?? [], query: $query, sources: search?.sources ?? [],
            warning: mode == .rename ? search?.warning : nil,
            title: mode == .rename ? "Rename \(label)" : "Give this stretch to",
            addRule: MeetingsPreferences.People.offerNew.value(),
            pick: { person in
                picking = nil
                switch mode {
                case .rename: detail.rename(label: label, to: person.name)
                case .assign: assign(person.name, email: person.email, detail: detail)
                }
            },
            addNew: { typed in
                picking = nil
                switch mode {
                case .rename: detail.addPersonAndRename(label: label, name: typed)
                case .assign: assign(typed, email: nil, detail: detail)
                }
            },
            cancel: { picking = nil },
            grantContacts: detail.window.map { window in { window.people.grantContacts() } })
            .onChange(of: query) { _, now in search?.ask(now) }
    }

    private func assign(_ person: String, email: String?, detail: MeetingDetailModel) {
        guard let startSec else { return }
        detail.startAssign(detail.blockStretch(speaker: speaker, startSec: startSec), to: person, email: email)
    }

    private func time(_ seconds: Double) -> some View {
        Text(verbatim: MeetingsFormat.clock(seconds)).font(.system(size: 11, design: .monospaced))
            .foregroundStyle(KitPalette.renamed)
    }
}

private struct MeetingDetailKey: EnvironmentKey {
    static let defaultValue: MeetingDetailModel? = nil
}

extension EnvironmentValues {
    /// The open meeting, for the speaker views that act on it (the chip's menu, the rename field's picker). nil outside
    /// a meeting: the views then show only the name.
    var meetingDetail: MeetingDetailModel? {
        get { self[MeetingDetailKey.self] }
        set { self[MeetingDetailKey.self] = newValue }
    }
}
