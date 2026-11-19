import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins

/// The camera keeps its bubble geometry and 720-pixel decode scale when it shares a reader with video layers.
final class CameraFeed: Sendable {
    private let feed: MediaFeed

    private init(feed: MediaFeed) { self.feed = feed }

    static func make(project: EditProject, warnings: RenderWarnings? = nil) async -> CameraFeed? {
        guard let camera = project.camera else { return nil }
        let url = camera.movieURL(video: project.source.video)
        // Keep the asset alive for the lifetime of the reader.
        let asset = AVURLAsset(url: url)
        guard let video = try? await asset.loadTracks(withMediaType: .video).first else { return nil }
        let cursors = (try? await video.load(.canProvideSampleCursors)) ?? false
        let duration = try? await asset.load(.duration)
        let durationUs = duration.flatMap { $0.isNumeric ? $0.convertScale(1_000_000, method: .roundHalfAwayFromZero).value : nil } ?? 0
        return CameraFeed(feed: MediaFeed(asset: asset, track: video, durationUs: durationUs, sampleCursors: cursors,
                                          camera: true, warnings: warnings))
    }

    func draw(_ camera: EditProject.Camera, atSourceUs sourceUs: Int64, on base: CIImage, canvas: CGSize) -> CIImage {
        guard camera.shows(atSourceUs: sourceUs),
              let frame = feed.frame(at: camera.cameraUs(atSourceUs: sourceUs)) else { return base }
        return Self.bubble(camera, frame: frame, canvas: canvas).composited(over: base)
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
