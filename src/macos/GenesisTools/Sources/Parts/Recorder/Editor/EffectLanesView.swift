import AppKit
import SwiftUI

/// Heights of the effects area: one lane per `EffectLanes.Resolved`, a lane as tall as its rows.
enum EffectLaneMetrics {
    static let singleRowHeight: CGFloat = 30
    static let rowHeight: CGFloat = 18
    static let rowGap: CGFloat = 2
    static let laneGap: CGFloat = 6
    /// Overlapping items take a row each, up to this many; past it they share the last row and a +N chip lists them.
    static let rowsShown = 3

    static func height(rows: Int) -> CGFloat {
        let rows = min(max(1, rows), rowsShown)
        return rows == 1 ? singleRowHeight : CGFloat(rows) * rowHeight + CGFloat(rows - 1) * rowGap
    }

    static func rowTop(_ row: Int, rows: Int) -> CGFloat {
        rows <= 1 ? 0 : CGFloat(min(row, rowsShown - 1)) * (rowHeight + rowGap)
    }

    /// Every lane's height and the gaps between them.
    static func contentHeight(_ lanes: [EffectLanes.Resolved]) -> CGFloat {
        guard !lanes.isEmpty else { return 0 }
        return lanes.map { height(rows: $0.rowCount) }.reduce(0, +) + CGFloat(lanes.count - 1) * laneGap
    }

    /// The area's height: every lane, or as many as `maxLanes` before it scrolls (0 shows all).
    static func areaHeight(_ lanes: [EffectLanes.Resolved], maxLanes: Int) -> CGFloat {
        guard maxLanes > 0, lanes.count > maxLanes else { return contentHeight(lanes) }
        // Half of the next lane shows under the fade, so the cut reads as "more below".
        let shown = Array(lanes.prefix(maxLanes))
        return contentHeight(shown) + laneGap + height(rows: lanes[maxLanes].rowCount) / 2
    }
}

extension EffectKind {
    var color: Color {
        switch self {
        case .zoom: RecorderPalette.zoom
        case .hide: Color(red: 1, green: 0.62, blue: 0.2)
        case .spotlight: Color(red: 1, green: 0.88, blue: 0.45)
        case .text: Color(red: 0.3, green: 0.85, blue: 0.5)
        case .shape: Color(red: 1, green: 0.45, blue: 0.35)
        case .speed: Color(red: 0.7, green: 0.55, blue: 1)
        }
    }

    /// Dark text on the light colours, white on the others.
    var labelColor: Color {
        switch self {
        case .zoom, .speed: .white
        case .hide, .spotlight, .text, .shape: Color.black.opacity(0.78)
        }
    }
}

/// The effect lanes, top to bottom; past `maxLanes` the area scrolls and fades at the cut edge.
struct EffectLanesArea: View {
    @Bindable var model: EditorModel
    let lanes: [EffectLanes.Resolved]
    let scale: TimelineScale
    let width: CGFloat
    let height: CGFloat

    var body: some View {
        // A scroll view only when the lanes overflow; lanes that fit are a plain stack with nothing to scroll.
        if EffectLaneMetrics.contentHeight(lanes) <= height + 0.5 {
            stack.frame(width: width, height: height, alignment: .topLeading)
        } else {
            ScrollView(.vertical, showsIndicators: false) {
                stack.scrollOverflowContent()
            }
            .scrollOverflowHints()
            .frame(width: width, height: height, alignment: .topLeading)
        }
    }

    private var stack: some View {
        VStack(alignment: .leading, spacing: EffectLaneMetrics.laneGap) {
            ForEach(lanes) { lane in
                EffectLaneView(model: model, lane: lane, lanes: lanes, scale: scale, width: width)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel(lane.lane.title)
            }
        }
        .frame(width: width, alignment: .topLeading)
    }
}

