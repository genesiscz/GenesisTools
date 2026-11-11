import AVFoundation
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// In a zoom or blur transition the live side's shapes and click rings scale, wipe and blur with the live picture, as
/// its hidden parts already do. They were laid over the blended frame unscaled, so they slid off their targets.
final class RecorderHuntR2TransitionOverlaysPerSideTests: XCTestCase {
    static let size = (width: 320, height: 180)

    /// Ten seconds of flat grey at 30 fps.
    private func makeMovie(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Self.size.width, AVVideoHeightKey: Self.size.height,
            AVVideoCompressionPropertiesKey: [AVVideoMaxKeyFrameIntervalKey: 30, AVVideoAllowFrameReorderingKey: false],
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<300 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, Self.size.width, Self.size.height, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let address = CVPixelBufferGetBaseAddress(buffer) {
                memset(address, 100, CVPixelBufferGetDataSize(buffer))
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    /// The x of the red pixels' centre in the rendered frame at `seconds`, as a fraction of the width.
    private func redCentreX(_ project: EditProject, movie: URL, seconds: Double) async throws -> Double? {
        let asset = AVURLAsset(url: movie)
        let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: ZoomState(project: project, cursor: nil),
                                                     maxHeight: Self.size.height)
        let generator = AVAssetImageGenerator(asset: rendered.composition)
        generator.videoComposition = rendered.videoComposition
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = try XCTUnwrap(CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                              space: CGColorSpaceCreateDeviceRGB(),
                                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        var sum = 0.0, count = 0.0
        for y in 0..<height {
            for x in 0..<width {
                let i = (y * width + x) * 4
                if Int(pixels[i]) - Int(pixels[i + 1]) > 50 {
                    sum += Double(x)
                    count += 1
                }
            }
        }
        return count > 0 ? sum / count / Double(width) : nil
    }

    private func project(movie: URL, kind: EditProject.TransitionKind) -> EditProject {
        var project = EditProject.whole(video: movie.path, durationUs: 10_000_000, width: Self.size.width, height: Self.size.height,
                                        cursor: nil, recording: nil)
        project.clips = [.init(id: "a", fromUs: 0, toUs: 2_900_000), .init(id: "b", fromUs: 6_200_000, toUs: 10_000_000)]
        // A red box centred 0.2 of the width right of the picture's centre, on the outgoing clip only.
        project.shapes = [EditProject.Shape(id: "s", startUs: 0, endUs: 2_900_000, kind: .box, x1: 0.65, y1: 0.4, x2: 0.75, y2: 0.6,
                                            color: "#FF0000", width: 0.02, appear: EditProject.ShapeAppear.none)]
        project.transitions = EditProject.Transitions(default: .init(kind: kind, ms: 2000))
        return project
    }

    func testAZoomTransitionScalesTheLiveSidesShapeWithItsPicture() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-side-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        // Output 2.7 s sits in the outgoing half (the join is at 2.9 s, the transition runs 1.9 to 3.9 s): progress
        // 0.4, so the outgoing picture is scaled 1 + 0.6 x smooth(0.4) = 1.21 about the centre. The box is still whole
        // there: it fades out over the last 0.2 s before the cut.
        let seconds = 81.0 / 30
        let p = TransitionLook.smooth((seconds - 1.9) / 2)
        let zoomed = try await redCentreX(project(movie: movie, kind: .zoom), movie: movie, seconds: seconds)
        XCTAssertEqual(try XCTUnwrap(zoomed), 0.5 + 0.2 * (1 + 0.6 * p), accuracy: 0.012, "the box grows away from the centre with its picture")
        // Control: a crossfade does not scale, so the box stays where it is.
        let faded = try await redCentreX(project(movie: movie, kind: .crossfade), movie: movie, seconds: seconds)
        XCTAssertEqual(try XCTUnwrap(faded), 0.7, accuracy: 0.012)
    }

    func testOneSidesScaleAndBlurComeFromOnePlace() {
        let extent = CGRect(x: 0, y: 0, width: 320, height: 180)
        var mark = TransitionLook.Mark(kind: .zoom, progress: 0.25, incoming: false, otherSourceUs: 0, otherRedactions: [])
        let p = TransitionLook.smooth(0.25)
        XCTAssertEqual(TransitionLook.side(mark, live: true, extent: extent).scale, 1 + 0.6 * p, accuracy: 0.0001)
        XCTAssertEqual(TransitionLook.side(mark, live: false, extent: extent).scale, 1 + 0.4 * (1 - p), accuracy: 0.0001)
        mark.incoming = true
        XCTAssertEqual(TransitionLook.side(mark, live: true, extent: extent).scale, 1 + 0.4 * (1 - p), accuracy: 0.0001)
        mark.kind = .blur
        XCTAssertEqual(TransitionLook.side(mark, live: true, extent: extent).scale, 1)
        XCTAssertEqual(TransitionLook.side(mark, live: true, extent: extent).blur, sin(.pi * 0.25) * 180 * 0.018, accuracy: 0.0001)
        mark.kind = .crossfade
        XCTAssertEqual(TransitionLook.side(mark, live: true, extent: extent).blur, 0)
    }
}
