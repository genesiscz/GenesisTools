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
    private let warnings: RenderWarnings?
    private let lock = NSLock()
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var current: (us: Int64, image: CIImage)?
    private var upcoming: (us: Int64, image: CIImage)?
    private var requestedUs: Int64?
    private var finished = false

    init(asset: AVURLAsset, track: AVAssetTrack, durationUs: Int64 = 0, transform: CGAffineTransform = .identity,
         sampleCursors: Bool = false, camera: Bool = false, warnings: RenderWarnings? = nil) {
        self.asset = asset
        self.track = track
        self.durationUs = durationUs
        self.transform = transform
        self.sampleCursors = sampleCursors
        self.camera = camera
        self.warnings = warnings
    }

    static func open(_ url: URL, warnings: RenderWarnings? = nil) async throws -> MediaFeed? {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { return nil }
        let duration = try await asset.load(.duration)
        guard duration.isNumeric, duration > .zero else { return nil }
        let (transform, cursors) = try await track.load(.preferredTransform, .canProvideSampleCursors)
        let us = duration.convertScale(1_000_000, method: .roundHalfAwayFromZero).value
        guard us > 0 else { return nil }
        return MediaFeed(asset: asset, track: track, durationUs: us, transform: transform, sampleCursors: cursors,
                         warnings: warnings)
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
        if camera, durationUs > 0, us > durationUs, us - durationUs > 100_000 { return nil }
        lock.lock()
        defer { lock.unlock() }
        let seek: Bool = camera
            ? (current.map { us < $0.us || us - $0.us > 2_000_000 } ?? (reader == nil))
            : (requestedUs.map { us < $0 || us - $0 > 2_000_000 } ?? true)
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
        guard let reader = try? AVAssetReader(asset: asset) else {
            warnings?.skipped(asset.url)
            return
        }
        // Pick a presentation sample at or before the request. With no usable cursor, AVFoundation's image seek
        // supplies the preceding frame without draining every decoded frame from the beginning of the asset.
        let requested = EditRenderer.us(us)
        var preceding: CMTime?
        if sampleCursors, let cursor = track.makeSampleCursor(presentationTimeStamp: requested) {
            if cursor.presentationTimeStamp > requested { _ = cursor.stepInPresentationOrder(byCount: -1) }
            if cursor.presentationTimeStamp.isNumeric, cursor.presentationTimeStamp <= requested {
                preceding = CMTimeMaximum(.zero, cursor.presentationTimeStamp)
            }
        }
        if preceding == nil, us > 0 {
            let generator = AVAssetImageGenerator(asset: asset)
            generator.requestedTimeToleranceBefore = .positiveInfinity
            generator.requestedTimeToleranceAfter = .zero
            if camera { generator.maximumSize = CGSize(width: 720, height: 720) }
            var actual = CMTime.invalid
            if let pixels = try? generator.copyCGImage(at: requested, actualTime: &actual),
               actual.isNumeric, actual <= requested {
                current = (actual.convertScale(1_000_000, method: .roundHalfAwayFromZero).value,
                           displayImage(CIImage(cgImage: pixels)))
            }
        }
        reader.timeRange = CMTimeRange(start: preceding ?? requested, duration: .positiveInfinity)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            warnings?.skipped(asset.url)
            return
        }
        reader.add(output)
        guard reader.startReading() else {
            if current == nil || reader.status == .failed { reportReadFailure(reader.error) }
            return
        }
        self.reader = reader
        self.output = output
        finished = false
    }

    private func read() -> (us: Int64, image: CIImage)? {
        guard !finished else { return nil }
        guard let sample = output?.copyNextSampleBuffer() else {
            finished = true
            if reader?.status == .failed { reportReadFailure(reader?.error) }
            return nil
        }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        guard let buffer = CMSampleBufferGetImageBuffer(sample), time.isNumeric, time.seconds.isFinite else {
            reportReadFailure(nil)
            finished = true
            return nil
        }
        return (time.convertScale(1_000_000, method: .roundHalfAwayFromZero).value, displayImage(CIImage(cvPixelBuffer: buffer)))
    }

    private func reportReadFailure(_ error: Error?) {
        current = nil
        warnings?.decodeFailed(asset.url, error: error)
    }

    private func displayImage(_ input: CIImage) -> CIImage {
        var image = input
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
        return image
    }
}

