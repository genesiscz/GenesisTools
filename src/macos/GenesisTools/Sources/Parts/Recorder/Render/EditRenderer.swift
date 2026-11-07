import AVFoundation
import CoreImage
import Foundation

/// What the zoom filter reads for each frame. The window changes it when a zoom changes, and the next frame drawn
/// shows it, so dragging a zoom's focus never rebuilds the player item. One lock, held only to copy a value.
final class ZoomState: @unchecked Sendable {
    private let lock = NSLock()
    private var project: EditProject
    private var cursor: CursorTrack?
    private var captions: CaptionTrack?
    /// The keys overlay's plates, one per shortcut label and size.
    let keyPlates = TextPlates()

    init(project: EditProject, cursor: CursorTrack?) {
        self.project = project
        self.cursor = cursor
        captions = CaptionTrack.load(video: project.source.video)
    }

    func update(_ project: EditProject) {
        lock.lock()
        self.project = project
        lock.unlock()
    }

    /// The camera bubble as the window has it now, so a moved or hidden bubble shows at the next frame.
    var camera: EditProject.Camera? {
        lock.lock()
        defer { lock.unlock() }
        return project.camera
    }

    /// Reads the transcript cache again (after a transcription); true when the movie now has captions.
    @discardableResult
    func reloadCaptions() -> Bool {
        let track = CaptionTrack.load(video: project.source.video)
        lock.lock()
        captions = track
        lock.unlock()
        return track != nil
    }

    /// The cached transcript's lines, for the timeline's marks lane.
    var captionLines: [CaptionTrack.Line] {
        lock.lock()
        defer { lock.unlock() }
        return captions?.lines ?? []
    }

    var hasCaptions: Bool {
        lock.lock()
        defer { lock.unlock() }
        return captions != nil
    }

    /// One caption to draw over the output.
    struct CaptionMark {
        var line: CaptionTrack.Line
        var track: CaptionTrack
        var settings: EditProject.Captions
    }

    /// The shortcut to draw over the output.
    struct KeyMark {
        var label: String
        var opacity: Double
        var settings: EditProject.Keys
    }


    /// Everything one frame draws: the zoom, the clicks animating at its source time, and the frame style.
    struct FrameLook {
        var view: ZoomCurve.View
        var marks: [Looks.ClickMark]
        var clicks: EditProject.Clicks?
        var cursor: Looks.CursorMark?
        /// Where a `cover` crop centres, 0...1 of the picture after the zoom.
        var coverFocus: CGPoint
        var frame: EditProject.Frame?
        var caption: CaptionMark?
        var key: KeyMark?
        /// The redactions active at the frame's source time.
        var redactions: [EditProject.Redaction] = []
        /// The texts showing at the frame's source time, each with its fade.
        var texts: [(note: EditProject.TextNote, opacity: Double)] = []
        /// How far the spotlights' dim has faded in (0...1): it comes and goes over 0.2 s, where a hiding style never fades.
        var spotlightFade = 1.0
        /// The shapes showing at the frame's source time: how far each has drawn itself on (0...1) and its fade.
        var shapes: [(shape: EditProject.Shape, drawn: Double, opacity: Double)] = []
        /// The zoom one output frame earlier, for the motion blur; nil at the start and across a cut.
        var previousView: ZoomCurve.View?
        var motionBlur = 0.0
    }

    /// Every frame the renderer drew; the editor compares it with the frames a playback should have shown.
    private var drawn = 0

    var framesDrawn: Int {
        lock.lock()
        defer { lock.unlock() }
        return drawn
    }

