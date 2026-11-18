import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO

/// A composition's video decoder. Sequential frames advance one reader; only a seek starts another.
final class MediaFeed: @unchecked Sendable {
    let asset: AVURLAsset
    let durationUs: Int64
    private let track: AVAssetTrack
    private let transform: CGAffineTransform
    private let camera: Bool
    private let sampleCursors: Bool
    private let lock = NSLock()
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var current: (us: Int64, image: CIImage)?
    private var upcoming: (us: Int64, image: CIImage)?
    private var requestedUs: Int64?
    private var finished = false

    init(asset: AVURLAsset, track: AVAssetTrack, durationUs: Int64 = 0, transform: CGAffineTransform = .identity,
         sampleCursors: Bool = false, camera: Bool = false) {
        self.asset = asset
        self.track = track
        self.durationUs = durationUs
        self.transform = transform
        self.sampleCursors = sampleCursors
        self.camera = camera
    }

    static func open(_ url: URL) async throws -> MediaFeed? {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
        let duration = try await asset.load(.duration)
        guard duration.isNumeric, duration > .zero else { return nil }
        let (transform, cursors) = try await track.load(.preferredTransform, .canProvideSampleCursors)
        let us = duration.convertScale(1_000_000, method: .roundHalfAwayFromZero).value
        guard us > 0 else { return nil }
        return MediaFeed(asset: asset, track: track, durationUs: us, transform: transform, sampleCursors: cursors)
    }

    /// Both the picture and the sound start at this instant of the video. Reduce an unbounded offset before
    /// converting milliseconds to microseconds, also when the very first frame is already on a later loop.
    func startUs(for layer: EditProject.MediaLayer) -> Int64 {
        let ms = Int64(max(0, layer.videoStartMs))
        if layer.loop {
            return (ms % durationUs) * 1000 % durationUs
        }
        return ms > durationUs / 1000 ? durationUs : min(durationUs, ms * 1000)
    }

    func frame(at us: Int64) -> CIImage? {
        guard us >= 0 else { return nil }
        lock.lock()
        defer { lock.unlock() }
        let seek = camera ? current.map { us < $0.us || us - $0.us > 2_000_000 } ?? (reader == nil)
            : requestedUs.map { us < $0 || us - $0 > 2_000_000 } ?? true
        if seek {
            restart(at: us)
        }
        requestedUs = us
        while true {
            if upcoming == nil { upcoming = read() }
            guard let next = upcoming, next.us <= us else { break }
            current = next
            upcoming = nil
        }
        // The camera vanishes at EOF. An ordinary video layer holds its last picture.
        if camera, let current, finished, upcoming == nil, us - current.us > 100_000 { return nil }
        return current?.image
    }

    private func restart(at us: Int64) {
        reader?.cancelReading()
        reader = nil
        output = nil
        current = nil
        upcoming = nil
        finished = true
        guard let reader = try? AVAssetReader(asset: asset) else { return }
        // A VFR layer can hold a single frame for seconds. Seek to its actual sample, including on a first
        // request at EOF. A format without sample cursors must decode forward from the beginning.
        var start = camera ? EditRenderer.us(max(0, us - 200_000)) : .zero
        if sampleCursors, let cursor = track.makeSampleCursor(presentationTimeStamp: EditRenderer.us(us)),
           cursor.presentationTimeStamp.isNumeric {
            start = CMTimeMaximum(.zero, cursor.presentationTimeStamp)
        }
        reader.timeRange = CMTimeRange(start: start, duration: .positiveInfinity)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { return }
        reader.add(output)
        guard reader.startReading() else {
            HubPerf.log("recorder: video reader did not start: \(reader.error?.localizedDescription ?? asset.url.lastPathComponent)")
            return
        }
        self.reader = reader
        self.output = output
        finished = false
    }

    private func read() -> (us: Int64, image: CIImage)? {
        guard !finished, let sample = output?.copyNextSampleBuffer(),
              let buffer = CMSampleBufferGetImageBuffer(sample) else {
            finished = true
            return nil
        }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        guard time.isNumeric, time.seconds.isFinite else {
            finished = true
            return nil
        }
        var image = CIImage(cvPixelBuffer: buffer)
        if camera {
            let longest = max(image.extent.width, image.extent.height)
            if longest > 720 {
                image = image.transformed(by: CGAffineTransform(scaleX: 720 / longest, y: 720 / longest))
            }
        } else if !transform.isIdentity {
            // A movie's display transform counts y from the top. Placement below normalizes its origin.
            let flip = CGAffineTransform(scaleX: 1, y: -1)
            image = image.transformed(by: flip.concatenating(transform).concatenating(flip))
        }
        return (time.convertScale(1_000_000, method: .roundHalfAwayFromZero).value, image)
    }
}

struct RenderWarnings {
    private var files = Set<URL>()
    private(set) var messages: [String] = []

    mutating func skipped(_ url: URL) {
        warn(url, "Skipped \(url.lastPathComponent). The file is missing or unreadable.")
    }

    mutating func noAudio(_ url: URL) {
        warn(url, "\(url.lastPathComponent) has no audio track.")
    }