/// One lane: a click on an empty spot adds what it holds there (a lane of several kinds asks which), a drag adds it
/// over the dragged range, and its items sit in rows when they overlap.
struct EffectLaneView: View {
    @Bindable var model: EditorModel
    let lane: EffectLanes.Resolved
    let lanes: [EffectLanes.Resolved]
    let scale: TimelineScale
    let width: CGFloat
    @State private var dragStart: CGFloat?
    @State private var dragNow: CGFloat?
    @State private var listingOverflow = false

    private var kinds: [EffectKind] { lane.lane.kinds ?? EffectKind.allCases }
    /// What a click adds: every kind the lane holds that can be added at a time (a speed is added over a range only).
    private var addable: [EffectKind] { kinds }

    var body: some View {
        let rows = lane.rows
        let rowCount = lane.rowCount
        let height = EffectLaneMetrics.height(rows: rowCount)
        let itemHeight = rowCount <= 1 ? height : EffectLaneMetrics.rowHeight
        ZStack(alignment: .topLeading) {
            gutter(height: height)
            // The offset comes last, after the gesture: `.offset` moves the drawing but not the frame the modifiers
            // after it hit-test (the zoom-lane click once landed one inset right of the pointer).
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(RecorderPalette.lane.opacity(0.7))
                .frame(width: scale.width(model.durationUs), height: height)
                .overlay(alignment: .center) {
                    if lane.items.isEmpty && dragStart == nil {
                        Label(emptyHint, systemImage: "plus")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(RecorderPalette.dim)
                            .allowsHitTesting(false)
                    }
                }
                .contentShape(Rectangle())
                .gesture(addGesture)
                .contextMenu { laneMenu() }
                .offset(x: scale.inset)
            if let dragStart, let dragNow {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill((kinds.first ?? .zoom).color.opacity(0.45))
                    .frame(width: abs(dragNow - dragStart), height: height)
                    .offset(x: min(dragStart, dragNow))
                    .allowsHitTesting(false)
            }
            ForEach(lane.items) { item in
                let row = rows[item.id] ?? 0
                let stacked = row >= EffectLaneMetrics.rowsShown && !model.isSelected(item)
                EffectSegment(model: model, item: item, laneID: lane.id, lanes: lanes, scale: scale, height: itemHeight)
                    .opacity(stacked ? 0 : 1)
                    .allowsHitTesting(!stacked)
                    .accessibilityHidden(stacked)
                    .zIndex(model.isSelected(item) ? 1 : 0)
                    .offset(y: EffectLaneMetrics.rowTop(row, rows: rowCount))
            }
            if let overflow = overflow(rows: rows) {
                overflowChip(overflow, rows: rows)
            }
        }
        .frame(width: width, height: height, alignment: .topLeading)
    }

    private var emptyHint: String {
        guard let first = lane.lane.kinds?.first, lane.lane.kinds?.count == 1 else { return "Click or drag to add an effect" }
        return first == .speed ? "Drag to play a part faster" : "Click or drag to add \(first.title.lowercased())"
    }

    /// The lane's icon in the space left of the movie's start: its menu (add, move, rename, remove).
    private func gutter(height: CGFloat) -> some View {
        MenuButton(items: { laneMenuItems() }) {
            Image(systemName: lane.lane.kinds?.first?.symbol ?? "square.stack.3d.up")
                .font(.system(size: 10.5, weight: .medium))
                .foregroundStyle(RecorderPalette.dim)
                .frame(width: scale.inset - 6, height: min(height, 22))
        }
        .instantTooltip("\(lane.lane.title): click for the lane's menu")
        .frame(width: scale.inset, height: height)
        .accessibilityLabel("\(lane.lane.title) lane menu")
    }