    func look(atOutput outUs: Int64) -> FrameLook {
        lock.lock()
        let project = project
        let cursor = cursor
        let captions = captions
        drawn += 1
        lock.unlock()
        let sourceUs = TimelineMap.sourceTime(atOutput: outUs, in: project)
        var marks: [Looks.ClickMark] = []
        if let clicks = project.clicks, clicks.highlight, let cursor {
            marks = Looks.marks(atSourceMs: Double(sourceUs) / 1000, clicks: cursor.clicks, durationMs: clicks.durationMs)
        }
        let view = ZoomCurve.view(atSource: sourceUs, zooms: project.zooms, cursor: cursor)
        let motionBlur = (project.motion ?? .init()).blur
        var previousView: ZoomCurve.View?
        if motionBlur > 0, outUs >= Self.frameUs, !project.zooms.isEmpty {
            let previousUs = TimelineMap.sourceTime(atOutput: outUs - Self.frameUs, in: project)
            // A cut jumps in source time; the frame after it has no move to smear.
            if sourceUs > previousUs, sourceUs - previousUs <= Self.frameUs * 17 {
                previousView = ZoomCurve.view(atSource: previousUs, zooms: project.zooms, cursor: cursor)
            }
        }
        var look = FrameLook(view: view,
                         marks: marks, clicks: project.clicks,
                         cursor: Self.cursorMark(atSourceUs: sourceUs, track: cursor, settings: project.cursor ?? .init(),
                                                 videoWidth: Double(project.source.width)),
                         coverFocus: Self.coverFocus(atSourceUs: sourceUs, project: project, track: cursor, view: view),
                         frame: project.frame,
                         caption: project.captions.flatMap { settings in
                             guard settings.show, let captions, let raw = captions.line(atSourceUs: sourceUs) else { return nil }
                             // A fix with no words hides the line.
                             guard let line = project.transcript.map({ $0.apply(raw) }) ?? raw else { return nil }
                             return CaptionMark(line: line, track: captions, settings: settings)
                         },
                         key: project.keys.flatMap { settings in
                             guard settings.show, let shown = cursor?.key(atMs: Double(sourceUs) / 1000, durationMs: settings.durationMs) else { return nil }
                             return KeyMark(label: shown.label, opacity: shown.opacity, settings: settings)
                         },
                         redactions: (project.redactions ?? []).filter { sourceUs >= $0.startUs && sourceUs < $0.endUs }
                             .map { Self.placed($0, atSourceUs: sourceUs, track: cursor) },
                         texts: Self.texts(atSourceUs: sourceUs, project: project))
        look.previousView = previousView
        look.motionBlur = motionBlur
        look.shapes = Self.shapes(atSourceUs: sourceUs, project: project)
        look.spotlightFade = look.redactions.filter { $0.style == .spotlight }.map { spot in
            let fade = Double(min(200_000, max(1, (spot.endUs - spot.startUs) / 3)))
            return min(1, Double(sourceUs - spot.startUs) / fade, Double(spot.endUs - sourceUs) / fade)
        }.max() ?? 1
        return look
    }

    /// The shapes showing at a source time: each draws itself on over 0.3 s (or fades in over 0.2 s, or is there at
    /// once, by its `appear`) and fades out over 0.2 s.
    static func shapes(atSourceUs us: Int64, project: EditProject) -> [(shape: EditProject.Shape, drawn: Double, opacity: Double)] {
        (project.shapes ?? []).compactMap { shape in
            guard us >= shape.startUs, us < shape.endUs else { return nil }
            let length = Double(shape.endUs - shape.startUs)
            let into = Double(us - shape.startUs)
            let out = min(1, Double(shape.endUs - us) / min(200_000, length / 3))
            switch shape.appear ?? .draw {
            case .draw:
                return (shape, max(0.02, min(1, into / min(300_000, length / 2))), max(0, out))
            case .fade:
                return (shape, 1, max(0, min(out, into / min(200_000, length / 3))))
            case .none:
                return (shape, 1, max(0, out))
            }
        }
    }

    /// One output frame at 60 fps.
    static let frameUs: Int64 = 16_667

    /// A redaction that follows the cursor, centred on it (averaged over ±150 ms, so it glides) and kept inside the
    /// picture; any other one as it is.
    static func placed(_ redaction: EditProject.Redaction, atSourceUs us: Int64, track: CursorTrack?) -> EditProject.Redaction {
        guard redaction.follow == true, let track,
              let point = track.averagedPoint(atMs: Double(us) / 1000, halfMs: 150) else { return redaction }
        var moved = redaction
        moved.x = min(max(0, point.x - redaction.width / 2), 1 - redaction.width)
        moved.y = min(max(0, point.y - redaction.height / 2), 1 - redaction.height)
        return moved
    }

    /// How long a text of `lengthUs` fades in and out: 0.2 s, less for a short one.
    static func textFadeUs(lengthUs: Int64) -> Int64 { min(200_000, max(1, lengthUs / 3)) }

    /// The texts showing at a source time, each fading in and out over `textFadeUs`.
    static func texts(atSourceUs us: Int64, project: EditProject) -> [(note: EditProject.TextNote, opacity: Double)] {
        (project.texts ?? []).compactMap { note in
            guard us >= note.startUs, us < note.endUs else { return nil }
            let fade = Double(textFadeUs(lengthUs: note.endUs - note.startUs))
            let opacity = min(1, Double(us - note.startUs) / fade, Double(note.endUs - us) / fade)
            return (note, max(0, opacity))
        }
    }

    /// The cursor, averaged over ±0.7 s and moved into the zoomed view; the centre without a track or a cover fit.
    static func coverFocus(atSourceUs us: Int64, project: EditProject, track: CursorTrack?, view: ZoomCurve.View) -> CGPoint {
        guard project.frame?.fit == .cover, let track,
              let point = track.averagedPoint(atMs: Double(us) / 1000, halfMs: 700) else { return CGPoint(x: 0.5, y: 0.5) }
        let rect = view.rect
        return CGPoint(x: (point.x - rect.minX) / rect.width, y: (point.y - rect.minY) / rect.height)
    }

    static func cursorMark(atSourceUs us: Int64, track: CursorTrack?, settings: EditProject.Cursor, videoWidth: Double) -> Looks.CursorMark? {
        guard settings.show, let track, track.drawsCursor else { return nil }
        let ms = Double(us) / 1000
        guard let shape = track.shape(atMs: ms), let point = track.drawnPoint(atMs: ms, smoothing: settings.smoothing) else { return nil }
        // A recording without the width in points is taken as a Retina display.
        let perPoint = track.pointWidth.map { videoWidth / $0 } ?? 2
        let opacity = track.visibility(atMs: ms, hideAfterMs: settings.hideAfterMs ?? 0)
        guard opacity > 0.001 else { return nil }
        return Looks.CursorMark(shape: shape, x: point.x, y: point.y, pixelsPerPoint: perPoint * max(0.5, min(3, settings.size)),
                                opacity: opacity)
    }
}

