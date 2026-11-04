import AppKit
import SwiftUI

/// A range of the edit in OUTPUT microseconds, as the frames lane shows it.
struct TimelineRange: Equatable {
    var fromUs: Int64
    var toUs: Int64

    var lengthUs: Int64 { toUs - fromUs }
}

/// What the popover over a dragged range can do with it. Each is the `range` op of `tools recorder apply`, the export
/// with `--from`/`--to`, or `tools recorder comment --to`, so an agent does the same with one call.
enum RangeAction: String, CaseIterable, Identifiable {
    case cut, speed, zoom, hide, spotlight, text, comment, exportPart
    var id: String { rawValue }

    var title: String {
        switch self {
        case .cut: "Cut"
        case .speed: "Speed"
        case .zoom: "Zoom"
        case .hide: "Hide a Part"
        case .spotlight: "Spotlight"
        case .text: "Text"
        case .comment: "Comment"
        case .exportPart: "Export This Part"
        }
    }

    var symbol: String {
        switch self {
        case .cut: "scissors"
        case .speed: "gauge.with.dots.needle.67percent"
        case .zoom: "plus.magnifyingglass"
        case .hide: "eye.slash"
        case .spotlight: "light.max"
        case .text: "textformat"
        case .comment: "text.bubble"
        case .exportPart: "square.and.arrow.up"
        }
    }

    var detail: String {
        switch self {
        case .cut: "Remove what plays here"
        case .speed: "Faster or slower"
        case .zoom: "Zoom in over it"
        case .hide: "Blur a part of the picture"
        case .spotlight: "Dim everything around a part"
        case .text: "A title over it"
        case .comment: "A review note, a marker on the timeline"
        case .exportPart: "Write only this part"
        }
    }
}

extension EditorModel {
    /// On by default: a drag on the frames lane opens the range's popover. Off, the drag marks the export part (I and
    /// O) instead. View → Ask What to Do With a Dragged Range.
    nonisolated static let rangePopoverKey = "recorder.timeline.rangePopover"
    nonisolated static var rangePopover: Bool { UserDefaults.standard.object(forKey: rangePopoverKey) as? Bool ?? true }
    nonisolated static let rangeSpeeds = [0.5, 1.5, 2, 4]

    /// A drag on the frames lane ended over `range`.
    func selectRange(_ range: TimelineRange) {
        let clamped = TimelineRange(fromUs: max(0, range.fromUs), toUs: min(durationUs, range.toUs))
        guard clamped.lengthUs >= 100_000 else { return }
        if Self.rangePopover {
            timelineRange = clamped
        } else {
            partInUs = clamped.fromUs
            partOutUs = clamped.toUs
        }
    }

    /// Does `action` over the range, as the `range` op does, and clears the range.
    func applyRange(_ action: RangeAction, _ range: TimelineRange, speed: Double = 2) {
        timelineRange = nil
        switch action {
        case .cut:
            guard let next = TimelineMap.cut(project, fromOut: range.fromUs, toOut: range.toUs) else {
                show("That would cut the whole movie.", error: false)
                return
            }
            selection = .none
            clock.outUs = range.fromUs
            apply(next, rebuildMovie: true)
        case .speed:
            speedRange(fromOut: range.fromUs, toOut: range.toUs, speed: speed)
        case .zoom:
            addEffect(.zoom, fromOut: range.fromUs, toOut: range.toUs, lane: nil)
        case .hide:
            addEffect(.hide, fromOut: range.fromUs, toOut: range.toUs, lane: nil)
        case .spotlight:
            addEffect(.spotlight, fromOut: range.fromUs, toOut: range.toUs, lane: nil)
        case .text:
            addEffect(.text, fromOut: range.fromUs, toOut: range.toUs, lane: nil)
        case .comment:
            commentPrompt(range: range)
        case .exportPart:
            partInUs = range.fromUs
            partOutUs = range.toUs
            tab = .export
            export()
        }
    }
}

/// The popover over a dragged range: its times and one row per action; Speed has its factors inline.
struct RangeActionsView: View {
    let model: EditorModel
    let range: TimelineRange

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "\(formatClock(range.fromUs, tenths: true)) – \(formatClock(range.toUs, tenths: true)) · \(String(format: "%.1f s", Double(range.lengthUs) / 1_000_000))")
                .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.bottom, 4)
            ForEach(RangeAction.allCases) { action in
                if action == .speed {
                    HStack(spacing: 8) {
                        label(action)
                        Spacer(minLength: 8)
                        ForEach(EditorModel.rangeSpeeds, id: \.self) { speed in
                            Button(speedLabel(speed)) { model.applyRange(.speed, range, speed: speed) }
                                .buttonStyle(.genHoverPlain())
                                .font(.system(size: 12, weight: .semibold).monospacedDigit())
                                .instantTooltip(speed < 1 ? "Play it at \(speedLabel(speed)) (slower)" : "Play it \(speedLabel(speed)) as fast")
                                .accessibilityLabel("Speed \(speedLabel(speed))")
                        }
                    }
                    .padding(.horizontal, 8).frame(height: 28)
                } else {
                    label(action)
                        .padding(.horizontal, 8).frame(height: 28)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .rowButton(cornerRadius: 5) { model.applyRange(action, range) }
                        .accessibilityIdentifier("recorder.range.\(action.rawValue)")
                }
            }
        }
        .padding(8)
        .frame(width: 300)
    }

    private func label(_ action: RangeAction) -> some View {
        HStack(spacing: 9) {
            Image(systemName: action.symbol).frame(width: 16)
                .foregroundStyle(action == .cut ? Color.red : Color.primary)
            VStack(alignment: .leading, spacing: 0) {
                Text(action.title).font(.system(size: 12.5, weight: .medium))
                Text(action.detail).font(.system(size: 10.5)).foregroundStyle(.secondary)
            }
        }
    }
}