    private var addGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                // Local points are the lane's own: its left edge is the movie's start, `inset` in from the strip.
                dragStart = value.startLocation.x + scale.inset
                dragNow = value.location.x + scale.inset
            }
            .onEnded { value in
                defer { dragStart = nil; dragNow = nil }
                let start = value.startLocation.x + scale.inset
                let end = value.location.x + scale.inset
                let click = abs(end - start) < 4
                let fromUs = scale.us(min(start, end))
                let lengthUs: Int64? = click ? nil : max(500_000, scale.us(max(start, end)) - fromUs)
                let choices = click ? addable.filter { $0 != .speed } : addable
                if choices.count == 1, let kind = choices.first {
                    model.addEffect(kind, atOutput: fromUs, durationUs: lengthUs, lane: lane.id)
                } else if !choices.isEmpty {
                    MenuButtonPresenter.pop(choices.map { kind in
                        .action("Add \(kind.title)", run: { model.addEffect(kind, atOutput: fromUs, durationUs: lengthUs, lane: lane.id) })
                    })
                }
            }
    }

    @ViewBuilder
    private func laneMenu() -> some View {
        ForEach(kinds.filter { $0 != .speed }) { kind in
            Button("Add \(kind.title) at Playhead") { model.addEffect(kind, atOutput: model.clock.outUs, durationUs: nil, lane: lane.id) }
        }
        Divider()
        laneEditButtons()
    }

    @ViewBuilder
    private func laneEditButtons() -> some View {
        let index = lanes.firstIndex { $0.id == lane.id } ?? 0
        Button("Rename Lane…") { model.renameLanePrompt(lane.id, current: lane.lane.title) }
        Button("Move Lane Up") { model.moveLane(lane.id, by: -1) }.disabled(index == 0)
        Button("Move Lane Down") { model.moveLane(lane.id, by: 1) }.disabled(index >= lanes.count - 1)
        Button("Remove Lane", role: .destructive) { model.removeLane(lane.id) }
    }

    private func laneMenuItems() -> [MenuButtonItem] {
        let index = lanes.firstIndex { $0.id == lane.id } ?? 0
        var items: [MenuButtonItem] = [.note(lane.lane.title)]
        items += kinds.filter { $0 != .speed }.map { kind in
            .action("Add \(kind.title) at Playhead", run: { model.addEffect(kind, atOutput: model.clock.outUs, durationUs: nil, lane: lane.id) })
        }
        items += [
            .divider,
            .action("Rename Lane…", run: { model.renameLanePrompt(lane.id, current: lane.lane.title) }),
            .action("Move Lane Up", enabled: index > 0, run: { model.moveLane(lane.id, by: -1) }),
            .action("Move Lane Down", enabled: index < lanes.count - 1, run: { model.moveLane(lane.id, by: 1) }),
            .action("Remove Lane", run: { model.removeLane(lane.id) }),
        ]
        return items
    }

    /// The items past the last row shown (they share that row): how many, and where the first starts.
    private func overflow(rows: [String: Int]) -> (count: Int, startUs: Int64)? {
        let hidden = lane.items.filter { (rows[$0.id] ?? 0) >= EffectLaneMetrics.rowsShown }
        guard let first = hidden.map(\.startUs).min() else { return nil }
        return (hidden.count, first)
    }

    private func overflowChip(_ overflow: (count: Int, startUs: Int64), rows: [String: Int]) -> some View {
        let out = TimelineMap.outputTime(ofSource: overflow.startUs, in: model.project) ?? 0
        return Button { listingOverflow = true } label: {
            Text(verbatim: "+\(overflow.count)")
                .font(.system(size: 9.5, weight: .bold).monospacedDigit())
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .frame(height: EffectLaneMetrics.rowHeight - 4)
                .background(Capsule().fill(Color.black.opacity(0.75)))
                .overlay(Capsule().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5))
                .contentShape(Capsule())
        }
        .buttonStyle(.genHoverPlain())
        .instantTooltip("\(Plural.count(overflow.count, "more item")) overlap this row: click to pick one")
        .accessibilityLabel("\(Plural.count(overflow.count, "more item")) not shown in their own row")
        .popover(isPresented: $listingOverflow, arrowEdge: .bottom) {
            OverflowList(model: model, items: lane.items.filter { (rows[$0.id] ?? 0) >= EffectLaneMetrics.rowsShown }) {
                listingOverflow = false
            }
        }
        .offset(x: max(0, scale.x(out) - 2), y: EffectLaneMetrics.rowTop(EffectLaneMetrics.rowsShown - 1, rows: EffectLaneMetrics.rowsShown) + 2)
        .zIndex(2)
    }

    /// The items under the +N chip, in time order: a click selects one and moves the playhead there.
    private struct OverflowList: View {
        let model: EditorModel
        let items: [EffectItem]
        let done: () -> Void

        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: Plural.count(items.count, "more item"))
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.bottom, 2)
                ForEach(items) { item in
                    HStack(spacing: 8) {
                        Image(systemName: item.kind.symbol).frame(width: 14)
                        Text(verbatim: item.label).lineLimit(1)
                        Spacer(minLength: 12)
                        Text(verbatim: formatClock(TimelineMap.outputTime(ofSource: item.startUs, in: model.project) ?? item.startUs))
                            .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12.5))
                    .padding(.horizontal, 8).frame(height: 24)
                    .frame(minWidth: 200)
                    .rowButton(cornerRadius: 5) {
                        model.selectEffect(item)
                        done()
                    }
                }
            }
            .padding(8)
        }
    }
}

