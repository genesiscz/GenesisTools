import Foundation

/// The edits that change which parts of the source play: pure functions over a project, so the window, the
/// renderer and the tests agree on one mapping from output time (what plays) to source time (the movie).
enum TimelineMap {
    struct Placed: Equatable {
        var clip: EditProject.Clip
        var index: Int
        var outStartUs: Int64
        var outEndUs: Int64 { outStartUs + clip.outputDurationUs }
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

    /// The shortest clip a split or trim leaves: one frame at 60 fps.
    static let minimumClipUs: Int64 = 16_667

    /// Splits the clip under `outUs` in two; nil when the point is at a clip's edge (nothing to split).
    static func split(_ project: EditProject, atOutput outUs: Int64) -> EditProject? {
        guard let placed = clip(atOutput: outUs, in: project) else { return nil }
        let sourceUs = sourceTime(atOutput: outUs, in: project)
        guard sourceUs - placed.clip.fromUs >= minimumClipUs, placed.clip.toUs - sourceUs >= minimumClipUs else { return nil }
        var next = project
        var left = placed.clip
        var right = placed.clip
        left.toUs = sourceUs
        right.fromUs = sourceUs
        right.id = EditProject.newID("c")
        next.clips.replaceSubrange(placed.index...placed.index, with: [left, right])
        return next
    }

    /// Removes a clip (cuts its part of the source); the last clip cannot go.
    static func delete(_ project: EditProject, clip id: String) -> EditProject? {
        guard project.clips.count > 1, let index = project.clips.firstIndex(where: { $0.id == id }) else { return nil }
        var next = project
        next.clips.remove(at: index)
        return next
    }

    /// Moves one edge of a clip, kept inside the source and inside its neighbours' source ranges in order.
    static func trim(_ project: EditProject, clip id: String, fromUs: Int64? = nil, toUs: Int64? = nil) -> EditProject? {
        guard let index = project.clips.firstIndex(where: { $0.id == id }) else { return nil }
        var next = project
        var clip = next.clips[index]
        if let fromUs { clip.fromUs = max(0, min(fromUs, clip.toUs - minimumClipUs)) }
        if let toUs { clip.toUs = min(project.source.durationUs, max(toUs, clip.fromUs + minimumClipUs)) }
        next.clips[index] = clip
        return next
    }

    static func setSpeed(_ project: EditProject, clip id: String, speed: Double) -> EditProject? {
        guard let index = project.clips.firstIndex(where: { $0.id == id }) else { return nil }
        var next = project
        next.clips[index].speed = min(16, max(0.25, speed))
        return next
    }

    /// Adds a zoom over a source range; a range that overlaps another zoom is moved after it, or refused.
    static func addZoom(_ project: EditProject, startUs: Int64, endUs: Int64, scale: Double) -> (EditProject, String)? {
        let length = max(endUs - startUs, 500_000)
        var start = max(0, startUs)
        for zoom in project.zooms.sorted(by: { $0.startUs < $1.startUs }) where start < zoom.endUs && start + length > zoom.startUs {
            start = zoom.endUs
        }
        let end = min(project.source.durationUs, start + length)
        guard end - start >= 200_000, !project.zooms.contains(where: { start < $0.endUs && end > $0.startUs }) else { return nil }
        var next = project
        let zoom = EditProject.Zoom(id: EditProject.newID("z"), startUs: start, endUs: end, scale: scale)
        next.zooms.append(zoom)
        next.zooms.sort { $0.startUs < $1.startUs }
        return (next, zoom.id)
    }

    /// Moves or resizes a zoom inside the source without overlapping its neighbours.
    static func moveZoom(_ project: EditProject, zoom id: String, startUs: Int64, endUs: Int64) -> EditProject? {
        guard let index = project.zooms.firstIndex(where: { $0.id == id }) else { return nil }
        let others = project.zooms.filter { $0.id != id }
        let lower = others.filter { $0.endUs <= project.zooms[index].startUs }.map(\.endUs).max() ?? 0
        let upper = others.filter { $0.startUs >= project.zooms[index].endUs }.map(\.startUs).min() ?? project.source.durationUs
        let start = max(lower, min(startUs, upper - 200_000))
        let end = min(upper, max(endUs, start + 200_000))
        var next = project
        next.zooms[index].startUs = start
        next.zooms[index].endUs = end
        return next
    }
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

    static func view(atSource sourceUs: Int64, zooms: [EditProject.Zoom], cursor: CursorTrack?) -> View {
        guard let zoom = zooms.first(where: { sourceUs >= $0.startUs && sourceUs < $0.endUs }) else { return .whole }
        let into = Double(sourceUs - zoom.startUs) / 1000
        let left = Double(zoom.endUs - sourceUs) / 1000
        let inProgress = zoom.easeInMs > 0 ? min(1, into / Double(zoom.easeInMs)) : 1
        let outProgress = zoom.easeOutMs > 0 ? min(1, left / Double(zoom.easeOutMs)) : 1
        let amount = easeOut(min(inProgress, outProgress))
        let scale = 1 + (zoom.scale - 1) * amount
        var focus = (x: zoom.focusX, y: zoom.focusY)
        if zoom.mode == .follow, let point = cursor?.smoothedPoint(atUs: sourceUs) {
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
