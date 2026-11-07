import AVFoundation
import SwiftUI

/// The editor's colours, one dark palette like the reference editor: near-black lanes, the blue of a zoom, the red
/// playhead, the white frame of a selected clip (as on a selected zoom; yellow read as a warning).
enum RecorderPalette {
    static let window = Color(white: 0.105)
    static let panel = Color(white: 0.135)
    static let lane = Color(white: 0.17)
    static let hairline = Color.white.opacity(0.08)
    static let zoom = Color(red: 0.04, green: 0.45, blue: 0.98)
    static let playhead = Color(red: 0.98, green: 0.27, blue: 0.27)
    static let selected = Color.white.opacity(0.95)
    static let text = Color.white.opacity(0.88)
    static let dim = Color.white.opacity(0.5)
}

/// Output time and x position on the timeline, both ways.
struct TimelineScale {
    var pointsPerSecond: Double = 100
    var inset: CGFloat = 28

    func x(_ us: Int64) -> CGFloat { inset + CGFloat(Double(us) / 1_000_000 * pointsPerSecond) }
    func us(_ x: CGFloat) -> Int64 { Int64(max(0, Double(x - inset) / pointsPerSecond * 1_000_000)) }
    func width(_ us: Int64) -> CGFloat { CGFloat(Double(us) / 1_000_000 * pointsPerSecond) }
}

struct TimelineView: View {
    @Bindable var model: EditorModel
    let viewportWidth: CGFloat
    @AppStorage(EditorModel.lanesShownKey) private var lanesShown = 4

    static let rulerHeight: CGFloat = 26
    static let clipLaneHeight: CGFloat = 64
    static let audioLaneHeight: CGFloat = 30
    static let musicLaneHeight: CGFloat = 14
    static let marksLaneHeight: CGFloat = 16
    static let displayLaneHeight: CGFloat = 20
    static let laneGap: CGFloat = 8
    /// Where the effect lanes start, under the ruler.
    static let effectsTop: CGFloat = rulerHeight + 10

    /// Fitted, the whole edit fills the strip between the two insets, so nothing runs past the window's edge.
    private var fit: Double {
        Double(max(200, viewportWidth - 2 * TimelineScale().inset)) / max(0.5, Double(model.durationUs) / 1_000_000)
    }

    private var scale: TimelineScale {
        TimelineScale(pointsPerSecond: model.pointsPerSecond > 0 ? model.pointsPerSecond : fit)
    }

    var body: some View {
        let scale = scale
        let layout = TimelineLayout(model: model, lanesShown: lanesShown)
        let contentWidth = max(viewportWidth, scale.x(model.durationUs) + scale.inset)
        ScrollView(.horizontal, showsIndicators: true) {
            ZStack(alignment: .topLeading) {
                RulerView(durationUs: model.durationUs, scale: scale)
                    .frame(width: contentWidth, height: Self.rulerHeight)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { value in model.seek(scale.us(value.location.x)) })
                // Each lane is a named group for VoiceOver, so "Zooms, 3 items" says which lane the cursor is in.
                EffectLanesArea(model: model, lanes: layout.lanes, scale: scale, width: contentWidth, height: layout.effectsHeight)
                    .offset(y: Self.effectsTop)
                if let plan = model.displayPlan, layout.displays {
                    DisplayLaneView(model: model, plan: plan, scale: scale)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Displays shown")
                        .offset(y: layout.displaysTop)
                }
                ClipLaneView(model: model, scale: scale)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Clips")
                    .offset(y: layout.clipTop)
                if let guide = model.snapGuideUs, let out = TimelineMap.outputTime(ofSource: guide, in: model.project) {
                    Rectangle().fill(Color.yellow.opacity(0.9))
                        .frame(width: 1, height: layout.lanesBottom - Self.rulerHeight)
                        .offset(x: scale.x(out), y: Self.rulerHeight)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
                if layout.marks {
                    MarksLaneView(model: model, scale: scale)
                        .offset(y: layout.marksTop)
                }
                if layout.audio {
                    AudioLaneView(model: model, scale: scale)
                        .offset(y: layout.audioTop)
                }
                if layout.music, let music = model.project.audio.music {
                    MusicLaneView(model: model, music: music, scale: scale)
                        .offset(y: layout.musicTop)
                }
                if let part = model.exportPart {
                    PartBand(model: model, scale: scale, part: part, layout: layout)
                }
                PlayheadView(clock: model.clock, scale: scale, model: model, layout: layout)
            }
            .frame(width: contentWidth, height: layout.totalHeight, alignment: .topLeading)
        }
        .background(RecorderPalette.window)
        .onAppear { model.fittedPointsPerSecond = fit }
        .onChange(of: fit) { _, value in model.fittedPointsPerSecond = value }
    }
}

/// Where each lane sits, from what the edit has: the effect lanes on top (scrolling past `EditorModel.lanesShown`), the
/// clips, a marks lane only with markers, captions or shortcuts to show, the sound lane only for a movie with sound,
/// and a music lane under it.
struct TimelineLayout: Equatable {
    var lanes: [EffectLanes.Resolved]
    var effectsHeight: CGFloat
    /// A frames recording's proxy with a display plan: the lane that says which display shows when.
    var displays: Bool
    var marks: Bool
    var audio: Bool
    var music: Bool

