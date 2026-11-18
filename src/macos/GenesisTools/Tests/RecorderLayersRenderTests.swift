import AVFoundation
import CoreImage
import CryptoKit
import XCTest
@testable import GenesisToolsRecorder

final class RecorderLayersRenderTests: XCTestCase {
    private let side = 64
    private let durationUs: Int64 = 1_000_000

    private func folder() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("render-layers-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try FileManager.default.removeItem(at: url) }
        return url
    }

    private func movie(_ url: URL, levels: [UInt8]) async throws {
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: side, AVVideoHeightKey: side,
            AVVideoCompressionPropertiesKey: [AVVideoAllowFrameReorderingKey: false],
        ])
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        writer.add(input)
        XCTAssertTrue(writer.startWriting())
        writer.startSession(atSourceTime: .zero)
        for (index, level) in levels.enumerated() {
            try await input.waitUntilReady()
            var raw: CVPixelBuffer?
            CVPixelBufferCreate(nil, side, side, kCVPixelFormatType_32BGRA, nil, &raw)
            let buffer = try XCTUnwrap(raw)
            CVPixelBufferLockBaseAddress(buffer, [])
            let base = try XCTUnwrap(CVPixelBufferGetBaseAddress(buffer)).assumingMemoryBound(to: UInt32.self)
            let stride = CVPixelBufferGetBytesPerRow(buffer) / MemoryLayout<UInt32>.stride
            let pixel = 0xff00_0000 | UInt32(level) * 0x01_01_01
            for row in 0..<side {
                for col in 0..<side { base[row * stride + col] = pixel }
            }
            CVPixelBufferUnlockBaseAddress(buffer, [])
            XCTAssertTrue(adaptor.append(buffer, withPresentationTime: CMTime(value: Int64(index), timescale: 10)))
        }
        writer.endSession(atSourceTime: CMTime(value: Int64(levels.count), timescale: 10))
        input.markAsFinished()
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, writer.error?.localizedDescription ?? "")
    }

    private func tone(_ url: URL, frequencies: [Double]) throws {
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1))
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        let pcm = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000))
        pcm.frameLength = 48_000
        let samples = try XCTUnwrap(pcm.floatChannelData?[0])
        for i in 0..<48_000 {
            let t = 2 * Double.pi * Double(i) / 48_000
            samples[i] = Float(frequencies.reduce(0) { $0 + 0.1 * sin($1 * t) })
        }
        try file.write(from: pcm)
    }

    private func source(in dir: URL, mixed: Bool = false) async throws -> EditProject {
        var url = dir.appendingPathComponent("screen.mov")
        try await movie(url, levels: Array(repeating: 24, count: 10))
        if mixed {
            let wav = dir.appendingPathComponent("mix.wav")
            try tone(wav, frequencies: [220, 660])
            let media = AVMutableComposition()
            let picture = AVURLAsset(url: url), sound = AVURLAsset(url: wav)
            for (asset, kind) in [(picture, AVMediaType.video), (sound, .audio)] {
                let tracks = try await asset.loadTracks(withMediaType: kind)
                let track = try XCTUnwrap(tracks.first)
                let output = try XCTUnwrap(media.addMutableTrack(withMediaType: kind, preferredTrackID: kCMPersistentTrackID_Invalid))
                try output.insertTimeRange(CMTimeRange(start: .zero, duration: EditRenderer.us(durationUs)), of: track, at: .zero)
            }
            url = dir.appendingPathComponent("proxy.mov")
            let export = try XCTUnwrap(AVAssetExportSession(asset: media, presetName: AVAssetExportPresetPassthrough))
            export.outputURL = url
            export.outputFileType = .mov
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                export.exportAsynchronously { done.resume() }
            }
            XCTAssertEqual(export.status, .completed, export.error?.localizedDescription ?? "")
        }
        return .whole(video: url.path, durationUs: durationUs, width: side, height: side, cursor: nil, recording: nil)
    }

    private func render(_ edit: EditProject) async throws -> EditRenderer.Rendered {
        try await EditRenderer.render(project: edit, asset: AVURLAsset(url: URL(fileURLWithPath: edit.source.video)),
                                      zoom: ZoomState(project: edit, cursor: nil), maxHeight: side)
    }

    private func pixels(_ rendered: EditRenderer.Rendered, atUs us: Int64) async throws -> Data {
        let generator = AVAssetImageGenerator(asset: rendered.composition)
        generator.videoComposition = rendered.videoComposition
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let (image, _) = try await generator.image(at: EditRenderer.us(us))
        XCTAssertEqual(image.width, side)
        XCTAssertEqual(image.height, side)
        var data = Data(count: image.width * image.height * 4)
        try data.withUnsafeMutableBytes { raw in
            let context = try XCTUnwrap(CGContext(data: raw.baseAddress, width: image.width, height: image.height,
                                                  bitsPerComponent: 8, bytesPerRow: image.width * 4,
                                                  space: CGColorSpaceCreateDeviceRGB(),
                                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        }
        return data
    }

    private func whiteImage(in dir: URL) throws -> EditProject.MediaLayer {
        let url = dir.appendingPathComponent("logo.png")
        let image = CIImage(color: .white).cropped(to: CGRect(x: 0, y: 0, width: 16, height: 8))
        try CIContext().writePNGRepresentation(of: image, to: url, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
        return .init(id: "logo", kind: .image, file: url.lastPathComponent, startUs: 200_000, endUs: 800_000)
    }

    func testMixedProxyPlaysOnlyItsTwoFilesAndMutesOnlyTheMicrophone() async throws {
        let dir = try folder()
        var edit = try await source(in: dir, mixed: true)
        try tone(dir.appendingPathComponent("mic.wav"), frequencies: [220])
        try tone(dir.appendingPathComponent("system.wav"), frequencies: [660])
        edit.audio.lanes = [.init(id: "mic", source: .mic, file: "mic.wav", offsetMs: 100, muted: true),
                            .init(id: "system", source: .system, file: "system.wav", offsetMs: -100)]
        edit.clips = [.init(id: "clip", fromUs: 0, toUs: 800_000, speed: 2)]
        let rendered = try await render(edit)
        let tracks = rendered.composition.tracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 2)
        let inputs = try XCTUnwrap(rendered.audioMix?.inputParameters)
        XCTAssertEqual(inputs.count, 2)
        var names = Set<String>()
        for track in tracks {
            let segment = try XCTUnwrap(track.segments.first { !$0.isEmpty })
            let name = try XCTUnwrap(segment.sourceURL?.lastPathComponent)
            names.insert(name)
            let mic = name == "mic.wav"
            let mapping = segment.timeMapping
            XCTAssertEqual(mapping.source.start.seconds, mic ? 0 : 0.1, accuracy: 0.001)
            XCTAssertEqual(mapping.target.start.seconds, mic ? 0.05 : 0, accuracy: 0.001)
            XCTAssertEqual(mapping.target.duration.seconds, mic ? 0.35 : 0.4, accuracy: 0.001)
            let parameters = try XCTUnwrap(inputs.first { $0.trackID == track.trackID })
            for time in [0, 100_000, 399_999] {
                var start: Float = -1, end: Float = -1, range = CMTimeRange.zero
                XCTAssertTrue(parameters.getVolumeRamp(for: EditRenderer.us(Int64(time)), startVolume: &start,
                                                       endVolume: &end, timeRange: &range))
                XCTAssertEqual(start, mic ? 0 : 1)
                XCTAssertEqual(end, start)
            }
        }
        XCTAssertEqual(names, ["mic.wav", "system.wav"])

        edit.audio.lanes = nil
        let facts = EditProject.AudioFacts(movieTracks: 1, mixedFrom: [
            .init(source: .mic, file: "mic.wav", offsetMs: 100), .init(source: .system, file: "system.wav", offsetMs: -100),
        ])
        let derived = try await EditRenderer.render(project: edit, asset: AVURLAsset(url: URL(fileURLWithPath: edit.source.video)),
                                                    zoom: ZoomState(project: edit, cursor: nil), maxHeight: side, audioFacts: facts)
        let files = derived.composition.tracks(withMediaType: .audio).compactMap { track in
            track.segments.first { !$0.isEmpty }?.sourceURL?.lastPathComponent
        }
        XCTAssertEqual(Set(files), names)
    }

    func testImageChangesTheCentreOnlyInsideItsSourceSpanAndWhenVisible() async throws {
        let dir = try folder()
        var edit = try await source(in: dir)
        let plain = try await render(edit)
        var logo = try whiteImage(in: dir)
        edit.layers = .init(media: [logo])
        let visible = try await render(edit)
        for us: Int64 in [0, 200_000, 500_000, 800_000] {
            let expected = try await pixels(plain, atUs: us)
            let actual = try await pixels(visible, atUs: us)
            if (logo.startUs..<logo.endUs).contains(us) {
                XCTAssertGreaterThan(actual[(side / 2 * side + side / 2) * 4], 230)
                XCTAssertNotEqual(actual, expected)
            } else {
                XCTAssertEqual(actual, expected)
            }
        }
        logo.hidden = true
        edit.layers = .init(media: [logo])
        let hidden = try await pixels(render(edit), atUs: 500_000)
        let without = try await pixels(plain, atUs: 500_000)
        XCTAssertEqual(hidden, without)
    }

    func testMovingImageBehindCameraRestoresLegacyFrameHash() async throws {
        let dir = try folder()
        var edit = try await source(in: dir)
        try await movie(dir.appendingPathComponent("camera.mov"), levels: Array(repeating: 135, count: 10))
        var camera = EditProject.Camera(file: "camera.mov")
        camera.corner = .custom
        camera.x = 0.5
        camera.y = 0.5
        camera.size = 0.6
        edit.camera = camera
        let old = try await pixels(render(edit), atUs: 500_000)
        let hash = SHA256.hash(data: old).map { String(format: "%02x", $0) }.joined()
        print("recorder.layers.legacy.sha256 \(hash)")
        if let reference = ProcessInfo.processInfo.environment["RECORDER_LEGACY_FRAME_SHA256"] {
            XCTAssertEqual(hash, reference, "old-format project rendered at the package base")
        }
        var logo = try whiteImage(in: dir)
        logo.width = 0.12 // Fully covered by the opaque centre of the camera when behind it.
        edit.layers = .init(media: [logo])
        let state = ZoomState(project: edit, cursor: nil)
        let preview = try await EditRenderer.render(project: edit, asset: AVURLAsset(url: URL(fileURLWithPath: edit.source.video)),
                                                    zoom: state, maxHeight: side)
        let top = try await pixels(preview, atUs: 500_000)
        let reordered = try edit.movingLayer(logo.id, to: .bottom)
        state.update(reordered)
        let below = try await pixels(preview, atUs: 500_000)
        let centre = (side / 2 * side + side / 2) * 4
        XCTAssertGreaterThan(top[centre], 230)
        XCTAssertLessThan(below[centre], 180)
        XCTAssertEqual(SHA256.hash(data: below), SHA256.hash(data: old))
        let rebuilt = try await pixels(render(reordered), atUs: 500_000)
        XCTAssertEqual(rebuilt, below)
    }

    func testVideoHoldsItsLastPictureOrLoopsFromItsFileClock() async throws {
        let dir = try folder()
        var edit = try await source(in: dir)
        try await movie(dir.appendingPathComponent("inset.mov"), levels: [80, 120, 160, 220])
        var inset = EditProject.MediaLayer(id: "inset", kind: .video, file: "inset.mov",
                                           startUs: 200_000, endUs: 900_000, videoStartMs: 100)
        let centre = (side / 2 * side + side / 2) * 4
        edit.layers = .init(media: [inset])
        let once = try await render(edit)
        let first = try await pixels(once, atUs: 200_000)[centre]
        let held = try await pixels(once, atUs: 600_000)[centre]
        let outside = try await pixels(once, atUs: 900_000)[centre]
        XCTAssertGreaterThan(first, 90)
        XCTAssertGreaterThan(Int(held), Int(first) + 40)
        XCTAssertLessThan(outside, 60)
        inset.loop = true
        edit.layers = .init(media: [inset])
        let looped = try await pixels(render(edit), atUs: 600_000)
        XCTAssertEqual(looped[centre], first)
    }

    func testVideoSoundFollowsTheLayerSpanOffsetAndLoopAcrossACut() async throws {
        let dir = try folder()
        var edit = try await source(in: dir, mixed: true)
        edit.audio.lanes = []
        edit.clips = [.init(id: "a", fromUs: 0, toUs: 400_000),
                      .init(id: "b", fromUs: 600_000, toUs: durationUs, speed: 2)]
        var inset = EditProject.MediaLayer(id: "inset", kind: .video, file: "proxy.mov",
                                           startUs: 100_000, endUs: 900_000, videoStartMs: 800, loop: true)
        edit.layers = .init(media: [inset])
        let silent = try await render(edit)
        XCTAssertTrue(silent.composition.tracks(withMediaType: .audio).isEmpty)
        inset.videoSound = true
        edit.layers = .init(media: [inset])
        let audible = try await render(edit)
        let tracks = audible.composition.tracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 1)
        let segments = try XCTUnwrap(tracks.first).segments.filter { !$0.isEmpty }
        XCTAssertEqual(segments.count, 3)
        let expected = [(0.8, 0.1, 0.2), (0, 0.3, 0.1), (0.3, 0.4, 0.15)]
        for (segment, times) in zip(segments, expected) {
            XCTAssertEqual(segment.timeMapping.source.start.seconds, times.0, accuracy: 0.001)
            XCTAssertEqual(segment.timeMapping.target.start.seconds, times.1, accuracy: 0.001)
            XCTAssertEqual(segment.timeMapping.target.duration.seconds, times.2, accuracy: 0.001)
        }
    }

    func testMissingInputUsedByPictureAndSoundLeavesAnExportableComposition() async throws {
        let dir = try folder()
        var edit = try await source(in: dir, mixed: true)
        let file = "removed.mov"
        edit.layers = .init(media: [.init(id: "inset", kind: .video, file: file, startUs: 0, endUs: durationUs, videoSound: true)])
        edit.audio.lanes = [.init(id: "mic", source: .mic, file: file)]
        let rendered = try await render(edit)
        XCTAssertTrue(rendered.composition.tracks(withMediaType: .audio).isEmpty, "the skipped mic must not restore the mixed proxy")
        XCTAssertEqual(rendered.warnings.count, 1)
        XCTAssertTrue(rendered.warnings.first?.contains(file) == true)
        let url = dir.appendingPathComponent("edited.mp4")
        _ = try await EditExporter.export(project: edit, to: url) { _ in }
        let result = AVURLAsset(url: url)
        let picture = try await result.loadTracks(withMediaType: .video)
        let sound = try await result.loadTracks(withMediaType: .audio)
        XCTAssertEqual(picture.count, 1)
        XCTAssertTrue(sound.isEmpty)
    }

    func testMusicAndVoiceoverUseTheirOwnLevelMultipliedByTheirLane() async throws {
        let dir = try folder()
        var edit = try await source(in: dir)
        try tone(dir.appendingPathComponent("bed.wav"), frequencies: [110])
        try tone(dir.appendingPathComponent("voice.wav"), frequencies: [440])
        edit.audio.music = .init(file: dir.appendingPathComponent("bed.wav").path, volume: 0.6, duck: 0, fadeMs: 0)
        edit.audio.voiceovers = [.init(id: "voice", atUs: 0, file: dir.appendingPathComponent("voice.wav").path, durationUs: durationUs)]
        edit.audio.lanes = [.init(id: "music", source: .music, volume: 0.5), .init(id: "voice", source: .voiceover, muted: true)]
        let result = try await render(edit)
        let inputs = try XCTUnwrap(result.audioMix?.inputParameters)
        XCTAssertEqual(inputs.count, 2)
        for input in inputs {
            let track = try XCTUnwrap(result.composition.track(withTrackID: input.trackID))
            let file = try XCTUnwrap(track.segments.first { !$0.isEmpty }?.sourceURL?.lastPathComponent)
            var start: Float = -1, end: Float = -1, range = CMTimeRange.zero
            XCTAssertTrue(input.getVolumeRamp(for: .zero, startVolume: &start, endVolume: &end, timeRange: &range))
            XCTAssertEqual(start, file == "bed.wav" ? 0.3 : 0, accuracy: 0.001)
        }
    }

    func testEditorRebuildsForLayerFilesPlacementAndSoundLaneChanges() throws {
        var edit = EditProject.whole(video: "/tmp/screen.mov", durationUs: durationUs, width: side, height: side,
                                     cursor: nil, recording: nil)
        edit.camera = .init(file: "camera.mov")
        edit.layers = .init(media: [.init(id: "inset", kind: .video, file: "inset.mov", startUs: 0, endUs: durationUs)])
        edit.audio.lanes = [.init(id: "mic", source: .mic, file: "mic.wav")]
        func rebuild(_ change: (inout EditProject) -> Void) -> Bool {
            var next = edit
            change(&next)
            return EditorModel.needsNewMovie(edit, next)
        }
        XCTAssertTrue(rebuild { $0.layers?.media[0].file = "replacement.mov" })
        XCTAssertTrue(rebuild { $0.layers?.media[0].x = 0.25 })
        XCTAssertTrue(rebuild { $0.layers?.media[0].y = 0.75 })
        XCTAssertTrue(rebuild { $0.layers?.media[0].startUs = 100_000 })
        XCTAssertTrue(EditorModel.needsNewMovie(edit, try edit.movingLayer("inset", to: .bottom)))
        XCTAssertTrue(rebuild { $0.layers?.media[0].videoSound = true })
        XCTAssertTrue(rebuild { $0.audio.lanes?[0].muted = true })
        XCTAssertTrue(rebuild { $0.audio.lanes?[0].volume = 0.5 })
        XCTAssertFalse(rebuild { $0.layers?.media[0].name = "Inset" })
        XCTAssertFalse(EditorModel.needsNewMovie(edit, edit))
    }

    @MainActor
    func testEditorChangeFeedReportsAMissingFileOnceAcrossRebuilds() async throws {
        let dir = try folder()
        var edit = try await source(in: dir)
        edit.layers = .init(media: [.init(id: "logo", kind: .image, file: "missing.png", startUs: 0, endUs: durationUs)])
        let model = EditorModel(project: edit, store: ProjectStore(url: dir.appendingPathComponent("edit.json")), link: { nil })
        @MainActor func waitForItem(rebuild: Bool) async {
            if !rebuild, model.player.currentItem != nil { return }
            let installed = expectation(description: "the preview installs the rendered composition")
            let watch = model.player.observe(\.currentItem, options: [.new]) { player, _ in
                if player.currentItem != nil { installed.fulfill() }
            }
            if rebuild { model.rebuild() }
            await fulfillment(of: [installed], timeout: 10)
            watch.invalidate()
        }
        await waitForItem(rebuild: false)
        let change = try XCTUnwrap(model.changes.first)
        XCTAssertEqual(change.lines.count, 1)
        XCTAssertTrue(change.lines[0].text.contains("missing.png"))
        model.holdBanner(change.id, hovering: true)
        await waitForItem(rebuild: true)
        XCTAssertEqual(model.changes.map(\.id), [change.id])
        model.holdBanner(change.id, hovering: false)
    }
}
