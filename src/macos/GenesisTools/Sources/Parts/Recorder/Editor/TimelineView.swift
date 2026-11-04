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

    static let rulerHeight: CGFloat = 26
    static let zoomLaneHeight: CGFloat = 34
    static let clipLaneHeight: CGFloat = 64
    static let audioLaneHeight: CGFloat = 30
    static let musicLaneHeight: CGFloat = 14
    static let marksLaneHeight: CGFloat = 16
    /// One row of the hidden-parts lane; overlapping parts take a row each, up to `hiddenRowsShown`.
    static let hiddenRowHeight: CGFloat = 16
    static let hiddenRowsShown = 3
    static let laneGap: CGFloat = 8
    static var clipLaneTop: CGFloat { rulerHeight + 10 + zoomLaneHeight + laneGap }

    /// Fitted, the whole edit fills the strip between the two insets, so nothing runs past the window's edge.
    private var fit: Double {
        Double(max(200, viewportWidth - 2 * TimelineScale().inset)) / max(0.5, Double(model.durationUs) / 1_000_000)
    }

    private var scale: TimelineScale {
        TimelineScale(pointsPerSecond: model.pointsPerSecond > 0 ? model.pointsPerSecond : fit)
    }

    var body: some View {
        let scale = scale
        let layout = TimelineLayout(model: model)
        let contentWidth = max(viewportWidth, scale.x(model.durationUs) + scale.inset)
        ScrollView(.horizontal, showsIndicators: true) {
            ZStack(alignment: .topLeading) {
                RulerView(durationUs: model.durationUs, scale: scale)
                    .frame(width: contentWidth, height: Self.rulerHeight)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { value in model.seek(scale.us(value.location.x)) })
                // Each lane is a named group for VoiceOver, so "Zooms, 3 items" says which lane the cursor is in.
                ZoomLaneView(model: model, scale: scale, width: contentWidth)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Zooms")
                    .offset(y: Self.rulerHeight + 10)
                ClipLaneView(model: model, scale: scale)
                    .accessibilityElement(children: .contain)
                    .accessibilityLabel("Clips")
                    .offset(y: Self.clipLaneTop)
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
                if layout.hiddenRows > 0 {
                    HiddenLaneView(model: model, scale: scale)
                        .accessibilityElement(children: .contain)
                        .accessibilityLabel("Hidden parts and spotlights")
                        .offset(y: layout.hiddenTop)
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

/// Where each lane sits, from what the edit has: a marks lane only with markers, captions, texts or shortcuts to show,
/// a hidden-parts lane with one row per overlap, the sound lane only for a movie with sound, and a music lane under it.
struct TimelineLayout: Equatable {
    var marks: Bool
    var hiddenRows: Int
    var audio: Bool
    var music: Bool

    @MainActor
    init(model: EditorModel) {
        let project = model.project
        marks = !model.markers.isEmpty || !(project.texts ?? []).isEmpty || !(project.shapes ?? []).isEmpty
            || (project.captions?.show == true && !model.zoom.captionLines.isEmpty)
            || (project.keys?.show == true && !(model.cursor?.keys ?? []).isEmpty)
        let rows = HiddenLaneView.rows(project.redactions ?? [])
        hiddenRows = (project.redactions ?? []).isEmpty ? 0 : min(TimelineView.hiddenRowsShown, (rows.values.max() ?? 0) + 1)
        // Until the waveform is read, keep the lane, so a movie with sound does not jump once it loads.
        audio = !model.waveform.loaded || model.waveform.hasAudio
        music = project.audio.music != nil
    }

    var marksTop: CGFloat { TimelineView.clipLaneTop + TimelineView.clipLaneHeight + 4 }
    var hiddenTop: CGFloat { marksTop + (marks ? TimelineView.marksLaneHeight + 2 : 0) }
    var hiddenHeight: CGFloat { hiddenRows == 0 ? 0 : CGFloat(hiddenRows) * (TimelineView.hiddenRowHeight + 2) - 2 }
    var audioTop: CGFloat { hiddenTop + (hiddenRows > 0 ? hiddenHeight + 4 : 0) }
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
func formatClock(_ us: Int64, tenths: Bool = false) -> String {
    let total = max(0, Double(us) / 1_000_000)
    let minutes = Int(total) / 60
    let seconds = Int(total) % 60
    if tenths {
        return String(format: "%02d:%02d.%d", minutes, seconds, Int((total * 10).rounded(.down)) % 10)
    }
    return String(format: "%02d:%02d", minutes, seconds)
}

/// A source range as the edit plays it, the time the ruler shows ("00:00.5 – 00:03.0", or "Cut from the edit" when
/// none of it plays), and the range in the recording when the edit moved it (nil when the two read the same).
func editRange(_ project: EditProject, fromUs: Int64, toUs: Int64) -> (edit: String, recording: String?) {
    let source = "\(formatClock(fromUs, tenths: true)) – \(formatClock(toUs, tenths: true))"
    let spans = TimelineMap.outputSpans(fromUs: fromUs, toUs: toUs, in: project)
    guard let first = spans.first, let last = spans.last else { return ("Cut from the edit", "\(source) in the recording") }
    let edit = "\(formatClock(first.fromUs, tenths: true)) – \(formatClock(last.toUs, tenths: true))"
    return (edit, edit == source ? nil : "\(source) in the recording")
}

// MARK: - Zoom lane

private struct ZoomLaneView: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale
    let width: CGFloat
    @State private var dragStart: CGFloat?
    @State private var dragNow: CGFloat?

    var body: some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(RecorderPalette.lane.opacity(0.7))
                .frame(width: scale.width(model.durationUs), height: TimelineView.zoomLaneHeight)
                .offset(x: scale.inset)
                .overlay(alignment: .center) {
                    if model.project.zooms.isEmpty && dragStart == nil {
                        Label("Click or drag to add zoom", systemImage: "plus")
                            .font(.system(size: 12, weight: .medium))
                            .foregroundStyle(RecorderPalette.dim)
                            .offset(x: scale.inset / 2)
                            .allowsHitTesting(false)
                    }
                }
                .contentShape(Rectangle())
                .gesture(addGesture)
            if let dragStart, let dragNow {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .fill(RecorderPalette.zoom.opacity(0.45))
                    .frame(width: abs(dragNow - dragStart), height: TimelineView.zoomLaneHeight)
                    .offset(x: min(dragStart, dragNow))
                    .allowsHitTesting(false)
            }
            ForEach(model.project.zooms) { zoom in
                ZoomSegment(model: model, zoom: zoom, scale: scale)
            }
        }
        .frame(width: width, height: TimelineView.zoomLaneHeight, alignment: .leading)
    }

    private var addGesture: some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                dragStart = value.startLocation.x + scale.inset
                dragNow = value.location.x + scale.inset
            }
            .onEnded { value in
                defer { dragStart = nil; dragNow = nil }
                let start = value.startLocation.x + scale.inset
                let end = value.location.x + scale.inset
                if abs(end - start) < 4 {
                    model.addZoom(atOutput: scale.us(start))
                } else {
                    let from = scale.us(min(start, end)), to = scale.us(max(start, end))
                    model.addZoom(atOutput: from, durationUs: max(500_000, to - from))
                }
            }
    }
}