    @MainActor
    init(model: EditorModel, lanesShown: Int = EditorModel.lanesShown) {
        let project = model.project
        lanes = model.effectLanes
        effectsHeight = EffectLaneMetrics.areaHeight(lanes, maxLanes: lanesShown)
        displays = !(model.displayPlan?.ranges.isEmpty ?? true)
        marks = !model.markers.isEmpty || !model.reviewComments.isEmpty
            || (project.captions?.show == true && !model.zoom.captionLines.isEmpty)
            || (project.keys?.show == true && !(model.cursor?.keys ?? []).isEmpty)
        // Until the waveform is read, keep the lane, so a movie with sound does not jump once it loads.
        audio = !model.waveform.loaded || model.waveform.hasAudio
        music = project.audio.music != nil
    }

    var displaysTop: CGFloat { TimelineView.effectsTop + effectsHeight + TimelineView.laneGap }
    var clipTop: CGFloat { displaysTop + (displays ? TimelineView.displayLaneHeight + 4 : 0) }
    var marksTop: CGFloat { clipTop + TimelineView.clipLaneHeight + 4 }
    var audioTop: CGFloat { marksTop + (marks ? TimelineView.marksLaneHeight + 4 : 0) }
    var musicTop: CGFloat { audio ? audioTop + TimelineView.audioLaneHeight + 4 : audioTop }
    /// The bottom of the last lane shown.
    var lanesBottom: CGFloat {
        if music { return musicTop + TimelineView.musicLaneHeight }
        return audio ? audioTop + TimelineView.audioLaneHeight : audioTop - 2
    }
    var totalHeight: CGFloat { lanesBottom + 16 }
}

private struct RulerView: View {
    let durationUs: Int64
    let scale: TimelineScale

    var body: some View {
        Canvas { context, size in
            let seconds = Double(durationUs) / 1_000_000
            // A label every 1, 2, 5, 10, 30 or 60 s, whichever keeps labels at least 70 pt apart.
            let step = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300].first { $0 * scale.pointsPerSecond >= 70 } ?? 600
            var at = 0.0
            while at <= seconds + 0.001 {
                let x = scale.x(Int64(at * 1_000_000))
                context.fill(Path(CGRect(x: x, y: size.height - 6, width: 1, height: 6)), with: .color(RecorderPalette.dim))
                let text = Text(verbatim: formatClock(Int64(at * 1_000_000), tenths: step < 1))
                    .font(.system(size: 10.5, weight: .medium).monospacedDigit())
                    .foregroundStyle(RecorderPalette.dim)
                // A label at either end of the strip leans inward instead of being cut in half.
                let half = context.resolve(text).measure(in: size).width / 2
                let anchor: UnitPoint = x - half < 0 ? .leading : (x + half > size.width ? .trailing : .center)
                context.draw(text, at: CGPoint(x: x, y: 8), anchor: anchor)
                at += step
            }
        }
    }
}

/// "01:05", or "01:05.4" when tenths matter.
/// While a segment is dragged: where it starts in the movie and how long it lasts, over the segment, so a move to a
/// time is exact without the inspector.
struct DragTimeTag: View {
    let project: EditProject
    let startUs: Int64
    let endUs: Int64

