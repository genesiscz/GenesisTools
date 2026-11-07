import Foundation

/// The mapping from output time (what plays) to source time (the movie), so the window, the renderer and the tests
/// read the clips the same way. The edits that change the clips (split, cut, speed, trim, delete) are the recorder
/// service's ops (src/utils/recording-editor/project.ts and item-ops.ts); the window only sends them.
enum TimelineMap {
    struct Placed: Equatable {
        var clip: EditProject.Clip
        var index: Int
        var outStartUs: Int64
        var outEndUs: Int64 { outStartUs + clip.outputDurationUs }
    }

    /// The output stretches that play the source range [fromUs, toUs): one per kept clip it overlaps, at the clip's
    /// speed. A range that was cut away plays nowhere.
    static func outputSpans(fromUs: Int64, toUs: Int64, in project: EditProject) -> [(fromUs: Int64, toUs: Int64)] {
        placed(project).compactMap { placed in
            let start = max(fromUs, placed.clip.fromUs)
            let end = min(toUs, placed.clip.toUs)
            guard end > start else { return nil }
            let out = { (source: Int64) in placed.outStartUs + Int64(Double(source - placed.clip.fromUs) / placed.clip.speed) }
            return (out(start), out(end))
        }
    }

    static func placed(_ project: EditProject) -> [Placed] {
        var start: Int64 = 0
        return project.clips.enumerated().map { index, clip in
            defer { start += clip.outputDurationUs }
            return Placed(clip: clip, index: index, outStartUs: start)
        }
    }

    /// The clip playing at an output time; the end of the timeline belongs to the last clip.
    static func clip(atOutput outUs: Int64, in project: EditProject) -> Placed? {
        let list = placed(project)
        return list.first { outUs >= $0.outStartUs && outUs < $0.outEndUs } ?? list.last.flatMap { outUs >= $0.outEndUs ? $0 : nil }
    }

    static func sourceTime(atOutput outUs: Int64, in project: EditProject) -> Int64 {
        guard let placed = clip(atOutput: outUs, in: project) else { return 0 }
        let into = Double(min(max(0, outUs - placed.outStartUs), placed.clip.outputDurationUs)) * placed.clip.speed
        return min(placed.clip.toUs, placed.clip.fromUs + Int64(into.rounded()))
    }

    /// The output time of a source time, or nil when that moment was cut.
    static func outputTime(ofSource sourceUs: Int64, in project: EditProject) -> Int64? {
        for placed in placed(project) where sourceUs >= placed.clip.fromUs && sourceUs <= placed.clip.toUs {
            return placed.outStartUs + Int64((Double(sourceUs - placed.clip.fromUs) / placed.clip.speed).rounded())
        }
        return nil
    }

    /// Convert a horizontal timeline move to source time through the kept clips and their speeds.
    static func sourceShift(outputDeltaUs: Int64, atSource sourceUs: Int64, in project: EditProject) -> Int64 {
        guard let output = outputTime(ofSource: sourceUs, in: project) else { return 0 }
        return sourceTime(atOutput: output + outputDeltaUs, in: project) - sourceUs
    }

    /// The edit cut down to what plays from `fromOut` to `toOut` (output microseconds): each clip's overlap with the
    /// range, at its speed. For exporting a part; nil when nothing plays there.
    static func part(_ project: EditProject, fromOut: Int64, toOut: Int64) -> EditProject? {
        var clips: [EditProject.Clip] = []
        for placed in placed(project) {
            let start = max(fromOut, placed.outStartUs), end = min(toOut, placed.outEndUs)
            guard end - start >= minimumClipUs else { continue }
            var clip = placed.clip
            clip.fromUs = placed.clip.fromUs + Int64((Double(start - placed.outStartUs) * placed.clip.speed).rounded())
            clip.toUs = min(placed.clip.toUs, placed.clip.fromUs + Int64((Double(end - placed.outStartUs) * placed.clip.speed).rounded()))
            clips.append(clip)
        }
        guard !clips.isEmpty else { return nil }
        var next = project
        next.clips = clips
        return next
    }

