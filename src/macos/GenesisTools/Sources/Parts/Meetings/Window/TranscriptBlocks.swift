import AppKit
import SwiftUI

// MARK: - Riverside transcript blocks (R39, R42, G57, G58, G-TR-1, G-TR-2)
//
// Presentational only: the views take plain values and closures. b-swift-timeline feeds them from
// `MeetingDetailModel.transcript` and the Moment player (see WaveBUI-transcript.md, "Wiring").

/// A mark on one transcript line: what the reader should notice on that line alone (G57).
enum TranscriptLineMark: String, Hashable, CaseIterable {
    /// The engine is not sure who said this line (a speaker hint range covers it).
    case unclearSpeaker
    case byVoice
    case swapSkipped, noRemotePresent, callEcho
    /// A confirmed item or a dictionary entry changed words of this line.
    case corrected
    /// A staged comment for the listening agent covers this line.
    case commented
    /// The filter field matched this line.
    case filterHit
}

/// One transcript line inside a block: its own seek target (R42), selection unit (R43) and marks (G57).
struct TranscriptBlockLine: Equatable, Hashable, Identifiable {
    let id: String
    /// The line's index in the transcript's entries (`LinePoint.line`).
    let index: Int
    let startSec: Double?
    /// When the line stops being heard: the next timed line's start (G-TR-1), or the recording's end for the last one.
    let endSec: Double?
    let text: String
    var marks: Set<TranscriptLineMark> = []
    var words: [TranscriptWord] = []
    var indicator: TranscriptLine.Indicator? = nil
    var evidenceMarks: [TranscriptEvidenceMark] = []
    /// The voice model's score for the line's suggested name (`nameScore`), drawn with its mark.
    var voiceScore: Double? = nil

    /// True while `position` is inside the line. A line without an end is heard from its start on.
    func isHeard(at position: Double) -> Bool {
        guard let startSec, position >= startSec else { return false }
        guard let endSec else { return true }
        return position < endSec
    }
}

/// Consecutive lines of one speaker, drawn as one Riverside block: the speaker chip, the block's time, the lines.
struct TranscriptBlock: Equatable, Identifiable {
    let id: String
    /// The speaker the engine sent for the block's first line: the label a rename or an assignment acts on. It may be an
    /// export mark (`[unclear: …]`), so it is never drawn; `who` is.
    let speaker: String
    /// Who said the block, as the chip draws it: a name, a guess or an open question (window audit H2a).
    let who: TranscriptSpeaker
    var lines: [TranscriptBlockLine]

    init(id: String, speaker: String, who: TranscriptSpeaker? = nil, lines: [TranscriptBlockLine]) {
        self.id = id
        self.speaker = speaker
        self.who = who ?? .name(speaker)
        self.lines = lines
    }

    var startSec: Double? { lines.first(where: { $0.startSec != nil })?.startSec }
    var endSec: Double? { lines.last?.endSec }
    /// The block's name is a guess with its percent (I11): its chip takes the guess style.
    var isGuess: Bool { who.isGuess }

