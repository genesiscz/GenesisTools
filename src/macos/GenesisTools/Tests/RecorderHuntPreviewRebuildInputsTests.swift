import AVFoundation
import XCTest
@testable import GenesisToolsRecorder

/// The editor's preview makes its movie again when an input changes that the renderer reads once per build (the canvas,
/// the click sound, the camera movie), and its captions follow a transcript written outside the window.
@MainActor
final class RecorderHuntPreviewRebuildInputsTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("preview-inputs-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A 2 s, 320 × 200 movie of grey frames with no sound.
    private func makeMovie(at url: URL, type: AVFileType = .mp4) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: type)
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

    private func until(_ what: String, timeout: TimeInterval = 5, _ condition: () -> Bool) async throws {
        let deadline = Date().addingTimeInterval(timeout)
        while !condition() {
            guard Date() < deadline else {
                XCTFail("timed out after \(timeout) s waiting until \(what)")
                return
            }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    /// A window on the movie with no recorder service; its `tools recorder apply` never answers, so a change stays drawn.
    private func openModel(_ project: EditProject) async throws -> EditorModel {
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("screen.edit.json")),
                                link: { nil })
        model.runTools = { _, _, _ in }
        try await until("the preview has its first movie", timeout: 10) { model.player.currentItem?.videoComposition != nil }
        return model
    }

    private func screenProject(cursor: String? = nil) async throws -> EditProject {
        let movie = folder.appendingPathComponent("screen.mp4")
        try await makeMovie(at: movie)
        return EditProject.whole(video: movie.path, durationUs: 2_000_000, width: 320, height: 200, cursor: cursor, recording: nil)
    }

    func testACursorOffRecordingStartsHiddenAndKeepsItsClickTrack() async throws {
        let project = try await screenProject()
        try Data(#"{"settings":{"cursor":"none"}}"#.utf8).write(to: folder.appendingPathComponent("recording.json"))
        try Data("{\"t\":0,\"x\":0.4,\"y\":0.5,\"click\":\"left\"}\n".utf8)
            .write(to: folder.appendingPathComponent("cursor.jsonl"))
        let opened = try await ProjectStore.newProject(video: URL(fileURLWithPath: project.source.video))
        let cursor = try XCTUnwrap(opened.cursor)
        XCTAssertFalse(cursor.show)
        let track = try XCTUnwrap(CursorTrack.load(opened.source.cursor))
        XCTAssertEqual(track.clicks.count, 1)
        XCTAssertEqual(track.clicks.first?.x, 0.4)
        XCTAssertNil(ZoomState.cursorMark(atSourceUs: 0, track: track, settings: cursor, videoWidth: 320))
    }

    /// One rule decides every rebuild of the preview: the window's own changes, the service's answers, undo and redo,
    /// and outside edits.
    func testTheMovieIsMadeAgainOnlyForWhatTheRendererReadsOnce() {
        let base = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        func changed(_ build: (inout EditProject) -> Void) -> Bool {
            var next = base
            build(&next)
            return EditorModel.needsNewMovie(base, next) && EditorModel.needsNewMovie(next, base)
        }
        XCTAssertFalse(changed { _ in }, "the same edit")
        XCTAssertTrue(changed { $0.frame = EditProject.Frame(aspect: .portrait) }, "the canvas shape sizes the render")
        XCTAssertFalse(changed { $0.frame = EditProject.Frame(aspect: .source) }, "the movie's own shape is no frame's shape")
        XCTAssertTrue(changed { $0.clicks = EditProject.Clicks(sound: true) }, "the click sound is a track of the sound")
        XCTAssertFalse(changed { $0.clicks = EditProject.Clicks(color: "#FF0000") }, "the click rings are drawn per frame")
        XCTAssertFalse(changed { $0.clicks = EditProject.Clicks(sound: false) }, "a click sound that is off adds no track")
        XCTAssertTrue(changed { $0.camera = EditProject.Camera(file: "camera.mov") }, "a camera added opens its movie")
        XCTAssertTrue(changed { $0.export.codec = .hevc }, "the codec moves the H.264 pixel budget")
        XCTAssertTrue(changed { $0.audio.volume = 0.5 }, "the sound")
        XCTAssertTrue(changed { $0.clips[0].toUs = 5_000_000 }, "a cut")
        XCTAssertTrue(changed { $0.clips[0].speed = 2 }, "a speed")
        XCTAssertFalse(changed { $0.clips[0].id = "other" }, "a clip id is not drawn")
        XCTAssertFalse(changed { $0.texts = [EditProject.TextNote(id: "t1", startUs: 0, endUs: 1_000_000, text: "Hello")] },
                       "a text is drawn per frame")
        XCTAssertFalse(changed { $0.frame = EditProject.Frame(); $0.frame?.padding = 0.2 }, "the frame's look is drawn per frame")

        var withCamera = base
        withCamera.camera = EditProject.Camera(file: "camera.mov")
        var otherMovie = withCamera
        otherMovie.camera?.file = "other.mov"
        XCTAssertTrue(EditorModel.needsNewMovie(withCamera, otherMovie), "another camera movie")
        var moved = withCamera
        moved.camera?.size = 0.4
        XCTAssertFalse(EditorModel.needsNewMovie(withCamera, moved), "the bubble's size is drawn per frame")
    }

    func testATranscriptReachesThePreviewsSoundOnlyUnderDuckingMusic() {
        var project = EditProject.whole(video: "/tmp/none.mp4", durationUs: 10_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        XCTAssertFalse(EditorModel.transcriptAffectsSound(project), "no music")
        project.audio.music = EditProject.Music(file: "/tmp/none.m4a")
        XCTAssertTrue(EditorModel.transcriptAffectsSound(project), "the music ducks under speech by default")
        project.audio.ducking = EditProject.Ducking(transcript: false)
        XCTAssertFalse(EditorModel.transcriptAffectsSound(project), "the ducking ignores the transcript")
    }

    // Hunt round 1, preview-canvas-aspect-stale: Style > Canvas 9:16 kept the preview's 16:9 render, because only a cut
    // or a sound change made the movie again.
    func testACanvasChangeMakesThePreviewAtTheNewCanvas() async throws {
        let model = try await openModel(try await screenProject())
        defer { model.close() }
        let expected = EditRenderer.outputSizes(source: CGSize(width: 320, height: 200), maxHeight: 1440, aspect: .portrait).canvas

        model.setLooks { project in
            project.frame = project.frame ?? EditProject.Frame()
            project.frame?.aspect = .portrait
        }

        try await until("the preview renders the 9:16 canvas") { model.player.currentItem?.videoComposition?.renderSize == expected }
        XCTAssertEqual(model.player.currentItem?.videoComposition?.renderSize, expected)
    }

    // Hunt round 1, preview-audio-built-once: the Click sound switch (or an agent's clicks op) left the preview without
    // ticks until an unrelated cut or volume change, and turning it off kept them playing.
    func testTheClickSoundFollowsItsSwitchInThePreview() async throws {
        let cursor = folder.appendingPathComponent("cursor.jsonl")
        try Data("""
        {"t":0.0,"x":0.5,"y":0.5}
        {"t":500.0,"x":0.5,"y":0.5,"click":"left"}
        {"t":1500.0,"x":0.6,"y":0.5,"click":"left"}

        """.utf8).write(to: cursor)
        let model = try await openModel(try await screenProject(cursor: cursor.path))
        defer { model.close() }
        XCTAssertNil(model.player.currentItem?.audioMix, "a silent movie without the click sound has no sound to mix")

        var on = model.project
        on.clicks = EditProject.Clicks(highlight: false, sound: true)
        on.revision += 1
        model.adoptExternal(on)
        try await until("the ticks are in the preview's sound") { model.player.currentItem?.audioMix?.inputParameters.count == 1 }

        var off = model.project
        off.clicks?.sound = nil
        off.revision += 1
        model.adoptExternal(off)
        try await until("the ticks leave the preview's sound") { model.player.currentItem?.audioMix == nil }
    }

    // Hunt round 1, preview-camera-feed-built-once: a camera added to an edit opened without one (or a new camera movie)
    // drew the bubble's outline over a preview that never opened the camera movie.
    func testACameraMovieAddedFromOutsideMakesThePreviewAgain() async throws {
        try await makeMovie(at: folder.appendingPathComponent("camera.mov"), type: .mov)
        let model = try await openModel(try await screenProject())
        defer { model.close() }
        let first = try XCTUnwrap(model.player.currentItem)

        var next = model.project
        next.camera = EditProject.Camera(file: "camera.mov")
        next.revision += 1
        model.adoptExternal(next)

        try await until("the preview has a new movie with the camera") {
            model.player.currentItem.map { $0 !== first && $0.videoComposition != nil } ?? false
        }
    }

    private func writeTranscript(_ lines: [(text: String, start: Double, end: Double)], replacing: Bool = false) throws {
        let segments = lines.map { ["text": $0.text, "start": $0.start, "end": $0.end] as [String: Any] }
        let data = try JSONSerialization.data(withJSONObject: ["segments": segments])
        let target = folder.appendingPathComponent("screen.transcript.json")
        guard replacing else { return try data.write(to: target) }
        // `tools transcribe -o` may replace the file in one step: written beside it, then renamed over it.
        let partial = folder.appendingPathComponent("screen.transcript.partial.json")
        try data.write(to: partial)
        _ = try FileManager.default.replaceItemAt(target, withItemAt: partial)
    }

    /// A window on a movie that is not there (no preview needed) with a transcript cached beside it.
    private func transcriptModel() throws -> EditorModel {
        try writeTranscript([("Hello there", 1, 2), ("Second line", 3, 4)])
        let project = EditProject.whole(video: folder.appendingPathComponent("screen.mp4").path, durationUs: 10_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("screen.edit.json")),
                                link: { nil })
        model.runTools = { _, _, _ in }
        return model
    }

    // Hunt round 1, editor-captions-not-reloaded: `movie.transcript({ refresh: true })` rewrote the transcript while the
    // window kept drawing the old lines, which only its own Transcribe button read again.
    func testATranscriptWrittenAgainOutsideTheWindowReachesItsCaptions() async throws {
        let model = try transcriptModel()
        defer { model.close() }
        XCTAssertEqual(model.zoom.captionLines.map(\.text), ["Hello there", "Second line"])
        model.lineWords = []

        try writeTranscript([("Hello there", 1, 2), ("Brand new words", 3, 4)], replacing: true)

        try await until("the captions show the new line") { model.zoom.captionLines.map(\.text) == ["Hello there", "Brand new words"] }
        XCTAssertEqual(model.zoom.captionLines, ZoomState(project: model.project, cursor: nil).captionLines,
                       "the window draws what still() and the export read")
        XCTAssertNil(model.lineWords, "the word picker reads the new words")
        XCTAssertTrue(model.hasTranscript)

        // Written again in place, the way Bun.write does it.
        try writeTranscript([("Written in place", 1, 2)])
        try await until("the captions show the rewritten file") { model.zoom.captionLines.map(\.text) == ["Written in place"] }
    }

    func testADeletedTranscriptTakesTheCaptionsAway() async throws {
        let model = try transcriptModel()
        defer { model.close() }
        XCTAssertTrue(model.hasTranscript)

        try FileManager.default.removeItem(at: folder.appendingPathComponent("screen.transcript.json"))

        try await until("the captions are gone") { !model.hasTranscript }
        XCTAssertEqual(model.zoom.captionLines, [])

        try writeTranscript([("Back again", 1, 2)])
        try await until("a transcript written later shows") { model.zoom.captionLines.map(\.text) == ["Back again"] }
        XCTAssertTrue(model.hasTranscript)
    }

    // Hunt round 1, preview-audio-built-once: the music kept ducking under the old transcript until an unrelated
    // rebuild, because the preview's sound read the transcript file once per build.
    func testANewTranscriptMovesTheMusicsDuckingInThePreview() async throws {
        let music = folder.appendingPathComponent("music.caf")
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        do {
            let file = try AVAudioFile(forWriting: music, settings: format.settings)
            let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 96_000))
            buffer.frameLength = 96_000
            try file.write(from: buffer)
        }
        try writeTranscript([("Hello there", 0.2, 0.8)])
        var project = try await screenProject()
        project.audio.music = EditProject.Music(file: music.path)
        let model = try await openModel(project)
        defer { model.close() }
        let first = try XCTUnwrap(model.player.currentItem)

        try writeTranscript([("Hello there", 0.2, 0.8), ("Later words", 1.2, 1.8)], replacing: true)
        try await until("the preview's sound is made again under the new lines") {
            model.player.currentItem.map { $0 !== first && $0.audioMix != nil } ?? false
        }
        XCTAssertEqual(model.zoom.captionLines.count, 2)

        // The same lines written again change nothing, so the playing movie stays.
        let second = try XCTUnwrap(model.player.currentItem)
        try writeTranscript([("Hello there", 0.2, 0.8), ("Later words", 1.2, 1.8)])
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertTrue(model.player.currentItem === second, "an unchanged transcript makes no new movie")
    }
}