    /// The shortest clip a split or trim leaves: one frame at 60 fps.
    static let minimumClipUs: Int64 = 16_667

    /// Whether a split at `outUs` would leave a frame on each side (the scissors button and S): the service splits.
    static func canSplit(_ project: EditProject, atOutput outUs: Int64) -> Bool {
        guard let placed = clip(atOutput: outUs, in: project) else { return false }
        let sourceUs = sourceTime(atOutput: outUs, in: project)
        return sourceUs - placed.clip.fromUs >= minimumClipUs && placed.clip.toUs - sourceUs >= minimumClipUs
    }

    /// The target closest to `us` within `toleranceUs`, or nil when none is that close (the drag goes where the
    /// pointer is).
    static func snap(_ us: Int64, to targets: [Int64], toleranceUs: Int64) -> Int64? {
        let nearest = targets.min { abs($0 - us) < abs($1 - us) }
        guard let nearest, abs(nearest - us) <= toleranceUs else { return nil }
        return nearest
    }

    /// Which side of the playhead a trim keeps: `[` keeps what follows it, `]` what came before.
    enum TrimSide { case start, end }
}

/// How far the view is zoomed in at a source time: the zoom's scale reached over `easeInMs` with an ease-out
/// curve, held, then released over `easeOutMs`. A focus point is kept far enough from the frame's edge that the
/// zoomed view never shows outside the movie.
enum ZoomCurve {
    struct View: Equatable {
        /// 1 is the whole frame.
        var scale: Double
        /// The centre of the shown rectangle, 0...1 from the top left.
        var centerX: Double
        var centerY: Double

        static let whole = View(scale: 1, centerX: 0.5, centerY: 0.5)

        /// The shown part of the frame, 0...1 from the top left.
        var rect: CGRect {
            let side = 1 / max(1, scale)
            return CGRect(x: centerX - side / 2, y: centerY - side / 2, width: side, height: side)
        }
    }

    /// Two zooms that touch, overlap, or leave less room between them than one zoom out and the next zoom in take,
    /// are linked: the view glides from the first zoom's view to the second's and never returns to the whole frame in
    /// between. Before 2026-11-07 the first zoom snapped out and the second snapped in again, with one frame of the
    /// whole frame between them, which read as the picture blinking (two touching zooms at 5.30 s of a 22:19 recording).
    static func linked(_ first: EditProject.Zoom, _ second: EditProject.Zoom) -> Bool {
        second.startUs > first.startUs && second.startUs - first.endUs < Int64(first.easeOutMs + second.easeInMs) * 1000
    }

    /// The picture's view: the zooms inside the movie (R5 4: a canvas zoom is `canvasView`'s, never this one's).
    static func view(atSource sourceUs: Int64, zooms: [EditProject.Zoom], cursor: CursorTrack?) -> View {
        curve(atSource: sourceUs, zooms: zooms.filter { $0.target != .canvas }, cursor: cursor)
    }

    // R5 4 canvas zoom
    /// The whole framed canvas's view: the canvas zooms, eased the same way, focused where they were placed (0...1 of
    /// the canvas; a canvas zoom does not follow the cursor, which moves inside the picture).
    static func canvasView(atSource sourceUs: Int64, zooms: [EditProject.Zoom]) -> View {
        curve(atSource: sourceUs, zooms: zooms.filter { $0.target == .canvas }, cursor: nil)
    }

