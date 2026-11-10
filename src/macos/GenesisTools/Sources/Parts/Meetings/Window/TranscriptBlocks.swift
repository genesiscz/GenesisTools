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
    let speaker: String
    var lines: [TranscriptBlockLine]

    var startSec: Double? { lines.first(where: { $0.startSec != nil })?.startSec }
    var endSec: Double? { lines.last?.endSec }

    /// Groups the transcript's lines into blocks. A new block starts when the speaker changes, and also after a
    /// silence longer than `breakAfterGapSec` (nil: never; the plan's pick, one block per turn as Riverside draws it).
    /// `durationSec` ends the last line; `marks` adds marks by line id.
    static func build(from entries: [TranscriptLine], durationSec: Double? = nil,
                      marks: [String: Set<TranscriptLineMark>] = [:], breakAfterGapSec: Double? = nil) -> [TranscriptBlock] {
        // The end of a line is the one `meeting.transcript` sends (G-TR-1), else the next timed line's start.
        var ends = [Double?](repeating: durationSec, count: entries.count)
        var nextStart = durationSec
        for index in entries.indices.reversed() {
            ends[index] = entries[index].endSec ?? nextStart
            if let start = entries[index].startSec { nextStart = start }
        }
        var blocks: [TranscriptBlock] = []
        for (index, entry) in entries.enumerated() {
            let line = TranscriptBlockLine(id: entry.rowID, index: index, startSec: entry.startSec, endSec: ends[index],
                                           text: entry.text, marks: marks[entry.rowID] ?? [])
            if var last = blocks.last, last.speaker == entry.speaker, !breaks(after: last.lines.last, before: line, gap: breakAfterGapSec) {
                last.lines.append(line)
                blocks[blocks.count - 1] = last
            } else {
                blocks.append(TranscriptBlock(id: "b-\(entry.rowID)", speaker: entry.speaker, lines: [line]))
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
            let speakerHit = block.speaker.localizedStandardContains(query)
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
    static func heard(in blocks: [TranscriptBlock], at position: Double?) -> TranscriptHeard? {
        guard let position,
              let index = blocks.lastIndex(where: { ($0.startSec ?? .infinity) <= position }) else { return nil }
        let block = blocks[index]
        guard let line = block.lines.last(where: { $0.isHeard(at: position) }) else { return nil }
        return TranscriptHeard(blockID: block.id, lineID: line.id)
    }
}

/// Which block and line the player is in now. Only this block's view gets a non-nil `heardLineID`.
struct TranscriptHeard: Equatable, Hashable {
    let blockID: String
    let lineID: String
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
    /// The player's position, read only to say which blocks are past; nil dims nothing.
    var pastBefore: Double? = nil
    /// The line the selection popover points at (R43), and the popover: it opens beside that line's block.
    var popoverLine: String? = nil
    var popover: () -> AnyView = { AnyView(EmptyView()) }
    var closePopover: () -> Void = {}
    /// A plain click on a line: play from this second (R42).
    let play: (Double) -> Void
    /// A ⇧ or ⌘ click on a line (R43).
    var select: (TranscriptBlockLine, TranscriptLineClick) -> Void = { _, _ in }

    var body: some View {
        let speakerNames = Set(blocks.map(\.speaker)).sorted()
        LazyVStack(alignment: .leading, spacing: 0) {
            ForEach(blocks) { block in
                TranscriptBlockView(
                    block: block,
                    heardLineID: heard?.blockID == block.id ? heard?.lineID : nil,
                    selected: selection.isEmpty ? [] : Set(block.lines.map(\.id)).intersection(selection),
                    past: dimsPast && isPast(block),
                    showsAvatar: showsAvatar,
                    play: play,
                    select: select
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
    let selected: Set<String>
    let past: Bool
    var showsAvatar = true
    let play: (Double) -> Void
    var select: (TranscriptBlockLine, TranscriptLineClick) -> Void = { _, _ in }

    nonisolated static func == (a: TranscriptBlockView, b: TranscriptBlockView) -> Bool {
        a.block == b.block && a.heardLineID == b.heardLineID && a.selected == b.selected && a.past == b.past
            && a.showsAvatar == b.showsAvatar
    }

    private var isHeard: Bool { heardLineID != nil }
    private var isSelected: Bool { !selected.isEmpty }

    /// The widest a block's lines run: about 100 characters of the 13 pt text.
    static let measure: CGFloat = 680

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            if showsAvatar {
                TranscriptAvatar(speaker: block.speaker)
            }
            VStack(alignment: .leading, spacing: 2) {
                SpeakerChip(speaker: block.speaker, startSec: block.startSec, play: play)
                ForEach(block.lines) { line in
                    TranscriptBlockLineView(
                        line: line, speaker: SpeakerChip(speaker: block.speaker).name, heard: line.id == heardLineID,
                        selected: selected.contains(line.id), past: past, play: play, select: select
                    )
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

    /// "Mira Holt" is "MH", "Speaker 4" is "S4", an empty label is "?". Only letters and digits count, so a label that
    /// is a note in brackets ("[unclear: …]") is "UN", not "[\"".
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
    let selected: Bool
    let past: Bool
    let play: (Double) -> Void
    let select: (TranscriptBlockLine, TranscriptLineClick) -> Void
    @Environment(\.rowLive) private var live
    @State private var hovering = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(verbatim: line.text)
                .font(.system(size: 13))
                .foregroundStyle(textStyle)
                .underline(line.marks.contains(.corrected), pattern: .dot, color: KitPalette.renamed)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 3)
                .padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 4).fill(fill))
            if line.marks.contains(.unclearSpeaker) {
                Image(systemName: "questionmark.circle")
                    .font(.system(size: 11)).foregroundStyle(.orange)
                    .instantTooltip("The engine is not sure who said this line")
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
        .onTapGesture { click() }
        .onHover { inside in
            if live || !inside { hovering = inside && line.startSec != nil }
        }
        .accessibilityElement(children: .ignore)
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
