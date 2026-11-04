import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins

/// The camera movie's frames for the renderer's Core Image handler, which only gets the screen's picture. One
/// `AVAssetReader` reads forward, so an export (which asks in order) decodes each camera frame once; a jump back or far
/// ahead (a seek while previewing) starts a new reader at that time. The handler runs on AVFoundation's own queues, so
/// every read holds the lock.
final class CameraFeed: @unchecked Sendable {
    /// The longest side of a decoded camera frame: a bubble is at most 60% of the short side of a 1080p canvas.
    static let maxSide = 720
    /// A jump of more than this ahead starts a new reader instead of decoding every frame between.
    static let seekAheadUs: Int64 = 2_000_000

    let camera: EditProject.Camera
    private let track: AVAssetTrack
    private let asset: AVURLAsset
    private let lock = NSLock()
    private var reader: AVAssetReader?
    private var output: AVAssetReaderTrackOutput?
    private var current: (us: Int64, image: CIImage)?
    private var upcoming: (us: Int64, image: CIImage)?
    private var finished = false

    private init(camera: EditProject.Camera, asset: AVURLAsset, track: AVAssetTrack) {
        self.camera = camera
        self.asset = asset
        self.track = track
    }

    /// Nil when the edit has no camera, the movie is missing or has no video (logged).
    static func make(project: EditProject) async -> CameraFeed? {
        guard let camera = project.camera, camera.show || !camera.hidden.isEmpty else { return nil }
        let url = camera.movieURL(video: project.source.video)
        guard FileManager.default.fileExists(atPath: url.path) else {
            HubPerf.log("recorder: camera movie \(url.path) is missing; no bubble")
            return nil
        }
        let asset = AVURLAsset(url: url)
        guard let track = try? await asset.loadTracks(withMediaType: .video).first else {
            HubPerf.log("recorder: camera movie \(url.path) has no video track; no bubble")
            return nil
        }
        return CameraFeed(camera: camera, asset: asset, track: track)
    }

    /// The bubble over `base` at a source moment, or `base` itself when the bubble is hidden there or the camera has
    /// no frame for it (before its start, after its end).
    func draw(atSourceUs sourceUs: Int64, on base: CIImage, canvas: CGSize) -> CIImage {
        guard camera.shows(atSourceUs: sourceUs), let frame = frame(atCameraUs: camera.cameraUs(atSourceUs: sourceUs))
        else { return base }
        return Self.bubble(camera, frame: frame, canvas: canvas).composited(over: base)
    }

    /// The newest camera frame at or before `us`; nil before the first frame or past the last by more than a frame.
    func frame(atCameraUs us: Int64) -> CIImage? {
        guard us >= 0 else { return nil }
        lock.lock()
        defer { lock.unlock() }
        if let current, us < current.us || us - current.us > Self.seekAheadUs {
            restart(at: us)
        } else if reader == nil {
            restart(at: us)
        }
        while true {
            if upcoming == nil { upcoming = read() }
            guard let next = upcoming, next.us <= us else { break }
            current = next
            upcoming = nil
        }
        if let current, finished, upcoming == nil, us - current.us > 100_000 { return nil }
        return current?.image
    }

    private func restart(at us: Int64) {
        reader?.cancelReading()
        current = nil
        upcoming = nil
        finished = false
        guard let reader = try? AVAssetReader(asset: asset) else {
            finished = true
            return
        }
        // Start a little before, so the frame shown at `us` (the one before it) is read too.
        let start = max(0, us - 200_000)
        reader.timeRange = CMTimeRange(start: CMTime(value: start, timescale: 1_000_000), duration: .positiveInfinity)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            finished = true
            return
        }
        reader.add(output)
        guard reader.startReading() else {
            HubPerf.log("recorder: camera reader did not start: \(reader.error?.localizedDescription ?? "no reason")")
            finished = true
            return
        }
        self.reader = reader
        self.output = output
    }

    private func read() -> (us: Int64, image: CIImage)? {
        guard !finished, let output, let sample = output.copyNextSampleBuffer(),
              let buffer = CMSampleBufferGetImageBuffer(sample) else {
            finished = true
            return nil
        }
        let time = CMSampleBufferGetPresentationTimeStamp(sample)
        var image = CIImage(cvPixelBuffer: buffer)
        let longest = max(image.extent.width, image.extent.height)
        if longest > CGFloat(Self.maxSide) {
            let scale = CGFloat(Self.maxSide) / longest
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }
        return (Int64((time.seconds * 1_000_000).rounded()), image)
    }

    /// The camera frame cut to the bubble's square (aspect fill), mirrored when asked, masked to its shape, with a
    /// soft shadow, in canvas pixels (Core Image counts y from the bottom).
    static func bubble(_ camera: EditProject.Camera, frame: CIImage, canvas: CGSize) -> CIImage {
        let top = camera.rect(canvas: canvas)
        let side = top.width
        let target = CGRect(x: top.minX, y: canvas.height - top.maxY, width: side, height: side)
        let extent = frame.extent
        guard extent.width > 0, extent.height > 0, side > 1 else { return CIImage.empty() }
        let scale = max(side / extent.width, side / extent.height)
        var image = frame.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY))
            .transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let scaled = CGSize(width: extent.width * scale, height: extent.height * scale)
        if camera.mirror {
            image = image.transformed(by: CGAffineTransform(scaleX: -1, y: 1).translatedBy(x: -scaled.width, y: 0))
        }
        image = image.transformed(by: CGAffineTransform(translationX: target.minX - (scaled.width - side) / 2,
                                                        y: target.minY - (scaled.height - side) / 2))
            .cropped(to: target)
        let mask = shapeMask(camera.shape, rect: target)
        let blend = CIFilter.blendWithMask()
        blend.inputImage = image
        blend.backgroundImage = CIImage.empty()
        blend.maskImage = mask
        let masked = blend.outputImage ?? image
        let shadow = mask.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 0), "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0.35),
        ])
            .applyingGaussianBlur(sigma: Double(side) * 0.03)
            .transformed(by: CGAffineTransform(translationX: 0, y: -side * 0.015))
        return masked.composited(over: shadow)
    }

    /// White inside the bubble's shape, clear outside.
    static func shapeMask(_ shape: EditProject.CameraShape, rect: CGRect) -> CIImage {
        let generator = CIFilter.roundedRectangleGenerator()
        generator.extent = rect
        generator.radius = Float(cornerRadius(shape, side: rect.width))
        generator.color = CIColor.white
        return generator.outputImage?.cropped(to: rect) ?? CIImage.empty()
    }

    static func cornerRadius(_ shape: EditProject.CameraShape, side: CGFloat) -> CGFloat {
        switch shape {
        case .circle: return side / 2
        case .rounded: return side * 0.2
        case .square: return side * 0.04
        }
    }
}