    private static func curve(atSource sourceUs: Int64, zooms: [EditProject.Zoom], cursor: CursorTrack?) -> View {
        let ordered = zooms.sorted { $0.startUs < $1.startUs }
        for (first, second) in zip(ordered, ordered.dropFirst()) where linked(first, second) {
            // The glide runs from where the first zoom would start to leave to where the second would have arrived.
            let start = max(first.startUs + Int64(first.easeInMs) * 1000, first.endUs - Int64(first.easeOutMs) * 1000)
            let end = min(second.endUs - Int64(second.easeOutMs) * 1000, second.startUs + Int64(second.easeInMs) * 1000)
            guard end > start, sourceUs >= start, sourceUs < end else { continue }
            let t = Double(sourceUs - start) / Double(end - start)
            let progress = t * t * (3 - 2 * t)
            let from = shown(first, amount: 1, atSource: sourceUs, cursor: cursor)
            let to = shown(second, amount: 1, atSource: sourceUs, cursor: cursor)
            return View(scale: from.scale + (to.scale - from.scale) * progress,
                        centerX: from.centerX + (to.centerX - from.centerX) * progress,
                        centerY: from.centerY + (to.centerY - from.centerY) * progress)
        }
        guard let index = ordered.lastIndex(where: { sourceUs >= $0.startUs && sourceUs < $0.endUs }) else { return .whole }
        let zoom = ordered[index]
        let linkedIn = index > 0 && linked(ordered[index - 1], zoom)
        let linkedOut = index + 1 < ordered.count && linked(zoom, ordered[index + 1])
        let into = Double(sourceUs - zoom.startUs) / 1000
        let left = Double(zoom.endUs - sourceUs) / 1000
        let inProgress = linkedIn || zoom.easeInMs <= 0 ? 1 : min(1, into / Double(zoom.easeInMs))
        let outProgress = linkedOut || zoom.easeOutMs <= 0 ? 1 : min(1, left / Double(zoom.easeOutMs))
        // In: fast, then a soft landing on the zoomed view. Out: the mirror, leaving fast and landing softly on the
        // whole frame. `easeOut(outProgress)` held the zoom until its last few milliseconds and then snapped out.
        let amount = min(easeOut(inProgress), 1 - easeOut(1 - outProgress))
        return shown(zoom, amount: amount, atSource: sourceUs, cursor: cursor)
    }

    /// The view of one zoom, `amount` of the way from the whole frame to its full scale and focus.
    private static func shown(_ zoom: EditProject.Zoom, amount: Double, atSource sourceUs: Int64, cursor: CursorTrack?) -> View {
        let scale = 1 + (zoom.scale - 1) * amount
        var focus = (x: zoom.focusX, y: zoom.focusY)
        // ±600 ms: the view glides after a quick move (about a tenth of the frame per 100 ms at most) instead of
        // jumping with it.
        if zoom.mode == .follow, let point = cursor?.averagedPoint(atMs: Double(sourceUs) / 1000, halfMs: 600) {
            focus = point
        }
        let half = 0.5 / scale
        // Between the whole frame (amount 0) and the focus (amount 1), so the view glides toward its target.
        let x = 0.5 + (min(max(focus.x, half), 1 - half) - 0.5) * amount
        let y = 0.5 + (min(max(focus.y, half), 1 - half) - 0.5) * amount
        return View(scale: scale, centerX: x, centerY: y)
    }

    /// Cubic bezier (0.16, 1, 0.3, 1), the curve screen editors use for zooms: fast in, long soft landing.
    static func easeOut(_ t: Double) -> Double {
        let t = min(1, max(0, t))
        // Solve x(u) = t for the curve's parameter with Newton steps, then read y(u).
        var u = t
        for _ in 0..<6 {
            let x = bezier(u, 0.16, 0.3) - t
            let dx = bezierDerivative(u, 0.16, 0.3)
            guard abs(dx) > 1e-6 else { break }
            u = min(1, max(0, u - x / dx))
        }
        return bezier(u, 1, 1)
    }

    private static func bezier(_ u: Double, _ p1: Double, _ p2: Double) -> Double {
        let v = 1 - u
        return 3 * v * v * u * p1 + 3 * v * u * u * p2 + u * u * u
    }

    private static func bezierDerivative(_ u: Double, _ p1: Double, _ p2: Double) -> Double {
        let v = 1 - u
        return 3 * v * v * p1 + 6 * v * u * (p2 - p1) + 3 * u * u * (1 - p2)
    }
}
