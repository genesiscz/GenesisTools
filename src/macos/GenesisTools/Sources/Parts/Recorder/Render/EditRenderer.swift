import AVFoundation
import CoreImage
import Foundation

/// What the zoom filter reads for each frame. The window changes it when a zoom changes, and the next frame drawn
/// shows it, so dragging a zoom's focus never rebuilds the player item. One lock, held only to copy a value.
final class ZoomState: @unchecked Sendable {
    private let lock = NSLock()
    private var project: EditProject
    private var cursor: CursorTrack?

    init(project: EditProject, cursor: CursorTrack?) {
        self.project = project
        self.cursor = cursor
    }

    func update(_ project: EditProject) {
        lock.lock()
        self.project = project
        lock.unlock()
    }

    func view(atOutput outUs: Int64) -> ZoomCurve.View {
        lock.lock()
        let project = project
        let cursor = cursor
        lock.unlock()
        let sourceUs = TimelineMap.sourceTime(atOutput: outUs, in: project)
        return ZoomCurve.view(atSource: sourceUs, zooms: project.zooms, cursor: cursor)
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

    /// `maxHeight` 0 keeps the source size. The size is rounded to even pixels, which H.264 needs.
    static func renderSize(source: CGSize, maxHeight: Int) -> CGSize {
        let scale = maxHeight > 0 && source.height > CGFloat(maxHeight) ? CGFloat(maxHeight) / source.height : 1
        func even(_ value: CGFloat) -> CGFloat { max(2, (value * scale / 2).rounded(.down) * 2) }
        return CGSize(width: even(source.width), height: even(source.height))
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

        let size = renderSize(source: natural, maxHeight: maxHeight)
        let outputScale = size.height / natural.height
        let videoComposition = AVMutableVideoComposition(asset: composition) { request in
            let image = request.sourceImage
            let extent = image.extent
            let outUs = Int64((request.compositionTime.seconds * 1_000_000).rounded())
            let view = zoom.view(atOutput: outUs)
            var result = image
            if view.scale > 1.0005 {
                let rect = view.rect
                // Core Image counts y from the bottom; the project counts it from the top.
                let crop = CGRect(x: extent.minX + rect.minX * extent.width, y: extent.minY + (1 - rect.maxY) * extent.height,
                                  width: rect.width * extent.width, height: rect.height * extent.height)
                result = image.cropped(to: crop)
                    .transformed(by: CGAffineTransform(translationX: -crop.minX, y: -crop.minY))
                    .transformed(by: CGAffineTransform(scaleX: extent.width / crop.width, y: extent.height / crop.height))
            }
            if outputScale != 1 {
                result = result.transformed(by: CGAffineTransform(scaleX: outputScale, y: outputScale))
            }
            request.finish(with: result.cropped(to: CGRect(origin: .zero, size: size)), context: nil)
        }
        videoComposition.renderSize = size
        let fps = nominalFps > 0 ? min(Double(nominalFps), 60) : 30
        videoComposition.frameDuration = CMTime(value: 1, timescale: CMTimeScale(fps.rounded()))

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
        if FileManager.default.fileExists(atPath: url.path) { throw ExportError.exists(url.path) }
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