    var body: some View {
        let start = TimelineMap.outputTime(ofSource: startUs, in: project) ?? startUs
        Text(verbatim: "\(formatClock(start, tenths: true)) · \(String(format: "%.1f", Double(endUs - startUs) / 1_000_000)) s")
            .font(.system(size: 10, weight: .semibold).monospacedDigit())
            .foregroundStyle(.white)
            .padding(.horizontal, 5)
            .frame(height: 15)
            .background(Capsule().fill(Color.black.opacity(0.8)))
            .fixedSize()
            .offset(y: -18)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

func formatClock(_ us: Int64, tenths: Bool = false) -> String {
    let total = max(0, Double(us) / 1_000_000)
    let minutes = Int(total) / 60
    let seconds = Int(total) % 60
    if tenths {
        return String(format: "%02d:%02d.%d", minutes, seconds, Int((total * 10).rounded(.down)) % 10)
    }
    return String(format: "%02d:%02d", minutes, seconds)
}

/// A time range in words, "00:03.0 to 00:08.0", as the change banner says it (no dash between the two times).
func formatClockRange(_ fromUs: Int64, _ toUs: Int64) -> String {
    "\(formatClock(fromUs, tenths: true)) to \(formatClock(toUs, tenths: true))"
}

/// A source range as the edit plays it, the time the ruler shows ("00:00.5 to 00:03.0", or "Cut from the edit" when
/// none of it plays), and the range in the recording when the edit moved it (nil when the two read the same).
func editRange(_ project: EditProject, fromUs: Int64, toUs: Int64) -> (edit: String, recording: String?) {
    let source = formatClockRange(fromUs, toUs)
    let spans = TimelineMap.outputSpans(fromUs: fromUs, toUs: toUs, in: project)
    guard let first = spans.first, let last = spans.last else { return ("Cut from the edit", "\(source) in the recording") }
    let edit = formatClockRange(first.fromUs, last.toUs)
    return (edit, edit == source ? nil : "\(source) in the recording")
}

// MARK: - Clip lane

/// The clips; a drag across them selects a range (a band over the lane), and on release a popover asks what to do
/// with it (RangeActions.swift). A click still selects a clip, and a selected clip's edges still trim it.
private struct ClipLaneView: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale
    @State private var dragFrom: CGFloat?
    @State private var dragTo: CGFloat?

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(TimelineMap.placed(model.project), id: \.clip.id) { placed in
                ClipView(model: model, placed: placed, scale: scale)
            }
            if let band = bandRange {
                RangeBand(model: model, range: band, scale: scale, live: dragFrom != nil)
            }
        }
        .frame(height: TimelineView.clipLaneHeight, alignment: .topLeading)
        .gesture(DragGesture(minimumDistance: 4, coordinateSpace: .local)
            .onChanged { value in
                // The lane's own points are the timeline's: it sits at the strip's left edge.
                dragFrom = value.startLocation.x
                dragTo = value.location.x
                model.timelineRange = nil
            }
            .onEnded { value in
                defer { dragFrom = nil; dragTo = nil }
                let from = scale.us(min(value.startLocation.x, value.location.x))
                let to = scale.us(max(value.startLocation.x, value.location.x))
                model.selectRange(TimelineRange(fromUs: from, toUs: to))
            })
    }

    /// The band while dragging, else the selected range.
    private var bandRange: TimelineRange? {
        if let dragFrom, let dragTo {
            return TimelineRange(fromUs: scale.us(min(dragFrom, dragTo)), toUs: scale.us(max(dragFrom, dragTo)))
        }
        return model.timelineRange
    }
}

/// The dragged range over the frames lane; once the drag ends its popover lists the range actions.
private struct RangeBand: View {
    @Bindable var model: EditorModel
    let range: TimelineRange
    let scale: TimelineScale
    let live: Bool

    var body: some View {
        let presented = Binding(get: { !live && model.timelineRange != nil },
                                set: { if !$0 { model.timelineRange = nil } })
        RoundedRectangle(cornerRadius: 6, style: .continuous)
            .fill(Color.accentColor.opacity(0.22))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.accentColor, lineWidth: 2))
            .frame(width: max(2, scale.width(range.lengthUs)), height: TimelineView.clipLaneHeight)
            .allowsHitTesting(false)
            .popover(isPresented: presented, arrowEdge: .top) {
                RangeActionsView(model: model, range: range)
            }
            .accessibilityLabel("Selected range from \(formatClock(range.fromUs, tenths: true)) to \(formatClock(range.toUs, tenths: true))")
            .offset(x: scale.x(range.fromUs))
    }
}

private struct ClipView: View {
    @Bindable var model: EditorModel
    let placed: TimelineMap.Placed
    let scale: TimelineScale
    @State private var trimFrom: (Int64, Int64)?

    var body: some View {
        let clip = placed.clip
        let selected = model.selection == .clip(clip.id)
        // A 6 pt gap between clips, so a cut reads as a cut at rest.
        let width = max(6, scale.width(clip.outputDurationUs) - 6)
        FilmstripCanvas(filmstrip: model.filmstrip, clip: clip, width: width)
            .frame(width: width, height: TimelineView.clipLaneHeight)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(selected ? RecorderPalette.selected : Color.white.opacity(0.14), lineWidth: selected ? 2 : 1)
            }
            .overlay(alignment: .topLeading) {
                if clip.speed != 1 {
                    Text(verbatim: speedLabel(clip.speed))
                        .font(.system(size: 10.5, weight: .bold).monospacedDigit())
                        .padding(.horizontal, 5).padding(.vertical, 2)
                        .background(Capsule().fill(Color.black.opacity(0.65)))
                        .foregroundStyle(.white)
                        .padding(5)
                        .allowsHitTesting(false)
                }
            }
            .overlay(alignment: .leading) { trimHandle(leading: true, selected: selected) }
            .overlay(alignment: .trailing) { trimHandle(leading: false, selected: selected) }
            .contentShape(Rectangle())
            .onTapGesture {
                model.selection = .clip(clip.id)
                model.tab = .clip
            }
            .accessibilityElement()
            .accessibilityLabel("Clip \(placed.index + 1), \(formatClock(clip.outputDurationUs))")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("recorder.clip.\(placed.index)")
            .accessibilityAction {
                model.selection = .clip(clip.id)
                model.tab = .clip
            }
            // Last, so the hit area moves with the drawing (every clip's used to sit at the lane's start).
            .offset(x: scale.x(placed.outStartUs) + 3)
    }

    private func trimHandle(leading: Bool, selected: Bool) -> some View {
        // A selected clip's grips: 8 pt bars with a dark notch, so the edge reads as "drag here".
        RoundedRectangle(cornerRadius: 3)
            .fill(selected ? RecorderPalette.selected : Color.white.opacity(0.001))
            .overlay {
                if selected {
                    Capsule().fill(Color.black.opacity(0.55)).frame(width: 2, height: 18)
                }
            }
            .frame(width: selected ? 8 : 9)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1).onChanged { value in
                if trimFrom == nil { trimFrom = (placed.clip.fromUs, placed.clip.toUs); model.selection = .clip(placed.clip.id) }
                guard let (from, to) = trimFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000 * placed.clip.speed)
                if leading {
                    model.trimClip(placed.clip.id, fromUs: model.snapped(from + delta, excluding: placed.clip.id))
                } else {
                    model.trimClip(placed.clip.id, toUs: model.snapped(to + delta, excluding: placed.clip.id))
                }
            }.onEnded { _ in trimFrom = nil; model.endSnap() })
    }
}

