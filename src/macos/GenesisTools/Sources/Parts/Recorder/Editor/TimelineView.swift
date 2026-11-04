import SwiftUI

/// The editor's colours, one dark palette like the reference editor: near-black lanes, the blue of a zoom, the red
/// playhead, the yellow of a selected clip.
enum RecorderPalette {
    static let window = Color(white: 0.105)
    static let panel = Color(white: 0.135)
    static let lane = Color(white: 0.17)
    static let hairline = Color.white.opacity(0.08)
    static let zoom = Color(red: 0.04, green: 0.45, blue: 0.98)
    static let playhead = Color(red: 0.98, green: 0.27, blue: 0.27)
    static let selected = Color(red: 1, green: 0.8, blue: 0.2)
    static let text = Color.white.opacity(0.88)
    static let dim = Color.white.opacity(0.5)
}

/// Output time and x position on the timeline, both ways.
struct TimelineScale {
    var pointsPerSecond: Double
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
    static let marksLaneHeight: CGFloat = 16
    static let laneGap: CGFloat = 8
    static var clipLaneTop: CGFloat { rulerHeight + 10 + zoomLaneHeight + laneGap }
    static var marksLaneTop: CGFloat { clipLaneTop + clipLaneHeight + 4 }
    static var audioLaneTop: CGFloat { marksLaneTop + marksLaneHeight + 4 }
    static var totalHeight: CGFloat { audioLaneTop + audioLaneHeight + 40 }

    private var scale: TimelineScale {
        let fit = Double(max(200, viewportWidth - 32)) / max(0.5, Double(model.durationUs) / 1_000_000)
        return TimelineScale(pointsPerSecond: model.pointsPerSecond > 0 ? model.pointsPerSecond : fit)
    }

    var body: some View {
        let scale = scale
        let contentWidth = max(viewportWidth, scale.x(model.durationUs) + scale.inset)
        ScrollView(.horizontal, showsIndicators: true) {
            ZStack(alignment: .topLeading) {
                RulerView(durationUs: model.durationUs, scale: scale)
                    .frame(width: contentWidth, height: Self.rulerHeight)
                    .contentShape(Rectangle())
                    .gesture(DragGesture(minimumDistance: 0).onChanged { value in model.seek(scale.us(value.location.x)) })
                ZoomLaneView(model: model, scale: scale, width: contentWidth)
                    .offset(y: Self.rulerHeight + 10)
                ClipLaneView(model: model, scale: scale)
                    .offset(y: Self.clipLaneTop)
                MarksLaneView(model: model, scale: scale)
                    .offset(y: Self.marksLaneTop)
                AudioLaneView(model: model, scale: scale)
                    .offset(y: Self.audioLaneTop)
                if let part = model.exportPart {
                    PartBand(fromX: scale.x(part.fromUs), toX: scale.x(part.toUs))
                }
                PlayheadView(clock: model.clock, scale: scale, model: model)
            }
            .frame(width: contentWidth, height: Self.totalHeight, alignment: .topLeading)
        }
        .background(RecorderPalette.window)
    }
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
                context.draw(text, at: CGPoint(x: x, y: 8), anchor: .center)
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
            .onTapGesture {
                model.selection = .zoom(zoom.id)
                model.tab = .zoom
            }
            .gesture(DragGesture(minimumDistance: 3).onChanged { value in
                if moveFrom == nil { moveFrom = (zoom.startUs, zoom.endUs); model.selection = .zoom(zoom.id) }
                guard let (start, end) = moveFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000)
                model.moveZoom(zoom.id, startUs: start + delta, endUs: end + delta)
            }.onEnded { _ in moveFrom = nil })
            .accessibilityElement()
            .accessibilityLabel("Zoom \(Int((zoom.scale * 100).rounded())) percent")
            .accessibilityAddTraits(.isButton)
            .accessibilityIdentifier("recorder.zoom.\(zoom.id)")
            // A tap gesture alone gives the element no AXPress, so VoiceOver and agents could not select a zoom.
            .accessibilityAction {
                model.selection = .zoom(zoom.id)
                model.tab = .zoom
            }
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
                    model.moveZoom(zoom.id, startUs: start + delta, endUs: end)
                } else {
                    model.moveZoom(zoom.id, startUs: start, endUs: end + delta)
                }
            }.onEnded { _ in moveFrom = nil })
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
        let width = max(6, scale.width(clip.outputDurationUs) - 3)
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
            .offset(x: scale.x(placed.outStartUs) + 1.5)
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
        RoundedRectangle(cornerRadius: 3)
            .fill(selected ? RecorderPalette.selected : Color.white.opacity(0.001))
            .frame(width: selected ? 7 : 9)
            .padding(.vertical, selected ? 0 : 0)
            .contentShape(Rectangle())
            .onHover { inside in
                if inside { NSCursor.resizeLeftRight.push() } else { NSCursor.pop() }
            }
            .gesture(DragGesture(minimumDistance: 1).onChanged { value in
                if trimFrom == nil { trimFrom = (placed.clip.fromUs, placed.clip.toUs); model.selection = .clip(placed.clip.id) }
                guard let (from, to) = trimFrom else { return }
                let delta = Int64(Double(value.translation.width) / scale.pointsPerSecond * 1_000_000 * placed.clip.speed)
                if leading {
                    model.trimClip(placed.clip.id, fromUs: from + delta)
                } else {
                    model.trimClip(placed.clip.id, toUs: to + delta)
                }
            }.onEnded { _ in trimFrom = nil })
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
private struct PartBand: View {
    let fromX: CGFloat
    let toX: CGFloat