    /// Groups the transcript's lines into blocks. A new block starts when the speaker changes, and also after a
    /// silence longer than `breakAfterGapSec` (nil: never; the plan's pick, one block per turn as Riverside draws it).
    /// `durationSec` ends the last line; `marks` adds marks by line id.
    static func build(from entries: [TranscriptLine], durationSec: Double? = nil,
                      marks: [String: Set<TranscriptLineMark>] = [:], evidence: [WindowLineEvidence] = [],
                      items: [MeetingItem] = [], echoAbove: Int = MeetingsPreferences.Transcript.defaultEchoAbove,
                      breakAfterGapSec: Double? = nil) -> [TranscriptBlock] {
        // The end of a line is the one `meeting.transcript` sends (G-TR-1), else the next timed line's start.
        var ends = [Double?](repeating: durationSec, count: entries.count)
        var nextStart = durationSec
        for index in entries.indices.reversed() {
            ends[index] = entries[index].endSec ?? nextStart
            if let start = entries[index].startSec { nextStart = start }
        }
        var blocks: [TranscriptBlock] = []
        let byIndex = Dictionary(evidence.map { ($0.index, $0) }, uniquingKeysWith: { _, last in last })
        // The voice model's score of a marked line whose shown name is not its own (an open question covers it): the
        // suggested range's cosine at the line's start. One pass over the items, not one per line.
        var voiceScores: [Double: Double] = [:]
        for item in items where item.kind == "speaker-range" && item.status == "suggested" && item.rules?.contains("voice-embedding") == true {
            guard let from = item.fromSec, case .number(let score)? = item.evidence?["score"] else { continue }
            voiceScores[from] = score
        }
        for (index, entry) in entries.enumerated() {
            let cues = byIndex[entry.sourceIndex ?? index].map { TranscriptEvidenceMark.build($0, items: items, echoAbove: echoAbove) } ?? []
            let voiced = entry.who.isVoice
            var lineMarks = (marks[entry.rowID] ?? []).union(cues.map(\.kind))
            if voiced { lineMarks.insert(.byVoice) }
            let line = TranscriptBlockLine(id: entry.rowID, index: index, startSec: entry.startSec, endSec: ends[index],
                                           text: entry.text, marks: lineMarks, words: entry.words ?? [],
                                           indicator: entry.indicator, evidenceMarks: cues,
                                           voiceScore: voiced ? entry.nameScore
                                               : lineMarks.contains(.byVoice) ? entry.startSec.flatMap { voiceScores[$0] } : nil)
            let who = entry.who
            if var last = blocks.last, last.who == who, !breaks(after: last.lines.last, before: line, gap: breakAfterGapSec) {
                last.lines.append(line)
                blocks[blocks.count - 1] = last
            } else {
                blocks.append(TranscriptBlock(id: "b-\(entry.rowID)", speaker: entry.speaker, who: who, lines: [line]))
            }
        }
        return blocks
    }

    private static func breaks(after previous: TranscriptBlockLine?, before line: TranscriptBlockLine, gap: Double?) -> Bool {
        guard let gap, let previousStart = previous?.startSec, let start = line.startSec else { return false }
        let previousEnd = previous?.endSec ?? previousStart
        return start - min(previousEnd, start) > gap || start - previousStart > gap * 4
    }

    /// The filter (G57): a block stays when one of its lines holds the query (or the speaker does); its matching lines
    /// get `.filterHit`, and the whole block shows so a hit keeps its context.
    static func filter(_ blocks: [TranscriptBlock], query: String) -> [TranscriptBlock] {
        let query = query.trimmingCharacters(in: .whitespaces)
        guard !query.isEmpty else { return blocks }
        return blocks.compactMap { block in
            let speakerHit = block.who.title.localizedStandardContains(query)
            var hit = speakerHit
            var copy = block
            for index in copy.lines.indices where copy.lines[index].text.localizedStandardContains(query) {
                copy.lines[index].marks.insert(.filterHit)
                hit = true
            }
            return hit ? copy : nil
        }
    }

    /// The heard block and line at `position`: the last timed block that starts at or before it, then its heard line.
    /// Nil in a silence between blocks. A linear scan: a few hundred comparisons per 10 Hz tick.
    static func heard(in blocks: [TranscriptBlock], at position: Double?, wordHighlights: Bool = true) -> TranscriptHeard? {
        guard let position,
              let index = blocks.lastIndex(where: { ($0.startSec ?? .infinity) <= position }) else { return nil }
        let block = blocks[index]
        guard let line = block.lines.last(where: { $0.isHeard(at: position) }) else { return nil }
        let wordRange = wordHighlights ? line.words.compactMap { $0.heardRange(at: position, in: line.text) }.first : nil
        return TranscriptHeard(blockID: block.id, lineID: line.id, wordRange: wordRange)
    }

    /// The shown names of the blocks, sorted: the person colours pick among them. Computed with the blocks (the pane's
    /// projection), never in a list's body.
    static func names(_ blocks: [TranscriptBlock]) -> [String] {
        Set(blocks.map(\.who.personName).filter { !$0.isEmpty }).sorted()
    }