final class RenderWarnings: @unchecked Sendable {
    struct Entry: Hashable, Sendable {
        let file: URL
        let message: String
    }

    private let lock = NSLock()
    private var files = Set<URL>()
    private var stored: [Entry] = []
    private let changed: (@Sendable ([Entry]) -> Void)?

    init(changed: (@Sendable ([Entry]) -> Void)? = nil) { self.changed = changed }

    var entries: [Entry] { lock.withLock { stored } }

    func skipped(_ url: URL) {
        warn(url, "Skipped \(url.lastPathComponent). The file is missing or unreadable.")
    }

    func noAudio(_ url: URL) {
        warn(url, "\(url.lastPathComponent) has no audio track.")
    }

    func decodeFailed(_ url: URL, error: Error? = nil) {
        let reason = error.map { " \($0.localizedDescription)" } ?? ""
        warn(url, "Could not decode \(url.lastPathComponent).\(reason)")
    }

    private func warn(_ url: URL, _ message: String) {
        let file = url.standardizedFileURL
        let snapshot = lock.withLock { () -> [Entry]? in
            guard files.insert(file).inserted else { return nil }
            stored.append(Entry(file: file, message: message))
            return stored
        }
        guard let snapshot else { return }
        HubPerf.log("recorder: \(message)")
        changed?(snapshot)
    }
}

struct MediaLayers {
    /// Open the container with the other files, but decode its pixels only when a visible frame needs them.
    private final class Still: @unchecked Sendable {
        private let lock = NSLock()
        private let url: URL
        private let warnings: RenderWarnings
        private var source: CGImageSource?
        private let orientedSize: CGSize
        private var cached: CIImage?
        private var decodedLimit = 0

        init?(_ url: URL, warnings: RenderWarnings) {
            let read = [kCGImageSourceShouldCache: false] as CFDictionary
            guard let source = CGImageSourceCreateWithURL(url as CFURL, read), CGImageSourceGetCount(source) > 0 else { return nil }
            self.url = url
            self.warnings = warnings
            self.source = source
            let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
            let width = (properties?[kCGImagePropertyPixelWidth] as? NSNumber)?.doubleValue ?? 1
            let height = (properties?[kCGImagePropertyPixelHeight] as? NSNumber)?.doubleValue ?? 1
            let orientation = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
            orientedSize = (5...8).contains(orientation) ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
        }

        func image(width: CGFloat, square: Bool, canvas: CGSize) -> CIImage? {
            lock.lock()
            defer { lock.unlock() }
            let longest = max(1, orientedSize.width, orientedSize.height)
            let fittedSide = max(1, square ? min(orientedSize.width, orientedSize.height) : orientedSize.width)
            let needed = min(longest, width * longest / fittedSide, 2 * max(canvas.width, canvas.height))
            let limit = max(1, Int((needed / 64).rounded(.up)) * 64)
            guard let source, limit > decodedLimit else { return cached }
            let span = HubPerf.begin("recorder.layer.thumbnail", "\(url.lastPathComponent) \(limit) px")
            defer { span.end() }
            let options = [
                kCGImageSourceCreateThumbnailFromImageAlways: true,
                kCGImageSourceCreateThumbnailWithTransform: true,
                kCGImageSourceShouldCacheImmediately: true,
                kCGImageSourceThumbnailMaxPixelSize: limit,
            ] as CFDictionary
            if let pixels = CGImageSourceCreateThumbnailAtIndex(source, 0, options) {
                cached = CIImage(cgImage: pixels)
                decodedLimit = limit
            } else {
                self.source = nil
                warnings.decodeFailed(url)
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

    init(project: EditProject, warnings: RenderWarnings) async {
        folder = URL(fileURLWithPath: project.source.video).deletingLastPathComponent()
        var cached: [URL: Still] = [:]
        for layer in project.layers?.media ?? [] {
            let url = fileURL(layer.file)
            switch layer.kind {
            case .image:
                if let image = cached[url] ?? Still(url, warnings: warnings) {
                    cached[url] = image
                    images[layer.file] = image
                } else {
                    warnings.skipped(url)
                }
            case .video:
                if let feed = try? await MediaFeed.open(url, warnings: warnings) {
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
            frame = images[layer.file]?.image(width: layer.width * canvas.width, square: layer.shape != nil, canvas: canvas)
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