/// A soft tick at each recorded click, on its own track of the composition: one audio file as long as the movie, with
/// a 45 ms decaying 2.4 kHz tone and a little noise at each click, inserted in one piece as the music is. The file is
/// kept in the temporary folder under a digest of the click times, so a rebuild with the same clicks reads it again.
enum ClickSound {
    static let lengthUs: Int64 = 45_000
    static let rate = 48_000.0

    /// The output times of the clicks that play, at least one tick apart, in order.
    static func times(clicks: [Int64], project: EditProject) -> [Int64] {
        // The ticks are sound: "Include audio" off leaves them out with the rest of it.
        guard project.audio.include else { return [] }
        var times: [Int64] = []
        for us in clicks.compactMap({ TimelineMap.outputTime(ofSource: $0, in: project) }).sorted()
        where times.last.map({ us - $0 >= lengthUs }) ?? true {
            times.append(us)
        }
        return times
    }

    static func add(to composition: AVMutableComposition, project: EditProject) async throws -> AVMutableAudioMixInputParameters? {
        let clicks = (CursorTrack.load(project.source.cursor)?.clicks ?? []).map { Int64(($0.ms * 1000).rounded()) }
        let times = times(clicks: clicks, project: project)
        let movieUs = project.outputDurationUs
        guard !times.isEmpty, let url = try trackFile(times: times, lengthUs: movieUs) else { return nil }
        // The asset is held for the whole insert: a track of an asset that was already freed made the insert throw
        // AVFoundation -11800 (OSStatus -12780).
        let asset = AVURLAsset(url: url)
        guard let source = try await asset.loadTracks(withMediaType: .audio).first,
              let out = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { return nil }
        let available = try await source.load(.timeRange)
        try out.insertTimeRange(CMTimeRange(start: available.start, duration: CMTimeMinimum(available.duration, EditRenderer.us(movieUs))),
                                of: source, at: .zero)
        let parameters = AVMutableAudioMixInputParameters(track: out)
        parameters.setVolume(0.3, at: .zero)
        HubPerf.log("recorder.clickSound: \(times.count) ticks in \(asset.url.lastPathComponent)")
        return parameters
    }

    /// The tick's samples, written once into a buffer per file.
    static func tick() -> [Float] {
        var noise: UInt32 = 0x9E37_79B9
        return (0..<Int(Double(lengthUs) / 1_000_000 * rate)).map { index in
            let t = Double(index) / rate
            noise = noise &* 1_664_525 &+ 1_013_904_223
            let hiss = Double(Int32(bitPattern: noise)) / Double(Int32.max) * 0.25
            let envelope = exp(-t * 110) * min(1, t * 4000)
            return Float((sin(2 * .pi * 2400 * t) + hiss) * envelope * 0.8)
        }
    }

    private static func trackFile(times: [Int64], lengthUs: Int64) throws -> URL? {
        // A stable digest of the length and the times (Swift's Hasher is seeded per process).
        let key = times.reduce(UInt64(truncatingIfNeeded: lengthUs)) { ($0 &* 1_099_511_628_211) ^ UInt64(truncatingIfNeeded: $1) }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("genesis-recorder-ticks-\(String(key, radix: 16)).m4a")
        if FileManager.default.fileExists(atPath: url.path) { return url }
        guard let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1) else { return nil }
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: rate, AVNumberOfChannelsKey: 1,
                                       AVEncoderBitRateKey: 64_000]
        let partial = url.deletingPathExtension().appendingPathExtension("partial.m4a")
        let total = Int((Double(lengthUs) / 1_000_000 * rate).rounded(.up))
        let starts = times.map { Int(Double($0) / 1_000_000 * rate) }
        let sound = tick()
        let chunk = 48_000
        do {
            let file = try AVAudioFile(forWriting: partial, settings: settings, commonFormat: .pcmFormatFloat32, interleaved: false)
            var from = 0
            while from < total {
                let count = min(chunk, total - from)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)),
                      let samples = buffer.floatChannelData?[0] else { return nil }
                buffer.frameLength = AVAudioFrameCount(count)
                for index in 0..<count { samples[index] = 0 }
                for start in starts where start < from + count && start + sound.count > from {
                    for offset in max(0, from - start)..<min(sound.count, from + count - start) {
                        samples[start + offset - from] += sound[offset]
                    }
                }
                try file.write(from: buffer)
                from += count
            }
        }
        // Renamed once the file is closed, so a crash mid-write never leaves half a track for the next run.
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.moveItem(at: partial, to: url)
        return url
    }
}

/// Short volume dips at the cuts, so a join between two places of the sound does not click.
enum Declick {
    static let halfUs: Int64 = 25_000