    /// The end of the last block the playback has passed: the latest block end at or before `position`. A block is
    /// past at this value exactly when it is past at `position`, but the value changes only when the playback crosses
    /// a block's end, so a view that takes it in place of the 10 Hz position renders again every few seconds.
    static func passedEnd(in blocks: [TranscriptBlock], at position: Double?) -> Double? {
        guard let position else { return nil }
        return blocks.reduce(nil) { latest, block in
            guard let end = block.endSec, end <= position else { return latest }
            return max(latest ?? end, end)
        }
    }
}

/// Which block and line the player is in now. Only this block's view gets a non-nil `heardLineID`.
struct TranscriptHeard: Equatable, Hashable {
    let blockID: String
    let lineID: String
    var wordRange: NSRange? = nil
}

/// New line cues keep their own glyph, hue and words in both the tooltip and the accessibility label.
struct TranscriptEvidenceMark: Equatable, Hashable {
    let kind: TranscriptLineMark
    let text: String
    var symbol: String { kind == .swapSkipped ? "arrow.triangle.swap" : kind == .noRemotePresent ? "person.crop.circle.badge.exclamationmark" : "speaker.wave.2" }
    var color: Color { kind == .swapSkipped ? .cyan : kind == .noRemotePresent ? .yellow : .pink }

    static func build(_ evidence: WindowLineEvidence, items: [MeetingItem], echoAbove: Int) -> [Self] {
        var marks: [Self] = []
        let swaps = (evidence.swapSkippedBy ?? []).compactMap { id -> String? in
            guard let swap = items.first(where: { $0.id == id && $0.status != "rejected" }) else { return nil }
            let span = "\(MeetingsFormat.clock(swap.fromSec ?? evidence.startSec)) to \(MeetingsFormat.clock(swap.toSec ?? evidence.endSec))"
            return "swap to \(swap.speaker ?? "another speaker") at \(span)"
        }
        if !swaps.isEmpty { marks.append(.init(kind: .swapSkipped, text: "Skipped by " + Set(swaps).sorted().joined(separator: "; "))) }
        if evidence.noRemotePresent == true { marks.append(.init(kind: .noRemotePresent, text: "No remote person was in the call at this time")) }
        if echoAbove > 0, let echo = evidence.echoOfCall, echo * 100 >= Double(echoAbove) {
            marks.append(.init(kind: .callEcho, text: "High echo of call: \(Int((echo * 100).rounded())) % of microphone power"))
        }
        return marks
    }
}

/// What a click on a line asks for. A plain click plays from the line (R42); ⇧ extends the selection to it and ⌘ adds
/// or removes it (R43), as in a Finder list.
enum TranscriptLineClick: Equatable {
    case play
    case extendSelection
    case toggleSelection

    init(modifiers: NSEvent.ModifierFlags) {
        if modifiers.contains(.shift) {
            self = .extendSelection
        } else if modifiers.contains(.command) {
            self = .toggleSelection
        } else {
            self = .play
        }
    }
}

// MARK: - Views

/// The blocks in a lazy stack. Each block view is `Equatable` and gets only its own heard line and selection, so a
/// 10 Hz position change redraws the heard block alone (G-TR-2): the parent computes `heard` with
/// `TranscriptBlock.heard(in:at:)` and passes the same value until the heard line changes.
struct TranscriptBlocksList: View {
    let blocks: [TranscriptBlock]
    var heard: TranscriptHeard?
    /// Selected line ids (R43).
    var selection: Set<String> = []
    /// Dims the blocks the playback has passed (the sketch's `.past`). The plan's pick: on.
    var dimsPast = true
    /// Draws the round initials badge before each block (Riverside). Neutral grey: colour means state (G-SPK-6).
    var showsAvatar = true
    /// A block whose end is at or before this is past; nil dims nothing. Pass `TranscriptBlock.passedEnd(in:at:)`,
    /// never the raw position: a value that changes per tick re-runs this list and lays out its whole column.
    var pastBefore: Double? = nil
    /// The line the selection popover points at (R43), and the popover: it opens beside that line's block.
    var popoverLine: String? = nil
    var popover: () -> AnyView = { AnyView(EmptyView()) }
    var closePopover: () -> Void = {}
    /// A plain click on a line: play from this second (R42).
    let play: (Double) -> Void
    /// A ⇧ or ⌘ click on a line (R43).
    var select: (TranscriptBlockLine, TranscriptLineClick) -> Void = { _, _ in }
    var selectWords: (TranscriptBlockLine, NSRange) -> Void = { _, _ in }
    /// The shown names, sorted (`TranscriptBlock.names`), for the person colours: computed with the blocks, not here.
    var speakerNames: [String] = []

