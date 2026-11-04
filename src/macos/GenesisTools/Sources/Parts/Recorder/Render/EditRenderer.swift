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
        return FrameLook(view: view,
                         marks: marks, clicks: project.clicks,
                         cursor: Self.cursorMark(atSourceUs: sourceUs, track: cursor, settings: project.cursor ?? .init(),
                                                 videoWidth: Double(project.source.width)),
                         coverFocus: Self.coverFocus(atSourceUs: sourceUs, project: project, track: cursor, view: view),
                         frame: project.frame,
                         caption: project.captions.flatMap { settings in
                             guard settings.show, let captions, let line = captions.line(atSourceUs: sourceUs) else { return nil }
                             return CaptionMark(line: line, track: captions, settings: settings)
                         },
                         key: project.keys.flatMap { settings in
                             guard settings.show, let shown = cursor?.key(atMs: Double(sourceUs) / 1000, durationMs: settings.durationMs) else { return nil }
                             return KeyMark(label: shown.label, opacity: shown.opacity, settings: settings)
                         },
                         redactions: (project.redactions ?? []).filter { sourceUs >= $0.startUs && sourceUs < $0.endUs })
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

        var errorDescription: String? {
            switch self {
            case let .noVideoTrack(path): "\(path) has no video track"
            case .emptyEdit: "the edit keeps nothing of the movie"
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
    static func exportFps(nominal: Double) -> Double {
        guard nominal > 0 else { return 30 }
        return nominal > 31 ? 60 : nominal.rounded()
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
        let videoComposition = AVMutableVideoComposition(asset: composition) { request in
            let image = request.sourceImage
            let extent = image.extent
            let outUs = Int64((request.compositionTime.seconds * 1_000_000).rounded())
            let look = zoom.look(atOutput: outUs)
            let view = look.view
            var result = Looks.redact(look.redactions, on: image).cropped(to: extent)
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
            if let cursor {
                result = cursor.composited(over: result).cropped(to: CGRect(origin: .zero, size: size))
            }
            request.finish(with: result, context: nil)
        }
        videoComposition.renderSize = size
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))
        // The CI-filter initializer times frames by the source track; a screen recording has a variable rate, and a
        // sped-up clip packs its frames closer (2× gave 74 fps). Without a timing track `frameDuration` decides.
        videoComposition.sourceTrackIDForFrameTiming = kCMPersistentTrackID_Invalid

        var audioMix: AVAudioMix?
        if !audioOut.isEmpty {
            let mix = AVMutableAudioMix()
            mix.inputParameters = audioOut.enumerated().map { index, track in
                let parameters = AVMutableAudioMixInputParameters(track: track)
                let muted = project.audio.mutedTracks.contains(index)
                parameters.setVolume(muted ? 0 : Float(project.audio.volume), at: .zero)
                return parameters
            }
            audioMix = mix
        }
        return Rendered(composition: composition, videoComposition: videoComposition, audioMix: audioMix, renderSize: size)
    }
}

/// Writes a project's movie with AVFoundation's hardware encoder. Progress comes from a 0.25 s timer on the
/// session (AVAssetExportSession has no progress callback before macOS 15); the export never overwrites its input.
@MainActor
final class EditExporter {
    struct Result {
        let url: URL
        let seconds: Double
        let bytes: Int64
    }

    static func outputURL(for project: EditProject) -> URL {
        if !project.export.output.isEmpty {
            return URL(fileURLWithPath: (project.export.output as NSString).expandingTildeInPath)
        }
        let source = URL(fileURLWithPath: project.source.video)
        let base = source.deletingPathExtension().lastPathComponent + "-edited"
        let folder = source.deletingLastPathComponent()
        var candidate = folder.appendingPathComponent(base + ".mp4")
        var counter = 2
        while FileManager.default.fileExists(atPath: candidate.path) {
            candidate = folder.appendingPathComponent("\(base)-\(counter).mp4")
            counter += 1
        }
        return candidate
    }

    static func export(project: EditProject, to url: URL, onProgress: @escaping (Double) -> Void) async throws -> Result {
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
        let timer = Timer(timeInterval: 0.25, repeats: true) { _ in
            MainActor.assumeIsolated { onProgress(Double(session.progress)) }
        }
        RunLoop.main.add(timer, forMode: .common)
        defer { timer.invalidate() }
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { continuation.resume() }
        }
        guard session.status == .completed else {
            try? FileManager.default.removeItem(at: partial)
            throw ExportError.failed(session.error?.localizedDescription ?? "status \(session.status.rawValue)")
        }
        // The finished file appears under its name in one step, so a reader never sees half a movie.
        if FileManager.default.fileExists(atPath: url.path) {
            try? FileManager.default.removeItem(at: partial)
            throw ExportError.exists(url.path)
        }
        try FileManager.default.moveItem(at: partial, to: url)
        onProgress(1)
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