    /// The output times where the sound jumps: the start of every clip that does not continue the one before it in
    /// the source at the same speed (a split alone joins nothing).
    static func cuts(in project: EditProject) -> [Int64] {
        var cuts: [Int64] = []
        var at: Int64 = 0
        var previous: EditProject.Clip?
        for clip in project.clips where clip.sourceDurationUs > 0 {
            if let previous, previous.toUs != clip.fromUs || previous.speed != clip.speed { cuts.append(at) }
            at += clip.outputDurationUs
            previous = clip
        }
        return cuts
    }

    /// Each cut as a ramp down to silence over the 25 ms before it and back up over the 25 ms after; cuts closer than
    /// 50 ms share one silence from the first to the last. Volumes are factors of the track's own volume. Measured on a
    /// 440 Hz tone: a 10 ms ramp left the cut at 65 % (the mix applies ramps coarsely), 25 ms brings it to 6 %.
    /// The ramps never overlap: AVFoundation raises an Objective-C exception for an overlapping ramp, which crashed the
    /// editor on two cuts 10 ms apart (or a clip so short it plays for 0 µs, whose two cuts fall on one time).
    static func ramps(at cuts: [Int64], lengthUs: Int64) -> [(startUs: Int64, endUs: Int64, from: Double, to: Double)] {
        var groups: [(start: Int64, end: Int64)] = []
        for cut in Set(cuts.map { min(max(0, $0), lengthUs) }).sorted() {
            if let last = groups.last, cut - last.end < halfUs * 2 {
                groups[groups.count - 1].end = cut
            } else {
                groups.append((cut, cut))
            }
        }
        var ramps: [(startUs: Int64, endUs: Int64, from: Double, to: Double)] = []
        for group in groups {
            let down = max(ramps.last?.endUs ?? 0, group.start - halfUs)
            if group.start > down { ramps.append((down, group.start, 1, 0)) }
            if group.end > group.start { ramps.append((group.start, group.end, 0, 0)) }
            let up = min(lengthUs, group.end + halfUs)
            if up > group.end { ramps.append((group.end, up, 0, 1)) }
        }
        return ramps
    }
}

/// Music under the movie: looped to its length, faded in and out, ducked under the transcript's lines.
enum MusicMix {
    /// How long the music takes to dip under a line and come back.
    static let rampUs: Int64 = 300_000

    /// The spoken parts in output time, from the cached transcript; lines closer than two ramps merge.
    static func speech(lines: [CaptionTrack.Line], project: EditProject) -> [(fromUs: Int64, toUs: Int64)] {
        let spans = lines.compactMap { line -> (fromUs: Int64, toUs: Int64)? in
            guard let from = TimelineMap.outputTime(ofSource: line.fromUs, in: project),
                  let to = TimelineMap.outputTime(ofSource: line.toUs, in: project), to > from else { return nil }
            return (from, to)
        }.sorted { $0.fromUs < $1.fromUs }
        var merged: [(fromUs: Int64, toUs: Int64)] = []
        for span in spans {
            if let last = merged.last, span.fromUs - last.toUs < rampUs * 2 {
                merged[merged.count - 1].toUs = max(last.toUs, span.toUs)
            } else {
                merged.append(span)
            }
        }
        return merged
    }

    /// The music's volume at `us`: its level, times the fades at both ends, times the duck under a spoken part.
    static func gain(atUs us: Int64, music: EditProject.Music, speech: [(fromUs: Int64, toUs: Int64)], lengthUs: Int64) -> Double {
        let fadeUs = Double(max(1, Int64(music.fadeMs) * 1000))
        let fade = music.fadeMs == 0 ? 1 : max(0, min(1, Double(us) / fadeUs, Double(lengthUs - us) / fadeUs))
        var level = 1.0
        for span in speech {
            let into: Double
            if us >= span.fromUs && us <= span.toUs {
                into = 1
            } else if us < span.fromUs && us > span.fromUs - rampUs {
                into = 1 - Double(span.fromUs - us) / Double(rampUs)
            } else if us > span.toUs && us < span.toUs + rampUs {
                into = 1 - Double(us - span.toUs) / Double(rampUs)
            } else {
                into = 0
            }
            level = min(level, 1 - music.duck * into)
        }
        return music.volume * fade * level
    }

    /// The times where the volume changes its slope, with the volume there; a ramp runs between each pair.
    static func keyframes(music: EditProject.Music, speech: [(fromUs: Int64, toUs: Int64)], lengthUs: Int64) -> [(us: Int64, volume: Double)] {
        let fadeUs = Int64(music.fadeMs) * 1000
        var times: Set<Int64> = [0, lengthUs, min(lengthUs, fadeUs), max(0, lengthUs - fadeUs)]
        for span in speech {
            times.formUnion([span.fromUs - rampUs, span.fromUs, span.toUs, span.toUs + rampUs])
        }
        return times.filter { $0 >= 0 && $0 <= lengthUs }.sorted()
            .map { ($0, gain(atUs: $0, music: music, speech: speech, lengthUs: lengthUs)) }
    }

