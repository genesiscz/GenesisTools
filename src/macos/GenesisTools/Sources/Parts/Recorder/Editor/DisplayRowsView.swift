import AppKit
import SwiftUI

/// A frames recording of several displays, one row per display (each display is its own track, as ScreenFlow keeps
/// two screen clips): a card where the movie shows that display, a faint slot where the display has a picture but
/// another one shows. A click on a slot shows that display there; the context menu also hides a display from a
/// segment and shows it in the selected range or from the playhead to the next switch. The lines between the cards
/// are the switch points: drag one to move the switch. Each change remakes the proxy movie as one undo step
/// (EditorDisplays.swift, the REPL's switchDisplay / hideDisplay / moveDisplaySwitch).
struct DisplayRowsView: View {
    @Bindable var model: EditorModel
    let plan: DisplayPlan
    let scale: TimelineScale

    static let rowHeight: CGFloat = 28
    /// A colour per display, in the recording's order.
    static let tints: [Color] = [Color(red: 0.4, green: 0.72, blue: 1), Color(red: 0.95, green: 0.55, blue: 0.85),
                                 Color(red: 0.55, green: 0.85, blue: 0.6), Color(red: 1, green: 0.7, blue: 0.4)]

    /// The display rows' height in the timeline, with the gap under them.
    static func height(rows: Int) -> CGFloat { rows > 0 ? CGFloat(rows) * rowHeight + 4 : 0 }

    var body: some View {
        let rows = plan.rows
        ZStack(alignment: .topLeading) {
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, display in
                    DisplayRowView(model: model, plan: plan, scale: scale, display: display,
                                   tint: Self.tints[index % Self.tints.count])
                }
            }
            ForEach(plan.switches, id: \.self) { atUs in
                SwitchLineHandle(model: model, scale: scale, atUs: atUs, height: CGFloat(rows.count) * Self.rowHeight)
            }
        }
        .frame(height: CGFloat(rows.count) * Self.rowHeight, alignment: .topLeading)
        .opacity(model.isSwitchingDisplay ? 0.55 : 1)
        .allowsHitTesting(!model.isSwitchingDisplay)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Displays")
    }
}

/// One display's row: its cards where the movie shows it, its slots where another display shows.
private struct DisplayRowView: View {
    @Bindable var model: EditorModel
    let plan: DisplayPlan
    let scale: TimelineScale
    let display: (id: Int, name: String)
    let tint: Color
    @State private var hovered: Int?
    @FocusState private var focused: Bool

    private struct Slot {
        let index: Int
        let range: DisplayPlan.Range
        let rect: CGRect
        let shown: Bool
        let available: Bool
    }

    private var slots: [Slot] {
        plan.ranges.enumerated().compactMap { index, range in
            // The last range ends at the last frame; the movie shows it to its own end.
            let toUs = index == plan.ranges.count - 1 ? max(range.toUs, model.project.source.durationUs) : range.toUs
            let spans = TimelineMap.outputSpans(fromUs: range.fromUs, toUs: toUs, in: model.project)
            guard let first = spans.first, let last = spans.last else { return nil }
            let x = scale.x(first.fromUs) + 1
            let rect = CGRect(x: x, y: 3, width: max(3, scale.x(last.toUs) - x - 1), height: DisplayRowsView.rowHeight - 6)
            return Slot(index: index, range: range, rect: rect, shown: range.displayId == display.id,
                        available: plan.hasFrames(display.id, before: range.toUs))
        }
    }

