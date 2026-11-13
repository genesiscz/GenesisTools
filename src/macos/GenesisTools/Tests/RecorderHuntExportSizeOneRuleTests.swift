import AVFoundation
import XCTest
@testable import GenesisToolsRecorder

/// The export's size has one rule (`EditRenderer.plannedOutput`): a full still (a poster, `still --full`, Save Frame)
/// is the size the export writes, the saved export size included, and the Export tab's size, file size and H.264 note
/// use the export's own frame rate instead of a fixed 60.
final class RecorderHuntExportSizeOneRuleTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("export-size-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A 2 s, 320 × 200 movie of grey frames at 30 fps, with no sound.
    private func makeMovie(at url: URL) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264,
                                                                          AVVideoWidthKey: 320, AVVideoHeightKey: 200])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        writer.startWriting()
        writer.startSession(atSourceTime: .zero)
        for frame in 0..<60 {
            try await input.waitUntilReady()
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

    /// `still --full` and `movie.poster()` said "the export's size" but dropped a saved export size: a 1280-wide
    /// export got a full-size poster.
    func testAFullStillFollowsTheSavedExportSize() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        var project = try await ProjectStore.load(path: movie.path).project
        project.export.size = .init(height: 100)
        try project.encoded().write(to: EditProject.projectURL(forVideo: movie))

        let full = try await RecorderRenders.still(source: movie.path, atSeconds: 0.5,
                                                   out: folder.appendingPathComponent("full.png").path, full: true)
        XCTAssertEqual(full["width"] as? Int, 160, "a full still has the saved export size")
        XCTAssertEqual(full["height"] as? Int, 100)

        // The export of the same edit writes the same size.
        let result = try await RecorderRenders.export(source: movie.path, out: folder.appendingPathComponent("out.mp4").path) { _ in }
        let tracks = try await AVURLAsset(url: result.url).loadTracks(withMediaType: .video)
        let exported = try await XCTUnwrap(tracks.first).load(.naturalSize)
        XCTAssertEqual(CGSize(width: full["width"] as? Int ?? 0, height: full["height"] as? Int ?? 0), exported,
                       "the poster and the movie it belongs to have one size")

        // A preview still keeps its own rule: the export's size does not reach it.
        let preview = try await RecorderRenders.still(source: movie.path, atSeconds: 0.5,
                                                      out: folder.appendingPathComponent("preview.png").path, full: false)
        XCTAssertEqual(preview["width"] as? Int, 320)
        XCTAssertEqual(preview["height"] as? Int, 200)
    }

    /// A full still of a size the export refuses fails as the export does, instead of writing a picture of another size.
    func testAFullStillOfASizeTheExportRefusesFails() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        var project = try await ProjectStore.load(path: movie.path).project
        project.export.size = .init(width: 300, height: 300)
        try project.encoded().write(to: EditProject.projectURL(forVideo: movie))
        do {
            _ = try await RecorderRenders.still(source: movie.path, atSeconds: 0.5,
                                                out: folder.appendingPathComponent("square.png").path, full: true)
            XCTFail("a 300 × 300 still of a 320 × 200 movie must be refused, as its export is")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("300×300"), error.localizedDescription)
        }
    }

    /// The Export tab assumed 60 fps and no fixed size: an 8 fps recording (exported at 30) read 2516 × 1626 with a
    /// false H.264 note, and a 1280-wide export read the same.
    func testThePlannedOutputUsesTheExportRateAndAFixedSize() {
        let source = CGSize(width: 3456, height: 2234)
        var settings = EditProject.ExportSettings()

        let slow = EditRenderer.plannedOutput(export: settings, source: source, aspect: nil, nominalFps: 8)
        XCTAssertEqual(slow.fps, 30)
        XCTAssertEqual(slow.canvas, source, "30 fps fits the whole picture into the H.264 budget")
        XCTAssertFalse(slow.budgetCapped)

        let fast = EditRenderer.plannedOutput(export: settings, source: source, aspect: nil, nominalFps: 60)
        XCTAssertEqual(fast.fps, 60)
        XCTAssertEqual(fast.canvas, CGSize(width: 2516, height: 1626))
        XCTAssertEqual(fast.unbudgeted, source, "what HEVC keeps")
        XCTAssertTrue(fast.budgetCapped)
        XCTAssertEqual(EditRenderer.plannedOutput(export: settings, source: source, aspect: nil, nominalFps: nil), fast,
                       "a rate not read yet guesses 60")

        // A 30 fps H.264 source of 4112 × 2570 budgets at 30, not at 60.
        let big = CGSize(width: 4112, height: 2570)
        let thirty = EditRenderer.plannedOutput(export: settings, source: big, aspect: nil, nominalFps: 29.97)
        XCTAssertEqual(thirty.canvas, EditRenderer.outputSizes(source: big, maxHeight: 0, aspect: nil, h264Fps: 30).canvas)
        XCTAssertGreaterThan(thirty.canvas.width, EditRenderer.outputSizes(source: big, maxHeight: 0, aspect: nil, h264Fps: 60).canvas.width)
        XCTAssertTrue(thirty.budgetCapped)

        settings.size = .init(width: 1280)
        let fixed = EditRenderer.plannedOutput(export: settings, source: source, aspect: nil, nominalFps: 60)
        XCTAssertEqual(fixed.canvas, CGSize(width: 1280, height: 828))
        XCTAssertFalse(fixed.budgetCapped, "a fixed size wins over the budget, so the tab shows no H.264 note")

        settings.size = nil
        settings.codec = .hevc
        let hevc = EditRenderer.plannedOutput(export: settings, source: source, aspect: nil, nominalFps: 60)
        XCTAssertEqual(hevc.canvas, source)
        XCTAssertFalse(hevc.budgetCapped)
    }

    func testTheSizeEstimateCountsTheExportsFrames() {
        let size = CGSize(width: 1280, height: 828)
        let thirty = EditExporter.estimatedBytes(size: size, lengthUs: 4_000_000, codec: .h264, fps: 30)
        let sixty = EditExporter.estimatedBytes(size: size, lengthUs: 4_000_000, codec: .h264, fps: 60)
        XCTAssertEqual(Double(thirty) * 2, Double(sixty), accuracy: 2)
    }

    /// The window reads the movie track's rate once, so the Export tab can use the export's rate.
    @MainActor
    func testTheEditorReadsTheMoviesFrameRate() async throws {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        let project = try await ProjectStore.load(path: movie.path).project
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("screen.edit.json")),
                                link: { nil })
        model.runTools = { _, _, _ in }
        let deadline = Date().addingTimeInterval(10)
        while model.sourceNominalFps == nil, Date() < deadline { try await Task.sleep(for: .milliseconds(20)) }
        let rate = try XCTUnwrap(model.sourceNominalFps, "the rate was read within 10 s")
        XCTAssertEqual(rate, 30, accuracy: 0.5)
        let plan = EditRenderer.plannedOutput(export: model.project.export, source: CGSize(width: 320, height: 200),
                                              aspect: nil, nominalFps: model.sourceNominalFps)
        XCTAssertEqual(plan.fps, 30)
    }
}