private struct ZoomSegment: View {
    @Bindable var model: EditorModel
    let zoom: EditProject.Zoom
    let scale: TimelineScale
    @State private var moveFrom: (Int64, Int64)?

    private var outStart: Int64 { TimelineMap.outputTime(ofSource: zoom.startUs, in: model.project) ?? nearestOut(zoom.startUs) }
    private var outEnd: Int64 { TimelineMap.outputTime(ofSource: zoom.endUs, in: model.project) ?? nearestOut(zoom.endUs) }

    /// A zoom whose edge was cut away is drawn up to the nearest kept moment.
    private func nearestOut(_ sourceUs: Int64) -> Int64 {
        let placed = TimelineMap.placed(model.project)
        if let next = placed.first(where: { $0.clip.fromUs >= sourceUs }) { return next.outStartUs }
        return model.durationUs
    }

    var body: some View {
        let selected = model.selection == .zoom(zoom.id)
        let width = max(8, scale.x(outEnd) - scale.x(outStart))
        RoundedRectangle(cornerRadius: 7, style: .continuous)
            .fill(RecorderPalette.zoom.opacity(selected ? 1 : 0.82))
            // The zoom's motion: lighter ramps where it eases in and out.
            .overlay(alignment: .leading) { ramp(ms: zoom.easeInMs, total: width, leading: true) }
            .overlay(alignment: .trailing) { ramp(ms: zoom.easeOutMs, total: width, leading: false) }
            .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 7, style: .continuous)
                    .strokeBorder(Color.white.opacity(selected ? 0.9 : 0), lineWidth: 1.5)
            }
            .overlay {
                Text(verbatim: width > 70 ? "Zoom \(Int((zoom.scale * 100).rounded()))%" : "\(Int((zoom.scale * 100).rounded()))%")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.white)
                    .lineLimit(1)
                    .allowsHitTesting(false)
            }
            .overlay(alignment: .leading) { edgeHandle(leading: true) }
            .overlay(alignment: .trailing) { edgeHandle(leading: false) }
            .frame(width: width, height: TimelineView.zoomLaneHeight)
            .offset(x: scale.x(outStart))
            .contentShape(Rectangle())
            .onTapGesture { selectZoom() }
            .gesture(DragGesture(minimumDistance: 3).onChanged { value in
                if moveFrom == nil { moveFrom = (zoom.startUs, zoom.endUs); model.selection = .zoom(zoom.id) }
                guard let (start, end) = moveFrom else { return }
                let raw = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000)
                let delta = raw + model.snappedMove(start: start + raw, end: end + raw, excluding: zoom.id)
                model.moveZoom(zoom.id, startUs: start + delta, endUs: end + delta)
            }.onEnded { _ in moveFrom = nil; model.endSnap() })
            .accessibilityElement()
            .accessibilityLabel("Zoom \(Int((zoom.scale * 100).rounded())) percent")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("recorder.zoom.\(zoom.id)")
            // A tap gesture alone gives the element no AXPress, so VoiceOver and agents could not select a zoom.
            .accessibilityAction { selectZoom() }
    }

    /// Selects the zoom and, when the playhead is outside it, moves to its first fully zoomed frame, so the preview
    /// shows what the inspector changes.
    private func selectZoom() {
        model.selection = .zoom(zoom.id)
        model.tab = .zoom
        let now = TimelineMap.sourceTime(atOutput: model.clock.outUs, in: model.project)
        guard now < zoom.startUs || now >= zoom.endUs else { return }
        let settled = min(zoom.endUs - 1, zoom.startUs + Int64(zoom.easeInMs) * 1000)
        if let at = TimelineMap.outputTime(ofSource: settled, in: model.project) ?? TimelineMap.outputTime(ofSource: zoom.startUs, in: model.project) {
            model.seek(at)
        }
    }

    private func ramp(ms: Int, total: CGFloat, leading: Bool) -> some View {
        let width = min(total / 2, scale.width(Int64(ms) * 1000))
        return LinearGradient(colors: [Color.white.opacity(0.32), Color.white.opacity(0)],
                              startPoint: leading ? .leading : .trailing, endPoint: leading ? .trailing : .leading)
            .frame(width: max(0, width))
            .allowsHitTesting(false)
    }

    private func edgeHandle(leading: Bool) -> some View {
        Rectangle()
            .fill(Color.white.opacity(0.001))
            .frame(width: 8)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1).onChanged { value in
                if moveFrom == nil { moveFrom = (zoom.startUs, zoom.endUs) }
                guard let (start, end) = moveFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000)
                if leading {
                    model.moveZoom(zoom.id, startUs: model.snapped(start + delta, excluding: zoom.id), endUs: end)
                } else {
                    model.moveZoom(zoom.id, startUs: start, endUs: model.snapped(end + delta, excluding: zoom.id))
                }
            }.onEnded { _ in moveFrom = nil; model.endSnap() })
    }
}

