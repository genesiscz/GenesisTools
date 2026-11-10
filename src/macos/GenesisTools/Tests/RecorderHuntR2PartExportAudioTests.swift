import AVFoundation
import Foundation
import XCTest
@testable import GenesisToolsRecorder

/// A part export sounds like the same stretch of the whole export: a voiceover that started before the part plays its
/// rest, and the music goes on from its place in the whole without a new fade-in. The case is shared with
/// recording-editor.test.ts (__fixtures__/part-audio.json), so partOf and TimelineMap.part fail together.
final class RecorderHuntR2PartExportAudioTests: XCTestCase {
    private func fixture() throws -> (root: [String: Any], whole: EditProject, part: EditProject) {
        let root = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: SharedEditorFixture.url("part-audio.json"))) as? [String: Any])
        let whole = try JSONDecoder().decode(EditProject.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(root["edit"])))
        let range = try XCTUnwrap(root["part"] as? [String: Any])
        let fromUs = try XCTUnwrap((range["fromUs"] as? NSNumber)?.int64Value)
        let toUs = try XCTUnwrap((range["toUs"] as? NSNumber)?.int64Value)
        // The window's export: the part, without the cards around it.
        let part = EditorModel.exportedProject(whole, part: (fromUs: fromUs, toUs: toUs))
        return (root, whole, part)
    }

    func testThePartKeepsTheVoiceoversThatPlayAcrossItsStartAsTypeScriptDoes() throws {
        let (root, _, part) = try fixture()
        let expected = try XCTUnwrap(root["voiceovers"] as? [[String: Any]]).map { clip in
            "\(clip["id"] ?? "") \(clip["atUs"] ?? "") \(clip["skipUs"] ?? "-") \(clip["durationUs"] ?? "")"
        }
        XCTAssertEqual(part.audio.voiceovers?.map { "\($0.id) \($0.atUs) \($0.skipUs.map(String.init) ?? "-") \($0.durationUs)" }, expected)
        let spans = try XCTUnwrap(root["spans"] as? [[String: Any]]).map { "\($0["id"] ?? "") \($0["startUs"] ?? "") \($0["playUs"] ?? "")" }
        let placed = VoiceoverMix.exportPlacements(part, cards: CardSpans(project: part, enabled: true))
        XCTAssertEqual(placed.map { "\($0.clip.id) \($0.outUs) \($0.playUs)" }, spans)
        let inWhole = try XCTUnwrap(root["inWhole"] as? [String: Any])
        XCTAssertEqual(part.audio.music?.inWhole?.atUs, (inWhole["atUs"] as? NSNumber)?.int64Value)
        XCTAssertEqual(part.audio.music?.inWhole?.lengthUs, (inWhole["lengthUs"] as? NSNumber)?.int64Value)
    }

    func testThePartsMusicStartsAtTheWholesLevelThereWithNoNewFadeIn() throws {
        let (_, whole, part) = try fixture()
        let wholeMusic = try XCTUnwrap(whole.audio.music)
        let partMusic = try XCTUnwrap(part.audio.music)
        let inWhole = try XCTUnwrap(partMusic.inWhole)
        let partUs = part.outputDurationUs
        let frames = MusicMix.keyframes(music: partMusic, speech: [], lengthUs: partUs)
        let wholeThere = MusicMix.gain(atUs: inWhole.atUs, music: wholeMusic, speech: [], lengthUs: inWhole.lengthUs)
        XCTAssertEqual(try XCTUnwrap(frames.first).volume, wholeThere, accuracy: 1e-9)
        XCTAssertEqual(wholeThere, wholeMusic.volume, accuracy: 1e-9, "the part starts 8 s into the whole: no fade there")
        XCTAssertEqual(try XCTUnwrap(frames.last).volume, wholeMusic.volume, accuracy: 1e-9, "and no fade-out at the part's end")
        // The whole itself still fades in from silence.
        XCTAssertEqual(try XCTUnwrap(MusicMix.keyframes(music: wholeMusic, speech: [], lengthUs: inWhole.lengthUs).first).volume, 0, accuracy: 1e-9)
    }

    /// A mono 8 kHz WAV of `seconds` of a quiet tone, for MusicMix.add to lay.
    private func musicFile(seconds: Double) throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("part-music-\(UUID().uuidString).wav")
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        let format = try XCTUnwrap(AVAudioFormat(standardFormatWithSampleRate: 8000, channels: 1))
        let file = try AVAudioFile(forWriting: url, settings: format.settings)
        let frames = AVAudioFrameCount(seconds * 8000)
        let buffer = try XCTUnwrap(AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames))
        buffer.frameLength = frames
        let samples = try XCTUnwrap(buffer.floatChannelData?[0])
        for index in 0..<Int(frames) { samples[index] = Float(0.2 * sin(2 * .pi * 440 * Double(index) / 8000)) }
        try file.write(from: buffer)
        return url
    }

    /// The music's volume at `us` of the laid part, from the mix parameters MusicMix.add returns.
    private func volume(_ parameters: AVMutableAudioMixInputParameters, atUs us: Int64) throws -> Float {
        var start: Float = 0
        var end: Float = 0
        var range = CMTimeRange.zero
        XCTAssertTrue(parameters.getVolumeRamp(for: CMTime(value: us, timescale: 1_000_000), startVolume: &start, endVolume: &end,
                                               timeRange: &range), "a ramp covers \(us) µs")
        let t = range.duration.seconds > 0 ? (Double(us) / 1_000_000 - range.start.seconds) / range.duration.seconds : 0
        return start + (end - start) * Float(t)
    }

    /// PR #752 review: a 5 s part 10 s into a 60 s export faded its music to silence at its own last frame, because the
    /// fade end was the part's laid length; that stretch of the whole plays at full level. Looping music fades only at
    /// the whole's end, and music played once at the end of its file.
    func testAMiddlePartsMusicDoesNotFadeOutAtThePartsEnd() async throws {
        var project = EditProject.whole(video: "/tmp/x.mp4", durationUs: 5_000_000, width: 1920, height: 1080, cursor: nil, recording: nil)
        for (loop, seconds) in [(nil, 2.0), (false, 30.0)] as [(Bool?, Double)] {
            var music = EditProject.Music(file: try musicFile(seconds: seconds).path)
            music.loop = loop
            music.inWhole = .init(atUs: 10_000_000, lengthUs: 60_000_000)
            project.audio.music = music
            let laid = try await MusicMix.add(music, to: AVMutableComposition(), lengthUs: 5_000_000, project: project, lines: [])
            let parameters = try XCTUnwrap(laid, "the music is laid")
            XCTAssertEqual(try volume(parameters, atUs: 4_950_000), Float(music.volume), accuracy: 0.001,
                           "loop \(String(describing: loop)): full level at the part's last frame, as in the whole")
            XCTAssertEqual(try volume(parameters, atUs: 100_000), Float(music.volume), accuracy: 0.001)
        }
        // The rule itself: the whole's end for a loop, the file's end on the whole's clock for one pass, never the part's.
        var once = EditProject.Music(file: "/tmp/m.wav")
        once.loop = false
        once.inWhole = .init(atUs: 10_000_000, lengthUs: 60_000_000)
        XCTAssertEqual(MusicMix.fadeEndUs(music: once, lengthUs: 5_000_000, laidEndUs: 2_000_000), 12_000_000)
        XCTAssertEqual(MusicMix.fadeEndUs(music: once, lengthUs: 5_000_000, laidEndUs: 80_000_000), 60_000_000)
        once.loop = nil
        XCTAssertEqual(MusicMix.fadeEndUs(music: once, lengthUs: 5_000_000, laidEndUs: 5_000_000), 60_000_000)
        once.inWhole = nil
        XCTAssertEqual(MusicMix.fadeEndUs(music: once, lengthUs: 5_000_000, laidEndUs: 5_000_000), 5_000_000)
    }
}
