import AVFoundation
import XCTest
@testable import GenesisToolsRecorder

/// A frames or meeting recording writes no settings.video.durationMs, so its library card had no length and its hover
/// scrub stayed in the first 0.1 s of its proxy movie. The card reads the movie's own length when the recorder wrote none.
final class RecorderHuntR2LibraryCardLengthFramesTests: XCTestCase {
    private var library: URL!

    override func setUp() async throws {
        library = FileManager.default.temporaryDirectory.appendingPathComponent("library-length-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: library, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: library)
    }

    /// A 2 s, 320 × 200 movie of grey frames with no sound.
    private func makeMovie(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                          AVVideoWidthKey: 320, AVVideoHeightKey: 200])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<60 {
            while !input.isReadyForMoreMediaData { try await Task.sleep(for: .milliseconds(5)) }
            var buffer: CVPixelBuffer?
            CVPixelBufferCreate(nil, 320, 200, kCVPixelFormatType_32BGRA, nil, &buffer)
            guard let buffer else { continue }
            CVPixelBufferLockBaseAddress(buffer, [])
            memset(CVPixelBufferGetBaseAddress(buffer), Int32(60 + frame), CVPixelBufferGetDataSize(buffer))
            CVPixelBufferUnlockBaseAddress(buffer, [])
            adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(frame), timescale: 30))
        }
        input.markAsFinished()
        await writer.finishWriting()
    }

    private func folder(_ name: String, manifest: String) throws -> URL {
        let dir = library.appendingPathComponent(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(manifest.utf8).write(to: dir.appendingPathComponent("recording.json"))
        return dir
    }

    /// The defect: a frames recording with a 2 s proxy.mp4 and no settings.video had durationMs nil.
    func testAFramesRecordingWithAProxyReadsTheProxyLength() async throws {
        let dir = try folder("frames-2026-11-09_10-00-00-aaaa0001",
                             manifest: #"{"title":"Frames","startedAt":"2026-11-09T09:00:00.000Z","frames":[],"settings":{"activeFps":2}}"#)
        try await makeMovie(at: dir.appendingPathComponent("proxy.mp4"))

        let item = try XCTUnwrap(RecorderMenu.readRecents(library).first)
        let length = try XCTUnwrap(item.durationMs, "the card names the proxy's length")
        XCTAssertEqual(length, 2000, accuracy: 50)
    }

    /// A video recording keeps the length its recorder wrote, even when the movie says otherwise.
    func testARecorderWrittenLengthWins() async throws {
        let dir = try folder("video-2026-11-09_10-00-00-aaaa0002",
                             manifest: #"{"title":"Video","startedAt":"2026-11-09T09:00:00.000Z","frames":[],"settings":{"video":{"durationMs":31000}}}"#)
        try await makeMovie(at: dir.appendingPathComponent("screen.mp4"))

        XCTAssertEqual(try XCTUnwrap(RecorderMenu.readRecents(library).first).durationMs, 31000)
    }

    /// A frames recording with no movie yet, or a file that is not a movie, has no length rather than a zero one.
    func testNoMovieOrABrokenMovieHasNoLength() throws {
        _ = try folder("frames-2026-11-09_10-00-00-aaaa0003",
                       manifest: #"{"title":"No proxy","startedAt":"2026-11-09T09:00:00.000Z","frames":[],"settings":{}}"#)
        let broken = try folder("frames-2026-11-09_10-00-00-aaaa0004",
                                manifest: #"{"title":"Broken","startedAt":"2026-11-09T08:00:00.000Z","frames":[],"settings":{}}"#)
        try Data("not a movie".utf8).write(to: broken.appendingPathComponent("proxy.mp4"))

        let items = RecorderMenu.readRecents(library)
        XCTAssertEqual(items.count, 2)
        XCTAssertTrue(items.allSatisfy { $0.durationMs == nil })
        XCTAssertNil(RecordingMovie.lengthMs(broken.appendingPathComponent("proxy.mp4")))
    }

    /// PR #752 review: every library refresh (an edit or a comment on any recording) loaded each proxy's length again,
    /// up to 3 s a movie. The length is kept per version of the file: the same file is not read again, a changed one is.
    func testAKeptLengthIsReusedUntilTheMovieChanges() async throws {
        let dir = try folder("frames-2026-11-09_10-00-00-aaaa0005",
                             manifest: #"{"title":"Kept","startedAt":"2026-11-09T09:00:00.000Z","frames":[],"settings":{}}"#)
        let proxy = dir.appendingPathComponent("proxy.mp4")
        try await makeMovie(at: proxy)
        // A whole-second date: setting it again after the rewrite gives back the same date (the file system keeps
        // nanoseconds, setAttributes writes fewer).
        let written = Date(timeIntervalSince1970: 1_800_000_000)
        try FileManager.default.setAttributes([.modificationDate: written], ofItemAtPath: proxy.path)
        XCTAssertEqual(try XCTUnwrap(RecordingMovie.lengthMs(proxy)), 2000, accuracy: 50)

        // The same bytes count and modification date, in place: an asset load would now read no movie at all.
        let size = try XCTUnwrap((FileManager.default.attributesOfItem(atPath: proxy.path)[.size] as? NSNumber)?.intValue)
        let handle = try FileHandle(forWritingTo: proxy)
        try handle.write(contentsOf: Data(count: size))
        try handle.close()
        try FileManager.default.setAttributes([.modificationDate: written], ofItemAtPath: proxy.path)
        XCTAssertEqual(try XCTUnwrap(RecordingMovie.lengthMs(proxy), "the kept length, no second read"), 2000, accuracy: 50)
        XCTAssertEqual(try XCTUnwrap(RecorderMenu.readRecents(library).first?.durationMs), 2000, accuracy: 50)

        // A newer modification date is a new version of the file: it is read again.
        try FileManager.default.setAttributes([.modificationDate: written.addingTimeInterval(60)], ofItemAtPath: proxy.path)
        XCTAssertNil(RecordingMovie.lengthMs(proxy))
    }
}