    var body: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(blocks) { block in
                TranscriptBlockView(
                    block: block,
                    heardLineID: heard?.blockID == block.id ? heard?.lineID : nil,
                    heardWordRange: heard?.blockID == block.id ? heard?.wordRange : nil,
                    selected: selection.isEmpty ? [] : Set(block.lines.map(\.id)).intersection(selection),
                    past: dimsPast && isPast(block),
                    showsAvatar: showsAvatar,
                    play: play,
                    select: select, selectWords: selectWords
                )
                .equatable()
                .environment(\.meetingSpeakerNames, speakerNames)
                .popover(isPresented: Binding(get: { holdsPopover(block) }, set: { if !$0 { closePopover() } }),
                         arrowEdge: .leading) { popover() }
                .id(block.id)
            }
        }
    }

    private func holdsPopover(_ block: TranscriptBlock) -> Bool {
        guard let popoverLine else { return false }
        return block.lines.contains { $0.id == popoverLine }
    }

    private func isPast(_ block: TranscriptBlock) -> Bool {
        guard let pastBefore, let end = block.endSec else { return false }
        return end <= pastBefore && heard?.blockID != block.id
    }
}

/// One Riverside block: avatar, speaker chip with the block's time, then each line as its own target and element.
struct TranscriptBlockView: View, Equatable {
    let block: TranscriptBlock
    /// The heard line when this is the heard block; nil for every other block.
    let heardLineID: String?
    var heardWordRange: NSRange? = nil
    let selected: Set<String>
    let past: Bool
    var showsAvatar = true
    let play: (Double) -> Void
    var select: (TranscriptBlockLine, TranscriptLineClick) -> Void = { _, _ in }
    var selectWords: (TranscriptBlockLine, NSRange) -> Void = { _, _ in }

    nonisolated static func == (a: TranscriptBlockView, b: TranscriptBlockView) -> Bool {
        a.block == b.block && a.heardLineID == b.heardLineID && a.heardWordRange == b.heardWordRange
            && a.selected == b.selected && a.past == b.past
            && a.showsAvatar == b.showsAvatar
    }

    private var isHeard: Bool { heardLineID != nil }
    private var isSelected: Bool { !selected.isEmpty }

    /// The widest a block's lines run: about 100 characters of the 13 pt text.
    static let measure: CGFloat = 680

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if showsAvatar {
                TranscriptAvatar(speaker: block.who.personName)
            }
            VStack(alignment: .leading, spacing: 2) {
                SpeakerChip(speaker: block.speaker, who: block.who, startSec: block.startSec, play: play)
                ForEach(block.lines) { line in
                    TranscriptBlockLineView(
                        line: line, speaker: block.who.title, heard: line.id == heardLineID,
                        wordRange: line.id == heardLineID ? heardWordRange : nil,
                        selected: selected.contains(line.id), past: past, play: play, select: select, selectWords: selectWords
                    )
                    // A scroll target of its own: a speaker's block can be taller than the pane, and the follow keeps
                    // the heard line, not only its block, in view.
                    .id(line.id)
                }
            }
            // A reader loses the way back to the start of a line of 180 characters, which a wide window drew.
            .frame(maxWidth: Self.measure, alignment: .leading)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 7)
        .padding(.leading, 11)
        .padding(.trailing, 14)
        .background(background)
        .overlay(alignment: .leading) {
            Rectangle().fill(edge).frame(width: 3)
        }
        .contentShape(Rectangle())
        .liveRow(selected: isHeard)
    }

    private var background: Color {
        if isHeard { return Color.accentColor.opacity(0.14) }
        if isSelected { return Color.purple.opacity(0.12) }
        return .clear
    }

    private var edge: Color {
        if isHeard { return .accentColor }
        if isSelected { return .purple }
        return .clear
    }
}