// MARK: - Clip lane

private struct ClipLaneView: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale

    var body: some View {
        ZStack(alignment: .topLeading) {
            ForEach(TimelineMap.placed(model.project), id: \.clip.id) { placed in
                ClipView(model: model, placed: placed, scale: scale)
            }
        }
        .frame(height: TimelineView.clipLaneHeight, alignment: .topLeading)
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
            .offset(x: scale.x(placed.outStartUs) + 3)
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

/// What the looks put on the edit, where it plays: spoken lines (blue), hidden parts (orange) and a tick with its
/// label for each kept shortcut (white). Everything is mapped through the cuts and speeds; a cut mark is gone.
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
            for line in captions { bar(&context, line.fromUs, line.toUs, row: 2, color: Color(red: 0.36, green: 0.62, blue: 1).opacity(0.8)) }
            for note in project.texts ?? [] {
                bar(&context, note.startUs, note.endUs, row: 9, color: Color(red: 0.3, green: 0.85, blue: 0.5).opacity(0.85))
            }
            for shape in project.shapes ?? [] {
                bar(&context, shape.startUs, shape.endUs, row: 9, color: Color(red: 1, green: 0.45, blue: 0.35).opacity(0.85))
            }
            for marker in markers {
                guard let outUs = TimelineMap.outputTime(ofSource: marker.us, in: project) else { continue }
                let x = scale.x(outUs)
                let flag = Path { path in
                    path.move(to: CGPoint(x: x, y: 0))
                    path.addLine(to: CGPoint(x: x + 7, y: 3.5))
                    path.addLine(to: CGPoint(x: x, y: 7))
                    path.closeSubpath()
                }
                let marked = Color(red: 0.75, green: 0.55, blue: 1)
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
        .overlay(alignment: .topLeading) {
            // Each text and shape bar is its own segment: a click selects it, a drag moves it, an edge trims it.
            ZStack(alignment: .topLeading) {
                ForEach(project.texts ?? []) { note in
                    MarkSegment(model: model, scale: scale, id: note.id, startUs: note.startUs, endUs: note.endUs,
                                name: "Text “\(note.text)”", selected: model.selectedText == note.id,
                                select: { model.selectedText = note.id; model.selectedShape = nil; model.tab = .text },
                                move: { start, end in model.updateText(note.id) { $0.startUs = start; $0.endUs = end } })
                }
                ForEach(project.shapes ?? []) { shape in
                    MarkSegment(model: model, scale: scale, id: shape.id, startUs: shape.startUs, endUs: shape.endUs,
                                name: shape.kind.rawValue.capitalized, selected: model.selectedShape == shape.id,
                                select: { model.selectedShape = shape.id; model.selectedText = nil; model.tab = .text },
                                move: { start, end in model.updateShape(shape.id) { $0.startUs = start; $0.endUs = end } })
                }
            }
        }
        .contentShape(Rectangle())
        .onTapGesture { location in select(atX: location.x) }
        .instantTooltip("Markers (purple flags), caption lines (blue), texts (green), arrows and boxes (red) and shortcuts (white lines). Click a text or a shape to edit it, drag it to move it in time, a marker to go to it.")
        .accessibilityElement()
        .accessibilityLabel("Marks: \(Plural.count(markers.count, "marker")), \(Plural.count(captions.count, "caption line")), \(Plural.count((project.texts ?? []).count, "text")), \(Plural.count((project.shapes ?? []).count, "shape")), \(Plural.count(keys.count, "shortcut"))")
    }

    /// A click on the lane: a marker within 6 pt puts the playhead on it; otherwise the arrow, box or text playing
    /// there is selected on the Text tab and the playhead goes to the click.
    private func select(atX x: CGFloat) {
        let project = model.project
        for marker in model.markers {
            if let outUs = TimelineMap.outputTime(ofSource: marker.us, in: project), abs(scale.x(outUs) - x) <= 6 {
                model.seek(outUs)
                return
            }
        }
        let outUs = scale.us(x)
        let sourceUs = TimelineMap.sourceTime(atOutput: outUs, in: project)
        if let shape = (project.shapes ?? []).last(where: { sourceUs >= $0.startUs && sourceUs < $0.endUs }) {
            model.selectedShape = shape.id
            model.tab = .text
        } else if let note = (project.texts ?? []).last(where: { sourceUs >= $0.startUs && sourceUs < $0.endUs }) {
            model.selectedText = note.id
            model.tab = .text
        }
        model.seek(outUs)
    }
}