    private mutating func warn(_ url: URL, _ message: String) {
        guard files.insert(url.standardizedFileURL).inserted else { return }
        messages.append(message)
        HubPerf.log("recorder: \(message)")
    }
}

struct MediaLayers {
    /// Open the container with the other files, but decode its pixels only when a visible frame needs them.
    private final class Still: @unchecked Sendable {
        private let lock = NSLock()
        private var source: CGImageSource?
        private var cached: CIImage?

        init?(_ url: URL) {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0 else { return nil }
            self.source = source
        }

        func image() -> CIImage? {
            lock.lock()
            defer { lock.unlock() }
            if let source {
                self.source = nil
                if let pixels = CGImageSourceCreateImageAtIndex(source, 0, nil) {
                    let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
                    let orientation = properties?[kCGImagePropertyOrientation] as? NSNumber
                    cached = CIImage(cgImage: pixels).oriented(forExifOrientation: orientation?.int32Value ?? 1)
                }
            }
            return cached
        }
    }

    private var images: [String: Still] = [:]
    private var videos: [String: (file: String, feed: MediaFeed)] = [:]
    private let folder: URL

    /// Committed placement or source changes replace the player item. Pure appearance changes can use its live frame.
    static func needsNewMovie(_ before: EditProject, _ after: EditProject) -> Bool {
        if before.camera?.corner != after.camera?.corner || before.camera?.x != after.camera?.x
            || before.camera?.y != after.camera?.y || before.camera?.margin != after.camera?.margin { return true }
        if (before.layers?.order ?? []) != (after.layers?.order ?? []) { return true }
        let old = before.layers?.media ?? [], new = after.layers?.media ?? []
        guard old != new else { return false }
        guard old.count == new.count else { return true }
        for (a, b) in zip(old, new) {
            if a.id != b.id || a.file != b.file || a.kind != b.kind { return true }
            if a.x != b.x || a.y != b.y || a.startUs != b.startUs || a.endUs != b.endUs { return true }
            let oldSound = a.kind == .video && a.videoSound && !a.hidden
            let newSound = b.kind == .video && b.videoSound && !b.hidden
            if oldSound != newSound { return true }
            if newSound, a.videoStartMs != b.videoStartMs || a.loop != b.loop { return true }
        }
        return false
    }

    init(project: EditProject, warnings: inout RenderWarnings) async {
        folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        var cached: [URL: Still] = [:]
        for layer in project.layers?.media ?? [] {
            let url = fileURL(layer.file)
            switch layer.kind {
            case .image:
                if let image = cached[url] ?? Still(url) {
                    cached[url] = image
                    images[layer.file] = image
                } else {
                    warnings.skipped(url)
                }
            case .video:
                if let feed = try? await MediaFeed.open(url) {
                    videos[layer.id] = (layer.file, feed)
                } else {
                    warnings.skipped(url)
                }
            }
        }
    }

    func fileURL(_ file: String) -> URL {
        URL(fileURLWithPath: file, relativeTo: folder).standardizedFileURL
    }

    func video(_ layer: EditProject.MediaLayer) -> MediaFeed? {
        guard let entry = videos[layer.id], entry.file == layer.file else { return nil }
        return entry.feed
    }

    func draw(_ layer: EditProject.MediaLayer, at us: Int64, on base: CIImage, canvas: CGSize) -> CIImage {
        guard !layer.hidden, layer.opacity > 0, us >= layer.startUs, us < layer.endUs else { return base }
        let frame: CIImage?
        switch layer.kind {
        case .image:
            frame = images[layer.file]?.image()
        case .video:
            guard let feed = video(layer) else { return base }
            let elapsed = us - layer.startUs
            let start = feed.startUs(for: layer)
            let at = layer.loop ? (elapsed % feed.durationUs + start) % feed.durationUs
                : min(start + min(elapsed, feed.durationUs - start), feed.durationUs - 1)
            frame = feed.frame(at: at)
        }
        guard var image = frame, image.extent.width > 0, image.extent.height > 0 else { return base }
        let extent = image.extent
        let width = layer.width * canvas.width
        let height = layer.shape == nil ? width * extent.height / extent.width : width
        let rect = CGRect(x: layer.x * canvas.width - width / 2, y: (1 - layer.y) * canvas.height - height / 2,
                          width: width, height: height)
        let scale = max(width / extent.width, height / extent.height)
        image = image.transformed(by: CGAffineTransform(translationX: -extent.midX, y: -extent.midY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
            .transformed(by: CGAffineTransform(translationX: rect.midX, y: rect.midY)).cropped(to: rect)
        if let shape = layer.shape {
            let blend = CIFilter.blendWithMask()
            blend.inputImage = image
            blend.maskImage = CameraFeed.shapeMask(shape, rect: rect)
            blend.backgroundImage = CIImage.empty()
            image = blend.outputImage ?? image
        }
        if layer.opacity < 1 {
            image = image.applyingFilter("CIColorMatrix", parameters: [
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: layer.opacity),
            ])
        }
        return image.composited(over: base).cropped(to: CGRect(origin: .zero, size: canvas))
    }
}
