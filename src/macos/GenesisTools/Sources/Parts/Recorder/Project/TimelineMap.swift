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
        outputSpans(fromUs: fromUs, toUs: toUs, placed: placed(project))
    }

    static func outputSpans(fromUs: Int64, toUs: Int64, placed: [Placed]) -> [(fromUs: Int64, toUs: Int64)] {
        placed.compactMap { placed in
            let start = max(fromUs, placed.clip.fromUs)
            let end = min(toUs, placed.clip.toUs)
            guard end > start else { return nil }
            let out = { (source: Int64) in placed.outStartUs + Int64(Double(source - placed.clip.fromUs) / placed.clip.speed) }
            return (out(start), out(end))
        }
    }

    /// How long the source range [fromUs, toUs) plays in the edit: its output spans added up, so a sped-up part plays
    /// shorter and a cut part plays no time. The Swift twin of the recorder service's playedUs, which check() uses.
    static func playedUs(fromUs: Int64, toUs: Int64, in project: EditProject) -> Int64 {
        outputSpans(fromUs: fromUs, toUs: toUs, in: project).reduce(0) { $0 + $1.toUs - $1.fromUs }
    }

    static func placed(_ project: EditProject) -> [Placed] {
        placed(clips: project.clips)
    }

    /// `placed(_:)` of a clip list alone (a cached zoom schedule keeps the clips, not the whole project).
    static func placed(clips: [EditProject.Clip]) -> [Placed] {
        var start: Int64 = 0
        return clips.enumerated().map { index, clip in
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
        outputTime(ofSource: sourceUs, placed: placed(project))
    }

    static func outputTime(ofSource sourceUs: Int64, placed: [Placed]) -> Int64? {
        for placed in placed where sourceUs >= placed.clip.fromUs && sourceUs <= placed.clip.toUs {
            return placed.outStartUs + Int64((Double(sourceUs - placed.clip.fromUs) / placed.clip.speed).rounded())
        }
        return nil
    }

    /// Where an item that shows over the source range [fromUs, toUs) plays: the output time of its first and of its
    /// last kept moment, and how long it plays in all (a cut part plays no time). Its fades, draw-ons and eases run on
    /// these, in the movie as it plays, as transitions and the speed badge do: a sped-up part does not shorten them, and
    /// an item whose start was cut comes in from its first shown frame. Nil when all of it was cut.
    struct Shown: Equatable {
        var startOut: Int64
        var endOut: Int64
        var playedUs: Int64

        /// How far in it is at output time `outUs`, 0...1: in over `fadeUs` after its first shown frame and out over
        /// `fadeUs` before its last; 1 when `fadeUs` is 0.
        func fade(atOutput outUs: Int64, overUs fadeUs: Int64) -> Double {
            guard fadeUs > 0 else { return 1 }
            return max(0, min(1, Double(outUs - startOut) / Double(fadeUs), Double(endOut - outUs) / Double(fadeUs)))
        }
    }

    static func shown(fromUs: Int64, toUs: Int64, in project: EditProject) -> Shown? {
        shown(fromUs: fromUs, toUs: toUs, placed: placed(project))
    }

    static func shown(fromUs: Int64, toUs: Int64, placed: [Placed]) -> Shown? {
        let spans = outputSpans(fromUs: fromUs, toUs: toUs, placed: placed)
        guard let first = spans.first, let last = spans.last else { return nil }
        return Shown(startOut: first.fromUs, endOut: last.toUs, playedUs: spans.reduce(0) { $0 + $1.toUs - $1.fromUs })
    }

    /// The output time where the unbroken stretch of the movie playing at `outUs` began: the movie's start, or the start
    /// of the clip after the last cut before it (a split alone breaks nothing). A look that runs on from a moment, as a
    /// click's disc does, ends at a cut, where the picture it sits on is gone.
    static func unbrokenStart(atOutput outUs: Int64, placed: [Placed]) -> Int64 {
        guard var index = placed.lastIndex(where: { $0.outStartUs <= outUs }) else { return 0 }
        while index > 0, placed[index - 1].clip.toUs == placed[index].clip.fromUs {
            index -= 1
        }
        return placed[index].outStartUs
    }

    /// Convert a horizontal timeline move to source time through the kept clips and their speeds.
    static func sourceShift(outputDeltaUs: Int64, atSource sourceUs: Int64, in project: EditProject) -> Int64 {
        guard let output = outputTime(ofSource: sourceUs, in: project) else { return 0 }
        return sourceTime(atOutput: output + outputDeltaUs, in: project) - sourceUs
    }

    /// The edit cut down to what plays from `fromOut` to `toOut` (output microseconds): each clip's overlap with the
    /// range, at its speed. For exporting a part; nil when nothing plays there. Its audio sounds like that stretch of
    /// the whole export: a movie voiceover that starts before the part and plays into it starts at the part's first
    /// frame with the cut-off length skipped, one that ends before it is left out, and the music learns where the part
    /// plays in the whole. partOf in project.ts does the same (__fixtures__/part-audio.json).
    static func part(_ project: EditProject, fromOut: Int64, toOut: Int64) -> EditProject? {
        var clips: [EditProject.Clip] = []
        for placed in placed(project) {
            let start = max(fromOut, placed.outStartUs), end = min(toOut, placed.outEndUs)
            guard end > start else { continue }
            var clip = placed.clip
            clip.fromUs = placed.clip.fromUs + Int64((Double(start - placed.outStartUs) * placed.clip.speed).rounded())
            clip.toUs = min(placed.clip.toUs, placed.clip.fromUs + Int64((Double(end - placed.outStartUs) * placed.clip.speed).rounded()))
            // The shortest clip is source time, as split and trim measure it; a whole clip inside the part always stays.
            let whole = start == placed.outStartUs && end == placed.outEndUs
            guard whole || clip.toUs - clip.fromUs >= minimumClipUs else { continue }
            clips.append(clip)
        }
        guard let first = clips.first else { return nil }
        var next = project
        next.clips = clips
        next.audio.voiceovers = project.audio.voiceovers?.compactMap { clip in
            guard clip.card == nil, let startUs = outputTime(ofSource: clip.atUs, in: project), startUs < fromOut else { return clip }
            let cutUs = fromOut - startUs
            guard clip.durationUs > cutUs else { return nil }
            var kept = clip
            kept.atUs = first.fromUs
            kept.skipUs = (clip.skipUs ?? 0) + cutUs
            kept.durationUs = clip.durationUs - cutUs
            return kept
        }
        if var music = project.audio.music {
            let cards = CardSpans(project: project, enabled: true)
            music.inWhole = .init(atUs: (music.inWhole?.atUs ?? 0) + cards.leadUs + fromOut,
                                  lengthUs: music.inWhole?.lengthUs ?? cards.leadUs + project.outputDurationUs + cards.tailUs)
            next.audio.music = music
        }
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

/// How far the view is zoomed in: the zoom's scale reached over `easeInMs` with an ease-out curve, held, then released
/// over `easeOutMs`. A zoom shows over its source range, and its eases run on `clockUs`: in the movie as it plays, so a
/// sped-up part does not turn them into a snap, while the part of an ease that falls in a cut stays hidden there. A
/// focus point is kept far enough from the frame's edge that the zoomed view never shows outside the movie.
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

    /// A zoom and where it plays: the output time of its first and of its last shown moment.
    private struct Played {
        var zoom: EditProject.Zoom
        var startOut: Int64
        var endOut: Int64
    }

    /// Two zooms that touch, overlap, or leave less played time between them than one zoom out and the next zoom in
    /// take, are linked: the view glides from the first zoom's view to the second's and never returns to the whole frame
    /// in between. Before 2026-11-07 the first zoom snapped out and the second snapped in again, with one frame of the
    /// whole frame between them, which read as the picture blinking (two touching zooms at 5.30 s of a 22:19 recording).
    /// Until 2026-11-09 the gap was the recording's: two zooms that touched across a cut blinked the same way. The
    /// TypeScript twin is zoomsLinked in project.ts.
    private static func linked(_ first: Played, _ second: Played) -> Bool {
        (second.startOut, second.zoom.startUs) > (first.startOut, first.zoom.startUs)
            && second.startOut - first.endOut < Int64(first.zoom.easeOutMs + second.zoom.easeInMs) * 1000
    }

    /// The picture's view at a source moment that plays: the zooms inside the movie (R5 4: a canvas zoom is
    /// `canvasView`'s, never this one's).
    static func view(atSource sourceUs: Int64, project: EditProject, cursor: CursorTrack?) -> View {
        curve(atSource: sourceUs, project: project, layer: .picture, cursor: cursor)
    }

    // R5 4 canvas zoom
    /// The whole framed canvas's view: the canvas zooms, eased the same way, focused where they were placed (0...1 of
    /// the canvas; a canvas zoom does not follow the cursor, which moves inside the picture).
    static func canvasView(atSource sourceUs: Int64, project: EditProject) -> View {
        curve(atSource: sourceUs, project: project, layer: .canvas, cursor: nil)
    }

    private static func curve(atSource sourceUs: Int64, project: EditProject, layer: Layer, cursor: CursorTrack?) -> View {
        let schedule = schedules.schedule(layer: layer, clips: project.clips, zooms: project.zooms) {
            Schedule(layer: layer, clips: project.clips, zooms: project.zooms)
        }
        // A moment that was cut never shows; the renderer asks only for moments that play.
        guard !schedule.ordered.isEmpty, let outUs = TimelineMap.outputTime(ofSource: sourceUs, placed: schedule.placed) else {
            return .whole
        }
        return curve(atSource: sourceUs, outUs: outUs, ordered: schedule.ordered, placed: schedule.placed, cursor: cursor)
    }

    /// Which zooms a curve reads: the picture's (every zoom inside the movie) or the framed canvas's.
    enum Layer { case picture, canvas }

    /// One layer's zooms placed on the output timeline and sorted by where they play. It depends on the clips and the
    /// zooms only, so it is made once per edit, not at every frame: the preview and the export ask for both layers at
    /// every frame, and again for the previous frame with motion blur.
    private struct Schedule {
        let clips: [EditProject.Clip]
        let zooms: [EditProject.Zoom]
        let placed: [TimelineMap.Placed]
        let ordered: [Played]

        init(layer: Layer, clips: [EditProject.Clip], zooms: [EditProject.Zoom]) {
            self.clips = clips
            self.zooms = zooms
            let placed = TimelineMap.placed(clips: clips)
            self.placed = placed
            ordered = zooms.filter { ($0.target == .canvas) == (layer == .canvas) }.compactMap { zoom in
                TimelineMap.shown(fromUs: zoom.startUs, toUs: zoom.endUs, placed: placed)
                    .map { Played(zoom: zoom, startOut: $0.startOut, endOut: $0.endOut) }
            }.sorted { ($0.startOut, $0.zoom.startUs) < ($1.startOut, $1.zoom.startUs) }
        }
    }

    /// The last schedule of each layer. The render threads and the editor read it at once, so a lock guards it; a hit
    /// compares the project's clip and zoom arrays, which share their storage while the edit does not change.
    private final class Schedules: @unchecked Sendable {
        private let lock = NSLock()
        private var kept: [Layer: Schedule] = [:]
        private var made = 0

        /// How many schedules were made, for the tests.
        var builds: Int {
            lock.lock()
            defer { lock.unlock() }
            return made
        }

        func schedule(layer: Layer, clips: [EditProject.Clip], zooms: [EditProject.Zoom], make: () -> Schedule) -> Schedule {
            lock.lock()
            defer { lock.unlock() }
            if let schedule = kept[layer], schedule.clips == clips, schedule.zooms == zooms { return schedule }
            let schedule = make()
            kept[layer] = schedule
            made += 1
            return schedule
        }
    }

    private static let schedules = Schedules()

    /// How many zoom schedules were made since launch: the tests read it to prove a frame reuses the edit's schedule.
    static var scheduleBuilds: Int { schedules.builds }

    /// Which zoom shows is the source time's, how far it is in is `clockUs`'s, and the links and the glides between
    /// zooms are the output time's. A follow zoom's cursor average stays in source time, so the view stays on what the
    /// cursor does.
    private static func curve(atSource sourceUs: Int64, outUs: Int64, ordered: [Played], placed: [TimelineMap.Placed],
                              cursor: CursorTrack?) -> View {
        for (index, (first, second)) in zip(ordered, ordered.dropFirst()).enumerated() where linked(first, second) {
            // The glide runs from where the first zoom would start to leave to where the second would have arrived.
            // A zoom shorter than its own ease would leave a gap between the glide and the zoom, which showed the
            // whole frame: the glide starts no later than the first zoom's end and ends no earlier than the second's
            // start, and each side is the view its zoom has at the glide's edge, so nothing jumps there.
            var start = min(first.endOut, max(first.startOut + Int64(first.zoom.easeInMs) * 1000, first.endOut - Int64(first.zoom.easeOutMs) * 1000))
            var end = max(second.startOut, min(second.endOut - Int64(second.zoom.easeOutMs) * 1000, second.startOut + Int64(second.zoom.easeInMs) * 1000))
            if end <= start {
                // A deep overlap leaves that window empty, and the view jumped at the second zoom's start: it glides
                // over the second zoom's ease-in instead.
                start = second.startOut
                end = min(second.endOut, second.startOut + max(1, Int64(second.zoom.easeInMs)) * 1000)
            }
            guard end > start, outUs >= start, outUs < end else { continue }
            let t = Double(outUs - start) / Double(end - start)
            let progress = t * t * (3 - 2 * t)
            let from = shown(first.zoom, amount: amount(ordered, index, atSource: min(sourceUs, first.zoom.endUs - 1), placed: placed),
                             atSource: sourceUs, cursor: cursor)
            let to = shown(second.zoom, amount: amount(ordered, index + 1, atSource: max(sourceUs, second.zoom.startUs), placed: placed),
                           atSource: sourceUs, cursor: cursor)
            return View(scale: from.scale + (to.scale - from.scale) * progress,
                        centerX: from.centerX + (to.centerX - from.centerX) * progress,
                        centerY: from.centerY + (to.centerY - from.centerY) * progress)
        }
        guard let index = ordered.lastIndex(where: { sourceUs >= $0.zoom.startUs && sourceUs < $0.zoom.endUs }) else { return .whole }
        return shown(ordered[index].zoom, amount: amount(ordered, index, atSource: sourceUs, placed: placed), atSource: sourceUs, cursor: cursor)
    }

    /// How long the source range [fromUs, toUs) lasts on a zoom's clock: a kept part as long as it plays, so an ease in a
    /// part sped up 4x still takes its ms, and a cut part as long as it was recorded, so a zoom that ends past a cut
    /// holds to the cut and eases out inside it, as "End in the Cut" (check.ts zoomEaseAtCutIssues) promises.
    private static func clockUs(fromUs: Int64, toUs: Int64, placed: [TimelineMap.Placed]) -> Double {
        guard toUs > fromUs else { return 0 }
        var played = 0.0
        var kept = 0.0
        for placed in placed {
            let start = max(fromUs, placed.clip.fromUs)
            let end = min(toUs, placed.clip.toUs)
            guard end > start else { continue }
            played += Double(end - start) / placed.clip.speed
            kept += Double(end - start)
        }
        return played + Double(toUs - fromUs) - kept
    }

    /// How far a zoom is in at a source time inside it: eased in and out on `clockUs`, except toward a zoom it is linked
    /// with.
    private static func amount(_ ordered: [Played], _ index: Int, atSource sourceUs: Int64, placed: [TimelineMap.Placed]) -> Double {
        let zoom = ordered[index].zoom
        let linkedIn = index > 0 && linked(ordered[index - 1], ordered[index])
        let linkedOut = index + 1 < ordered.count && linked(ordered[index], ordered[index + 1])
        let into = clockUs(fromUs: zoom.startUs, toUs: sourceUs, placed: placed) / 1000
        let left = clockUs(fromUs: sourceUs, toUs: zoom.endUs, placed: placed) / 1000
        let inProgress = linkedIn || zoom.easeInMs <= 0 ? 1 : min(1, into / Double(zoom.easeInMs))
        let outProgress = linkedOut || zoom.easeOutMs <= 0 ? 1 : min(1, left / Double(zoom.easeOutMs))
        // In: fast, then a soft landing on the zoomed view. Out: a soft start and a soft landing on the whole frame
        // (smoothstep). `easeOut(outProgress)` held the zoom until its last few milliseconds and then snapped out; the
        // mirror of the zoom in, `1 - easeOut(1 - outProgress)`, left at full speed, which read as a snap at 300 to
        // 500 ms (round 3, 2026-11-08).
        let release = 1 - outProgress
        return min(easeOut(inProgress), 1 - release * release * (3 - 2 * release))
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