/// A text or a shape on the marks lane, over the bar the lane draws: a click selects it on the Annotate tab, a drag
/// moves it in time with snapping, an edge trims it. The selected one has a white outline.
private struct MarkSegment: View {
    let model: EditorModel
    let scale: TimelineScale
    let id: String
    let startUs: Int64
    let endUs: Int64
    let name: String
    let selected: Bool
    let select: () -> Void
    let move: (Int64, Int64) -> Void
    @State private var moveFrom: (Int64, Int64)?

    private static let top: CGFloat = 7
    private static let height: CGFloat = 9

    var body: some View {
        let spans = TimelineMap.outputSpans(fromUs: startUs, toUs: endUs, in: model.project)
        if let first = spans.first, let last = spans.last {
            let width = max(6, scale.x(last.toUs) - scale.x(first.fromUs))
            RoundedRectangle(cornerRadius: 3, style: .continuous)
                .fill(Color.white.opacity(0.001))
                .overlay {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .strokeBorder(Color.white.opacity(selected ? 0.95 : 0), lineWidth: 1.25)
                }
                .overlay(alignment: .leading) { edgeHandle(leading: true, width: min(6, width / 3)) }
                .overlay(alignment: .trailing) { edgeHandle(leading: false, width: min(6, width / 3)) }
                .frame(width: width, height: Self.height)
                .contentShape(Rectangle())
                .onTapGesture { select() }
                .gesture(DragGesture(minimumDistance: 3).onChanged { value in
                    if moveFrom == nil { moveFrom = (startUs, endUs); select() }
                    guard let (start, end) = moveFrom else { return }
                    let raw = shift(value.translation.width, start: start, end: end)
                    let delta = raw + model.snappedMove(start: start + raw, end: end + raw, excluding: id)
                    let length = end - start
                    let moved = min(max(0, start + delta), model.project.source.durationUs - length)
                    move(moved, moved + length)
                }.onEnded { _ in moveFrom = nil; model.endSnap() })
                .instantTooltip("\(name): drag to move, drag an edge to trim")
                .offset(x: scale.x(first.fromUs), y: Self.top)
                .accessibilityHidden(true)
                .liveRow(selected: selected)
                // Texts and shapes share one row: the selected one is on top, so a drag where two overlap moves it.
                .zIndex(selected ? 1 : 0)
        }
    }