/// One item on a lane: a click selects it and opens its panel, a drag moves it in time with snapping, an edge trims
/// it, and a right-click offers Edit, Duplicate, Move to Lane and Delete. A speed item is its clip: it does not move.
struct EffectSegment: View {
    @Bindable var model: EditorModel
    let item: EffectItem
    let laneID: String
    let lanes: [EffectLanes.Resolved]
    let scale: TimelineScale
    let height: CGFloat
    @State private var moveFrom: (Int64, Int64)?

    private var movable: Bool { item.kind != .speed }

    var body: some View {
        let spans = TimelineMap.outputSpans(fromUs: item.startUs, toUs: item.endUs, in: model.project)
        if let first = spans.first, let last = spans.last {
            let selected = model.isSelected(item)
            let width = max(8, scale.x(last.toUs) - scale.x(first.fromUs))
            let radius: CGFloat = height > 22 ? 7 : 5
            RoundedRectangle(cornerRadius: radius, style: .continuous)
                .fill(item.kind.color.opacity(selected ? 1 : 0.8))
                .overlay(alignment: .leading) { ramp(ms: item.easeInMs, total: width, leading: true) }
                .overlay(alignment: .trailing) { ramp(ms: item.easeOutMs, total: width, leading: false) }
                .clipShape(RoundedRectangle(cornerRadius: radius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: radius, style: .continuous)
                        .strokeBorder(Color.white.opacity(selected ? 0.9 : 0), lineWidth: 1.5)
                        .attentionPulse(trigger: model.flashToken(item.id), style: EditorView.pulse(cornerRadius: radius))
                }
                .overlay {
                    if width > 34 {
                        Text(verbatim: width > 70 || item.kind != .zoom ? item.label : item.label.replacingOccurrences(of: "Zoom ", with: ""))
                            .font(.system(size: height > 22 ? 12 : 10.5, weight: .semibold))
                            .foregroundStyle(item.kind.labelColor)
                            .lineLimit(1)
                            .padding(.horizontal, 6)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(alignment: .leading) { if movable { edgeHandle(leading: true, width: min(8, width / 3)) } }
                .overlay(alignment: .trailing) { if movable { edgeHandle(leading: false, width: min(8, width / 3)) } }
                .frame(width: width, height: height)
                .overlay(alignment: .topLeading) {
                    if moveFrom != nil { DragTimeTag(project: model.project, startUs: item.startUs, endUs: item.endUs) }
                }
                .contentShape(Rectangle())
                .onTapGesture { model.selectEffect(item) }
                .gesture(moveGesture)
                .contextMenu { menu() }
                .instantTooltip(movable ? "\(item.label): click to edit, drag to move, drag an edge to trim, right-click for more"
                                        : "\(item.label): this clip plays at another speed; click to edit it")
                .accessibilityElement()
                .accessibilityLabel("\(item.kind.title), \(item.label), \(editRange(model.project, fromUs: item.startUs, toUs: item.endUs).edit)")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("recorder.\(item.kind.rawValue).\(item.id)")
                // A tap gesture alone gives the element no AXPress, so VoiceOver and agents could not select it.
                .accessibilityAction { model.selectEffect(item) }
                .accessibilityAction(named: "Delete") { model.deleteEffect(item) }
                // No `.liveRow`: a segment that flipped between live and resting lost every second click
                // (RecorderTimelineTests), and a lane holds a few segments, not a dense list.
                // Last: the segment and its hit area move together (see EffectLaneView).
                .offset(x: scale.x(first.fromUs))
        }
    }

    @ViewBuilder
    private func menu() -> some View {
        Button("Edit") { model.selectEffect(item) }
        if movable {
            Button("Duplicate") { model.selectEffect(item); model.duplicateSelection() }
            let others = lanes.filter { $0.id != laneID && $0.lane.holds(item.kind) }
            if !others.isEmpty {
                Menu("Move to Lane") {
                    ForEach(others) { other in
                        Button(other.lane.title) { model.moveEffect(item, toLane: other.id) }
                    }
                }
            }
        }
        Divider()
        Button(item.kind == .speed ? "Play at Normal Speed" : "Delete", role: .destructive) { model.deleteEffect(item) }
    }

    private var moveGesture: some Gesture {
        DragGesture(minimumDistance: 3).onChanged { value in
            guard movable else { return }
            if moveFrom == nil { moveFrom = (item.startUs, item.endUs); model.selectEffect(item, seek: false) }
            guard let (start, end) = moveFrom else { return }
            let raw = shift(value.translation.width, start: start, end: end)
            let delta = raw + model.snappedMove(start: start + raw, end: end + raw, excluding: item.id)
            let length = end - start
            let moved = min(max(0, start + delta), model.project.source.durationUs - length)
            model.moveEffect(item, startUs: moved, endUs: moved + length)
        }.onEnded { _ in moveFrom = nil; model.endSnap() }
    }

    /// The source shift of a drag, kept inside the recording.
    private func shift(_ points: CGFloat, start: Int64, end: Int64) -> Int64 {
        let delta = Int64(Double(points) / scale.pointsPerSecond * 1_000_000)
        return min(max(delta, -start), model.project.source.durationUs - (end - start) - start)
    }

    private func ramp(ms: Int, total: CGFloat, leading: Bool) -> some View {
        let width = min(total / 2, scale.width(Int64(ms) * 1000))
        return LinearGradient(colors: [Color.white.opacity(0.32), Color.white.opacity(0)],
                              startPoint: leading ? .leading : .trailing, endPoint: leading ? .trailing : .leading)
            .frame(width: max(0, width))
            .allowsHitTesting(false)
    }

    private func edgeHandle(leading: Bool, width: CGFloat) -> some View {
        Rectangle()
            .fill(Color.white.opacity(0.001))
            .frame(width: width)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1).onChanged { value in
                if moveFrom == nil { moveFrom = (item.startUs, item.endUs); model.selectEffect(item, seek: false) }
                guard let (start, end) = moveFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000)
                let edge = model.snapped(leading ? start + delta : end + delta, excluding: item.id)
                if leading {
                    model.moveEffect(item, startUs: max(0, min(edge, end - 100_000)), endUs: end)
                } else {
                    model.moveEffect(item, startUs: start, endUs: max(start + 100_000, edge))
                }
            }.onEnded { _ in moveFrom = nil; model.endSnap() })
    }
}
