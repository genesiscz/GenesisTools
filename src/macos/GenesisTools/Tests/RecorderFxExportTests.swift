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

    /// Shows from 6.2 s on, in the middle of the picture, under a redaction for the whole second clip.
    static let incomingSecret = CGRect(x: 112, y: 63, width: 96, height: 54)

    private func makeMovie(at url: URL, incoming: Bool = false) async throws {
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
            try await input.waitUntilReady()
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
            if incoming, frame >= 186 { white.append(Self.incomingSecret) }
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

    /// Per frame of `movie`, the brightest value anywhere in the picture (every fourth pixel of every fourth row).
    private func framePeaks(_ movie: URL) async throws -> [(seconds: Double, peak: Int)] {
        let asset = AVURLAsset(url: movie)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        reader.add(output)
        reader.startReading()
        var frames: [(Double, Int)] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
            guard let address = CVPixelBufferGetBaseAddress(buffer) else { continue }
            let base = address.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(buffer)
            var peak = 0
            for y in stride(from: 0, to: CVPixelBufferGetHeight(buffer), by: 4) {
                for x in stride(from: 0, to: CVPixelBufferGetWidth(buffer), by: 4) {
                    let pixel = base + y * row + x * 4
                    peak = max(peak, Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
                }
            }
            frames.append((CMSampleBufferGetPresentationTimeStamp(sample).seconds, peak))
        }
        return frames
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

    /// R5 3 export size: a 2698×1516 export came out of the H.264 budget unasked; a size asks for exact pixels.
    func testAnAskedSizeIsExactAndBothSidesMustKeepTheShape() throws {
        let source = CGSize(width: 2940, height: 1912)
        let height = EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: nil, h264Fps: 60, fixed: .init(height: 1080))
        XCTAssertEqual(height.canvas, CGSize(width: 1660, height: 1080), "the width follows the movie's shape, to even pixels")
        XCTAssertEqual(height.picture, height.canvas, "no frame: the picture is the canvas")
        let wide = EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .wide, h264Fps: 60, fixed: .init(width: 1920))
        XCTAssertEqual(wide.canvas, CGSize(width: 1920, height: 1080))
        let budget = EditRenderer.outputSizes(source: source, maxHeight: 0, aspect: .wide, h264Fps: 60)
        XCTAssertLessThan(budget.canvas.width, 3400, "without a size the budget still decides")
        XCTAssertNoThrow(try EditRenderer.checkSize(.init(width: 1920, height: 1080), source: source, aspect: .wide))
        XCTAssertThrowsError(try EditRenderer.checkSize(.init(width: 1920, height: 1080), source: source, aspect: nil),
                             "1920×1080 is not a 2940×1912 movie's shape")
    }

    /// Round 3 (2026-11-08): the live side of a transition is hidden by its own parts before the blend, as the still
    /// side is. They were laid over the blended frame, where the zoom transition draws the live picture grown (1.4x at
    /// the join), so the edges of a hidden block showed around its part, and the still's own picture under the live
    /// side's part was hidden too.
    func testTheLiveSideOfATransitionIsHiddenBeforeTheBlend() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-live-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie, incoming: true)
        var project = EditProject.whole(video: movie.path, durationUs: 10_000_000, width: Self.size.width, height: Self.size.height,
                                        cursor: nil, recording: nil)
        project.clips = [.init(id: "a", fromUs: 0, toUs: 2_900_000), .init(id: "b", fromUs: 6_200_000, toUs: 10_000_000)]
        let hidden = normalized(Self.incomingSecret)
        project.redactions = [EditProject.Redaction(id: "r", startUs: 6_200_000, endUs: 10_000_000, x: hidden.x, y: hidden.y,
                                                    width: hidden.width, height: hidden.height, style: .black)]
        for kind in [EditProject.TransitionKind.zoom, .crossfade] {
            project.transitions = EditProject.Transitions(default: .init(kind: kind, ms: 600))
            let out = folder.appendingPathComponent("\(kind.rawValue).mp4")
            _ = try await EditExporter.export(project: project, to: out) { _ in }
            let frames = try await framePeaks(out)
            XCTAssertGreaterThan(frames.count, 150, "\(kind): the export has its frames")
            // The white block dissolved half into the grey outgoing side is about 178. The moving edge of the black
            // part makes the encoder overshoot the grey by up to about 20 (117 to 120 measured), which is no block.
            let leaks = frames.filter { $0.peak > 150 }
            XCTAssertTrue(leaks.isEmpty, "\(kind): the hidden block shows at \(leaks.map { String(format: "%.3f s %d", $0.seconds, $0.peak) })")
        }
    }

    /// A long edit with many cuts reads two stills per join; the stills of joins already played must not stay in
    /// memory (100 joins of a 5K source kept about 12 GB), and a still is no larger than the render can show.
    func testTransitionStillsKeepOnlyTheLastFewAndNoMoreThanTheOutputShows() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-stills-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        let stills = TransitionStills(asset: AVURLAsset(url: movie))
        let extent = CGRect(x: 0, y: 0, width: Self.size.width, height: Self.size.height)
        for second in 0..<9 {
            XCTAssertNotNil(stills.image(atSourceUs: Int64(second) * 1_000_000, extent: extent), "a still at \(second) s")
        }
        XCTAssertLessThanOrEqual(stills.count, 4, "only the stills used last stay")
        XCTAssertNotNil(stills.image(atSourceUs: 8_000_000, extent: extent), "the newest still is still there")

        let source = CGSize(width: 5120, height: 2880), picture = CGSize(width: 1920, height: 1080)
        XCTAssertEqual(TransitionStills.maximumSize(source: source, picture: picture, zoomScale: 1), picture, "no zoom: the output's picture")
        XCTAssertEqual(TransitionStills.maximumSize(source: source, picture: picture, zoomScale: 2), CGSize(width: 3840, height: 2160),
                       "a 2x zoom shows the still twice as large")
        XCTAssertEqual(TransitionStills.maximumSize(source: source, picture: picture, zoomScale: 4), source, "never more than the source")
    }

    /// The lens draws on the finished picture (after the zoom and the output scale), so it never enlarges a still: a 4x
    /// lens on an edit without a zoom keeps the stills at the output's size.
    func testALensDoesNotEnlargeTheTransitionStills() {
        var project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 5120, height: 2880, cursor: nil, recording: nil)
        project.lens = EditProject.Lens(items: [.init(id: "l", startUs: 0, endUs: 1_000_000, magnification: 4)])
        let zoom = ZoomState(project: project, cursor: nil)
        XCTAssertEqual(zoom.largestZoomScale, 1, "a lens is no zoom")
        XCTAssertEqual(TransitionStills.maximumSize(source: CGSize(width: 5120, height: 2880), picture: CGSize(width: 1920, height: 1080),
                                                    zoomScale: zoom.largestZoomScale),
                       CGSize(width: 1920, height: 1080))
    }

    /// The size TransitionStills is built with is the size its generator reads, and a still read is no larger.
    func testTransitionStillsReadAtTheSizeTheyAreBuiltWith() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-stills-size-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        let half = CGSize(width: 160, height: 90)
        let stills = TransitionStills(asset: AVURLAsset(url: movie), maximumSize: half)
        XCTAssertEqual(stills.maximumSize, half, "the generator gets the size")
        let extent = CGRect(x: 0, y: 0, width: Self.size.width, height: Self.size.height)
        XCTAssertNotNil(stills.image(atSourceUs: 1_000_000, extent: extent, maximumSize: half))
        XCTAssertEqual(stills.readSize(atSourceUs: 1_000_000), half, "the still is read at that size")
    }

    /// The preview keeps its composition when a zoom changes (ZoomState.update), so a 2x zoom added over a fade must
    /// make the stills read at the new size, not keep the 1x stills drawn twice as large.
    func testTransitionStillsGrowWhenTheLargestZoomGrows() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-stills-grow-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        var project = EditProject.whole(video: movie.path, durationUs: 10_000_000, width: Self.size.width, height: Self.size.height,
                                        cursor: nil, recording: nil)
        let zoom = ZoomState(project: project, cursor: nil)
        let source = CGSize(width: Self.size.width, height: Self.size.height), picture = CGSize(width: 80, height: 45)
        let stills = TransitionStills(asset: AVURLAsset(url: movie),
                                      maximumSize: TransitionStills.maximumSize(source: source, picture: picture, zoomScale: zoom.largestZoomScale))
        let extent = CGRect(origin: .zero, size: source)
        func read() -> CGSize? {
            _ = stills.image(atSourceUs: 1_000_000, extent: extent,
                             maximumSize: TransitionStills.maximumSize(source: source, picture: picture, zoomScale: zoom.largestZoomScale))
            return stills.readSize(atSourceUs: 1_000_000)
        }
        XCTAssertEqual(read(), picture, "no zoom: the output's size")
        project.zooms = [EditProject.Zoom(id: "z", startUs: 0, endUs: 2_000_000, scale: 2)]
        zoom.update(project)
        XCTAssertEqual(zoom.largestZoomScale, 2)
        XCTAssertEqual(read(), CGSize(width: 160, height: 90), "the 2x zoom reads the still again at twice the size")
        XCTAssertEqual(stills.maximumSize, CGSize(width: 160, height: 90))
    }

    /// A crossfade into a clip that starts inside a canvas zoom blends the two sides' own canvases: the export still
    /// hides every secret, and the outgoing still (its block redacted black, no canvas zoom) dissolves after the join.
    func testACrossfadeIntoACanvasZoomBlendsEachSidesOwnCanvas() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("fx-canvas-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        var project = EditProject.whole(video: movie.path, durationUs: 10_000_000, width: Self.size.width, height: Self.size.height,
                                        cursor: nil, recording: nil)
        project.clips = [.init(id: "a", fromUs: 0, toUs: 5_000_000, speed: 2), .init(id: "b", fromUs: 6_200_000, toUs: 10_000_000)]
        let hidden = normalized(Self.hiddenSecret)
        project.redactions = [EditProject.Redaction(id: "r", startUs: 3_000_000, endUs: 5_000_000, x: hidden.x, y: hidden.y,
                                                    width: hidden.width, height: hidden.height, style: .black)]
        var zoom = EditProject.Zoom(id: "z", startUs: 5_500_000, endUs: 9_000_000, scale: 2, focusX: 0.25, focusY: 0.75)
        zoom.target = .canvas
        project.zooms = [zoom]
        project.transitions = EditProject.Transitions(default: .init(kind: .crossfade, ms: 500))
        let out = folder.appendingPathComponent("canvas.mp4")
        _ = try await EditExporter.export(project: project, to: out) { _ in }
        let frames = try await brightness(out, blocks: [Self.cutSecret, Self.hiddenSecret])
        XCTAssertGreaterThan(frames.count, 150, "the export has its frames")
        let leaks = frames.filter { $0.values.contains { $0 > 115 } }
        XCTAssertTrue(leaks.isEmpty, "a secret shows at \(leaks.map { String(format: "%.3f s %@", $0.seconds, $0.values.description) })")
        // The canvas zoom (focus on the lower left) would carry the black block out of its place; its own canvas keeps it.
        XCTAssertTrue(frames.contains { $0.seconds > 2.5 && $0.seconds < 2.75 && $0.values[1] > 20 && $0.values[1] < 95 },
                      "the outgoing still dissolves in its own place after the join")
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