    /// The source shift of a drag, kept inside the recording.
    private func shift(_ points: CGFloat, start: Int64, end: Int64) -> Int64 {
        let delta = Int64(Double(points) / scale.pointsPerSecond * 1_000_000)
        return min(max(delta, -start), model.project.source.durationUs - (end - start) - start)
    }

    private func edgeHandle(leading: Bool, width: CGFloat) -> some View {
        Rectangle()
            .fill(Color.white.opacity(0.001))
            .frame(width: width)
            .contentShape(Rectangle())
            .onHover { inside in (inside ? NSCursor.resizeLeftRight : NSCursor.arrow).set() }
            .gesture(DragGesture(minimumDistance: 1).onChanged { value in
                if moveFrom == nil { moveFrom = (startUs, endUs); select() }
                guard let (start, end) = moveFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000)
                let edge = model.snapped(leading ? start + delta : end + delta, excluding: id)
                if leading {
                    move(max(0, min(edge, end - 100_000)), end)
                } else {
                    move(start, max(start + 100_000, edge))
                }
            }.onEnded { _ in moveFrom = nil; model.endSnap() })
    }
}

/// The hidden parts as segments, like the zooms: a click selects one in the Hide tab, a drag moves it, an edge trims it.
private struct HiddenLaneView: View {
    @Bindable var model: EditorModel
    let scale: TimelineScale
    @State private var listingOverflow = false