    var body: some View {
        let slots = slots
        let hoveredSlot = slots.first { $0.index == hovered }
        Canvas { context, _ in
            for slot in slots {
                let shape = Path(roundedRect: slot.rect, cornerRadius: 5, style: .continuous)
                let over = slot.index == hovered && !slot.shown && slot.available
                if slot.shown {
                    context.fill(shape, with: .color(tint.opacity(0.32)))
                    context.stroke(shape, with: .color(tint.opacity(0.8)), lineWidth: 1)
                } else if over {
                    context.fill(shape, with: .color(tint.opacity(0.16)))
                    context.stroke(shape, with: .color(tint.opacity(0.7)), style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
                } else if slot.available {
                    context.fill(shape, with: .color(.white.opacity(0.035)))
                    context.stroke(shape, with: .color(.white.opacity(0.12)), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                } else {
                    continue
                }
                let label = over ? "Show \(display.name)" : display.name
                let text = context.resolve(Text(label).font(.system(size: 10.5, weight: slot.shown ? .semibold : .medium))
                    .foregroundStyle(slot.shown || over ? tint : Color.white.opacity(0.42)))
                let glyph = context.resolve(Text(Image(systemName: over ? "plus.circle.fill" : "display"))
                    .font(.system(size: 9.5, weight: .semibold))
                    .foregroundStyle(slot.shown || over ? tint : Color.white.opacity(0.42)))
                let size = text.measure(in: CGSize(width: .greatestFiniteMagnitude, height: slot.rect.height))
                if slot.rect.width >= size.width + 30 {
                    context.draw(glyph, at: CGPoint(x: slot.rect.minX + 11, y: slot.rect.midY), anchor: .center)
                    context.draw(text, at: CGPoint(x: slot.rect.minX + 20, y: slot.rect.midY), anchor: .leading)
                } else if slot.rect.width >= 18 {
                    context.draw(glyph, at: CGPoint(x: slot.rect.midX, y: slot.rect.midY), anchor: .center)
                }
            }
        }
        .frame(height: DisplayRowsView.rowHeight)
        .background(focused ? tint.opacity(0.08) : Color.clear)
        .contentShape(Rectangle())
        .onContinuousHover(coordinateSpace: .local) { phase in
            switch phase {
            case let .active(point): hovered = slots.first { $0.rect.minX <= point.x && point.x < $0.rect.maxX }?.index
            case .ended: hovered = nil
            }
        }
        .onTapGesture(count: 1, coordinateSpace: .local) { point in
            focused = true
            guard let slot = slots.first(where: { $0.rect.minX <= point.x && point.x < $0.rect.maxX }) else { return }
            if slot.shown {
                model.seek(TimelineMap.outputTime(ofSource: slot.range.fromUs, in: model.project) ?? 0)
            } else if slot.available {
                model.switchDisplay(fromUs: slot.range.fromUs, toUs: slot.range.toUs, displayId: display.id)
            } else {
                model.show("\(display.name) has no picture before \(formatClock(slot.range.toUs, tenths: true)).", error: true)
            }
        }
        .contextMenu { menu(for: hoveredSlot.map { (range: $0.range, shown: $0.shown) }) }
        // lint-rules-ignore: short list (one row per captured display)
        .instantTooltip(tooltip(hoveredSlot))
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(.return) { showAtPlayhead() }
        .onKeyPress(.delete) { hideAtPlayhead() }
        .accessibilityElement()
        .accessibilityLabel(display.name)
        .accessibilityValue(accessibilityValue)
        .accessibilityAddTraits(.isButton)
        .accessibilityAction(named: "Show \(display.name) at the playhead") { _ = showAtPlayhead() }
        .accessibilityAction(named: "Hide \(display.name) at the playhead") { _ = hideAtPlayhead() }
        .accessibilityIdentifier("recorder.timeline.display.\(display.id)")
        .frameProbe("recorder.timeline.display.\(display.id)")
    }

    private func tooltip(_ slot: Slot?) -> String {
        guard let slot else { return "\(display.name): click a faint slot to show this display there; right-click for more" }
        let span = "\(formatClock(slot.range.fromUs, tenths: true)) to \(formatClock(slot.range.toUs, tenths: true))"
        if slot.shown { return "\(display.name) shows from \(span). Right-click to hide it here." }
        if slot.available { return "Click to show \(display.name) from \(span) (Return at the playhead)." }
        return "\(display.name) has no picture from \(span)."
    }

    private var accessibilityValue: String {
        let own = plan.ranges.filter { $0.displayId == display.id }
        let shown = own.reduce(Int64(0)) { $0 + $1.toUs - $1.fromUs }
        let now = model.displaySegmentAtPlayhead?.displayId == display.id ? "shown at the playhead" : "not shown at the playhead"
        return "shown \(formatClock(shown, tenths: true)) in \(Plural.count(own.count, "segment")), \(now)"
    }

    @ViewBuilder private func menu(for slot: (range: DisplayPlan.Range, shown: Bool)?) -> some View {
        if let slot {
            let span = "\(formatClock(slot.range.fromUs, tenths: true)) to \(formatClock(slot.range.toUs, tenths: true))"
            if slot.shown {
                Button("Hide \(display.name) from \(span)") {
                    model.hideDisplay(fromUs: slot.range.fromUs, toUs: slot.range.toUs, displayId: display.id)
                }
            } else {
                Button("Show \(display.name) from \(span)") {
                    model.switchDisplay(fromUs: slot.range.fromUs, toUs: slot.range.toUs, displayId: display.id)
                }
                .disabled(!plan.hasFrames(display.id, before: slot.range.toUs))
            }
        }
        if let range = model.timelineRange {
            Button("Show \(display.name) in the Selected Range") { model.switchDisplay(range, to: display.id) }
        }
        if let split = splitAtPlayhead {
            Divider()
            Button("Show \(display.name) from the Playhead to \(formatClock(split.next, tenths: true))") {
                model.switchDisplay(fromUs: split.at, toUs: split.next, displayId: display.id)
            }
            .disabled(split.shown)
            Button("Show \(display.name) from \(formatClock(split.previous, tenths: true)) to the Playhead") {
                model.switchDisplay(fromUs: split.previous, toUs: split.at, displayId: display.id)
            }
            .disabled(split.shown || split.at <= split.previous)
        }
        Divider()
        Button("Hide \(display.name) Everywhere") {
            model.hideDisplay(fromUs: 0, toUs: plan.ranges.last?.toUs ?? 0, displayId: display.id)
        }
        .disabled(!plan.ranges.contains { $0.displayId == display.id })
    }

    /// The segment under the playhead split there: its start, the playhead and its end (source microseconds).
    private var splitAtPlayhead: (previous: Int64, at: Int64, next: Int64, shown: Bool)? {
        let at = TimelineMap.sourceTime(atOutput: model.clock.outUs, in: model.project)
        guard let index = plan.rangeIndex(atSource: at), at < plan.ranges[index].toUs else { return nil }
        let range = plan.ranges[index]
        return (range.fromUs, at, range.toUs, range.displayId == display.id)
    }

    private func showAtPlayhead() -> KeyPress.Result {
        guard let range = model.displaySegmentAtPlayhead, range.displayId != display.id else { return .ignored }
        model.switchDisplay(fromUs: range.fromUs, toUs: range.toUs, displayId: display.id)
        return .handled
    }

    private func hideAtPlayhead() -> KeyPress.Result {
        guard let range = model.displaySegmentAtPlayhead, range.displayId == display.id else { return .ignored }
        model.hideDisplay(fromUs: range.fromUs, toUs: range.toUs, displayId: display.id)
        return .handled
    }
}

/// A switch point between two displays: a line through the display rows with a grip at the top. Dragging it moves
/// the switch (one remake when it is let go); the time it would move to shows over the grip while it moves.
private struct SwitchLineHandle: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale
    let atUs: Int64
    let height: CGFloat
    @State private var dx: CGFloat = 0
    @State private var dragging = false
    @State private var hovering = false
    /// Where a released drag left the line, held until the remade movie's plan replaces this handle (or it failed).
    @State private var pending: CGFloat?

    var body: some View {
        let baseX = scale.x(TimelineMap.outputTime(ofSource: atUs, in: model.project) ?? 0)
        let shift = dragging ? dx : pending ?? 0
        let target = TimelineMap.sourceTime(atOutput: scale.us(baseX + dx), in: model.project)
        ZStack(alignment: .top) {
            Rectangle()
                .fill(Color.white.opacity(dragging || hovering ? 0.95 : 0.7))
                .frame(width: dragging || hovering ? 2 : 1.5, height: height)
            Capsule()
                .fill(Color.white.opacity(0.95))
                .overlay(Capsule().fill(Color.black.opacity(0.5)).frame(width: 1.5, height: 8))
                .frame(width: 7, height: 14)
                .offset(y: -2)
            if dragging {
                Text(verbatim: formatClock(target, tenths: true))
                    .font(.system(size: 10, weight: .semibold).monospacedDigit())
                    .padding(.horizontal, 5).padding(.vertical, 1)
                    .background(Capsule().fill(Color.black.opacity(0.8)))
                    .fixedSize()
                    .offset(y: -18)
            }
        }
        .frame(width: 14, height: height)
        .contentShape(Rectangle())
        .onHover { inside in
            hovering = inside
            if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
        }
        .gesture(DragGesture(minimumDistance: 1)
            .onChanged { value in
                dragging = true
                dx = value.translation.width
            }
            .onEnded { _ in
                dragging = false
                if abs(dx) >= 2 {
                    model.moveDisplaySwitch(atUs: atUs, toUs: target)
                    if model.isSwitchingDisplay { pending = dx }
                }
                dx = 0
            })
        .onChange(of: model.isSwitchingDisplay) { _, busy in
            if !busy { pending = nil }
        }
        .instantTooltip("Display switch at \(formatClock(atUs, tenths: true)): drag to move it")
        .accessibilityElement()
        .accessibilityLabel("Display switch at \(formatClock(atUs, tenths: true))")
        .accessibilityIdentifier("recorder.timeline.displaySwitch.\(atUs)")
        .frameProbe("recorder.timeline.displaySwitch.\(atUs)")
        // Last, so the hit area moves with the drawing.
        .offset(x: baseX + shift - 7)
        // One line per display switch: its tooltip rests until the pointer reaches the line.
        .liveRow()
    }
}