/// The round initials badge of a block. In a look it has the person's own colour, from a palette without the play
/// blue, so a colour is never read as "this plays" (G-SPK-6 kept the badge neutral for that reason; the classic look
/// still does). A voice without a name stays neutral.
struct TranscriptAvatar: View {
    let speaker: String
    var size: CGFloat = 26
    @Environment(\.kitLook) private var look
    @Environment(\.meetingSpeakerNames) private var names

    var body: some View {
        let coloured = look != .classic && !speaker.isEmpty
        Text(verbatim: Self.initials(speaker))
            .font(.system(size: size * 0.42, weight: coloured ? .bold : .semibold))
            .foregroundStyle(coloured ? AnyShapeStyle(Color.white) : AnyShapeStyle(.secondary))
            .frame(width: size, height: size)
            .background {
                if coloured {
                    Circle().fill(KitPersonColor.color(for: speaker, among: names).gradient)
                } else {
                    Circle().fill(Color.secondary.opacity(0.18))
                }
            }
            .accessibilityHidden(true)
    }

    /// "Mira Holt" is "MH", "Speaker 4" is "S4", an empty name (an open question) is "?". Only letters and digits count.
    static func initials(_ speaker: String) -> String {
        let words = speaker.split(whereSeparator: { $0.isWhitespace || $0 == "-" })
            .map { String($0.filter { $0.isLetter || $0.isNumber }) }
            .filter { !$0.isEmpty }
        guard let first = words.first else { return "?" }
        if words.count == 1 { return String(first.prefix(2)).uppercased() }
        let second = words[1]
        if second.allSatisfy(\.isNumber) { return (String(first.prefix(1)) + second.prefix(2)).uppercased() }
        return (String(first.prefix(1)) + String(second.prefix(1))).uppercased()
    }
}