    /// Lays the music under the movie and returns its mix parameters; nil (logged) when the file has no sound.
    static func add(_ music: EditProject.Music, to composition: AVMutableComposition, lengthUs: Int64,
                    project: EditProject) async throws -> AVMutableAudioMixInputParameters? {
        let asset = AVURLAsset(url: URL(fileURLWithPath: music.file))
        guard let source = try? await asset.loadTracks(withMediaType: .audio).first,
              let out = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            HubPerf.log("recorder.music: no sound in \(music.file); the movie plays without it")
            return nil
        }
        let available = try await source.load(.timeRange)
        guard available.duration > .zero else { return nil }
        let length = EditRenderer.us(lengthUs)
        // The first pass starts at startMs (kept 0.5 s before the file's end); a loop goes on from the beginning.
        let skip = CMTimeMinimum(EditRenderer.us(Int64(music.startMs ?? 0) * 1000),
                                 CMTimeMaximum(.zero, available.duration - CMTime(value: 1, timescale: 2)))
        var range = CMTimeRange(start: available.start + skip, duration: available.duration - skip)
        var at = CMTime.zero
        while at < length {
            let piece = CMTimeMinimum(range.duration, length - at)
            try out.insertTimeRange(CMTimeRange(start: range.start, duration: piece), of: source, at: at)
            at = at + piece
            if music.loop == false { break }
            range = available
        }
        // Played once, the music fades out at its own end.
        let playedUs = min(lengthUs, Int64((at.seconds * 1_000_000).rounded()))
        let speech = speech(lines: CaptionTrack.load(video: project.source.video)?.lines ?? [], project: project)
        let frames = keyframes(music: music, speech: speech, lengthUs: playedUs)
        let parameters = AVMutableAudioMixInputParameters(track: out)
        for (start, end) in zip(frames, frames.dropFirst()) where end.us > start.us {
            parameters.setVolumeRamp(fromStartVolume: Float(start.volume), toEndVolume: Float(end.volume),
                                     timeRange: CMTimeRange(start: EditRenderer.us(start.us), duration: EditRenderer.us(end.us - start.us)))
        }
        HubPerf.log("recorder.music: \(URL(fileURLWithPath: music.file).lastPathComponent) under \(speech.count) spoken parts, \(frames.count) keyframes")
        return parameters
    }
}

/// The movie a project plays: the kept clips in order with their speeds, the zoom filter, and the audio levels.
/// The preview's player item and the export are built from the same `Rendered`, so what plays is what exports.
struct EditRenderer {
    struct Rendered {
        let composition: AVMutableComposition
        let videoComposition: AVMutableVideoComposition
        let audioMix: AVAudioMix?
        let renderSize: CGSize
    }

    enum RenderError: LocalizedError {
        case noVideoTrack(String)
        case emptyEdit
        case badComposition(String)

        var errorDescription: String? {
            switch self {
            case let .noVideoTrack(path): "\(path) has no video track"
            case .emptyEdit: "the edit keeps nothing of the movie"
            case let .badComposition(detail): "the movie's picture settings are not valid (\(detail))"
            }
        }
    }

    static func us(_ value: Int64) -> CMTime { CMTime(value: value, timescale: 1_000_000) }

    /// The pixels a second the H.264 export preset keeps at full rate: 2560×1600 at 60 fps. Measured 2026-11-04 on a
    /// 60 fps recording: 2560×1600 kept 60 fps, 2880×1798 and 3456×2160 came out at 30, 3724×2326 at 15. HEVC kept
    /// 4112×2570 at 60.
    static let h264PixelRate: CGFloat = 2560 * 1600 * 60

    /// `maxHeight` 0 keeps the source size. The size is rounded to even pixels, which H.264 needs. With `h264Fps` the
    /// size also fits `h264PixelRate`, so the export keeps its frame rate instead of the encoder halving it.
    static func renderSize(source: CGSize, maxHeight: Int, h264Fps: Double? = nil) -> CGSize {
        outputSizes(source: source, maxHeight: maxHeight, aspect: nil, h264Fps: h264Fps).canvas
    }

    /// The movie's picture and the canvas it sits on (the same size without an aspect). The canvas's short side is
    /// the picture's height; the H.264 budget applies to the canvas, which is what the encoder gets.
    static func outputSizes(source: CGSize, maxHeight: Int, aspect: EditProject.CanvasAspect?, h264Fps: Double? = nil)
        -> (picture: CGSize, canvas: CGSize) {
        var scale = maxHeight > 0 && source.height > CGFloat(maxHeight) ? CGFloat(maxHeight) / source.height : 1
        let ratio = aspect?.ratio
        func canvas(_ height: CGFloat) -> CGSize {
            guard let ratio else { return CGSize(width: source.width / source.height * height, height: height) }
            return ratio >= 1 ? CGSize(width: height * ratio, height: height) : CGSize(width: height, height: height / ratio)
        }
        if let h264Fps, h264Fps > 0 {
            let full = canvas(source.height * scale)
            let pixels = full.width * full.height
            let limit = h264PixelRate / CGFloat(h264Fps)
            if pixels > limit { scale *= (limit / pixels).squareRoot() }
        }
        func even(_ value: CGFloat) -> CGFloat { max(2, (value / 2).rounded(.down) * 2) }
        let height = source.height * scale
        let shape = canvas(height)
        return (CGSize(width: even(source.width * scale), height: even(height)), CGSize(width: even(shape.width), height: even(shape.height)))
    }