func speedLabel(_ speed: Double) -> String {
    speed == speed.rounded() ? "\(Int(speed))×" : String(format: "%g×", speed)
}

/// The tiles of one clip, side by side at the lane's height, each the frame nearest its source time.
private struct FilmstripCanvas: View {
    let filmstrip: Filmstrip
    let clip: EditProject.Clip
    let width: CGFloat

    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(RecorderPalette.lane))
            let tileWidth = size.height * 16 / 10
            let count = max(1, Int((size.width / tileWidth).rounded(.up)))
            for index in 0..<count {
                let x = CGFloat(index) * tileWidth
                let fraction = Double(min(size.width, x + tileWidth / 2)) / Double(max(1, size.width))
                let sourceUs = clip.fromUs + Int64(Double(clip.sourceDurationUs) * fraction)
                guard let tile = filmstrip.tile(atSource: sourceUs) else { continue }
                let image = Image(decorative: tile.image, scale: 1)
                context.draw(image, in: CGRect(x: x, y: 0, width: tileWidth, height: size.height))
            }
        }
    }
}

// MARK: - Audio lane

/// The part an export writes (I and O): a light band over every lane with an edge at each end.
/// The part marked with I and O: a wash under the ruler and an edge to drag at each end. Its times, Export and the
/// clear button sit beside the clock (`PartPill`), clear of the playhead's split button.
private struct PartBand: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale
    let part: (fromUs: Int64, toUs: Int64)
    let layout: TimelineLayout

    var body: some View {
        let fromX = scale.x(part.fromUs), toX = scale.x(part.toUs)
        let top = TimelineView.rulerHeight
        let height = layout.lanesBottom - top + 2
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(Color.accentColor.opacity(0.14))
                .frame(width: max(2, toX - fromX), height: height)
                .offset(x: fromX, y: top)
                .allowsHitTesting(false)
            edge(at: fromX, top: top, height: height, leading: true)
            edge(at: toX, top: top, height: height, leading: false)
        }
        .coordinateSpace(name: "partBand")
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Export part from \(formatClock(part.fromUs, tenths: true)) to \(formatClock(part.toUs, tenths: true))")
    }

    private func edge(at x: CGFloat, top: CGFloat, height: CGFloat, leading: Bool) -> some View {
        Rectangle()
            .fill(Color.accentColor)
            .frame(width: 2, height: height)
            .frame(width: 10, height: height)
            .contentShape(Rectangle())
            .offset(x: x - 5, y: top)
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1, coordinateSpace: .named("partBand")).onChanged { value in
                let us = min(max(0, scale.us(value.location.x)), model.durationUs)
                if leading {
                    model.partInUs = min(us, part.toUs - TimelineMap.minimumClipUs)
                    model.partOutUs = part.toUs
                } else {
                    model.partOutUs = max(us, part.fromUs + TimelineMap.minimumClipUs)
                    model.partInUs = part.fromUs
                }
            })
            .instantTooltip(leading ? "Drag to move where the part starts" : "Drag to move where the part ends")
    }
}

