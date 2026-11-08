import AVFoundation
import CoreImage
import XCTest
@testable import GenesisToolsRecorder

/// Round 5 (item 5): a hidden part must cover every exported frame that shows what it hides. Editors found a
/// half-visible frame where two boxes join (the text scrolled from one box to the next), a box of a few frames that
/// never drew, and two open frames after a box that ended just before a cut. A screen recording writes a frame only
/// when something changes, so its last frame before a box's end can stay on screen after that end. This movie is made
/// up: grey, with white blocks only where the edit hides them, and one 150 ms hole in its frames at the join.
final class RecorderRedactionEdgeTests: XCTestCase {
    static let size = (width: 320, height: 180)
    /// White from 2.0 s until the frame at 3.95 s, which stays on screen until the next frame at 4.10 s.
    static let before = CGRect(x: 16, y: 18, width: 64, height: 54)
    /// White from the frame at 4.10 s to 6.0 s: the text scrolled here.
    static let after = CGRect(x: 96, y: 18, width: 64, height: 54)
    /// White on the one frame at 6.5 s, under a box of 10 ms.
    static let flash = CGRect(x: 256, y: 100, width: 48, height: 48)
    /// White from 7.0 to 9.0 s, where the first clip ends; its box ends 50 ms early, at 8.95 s.
    static let tail = CGRect(x: 176, y: 18, width: 64, height: 54)

    /// Frame times in 1/600 s: 30 fps, with no frame between 3.95 s and 4.10 s.
    static let frameTimes: [Int64] = ((0..<300).map { Int64($0) * 20 }.filter { $0 < 2370 || $0 > 2460 } + [2370, 2460]).sorted()

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
        for time in Self.frameTimes {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, Self.size.width, Self.size.height, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            guard let address = CVPixelBufferGetBaseAddress(buffer) else { continue }
            let base = address.assumingMemoryBound(to: UInt8.self)
            let row = CVPixelBufferGetBytesPerRow(buffer)
            memset(base, 100, CVPixelBufferGetDataSize(buffer))
            let seconds = Double(time) / 600
            var white: [CGRect] = []
            if seconds >= 2, seconds < 4 { white.append(Self.before) }
            if seconds >= 4, seconds < 6 { white.append(Self.after) }
            if time == 3900 { white.append(Self.flash) }
            if seconds >= 7, seconds < 9 { white.append(Self.tail) }
            for block in white {
                for y in Int(block.minY)..<Int(block.maxY) {
                    memset(base + y * row + Int(block.minX) * 4, 255, Int(block.width) * 4)
                }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: time, timescale: 600))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    /// Per exported frame, the brightest value inside each block (three points across it).
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

    private func box(_ id: String, _ block: CGRect, from: Int64, to: Int64) -> EditProject.Redaction {
        EditProject.Redaction(id: id, startUs: from, endUs: to, x: block.minX / Double(Self.size.width),
                              y: block.minY / Double(Self.size.height), width: block.width / Double(Self.size.width),
                              height: block.height / Double(Self.size.height), style: .black)
    }

    private func project(movie: URL) -> EditProject {
        var project = EditProject.whole(video: movie.path, durationUs: 10_000_000, width: Self.size.width, height: Self.size.height,
                                        cursor: nil, recording: nil)
        // The first clip ends at 9.0 s; a cut takes 9.0 to 9.5 s out.
        project.clips = [.init(id: "a", fromUs: 0, toUs: 9_000_000), .init(id: "b", fromUs: 9_500_000, toUs: 10_000_000)]
        return project
    }