    var body: some View {
        let rows = Self.rows(model.project.redactions ?? [])
        let height = TimelineView.hiddenRowHeight
        // A row per overlap, each tall enough for its label; past the last row shown, parts share that row.
        ZStack(alignment: .topLeading) {
            ForEach(model.project.redactions ?? []) { redaction in
                // A part past the last row shares that row: it shows only once picked from the +N chip's list, so a
                // click or a drag never lands on whichever was drawn last and the labels never pile up.
                let stacked = (rows[redaction.id] ?? 0) >= TimelineView.hiddenRowsShown && model.selectedRedaction != redaction.id
                HiddenSegment(model: model, redaction: redaction, scale: scale, height: height)
                    .opacity(stacked ? 0 : 1)
                    .allowsHitTesting(!stacked)
                    .accessibilityHidden(stacked)
                    .zIndex(model.selectedRedaction == redaction.id ? 0.5 : 0)
                    .offset(y: CGFloat(min(rows[redaction.id] ?? 0, TimelineView.hiddenRowsShown - 1)) * (height + 2))
            }
            if let overflow = Self.overflow(model.project.redactions ?? [], rows: rows) {
                Button { listingOverflow = true } label: {
                    Text(verbatim: "+\(overflow.count)")
                        .font(.system(size: 9.5, weight: .bold).monospacedDigit())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 4)
                        .frame(height: height - 4)
                        .background(Capsule().fill(Color.black.opacity(0.75)))
                        .overlay(Capsule().strokeBorder(Color.white.opacity(0.35), lineWidth: 0.5))
                        .contentShape(Capsule())
                }
                .buttonStyle(.genHoverPlain())
                .instantTooltip("\(Plural.count(overflow.count, "more hidden part")) overlap this row: click to pick one")
                .accessibilityLabel("\(Plural.count(overflow.count, "more hidden part")) not shown in their own row")
                .accessibilityHint("Lists them; choose one to select it")
                .popover(isPresented: $listingOverflow, arrowEdge: .bottom) {
                    OverflowList(model: model, parts: (model.project.redactions ?? []).filter { (rows[$0.id] ?? 0) >= TimelineView.hiddenRowsShown }) {
                        listingOverflow = false
                    }
                }
                .offset(x: max(0, scale.x(overflow.startUs) - 2), y: CGFloat(TimelineView.hiddenRowsShown - 1) * (height + 2) + 2)
                .zIndex(1)
            }
        }
    }

    /// The parts under the +N chip, in time order: a click selects one, opens the Hide tab and moves the playhead there.
    private struct OverflowList: View {
        let model: EditorModel
        let parts: [EditProject.Redaction]
        let done: () -> Void

        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: Plural.count(parts.count, "more hidden part"))
                    .font(.system(size: 11, weight: .semibold)).foregroundStyle(.secondary)
                    .padding(.horizontal, 8).padding(.bottom, 2)
                ForEach(parts.sorted { $0.startUs < $1.startUs }) { part in
                    HStack(spacing: 8) {
                        Image(systemName: part.style == .spotlight ? "light.max" : "eye.slash").frame(width: 14)
                        Text(verbatim: part.label ?? (part.style == .spotlight ? "Spotlight" : part.style.rawValue.capitalized))
                            .lineLimit(1)
                        Spacer(minLength: 12)
                        Text(verbatim: formatClock(TimelineMap.outputTime(ofSource: part.startUs, in: model.project) ?? part.startUs))
                            .font(.system(size: 11.5).monospacedDigit()).foregroundStyle(.secondary)
                    }
                    .font(.system(size: 12.5))
                    .padding(.horizontal, 8).frame(height: 24)
                    .frame(minWidth: 200)
                    .rowButton(cornerRadius: 5) {
                        model.selectedRedaction = part.id
                        model.tab = .hide
                        if let out = TimelineMap.outputTime(ofSource: part.startUs, in: model.project) { model.seek(out) }
                        done()
                    }
                }
            }
            .padding(8)
        }
    }

    /// The parts past the last row shown (they share that row): how many, and where the first starts.
    static func overflow(_ list: [EditProject.Redaction], rows: [String: Int]) -> (count: Int, startUs: Int64)? {
        let hidden = list.filter { (rows[$0.id] ?? 0) >= TimelineView.hiddenRowsShown }
        guard let first = hidden.map(\.startUs).min() else { return nil }
        return (hidden.count, first)
    }

    /// A row per hidden part: the first row whose last part ended before this one starts.
    static func rows(_ list: [EditProject.Redaction]) -> [String: Int] {
        var ends: [Int64] = []
        var rows: [String: Int] = [:]
        for redaction in list.sorted(by: { $0.startUs < $1.startUs }) {
            if let row = ends.firstIndex(where: { $0 <= redaction.startUs }) {
                ends[row] = redaction.endUs
                rows[redaction.id] = row
            } else {
                ends.append(redaction.endUs)
                rows[redaction.id] = ends.count - 1
            }
        }
        return rows
    }
}

private struct HiddenSegment: View {
    @Bindable var model: EditorModel
    let redaction: EditProject.Redaction
    let scale: TimelineScale
    let height: CGFloat
    @State private var moveFrom: (Int64, Int64)?

    private static let color = Color(red: 1, green: 0.62, blue: 0.2)
    /// A spotlight lights, it does not hide: a pale yellow segment, not the blur's orange.
    private static let spotlightColor = Color(red: 1, green: 0.88, blue: 0.45)