/// The marks of the recording, where they play: markers (purple flags), spoken lines (blue) and a tick with its label
/// for each kept shortcut (white). Everything is mapped through the cuts and speeds; a cut mark is gone. Texts and
/// shapes are effect-lane items (EffectLanesView.swift).
private struct MarksLaneView: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale

    var body: some View {
        let project = model.project
        let captions = project.captions?.show == true ? model.zoom.captionLines : []
        let keys = project.keys?.show == true ? (model.cursor?.keys ?? []) : []

        let markers = model.markers
        Canvas { context, size in
            func bar(_ context: inout GraphicsContext, _ from: Int64, _ to: Int64, row: CGFloat, color: Color) {
                for span in TimelineMap.outputSpans(fromUs: from, toUs: to, in: project) {
                    let rect = CGRect(x: scale.x(span.fromUs), y: row, width: max(2, scale.width(span.toUs - span.fromUs)), height: 5)
                    context.fill(Path(roundedRect: rect, cornerRadius: 2.5), with: .color(color))
                }
            }
            for line in captions { bar(&context, line.fromUs, line.toUs, row: 9, color: Color(red: 0.36, green: 0.62, blue: 1).opacity(0.8)) }
            for marker in markers {
                guard let outUs = TimelineMap.outputTime(ofSource: marker.us, in: project) else { continue }
                let x = scale.x(outUs)
                let flag = Path { path in
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x + 7, y: 3.5))
                    path.addLine(to: CGPoint(x: x, y: 7))
                    path.closeSubpath()
                }
                let id = marker.id
                let selected = model.selection == .marker(id: id, atUs: marker.us)
                let marked = selected ? Color.white : Color(red: 0.75, green: 0.55, blue: 1)
                if selected { context.stroke(flag, with: .color(marked), lineWidth: 3) }
                context.fill(flag, with: .color(marked))
                context.fill(Path(CGRect(x: x - 0.75, y: 0, width: 1.5, height: size.height)), with: .color(marked))
                context.draw(Text(marker.label).font(.system(size: 9, weight: .semibold)).foregroundStyle(marked),
                             at: CGPoint(x: x + 9, y: 4), anchor: .leading)
            }
            for key in keys {
                let sourceUs = Int64(key.ms * 1000)
                guard let outUs = TimelineMap.outputTime(ofSource: sourceUs, in: project) else { continue }
                let x = scale.x(outUs)
                context.fill(Path(CGRect(x: x - 0.75, y: 0, width: 1.5, height: size.height)), with: .color(.white.opacity(0.85)))
                if let label = key.key {
                    context.draw(Text(label).font(.system(size: 9, weight: .semibold)).foregroundStyle(.white.opacity(0.85)),
                                 at: CGPoint(x: x + 3, y: size.height / 2), anchor: .leading)
                }
            }
        }
        .frame(height: TimelineView.marksLaneHeight)
        .contentShape(Rectangle())
        .onTapGesture { location in select(atX: location.x) }
        .instantTooltip("Markers (purple flags), review comments (yellow), caption lines (blue) and shortcuts (white lines). Click a marker or a comment to go to it.")
        .accessibilityElement(children: .contain)
        .accessibilityLabel(TimelineView.marksLabel(markers: markers.count, comments: model.reviewComments.count, captions: captions.count,
                                            shortcuts: keys.count))
        .overlay(alignment: .topLeading) {
            ZStack(alignment: .topLeading) {
                ForEach(model.reviewComments) { comment in
                    CommentMarker(model: model, comment: comment, scale: scale)
                }
                ForEach(model.project.markers ?? []) { marker in
                    EditMarkerFlag(model: model, marker: marker, scale: scale)
                }
            }
        }
    }

    /// A click on the lane: a marker within 6 pt puts the playhead on it; otherwise the playhead goes to the click.
    private func select(atX x: CGFloat) {
        let project = model.project
        for marker in model.markers {
            if let outUs = TimelineMap.outputTime(ofSource: marker.us, in: project), abs(scale.x(outUs) - x) <= 6 {
                let id = marker.id
                model.selectMarker(id: id, atUs: marker.us)
                return
            }
        }
        model.seek(scale.us(x))
    }
}

private struct AudioLaneView: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale

    var body: some View {
        let waveform = model.waveform
        let muted = !model.project.audio.include
        Canvas { context, size in
            guard waveform.hasAudio else { return }
            for placed in TimelineMap.placed(model.project) {
                let x0 = scale.x(placed.outStartUs) + 1.5
                let width = max(2, scale.width(placed.clip.outputDurationUs) - 3)
                context.fill(Path(roundedRect: CGRect(x: x0, y: 0, width: width, height: size.height), cornerRadius: 6),
                             with: .color(RecorderPalette.lane.opacity(0.75)))
                let bars = max(1, Int(width / 3))
                for bar in 0..<bars {
                    let a = Double(bar) / Double(bars), b = Double(bar + 1) / Double(bars)
                    let from = placed.clip.fromUs + Int64(Double(placed.clip.sourceDurationUs) * a)
                    let to = placed.clip.fromUs + Int64(Double(placed.clip.sourceDurationUs) * b)
                    let peak = CGFloat(waveform.peak(fromUs: from, toUs: to, durationUs: model.project.source.durationUs))
                    let level = min(1, peak * CGFloat(model.project.audio.volume))
                    let height = max(1, level * (size.height - 6))
                    let rect = CGRect(x: x0 + CGFloat(bar) * 3, y: (size.height - height) / 2, width: 2, height: height)
                    context.fill(Path(rect), with: .color(muted ? RecorderPalette.dim.opacity(0.4) : Color(red: 0.35, green: 0.82, blue: 0.55)))
                }
            }
        }
        .frame(height: TimelineView.audioLaneHeight)
        .instantTooltip("Sound (the waveform of the kept clips)")
        .accessibilityLabel(waveform.hasAudio ? "Audio waveform" : "No audio")
    }
}

/// The music under the movie as its volume over time: where it plays (all of the movie when it loops, else the file's
/// length from its start), its fades, and the dips under each spoken line, drawn from the same keyframes the export uses.
private struct MusicLaneView: View {
    let model: EditorModel
    let music: EditProject.Music
    let scale: TimelineScale
    @State private var fileUs: Int64?

