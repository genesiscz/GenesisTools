import SwiftUI

// MARK: - A speaker hint's ranges as chips (G-SPK-1, G-SPK-3)
//
// Presentational only. b-swift-timeline puts `SpeakerHintChips` under each speaker hint line of a speaker row
// (where `SpeakerHints` draws the text), with `global.playback.listen.longestClipSec` from `config.read`.

/// One chip of a hint: a range that plays, or one too long for a clip that zooms.
struct HintChip: Equatable, Hashable, Identifiable {
    enum Action: Equatable, Hashable { case play, show }

    let fromSec: Double
    let toSec: Double
    let lines: Int
    let action: Action
    /// Who was in the call meanwhile (an `absent-speaker` range).
    let present: [String]

    var id: String { "\(fromSec)-\(toSec)" }

    /// "12:04 to 12:31", or "12:04" for a stretch that starts and ends in one second ("2:07:12 to 2:07:12" read as a
    /// mistake).
    var rangeText: String {
        let from = MeetingsFormat.clock(fromSec), to = MeetingsFormat.clock(toSec)
        return from == to ? from : "\(from) to \(to)"
    }

    /// The chips of a hint's ranges in time order: a range up to `longestClipSec` plays, a longer one shows (zooms),
    /// because the engine refuses a Moment that long (G-SPK-3). At most `maxShown` chips; the rest are counted for
    /// "Review N" (G-SPK-1). Ranges without times have no chip.
    static func chips(for ranges: [SpeakerHint.Range], longestClipSec: Double = 30, maxShown: Int = 3) -> (chips: [HintChip], more: Int) {
        let timed = ranges.compactMap { range -> HintChip? in
            guard let from = range.fromSec, let to = range.toSec else { return nil }
            return HintChip(fromSec: from, toSec: max(from, to), lines: range.lines,
                            action: to - from > longestClipSec ? .show : .play, present: range.present ?? [])
        }
        .sorted { $0.fromSec < $1.fromSec }
        guard timed.count > maxShown else { return (timed, 0) }
        return (Array(timed.prefix(maxShown)), timed.count)
    }
}

/// A hint's ranges as chips: ▸ plays a range, "Show" zooms a long one, "Review N" opens all of them when there are
/// more than `maxShown`.
struct SpeakerHintChips: View {
    let ranges: [SpeakerHint.Range]
    /// The longest Moment the engine cuts (`global.playback.listen.longestClipSec`, 30).
    var longestClipSec: Double = 30
    /// Chips before "Review N". The plan's pick: 3.
    var maxShown = 3
    let play: (Double, Double) -> Void
    let zoom: (Double, Double) -> Void
    /// "Review N": walk every range of the hint (the wiring agent picks the surface).
    var review: () -> Void = {}

    var body: some View {
        let (chips, more) = HintChip.chips(for: ranges, longestClipSec: longestClipSec, maxShown: maxShown)
        if !chips.isEmpty {
            // Wrapped, not one line: four chips are wider than the detail column at the window's smallest size.
            WrapLayout(spacing: 6, lineSpacing: 6) {
                ForEach(chips) { chip in
                    chipButton(chip)
                }
                if more > 0 {
                    Button(action: review) {
                        Text(verbatim: "Review \(more)")
                            .font(.system(size: 11.5, weight: .medium))
                            .padding(.horizontal, 8).frame(height: 22)
                            .overlay(Capsule().strokeBorder(Color.secondary.opacity(0.4)))
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.genHoverPlain())
                    .instantTooltip("Review all \(more) stretches of this hint")
                }
            }
        }
    }

    private func chipButton(_ chip: HintChip) -> some View {
        Button {
            switch chip.action {
            case .play: play(chip.fromSec, chip.toSec)
            case .show: zoom(chip.fromSec, chip.toSec)
            }
        } label: {
            HStack(spacing: 4) {
                Image(systemName: chip.action == .play ? "play.fill" : "plus.magnifyingglass")
                    .font(.system(size: 9))
                if chip.action == .show { Text("Show") }
                Text(verbatim: chip.rangeText).font(.system(size: 11, design: .monospaced))
            }
            .font(.system(size: 11.5))
            .padding(.horizontal, 8).frame(height: 22)
            .background(Capsule().fill(Color.secondary.opacity(0.14)))
            .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip(tooltip(chip))
        .accessibilityLabel(chip.action == .play ? "Play \(chip.rangeText)" : "Show \(chip.rangeText) on the timeline")
    }

    private func tooltip(_ chip: HintChip) -> String {
        let who = chip.present.isEmpty ? "" : " In the call: \(chip.present.joined(separator: ", "))."
        switch chip.action {
        case .play:
            return chip.lines > 0 ? "Play \(Plural.count(chip.lines, "line")) from \(chip.rangeText).\(who)" : "Play \(chip.rangeText).\(who)"
        case .show:
            return "Longer than \(MeetingsFormat.seconds(longestClipSec)): zooms the timeline to \(chip.rangeText).\(who)"
        }
    }
}
