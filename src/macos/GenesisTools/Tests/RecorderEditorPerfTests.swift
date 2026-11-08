import AppKit
import AVFoundation
import XCTest
@testable import GenesisToolsRecorder

/// The editor's load and preview costs on a real recording, read only. Off unless `RECORDER_PERF_MOVIES` names one or
/// more recording folders, movies or edit files (comma separated); each line goes to stdout as `recorder.perf …`.
/// `RECORDER_PERF_ROUNDS` (default 5) repeats every measurement, interleaved over the movies.
final class RecorderEditorPerfTests: XCTestCase {
    private var subjects: [String] {
        (ProcessInfo.processInfo.environment["RECORDER_PERF_MOVIES"] ?? "").split(separator: ",").map(String.init).filter { !$0.isEmpty }
    }

    private var rounds: Int { Int(ProcessInfo.processInfo.environment["RECORDER_PERF_ROUNDS"] ?? "") ?? 5 }

    private static func cpuSeconds() -> Double {
        var usage = rusage()
        getrusage(RUSAGE_SELF, &usage)
        return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1_000_000
    }

    private static func line(_ text: String) {
        print("recorder.perf \(text)")
    }

    private static func percentiles(_ values: [Double]) -> String {
        let sorted = values.sorted()
        guard !sorted.isEmpty else { return "none" }
        let p50 = sorted[sorted.count / 2]
        let p95 = sorted[min(sorted.count - 1, Int((Double(sorted.count) * 0.95).rounded(.up)) - 1)]
        return String(format: "p50 %.1f p95 %.1f (n=%d)", p50, p95, sorted.count)
    }