    var body: some View {
        let missing = !FileManager.default.fileExists(atPath: music.file)
        let lengthUs = model.durationUs
        let playedUs = music.loop == false
            ? min(lengthUs, max(0, (fileUs ?? lengthUs) - Int64(music.startMs ?? 0) * 1000))
            : lengthUs
        let speech = MusicMix.speech(lines: model.zoom.captionLines, project: model.project)
        let frames = MusicMix.keyframes(music: music, speech: speech, lengthUs: playedUs, duck: .of(model.project))
        let tint = missing ? Color.red : Color(red: 0.55, green: 0.6, blue: 1)
        Canvas { context, size in
            let x0 = scale.x(0) + 1.5
            let x1 = scale.x(playedUs) - 1.5
            guard x1 > x0 else { return }
            context.fill(Path(roundedRect: CGRect(x: x0, y: 0, width: x1 - x0, height: size.height), cornerRadius: 4),
                         with: .color(tint.opacity(0.14)))
            guard !missing, music.volume > 0, let first = frames.first else { return }
            // Full height is the music's own level, so a dip under speech reads as a notch.
            let top = { (volume: Double) in size.height - 2 - CGFloat(volume / music.volume) * (size.height - 4) }
            var path = Path()
            path.move(to: CGPoint(x: scale.x(first.us), y: size.height))
            for frame in frames { path.addLine(to: CGPoint(x: scale.x(frame.us), y: top(frame.volume))) }
            path.addLine(to: CGPoint(x: scale.x(frames.last?.us ?? first.us), y: size.height))
            path.closeSubpath()
            context.fill(path, with: .color(tint.opacity(0.55)))
        }
        .frame(height: TimelineView.musicLaneHeight)
        .allowsHitTesting(true)
        .task(id: "\(music.file)|\(music.loop == false)") {
            guard music.loop == false, let duration = try? await AVURLAsset(url: URL(fileURLWithPath: music.file)).load(.duration),
                  duration.seconds.isFinite else { return }
            fileUs = Int64(duration.seconds * 1_000_000)
        }
        .instantTooltip(missing ? "The music file is missing: the export plays without music"
                        : "Music: \(URL(fileURLWithPath: music.file).lastPathComponent)\(speech.isEmpty ? "" : ", quieter under \(Plural.count(speech.count, "spoken part"))")")
        .accessibilityElement()
        .accessibilityLabel(missing ? "Music file missing" : "Music, \(speech.count) dips under speech")
    }
}

/// A review comment on the marks lane: a yellow bubble at its time (a bar along its range), dimmed once resolved. A
/// click goes there and opens its popover: the words, who wrote them, the page they came from, Resolve and Delete.
/// A marker set while editing, over the flag the lane draws: a click goes to it, its menu deletes it (the recording's
/// own markers cannot be deleted here).
private struct EditMarkerFlag: View {
    let model: EditorModel
    let marker: EditProject.Marker
    let scale: TimelineScale
    @State private var hovered = false

    var body: some View {
        if let out = TimelineMap.outputTime(ofSource: marker.atUs, in: model.project) {
            // The flag (7 pt) and its label as the lane draws them (the label 9 pt right of the line), the label laid
            // out unseen here: a click on either selects the marker.
            HStack(spacing: 2) {
                Color.clear.frame(width: 7)
                Text(verbatim: marker.label).font(.system(size: 9, weight: .semibold)).hidden()
            }
            .padding(.horizontal, 4)
            .frame(height: TimelineView.marksLaneHeight)
            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Color.white.opacity(hovered ? 0.12 : 0)))
            .contentShape(Rectangle())
            .onHover { inside in
                hovered = inside
                (inside ? NSCursor.pointingHand : NSCursor.arrow).set()
            }
            .onTapGesture { model.selectMarker(id: marker.id, atUs: marker.atUs) }
            .contextMenu {
                Button("Go to “\(marker.label)”") { model.seek(out) }
                Button("Delete Marker", role: .destructive) { model.deleteMarker(marker.id) }
            }
            .accessibilityElement()
            .accessibilityLabel("Marker \(marker.label) at \(formatClock(out, tenths: true))")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { model.selectMarker(id: marker.id, atUs: marker.atUs) }
            .accessibilityAction(named: "Delete Marker") { model.deleteMarker(marker.id) }
            .liveRow()
            .offset(x: scale.x(out) - 4)
        }
    }
}

private struct CommentMarker: View {
    @Bindable var model: EditorModel
    let comment: ReviewComment
    let scale: TimelineScale

    static let color = Color(red: 1, green: 0.8, blue: 0.2)