    /// The output's constant frame rate. A screen recording writes frames only while something moves, so its average
    /// (nominal) rate sits below the rate of its motion (45 for a 60 fps recording); above film rates it exports at
    /// 60. A film rate (24, 25, 30) is kept. `minFrameDuration` is no help: it read 1/15 on such a movie.
    /// Below film rates it exports at 30: a mostly still recording (8 fps) and a meeting's frames proxy (185 frames in
    /// 37 minutes, 0.08 fps) still animate their zooms and captions smoothly, and 0.08 rounded to 0 made a frame
    /// duration of 1/0 that AVPlayerItem refused with an Objective-C exception, which crashed the editor (2026-11-07).
    static func exportFps(nominal: Double) -> Double {
        if nominal > 31 { return 60 }
        if nominal >= 23.5 { return nominal.rounded() }
        return 30
    }

    static func render(project: EditProject, asset: AVURLAsset, zoom: ZoomState, maxHeight: Int) async throws -> Rendered {
        guard let video = try await asset.loadTracks(withMediaType: .video).first else {
            throw RenderError.noVideoTrack(asset.url.path)
        }
        let audio = project.audio.include ? try await asset.loadTracks(withMediaType: .audio) : []
        let (natural, nominalFps) = try await video.load(.naturalSize, .nominalFrameRate)
        let composition = AVMutableComposition()
        guard let videoOut = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw RenderError.emptyEdit
        }
        let audioOut = audio.compactMap { _ in
            composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
        }
        var cursor = CMTime.zero
        for clip in project.clips where clip.sourceDurationUs > 0 {
            let range = CMTimeRange(start: us(clip.fromUs), duration: us(clip.sourceDurationUs))
            try videoOut.insertTimeRange(range, of: video, at: cursor)
            for (index, track) in audio.enumerated() {
                // An audio track shorter than the movie (it started late) still gets the part it has.
                let available = try await track.load(.timeRange)
                let part = range.intersection(available)
                if part.duration > .zero {
                    try audioOut[index].insertTimeRange(part, of: track, at: cursor + (part.start - range.start))
                }
            }
            let placed = CMTimeRange(start: cursor, duration: range.duration)
            let played = us(clip.outputDurationUs)
            if clip.speed != 1 {
                composition.scaleTimeRange(placed, toDuration: played)
            }
            cursor = cursor + played
        }
        guard cursor > .zero else { throw RenderError.emptyEdit }