    func testEveryFrameThatShowsAHiddenThingIsCoveredInTheExport() async throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("redaction-edges-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        let blocks = [Self.before, Self.after, Self.flash, Self.tail]

        // Positive control: without the boxes every secret shows.
        let plain = folder.appendingPathComponent("plain.mp4")
        _ = try await EditExporter.export(project: project(movie: movie), to: plain) { _ in }
        let open = try await brightness(plain, blocks: blocks)
        for index in blocks.indices {
            XCTAssertTrue(open.contains { $0.values[index] > 200 }, "block \(index) shows in the movie without boxes")
        }

        var edit = project(movie: movie)
        edit.redactions = [
            box("before", Self.before, from: 2_000_000, to: 4_000_000),
            box("after", Self.after, from: 4_000_000, to: 6_000_000),
            box("flash", Self.flash, from: 6_500_000, to: 6_510_000),
            box("tail", Self.tail, from: 7_000_000, to: 8_950_000),
        ]
        let out = folder.appendingPathComponent("hidden.mp4")
        _ = try await EditExporter.export(project: edit, to: out) { _ in }
        let frames = try await brightness(out, blocks: blocks)
        XCTAssertGreaterThan(frames.count, 250, "the export has its frames (30 fps)")
        let leaks = frames.filter { $0.values.contains { $0 > 115 } }
        XCTAssertTrue(leaks.isEmpty, "a hidden thing shows at \(leaks.map { String(format: "%.3f s %@", $0.seconds, $0.values.description) })")
        // The boxes drew: black over the join's text and over the flash's frame.
        XCTAssertTrue(frames.contains { $0.seconds > 4.0 && $0.seconds < 4.1 && $0.values[0] < 40 }, "the first box holds over the join")
        XCTAssertTrue(frames.contains { $0.values[2] < 40 }, "the 10 ms box drew")
    }

    /// The joins without a movie: snapMs moves an end to the cut and closes a short gap; 0 leaves both.
    func testSnapClosesShortHolesAtCutsAndBetweenPartsAndZeroLeavesThem() {
        var project = EditProject.whole(video: "/movies/demo.mp4", durationUs: 10_000_000, width: 320, height: 180, cursor: nil, recording: nil)
        project.clips = [.init(id: "a", fromUs: 0, toUs: 9_000_000), .init(id: "b", fromUs: 9_500_000, toUs: 10_000_000)]
        project.redactions = [box("one", Self.before, from: 2_000_000, to: 3_900_000), box("two", Self.after, from: 4_000_000, to: 6_000_000),
                              box("tail", Self.tail, from: 7_000_000, to: 8_800_000), box("late", Self.flash, from: 9_600_000, to: 9_700_000)]
        let drawn = RedactionEdges.effective(project, frames: nil)
        XCTAssertEqual(drawn.map(\.endUs), [4_000_000, 6_000_000, 9_000_000, 9_700_000])
        XCTAssertEqual(drawn.map(\.startUs), [2_000_000, 4_000_000, 7_000_000, 9_500_000], "a start 100 ms after a cut moves to it")
        project.redactionJoins = .init(snapMs: 0)
        XCTAssertEqual(RedactionEdges.effective(project, frames: nil), project.redactions, "snapMs 0 draws every part as placed")
    }

    func testASpotlightFadesOverItsFadeMsAndZeroIsHard() {
        var spot = box("s", Self.before, from: 1_000_000, to: 3_000_000)
        spot.style = .spotlight
        XCTAssertEqual(ZoomState.spotlightFade(spot, atSourceUs: 1_100_000), 0.5, accuracy: 0.001, "200 ms by default")
        spot.fadeMs = 0
        XCTAssertEqual(ZoomState.spotlightFade(spot, atSourceUs: 1_000_000), 1, "hard from its first frame")
        spot.fadeMs = 1000
        XCTAssertEqual(ZoomState.spotlightFade(spot, atSourceUs: 1_333_333), 0.5, accuracy: 0.01, "capped at a third of its length")
    }

    func testAPixelateCellIsItsOwnSizeOrTheDefault() {
        var part = box("p", Self.before, from: 0, to: 1_000_000)
        XCTAssertEqual(Looks.pixelCell(part, pictureHeight: 1080), 19.44, accuracy: 0.01)
        part.cell = 40
        XCTAssertEqual(Looks.pixelCell(part, pictureHeight: 1080), 40)
        part.cell = 1
        XCTAssertEqual(Looks.pixelCell(part, pictureHeight: 1080), 2, "at least 2 pixels")
    }
}