    var body: some View {
        let out = TimelineMap.outputTime(ofSource: comment.atUs, in: model.project)
        let end = comment.toUs.flatMap { TimelineMap.outputSpans(fromUs: comment.atUs, toUs: $0, in: model.project).last?.toUs }
        let tint = Self.color.opacity(comment.isResolved ? 0.4 : 1)
        if let out {
            let presented = Binding(get: { model.openComment == comment.id }, set: { if !$0 { model.openComment = nil } })
            HStack(spacing: 0) {
                Image(systemName: comment.isResolved ? "checkmark.bubble.fill" : "text.bubble.fill")
                    .font(.system(size: 10.5))
                    .foregroundStyle(tint)
                    .frame(width: 14, height: TimelineView.marksLaneHeight)
                if let end, end > out {
                    Capsule().fill(tint.opacity(0.55))
                        .frame(width: max(2, scale.width(end - out) - 14), height: 4)
                }
            }
            .contentShape(Rectangle())
            .onHover { inside in (inside ? NSCursor.pointingHand : NSCursor.arrow).set() }
            .onTapGesture { model.goToComment(comment) }
            .instantTooltip(comment.text.isEmpty ? "A comment" : comment.text)
            .accessibilityElement()
            .accessibilityLabel("Comment at \(formatClock(out, tenths: true)): \(comment.text)\(comment.isResolved ? ", resolved" : "")")
            .accessibilityAddTraits(.isButton)
            .accessibilityAction { model.goToComment(comment) }
            .liveRow(selected: model.openComment == comment.id)
            // After `.liveRow`, so the popover's buttons never take the marker's resting environment.
            .popover(isPresented: presented, arrowEdge: .bottom) {
                CommentPopover(model: model, comment: comment)
            }
            .offset(x: scale.x(out) - 7)
        }
    }
}

private struct CommentPopover: View {
    let model: EditorModel
    let comment: ReviewComment

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(verbatim: comment.text.isEmpty ? "(no words)" : comment.text)
                .font(.system(size: 13))
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 6) {
                if let author = comment.author { Text(verbatim: author) }
                Text(verbatim: comment.toUs.map { editRange(model.project, fromUs: comment.atUs, toUs: $0).edit }
                    ?? TimelineMap.outputTime(ofSource: comment.atUs, in: model.project).map { formatClock($0, tenths: true) }
                    ?? "Cut from the edit")
                    .monospacedDigit()
            }
            .font(.system(size: 11)).foregroundStyle(.secondary)
            HStack(spacing: 10) {
                if let link = comment.link, let url = URL(string: link) {
                    Button(comment.linkTitle) { NSWorkspace.shared.open(url) }
                        .buttonStyle(.genHoverPlain())
                        .instantTooltip(link)
                }
                Spacer(minLength: 12)
                Button(comment.isResolved ? "Reopen" : "Resolve") { model.resolveComment(comment.id, !comment.isResolved) }
                    .buttonStyle(.genHoverPlain())
                Button("Delete", role: .destructive) { model.deleteComment(comment.id) }
                    .buttonStyle(.genHoverPlain())
                    .foregroundStyle(.red)
            }
            .font(.system(size: 12, weight: .medium))
        }
        .padding(12)
        .frame(width: 280, alignment: .leading)
    }
}

/// Which display the proxy movie of a frames recording shows when (its display plan): one band per range with the
/// display's name. Right-click a band to show another display there; the range popover over the frames does the same
/// for any range. Either runs `tools recorder proxy --keep-plan --switch` and loads the new movie.
private struct DisplayLaneView: View {
    @Bindable var model: EditorModel
    let plan: DisplayPlan
    let scale: TimelineScale

    /// A colour per display, in the recording's order.
    static let tints: [Color] = [Color(red: 0.4, green: 0.72, blue: 1), Color(red: 0.95, green: 0.55, blue: 0.85),
                                 Color(red: 0.55, green: 0.85, blue: 0.6), Color(red: 1, green: 0.7, blue: 0.4)]

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(Array(plan.ranges.enumerated()), id: \.offset) { _, range in
                DisplayBand(model: model, plan: plan, range: range, scale: scale,
                            tint: Self.tints[(plan.displays.firstIndex { $0.id == range.displayId } ?? 0) % Self.tints.count])
            }
        }
        .frame(height: TimelineView.displayLaneHeight, alignment: .topLeading)
        .opacity(model.isSwitchingDisplay ? 0.5 : 1)
    }
}

private struct DisplayBand: View {
    @Bindable var model: EditorModel
    let plan: DisplayPlan
    let range: DisplayPlan.Range
    let scale: TimelineScale
    let tint: Color

    var body: some View {
        let spans = TimelineMap.outputSpans(fromUs: range.fromUs, toUs: range.toUs, in: model.project)
        if let first = spans.first, let last = spans.last {
            let width = max(3, scale.x(last.toUs) - scale.x(first.fromUs) - 2)
            let name = plan.name(of: range.displayId)
            RoundedRectangle(cornerRadius: 4, style: .continuous)
                .fill(tint.opacity(0.28))
                .overlay(RoundedRectangle(cornerRadius: 4, style: .continuous).strokeBorder(tint.opacity(0.6), lineWidth: 1))
                .overlay(alignment: .leading) {
                    if width > 50 {
                        Label(name, systemImage: "display")
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(tint)
                            .lineLimit(1)
                            .padding(.horizontal, 6)
                            .allowsHitTesting(false)
                    }
                }
                .frame(width: width, height: TimelineView.displayLaneHeight)
                .contentShape(Rectangle())
                .contextMenu {
                    ForEach(plan.displays.filter { $0.id != range.displayId }, id: \.id) { display in
                        Button("Show \(display.name) Here") {
                            model.switchDisplay(fromUs: range.fromUs, toUs: range.toUs, displayId: display.id)
                        }
                    }
                }
                .instantTooltip("\(name) from \(formatClock(first.fromUs, tenths: true)) to \(formatClock(last.toUs, tenths: true)): right-click to show another display here")
                .accessibilityElement()
                .accessibilityLabel("\(name), \(formatClock(first.fromUs, tenths: true)) to \(formatClock(last.toUs, tenths: true))")
                .accessibilityActions {
                    ForEach(plan.displays.filter { $0.id != range.displayId }, id: \.id) { display in
                        Button("Show \(display.name)") { model.switchDisplay(fromUs: range.fromUs, toUs: range.toUs, displayId: display.id) }
                    }
                }
                .liveRow()
                .offset(x: scale.x(first.fromUs) + 1)
        }
    }
}