    var body: some View {
        Rectangle()
            .fill(Color.accentColor.opacity(0.1))
            .overlay(alignment: .leading) { Rectangle().fill(Color.accentColor).frame(width: 2) }
            .overlay(alignment: .trailing) { Rectangle().fill(Color.accentColor).frame(width: 2) }
            .frame(width: max(2, toX - fromX), height: TimelineView.totalHeight - 30)
            .offset(x: fromX, y: 4)
            .allowsHitTesting(false)
            .accessibilityElement()
            .accessibilityLabel("Export part")
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
        let redactions = project.redactions ?? []
        let markers = model.markers
        Canvas { context, size in
            func bar(_ context: inout GraphicsContext, _ from: Int64, _ to: Int64, row: CGFloat, color: Color) {
                for span in TimelineMap.outputSpans(fromUs: from, toUs: to, in: project) {
                    let rect = CGRect(x: scale.x(span.fromUs), y: row, width: max(2, scale.width(span.toUs - span.fromUs)), height: 5)
                    context.fill(Path(roundedRect: rect, cornerRadius: 2.5), with: .color(color))
                }
            }
            for line in captions { bar(&context, line.fromUs, line.toUs, row: 1, color: Color(red: 0.36, green: 0.62, blue: 1).opacity(0.8)) }
            for redaction in redactions {
                bar(&context, redaction.startUs, redaction.endUs, row: 9, color: Color(red: 1, green: 0.62, blue: 0.2).opacity(0.85))
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
        .accessibilityElement()
        .accessibilityLabel("Marks: \(Plural.count(markers.count, "marker")), \(Plural.count(captions.count, "caption line")), \(Plural.count(redactions.count, "hidden part")), \(Plural.count(keys.count, "shortcut"))")
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
        .accessibilityLabel(waveform.hasAudio ? "Audio waveform" : "No audio")
    }
}

// MARK: - Playhead

private struct PlayheadView: View {
    let clock: PlayheadClock
    let scale: TimelineScale
    let model: EditorModel

    var body: some View {
        let x = scale.x(clock.outUs)
        let canSplit = TimelineMap.split(model.project, atOutput: clock.outUs) != nil
        ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(RecorderPalette.playhead)
                .frame(width: 1.5, height: TimelineView.totalHeight - 30)
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
            if canSplit {
                IconButton(systemName: "scissors", tooltip: "Split the clip at the playhead (S)", size: 13) {
                    model.splitAtPlayhead()
                }
                .frame(width: 30, height: 28)
                .background(RoundedRectangle(cornerRadius: 7).fill(Color(white: 0.24)))
                .offset(x: x - 15, y: TimelineView.clipLaneTop + TimelineView.clipLaneHeight + TimelineView.laneGap + TimelineView.audioLaneHeight + 6)
                .accessibilityIdentifier("recorder.split")
            }
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
