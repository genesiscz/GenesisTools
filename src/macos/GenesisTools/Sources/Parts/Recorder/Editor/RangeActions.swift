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
    case cut, speed, zoom, hide, spotlight, text, marker, comment, exportPart
    var id: String { rawValue }

    var title: String {
        switch self {
        case .cut: "Cut"
        case .speed: "Speed"
        case .zoom: "Zoom"
        case .hide: "Hide a Part"
        case .spotlight: "Spotlight"
        case .text: "Text"
        case .marker: "Add Marker"
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
        case .marker: "flag"
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
        case .marker: "At its start"
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
            let op = EditOp.RangeAction(from: EditOpDiff.seconds(range.fromUs), to: EditOpDiff.seconds(range.toUs), action: "cut")
            edit([.range(op)], then: { [weak self] _, _ in
                self?.selection = .none
                self?.seek(range.fromUs)
            }, failed: { [weak self] reason in
                self?.show("Nothing was cut: \(reason)", error: false)
            })
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
        case .marker:
            addMarker(range, label: "")
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

extension EditorModel {
    /// What a new marker is called when it is given no name, as the `marker` op names it.
    var nextMarkerName: String { "Marker \((project.markers?.count ?? 0) + 1)" }

    /// A marker at the range's start, through the `range` op's `marker` action in `tools recorder apply`, so the
    /// window, the CLI and the REPL add it the same way; one undo step.
    func addMarker(_ range: TimelineRange, label: String) {
        timelineRange = nil
        var op: [String: Any] = ["op": "range", "from": Double(range.fromUs) / 1_000_000, "to": Double(range.toUs) / 1_000_000,
                                 "action": "marker"]
        let name = label.trimmingCharacters(in: .whitespacesAndNewlines)
        if !name.isEmpty { op["text"] = String(name.prefix(80)) }
        let json = (try? JSONSerialization.data(withJSONObject: op, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) } ?? "{}"
        applyOps(json) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success: self.show("Added a marker at \(formatClock(range.fromUs, tenths: true)). ⌘Z takes it back.", error: false)
            case let .failure(failure): self.show("The marker was not added: \(failure.reason)", error: true)
            }
        }
    }

    /// Removes a marker set while editing (the `unmarker` op); the recording's own markers stay.
    func deleteMarker(_ id: String) {
        applyOps(#"{"id":"\#(id)","op":"unmarker"}"#) { [weak self] result in
            guard let self else { return }
            switch result {
            case .success:
                if case let .marker(selectedID, _) = self.selection, selectedID == id { self.selection = .none }
                self.show("Deleted the marker. ⌘Z brings it back.", error: false)
            case let .failure(failure): self.show("The marker was not deleted: \(failure.reason)", error: true)
            }
        }
    }
}

/// The popover over a dragged range: its times and one row per action; Speed has its factors inline, Add Marker its
/// name field.
struct RangeActionsView: View {
    let model: EditorModel
    let range: TimelineRange
    @State private var markerName = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: "\(formatClock(range.fromUs, tenths: true)) – \(formatClock(range.toUs, tenths: true)) · \(String(format: "%.1f s", Double(range.lengthUs) / 1_000_000))")
                .font(.system(size: 11.5, weight: .semibold).monospacedDigit())
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8).padding(.bottom, 4)
            if let plan = model.displayPlan, plan.displays.count > 1 {
                HStack(spacing: 9) {
                    Image(systemName: "display").frame(width: 16)
                    VStack(alignment: .leading, spacing: 0) {
                        Text("Show a Display").font(.system(size: 12.5, weight: .medium))
                        Text("Which screen this range shows").font(.system(size: 10.5)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    MenuButton(items: {
                        plan.displays.map { display in
                            .action(display.name, run: { model.switchDisplay(range, to: display.id) })
                        }
                    }) {
                        Label("Display", systemImage: "chevron.down")
                            .labelStyle(.titleAndIcon)
                            .font(.system(size: 12, weight: .semibold))
                    }
                    .instantTooltip("Pick the display this range shows; the movie is made again")
                    .accessibilityIdentifier("recorder.range.display")
                }
                .padding(.horizontal, 8).frame(height: 32)
            }
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
                } else if action == .marker {
                    HStack(spacing: 8) {
                        label(action)
                        Spacer(minLength: 8)
                        TextField(model.nextMarkerName, text: $markerName)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 80)
                            .onSubmit { model.addMarker(range, label: markerName) }
                            .accessibilityLabel("Marker name")
                        IconButton(systemName: "plus", tooltip: "Add the marker at \(formatClock(range.fromUs, tenths: true)) (Return in the name)", size: 11) {
                            model.addMarker(range, label: markerName)
                        }
                        .accessibilityIdentifier("recorder.range.marker")
                    }
                    .padding(.horizontal, 8).frame(height: 32)
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