        let fps = Self.exportFps(nominal: Double(nominalFps))
        let (picture, size) = outputSizes(source: natural, maxHeight: maxHeight, aspect: project.frame?.aspect,
                                          h264Fps: project.export.codec == .h264 ? fps : nil)
        let outputScale = picture.height / natural.height
        let cameraFeed = await CameraFeed.make(project: project)
        let videoComposition = AVMutableVideoComposition(asset: composition) { request in
            let image = request.sourceImage
            let extent = image.extent
            let outUs = Int64((request.compositionTime.seconds * 1_000_000).rounded())
            let look = zoom.look(atOutput: outUs)
            let view = look.view
            var result = Looks.redact(look.redactions, on: image, spotlightFade: look.spotlightFade).cropped(to: extent)
            for drawn in look.shapes {
                result = Looks.drawShape(drawn.shape, drawn: drawn.drawn, opacity: drawn.opacity, on: result).cropped(to: extent)
            }
            if let clicks = look.clicks, !look.marks.isEmpty {
                result = Looks.drawClicks(look.marks, on: result, settings: clicks).cropped(to: extent)
            }
            // The cursor is its own layer: zoomed and framed like the picture, laid over the captions and plates last.
            var cursor = look.cursor.map { Looks.cursorSprite($0, extent: extent).cropped(to: extent) }
            // Core Image counts y from the bottom; the project counts it from the top.
            let rect = view.rect
            let crop = CGRect(x: extent.minX + rect.minX * extent.width, y: extent.minY + (1 - rect.maxY) * extent.height,
                              width: rect.width * extent.width, height: rect.height * extent.height)
            let toPicture = { (layer: CIImage) -> CIImage in
                var image = layer
                if view.scale > 1.0005 {
                    image = image.cropped(to: crop)
                        .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
                        .transformed(by: CGAffineTransform(scaleX: extent.width / crop.width, y: extent.height / crop.height))
                }
                if outputScale != 1 {
                    image = image.transformed(by: CGAffineTransform(scaleX: outputScale, y: outputScale))
                }
                return image.cropped(to: CGRect(origin: .zero, size: picture))
            }
            result = toPicture(result)
            if let previous = look.previousView {
                result = Looks.motionBlur(from: previous, to: view, amount: look.motionBlur, on: result)
            }
            cursor = cursor.map(toPicture)
            if let frame = look.frame {
                let placement = Looks.framePlacement(frame, picture: picture, canvas: size, focus: look.coverFocus)
                result = Looks.applyFrame(frame, to: result, canvas: size, placement: placement)
                cursor = cursor.map { placement.place($0).cropped(to: placement.inner) }
            }
            var captionUsed: CGFloat = 0
            if let caption = look.caption {
                let drawn = Looks.drawCaption(caption.line, track: caption.track, settings: caption.settings, on: result, size: size)
                result = drawn.image.cropped(to: CGRect(origin: .zero, size: size))
                captionUsed = drawn.used
            }
            if let key = look.key {
                let sameEdge = look.caption?.settings.position == key.settings.position
                result = Looks.drawKey(key.label, opacity: key.opacity, plates: zoom.keyPlates, settings: key.settings, on: result,
                                       size: size, below: sameEdge ? captionUsed - min(size.width, size.height) * 0.05 : 0)
                    .cropped(to: CGRect(origin: .zero, size: size))
            }
            for text in look.texts {
                result = Looks.drawText(text.note, opacity: text.opacity, plates: zoom.keyPlates, on: result, size: size)
                    .cropped(to: CGRect(origin: .zero, size: size))
            }
            if let cameraFeed, let camera = zoom.camera {
                result = cameraFeed.draw(camera, atSourceUs: TimelineMap.sourceTime(atOutput: outUs, in: project), on: result, canvas: size)
                    .cropped(to: CGRect(origin: .zero, size: size))
            }
            if let cursor {
                result = cursor.composited(over: result).cropped(to: CGRect(origin: .zero, size: size))
            }
            request.finish(with: result, context: nil)
        }
        videoComposition.renderSize = size
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))
        // AVPlayerItem and the export session raise an Objective-C exception for an invalid frame duration or size,
        // which Swift cannot catch and which leaves the main thread's executor state broken: refuse it here instead.
        guard videoComposition.frameDuration.isValid, videoComposition.frameDuration > .zero,
              size.width >= 2, size.height >= 2 else {
            throw RenderError.badComposition("frame duration \(videoComposition.frameDuration.seconds) s, size \(Int(size.width))×\(Int(size.height))")
        }
        // The CI-filter initializer times frames by the source track; a screen recording has a variable rate, and a
        // sped-up clip packs its frames closer (2× gave 74 fps). Without a timing track `frameDuration` decides.
        videoComposition.sourceTrackIDForFrameTiming = kCMPersistentTrackID_Invalid

        var inputs: [AVMutableAudioMixInputParameters] = audioOut.enumerated().map { index, track in
            let parameters = AVMutableAudioMixInputParameters(track: track)
            let muted = project.audio.mutedTracks.contains(index)
            let volume = muted ? 0 : Float(project.audio.volume)
            parameters.setVolume(volume, at: .zero)
            // A cut joins two places of the sound; a 25 ms dip on each side keeps the jump from clicking.
            if volume > 0 {
                for ramp in Declick.ramps(at: Declick.cuts(in: project), lengthUs: project.outputDurationUs) {
                    parameters.setVolumeRamp(fromStartVolume: volume * Float(ramp.from), toEndVolume: volume * Float(ramp.to),
                                             timeRange: CMTimeRange(start: us(ramp.startUs), duration: us(ramp.endUs - ramp.startUs)))
                }
            }
            return parameters
        }
        if let music = project.audio.music, let parameters = try await MusicMix.add(music, to: composition, lengthUs: Int64((cursor.seconds * 1_000_000).rounded()), project: project) {
            inputs.append(parameters)
        }
        if project.clicks?.sound == true, let parameters = try await ClickSound.add(to: composition, project: project) {
            inputs.append(parameters)
        }
        var audioMix: AVAudioMix?
        if !inputs.isEmpty {
            let mix = AVMutableAudioMix()
            mix.inputParameters = inputs
            audioMix = mix
        }
        return Rendered(composition: composition, videoComposition: videoComposition, audioMix: audioMix, renderSize: size)
    }
}

/// Writes a project's movie with AVFoundation's hardware encoder, off the main actor; only the progress and the cancel
/// check run on it, every 0.25 s (AVAssetExportSession has no progress callback before macOS 15). The export never
/// overwrites its input.
@MainActor
final class EditExporter {
    struct Result {
        let url: URL
        let seconds: Double
        let bytes: Int64
    }

    /// Where an export goes: the file chosen with Change… (its extension set to the format), else beside the movie,
    /// named after the recording's title ("cursor test 1.mp4") or `<movie>-edited` for a plain movie, with "-2", "-3"
    /// so an export never overwrites a file. `tools recorder export` names a GIF or WebM by the same rule.
    /// The MP4's likely size before it is made: screen exports measured at about 0.082 bits per pixel and frame at
    /// 60 fps with H.264 (1152 × 720 for 20 s gave 10.3 MB), HEVC about 40 % less. An estimate for the Export tab.
    nonisolated static func estimatedBytes(size: CGSize, lengthUs: Int64, codec: EditProject.Codec) -> Int64 {
        let bitsPerSecond = Double(size.width * size.height) * 60 * 0.082 * (codec == .hevc ? 0.6 : 1)
        return Int64(bitsPerSecond / 8 * Double(lengthUs) / 1_000_000)
    }