/// One line inside a block: a click plays from it (⇧ or ⌘ selects), its marks show at its end, and it is its own
/// accessibility element with "Play from …" (G58).
private struct TranscriptBlockLineView: View {
    let line: TranscriptBlockLine
    let speaker: String
    let heard: Bool
    let wordRange: NSRange?
    let selected: Bool
    let past: Bool
    let play: (Double) -> Void
    let select: (TranscriptBlockLine, TranscriptLineClick) -> Void
    let selectWords: (TranscriptBlockLine, NSRange) -> Void
    @Environment(\.rowLive) private var live
    @State private var hovering = false
    @AppStorage(MeetingsPreferences.Playback.animateActivity.key) private var animateActivity =
        MeetingsPreferences.Playback.animateActivity.defaultValue
    @GenReduceMotion private var reduceMotion

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            TranscriptWordText(text: line.text,
                               color: heard || selected ? .labelColor : (past ? .tertiaryLabelColor : .secondaryLabelColor),
                               corrected: line.marks.contains(.corrected), heardRange: wordRange, click: click,
                               selected: { selectWords(line, $0) })
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background {
                    RoundedRectangle(cornerRadius: 4).fill(fill)
                        .animation(animateActivity && !reduceMotion ? .easeOut(duration: 0.16) : nil, value: heard)
                }
            // Only an indicator that says something the block does not (window audit M12): stuck and ignored, or naming
            // someone other than the block's speaker. Drawn on every line, it was a glyph down the whole pane.
            if let indicator = line.indicator, indicator.addsTo(speaker: speaker) {
                Image(systemName: indicator.ignored == nil ? "person.wave.2" : "exclamationmark.triangle")
                    .font(.system(size: 11)).foregroundStyle(indicator.ignored == nil ? Color.secondary : .orange)
                    .instantTooltip(indicator.shownText)
                    .accessibilityLabel(indicator.shownText)
            }
            ForEach(line.evidenceMarks, id: \.self) { mark in
                Image(systemName: mark.symbol).font(.system(size: 11)).foregroundStyle(mark.color)
                    .instantTooltip(mark.text).accessibilityLabel(mark.text)
            }
            if line.marks.contains(.unclearSpeaker) {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 11)).foregroundStyle(.orange)
                    .instantTooltip("The engine is not sure who said this line")
            }
            if line.marks.contains(.byVoice) {
                VoiceModelMark(score: line.voiceScore)
            }
            if line.marks.contains(.commented) {
                Image(systemName: "text.bubble")
                    .font(.system(size: 11)).foregroundStyle(.purple)
                    .instantTooltip("A staged comment covers this line")
            }
            Spacer(minLength: 0)
            if hovering, let start = line.startSec {
                Text(verbatim: "Play from \(MeetingsFormat.clock(start))")
                    .font(.system(size: 11)).foregroundStyle(Color.accentColor)
                    .transition(.opacity)
            }
        }
        .contentShape(Rectangle())
        .onHover { inside in
            if live || !inside { hovering = inside && line.startSec != nil }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityText)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
        .accessibilityAction { if let start = line.startSec { play(start) } }
        .accessibilityAction(named: playActionName) { if let start = line.startSec { play(start) } }
        .accessibilityAction(named: selected ? "Remove from the selection" : "Add to the selection") {
            select(line, .toggleSelection)
        }
    }

    private func click() {
        let kind = TranscriptLineClick(modifiers: NSEvent.modifierFlags)
        if kind == .play {
            if let start = line.startSec { play(start) }
        } else {
            select(line, kind)
        }
    }

    private var playActionName: String {
        line.startSec.map { "Play from \(MeetingsFormat.clock($0))" } ?? "Play"
    }

    private var accessibilityText: String {
        var parts = [speaker]
        if let start = line.startSec { parts.append(MeetingsFormat.clock(start)) }
        parts.append(line.text)
        if heard { parts.append("playing now") }
        if line.marks.contains(.unclearSpeaker) { parts.append("speaker unsure") }
        if line.marks.contains(.corrected) { parts.append("corrected") }
        if line.marks.contains(.byVoice) { parts.append(VoiceModelMark.words(line.voiceScore)) }
        if line.marks.contains(.commented) { parts.append("has a staged comment") }
        return parts.joined(separator: ", ")
    }

    private var textStyle: HierarchicalShapeStyle {
        if heard || selected { return .primary }
        return past ? .tertiary : .secondary
    }

    private var fill: Color {
        if heard { return Color.accentColor.opacity(0.28) }
        if selected { return Color.purple.opacity(0.2) }
        if line.marks.contains(.filterHit) { return Color.yellow.opacity(0.22) }
        if hovering { return Color.primary.opacity(0.06) }
        return .clear
    }
}

extension TranscriptLine.Indicator {
    /// True when the indicator says something the block's speaker does not: it is stuck and ignored, or it names
    /// someone else (window audit M12).
    func addsTo(speaker: String) -> Bool {
        ignored != nil || (!names.isEmpty && !names.contains(speaker))
    }

    /// The indicator's names, and when the engine ignores it, why in words (C2): the engine sends a code.
    var shownText: String {
        let names = names.isEmpty ? "No named indicator" : names.joined(separator: ", ")
        return ignored.map { "\(names) · \(Self.ignoredWords($0))" } ?? names
    }

    /// Why the engine ignores the indicator, for its code.
    static func ignoredWords(_ code: String) -> String {
        switch code {
        case "meeting-dominance": "stuck: one name lit it through most of the meeting, so it is ignored"
        case "stretch-stuck": "stuck: it stayed on one name through this stretch of the call, so it is ignored"
        default: "stuck, so it is ignored"
        }
    }
}
