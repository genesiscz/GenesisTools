import AVFoundation
import XCTest
@testable import GenesisToolsRecorder

/// The timeline's audio lane draws the sound of every audio track that plays, as the preview and the export mix it,
/// not only the movie's first track, and a muted track leaves it.
@MainActor
final class RecorderHuntWaveformAllTracksTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appendingPathComponent("waveform-tracks-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A 4 s movie with one 8 kHz mono LPCM track per entry of `tones`: a 440 Hz sine at that amplitude over each
    /// range (in seconds), silence elsewhere.
    private func makeMovie(_ name: String, tones: [(amplitude: Double, ranges: [Range<Double>])]) async throws -> URL {
        let url = folder.appendingPathComponent(name)
        let rate = 8000
        let seconds = 4
        var description = AudioStreamBasicDescription(mSampleRate: Float64(rate), mFormatID: kAudioFormatLinearPCM,
                                                      mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                                      mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
                                                      mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var described: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: nil, asbd: &description, layoutSize: 0, layout: nil, magicCookieSize: 0,
                                       magicCookie: nil, extensions: nil, formatDescriptionOut: &described)
        let format = try XCTUnwrap(described)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let inputs = tones.map { _ in
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: nil, sourceFormatHint: format)
            input.expectsMediaDataInRealTime = false
            writer.add(input)
            return input
        }
        XCTAssertTrue(writer.startWriting(), "the writer starts: \(String(describing: writer.error))")
        writer.startSession(atSourceTime: .zero)
        let chunk = rate / 4
        let bytes = chunk * 2
        // Each quarter second goes to every track in turn: the writer interleaves them and waits for each.
        for start in stride(from: 0, to: rate * seconds, by: chunk) {
            for (index, input) in inputs.enumerated() {
                var samples = [Int16](repeating: 0, count: chunk)
                for offset in 0..<chunk {
                    let time = Double(start + offset) / Double(rate)
                    guard tones[index].ranges.contains(where: { $0.contains(time) }) else { continue }
                    samples[offset] = Int16(tones[index].amplitude * 32000 * sin(2 * .pi * 440 * time))
                }
                var allocated: CMBlockBuffer?
                CMBlockBufferCreateWithMemoryBlock(allocator: nil, memoryBlock: nil, blockLength: bytes, blockAllocator: nil,
                                                   customBlockSource: nil, offsetToData: 0, dataLength: bytes, flags: 0,
                                                   blockBufferOut: &allocated)
                let block = try XCTUnwrap(allocated)
                let copied = samples.withUnsafeBytes { raw in
                    CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: bytes)
                }
                XCTAssertEqual(copied, noErr)
                var made: CMSampleBuffer?
                CMAudioSampleBufferCreateReadyWithPacketDescriptions(allocator: nil, dataBuffer: block, formatDescription: format,
                                                                     sampleCount: chunk,
                                                                     presentationTimeStamp: CMTime(value: Int64(start), timescale: Int32(rate)),
                                                                     packetDescriptions: nil, sampleBufferOut: &made)
                let buffer = try XCTUnwrap(made)
                try await input.waitUntilReady()
                XCTAssertTrue(input.append(buffer), "track \(index) takes its samples: \(String(describing: writer.error))")
            }
        }
        for input in inputs { input.markAsFinished() }
        await writer.finishWriting()
        XCTAssertEqual(writer.status, .completed, "the fixture movie is written: \(String(describing: writer.error))")
        return url
    }

    private func loaded(_ url: URL) async throws -> Waveform {
        let wave = Waveform()
        wave.load(video: url)
        let deadline = Date().addingTimeInterval(10)
        while !wave.loaded {
            guard Date() < deadline else {
                XCTFail("the waveform of \(url.lastPathComponent) did not load in 10 s")
                return wave
            }
            try await Task.sleep(for: .milliseconds(20))
        }
        return wave
    }

    private func peak(_ wave: Waveform, _ fromS: Double, _ toS: Double, _ tracks: IndexSet) -> Float {
        wave.peak(fromUs: Int64(fromS * 1_000_000), toUs: Int64(toS * 1_000_000), durationUs: 4_000_000, tracks: tracks)
    }

    /// System sound on track 0 at 0 to 2 s, the microphone on track 1 at 2 to 4 s: with both playing, the lane shows
    /// both, because the preview plays both.
    func testTheLaneShowsTheSecondTrack() async throws {
        let url = try await makeMovie("two-tracks.mov", tones: [(0.9, [0..<2]), (0.9, [2..<4])])
        let wave = try await loaded(url)
        XCTAssertTrue(wave.hasAudio)
        XCTAssertEqual(wave.trackCount, 2)
        XCTAssertGreaterThan(peak(wave, 0.2, 1.8, [0, 1]), 0.5, "track 0's tone shows")
        XCTAssertGreaterThan(peak(wave, 2.2, 3.8, [0, 1]), 0.5, "track 1's tone shows at 2 to 4 s, where the preview plays it")
    }

    /// A muted track leaves the lane: with track 0 muted the lane is flat at 0 to 2 s, where the export is silent, and
    /// shows the microphone at 2 to 4 s.
    func testAMutedTrackLeavesTheLane() async throws {
        let url = try await makeMovie("two-tracks.mov", tones: [(0.9, [0..<2]), (0.9, [2..<4])])
        let wave = try await loaded(url)
        XCTAssertLessThan(peak(wave, 0.2, 1.8, [1]), 0.05, "muted track 0 draws nothing")
        XCTAssertGreaterThan(peak(wave, 2.2, 3.8, [1]), 0.5, "track 1 still shows")
        XCTAssertLessThan(peak(wave, 2.2, 3.8, [0]), 0.05, "muted track 1 draws nothing")
        XCTAssertGreaterThan(peak(wave, 0.2, 1.8, [0]), 0.5, "track 0 still shows")
        XCTAssertEqual(peak(wave, 0.2, 3.8, []), 0, "no track, no bars")
    }

    /// The tracks that play share one scale, so a quiet microphone stays smaller than loud system sound; alone, it
    /// fills the lane, so a quiet recording still shows its shape.
    func testTracksKeepTheirLevelAgainstEachOther() async throws {
        let url = try await makeMovie("levels.mov", tones: [(0.9, [0..<2]), (0.3, [2..<4])])
        let wave = try await loaded(url)
        let both = peak(wave, 2.2, 3.8, [0, 1])
        XCTAssertGreaterThan(both, 0.25)
        XCTAssertLessThan(both, 0.45, "the quiet track is about a third of the loud one")
        XCTAssertGreaterThan(peak(wave, 0.2, 1.8, [0, 1]), 0.9)
        XCTAssertGreaterThan(peak(wave, 2.2, 3.8, [1]), 0.9, "the quiet track alone is scaled to its own loudest moment")
    }

    /// A movie with one sound track reads as before: its tone fills the lane and its silence is flat.
    func testOneTrackMovieKeepsItsShape() async throws {
        let url = try await makeMovie("one-track.mov", tones: [(0.5, [1..<3])])
        let wave = try await loaded(url)
        XCTAssertEqual(wave.trackCount, 1)
        XCTAssertGreaterThan(peak(wave, 1.2, 2.8, [0]), 0.9)
        XCTAssertLessThan(peak(wave, 0.1, 0.8, [0]), 0.05)
        XCTAssertLessThan(peak(wave, 3.2, 3.9, [0]), 0.05)
    }

    /// The lane's audible set is the renderer's: none while the sound is off, else every track `mutedTracks` does not
    /// name, an index past the movie's tracks ignored.
    func testAudibleTracksFollowTheRenderersRule() {
        var audio = EditProject.AudioSettings()
        XCTAssertEqual(audio.audibleTracks(count: 2), IndexSet([0, 1]))
        audio.mutedTracks = [0]
        XCTAssertEqual(audio.audibleTracks(count: 2), IndexSet([1]))
        audio.mutedTracks = [0, 1]
        XCTAssertEqual(audio.audibleTracks(count: 2), IndexSet())
        audio.mutedTracks = [5, -1]
        XCTAssertEqual(audio.audibleTracks(count: 2), IndexSet([0, 1]))
        audio.mutedTracks = []
        audio.include = false
        XCTAssertEqual(audio.audibleTracks(count: 2), IndexSet())
        XCTAssertEqual(EditProject.AudioSettings().audibleTracks(count: 0), IndexSet())
    }
}