    nonisolated static func outputURL(for project: EditProject, format: EditProject.ExportFormat = .mp4) -> URL {
        if !project.export.output.isEmpty {
            return URL(fileURLWithPath: (project.export.output as NSString).expandingTildeInPath)
                .deletingPathExtension().appendingPathExtension(format.rawValue)
        }
        let source = URL(fileURLWithPath: project.source.video)
        let base = defaultName(for: project)
        let folder = source.deletingLastPathComponent()
        var candidate = folder.appendingPathComponent("\(base).\(format.rawValue)")
        var counter = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent("\(base)-\(counter).\(format.rawValue)")
            counter += 1
        }
        return candidate
    }

    /// The recording's title made safe for a file name, else `<movie>-edited`.
    nonisolated static func defaultName(for project: EditProject) -> String {
        let source = URL(fileURLWithPath: project.source.video)
        let manifest = source.deletingLastPathComponent().appendingPathComponent("recording.json")
        if let data = try? Data(contentsOf: manifest),
           let title = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["title"] as? String {
            let safe = title.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
                .trimmingCharacters(in: .whitespacesAndNewlines.union(CharacterSet(charactersIn: ".")))
            if !safe.isEmpty { return String(safe.prefix(80)) }
        }
        return source.deletingPathExtension().lastPathComponent + "-edited"
    }

    /// `isCancelled` is read every 0.25 s while the session runs; true stops it, removes the partial file and throws a
    /// CancellationError. Both closures run on the main actor; the rest (the cursor track, the composition, the files)
    /// does not.
    nonisolated static func export(project: EditProject, to url: URL, isCancelled: @escaping @MainActor () -> Bool = { false },
                                   onProgress: @escaping @MainActor (Double) -> Void) async throws -> Result {
        let started = Date()
        guard url.standardizedFileURL.path != URL(fileURLWithPath: project.source.video).standardizedFileURL.path else {
            throw ExportError.overwritesInput(url.path)
        }
        let asset = AVURLAsset(url: URL(fileURLWithPath: project.source.video))
        let zoom = ZoomState(project: project, cursor: CursorTrack.load(project.source.cursor))
        let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: zoom, maxHeight: project.export.maxHeight)
        let preset = project.export.codec == .hevc ? AVAssetExportPresetHEVCHighestQuality : AVAssetExportPresetHighestQuality
        guard let session = AVAssetExportSession(asset: rendered.composition, presetName: preset) else {
            throw ExportError.noSession(preset)
        }
        // Refused before any work, so a refused export leaves no partial file behind.
        if FileManager.default.fileExists(atPath: url.path) { throw ExportError.exists(url.path) }
        let partial = url.deletingPathExtension().appendingPathExtension("partial.mp4")
        try? FileManager.default.removeItem(at: partial)
        session.outputURL = partial
        session.outputFileType = .mp4
        session.videoComposition = rendered.videoComposition
        session.audioMix = rendered.audioMix
        session.shouldOptimizeForNetworkUse = true
        var watch: Task<Void, Never>?
        defer { watch?.cancel() }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
            // Started after the export: a cancel before it starts makes AVFoundation refuse the start.
            watch = Task { @MainActor in
                while !Task.isCancelled {
                    try? await Task.sleep(for: .milliseconds(250))
                    guard !Task.isCancelled else { return }
                    if isCancelled() { session.cancelExport() }
                    onProgress(Double(session.progress))
                }
            }
        }
        watch?.cancel()
        let cancelled = await MainActor.run { isCancelled() }
        if session.status == .cancelled || cancelled {
            try? FileManager.default.removeItem(at: partial)
            throw CancellationError()
        }
        guard session.status == .completed else {
            try? FileManager.default.removeItem(at: partial)
            throw ExportError.failed(session.error.map(explained) ?? "status \(session.status.rawValue)")
        }
        // The finished file appears under its name in one step, so a reader never sees half a movie.
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: partial)
            throw ExportError.exists(url.path)
        }
        try FileManager.default.moveItem(at: partial, to: url)
        await MainActor.run { onProgress(1) }
        let bytes = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? Int64) ?? 0
        return Result(url: url, seconds: Date().timeIntervalSince(started), bytes: bytes)
    }

    enum ExportError: LocalizedError {
        case overwritesInput(String)
        case noSession(String)
        case failed(String)
        case exists(String)

        var errorDescription: String? {
            switch self {
            case let .overwritesInput(path): "the export would overwrite its input \(path); pick another file"
            case let .noSession(preset): "AVFoundation has no export session for preset \(preset)"
            case let .failed(message): "the export failed: \(message)"
            case let .exists(path): "\(path) exists already; the export never overwrites a file"
            }
        }
    }
}
