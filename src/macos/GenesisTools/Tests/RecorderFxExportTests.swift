import AVFoundation
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// Round 4 fx-render: a transition must never show what a redaction hides or what a cut took out, in the EXPORT.
/// The lead found one exported frame at a cut with a phone number and an address unredacted (2026-11-07 16:1x) while
/// the sheet was clean. These tests export a made-up movie whose white blocks show only where the edit cuts or hides
/// them, and read every exported frame.
final class RecorderFxExportTests: XCTestCase {
    static let size = (width: 320, height: 180)
    /// Shows only in cut time (5.9 to 6.17 s), just before the second clip starts at 6.2 s and after the key frame at 6.0 s.
    static let cutSecret = CGRect(x: 32, y: 18, width: 96, height: 54)
    /// Shows from 3.0 to 5.0 s, the end of the first clip, under a redaction that ends exactly at the join.
    static let hiddenSecret = CGRect(x: 192, y: 18, width: 96, height: 54)

    private func makeMovie(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: Self.size.width, AVVideoHeightKey: Self.size.height,
            // A key frame every second and no B-frames, as a screen recorder writes: AVAssetImageGenerator then answers
            // a request inside its tolerance with the key frame before it (6.0 s for 6.2 s, measured on this file).
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
            guard let address = CVPixelBufferGetBaseAddress(buffer) else { continue }
            let base = address.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(buffer)
            memset(base, 100, CVPixelBufferGetDataSize(buffer))
            var white: [CGRect] = []
            if (177..<186).contains(frame) { white.append(Self.cutSecret) }
            if (90..<150).contains(frame) { white.append(Self.hiddenSecret) }
            for block in white {
                for y in Int(block.minY)..<Int(block.maxY) {
                    memset(base + y * row + Int(block.minX) * 4, 255, Int(block.width) * 4)
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    /// Per frame of `movie`, the brightest value inside each block (three points across it).
    private func brightness(_ movie: URL, blocks: [CGRect]) async throws -> [(seconds: Double, values: [Int])] {
        let asset = AVURLAsset(url: movie)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        reader.startReading()
        var frames: [(Double, [Int])] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
            guard let address = CVPixelBufferGetBaseAddress(buffer) else { continue }
            let base = address.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(buffer)
            let scaleX = Double(CVPixelBufferGetWidth(buffer)) / Double(Self.size.width)
            let scaleY = Double(CVPixelBufferGetHeight(buffer)) / Double(Self.size.height)
            let values = blocks.map { block in
                [(0.3, 0.3), (0.5, 0.5), (0.7, 0.7)].map { fx, fy in
                    let pixel = base + Int((block.minY + block.height * fy) * scaleY) * row + Int((block.minX + block.width * fx) * scaleX) * 4
                    return max(Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
                }.max() ?? 0
            }
            frames.append((CMSampleBufferGetPresentationTimeStamp(sample).seconds, values))
        }
        return frames
    }

    private func normalized(_ block: CGRect) -> (x: Double, y: Double, width: Double, height: Double) {
        (block.minX / Double(Self.size.width), block.minY / Double(Self.size.height), block.width / Double(Self.size.width),
         block.height / Double(Self.size.height))
    }

    func testNoTransitionShowsACutOrRedactedSecretInTheExport() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-secret-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        var project = EditProject.whole(video: movie.path, durationUs: 10_000_000, width: Self.size.width, height: Self.size.height,
                                        cursor: nil, recording: nil)
        // A sped-up first clip that ends at 5.0 s, then a normal one from 6.2 s: the join plays at 2.5 s.
        project.clips = [.init(id: "a", fromUs: 0, toUs: 5_000_000, speed: 2), .init(id: "b", fromUs: 6_200_000, toUs: 10_000_000)]
        let hidden = normalized(Self.hiddenSecret)
        project.redactions = [EditProject.Redaction(id: "r", startUs: 3_000_000, endUs: 5_000_000, x: hidden.x, y: hidden.y,
                                                    width: hidden.width, height: hidden.height, style: .black)]
        for kind in [EditProject.TransitionKind.crossfade, .zoom, .blur] {
            project.transitions = EditProject.Transitions(default: .init(kind: kind, ms: 500))
            let out = folder.appendingPathComponent("\(kind.rawValue).mp4")
            _ = try await EditExporter.export(project: project, to: out) { _ in }
            let frames = try await brightness(out, blocks: [Self.cutSecret, Self.hiddenSecret])
            XCTAssertGreaterThan(frames.count, 150, "\(kind): the export has its frames")
            // The picture there is grey (100) or the redaction's black; anything brighter is a white secret, even
            // dissolved half into grey (about 178) or into black (about 135).
            let leaks = frames.filter { $0.values.contains { $0 > 115 } }
            XCTAssertTrue(leaks.isEmpty, "\(kind): a secret shows at \(leaks.map { String(format: "%.3f s %@", $0.seconds, $0.values.description) })")
            // The transition did draw: after the join the outgoing still (its block redacted black) dissolves into grey.
            XCTAssertTrue(frames.contains { $0.seconds > 2.5 && $0.seconds < 2.75 && $0.values[1] > 20 && $0.values[1] < 95 }
                          || kind == .blur, "\(kind): the outgoing side dissolves after the join")
        }
    }
}