extension TimelineView {
    /// What the marks lane holds, without the kinds it has none of: "Marks: 4 caption lines", not "0 markers, 0
    /// comments, 4 caption lines, 0 shortcuts".
    nonisolated static func marksLabel(markers: Int, comments: Int, captions: Int, shortcuts: Int) -> String {
        let parts = [(markers, "marker"), (comments, "comment"), (captions, "caption line"), (shortcuts, "shortcut")]
            .filter { $0.0 > 0 }.map { Plural.count($0.0, $0.1) }
        return parts.isEmpty ? "Marks: none" : "Marks: " + parts.joined(separator: ", ")
    }
}

// MARK: - Playhead

struct PlayheadView: View {
    let clock: PlayheadClock
    let scale: TimelineScale
    let model: EditorModel
    let layout: TimelineLayout

    var body: some View {
        let x = scale.x(clock.outUs)
        let canSplit = TimelineMap.canSplit(model.project, atOutput: clock.outUs)
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(RecorderPalette.playhead)
                .frame(width: 1.5, height: layout.lanesBottom - TimelineView.rulerHeight + 8)
                .offset(x: x - 0.75, y: TimelineView.rulerHeight - 4)
                .allowsHitTesting(false)
            // The knob draws 13 × 16 pt; its grip is 23 × 22 pt round it, so a press beside the knob still takes it.
            PlayheadKnob()
                .fill(RecorderPalette.playhead)
                .frame(width: 13, height: 16)
                .frame(width: PlayheadView.grip.width, height: PlayheadView.grip.height, alignment: .top)
                .contentShape(Rectangle())
                .offset(x: x - PlayheadView.grip.width / 2, y: TimelineView.rulerHeight - 10)
                .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("timeline")).onChanged { value in
                    model.player.pause()
                    model.seek(scale.us(value.location.x))
                })
                // VoiceOver moves it too: a swipe up or down steps one second, as the arrow keys step the time.
                .accessibilityElement()
                .accessibilityLabel("Playhead")
                .accessibilityValue(PlayheadView.spoken(clock.outUs, of: model.durationUs))
                .accessibilityAdjustableAction { direction in
                    model.player.pause()
                    switch direction {
                    case .increment: model.seek(min(model.durationUs, clock.outUs + 1_000_000))
                    case .decrement: model.seek(max(0, clock.outUs - 1_000_000))
                    @unknown default: break
                    }
                }
                .accessibilityIdentifier("recorder.playhead")
            // On the clip lane's top edge beside the playhead, where the cut lands; greyed at a clip edge.
            IconButton(systemName: "scissors", tooltip: canSplit ? "Split the clip at the playhead (S)" : "No cut here: the playhead is at a clip edge",
                       size: 11) {
                model.splitAtPlayhead()
            }
            .disabled(!canSplit)
            .opacity(canSplit ? 1 : 0.45)
            .frame(width: 24, height: 20)
            .background(Capsule().fill(Color(white: 0.24)))
            .overlay(Capsule().strokeBorder(Color.white.opacity(0.15), lineWidth: 1))
            .offset(x: min(x + 5, max(0, scale.x(model.durationUs) - 24)), y: layout.clipTop + 4)
            .accessibilityIdentifier("recorder.split")
        }
        .coordinateSpace(name: "timeline")
    }

    /// The knob's hit area: at least 22 pt each way.
    nonisolated static let grip = CGSize(width: 23, height: 22)

    /// "00:12.5 of 00:44.8", as the clock reads.
    nonisolated static func spoken(_ atUs: Int64, of durationUs: Int64) -> String {
        "\(formatClock(atUs, tenths: true)) of \(formatClock(durationUs, tenths: true))"
    }
}

private struct PlayheadKnob: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.addRoundedRect(in: CGRect(x: rect.minX, y: rect.minY, width: rect.width, height: rect.height * 0.62), cornerSize: CGSize(width: 3.5, height: 3.5))
        path.move(to: CGPoint(x: rect.minX + 1, y: rect.height * 0.55))
        path.addLine(to: CGPoint(x: rect.midX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.maxX - 1, y: rect.height * 0.55))
        path.closeSubpath()
        return path
    }
}