    var body: some View {
        let spans = TimelineMap.outputSpans(fromUs: redaction.startUs, toUs: redaction.endUs, in: model.project)
        if let first = spans.first, let last = spans.last {
            let selected = model.selectedRedaction == redaction.id
            let width = max(8, scale.x(last.toUs) - scale.x(first.fromUs))
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill((redaction.style == .spotlight ? Self.spotlightColor : Self.color).opacity(selected ? 0.95 : 0.7))
                .overlay {
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .strokeBorder(Color.white.opacity(selected ? 0.9 : 0), lineWidth: 1.5)
                }
                .overlay {
                    if width > 46 {
                        Text(verbatim: redaction.label ?? redaction.style.rawValue.capitalized)
                            .font(.system(size: 10.5, weight: .semibold))
                            .foregroundStyle(Color.black.opacity(0.75))
                            .lineLimit(1)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(alignment: .leading) { edgeHandle(leading: true, width: min(7, width / 3)) }
                .overlay(alignment: .trailing) { edgeHandle(leading: false, width: min(7, width / 3)) }
                .frame(width: width, height: height)
                .offset(x: scale.x(first.fromUs))
                .contentShape(Rectangle())
                .onTapGesture { select() }
                .gesture(DragGesture(minimumDistance: 3).onChanged { value in
                    if moveFrom == nil { moveFrom = (redaction.startUs, redaction.endUs); select() }
                    guard let (start, end) = moveFrom else { return }
                    let raw = shift(value.translation.width, start: start)
                    let delta = raw + model.snappedMove(start: start + raw, end: end + raw, excluding: redaction.id)
                    model.updateRedaction(redaction.id) {
                        $0.startUs = start + delta
                        $0.endUs = end + delta
                    }
                }.onEnded { _ in moveFrom = nil; model.endSnap() })
                .instantTooltip("\(redaction.label.map { "\($0) (\(redaction.style.rawValue))" } ?? redaction.style.rawValue.capitalized): drag to move, drag an edge to trim")
                .accessibilityElement()
                .accessibilityLabel("\(redaction.style == .spotlight ? "Spotlight" : "Hidden part, \(redaction.style.rawValue)"), \(editRange(model.project, fromUs: redaction.startUs, toUs: redaction.endUs).edit)")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("recorder.hidden.\(redaction.id)")
                .accessibilityAction { select() }
                .liveRow(selected: selected)
        }
    }

    private func select() {
        model.selectedRedaction = redaction.id
        model.tab = .hide
    }

    /// The source shift of a drag, kept inside the recording.
    private func shift(_ points: CGFloat, start: Int64) -> Int64 {
        let delta = Int64(Double(points) / scale.pointsPerSecond * 1_000_000)
        let length = (moveFrom?.1 ?? redaction.endUs) - start
        return min(max(delta, -start), model.project.source.durationUs - length - start)
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
                if moveFrom == nil { moveFrom = (redaction.startUs, redaction.endUs); select() }
                guard let (start, end) = moveFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000)
                let edge = model.snapped(leading ? start + delta : end + delta, excluding: redaction.id)
                model.updateRedaction(redaction.id) {
                    if leading {
                        $0.startUs = max(0, min(edge, end - 100_000))
                    } else {
                        $0.endUs = max(start + 100_000, edge)
                    }
                }
            }.onEnded { _ in moveFrom = nil; model.endSnap() })
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
        let frames = MusicMix.keyframes(music: music, speech: speech, lengthUs: playedUs)
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

// MARK: - Playhead

private struct PlayheadView: View {
    let clock: PlayheadClock
    let scale: TimelineScale
    let model: EditorModel
    let layout: TimelineLayout

    var body: some View {
        let x = scale.x(clock.outUs)
        let canSplit = TimelineMap.split(model.project, atOutput: clock.outUs) != nil
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(RecorderPalette.playhead)
                .frame(width: 1.5, height: layout.lanesBottom - TimelineView.rulerHeight + 8)
                .offset(x: x - 0.75, y: TimelineView.rulerHeight - 4)
                .allowsHitTesting(false)
            PlayheadKnob()
                .fill(RecorderPalette.playhead)
                .frame(width: 13, height: 16)
                .offset(x: x - 6.5, y: TimelineView.rulerHeight - 10)
                .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("timeline")).onChanged { value in
                    model.player.pause()
                    model.seek(scale.us(value.location.x))
                })
                .accessibilityLabel("Playhead at \(formatClock(clock.outUs, tenths: true))")
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
            .offset(x: min(x + 5, max(0, scale.x(model.durationUs) - 24)), y: TimelineView.clipLaneTop + 4)
            .accessibilityIdentifier("recorder.split")
        }
        .coordinateSpace(name: "timeline")
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
