import AVFoundation
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// A movie stored sideways with a 90° turn (a phone clip) opens and renders upright, as players and the TypeScript side
/// show it: the edit's source size is the upright size, and a rendered frame is upright too.
final class RecorderHuntRotatedMovieTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("rotated-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// 1 s at 30 fps, stored 320×180 with a red top quarter (rows 0-44 from the top) and a 90° turn.
    private func makeTurnedMovie() async throws -> URL {
        let url = folder.appendingPathComponent("screen.mp4")
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 320, AVVideoHeightKey: 180,
        ])
        input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 180, ty: 0)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<30 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 320, 180, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            if let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) {
                let row = CVPixelBufferGetBytesPerRow(buffer)
                for y in 0..<180 {
                    for x in 0..<320 {
                        let pixel = base + y * row + x * 4
                        let red = y < 45
                        pixel[0] = red ? 0 : 128
                        pixel[1] = red ? 0 : 128
                        pixel[2] = red ? 255 : 128
                        pixel[3] = 255
                    }
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
        return url
    }

    /// The red share of each edge of an image: which side the stored top quarter landed on.
    private func redEdge(_ image: CGImage) -> String {
        let width = image.width, height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let context = CGContext(data: &pixels, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        context?.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        func isRed(_ x: Int, _ yFromTop: Int) -> Bool {
            let i = (yFromTop * width + x) * 4
            return pixels[i] > 200 && pixels[i + 1] < 60
        }
        let edges = ["top": isRed(width / 2, 2), "bottom": isRed(width / 2, height - 3),
                     "left": isRed(2, height / 2), "right": isRed(width - 3, height / 2)]
        return edges.filter(\.value).map(\.key).sorted().joined(separator: ",")
    }

    func testATurnedMovieOpensAndRendersUpright() async throws {
        let movie = try await makeTurnedMovie()
        let project = try await ProjectStore.newProject(video: movie)
        XCTAssertEqual(project.source.width, 180, "the upright width")
        XCTAssertEqual(project.source.height, 320)

        // Where a player shows the red quarter: the movie as macOS plays it, upright.
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: movie))
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let upright = try await generator.image(at: CMTime(value: 15, timescale: 30)).image
        XCTAssertEqual(upright.width, 180)
        let expected = redEdge(upright)
        XCTAssertFalse(expected.isEmpty)

        let rendered = try await EditRenderer.render(project: project, asset: AVURLAsset(url: movie),
                                                     zoom: ZoomState(project: project, cursor: nil), maxHeight: 0)
        XCTAssertEqual(rendered.renderSize, CGSize(width: 180, height: 320))
        let frames = AVAssetImageGenerator(asset: rendered.composition)
        frames.videoComposition = rendered.videoComposition
        frames.requestedTimeToleranceBefore = .zero
        frames.requestedTimeToleranceAfter = .zero
        let frame = try await frames.image(at: CMTime(value: 15, timescale: 30)).image
        XCTAssertEqual(frame.width, 180)
        XCTAssertEqual(frame.height, 320)
        XCTAssertEqual(redEdge(frame), expected, "the rendered frame is upright, as the player shows the movie")
    }
}