    /// Reads `seconds` of the preview from `startUs` through the composition, as the player draws it while it plays.
    private static func playback(_ rendered: EditRenderer.Rendered, startUs: Int64, seconds: Double) throws -> (frames: Int, cpu: Double, wall: Double) {
        let reader = try AVAssetReader(asset: rendered.composition)
        let tracks = rendered.composition.tracks(withMediaType: .video)
        let output = AVAssetReaderVideoCompositionOutput(videoTracks: tracks, videoSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        ])
        output.videoComposition = rendered.videoComposition
        output.alwaysCopiesSampleData = false
        reader.add(output)
        reader.timeRange = CMTimeRange(start: EditRenderer.us(startUs), duration: CMTime(seconds: seconds, preferredTimescale: 600))
        let cpu = cpuSeconds()
        let start = Date()
        guard reader.startReading() else { throw reader.error ?? NSError(domain: "perf", code: 1) }
        var frames = 0
        while let buffer = output.copyNextSampleBuffer() {
            if CMSampleBufferGetImageBuffer(buffer) != nil { frames += 1 }
        }
        return (frames, cpuSeconds() - cpu, Date().timeIntervalSince(start))
    }

    func testAPlayingTickRedrawsOnlyWhenTheClockOrThePlayheadMoves() {
        // The clock shows tenths, rounded down: a tick inside the same tenth at a fitted long movie draws nothing.
        XCTAssertFalse(EditorModel.tickShows(from: 60_000_000, to: 60_033_333, pointsPerSecond: 0.6))
        XCTAssertTrue(EditorModel.tickShows(from: 60_066_666, to: 60_100_000, pointsPerSecond: 0.6))
        // Zoomed in, every tick moves the playhead a point or more.
        XCTAssertTrue(EditorModel.tickShows(from: 60_000_000, to: 60_033_333, pointsPerSecond: 400))
        XCTAssertFalse(EditorModel.tickShows(from: 60_000_000, to: 60_033_333, pointsPerSecond: 20))
        XCTAssertFalse(EditorModel.tickShows(from: 60_000_000, to: 60_000_000, pointsPerSecond: 400))
    }

    @MainActor
    func testAPausedTickAndThePauseAlwaysWriteTheExactTime() throws {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("tick-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let project = EditProject.whole(video: folder.appendingPathComponent("none.mp4").path, durationUs: 2_000_000_000,
                                        width: 1920, height: 1080, cursor: nil, recording: nil)
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("edit.json")), link: { nil })
        model.fittedPointsPerSecond = 0.6
        model.playbackTick(outUs: 60_000_000, playing: true)
        XCTAssertEqual(model.clock.outUs, 60_000_000, "the first playing tick writes")
        model.playbackTick(outUs: 60_033_333, playing: true)
        XCTAssertEqual(model.clock.outUs, 60_000_000, "a tick the screen cannot show is skipped")
        model.playbackTick(outUs: 60_100_000, playing: true)
        XCTAssertEqual(model.clock.outUs, 60_100_000)
        model.playbackTick(outUs: 60_133_333, playing: false)
        XCTAssertEqual(model.clock.outUs, 60_133_333, "the pause lands on the exact time")
        XCTAssertFalse(model.isPlaying)
    }

    private static func mainThreadCPU() -> Double {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
        let thread = mach_thread_self()
        defer { mach_port_deallocate(mach_task_self_, thread) }
        let result = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { thread_info(thread, thread_flavor_t(THREAD_BASIC_INFO), $0, &count) }
        }
        guard result == KERN_SUCCESS else { return 0 }
        return Double(info.user_time.seconds + info.system_time.seconds)
            + Double(info.user_time.microseconds + info.system_time.microseconds) / 1_000_000
    }

    /// Ten seconds of playback ticks into a whole editor window (never shown, never key): the main thread's CPU per
    /// played second with every tick written (the old path) and with `playbackTick` (only ticks the screen shows),
    /// interleaved. `RECORDER_PERF_TICKS=<recording>` turns it on; the recording is only read.
    @MainActor
    func testPlaybackTicksCostTheMainThread() async throws {
        let path = ProcessInfo.processInfo.environment["RECORDER_PERF_TICKS"] ?? ""
        try XCTSkipIf(path.isEmpty, "set RECORDER_PERF_TICKS to measure")
        let project = try await ProjectStore.load(path: path).project
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("ticks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let model = EditorModel(project: project, store: ProjectStore(url: folder.appendingPathComponent("edit.json")), link: { nil })
        let window = EditorWindows.makeWindow(model: model, size: NSSize(width: 1440, height: 920))
        window.alphaValue = 0
        window.orderBack(nil)
        defer { window.close() }
        while !model.filmstrip.loaded { try await Task.sleep(for: .milliseconds(50)) }
        try await Task.sleep(for: .seconds(1))
        var arms: [String: [Double]] = [:]
        var writes: [String: Int] = [:]
        let startUs: Int64 = min(60_000_000, model.durationUs / 2)
        for round in 0..<rounds {
            for arm in ["every tick", "playbackTick"] {
                model.player.pause()
                model.seek(startUs)
                try await Task.sleep(for: .milliseconds(300))
                var written = 0
                let cpu = Self.mainThreadCPU()
                for tick in 1...300 {
                    let outUs = startUs + Int64(tick) * 33_333
                    let before = model.clock.outUs
                    if arm == "every tick" {
                        model.clock.outUs = outUs
                    } else {
                        model.playbackTick(outUs: outUs, playing: true)
                    }
                    if model.clock.outUs != before { written += 1 }
                    try await Task.sleep(for: .microseconds(33_333))
                }
                let used = Self.mainThreadCPU() - cpu
                arms[arm, default: []].append(used / 10 * 1000)
                writes[arm] = written
                Self.line("ticks round \(round) \(arm): \(written) writes, main thread \(String(format: "%.0f", used * 1000)) ms for 10 s")
            }
        }
        for (arm, values) in arms.sorted(by: { $0.key < $1.key }) {
            Self.line("ticks \(URL(fileURLWithPath: path).lastPathComponent) \(arm) (\(writes[arm] ?? 0) writes): main thread ms per played s \(Self.percentiles(values))")
        }
    }

    @MainActor
    func testTheEditorsLoadAndPreviewCosts() async throws {
        let subjects = subjects
        try XCTSkipIf(subjects.isEmpty, "set RECORDER_PERF_MOVIES to measure")
        var renders: [String: [Double]] = [:]
        var playCpu: [String: [Double]] = [:]
        var playWall: [String: [Double]] = [:]
        var strips: [String: [Double]] = [:]
        var waves: [String: [Double]] = [:]
        var loaded: [String: EditProject] = [:]
        for path in subjects {
            loaded[path] = try await ProjectStore.load(path: path).project
        }
        for round in 0..<rounds {
            for path in subjects {
                guard let project = loaded[path] else { continue }
                let name = URL(fileURLWithPath: path).lastPathComponent
                let asset = AVURLAsset(url: URL(fileURLWithPath: project.source.video))
                let zoom = ZoomState(project: project, cursor: CursorTrack.load(project.source.cursor))

                var started = Date()
                let rendered = try await EditRenderer.render(project: project, asset: asset, zoom: zoom, maxHeight: 1440)
                renders[name, default: []].append(Date().timeIntervalSince(started) * 1000)

                // Ten seconds of playback from a minute in (or the start of a short movie).
                let startUs: Int64 = project.outputDurationUs > 75_000_000 ? 60_000_000 : 0
                let seconds = min(10, Double(project.outputDurationUs - startUs) / 1_000_000)
                let play = try Self.playback(rendered, startUs: startUs, seconds: seconds)
                playCpu[name, default: []].append(play.cpu / seconds * 1000)
                playWall[name, default: []].append(play.wall / seconds * 1000)
                Self.line("round \(round) \(name): \(play.frames) frames for \(String(format: "%.1f", seconds)) s of playback, cpu \(String(format: "%.0f", play.cpu * 1000)) ms, wall \(String(format: "%.0f", play.wall * 1000)) ms")

                let video = URL(fileURLWithPath: project.source.video)
                let strip = Filmstrip()
                started = Date()
                strip.load(video: video, durationUs: project.source.durationUs)
                while !strip.loaded { try await Task.sleep(for: .milliseconds(10)) }
                strips[name, default: []].append(Date().timeIntervalSince(started) * 1000)

                let wave = Waveform()
                started = Date()
                wave.load(video: video)
                while !wave.loaded { try await Task.sleep(for: .milliseconds(10)) }
                waves[name, default: []].append(Date().timeIntervalSince(started) * 1000)
            }
        }
        for path in subjects {
            let name = URL(fileURLWithPath: path).lastPathComponent
            Self.line("\(name) render ms \(Self.percentiles(renders[name] ?? []))")
            Self.line("\(name) playback cpu ms per played s \(Self.percentiles(playCpu[name] ?? []))")
            Self.line("\(name) playback wall ms per played s \(Self.percentiles(playWall[name] ?? []))")
            Self.line("\(name) filmstrip ms \(Self.percentiles(strips[name] ?? []))")
            Self.line("\(name) waveform ms \(Self.percentiles(waves[name] ?? []))")
        }
    }
}
